'use strict';

/**
 * 模拟 GSI 推送，用于不开游戏时预览覆盖层 / 跑自测。
 *
 *   node tools/mock.js            默认推一包「满买」场景
 *   node tools/mock.js eco        存钱局
 *   node tools/mock.js force      强起
 *   node tools/mock.js pistol     下半场手枪局
 *   node tools/mock.js retake     CT 回防（包已下）
 *   node tools/mock.js partial    【重点】先推全量帧，再推一个只有 money 的增量帧
 *                                 用来验证服务端的 delta 合并是否正确
 *   node tools/mock.js demo       每 4 秒轮换所有场景
 *
 * 注意回合号语义：payload 里的 map.round 是 **0 基** 的（等于已完成的回合数），
 * 手枪局是 0 和 12。这一点已用真实对局日志验证过，别再改回 1/13。
 */

const http = require('http');

const PORT = Number(process.env.PORT) || 31982;
const HOST = '127.0.0.1';

const NAMES_T = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve'];
const NAMES_CT = ['Fay', 'Gus', 'Hal', 'Ivy', 'Jon'];

/**
 * 造一份武器子树。
 * 关键点：GSI 每次推送的是**完整**的 weapons 子树（武器消失时旧键直接消失、不带 null），
 * 所以这里的形状要和真实数据一致 —— 整体替换才不会留下幽灵武器。
 */
function weaponsFor(o) {
  o = o || {};
  const side = o.side || 'T';
  const w = {
    weapon_0: { name: 'weapon_knife', type: 'Knife', state: 'holstered' },
    weapon_1: {
      name: o.primary || (side === 'CT' ? 'weapon_usp_silencer' : 'weapon_glock'),
      type: o.primary ? (o.primaryType || 'Rifle') : 'Pistol',
      state: 'active'
    }
  };
  let i = 2;
  if (o.kit) w['weapon_' + (i++)] = { name: 'weapon_defuse_kit', type: 'StackableItem', state: 'holstered' };
  const n = o.nades || {};
  const push = function (name, count) {
    for (let c = 0; c < (count || 0); c++) {
      w['weapon_' + (i++)] = { name: name, type: 'Grenade', state: 'holstered' };
    }
  };
  push('weapon_smokegrenade', n.smoke);
  push('weapon_flashbang', n.flash);
  push('weapon_hegrenade', n.he);
  push(side === 'CT' ? 'weapon_incgrenade' : 'weapon_molotov', n.fire);
  push('weapon_decoy', n.decoy);
  return w;
}

function makePayload(opts) {
  const side = opts.side;
  const mapName = opts.mapName || 'de_mirage';
  const myTeamNames = side === 'T' ? NAMES_T : NAMES_CT;
  const enemyNames = side === 'T' ? NAMES_CT : NAMES_T;
  const primary = side === 'T' ? 'weapon_ak47' : 'weapon_m4a1_silencer';
  const myPrimary = opts.primaryWeapon || primary;
  const myNades = opts.nades || {};

  const allplayers = {};
  if (!opts.povOnly) {
    myTeamNames.forEach(function (n, i) {
      allplayers[i] = {
        name: n,
        team: side,
        state: { money: opts.teamMoneys[i], health: 100, armor: 100, helmet: true },
        weapons: weaponsFor({ side: side, primary: primary, kit: side === 'CT', nades: { smoke: 1, flash: 2, fire: 1 } })
      };
    });
    enemyNames.forEach(function (n, i) {
      allplayers[100 + i] = {
        name: n,
        team: side === 'T' ? 'CT' : 'T',
        state: { money: 3000, health: 100, armor: 100, helmet: true },
        weapons: weaponsFor({ side: side === 'T' ? 'CT' : 'T', primary: 'weapon_ak47' })
      };
    });
  }

  return {
    // 标记这是模拟数据：真实 GSI 不会推这个字段。
    // 服务端照常接收，但事后回放 logs/ 时可以据此把测试帧剔掉，
    // 不污染你真实对局的日志。
    _mock: true,
    provider: { name: 'Counter-Strike: Global Offensive', appid: 730, version: 14190, steamid: '76561190000000000', timestamp: Math.floor(Date.now() / 1000) },
    map: {
      mode: opts.mode || 'competitive',
      name: mapName,
      phase: opts.mapPhase || 'live',
      round: opts.round,
      team_ct: { score: opts.scoreCT, consecutive_round_losses: side === 'CT' ? opts.myLosses : opts.enemyLosses, timeouts_remaining: 2, name: 'CT' },
      team_t: { score: opts.scoreT, consecutive_round_losses: side === 'T' ? opts.myLosses : opts.enemyLosses, timeouts_remaining: 2, name: 'T' },
      num_matches_to_win_series: 0,
      current_spectators: 0,
      souvenirs_total: 0
    },
    round: {
      phase: opts.phase,
      bomb: opts.bombPlanted ? 'planted' : (opts.bomb || 'carried'),
      win_team: 'none'
    },
    phase_countdowns: { phase: opts.phase, phase_ends_in: '18.4' },
    player: {
      steamid: '76561190000000000',
      clan: '',
      name: 'YOU',
      observer_slot: 1,
      team: side,
      activity: 'playing',
      state: {
        health: opts.dead ? 0 : 100,
        armor: opts.armor,
        helmet: opts.helmet,
        flashed: 0,
        smoked: 0,
        burning: 0,
        money: opts.money,
        round_kills: 0,
        round_killhs: 0,
        round_totaldmg: 0,
        equip_value: opts.money,
        defusekit: opts.defuseKit || false
      },
      weapons: opts.dead
        ? {}
        : weaponsFor({ side: side, primary: opts.primary ? myPrimary : null, kit: opts.defuseKit, nades: myNades }),
      match_stats: { kills: 12, assists: 3, deaths: 9, mvps: 4, score: 27 }
    },
    allplayers: allplayers,
    bomb: { state: opts.bombPlanted ? 'planted' : 'carried', countdown: opts.bombPlanted ? '35.0' : '40.0' }
  };
}

// map.round 是 0 基：手枪局 = 0 与 12
const SCENARIOS = {
  // 上半场第 2 回合、对手（CT）输了手枪局 —— 这是**资金上界最有判别力**的位置：
  // 对手人均上界 $3300 < 「步枪 + 甲盔」$3900，所以能下确定性结论「不可能人手长枪」。
  // 往后几回合上界就涨到 $16000 饱和、只剩定性判断了，所以这个场景必须留着。
  early:   { side: 'T',  round: 1,  phase: 'freezetime', scoreCT: 0, scoreT: 1, money: 3050, armor: 0,   helmet: false, myLosses: 0, enemyLosses: 1, teamMoneys: [3050, 2900, 3200, 2800, 3600] },
  // 休闲模式：护甲每回合**白送**，所以「凑出长枪」的门槛从 $3700 掉到 $2700；
  // 击杀奖励也整体减半（$300 -> $150）。起始资金却是 $1000 而不是 $800。
  // 把这个场景放进预览页，是为了让「模式不同、同一局面的结论就不同」看得见 ——
  // 之前那套常数只有竞技一份，而 logs/ 里的真实数据全是休闲局。
  casual:  { side: 'T',  round: 1,  phase: 'freezetime', mode: 'casual', scoreCT: 0, scoreT: 1, money: 1000, armor: 0, helmet: false, myLosses: 0, enemyLosses: 1, teamMoneys: [1000, 1000, 1000, 1000, 1000] },
  full:    { side: 'T',  round: 8,  phase: 'freezetime', scoreCT: 4, scoreT: 3, money: 6400, armor: 0,   helmet: false, myLosses: 0, enemyLosses: 2, teamMoneys: [5200, 6100, 4800, 7300, 6400], nades: { smoke: 1, flash: 2 } },
  keep:    { side: 'T',  round: 9,  phase: 'freezetime', scoreCT: 5, scoreT: 3, money: 4300, armor: 100, helmet: true,  myLosses: 0, enemyLosses: 3, primary: true, teamMoneys: [4300, 5200, 4800, 4600, 6100], nades: { smoke: 1, flash: 1, he: 1 } },
  eco:     { side: 'CT', round: 11, phase: 'freezetime', scoreCT: 5, scoreT: 5, money: 1900, armor: 0,   helmet: false, myLosses: 2, enemyLosses: 0, teamMoneys: [1900, 1200, 2400, 800, 3100] },
  force:   { side: 'T',  round: 14, phase: 'freezetime', scoreCT: 8, scoreT: 5, money: 3100, armor: 100, helmet: true,  myLosses: 1, enemyLosses: 3, teamMoneys: [3100, 2100, 2600, 1500, 4200], nades: { flash: 1 } },
  pistol:  { side: 'CT', round: 12, phase: 'freezetime', scoreCT: 6, scoreT: 6, money: 800,  armor: 0,   helmet: false, myLosses: 0, enemyLosses: 0, teamMoneys: [800, 800, 800, 800, 800] },
  pistol0: { side: 'T',  round: 0,  phase: 'freezetime', scoreCT: 0, scoreT: 0, money: 800,  armor: 0,   helmet: false, myLosses: 0, enemyLosses: 0, teamMoneys: [800, 800, 800, 800, 800] },
  awp:     { side: 'T',  round: 10, phase: 'freezetime', scoreCT: 5, scoreT: 4, money: 7200, armor: 0,   helmet: false, myLosses: 0, enemyLosses: 1, teamMoneys: [7200, 6800, 7400, 5900, 6600], primaryWeapon: 'weapon_awp' },
  awpkeep: { side: 'T',  round: 11, phase: 'freezetime', scoreCT: 5, scoreT: 5, money: 7200, armor: 100, helmet: true,  myLosses: 0, enemyLosses: 0, primary: true, primaryWeapon: 'weapon_awp', teamMoneys: [7200, 6800, 7400, 5900, 6600], nades: { smoke: 1, flash: 2, fire: 1 } },
  half:    { side: 'CT', round: 13, phase: 'freezetime', scoreCT: 6, scoreT: 5, money: 3200, armor: 0,   helmet: false, myLosses: 1, enemyLosses: 0, teamMoneys: [3200, 2900, 3400, 2600, 4100], nades: { smoke: 1 } },
  ctfull:  { side: 'CT', round: 5,  phase: 'freezetime', scoreCT: 3, scoreT: 2, money: 6800, armor: 0,   helmet: false, myLosses: 0, enemyLosses: 0, teamMoneys: [6800, 7200, 6100, 7500, 6900] },
  retake:  { side: 'CT', round: 15, phase: 'live',      scoreCT: 8, scoreT: 6, money: 4000, armor: 100, helmet: true,  myLosses: 0, enemyLosses: 1, bombPlanted: true, primary: true, defuseKit: true, teamMoneys: [4000, 3800, 4600, 2200, 5100], nades: { smoke: 1, flash: 2 } },
  inferno: { side: 'T',  round: 6,  phase: 'freezetime', scoreCT: 3, scoreT: 3, money: 7000, armor: 100, helmet: true,  myLosses: 0, enemyLosses: 0, mapName: 'de_inferno', teamMoneys: [7000, 6600, 7200, 6100, 7400], nades: { smoke: 2, flash: 2, fire: 1 } },
  anubis:  { side: 'CT', round: 7,  phase: 'freezetime', scoreCT: 4, scoreT: 3, money: 5600, armor: 0,   helmet: false, myLosses: 1, enemyLosses: 0, mapName: 'de_anubis', teamMoneys: [5600, 5200, 6100, 4900, 6300], nades: { smoke: 1, fire: 1 } },
  custom:  { side: 'T',  round: 4,  phase: 'freezetime', scoreCT: 2, scoreT: 2, money: 6000, armor: 0,   helmet: false, myLosses: 0, enemyLosses: 0, mapName: 'de_italy', teamMoneys: [6000, 5800, 6200, 5500, 6400], nades: { smoke: 1 } },
  pov:     { side: 'T',  round: 8,  phase: 'freezetime', scoreCT: 4, scoreT: 3, money: 6400, armor: 0,   helmet: false, myLosses: 0, enemyLosses: 2, teamMoneys: [6400], povOnly: true, nades: { smoke: 1, flash: 1 } }
};

// 热身 / 死斗场景：故意不进 SCENARIOS，因为自测会要求「每个正常场景都能推出对手经济」，
// 而热身期正确行为恰恰是「不出结论、不播语音」。
const WARMUP_OPTS = {
  side: 'T', round: 0, phase: 'freezetime', mapPhase: 'warmup',
  scoreCT: 0, scoreT: 0, money: 16000, armor: 100, helmet: true,
  myLosses: 0, enemyLosses: 0,
  teamMoneys: [16000, 16000, 16000, 16000, 16000]
};

function post(payload, label) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: HOST, port: PORT, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function (res) {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', function (e) {
      console.error('  推送失败: 请先启动 server.js (' + e.message + ')');
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

function push(name) {
  const base = SCENARIOS[name];
  if (!base) {
    console.error('  没有这个场景: ' + name);
    console.error('  可用: ' + Object.keys(SCENARIOS).join(', ') + ', partial, demo');
    process.exit(1);
  }
  return post(makePayload(base), name).then(function () {
    console.log('  -> 已推送场景 [' + name + ']  ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  });
}

/**
 * 增量帧测试：先推一帧全量，再推一帧「只有 money 变化」的增量包。
 * 只带 player.state.money —— 没有 map、没有 round、没有 player.team。
 * 服务端如果没做合并，就会出现「第 0 回合 / 阵营未定」，
 * 做了合并则应当保持第 9 回合、阵营 T。
 */
function pushPartial() {
  const full = makePayload(SCENARIOS.full);
  return post(full, 'full').then(function () {
    console.log('  -> 已推送全量帧（T，第 9 回合，$6400）');
    return new Promise(function (r) { setTimeout(r, 250); });
  }).then(function () {
    const delta = {
      provider: full.provider,
      player: { state: { money: 1234 } },
      previously: { player: { state: { money: 6400 } } }
    };
    return post(delta, 'delta');
  }).then(function () {
    console.log('  -> 已推送增量帧（只含 money=1234，无 map / round / team）');
    console.log('     现在去看 http://127.0.0.1:31982/state ：');
    console.log('     roundIndex 应仍为 8、side 应为 T、money 为 1234。若变成 0 / null 就是合并没生效。');
  });
}

const arg = process.argv[2] || 'full';

if (require.main === module) {
  if (arg === 'demo') {
    const keys = Object.keys(SCENARIOS).filter(function (k) { return k !== 'pov'; });
    let i = 0;
    console.log('轮换演示中，每 4 秒切换一个场景，Ctrl+C 停止。');
    const tick = function () { push(keys[i % keys.length]); i++; };
    tick();
    setInterval(tick, 4000);
  } else if (arg === 'partial') {
    pushPartial();
  } else if (arg === 'warmup') {
    post(makePayload(WARMUP_OPTS), 'warmup').then(function () {
      console.log('  -> 已推送热身场景 [warmup]：');
      console.log('     界面应当显示「热身中」、不出对手结论、语音也不念。');
    });
  } else {
    push(arg);
  }
}

module.exports = { makePayload: makePayload, SCENARIOS: SCENARIOS, weaponsFor: weaponsFor };
