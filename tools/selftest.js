'use strict';

/**
 * 离线自测。跑一遍就知道引擎有没有被改坏：
 *
 *   node tools/selftest.js
 *
 * 开头先扫一遍 logs/，把「实测事实」现场数出来 —— 这一组不写死数字，
 * 因为日志每长一次，写死的数字就变成谎话（195 → 549 → 753，已经谎过两回）。
 * 之后是各组校验：
 *   1. 输出结构：analyze() 只返回该有的字段，买枪 / 战术的字段不许再冒出来
 *   2. 回合号边界：手枪局是索引 0 和 12（0 基，已用真实日志验证），
 *      绝不能再把第 2 回合当成手枪局
 *   3. 热身 / 死斗屏蔽：这些阶段不许出对手结论、不许播语音
 *   3.5 身份识别与旁观：player 块不一定是你（休闲模式旁观 / 接手机器人），
 *      不许把敌人的钱当自己的钱、不许翻转阵营、不许把正常回合误判成热身
 *   4. delta 合并：合成用例 + **真实日志回放**（logs/*.jsonl 存在时）
 *   5. 炸弹状态：下过包之后不许在后面的回合继续报「包已下」
 *   6. 对手经济推算：重建胜负序列、收入下界、资金上界、覆盖率降级（含真实日志回归）
 *   7. 模式常数 / 击杀奖励 / 观测账本：休闲与竞技必须分开算（休闲击杀奖励减半、
 *      护甲白送）；「按累计击杀数做差」这条路的算法与降级行为；
 *      炸弹结算（$3500 胜局、T 埋包失败 $800）、手枪局每杀均值、死亡数推算支出
 *   8. 语音播报文案：给浏览器脚本造桩，验证手枪局 / 数据不全时不会说出反话
 *   9. 日志留存：真起一个服务进程，验证写入 / 手动清理 / 空闲自动清理
 *
 * 第 9 组是本文件里唯一一组**异步**的（要等定时器），所以最后用 finish() 收尾，
 * 不再是跑到文件末尾直接 process.exit。
 *
 * 说明：这次「只保留对手经济推算」的精简删掉了五组校验 —— 档位+购买清单、
 * 菜单交叉校验、道具价差、战术覆盖、中文报点。它们测的功能代码已彻底删除。
 */

const fs = require('fs');
const path = require('path');

const { analyze, isPistolRound } = require('../lib/economy');
const { makePayload, SCENARIOS } = require('./mock');
const { createAccumulator, mergeFrame, looksLikeWarmup } = require('../lib/gsi');

let failed = 0;
let warned = 0;
function fail(msg) { failed++; console.log('  BAD ' + msg); }
/** 值得知道、但不算错的发现（比如 log 里出现了本该拿不到的字段） */
function warn(msg) { warned++; console.log('  注意 ' + msg); }

/* ==================================================================
 * 0. 实测事实（现场扫 logs/，不写死）
 *
 * 这个工具的全部设计都建立在一句判断上：「亲自游玩时 GSI 下不发 allplayers」。
 * 所以这句话必须是**数出来的**，不能是抄来的。这里每次跑都把最新那份日志
 * 扫一遍，把「拿到了什么 / 拿不到什么」摆出来，下面各组直接引用这些数字。
 *
 * 必须剔掉 tools/mock.js 推的测试帧（带 _mock 标记）—— 那两帧**是带 allplayers 的**
 * （模拟器为了造场景自己编的），直接数会把「拿不到 allplayers」的结论当场推翻。
 *
 * 还有一类要剔：**缺 provider 的帧**。真实 GSI 每一帧都带 provider
 * （appid 730 / version 14190，全程恒定），缺了它必然是手搓的。
 * 日志里就有这么一帧（第 299 行），而且它恰好是**唯一**破坏
 * `map.round = ct.score + t.score` 恒等式的帧 —— 一开始就是被它带偏，
 * 报了个假 BAD。判据写成 isRealFrame() 一个函数，四处回放共用，
 * 免得下次又各写各的。
 * ================================================================== */
function isRealFrame(frame) {
  return !!frame && !frame._mock && !!frame.provider;
}
const LOG_DIR_LOCAL = path.join(__dirname, '..', 'logs');
let logFile = '';
try {
  const files = fs.readdirSync(LOG_DIR_LOCAL).filter(function (f) { return f.endsWith('.jsonl'); });
  if (files.length) logFile = path.join(LOG_DIR_LOCAL, files.sort().reverse()[0]);
} catch (e) { /* 没有 logs 目录 */ }

const EV = {
  usable: false, frames: 0, mock: 0, handmade: 0, deltas: 0, maps: [],
  identity: 0, identityOk: 0,
  allplayers: 0, topBomb: 0, roundWins: 0, mapMid: 0,
  roundBomb: 0, winTeam: 0, modes: {}, phases: {}
};

if (logFile) {
  let evLines = [];
  try { evLines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean); } catch (e) { evLines = []; }
  evLines.forEach(function (line) {
    let frame = null;
    try { frame = JSON.parse(line).payload; } catch (e) { return; }
    if (!frame) return;
    if (frame._mock) { EV.mock++; return; }
    if (!frame.provider) { EV.handmade++; return; }
    EV.frames++;
    if (!('map' in frame)) EV.deltas++;
    const m = frame.map || {};
    if (m.name && EV.maps.indexOf(m.name) === -1) EV.maps.push(m.name);
    if (m.mode) EV.modes[m.mode] = (EV.modes[m.mode] || 0) + 1;
    if (m.phase) EV.phases[m.phase] = (EV.phases[m.phase] || 0) + 1;
    if (m.round_wins) EV.roundWins++;
    if (m.mid !== undefined) EV.mapMid++;
    if (frame.allplayers) EV.allplayers++;
    if (frame.bomb) EV.topBomb++;
    const r = frame.round || {};
    if (r.bomb) EV.roundBomb++;
    if (r.win_team) EV.winTeam++;
    if (typeof m.round === 'number' && m.team_ct && m.team_t &&
        typeof m.team_ct.score === 'number' && typeof m.team_t.score === 'number') {
      EV.identity++;
      if (m.round === m.team_ct.score + m.team_t.score) EV.identityOk++;
    }
  });
  EV.usable = EV.frames > 0;
}

console.log('-'.repeat(78));
console.log('实测事实（现场扫 logs/ 数出来的，不是文档抄的）：');
console.log('');
if (!EV.usable) {
  console.log('  跳过：logs/ 里还没有可用的 .jsonl。打一局之后重跑本测试，这一组会自动填上数字。');
  console.log('');
} else {
  console.log('  日志文件    ' + path.basename(logFile) + '：真实帧 ' + EV.frames +
    (EV.mock || EV.handmade
      ? '（另有 ' + (EV.mock ? EV.mock + ' 帧带 _mock 标记' : '') +
        (EV.mock && EV.handmade ? '、' : '') +
        (EV.handmade ? EV.handmade + ' 帧缺 provider' : '') + '，都不是游戏推的，已剔除）'
      : ''));
  console.log('  覆盖地图    ' + (EV.maps.join('、') || '-'));
  console.log('  取值分布    phase ' + JSON.stringify(EV.phases) + '  mode ' + JSON.stringify(EV.modes));
  console.log('  增量帧      ' + EV.frames + ' 帧里有 ' + EV.deltas + ' 帧没有 map 分量（服务端必须自己累积，见第 4 组）');
  console.log('');

  // 这一条是「map.round 到底几基」的唯一证据来源。
  // 只算游戏真的推过来的帧 —— 手搓的那一帧（缺 provider）round 比比分之和大 1，
  // 混进来会把它变成一个假 BAD。
  if (EV.identity && EV.identityOk === EV.identity) {
    console.log('  ' + ('map.round = team_ct.score + team_t.score，' + EV.identityOk + '/' + EV.identity + ' 帧全中').padEnd(48) + 'OK 0 基实锤');
    console.log('  ' + '（只统计游戏推的帧：缺 provider 的那类手搓帧不参与，见上面剔除数）'.padEnd(48) + '');
  } else if (EV.identity) {
    fail('map.round 与比分对不上：只有 ' + EV.identityOk + '/' + EV.identity + ' 帧相等 —— 0 基结论失效，先看第 2 组');
  } else {
    console.log('  ' + '日志里没有同时带 round 和双方 score 的帧，无法验算 0 基'.padEnd(48) + '跳过');
  }

  // 本该拿不到的字段。全为 0 才是正常 —— 但**不算错**：
  // 观战 / GOTV / demo 会真的下发 allplayers，那时候 0 以外的数字是对的。
  const UNAVAILABLE = [
    ['allplayers', EV.allplayers, '队友 / 对手的钱包与武器'],
    ['顶层 bomb', EV.topBomb, '全局炸弹对象（只有 round.bomb 有值）'],
    ['map.round_wins', EV.roundWins, '每回合结束原因表（CS:GO 时代字段，CS2 已删）'],
    ['map.mid', EV.mapMid, '地图中点数据（引擎读不到，别再往顶层搬）']
  ];
  UNAVAILABLE.forEach(function (row) {
    if (row[1] === 0) {
      console.log('  ' + (row[0] + '：0 帧 —— 拿不到「' + row[2] + '」').padEnd(48) + 'OK');
    } else {
      warn(row[0] + ' 出现了 ' + row[1] + ' 帧。如果你是**观战 / GOTV / 录像**录的，这是正常的，' +
        '而且意味着那时对手经济可以直接读、不用推算；如果是亲自游玩录的，说明 Valve 改了下发策略，' +
        '去 debug.html 确认一下再回来改 lib/enemy.js 的说明。');
    }
  });

  // 这两个有值，而且**必须**有值 —— 它们描述的「上一回合怎么结束的」是可用的信息
  console.log('  ' + ('round.bomb：' + EV.roundBomb + ' 帧有值，round.win_team：' + EV.winTeam + ' 帧有值').padEnd(48) + 'OK 可用');
  console.log('  （都是回合**结果**字段，只在变化时推一次，描述的是刚结束的那一回合；' +
    '按 map.round - 1 归因，且必须在清残留之前收集）');
  console.log('');
}

/* ==================================================================
 * 1. 输出结构
 *
 * 精简之后 analyze() 的输出是固定的一小撮字段。这一组用「精确比对」把它钉住：
 * 少一个字段 = 界面某处会显示 undefined；多一个字段 = 有功能悄悄长回来了。
 * 比逐个 assert 更省事，也更难绕过。
 * ================================================================== */
console.log('-'.repeat(78));
console.log('输出结构（analyze() 现在只该返回这 16 个字段）：');
console.log('');

{
  const EXPECTED = [
    'ts', 'phase', 'roundNum', 'roundIndex', 'side',
    'notInMatch', 'inWarmup', 'notInMatchLabel',
    'score', 'mapName', 'mapRaw', 'bombPlanted',
    'spectating', 'observed',
    'me', 'myTeam', 'enemy', 'advice'
  ];
  // 这些是「买枪建议 / 战术规划」时代的字段，精简后必须彻底消失
  const GONE = [
    'tier', 'tierLabel', 'tierNote', 'headline', 'plan', 'loadout',
    'awper', 'primaryPick', 'tactics', 'forecast', 'team', 'lowerBoundNote'
  ];

  const a = analyze(makePayload(SCENARIOS.full), { roundScore: {} });
  const got = Object.keys(a).sort().join(',');
  const want = EXPECTED.slice().sort().join(',');

  if (got === want) {
    console.log('  ' + ('字段集合与期望完全一致（' + EXPECTED.length + ' 个）').padEnd(48) + 'OK');
  } else {
    const gotArr = Object.keys(a);
    const missing = EXPECTED.filter(function (k) { return gotArr.indexOf(k) === -1; });
    const extra = gotArr.filter(function (k) { return EXPECTED.indexOf(k) === -1; });
    fail('输出字段对不上；缺少 [' + missing.join(',') + ']，多出 [' + extra.join(',') + ']');
  }

  const leaked = GONE.filter(function (k) { return k in a; });
  if (!leaked.length) {
    console.log('  ' + '已移除功能的字段一个都没回来（查了 ' + GONE.length + ' 个）'.padEnd(48) + 'OK');
  } else {
    fail('已移除的字段又出现了：' + leaked.join('、'));
  }

  // 顶层导出也要干净：只留 analyze 和它自带的小工具
  const econKeys = Object.keys(require('../lib/economy')).sort();
  const wantEcon = ['analyze', 'countGrenades', 'isPistolRound', 'lossBonus'];
  if (econKeys.join(',') === wantEcon.join(',')) {
    console.log('  ' + 'lib/economy.js 的导出也没多没少'.padEnd(48) + 'OK');
  } else {
    fail('lib/economy.js 导出异常：' + econKeys.join(', ') + '（期望 ' + wantEcon.join(', ') + '）');
  }

  // 买枪 / 战术模块必须已经从 lib 里搬走 —— 被 require 会直接抛错才是对的
  const MOVED = ['./loadout', './tactics', './maps', './llm'];
  const stillThere = MOVED.filter(function (m) {
    try { require.resolve(path.join(__dirname, '..', 'lib', m.replace('./', '') + '.js')); return true; }
    catch (e) { return false; }
  });
  if (!stillThere.length) {
    console.log('  ' + 'lib/ 下已无 loadout / tactics / maps / llm'.padEnd(48) + 'OK');
  } else {
    fail('这些模块还留在 lib/ 里：' + stillThere.join('、'));
  }
  console.log('');
}

/* ==================================================================
 * 2. 回合号边界
 * ================================================================== */
console.log('-'.repeat(78));
console.log('回合号边界（map.round 是 0 基，等于已完成的回合数）：');
console.log('  真实日志证据：' + (EV.identity
  ? EV.identityOk + '/' + EV.identity + ' 帧满足 map.round = team_ct.score + team_t.score'
  : '（还没日志，见开头第 0 组）'));
console.log('  -> 手枪局是索引 0（上半场）和 12（下半场），不是 1 和 13');
console.log('  注意：索引 0 就是手枪局，所以判断**不能**写成 roundIndex <= 0；');
console.log('');

const PISTOL_INDEXES = [0, 12];
const NOT_PISTOL = [1, 2, 11, 13, 14, 23];
let roundBad = 0;

PISTOL_INDEXES.forEach(function (idx) {
  const a = analyze(makePayload({
    side: 'CT', round: idx, phase: 'freezetime',
    scoreCT: idx === 0 ? 0 : 6, scoreT: idx === 0 ? 0 : 6,
    money: 800, armor: 0, helmet: false, myLosses: 0, enemyLosses: 0,
    teamMoneys: [800, 800, 800, 800, 800]
  }), { roundScore: {} });
  // 两个判据必须同时成立：工具函数认它是手枪局，且对手推算也走手枪局分支
  const ok = isPistolRound(idx) && a.enemy.pistol === true && a.enemy.cashCeil === 800;
  if (!ok) roundBad++;
  console.log('  索引 ' + String(idx).padEnd(3) + ' -> ' +
    ('第 ' + a.roundNum + ' 回合 · 对手' + (a.enemy.tierLabel || '-')).padEnd(26) +
    (ok ? 'OK 手枪局（双方 $800）' : 'BAD 应当判为手枪局'));
});

NOT_PISTOL.forEach(function (idx) {
  const a = analyze(makePayload({
    side: 'CT', round: idx, phase: 'freezetime', scoreCT: 6, scoreT: 6,
    money: 3000, armor: 0, helmet: false, myLosses: 0, enemyLosses: 0,
    teamMoneys: [3000, 3000, 3000, 3000, 3000]
  }), { roundScore: {} });
  const ok = !isPistolRound(idx) && a.enemy.pistol !== true;
  if (!ok) roundBad++;
  console.log('  索引 ' + String(idx).padEnd(3) + ' -> ' +
    ('第 ' + a.roundNum + ' 回合').padEnd(26) +
    (ok ? 'OK 非手枪局' : 'BAD 被误判成手枪局'));
});
console.log('');
failed += roundBad;

/* ==================================================================
 * 3. 热身 / 死斗屏蔽
 * ================================================================== */
console.log('-'.repeat(78));
console.log('热身 / 死斗屏蔽（这些阶段不该给出对手经济结论，更不该播语音）：');
console.log('');

const WARMUP_CASES = [
  { name: 'map.phase=warmup', opts: { mapPhase: 'warmup', round: 0, money: 16000 }, ctx: {}, want: 'warmup' },
  { name: 'map.mode=deathmatch', opts: { mapPhase: 'live', mode: 'deathmatch', round: 0, money: 16000 }, ctx: {}, want: 'deathmatch' },
  { name: 'map.phase=gameover', opts: { mapPhase: 'gameover', round: 15, money: 4000 }, ctx: {}, want: 'gameover' },
  { name: '同回合内复活（兜底）', opts: { mapPhase: 'live', round: 0, money: 3200 }, ctx: { respawnRecently: true, respawnAgo: 5 }, want: 'deathmatch' }
];

let warmBad = 0;
WARMUP_CASES.forEach(function (c) {
  const a = analyze(makePayload(Object.assign({
    side: 'T', phase: 'freezetime', scoreCT: 0, scoreT: 0, armor: 100, helmet: true,
    myLosses: 0, enemyLosses: 0, teamMoneys: [16000, 16000, 16000, 16000, 16000]
  }, c.opts)), c.ctx);
  const problems = [];
  if (!a.inWarmup) problems.push('没有被识别为热身');
  if (a.notInMatch !== c.want) problems.push('类型是 ' + a.notInMatch + '，期望 ' + c.want);
  if (!a.advice.length) problems.push('没有说明原因');
  if (a.advice[0].indexOf(a.notInMatchLabel) !== 0) problems.push('说明没有以阶段名开头');
  // 关键：热身期**不许给出对手经济结论**。
  // 注意这里比的是推算出来的那句话本身，而不是「对手经济」这个字符串 ——
  // 说明里还有一句「打开 /debug.html 看对手经济卡对不对得上」，
  // 那是界面指路，不是结论，用关键词去撞会误伤（这个坑刚踩过）。
  if (a.enemy && a.enemy.verdict && a.advice.join('').indexOf(a.enemy.verdict) !== -1) {
    problems.push('说明里仍然给了对手经济结论');
  }
  if (problems.length) warmBad++;
  console.log('  ' + c.name.padEnd(26) + (problems.length ? 'BAD ' + problems.join('；') : 'OK 已屏蔽'));
});

// 光看字段不够，还得验「真的不会发声」
{
  global.window = global;
  global.document = {
    readyState: 'complete',
    getElementById: function () { return null; },
    addEventListener: function () {},
    createElement: function () { return {}; }
  };
  global.localStorage = { getItem: function () { return null; }, setItem: function () {} };
  require('../public/speech.js');
  const S = global.BuyHelperSpeech;
  S.cfg.enabled = true;   // 开着语音也要在热身期闭嘴

  const warm = analyze(makePayload(Object.assign({}, SCENARIOS.full, { mapPhase: 'warmup' })), {});
  const spoke = S.maybeAnnounce(warm);
  const said = S.compose(warm);
  if (spoke === false && said === '') {
    console.log('  ' + '热身时语音开关开着也一个字都不念'.padEnd(48) + 'OK');
  } else {
    warmBad++;
    console.log('  ' + ('热身时竟然发声了：maybeAnnounce=' + spoke + ' compose=' + JSON.stringify(said)).padEnd(48) + 'BAD');
  }
  S.cfg.enabled = false;
}
console.log('');
failed += warmBad;

/* ==================================================================
 * 3.5 身份识别与旁观
 *
 * 本组来自一次实测发现：**GSI 的 player 块不一定是「你」**。
 * 休闲模式里阵亡后可以旁观 / 接手机器人，那一刻 GSI 会把整个 player 块
 * 切成被旁观者的 —— 名字、steamid、金钱、武器全变成他的。
 *
 * 判据是 provider.steamid：它是**客户端身份**，实测 1135 帧恒定不变；
 * 而 player.steamid 会来回跳（实测 102 次）。
 *
 * 不拦住会出四件事，前三件在真实日志里都发生过：
 *   1. 界面把**敌人的钱**显示成「我的金钱」
 *   2. 我方 / 敌方整个翻转（实测 32 次）
 *   3. 「死而复生」检测被别人的血量骗到
 *   4. player.state 的旧键残留（REPLACE_SUBTREES 只替换 weapons）
 *
 * 第 3 件的连带后果最隐蔽：休闲模式**接手机器人**也是「同一回合内血从 0 变正」，
 * 于是热身检测被触发 —— 真实日志 1135 帧里有 **291 帧（26%）** 被判成热身，
 * 而真正处于 warmup 阶段的只有 4 帧，界面会在正常回合里显示「热身中」、
 * 把对手经济的结论整段屏蔽掉。所以复活改成「同回合 ≥2 次」才算热身。
 * ================================================================== */
{
  const ID_ME = '76561198974921480';
  const ID_FOE = '795';
  let idBad = 0;
  function idCheck(label, cond, extra) {
    if (cond) { console.log('  ' + label.padEnd(46) + 'OK'); return; }
    idBad++;
    console.log('  ' + label.padEnd(46) + 'BAD ' + (extra || ''));
  }

  function mkFrame(over) {
    return Object.assign({
      provider: { appid: 730, name: 'Counter-Strike: Global Offensive', steamid: ID_ME, version: 14190 },
      map: {
        name: 'de_dust2', mode: 'casual', phase: 'live', round: 5,
        team_ct: { score: 2, consecutive_round_losses: 0 },
        team_t: { score: 3, consecutive_round_losses: 1 }
      },
      round: { phase: 'live' },
      player: {
        steamid: ID_ME, name: '我', team: 'CT', observer_slot: 0,
        state: { health: 100, money: 2000, armor: 100, helmet: true, equip_value: 4000 },
        weapons: { weapon_0: { name: 'weapon_knife' }, weapon_1: { name: 'weapon_m4a1_silencer' } },
        match_stats: { kills: 2, deaths: 0, assists: 0 }
      }
    }, over);
  }

  // ---- 合成：一帧自己，再一帧旁观敌人 ----
  const accId = createAccumulator();
  const mA = mergeFrame(accId, mkFrame());
  idCheck('自己那一帧：state.player 是我', mA.player.steamid === ID_ME && mA.player.name === '我');
  idCheck('自己那一帧：不标记为旁观', accId.spectating === false);
  idCheck('自己那一帧：不产生 playerObserved', mA.playerObserved === undefined);

  const mB = mergeFrame(accId, mkFrame({
    player: {
      steamid: ID_FOE, name: '尤里', team: 'T', observer_slot: 5,
      state: { health: 44, money: 5100, armor: 64, helmet: true, equip_value: 4500 },
      weapons: { weapon_0: { name: 'weapon_knife_t' }, weapon_1: { name: 'weapon_sg556' } },
      match_stats: { kills: 7, deaths: 4, assists: 1 }
    }
  }));
  idCheck('旁观帧被识别出来', accId.spectating === true);
  idCheck('旁观帧没污染 state.player（名字还是我）',
    mB.player.steamid === ID_ME && mB.player.name === '我', JSON.stringify(mB.player.name));
  idCheck('被旁观者另存到 state.playerObserved',
    !!mB.playerObserved && mB.playerObserved.name === '尤里');
  idCheck('playerObserved 里能读到他的总击杀数',
    !!mB.playerObserved.match_stats && mB.playerObserved.match_stats.kills === 7);
  idCheck('playerObserved 里能读到他的真实资金',
    !!mB.playerObserved.state && mB.playerObserved.state.money === 5100);

  const aB = analyze(mB, { roundScore: {} });
  idCheck('分析结果 spectating=true', aB.spectating === true);
  idCheck('分析结果 observed 带出对面的钱', !!aB.observed && aB.observed.money === 5100);
  idCheck('分析结果 observed 带出对面的总击杀', !!aB.observed && aB.observed.kills === 7);
  idCheck('「我的钱」仍是自己的 $2000（不是对面的 $5100）',
    aB.me.money === 2000, 'me.money=' + aB.me.money);
  idCheck('我方阵营没被旁观对象带偏（仍是 CT）', aB.side === 'CT', 'side=' + aB.side);
  idCheck('说明里明确写了「正在旁观」', aB.advice.join('').indexOf('旁观') !== -1);

  const mC = mergeFrame(accId, mkFrame());
  idCheck('回到自己后 spectating 归位', accId.spectating === false);
  idCheck('回到自己后 playerObserved 被清掉（不能残留成一直有敌人数据）',
    mC.playerObserved === undefined);

  // ---- 热身误判：同回合复活 1 次不算，≥2 次才算 ----
  function respawnPair(a, round) {
    const mk = function (hp) {
      return mkFrame({
        map: {
          name: 'de_dust2', mode: 'casual', phase: 'live', round: round,
          team_ct: { score: 0 }, team_t: { score: 0 }
        },
        player: {
          steamid: ID_ME, name: '我', team: 'CT', observer_slot: 0,
          state: { health: hp, money: 2000 }
        }
      });
    };
    mergeFrame(a, mk(0));
    return mergeFrame(a, mk(100));
  }
  const wAcc = createAccumulator();
  const w1 = respawnPair(wAcc, 3);
  idCheck('同回合只复活 1 次 -> 不算热身（接手机器人就是这个特征）',
    looksLikeWarmup(wAcc, w1).hit === false);
  const w2 = respawnPair(wAcc, 3);
  idCheck('同回合复活到 2 次 -> 判定为热身 / 死斗（真热身照样认得出）',
    looksLikeWarmup(wAcc, w2).hit === true);

  // ---- 真实日志：把上面两条放到整份日志上验一遍 ----
  if (logFile) {
    const idLines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const accR = createAccumulator();
    let spectFrames = 0;
    let sideFlipWhileSpectating = 0;
    let livePhaseCalledWarmup = 0;
    let lastSideOutside = null;
    idLines.forEach(function (line) {
      let f; try { f = JSON.parse(line).payload; } catch (e) { return; }
      if (!isRealFrame(f)) return;
      const m = mergeFrame(accR, f);
      const a = analyze(m, { roundScore: accR.roundScore });
      const phase = String((m.map && m.map.phase) || '');
      if (accR.spectating) {
        spectFrames++;
        // 旁观期间「我」的阵营不许变（变了说明又被旁观对象带偏了）
        if (lastSideOutside && m.player && m.player.team && m.player.team !== lastSideOutside) {
          sideFlipWhileSpectating++;
        }
      } else if (m.player && (m.player.team === 'CT' || m.player.team === 'T')) {
        lastSideOutside = m.player.team;
      }
      // 端到端：**live 阶段**绝不许被判成「非正式回合」。
      // 要放过两种情况：gameover（确实不是正式回合，屏蔽是对的）
      // 和真的 deathmatch 模式（那种本来就该屏蔽）。
      const mode = String((m.map && m.map.mode) || '');
      if (a.inWarmup && phase === 'live' && mode !== 'deathmatch') livePhaseCalledWarmup++;
    });

    idCheck('真实日志里确实存在「旁观别人」的帧（不是假想场景）',
      spectFrames > 0, 'spectFrames=' + spectFrames);
    idCheck('旁观期间「我」的阵营一次都没被带偏',
      sideFlipWhileSpectating === 0, 'flips=' + sideFlipWhileSpectating);
    idCheck('非 warmup 阶段被误判成热身的帧数为 0（修复前 291 帧）',
      livePhaseCalledWarmup === 0, '误判=' + livePhaseCalledWarmup);
    console.log('  ' + ('（本份日志里旁观帧 ' + spectFrames + ' 个）').padEnd(46) + '');
  } else {
    console.log('  ' + '跳过真实日志部分：logs/ 里还没有 .jsonl'.padEnd(46) + 'OK');
  }

  failed += idBad;
}
console.log('');

/* ==================================================================
 * 4. delta 合并：合成用例
 * ================================================================== */
console.log('-'.repeat(78));
console.log('delta 合并（GSI 只推变化分量，服务端必须累积成完整状态）：');
console.log('  配置里开了 buffer/throttle，真实日志里 ' + (EV.usable
  ? EV.deltas + '/' + EV.frames + ' 个包没有 map 分量'
  : '有一部分包没有 map 分量') + '、');
console.log('  一部分包的 player 缺 state/weapons/team。');
console.log('');

let mergeBad = 0;
function check(label, cond, extra) {
  if (cond) { console.log('  ' + label.padEnd(46) + 'OK'); return; }
  mergeBad++;
  console.log('  ' + label.padEnd(46) + 'BAD ' + (extra || ''));
}

const acc = createAccumulator();
mergeFrame(acc, {
  map: { name: 'de_mirage', round: 5, team_ct: { score: 3 }, team_t: { score: 2 } },
  round: { phase: 'freezetime' },
  player: {
    team: 'T',
    state: { money: 5000, health: 100, armor: 100 },
    weapons: {
      weapon_0: { name: 'weapon_ak47', type: 'Rifle' },
      weapon_1: { name: 'weapon_smokegrenade', type: 'Grenade' }
    }
  }
});
check('全量帧后，状态里拿到 map/player', acc.state.map.round === 5 && acc.state.player.team === 'T');

mergeFrame(acc, { player: { state: { money: 1234 } } });
check('增量帧（只有 money）不丢 map.round', acc.state.map.round === 5, 'round=' + acc.state.map.round);
check('增量帧不丢 player.team', acc.state.player.team === 'T', 'team=' + acc.state.player.team);
check('增量帧的 money 被应用', acc.state.player.state.money === 1234, 'money=' + acc.state.player.state.money);

// 关键：武器子树必须整体替换。真实数据里阵亡时武器键数从 6 掉到 0，且不带 null。
mergeFrame(acc, { player: { weapons: {} } });
check('阵亡帧把武器清空（不留幽灵步枪）',
  Object.keys(acc.state.player.weapons).length === 0,
  '还剩 ' + Object.keys(acc.state.player.weapons).join(','));
check('清空武器后引擎不再认为「已有主武器」',
  analyze(acc.state).me.primary === false);

mergeFrame(acc, { allplayers: { 1: { name: 'x', team: 'T', state: { money: 900 } } } });
check('allplayers 合并进来', !!(acc.state.allplayers && acc.state.allplayers[1]));
mergeFrame(acc, { allplayers: { 1: null } });
check('allplayers 里 null 表示离开，会被删除', !acc.state.allplayers[1]);

mergeFrame(acc, { map: { name: 'de_inferno', round: 0 } });
check('换图后状态被清空重建', acc.state.map.name === 'de_inferno' && !acc.state.player,
  'player=' + JSON.stringify(acc.state.player));

// 比分快照：对手经济推算完全依赖它，语义写错会静默退化，所以单独钉一下
{
  const sacc = createAccumulator();
  mergeFrame(sacc, { map: { name: 'de_mirage', round: 0, team_ct: { score: 0 }, team_t: { score: 0 } } });
  mergeFrame(sacc, { map: { round: 1, team_ct: { score: 1 } } });
  mergeFrame(sacc, { map: { round: 1, team_ct: { score: 1 } } });
  check('roundScore[0] 是「回合 0 开始前」的比分（0:0）',
    sacc.roundScore[0] && sacc.roundScore[0].ct === 0 && sacc.roundScore[0].t === 0,
    JSON.stringify(sacc.roundScore[0]));
  check('roundScore[1] 记的是回合 0 走完后的比分（1:0）',
    sacc.roundScore[1] && sacc.roundScore[1].ct === 1 && sacc.roundScore[1].t === 0,
    JSON.stringify(sacc.roundScore[1]));
  check('同一回合重复推同样的分数不会累加（取 max 而非相加）',
    sacc.roundScore[1].ct === 1, String(sacc.roundScore[1].ct));
}

// 复位检测 —— 注意「同回合复活 1 次」**不算**热身。
// 休闲模式阵亡后接手机器人也是这个特征（同一回合内血从 0 跳到 100），
// 只判一次的话正常回合会被整段误判成热身：真实日志 1135 帧里 291 帧中招，
// 而真正处于 warmup 的只有 4 帧。热身 / 死斗的特征是**反复**复活，所以要求 ≥2 次。
const acc2 = createAccumulator();
mergeFrame(acc2, { map: { name: 'de_mirage', round: 0 }, player: { team: 'T', state: { money: 1000, health: 100 } } });
mergeFrame(acc2, { player: { state: { health: 0 } } });
mergeFrame(acc2, { player: { state: { health: 100, money: 2200 } } });
check('同回合只复活 1 次 -> 不判热身（接手机器人就长这样）', !looksLikeWarmupFn(acc2));
mergeFrame(acc2, { player: { state: { health: 0, money: 2210 } } });
mergeFrame(acc2, { player: { state: { health: 100, money: 2400 } } });
check('同回合复活到 2 次 -> 记为「疑似热身」', looksLikeWarmupFn(acc2));
const acc3 = createAccumulator();
mergeFrame(acc3, { map: { name: 'de_mirage', round: 0 }, player: { team: 'T', state: { health: 100 } } });
mergeFrame(acc3, { player: { state: { health: 0 } } });
mergeFrame(acc3, { map: { round: 1 }, player: { state: { health: 100 } } });
check('下一回合才复活不算（正式回合正常情况）', !looksLikeWarmupFn(acc3));

function looksLikeWarmupFn(a) {
  return require('../lib/gsi').looksLikeWarmup(a, a.state).hit;
}

console.log('');
failed += mergeBad;

/* ==================================================================
 * 5. delta 合并：真实日志回放
 * ================================================================== */
console.log('-'.repeat(78));
console.log('真实日志回放（用你自己打的那局数据验证合并）：');
console.log('');

// logFile 在第 0 组就找好了，这里直接复用（那两处曾经各找一遍，容易改成不一致）
if (!logFile) {
  console.log('  跳过：logs/ 里还没有 .jsonl 文件。打一局之后重跑本测试即可回放。');
  console.log('');
} else {
  const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const racc = createAccumulator();
  let noMap = 0, noRound = 0, noTeam = 0, noMoney = 0, weaponMismatch = 0;
  let deltas = 0, lastBadFrame = -1, skipped = 0, excused = 0, spectated = 0;

  // 换图那一帧「数据不全是正常的」：GSI 换了地图之后先推一个只有 map 的帧
  // （player 分量要到下一帧才来），而 mergeFrame 遇到换图会清空状态，
  // 所以这一帧必然缺阵营和资金。真实日志里第 300 帧就是这样：
  // {provider, map} -> de_dust2 / round 0 / warmup，没有 player。
  // 但不能因此把断言放宽成「缺数据就不管」—— 只放过「这一帧自己声明了换图」
  // 和「当前处于 warmup / gameover」这两种，图中间掉数据仍然要报错。
  let declaredMap = '';
  function isMapTransition(frame, merged) {
    const name = frame.map && frame.map.name;
    const changed = !!(name && name !== declaredMap);
    if (name) declaredMap = name;
    const phase = merged.map && merged.map.phase;
    return changed || phase === 'warmup' || phase === 'gameover';
  }

  lines.forEach(function (line, i) {
    let frame;
    try { frame = JSON.parse(line).payload; } catch (e) { return; }
    if (!frame) return;
    // 只回放游戏真的推过来的帧：_mock 是 tools/mock.js 编的场景，
    // 缺 provider 的是手搓的（真实 GSI 每一帧都带 provider）。
    // 这两种混进来会把「合并是否正确」的结论搅浑。
    if (!isRealFrame(frame)) { skipped++; return; }
    if (!('map' in frame)) deltas++;
    const m = mergeFrame(racc, frame);

    const hasMap = !!(m.map && m.map.name);
    const hasRound = !!(m.map && typeof m.map.round === 'number');
    const hasTeam = !!(m.player && (m.player.team === 'CT' || m.player.team === 'T'));
    const hasMoney = !!(m.player && m.player.state && typeof m.player.state.money === 'number');
    if (!hasMap || !hasRound || !hasTeam || !hasMoney) {
      if (isMapTransition(frame, m)) {
        excused++;
      } else {
        lastBadFrame = i;
        if (!hasMap) noMap++;
        if (!hasRound) noRound++;
        if (!hasTeam) noTeam++;
        if (!hasMoney) noMoney++;
      }
    }
    // 关键断言：帧里带了 weapons 时，合并后的数量必须和帧里一致（证明是整体替换）。
    // **旁观帧要排除**：那一帧的 weapons 属于被旁观者，而合并后的
    // state.player.weapons 仍然是「我」的（这是刻意设计，见第 3.5 组），
    // 数量当然对不上 —— 不排除的话会误报 120 帧。
    if (racc.spectating) {
      spectated++;
    } else if (frame.player && frame.player.weapons) {
      const rawN = Object.keys(frame.player.weapons).length;
      const mergedN = Object.keys((m.player && m.player.weapons) || {}).length;
      if (rawN !== mergedN) weaponMismatch++;
    }
  });

  console.log('  日志文件: ' + path.basename(logFile) + '（' + lines.length + ' 帧' +
    (skipped ? '，其中测试帧 ' + skipped + ' 已剔除' : '') +
    '，增量帧 ' + deltas + ' 帧）');
  console.log('  合并后仍缺 map 的帧: ' + noMap + '；缺 round: ' + noRound +
    '；缺阵营: ' + noTeam + '；缺 money: ' + noMoney +
    '（另有 ' + excused + ' 帧是换图 / 热身帧，缺数据属正常，不计入）');
  console.log('  最后一帧数据不全的位置: ' + (lastBadFrame < 0 ? '无' : '#' + lastBadFrame));
  console.log('  武器子树与原始帧数量不一致的帧: ' + weaponMismatch + '（必须为 0）');
  console.log('  其中判定为「旁观别人」的帧: ' + spectated + '（这些帧的 weapons 属于被旁观者，已排除在上一行之外）');

  // 允许开头有一段「还没进图」的帧（实测是前 20 帧内外），之后必须一直有完整数据
  const ALLOW_HEAD = 20;
  if (lastBadFrame >= ALLOW_HEAD) {
    fail('日志回放：第 ' + lastBadFrame + ' 帧之后仍出现数据缺失' +
      '（已排除换图 / 热身帧；前 ' + ALLOW_HEAD + ' 帧允许是未进图阶段）');
  } else {
    console.log('  ' + '第 ' + ALLOW_HEAD + ' 帧之后，非换图帧数据始终完整'.padEnd(46) + 'OK');
  }
  if (weaponMismatch !== 0) fail('日志回放：武器合并数量不一致 ' + weaponMismatch + ' 帧');
  else console.log('  ' + '武器子树整体替换语义正确'.padEnd(46) + 'OK');
  console.log('');
}

/* ==================================================================
 * 6. 炸弹状态：不许跨回合残留
 * ================================================================== */
console.log('-'.repeat(78));
console.log('炸弹状态（round.bomb 是回合结果，不能在后面的回合继续生效）：');
console.log('');

// 合成的核心用例：同一局里，第 3 回合下包，第 4 回合的增量帧里没有 round 字段
{
  const bacc = createAccumulator();
  mergeFrame(bacc, { map: { name: 'de_mirage', round: 3, phase: 'live' },
    round: { phase: 'live', bomb: 'planted' } });
  const planted = analyze(bacc.state, {}).bombPlanted;
  if (planted) console.log('  ' + 'live 阶段下了包 -> 报告已下包'.padEnd(46) + 'OK');
  else fail('炸弹状态：live 阶段 round.bomb=planted 却没报告已下包');

  // 下一回合：只有 map 的增量帧（没有 round 字段）
  mergeFrame(bacc, { map: { name: 'de_mirage', round: 4, phase: 'freezetime' } });
  const leaked = analyze(bacc.state, {}).bombPlanted;
  if (!leaked) console.log('  ' + '换回合后（增量帧无 round）不再报'.padEnd(46) + 'OK');
  else fail('炸弹状态：换回合后仍保留上一回合的 round.bomb —— 会每回合都喊「包已下」');

  // round.bomb = 'defused' 只在回合结果帧里出现，不能算「现在地上有包」
  const dacc = createAccumulator();
  mergeFrame(dacc, { map: { name: 'de_mirage', round: 2, phase: 'live' },
    round: { phase: 'live', win_team: 'CT', bomb: 'defused' } });
  if (!analyze(dacc.state, {}).bombPlanted) {
    console.log('  ' + 'round.bomb=defused 不算「包已下」'.padEnd(46) + 'OK');
  } else {
    fail('炸弹状态：把 defused（上一回合被拆）当成了「包已下」');
  }

  // 倒计时阶段物理上不可能有包在地上
  const facc = createAccumulator();
  mergeFrame(facc, { map: { name: 'de_mirage', round: 5, phase: 'freezetime' },
    round: { phase: 'freezetime', bomb: 'planted' } });
  if (!analyze(facc.state, {}).bombPlanted) {
    console.log('  ' + '倒计时阶段不报「包已下」'.padEnd(46) + 'OK');
  } else {
    fail('炸弹状态：倒计时阶段报了「包已下」');
  }
}

// 真实日志回放：没有 live 帧的回合，不可能真的下过包
if (logFile) {
  const lines2 = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const bacc2 = createAccumulator();
  const perRound = new Map();
  lines2.forEach(function (line) {
    let frame;
    try { frame = JSON.parse(line).payload; } catch (e) { return; }
    if (!isRealFrame(frame)) return;
    mergeFrame(bacc2, frame);
    let r;
    try { r = analyze(bacc2.state, {}); } catch (e) { return; }
    const key = String(r.roundIndex);
    if (!perRound.has(key)) perRound.set(key, { live: 0, planted: 0 });
    const rec = perRound.get(key);
    if (r.phase === 'live') rec.live++;
    if (r.bombPlanted) rec.planted++;
  });
  let phantom = [];
  perRound.forEach(function (rec, k) {
    if (rec.planted > 0 && rec.live === 0) phantom.push(k);
  });
  console.log('  ' + ('日志回放：' + perRound.size + ' 个回合，回合切换清理 ' + bacc2.roundClears + ' 次').padEnd(40) + 'OK');
  if (phantom.length) {
    fail('炸弹状态：第 ' + phantom.join('、') + ' 回合没有任何 live 帧却报告了「包已下」（跨回合残留）');
  } else {
    console.log('  ' + '没有 live 帧的回合一律不报「包已下」'.padEnd(46) + 'OK');
  }
}
console.log('');

/* ==================================================================
 * 7. 对手经济推算（核心）
 * ================================================================== */
console.log('-'.repeat(78));
console.log('对手经济推算（lib/enemy.js）：重建对手胜负序列 → 硬算收入下界 + 资金上界 → 结论');
console.log('  这一组的核心是那个 off-by-one：roundScore[k] 是「回合 k 开始前」的比分，');
console.log('  所以「回合 r 谁赢」必须用 roundScore[r+1] − roundScore[r]。');
console.log('  写反了的话每一回合都会被判成「未知」、覆盖率恒为 0、信心永远是「数据不全」——');
console.log('  而且不会报错，只会安静地退化。所以这里逐条钉死。');
console.log('');

const enemy = require('../lib/enemy');

let enBad = 0;
function enCheck(label, cond, extra) {
  if (cond) { console.log('  ' + label.padEnd(48) + 'OK'); return; }
  enBad++;
  console.log('  ' + label.padEnd(48) + 'BAD ' + (extra || ''));
}

// ---- 7.1 序列重建方向 ----
{
  const rs = { 0: { ct: 0, t: 0 }, 1: { ct: 1, t: 0 } };
  const seq = enemy.buildSequence(rs, 0, 1);
  enCheck('序列：CT 得分 -> 回合 0 判为 CT 胜',
    seq.length === 1 && seq[0].winner === 'CT', JSON.stringify(seq));

  const rs2 = { 0: { ct: 0, t: 0 }, 1: { ct: 0, t: 1 } };
  const seq2 = enemy.buildSequence(rs2, 0, 1);
  enCheck('序列：T 得分 -> 回合 0 判为 T 胜',
    seq2.length === 1 && seq2[0].winner === 'T', JSON.stringify(seq2));

  const seq3 = enemy.buildSequence({ 0: { ct: 0, t: 0 }, 1: { ct: 1, t: 1 } }, 0, 1);
  enCheck('序列：两边都得分（异常）-> 判为未知，不瞎猜',
    seq3.length === 1 && seq3[0].winner === null, JSON.stringify(seq3));

  const seq4 = enemy.buildSequence({}, 0, 3);
  enCheck('序列：没有快照 -> 3 个回合全是未知',
    seq4.length === 3 && seq4.every(function (s) { return s.winner === null; }));
}

// ---- 7.2 收入下界累积 ----
{
  const acc1 = enemy.accumulate([{ round: 0, winner: 'CT' }], 'T');
  // 起始 800 + 基础 800 + 一败 1400 = 3000（对手 T 输了）
  enCheck('累积：对手第 1 局就输 -> 人均 $3000（800+800+1400）',
    acc1.income === 3000 && acc1.streakAfter === 1, 'income=' + acc1.income);

  const acc2 = enemy.accumulate([
    { round: 0, winner: 'T' }, { round: 1, winner: 'T' }
  ], 'T');
  // 800 + 800*2 + 3250*2 = 8900
  enCheck('累积：对手连赢两局 -> 人均 $8900（800+1600+6500）',
    acc2.income === 8900 && acc2.streakAfter === 0, 'income=' + acc2.income);

  const acc3 = enemy.accumulate([{ round: 0, winner: null }], 'T');
  enCheck('累积：未知回合按「最少增益」计（首败 $1400）',
    acc3.income === 3000 && acc3.unknown === 1 && acc3.losses === 1, 'income=' + acc3.income);

  const acc4 = enemy.accumulate([
    { round: 0, winner: 'CT' }, { round: 1, winner: 'CT' }, { round: 2, winner: 'CT' }
  ], 'T');
  // 800 + 2400 + (1400+1900+2400) = 8900
  enCheck('累积：对手连败三局 -> 败方补偿走阶梯 1400/1900/2400',
    acc4.income === 8900 && acc4.streakAfter === 3, 'income=' + acc4.income);
}

// ---- 7.3 阶梯与门槛 ----
{
  enCheck('补偿阶梯：连败 0/1/2/3/4/9 局 -> 1400/1900/2400/2900/3400/3400',
    [0, 1, 2, 3, 4, 9].map(enemy.lossBonus).join(',') === '1400,1900,2400,2900,3400,3400',
    [0, 1, 2, 3, 4, 9].map(enemy.lossBonus).join(','));
  enCheck('补偿累计：连败 4 局共领 $8600（1400+1900+2400+2900）',
    enemy.lossCumulative(4) === 8600, String(enemy.lossCumulative(4)));

  const rfT = enemy.combatCostOf('T');
  const rfCT = enemy.combatCostOf('CT');
  enCheck('门槛：T 的「步枪+甲盔」= $3700（AK 2700 + 甲盔 1000）', rfT === 3700, '$' + rfT);
  enCheck('门槛：CT 的「步枪+甲盔」= $3900（M4A1-S 2900 + 甲盔 1000）', rfCT === 3900, '$' + rfCT);
  enCheck('门槛：CT 满买比 T 贵 $400（枪贵 $200 + 燃烧弹贵 $200）',
    enemy.fullCostOf('CT') === enemy.fullCostOf('T') + 400,
    'CT=$' + enemy.fullCostOf('CT') + ' T=$' + enemy.fullCostOf('T'));
}

// ---- 7.4 硬结论：上界低于门槛时必须是「确定」 ----
{
  // 我打 CT，对手 T。第 1 回合（索引 1，非手枪局）：对手输掉了第 0 回合。
  const e1 = enemy.estimate({
    side: 'CT', roundIndex: 1,
    roundScore: { 0: { ct: 0, t: 0 }, 1: { ct: 1, t: 0 } },
    theirLosses: 1
  });
  enCheck('第 1 回合对手输了 -> 覆盖率 100%', e1.available && e1.coverage === 1, 'cov=' + e1.coverage);
  // 上界 = 3000 + 1*300 = 3300 < 3700（步枪+甲盔） -> 硬结论
  enCheck('第 1 回合 -> 资金上界 $3300 < 步枪+甲盔 $3700',
    e1.cashCeil === 3300 && e1.cashCeil < e1.costs.combat,
    'ceil=' + e1.cashCeil + ' combat=' + e1.costs.combat);
  enCheck('第 1 回合 -> 结论为「确定」，档位是强起（凑不出人人长枪）',
    e1.conf === 'high' && e1.tier === 'FORCE_BUY', e1.conf + '/' + e1.tier);
  enCheck('第 1 回合 -> 语音短句非空（有硬结论就该播）', !!e1.say, JSON.stringify(e1.say));
  enCheck('第 1 回合 -> 推理链至少 4 条', (e1.why || []).length >= 4, String((e1.why || []).length));
  enCheck('第 1 回合 -> 返回的序列被带出来（debug 页要画）',
    Array.isArray(e1.seq) && e1.seq.length === 1, JSON.stringify(e1.seq || null));

  // 对手连败 3 局（索引 3，代表已走完 3 个回合）：补偿累计 $5700，上界已饱和 -> 走定性层
  const e3 = enemy.estimate({
    side: 'CT', roundIndex: 3,
    roundScore: {
      0: { ct: 0, t: 0 }, 1: { ct: 1, t: 0 }, 2: { ct: 2, t: 0 }, 3: { ct: 3, t: 0 }
    },
    theirLosses: 3
  });
  enCheck('对手连败 3 局 -> 档位「满买」（攒够了要反扑），信心「推算」',
    e3.streak === 3 && e3.tier === 'FULL_BUY' && e3.conf === 'mid',
    'streak=' + e3.streak + ' ' + e3.conf + '/' + e3.tier);
  enCheck('对手连败 3 局 -> 累计补偿 $5700 出现在结论里',
    e3.verdict.indexOf('5700') !== -1, e3.verdict);

  // 对手刚赢（连败清零）
  const eWin = enemy.estimate({
    side: 'CT', roundIndex: 3,
    roundScore: {
      0: { ct: 0, t: 0 }, 1: { ct: 0, t: 1 }, 2: { ct: 0, t: 2 }, 3: { ct: 0, t: 3 }
    },
    theirLosses: 0
  });
  enCheck('对手连赢 -> 连败清零、档位「满买」',
    eWin.streak === 0 && eWin.tier === 'FULL_BUY', 'streak=' + eWin.streak + '/' + eWin.tier);
}

// ---- 7.5 覆盖率不足必须降级，且不许播报 ----
{
  const eLow = enemy.estimate({
    side: 'CT', roundIndex: 8, roundScore: {}, theirLosses: 0
  });
  enCheck('完全没有比分快照 -> 覆盖率 0、信心「数据不全」',
    eLow.coverage === 0 && eLow.conf === 'low', 'cov=' + eLow.coverage + '/' + eLow.conf);
  enCheck('数据不全时档位留空（不给出会误导的档位）', eLow.tier === '', 'tier=' + eLow.tier);
  enCheck('数据不全时语音短句为空（宁可不说，也不说错）', eLow.say === '', JSON.stringify(eLow.say));
  enCheck('数据不全时结论里说明了原因',
    /不完整|中途/.test(eLow.verdict), eLow.verdict);

  // 7 个回合全部有快照 -> 覆盖率必须是 100%。
  // 注意 roundScore 要一直给到 roundIndex（=7）—— 第 6 回合的胜负要用 rs[7] 判，
  // 少给一格就会把最后一个回合算成「未知」，覆盖率掉到 6/7。
  // 逐回合推演（我打 CT，对手 T）：CT 拿前 5 局，T 拿后 2 局
  //   r0..r4 由 rs0→rs5 的分差判定 = CT 胜 -> 对手 T 输 5 局
  //   r5、r6 由 rs5→rs7 判定 = T 胜   -> 对手 T 赢 2 局，连败清零
  const eMostly = enemy.estimate({
    side: 'CT', roundIndex: 7,
    roundScore: {
      0: { ct: 0, t: 0 }, 1: { ct: 1, t: 0 }, 2: { ct: 2, t: 0 }, 3: { ct: 3, t: 0 },
      4: { ct: 4, t: 0 }, 5: { ct: 5, t: 0 }, 6: { ct: 5, t: 1 }, 7: { ct: 5, t: 2 }
    },
    theirLosses: 0
  });
  enCheck('7 个回合快照齐全 -> 覆盖率 100% 且不算「数据不全」',
    eMostly.coverage === 1 && eMostly.conf !== 'low',
    'cov=' + eMostly.coverage + '/' + eMostly.conf);
  enCheck('7 个回合快照齐全 -> 对手 2 胜 5 负，连败已清零',
    eMostly.halfWins === 2 && eMostly.halfLosses === 5 && eMostly.streak === 0,
    eMostly.halfWins + '胜' + eMostly.halfLosses + '负 streak=' + eMostly.streak);
}

// ---- 7.6 手枪局与边界 ----
{
  const p = enemy.estimate({ side: 'T', roundIndex: 12, roundScore: {}, theirLosses: 0 });
  enCheck('索引 12 是手枪局 -> 双方都 $800、信心「确定」',
    p.available && p.pistol === true && p.conf === 'high' && p.cashCeil === 800,
    'pistol=' + p.pistol + ' ceil=' + p.cashCeil);

  // 索引 0 也是手枪局，而且它**不需要任何历史**就能给确定结论。
  // 早先这里被「回合还没走完」的守卫挡住，明明最确定的回合反而说不出话。
  const p0 = enemy.estimate({ side: 'T', roundIndex: 0, roundScore: {}, theirLosses: 0 });
  enCheck('索引 0（上半场手枪局）-> 同样给确定结论，不被「没走完」挡住',
    p0.available && p0.pistol === true && p0.conf === 'high' && p0.cashCeil === 800,
    'available=' + p0.available + ' pistol=' + p0.pistol + ' ceil=' + p0.cashCeil);

  const pNo = enemy.estimate({ side: 'T', roundScore: {}, theirLosses: 0 });
  enCheck('拿不到回合号 -> 不可用，不硬凑', pNo.available === false, JSON.stringify(pNo.available));

  const pNeg = enemy.estimate({ side: 'T', roundIndex: -1, roundScore: {}, theirLosses: 0 });
  enCheck('回合号为负 -> 不可用', pNeg.available === false);

  const noSide = enemy.estimate({ side: null, roundIndex: 5, roundScore: {}, theirLosses: 0 });
  enCheck('还没确定阵营 -> 不可用', noSide.available === false);
}

// ---- 7.7 半场重置：下半场的收入要从 $800 重新起算 ----
{
  // 上半场 12 回合打完进入下半场，现在索引 14（下半场已走完 2 个回合）。
  // 我打 T，对手是 CT —— 要让**对手**输，就必须是 T 拿分。
  const rs = {
    12: { ct: 6, t: 6 },   // 下半场手枪局开打前的比分
    13: { ct: 6, t: 7 },   // 回合 12：T 赢 -> 对手 CT 输
    14: { ct: 6, t: 8 }    // 回合 13：T 赢 -> 对手 CT 输
  };
  const e = enemy.estimate({ side: 'T', roundIndex: 14, roundScore: rs, theirLosses: 2 });
  // 只算 12~13 两个回合：800 + 800*2 + (1400+1900) = 5700
  enCheck('下半场从 $800 重新起算（只累加本半场的 2 个回合）',
    e.endedThisHalf === 2 && e.income === 5700, 'ended=' + e.endedThisHalf + ' income=' + e.income);
  enCheck('下半场序列只覆盖本半场的回合数', (e.seq || []).length === 2, String((e.seq || []).length));
  enCheck('下半场对手连败 2 局 -> 结论是「半买」',
    e.streak === 2 && e.tier === 'HALF_BUY', 'streak=' + e.streak + '/' + e.tier);
}

// ---- 7.8 与 economy.js 的接线：a.enemy.losses 必须是「连败数」，不能被同名字段盖掉 ----
{
  // 关键设计：故意让这两个数**互不相等** ——
  //   enemyLosses（GSI 给的连败数）  = 2
  //   重建序列里的连败 streak        = 3   （最近 3 局都输）
  // 如果哪天又出现同名字段互相覆盖，2 和 3 里必然有一个对不上。
  // 逐回合推演（我打 T，对手 CT）：CT 赢 r0，然后 T 连赢 r1/r2/r3
  //   r0: rs0→rs1，ct 0→1      -> CT 胜 -> 对手赢，连败清零
  //   r1: rs1→rs2，t 0→1       -> T 胜  -> 对手输（第 1 连败）
  //   r2: rs2→rs3，t 1→2       -> T 胜  -> 对手输（第 2 连败）
  //   r3: rs3→rs4，t 2→3       -> T 胜  -> 对手输（第 3 连败）
  const a = analyze(makePayload({
    side: 'T', round: 4, phase: 'freezetime', scoreCT: 1, scoreT: 3,
    money: 4000, armor: 0, helmet: false, myLosses: 0, enemyLosses: 2,
    teamMoneys: [4000, 4000, 4000, 4000, 4000]
  }), {
    roundScore: {
      0: { ct: 0, t: 0 }, 1: { ct: 1, t: 0 }, 2: { ct: 1, t: 1 },
      3: { ct: 1, t: 2 }, 4: { ct: 1, t: 3 }
    }
  });
  enCheck('a.enemy.losses 是 GSI 的连败数（2），没被同名的推算字段盖掉',
    a.enemy.losses === 2, 'losses=' + a.enemy.losses);
  enCheck('a.enemy.halfLosses 是本半场输掉的回合数（3）',
    a.enemy.halfLosses === 3, 'halfLosses=' + a.enemy.halfLosses);
  enCheck('a.enemy.halfWins 是本半场赢的回合数（1）',
    a.enemy.halfWins === 1, 'halfWins=' + a.enemy.halfWins);
  enCheck('a.enemy.streak 用重建序列的值（3，比滞后的 GSI 值 2 更准）',
    a.enemy.streak === 3, 'streak=' + a.enemy.streak);
  enCheck('a.enemy.ifLoseNow 跟着 streak 走（连败 3 局 -> 再输拿 $2900）',
    a.enemy.ifLoseNow === 2900, 'ifLoseNow=' + a.enemy.ifLoseNow);
  enCheck('a.enemy 带上了推算结论', typeof a.enemy.verdict === 'string' && a.enemy.verdict.length > 0);
}

// ---- 7.9 真实日志回归 ----
if (logFile) {
  const lines3 = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const eacc = createAccumulator();
  let firstRound = null;
  let lastRound = null;
  let lastSide = null;
  let lastMap = null;
  let resetsSeen = eacc.resets;
  /*
   * snap = 「最后一次真正在局内」的快照（阵营 / 回合号 / 比分表都拷一份）。
   * 为什么要拷而不是直接读 eacc：日志末尾必然有一段「回大厅 / 换图铺场」的帧，
   * 那段帧会把累积器 reset 掉（roundScore 清空、player.team 变成 undefined）。
   * 不拷的话最后这几帧会把整组断言推进 else 分支直接跳过 —— 竞技日志里就是这么发生的。
   */
  let snap = null;

  /*
   * 这份日志跨了多张地图、多局比赛。累积器自己在换图时会 reset 并清空
   * roundScore（lib/gsi.js 的 map change 分支），所以「日志第一个回合号」
   * 和「roundScore 里装的是哪一局」并不是同一局 —— 必须跟着 reset 一起
   * 重置本地记账，否则会拿第 1 局的回合 0 去查第 5 局的 roundScore。
   */
  lines3.forEach(function (line) {
    let frame;
    try { frame = JSON.parse(line).payload; } catch (e) { return; }
    if (!isRealFrame(frame)) return;
    const before = eacc.resets;
    const m = mergeFrame(eacc, frame);
    if (eacc.resets !== before) {
      // 换图 / 新对局 / 热身结束 —— 和累积器同步清零
      resetsSeen = eacc.resets;
      firstRound = null; lastRound = null; lastSide = null; lastMap = null;
    }
    if (m.map && m.map.name) lastMap = m.map.name;
    if (m.map && typeof m.map.round === 'number') {
      if (firstRound === null) firstRound = m.map.round;
      lastRound = m.map.round;
    }
    if (m.player && (m.player.team === 'CT' || m.player.team === 'T')) lastSide = m.player.team;
    if (lastSide && lastRound !== null) {
      snap = {
        side: lastSide, round: lastRound, map: lastMap,
        roundScore: JSON.parse(JSON.stringify(eacc.roundScore))
      };
    }
  });

  if (snap && snap.side && snap.round !== null) {
    const e = enemy.estimate({
      side: snap.side, roundIndex: snap.round,
      roundScore: snap.roundScore, theirLosses: 0
    });
    const known = (e.seq || []).filter(function (s) { return s.winner !== null; }).length;
    console.log('  ' + ('日志回放（只算最后一局 ' + (lastMap || '?') + '）：上半场起点 ' +
      e.halfStart + '，当前回合 ' + lastRound + '，我打 ' + lastSide + '，重建 ' +
      (e.seq || []).length + ' 个回合，' + known + ' 个判定了胜负').slice(0, 46).padEnd(48) + 'OK');

    /*
     * 关键回归：本半场的**第 1 个回合**必须能判出胜负。
     * 这正是 off-by-one 会破坏的地方 —— 坏了的话 known 会恒等于 0。
     *
     * 注意这里不能写死「回合 1」：seq 只覆盖本半场，起点是 e.halfStart。
     * 下半场的 halfStart 是 12（MR12 每 12 回合经济重置），此时序列里
     * 只有 12/13/14… 这些回合，找「回合 1」必然找不到 —— 测试自己写错了。
     */
    if (firstRound !== null && firstRound <= e.halfStart && (e.seq || []).length >= 2) {
      const r1 = (e.seq || [])[0];
      enCheck('日志回归：本半场起点（索引 ' + e.halfStart + '）胜负判出（off-by-one 没复发）',
        !!r1 && r1.round === e.halfStart && r1.winner !== null, JSON.stringify(r1 || null));
      enCheck('日志回归：本半场覆盖率 >= 80%',
        e.coverage >= 0.8, 'cov=' + e.coverage);
    } else {
      console.log('  ' + ('（日志没覆盖到本半场起点 ' + e.halfStart + '，跳过强断言）'.padEnd(48)) + 'OK');
    }

    // 序列的胜负数必须和序列长度对得上，不能漏也不多重
    enCheck('日志回归：胜 + 负 = 序列长度',
      (e.halfWins || 0) + (e.halfLosses || 0) === (e.seq || []).length,
      (e.halfWins || 0) + '+' + (e.halfLosses || 0) + ' vs ' + (e.seq || []).length);
  } else {
    console.log('  跳过：日志里没有可用的阵营 / 回合信息。');
  }
} else {
  console.log('  跳过：logs/ 里还没有 .jsonl 文件。');
}
console.log('');
failed += enBad;

/* ==================================================================
 * 7.5 模式常数 · 击杀奖励 · 观测账本
 * ==================================================================
 * 这一组的由来：用户提了一个想法 ——
 *   「记下某个对手在回合开始时的**累计总击杀数**，和上一回合的相减，
 *     就是他上回合杀了几个人；再乘一个平均击杀奖励（比如 $400），
 *     就能更准地估对手的经济。」
 *
 * 方法本身完全正确，但落地前有两件事必须先钉死，这一组就是把它们钉死：
 *   1. **平均击杀奖励不是 $400，而且不是一个固定值** ——
 *      它按模式变（休闲模式所有击杀奖励减半）。实测出来的倍数是 ×0.50。
 *   2. **数据从哪来** —— GSI 在自己游玩时不下发敌方数据，
 *      这条链只在「阵亡后旁观到某个人」时才成立。有就用，没有就老实退回假设值。
 */
console.log('模式常数 / 击杀奖励 / 观测账本（休闲与竞技必须分开算）：');
let kbBad = 0;
function kbCheck(label, cond, extra) {
  if (cond) { console.log('  ' + label.padEnd(48) + 'OK'); return; }
  kbBad++;
  console.log('  ' + label.padEnd(48) + 'BAD ' + (extra || ''));
}

// ---- 7.5.1 模式识别 ----
kbCheck("modeOf('casual') 认出休闲", enemy.modeOf('casual') === 'casual');
kbCheck("modeOf('competitive') 认出竞技", enemy.modeOf('competitive') === 'competitive');
kbCheck("modeOf('premier') 归到竞技那套常数", enemy.modeOf('premier') === 'competitive');
kbCheck('模式缺失时按竞技兜底（不猜成休闲）',
  enemy.modeOf('') === 'competitive' && enemy.modeOf(undefined) === 'competitive' &&
  enemy.modeOf(null) === 'competitive');

// ---- 7.5.2 击杀奖励随模式变（这是「$400 均值」该不该用的核心） ----
kbCheck('竞技普通回合每杀按加权均值 $279（AWP 的 $100 拖低）',
  enemy.meanKillReward('competitive') === 279,
  String(enemy.meanKillReward('competitive')));
kbCheck('休闲普通回合每杀减半 -> $140',
  enemy.meanKillReward('casual') === 140,
  String(enemy.meanKillReward('casual')));
kbCheck('手枪局每杀 $300（那一局没有 AWP，均值更高）',
  enemy.meanKillReward('competitive', { pistol: true }) === 300);
kbCheck('休闲手枪局每杀 $150',
  enemy.meanKillReward('casual', { pistol: true }) === 150);
kbCheck('手枪局均值严格高于普通回合（两种模式都成立）',
  enemy.meanKillReward('competitive', { pistol: true }) > enemy.meanKillReward('competitive') &&
  enemy.meanKillReward('casual', { pistol: true }) > enemy.meanKillReward('casual'));
kbCheck('休闲每回合击杀上界 = 普通回合口径 $140', enemy.killCeilPerRound('casual') === 140);
kbCheck('竞技每回合击杀上界 = 普通回合口径 $279', enemy.killCeilPerRound('competitive') === 279);
kbCheck('休闲的倍率就是 0.5（和实测一致）', enemy.MODES.casual.KILL_MUL === 0.5);
kbCheck('击杀奖励表里 AWP $100 / 步枪 $300 / 微冲 $600（竞技原值）',
  enemy.KILL_REWARD.awp === 100 && enemy.KILL_REWARD.rifle === 300 &&
  enemy.KILL_REWARD.smg === 600);

// ---- 7.5.3 休闲护甲白送 -> 对手凑长枪的门槛更低 ----
kbCheck('竞技：步枪 + 甲盔 = $3700', enemy.combatCostOf('T', 'competitive') === 3700,
  String(enemy.combatCostOf('T', 'competitive')));
kbCheck('休闲：护甲白送，步枪只要 $2700', enemy.combatCostOf('T', 'casual') === 2700,
  String(enemy.combatCostOf('T', 'casual')));
kbCheck('休闲满买正好比竞技便宜 $1000（就是那份甲钱）',
  enemy.fullCostOf('T', 'competitive') - enemy.fullCostOf('T', 'casual') === 1000,
  enemy.fullCostOf('T', 'competitive') + ' vs ' + enemy.fullCostOf('T', 'casual'));

// ---- 7.5.4 estimate 必须跟着模式走 ----
const rsMode = { 0: { ct: 0, t: 0 }, 1: { ct: 0, t: 1 }, 2: { ct: 1, t: 1 }, 3: { ct: 1, t: 2 } };
const qCas = enemy.estimate({ side: 'CT', roundIndex: 3, roundScore: rsMode, theirLosses: 0, mode: 'casual' });
const qCom = enemy.estimate({ side: 'CT', roundIndex: 3, roundScore: rsMode, theirLosses: 0, mode: 'competitive' });
kbCheck('estimate 回填用了哪套模式', qCas.mode === 'casual' && qCom.mode === 'competitive');
kbCheck('休闲的每杀奖励字段 = $140（普通回合口径）', qCas.killReward === 140, String(qCas.killReward));
kbCheck('竞技的每杀奖励字段 = $279（普通回合口径）', qCom.killReward === 279, String(qCom.killReward));
kbCheck('同样局面下休闲的资金上界比竞技低（胜利奖金和击杀奖励都更低）',
  qCas.cashCeil < qCom.cashCeil, qCas.cashCeil + ' vs ' + qCom.cashCeil);
kbCheck('手枪局起始资金随模式：休闲 $1000',
  enemy.estimate({ side: 'T', roundIndex: 0, mode: 'casual' }).cashCeil === 1000);
kbCheck('手枪局起始资金随模式：竞技 $800',
  enemy.estimate({ side: 'T', roundIndex: 0, mode: 'competitive' }).cashCeil === 800);
kbCheck('没有观测数据时 killSource = assumed，且不假报击杀数',
  qCas.killSource === 'assumed' && qCas.killsPerRound === null && qCas.killObservedPlayers === 0);

// ---- 7.5.5 「累计击杀数做差」这个算法本身 ----
const L = function (side, samples, name) {
  return { 'x1': { name: name || '对手', side: side, samples: samples } };
};
const mDiff = enemy.measuredKillsPerRound(
  L('T', [{ round: 1, kills: 0 }, { round: 3, kills: 4 }]), 'T', 0);
kbCheck('回合1→3 之间涨 4 杀 -> 人均 2.00 杀/回合',
  !!mDiff && Math.abs(mDiff.killsPerRound - 2) < 1e-9,
  mDiff ? String(mDiff.killsPerRound) : 'null');

kbCheck('只统计敌方：队友那条必须被忽略',
  enemy.measuredKillsPerRound(L('CT', [{ round: 1, kills: 0 }, { round: 3, kills: 4 }]), 'T', 0) === null);

kbCheck('没有敌方样本 -> null（不许瞎编）',
  enemy.measuredKillsPerRound({}, 'T', 0) === null &&
  enemy.measuredKillsPerRound(null, 'T', 0) === null);

kbCheck('同一回合的重复采样不影响结果（回合内已发生的击杀不能算进差值）',
  (function () {
    const a = enemy.measuredKillsPerRound(L('T', [{ round: 1, kills: 0 }, { round: 3, kills: 4 }]), 'T', 0);
    const b = enemy.measuredKillsPerRound(L('T', [{ round: 1, kills: 0 }, { round: 1, kills: 2 }, { round: 3, kills: 4 }]), 'T', 0);
    return a && b && Math.abs(a.killsPerRound - b.killsPerRound) < 1e-9;
  })());

kbCheck('累计值倒退（换局了）-> 整条作废，不产生负数',
  enemy.measuredKillsPerRound(L('T', [{ round: 1, kills: 9 }, { round: 2, kills: 2 }]), 'T', 0) === null);

kbCheck('同一回合内的两个采样 -> 算不出差值 -> null',
  enemy.measuredKillsPerRound(L('T', [{ round: 2, kills: 1 }, { round: 2, kills: 3 }]), 'T', 0) === null);

kbCheck('本半场样本优先（scope = half）',
  (function () {
    const m = enemy.measuredKillsPerRound(
      L('T', [{ round: 1, kills: 0 }, { round: 2, kills: 1 }, { round: 13, kills: 5 }, { round: 14, kills: 6 }]), 'T', 12);
    return m && m.scope === 'half' && Math.abs(m.killsPerRound - 1) < 1e-9;
  })());

kbCheck('本半场凑不出差值时退回整局样本（scope = match）',
  (function () {
    // 本半场只剩一个采样点（round 13），算不出差值 -> 退回整局：
    //   1→3 涨 6 杀（2 回合）、3→13 涨 1 杀（10 回合）=> 7 杀 / 12 回合
    const m = enemy.measuredKillsPerRound(
      L('T', [{ round: 1, kills: 0 }, { round: 3, kills: 6 }, { round: 13, kills: 7 }]), 'T', 12);
    return m && m.scope === 'match' && Math.abs(m.killsPerRound - 7 / 12) < 1e-9;
  })());

// ---- 7.5.6 有实测就用实测（这正是用户想要的那条路） ----
const ledgerOn = L('T', [{ round: 0, kills: 0 }, { round: 1, kills: 1 }, { round: 2, kills: 2 }, { round: 3, kills: 3 }]);
const eMeas = enemy.estimate({
  side: 'CT', roundIndex: 3, roundScore: rsMode, theirLosses: 0, mode: 'casual', killLedger: ledgerOn
});
kbCheck('有敌方账本 -> killSource = measured', eMeas.killSource === 'measured', eMeas.killSource);
kbCheck('实测人均每回合击杀 = 1.00', Math.abs(eMeas.killsPerRound - 1) < 1e-9, String(eMeas.killsPerRound));
kbCheck('killIncome = 1 杀/回合 × (手枪局 $150 + 两回合 $140) = $430',
  Math.abs(eMeas.killIncome - 430) < 1e-9, String(eMeas.killIncome));
kbCheck('实测值真的进了资金上界（上界 = 收入 + 击杀收入）',
  Math.abs(eMeas.cashCeil - Math.min(10000, eMeas.income + 430)) < 1e-6,
  eMeas.cashCeil + ' vs ' + (eMeas.income + 430));
kbCheck('说明里写明了是算出来的、并给出被杀的那个人',
  eMeas.why.join('').indexOf('是**算出来的**') !== -1 &&
  eMeas.why.join('').indexOf('对手') !== -1);

// 「一杀未得」是假设值永远给不出的结论 —— 这是实测路线的最大价值
const eZero = enemy.estimate({
  side: 'CT', roundIndex: 3, roundScore: rsMode, theirLosses: 0, mode: 'casual',
  killLedger: L('T', [{ round: 0, kills: 7 }, { round: 3, kills: 7 }])
});
kbCheck('实测「这几回合一个人头都没拿」-> killIncome 归零',
  eZero.killSource === 'measured' && eZero.killIncome === 0, String(eZero.killIncome));
kbCheck('对照：同样局面用假设值会凭空多算 $430',
  qCas.killIncome === 430, String(qCas.killIncome));

/* ---- 7.6 炸弹结算：$3500 与 T 埋包失败的 $800 ----
 * 这两条是「收入侧」漏掉的真实规则，实测依据见 lib/enemy.js 的 WIN_BOMB_EXTRA 注释。
 * 都只会抬高上界，方向上永远安全。 */
{
  // T 连赢两局（我打 CT）
  const rsT = { 0: { ct: 0, t: 0 }, 1: { ct: 0, t: 1 }, 2: { ct: 0, t: 2 } };
  const plain = enemy.estimate({ side: 'CT', roundIndex: 2, roundScore: rsT, theirLosses: 0, mode: 'competitive' });
  const bomb = enemy.estimate({
    side: 'CT', roundIndex: 2, roundScore: rsT, theirLosses: 0, mode: 'competitive',
    roundPlant: { 0: true, 1: true }
  });
  kbCheck('以炸弹结束的胜局每人多 $250（两局 -> 收入多 $500）',
    bomb.income - plain.income === 2 * enemy.WIN_BOMB_EXTRA,
    (bomb.income - plain.income) + ' vs ' + (2 * enemy.WIN_BOMB_EXTRA));
  kbCheck('bombWins 计数正确', bomb.bombWins === 2 && plain.bombWins === 0,
    bomb.bombWins + ' / ' + plain.bombWins);
  kbCheck('没有埋包记录时完全不加钱（不许默认加成）',
    plain.income === 800 + 2 * 800 + 2 * 3250, String(plain.income));

  // CT 连赢两局，而对手 T 埋了包却输掉 —— T 每人多拿 $800（我打 CT，对手是 T）
  const rsCT = { 0: { ct: 0, t: 0 }, 1: { ct: 1, t: 0 }, 2: { ct: 2, t: 0 } };
  const tPlain = enemy.estimate({ side: 'CT', roundIndex: 2, roundScore: rsCT, theirLosses: 0, mode: 'competitive' });
  const tPlant = enemy.estimate({
    side: 'CT', roundIndex: 2, roundScore: rsCT, theirLosses: 0, mode: 'competitive',
    roundPlant: { 0: true, 1: true }
  });
  kbCheck('T 埋包后仍输 -> 每人 +$800（两局 +$1600）',
    tPlant.income - tPlain.income === 2 * enemy.PLANT_LOSS,
    (tPlant.income - tPlain.income) + ' vs ' + (2 * enemy.PLANT_LOSS));
  kbCheck('这笔补偿只给 T：对手是 CT 时不给',
    (function () {
      const a = enemy.estimate({ side: 'T', roundIndex: 2, roundScore: rsT, theirLosses: 0, mode: 'competitive' });
      const b = enemy.estimate({
        side: 'T', roundIndex: 2, roundScore: rsT, theirLosses: 0, mode: 'competitive',
        roundPlant: { 0: true, 1: true }
      });
      return b.plantLosses === 0;
    })());
}

/* ---- 7.7 手枪局每杀均值 & 死亡数推算支出 ---- */
{
  // 逐回合取奖励：手枪局（0 / 12）用 $300，普通回合用加权均值 $279
  kbCheck('手枪局那一段按 $300 算', enemy.killIncomeOf([{ round: 0 }], 'competitive', null) === 300);
  kbCheck('两个普通回合按 $279 × 2 = $558 算',
    enemy.killIncomeOf([{ round: 1 }, { round: 2 }], 'competitive', null) === 558);
  kbCheck('混着手枪局时逐回合算（300 + 279 = 579），不是简单乘回合数',
    enemy.killIncomeOf([{ round: 0 }, { round: 1 }], 'competitive', null) === 579);
  kbCheck('休闲同样逐回合减半（150 + 140 = 290）',
    enemy.killIncomeOf([{ round: 0 }, { round: 1 }], 'casual', null) === 290);
  kbCheck('下半场手枪局（索引 12）也认',
    enemy.killIncomeOf([{ round: 12 }], 'competitive', null) === 300);

  // 死亡数走的是和击杀数同一个差分
  const ledD = {
    d1: {
      name: '对手甲', side: 'T', samples: [
        { round: 0, kills: 0, deaths: 0 },
        { round: 2, kills: 1, deaths: 2 },
        { round: 4, kills: 2, deaths: 3 }
      ]
    }
  };
  const mD = enemy.measuredDeathsPerRound(ledD, 'T', 0);
  kbCheck('死亡数：4 回合死 3 次 -> 0.75 死/回合',
    !!mD && Math.abs(mD.deathsPerRound - 0.75) < 1e-9,
    mD ? String(mD.deathsPerRound) : 'null');
  kbCheck('死亡账本也只统计敌方（队友那条忽略）',
    enemy.measuredDeathsPerRound(ledD, 'CT', 0) === null);
  kbCheck('同一份账本里击杀与死亡互不干扰（击杀仍是 2 杀 / 4 回合）',
    Math.abs(enemy.measuredKillsPerRound(ledD, 'T', 0).killsPerRound - 0.5) < 1e-9);

  const rs4 = {
    0: { ct: 0, t: 0 }, 1: { ct: 0, t: 1 }, 2: { ct: 1, t: 1 },
    3: { ct: 1, t: 2 }, 4: { ct: 2, t: 2 }
  };
  const mkLed = function (deaths) {
    return {
      d1: {
        name: '对手甲', side: 'T',
        samples: deaths.map(function (d, i) { return { round: i * 2, kills: i, deaths: d }; })
      }
    };
  };
  const eA = enemy.estimate({
    side: 'CT', roundIndex: 4, roundScore: rs4, theirLosses: 0, mode: 'competitive',
    killLedger: mkLed([0, 0, 0])
  });
  const eB = enemy.estimate({
    side: 'CT', roundIndex: 4, roundScore: rs4, theirLosses: 0, mode: 'competitive',
    killLedger: mkLed([0, 2, 3])
  });
  kbCheck('有死亡样本 -> deathSource = measured，且给出 cashLikely',
    eB.deathSource === 'measured' && typeof eB.cashLikely === 'number',
    eB.deathSource + ' / ' + eB.cashLikely);
  kbCheck('估算支出 = 0.75 死/回合 × 重购成本 × 回合数',
    eB.spendEst === Math.round(0.75 * eB.costs.combat * eB.seq.length),
    eB.spendEst + ' vs ' + Math.round(0.75 * eB.costs.combat * eB.seq.length));
  kbCheck('cashLikely 落在 [0, cashCeil] 之间',
    eB.cashLikely >= 0 && eB.cashLikely <= eB.cashCeil,
    eB.cashLikely + ' / ' + Math.round(eB.cashCeil));
  kbCheck('零死亡 -> cashLikely 等于上界（没扣钱）',
    eA.cashLikely === Math.round(eA.cashCeil), String(eA.cashLikely));
  kbCheck('支出估算只动 cashLikely，不动上界、不动档位',
    eA.cashCeil === eB.cashCeil && eA.tier === eB.tier &&
    eA.conf === eB.conf && eA.verdict === eB.verdict,
    eA.tier + '/' + eB.tier);
  kbCheck('没有死亡样本时 cashLikely = null（不编数字）',
    enemy.estimate({
      side: 'CT', roundIndex: 4, roundScore: rs4, theirLosses: 0, mode: 'competitive'
    }).cashLikely === null);
}

// ---- 7.5.7 真实日志：账本必须真的收到东西 ----
if (logFile) {
  const lines4 = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const kacc = createAccumulator();
  let lastFrame = null;        // 最后一帧 —— 可能已经退回菜单，map.mode / player.team 都没了
  let lastMatchFrame = null;   // 最后一帧「还在局内」（map.mode 和 player.team 都在）
  let ledgerPeak = 0;          // 账本历史最多收到过几名玩家
  let ledgerSnapshot = null;   // 账本非空时的最后一份拷贝（末尾换图会把它清空，这是对的）
  let scoreSnapshot = null;    // 和 lastMatchFrame 同一时刻的比分快照
  let plantSnapshot = null;    // 同一时刻的埋包记录（必须一起快照，否则会算进之后打的回合）
  let obsBest = null;          // 整份日志里，账本为某一侧凑出过的最好一次击杀频率
  lines4.forEach(function (line) {
    let frame;
    try { frame = JSON.parse(line).payload; } catch (e) { return; }
    if (!isRealFrame(frame)) return;
    const merged = mergeFrame(kacc, frame);
    lastFrame = merged;
    const n = Object.keys(kacc.killLedger).length;
    if (n > ledgerPeak) ledgerPeak = n;
    if (n > 0) ledgerSnapshot = JSON.parse(JSON.stringify(kacc.killLedger));
    // 观测链路能不能通，要看「整份日志里有没有成功过一次」，
    // 而不是看末尾那一刻 —— 末尾你固定在自己队里，对手侧常常凑不出两条样本。
    if (n >= 2) {
      ['CT', 'T'].forEach(function (side) {
        const got = enemy.measuredKillsPerRound(kacc.killLedger, side, 0);
        if (got && (!obsBest || got.rounds > obsBest.rounds)) {
          obsBest = { side: side, killsPerRound: got.killsPerRound, kills: got.kills, rounds: got.rounds };
        }
      });
    }
    if (merged.map && merged.map.mode && merged.player && merged.player.team) {
      // 累积器的 state 是原地改的，必须拷一份，否则拿到的永远是最终状态
      lastMatchFrame = JSON.parse(JSON.stringify(merged));
      scoreSnapshot = JSON.parse(JSON.stringify(kacc.roundScore));
      plantSnapshot = JSON.parse(JSON.stringify(kacc.roundPlant));
    }
  });
  /*
   * 注意口径：账本查的是**历史快照**而不是最终状态。
   * 原因是日志末尾一定会出现「下一张图 round 0」的帧（换图 / 回大厅再进），
   * mergeFrame 会按设计把账本清掉 —— 那时再看最终状态永远是 0，会误报成「账本坏了」。
   * 真实竞技日志里就是第 2258 帧（共 2265 帧）触发了这次清空。
   */
  const ledger = ledgerSnapshot || kacc.killLedger;
  const ledgerIds = Object.keys(ledger);
  kbCheck('真实日志：击杀账本收到过玩家（历史最多 ' + ledgerPeak + ' 名）',
    ledgerPeak >= 1, String(ledgerPeak));

  const multi = ledgerIds.filter(function (id) { return ledger[id].samples.length >= 2; });
  kbCheck('真实日志：有玩家的采样跨了多个回合（够做差）', multi.length >= 1, String(multi.length));

  // 每个回合只留一笔 —— 这是差值能成立的前提
  let dupRound = 0;
  ledgerIds.forEach(function (id) {
    const rounds = ledger[id].samples.map(function (s) { return s.round; });
    if (new Set(rounds).size !== rounds.length) dupRound++;
  });
  kbCheck('真实日志：同一回合只留一笔采样（没有重复）', dupRound === 0, String(dupRound));

  if (lastMatchFrame && lastMatchFrame.map) {
    const fSide = lastMatchFrame.player.team;
    const foeSide = enemy.foeOf(fSide);
    // 这一条查的是「整份日志里这条链路有没有通过一次」，不是末尾那一刻
    kbCheck('真实日志：观测账本至少凑出过一次击杀频率（链路通了）',
      !!obsBest,
      obsBest
        ? (obsBest.side === foeSide ? '敌方侧 ' : obsBest.side + ' 侧 ') +
          obsBest.killsPerRound.toFixed(2) + ' 杀/回合（' + obsBest.kills + ' 杀 / ' + obsBest.rounds + ' 回合）'
        : 'null');
    kbCheck('真实日志：凑出来的击杀频率落在 0~5 杀/回合这个合理区间',
      !!obsBest && obsBest.killsPerRound >= 0 && obsBest.killsPerRound <= 5,
      obsBest ? obsBest.killsPerRound.toFixed(2) : 'null');

    const eReal = enemy.estimate({
      side: fSide, roundIndex: lastMatchFrame.map.round, roundScore: scoreSnapshot || kacc.roundScore,
      theirLosses: 0, mode: lastMatchFrame.map.mode, killLedger: ledger,
      roundPlant: plantSnapshot || kacc.roundPlant
    });
    // 模式识别必须和 map.mode 对得上，而不是写死一个
    kbCheck('真实日志：模式识别和 map.mode 一致',
      eReal.mode === enemy.modeOf(lastMatchFrame.map.mode),
      lastMatchFrame.map.mode + ' -> ' + eReal.mode);
    kbCheck('真实日志：每杀奖励跟模式走（普通回合加权 / 手枪局手枪档）',
      eReal.killReward === enemy.meanKillReward(eReal.mode) &&
      eReal.killRewardPistol === enemy.meanKillReward(eReal.mode, { pistol: true }) &&
      eReal.killRewardPistol >= eReal.killReward,
      '$' + eReal.killReward + '，手枪局 $' + eReal.killRewardPistol);
    kbCheck('真实日志：击杀收入按逐回合奖励累加（手枪局单独算）',
      Math.abs(eReal.killIncome - enemy.killIncomeOf(
        eReal.seq, eReal.mode,
        eReal.killSource === 'measured' ? eReal.killsPerRound : null)) < 1e-6,
      eReal.killSource + ' $' + Math.round(eReal.killIncome));
  } else {
    warn('日志里没有「局内」帧（只有菜单帧），跳过 4 条真实日志断言。');
  }

  /* ---- 7.5.8 真实日志：从资金事件反推模式常数 ----
   * 这一组是「用真实比赛数据校准常数」，不是抄文档。
   *
   * 做法：只看**前后两帧 player 块都是你本人**的相邻帧，这样 money 的差值
   * 才是「你的钱真的变了」，不会被死亡镜头切到别人身上污染。
   * （5E 竞技实测：player 块只有 62% 的时间是你自己，14 个身份、149 次切换。）
   */
  const modeFrames = {};
  let myId = null;
  const moneyEvents = [];
  let prevMine = null;
  lines4.forEach(function (line) {
    let frame;
    try { frame = JSON.parse(line).payload; } catch (e) { return; }
    if (!isRealFrame(frame)) return;
    if (!myId) myId = frame.provider.steamid;
    const mine = !!(frame.player && frame.player.steamid === myId);
    if (frame.map && frame.map.mode) modeFrames[frame.map.mode] = (modeFrames[frame.map.mode] || 0) + 1;
    const pm = frame.previously && frame.previously.player && frame.previously.player.state &&
      frame.previously.player.state.money;
    const cm = frame.player && frame.player.state && frame.player.state.money;
    if (mine && prevMine === true && typeof pm === 'number' && typeof cm === 'number' && pm !== cm) {
      moneyEvents.push({ d: cm - pm, pm: pm, cm: cm, mode: frame.map && frame.map.mode });
    }
    if (frame.player && frame.player.steamid) prevMine = mine;
  });
  const compFrames = modeFrames.competitive || 0;
  const casualFrames = modeFrames.casual || 0;
  console.log('  日志里的模式分布：' + (Object.keys(modeFrames).map(function (k) {
    return k + '×' + modeFrames[k];
  }).join('，') || '（无）') + '；干净的资金变动 ' + moneyEvents.length + ' 笔');

  if (compFrames > 200) {
    const comp = moneyEvents.filter(function (e) { return e.mode === 'competitive'; });
    const has = function (v) { return comp.some(function (e) { return e.d === v; }); };
    kbCheck('真实竞技日志：出现过 +$3250 的回合胜利奖金',
      has(3250), '样本 ' + comp.filter(function (e) { return e.d === 3250; }).length);
    kbCheck('真实竞技日志：出现过 +$300 的击杀奖励（步枪/手枪档）',
      has(300), '样本 ' + comp.filter(function (e) { return e.d === 300; }).length);
    const LAD = [1400, 1900, 2400, 2900, 3400];
    const ladderHit = LAD.filter(has);
    kbCheck('真实竞技日志：连败奖金都落在 1400/1900/2400/2900/3400 这套阶梯上',
      ladderHit.length >= 2 && ladderHit.every(function (v) { return LAD.indexOf(v) !== -1; }),
      '实测到 ' + ladderHit.length + ' 档：' + ladderHit.map(function (v) {
        return v + '×' + comp.filter(function (e) { return e.d === v; }).length;
      }).join(' '));
    kbCheck('真实竞技日志：击杀奖励全是竞技原值（$300 出现、$150 不出现）',
      has(300) && !has(150), '$150 出现 ' + comp.filter(function (e) { return e.d === 150; }).length + ' 次');
    kbCheck('真实竞技日志：资金上限 $16000 出现过',
      comp.some(function (e) { return e.cm === 16000; }),
      '最高余额 ' + Math.max.apply(null, comp.map(function (e) { return e.cm; })));
    kbCheck('竞技起始资金 $800 在日志里出现过（手枪局从热身的大额余额降到 $800）',
      comp.some(function (e) { return e.d === -15200; }) ||
      comp.some(function (e) { return e.d < -10000; }),
      '最大降幅 ' + Math.min.apply(null, comp.map(function (e) { return e.d; })));
  } else if (casualFrames > 200) {
    const cas = moneyEvents.filter(function (e) { return e.mode === 'casual'; });
    const has = function (v) { return cas.some(function (e) { return e.d === v; }); };
    kbCheck('真实休闲日志：击杀奖励是竞技的一半（$150 出现、$300 不出现）',
      has(150) && !has(300), '$150×' + cas.filter(function (e) { return e.d === 150; }).length);
  } else {
    warn('日志里没有足够的一整模式帧，跳过「真实日志反推常数」这一组。');
  }

  // 换局必须清空账本 —— 击杀数是按局累计的，把上一局的采样留着会让差值算出负数
  // （这里手搓最小帧，不用 tools/mock.js：那个构造器要一大堆场景参数，
  //   而这条测试关心的是「换图那一刻账本有没有被清」，跟场景无关。）
  const kacc2 = createAccumulator();
  const rawFrame = function (mapName, round, kills) {
    return {
      provider: { appid: 730, steamid: 'me' },
      map: {
        name: mapName, mode: 'competitive', phase: 'live', round: round,
        team_ct: { score: 0 }, team_t: { score: 0 }
      },
      player: {
        steamid: '999', name: '甲', team: 'T',
        match_stats: { kills: kills }, state: { money: 1000, health: 100 }
      }
    };
  };
  mergeFrame(kacc2, rawFrame('de_mirage', 5, 9));
  const before = Object.keys(kacc2.killLedger).length;
  const rateBefore = enemy.measuredKillsPerRound(kacc2.killLedger, 'T', 0);
  // 新地图、回合号更大、击杀数也更大 —— 如果账本没清，这两笔会拼成一个假的「1 回合 1 杀」
  mergeFrame(kacc2, rawFrame('de_inferno', 6, 10));
  const rateAfter = enemy.measuredKillsPerRound(kacc2.killLedger, 'T', 0);
  kbCheck('换图后账本被清空（不然会拼出跨越两局的假差值）',
    before === 1 && rateBefore === null && rateAfter === null,
    before + ' / ' + (rateBefore ? 'rate=' + rateBefore.killsPerRound : 'null') +
    ' -> ' + (rateAfter ? 'rate=' + rateAfter.killsPerRound : 'null'));
} else {
  console.log('  跳过：logs/ 里还没有 .jsonl 文件。');
}
console.log('');
failed += kbBad;

/* ==================================================================
 * 8. 语音播报文案
 * ================================================================== */
console.log('-'.repeat(78));
console.log('语音播报文案（speech.js 是浏览器脚本，这里给它造一个最小的浏览器桩来跑）：');
console.log('  重点验三件事：');
console.log('   ① 手枪局的 enemy.say 曾经是 undefined，导致语音掉进兜底分支，');
console.log('      说出「对面经济正常，大概率完整购买」—— 和事实完全相反；');
console.log('   ② 数据不全（覆盖率低）时兜底也会说出同样那句没有依据的话。');
console.log('      播一句错的比不播更糟，所以这两处必须钉住。');
console.log('   ③ 买枪建议和战术已经移除，播报里不许再出现枪名和落点。');
console.log('');

let spBad = 0;
function spCheck(label, cond, extra) {
  if (cond) { console.log('  ' + label.padEnd(48) + 'OK'); return; }
  spBad++;
  console.log('  ' + label.padEnd(48) + 'BAD ' + (extra || ''));
}

{
  // 最小浏览器桩：document.getElementById 一律返回 null，脚本会自己安静退出
  global.window = global;
  global.document = {
    readyState: 'complete',
    getElementById: function () { return null; },
    addEventListener: function () {},
    createElement: function () { return {}; }
  };
  global.localStorage = { getItem: function () { return null; }, setItem: function () {} };
  require('../public/speech.js');   // 会把 BuyHelperSpeech 挂到 global 上
  const S = global.BuyHelperSpeech;

  spCheck('speech.js 能在桩环境里加载出来', !!(S && typeof S.compose === 'function'));

  // ① 手枪局：必须说「手枪局」，绝不能出现「对面经济正常」
  const pistol = analyze(makePayload(SCENARIOS.pistol0), { roundScore: {} });
  spCheck('手枪局 -> enemy.say 已生成（不再是 undefined）',
    typeof pistol.enemy.say === 'string' && pistol.enemy.say.length > 0,
    JSON.stringify(pistol.enemy.say));
  const sp1 = S.compose(pistol);
  spCheck('手枪局 -> 播报里出现「手枪局」', sp1.indexOf('手枪局') !== -1, sp1);
  spCheck('手枪局 -> 播报里不出现「对面经济正常」这句反话',
    sp1.indexOf('对面经济正常') === -1, sp1);

  // ② 数据不全：什么都不该说
  const blind = analyze(makePayload(SCENARIOS.eco), { roundScore: {} });
  spCheck('数据不全时 enemy.say 为空串（lib 层就闭嘴）',
    blind.enemy.conf === 'low' && blind.enemy.say === '', JSON.stringify(blind.enemy.say));
  const sp2 = S.compose(blind);
  spCheck('数据不全且连败为 0 -> 一个字都不念', sp2 === '', JSON.stringify(sp2));

  // ③ 硬结论（资金上界低于买枪门槛）：那句「买不起长枪」必须念出来
  const hard = analyze(makePayload({
    side: 'CT', round: 1, phase: 'freezetime', scoreCT: 0, scoreT: 0,
    money: 3000, armor: 0, helmet: false, myLosses: 0, enemyLosses: 1,
    teamMoneys: [3000, 3000, 3000, 3000, 3000]
  }), { roundScore: { 0: { ct: 0, t: 0 }, 1: { ct: 1, t: 0 } } });
  spCheck('硬结论场景 enemy.conf 是 high', hard.enemy.conf === 'high', hard.enemy.conf);
  const sp3 = S.compose(hard);
  spCheck('硬结论 -> 播报里出现「买不起长枪」',
    sp3.indexOf('买不起长枪') !== -1, sp3);

  // ④ 播报里不该再有任何买枪 / 战术内容（这些功能已经移除）
  const GONE_WORDS = ['AK-47', 'M4A1-S', 'M4A4', 'AWP', '道具带满', '烟封', '火清', '双闪',
    '打 A 点', '打 B 点', '优先买甲'];
  const leakedWords = GONE_WORDS.filter(function (w) { return sp3.indexOf(w) !== -1; });
  spCheck('播报里不再出现枪名 / 道具 / 落点（买枪与战术已移除）',
    leakedWords.length === 0, leakedWords.join('、'));

  // ⑤ 推算层不可用、但 GSI 的连败数是精确的 -> 仍然可以说连败
  const manual = S.compose({
    side: 'T', roundNum: 5,
    enemy: { available: false, conf: 'low', say: '', losses: 3, streak: 3, ifLoseNow: 2900 }
  });
  spCheck('推算不可用但连败 3 局 -> 播报仍然带上「对面连败 3 局」',
    manual.indexOf('对面连败 3 局') !== -1, manual);
  spCheck('连败时补上「本回合再输能拿多少」（这是精确值）',
    manual.indexOf('2900') !== -1, manual);

  // ⑥ 没有 TTS 接口时不能抛错
  spCheck('没有语音合成接口时 supported() 返回 false（不抛错）',
    S.supported() === false);
}
console.log('');
failed += spBad;

/* ==================================================================
 * 9. 日志留存（异步）
 * ================================================================== */
console.log('-'.repeat(78));
console.log('日志留存策略（默认「空闲 5 分钟无新回合就删掉比赛数据」）：');
console.log('  这一组会真的起一个服务进程来验，不是空跑 —— 因为清理逻辑写在 server.js 里，');
console.log('  靠时间戳和定时器触发，只有真跑一遍才算数。用临时目录，不碰你的 logs/。');
console.log('');

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');

function finish() {
  console.log('');
  console.log('-'.repeat(78));
  console.log(failed === 0
    ? '全部通过：实测事实 + 输出结构 + 回合号边界 + 热身屏蔽 + 身份识别与旁观 + ' +
      'delta 合并 + 炸弹状态 + 对手经济推算 + 模式常数与击杀账本 + 语音文案 + 日志留存。'
    : failed + ' 个问题，见上面的 BAD 标记。');
  if (warned) {
    console.log('（另有 ' + warned + ' 条「注意」，不是错 —— 上面写了每一条该怎么看。）');
  }
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

(function logJanitorTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2bh-log-'));
  // 端口从 pid 派生，避开你自己正在跑的那个（默认 31982）
  const port = 31000 + (process.pid % 20000);
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    CS2BH_LOG_DIR: tmp,
    CS2BH_LOG_IDLE_MIN: '0.03',    // 1.8 秒就算「空闲」—— 测试只跑两秒，不拖时间
    CS2BH_LOG_SWEEP_MS: '250',
    CS2BH_OPEN: '0'
  });
  delete env.CS2BH_LOG;             // 确保日志是开着的

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: env, stdio: ['ignore', 'pipe', 'pipe']
  });

  let settled = false;
  function done() {
    if (settled) return;
    settled = true;
    try { child.kill(); } catch (e) {}
    setTimeout(function () {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      finish();
    }, 120);
  }

  const hardStop = setTimeout(function () {
    if (settled) return;
    console.log('  ' + '服务进程 10 秒内没能完成整个流程'.padEnd(48) + 'BAD');
    failed++;
    done();
  }, 10000);

  function logFiles() {
    try { return fs.readdirSync(tmp).filter(function (f) { return f.endsWith('.jsonl'); }); }
    catch (e) { return []; }
  }

  function reqJson(pathname, method, cb) {
    const r = http.request({ host: '127.0.0.1', port: port, path: pathname, method: method || 'GET' },
      function (res) {
        let body = '';
        res.on('data', function (c) { body += c; });
        res.on('end', function () {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch (e) {}
          cb(null, parsed, body);
        });
      });
    r.on('error', function (e) { cb(e); });
    r.end();
  }

  function postFrame(payload, cb) {
    const body = JSON.stringify(payload);
    const r = http.request({
      host: '127.0.0.1', port: port, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function (res) { res.resume(); res.on('end', function () { cb(null); }); });
    r.on('error', function (e) { cb(e); });
    r.write(body);
    r.end();
  }

  let out = '';
  child.stdout.on('data', function (c) { out += String(c); });
  child.stderr.on('data', function (c) { out += String(c); });

  const waitStart = setInterval(function () {
    if (out.indexOf('已启动') !== -1) {
      clearInterval(waitStart);
      run();
    } else if (out.indexOf('已经被占用') !== -1) {
      clearInterval(waitStart);
      console.log('  ' + ('端口 ' + port + ' 被占用，跳过这一组（重跑即可）').padEnd(48) + 'SKIP');
      clearTimeout(hardStop);
      done();
    }
  }, 100);

  function run() {
    const f1 = { map: { name: 'de_mirage', round: 0 }, player: { team: 'T', state: { money: 800, health: 100 } } };
    const f2 = { map: { name: 'de_mirage', round: 1 }, player: { state: { money: 2400 } } };

    postFrame(f1, function () {
      postFrame(f2, function () {
        // 稍等一下让 appendFile 落盘
        setTimeout(function () {
          const files = logFiles();
          const n = files.length;
          let lines = 0;
          if (n) {
            try {
              lines = fs.readFileSync(path.join(tmp, files[0]), 'utf8').trim().split(/\r?\n/).filter(Boolean).length;
            } catch (e) {}
          }
          if (n === 1 && lines === 2) {
            console.log('  ' + ('收到 2 帧 -> 写入 ' + files[0] + '（' + lines + ' 行）').padEnd(48) + 'OK');
          } else {
            failed++;
            console.log('  ' + ('收到 2 帧 -> 期望 1 个文件 2 行，实际 ' + n + ' 个文件 ' + lines + ' 行').padEnd(48) + 'BAD');
          }

          // 手动清理路由：这条必须返回 JSON —— 它必须排在「通用 POST 处理」之前，
          // 否则会被当成 GSI 推送吞掉（那个坑踩过一次，这里钉住）
          reqJson('/logs/purge', 'POST', function (err, parsed, raw) {
            const okJson = !err && parsed && parsed.ok === true && Array.isArray(parsed.removed);
            if (okJson && parsed.removed.length === 1) {
              console.log('  ' + '手动清理 /logs/purge 返回 {ok:true, removed:[1 个]}'.padEnd(48) + 'OK');
            } else {
              failed++;
              console.log('  ' + ('手动清理路由异常：' + String(raw).slice(0, 40)).padEnd(48) + 'BAD');
            }
            if (logFiles().length === 0) {
              console.log('  ' + '手动清理后文件确实没了'.padEnd(48) + 'OK');
            } else {
              failed++;
              console.log('  ' + '手动清理后文件还在'.padEnd(48) + 'BAD');
            }

            // 再来一轮，这次不手动清，等空闲自动清
            postFrame(f1, function () {
              postFrame(f2, function () {
                setTimeout(function () {
                  if (logFiles().length !== 1) {
                    failed++;
                    console.log('  ' + ('空闲清理前置条件不成立（没写出新文件）').padEnd(48) + 'BAD');
                    clearTimeout(hardStop);
                    done();
                    return;
                  }
                  console.log('  ' + '重新写入 1 个文件，开始等空闲自动清理…'.padEnd(48) + 'OK');

                  const t0 = Date.now();
                  const poll = setInterval(function () {
                    if (logFiles().length === 0) {
                      clearInterval(poll);
                      clearTimeout(hardStop);
                      const secs = ((Date.now() - t0) / 1000).toFixed(1);
                      console.log('  ' + ('空闲 ' + secs + ' 秒后自动清空（阈值 1.8 秒）').padEnd(48) + 'OK');
                      // 顺带验证对手经济在真服务里也活着：/state 里必须有 enemy 段
                      reqJson('/state', 'GET', function (e0, st) {
                        const en = st && st.analysis && st.analysis.enemy;
                        if (!e0 && en && typeof en.available === 'boolean') {
                          console.log('  ' + ('/state 里的 enemy 段存在（available=' + en.available + '）').padEnd(48) + 'OK');
                        } else {
                          failed++;
                          console.log('  ' + ('/state 里没有 enemy 段：' + JSON.stringify(st && st.analysis && Object.keys(st.analysis))).padEnd(48) + 'BAD');
                        }
                        // 顺带验一下状态接口：清过之后 purges >= 2，且 lastPurgeReason 有内容
                        reqJson('/logs/status', 'GET', function (e2, st2) {
                          if (!e2 && st2 && st2.purges >= 2 && st2.lastPurgeReason) {
                            console.log('  ' + ('/logs/status：purges=' + st2.purges + '，原因「' + st2.lastPurgeReason + '」').padEnd(48) + 'OK');
                          } else {
                            failed++;
                            console.log('  ' + ('/logs/status 异常：' + JSON.stringify(st2)).padEnd(48) + 'BAD');
                          }
                          done();
                        });
                      });
                      return;
                    } else if (Date.now() - t0 > 7000) {
                      clearInterval(poll);
                      clearTimeout(hardStop);
                      failed++;
                      console.log('  ' + ('空闲 7 秒后文件仍未清（阈值 1.8 秒）').padEnd(48) + 'BAD');
                      done();
                    }
                  }, 200);
                }, 400);
              });
            });
          });
        }, 350);
      });
    });
  }
})();
