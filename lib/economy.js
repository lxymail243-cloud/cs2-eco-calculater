'use strict';

/**
 * 敌方经济推算
 *
 * 这个模块现在只做一件事：
 *   把 GSI 的原始状态读出来，交给 lib/enemy.js 推算对手的经济状况。
 *
 * 它原来还负责三块内容 —— 战术规划（tactics.js + maps.js）、
 * 购买清单（loadout.js）、大模型简报（llm.js）。这些代码已经**彻底删除**，
 * 不再保留备份，也不再是「以后可能恢复」的状态。本工具只做敌方经济推算。
 *
 * 「我的状态」（钱 / 护甲 / 武器 / 道具）仍然读出来并返回，因为它是
 * **原始状态而不是建议** —— 而且判断对手经济时经常要拿自己的钱做参照。
 *
 * 设计前提（重要）：
 *   GSI 在你亲自游玩时**不下发**对手的钱包和购买记录（Valve 有意为之），
 *   但会下发双方比分和双方连败计数。所以对手经济能硬算的只有「收入侧」，
 *   支出侧推不出来。完整推导、资金上界算法、以及「什么时候才能下确定性结论」，
 *   全部写在 lib/enemy.js 顶部的注释里。
 *
 * ★ 一个例外（实测才知道，也是本模块唯一能拿到真实敌方数字的来源）：
 *   休闲模式里你阵亡后可以旁观 / 接手机器人，那时 GSI 会把 player 块切成被旁观者的，
 *   于是**他的真实资金、血量、护甲、武器、总击杀**全都能直读到。
 *   拦截逻辑在 lib/gsi.js（不并进 state.player，另存 state.playerObserved），
 *   这里只负责读出来并如实展示为「旁观情报」—— 不拿它冒充「我的状态」。
 */

const enemy = require('./enemy');

const LOSS_STREAK_OFFSET = 0;

/**
 * map.round 的语义 —— 用真实对局日志验证过（具体帧数见 tools/selftest.js 第 0 组，
 * 每次跑都会现场数一遍）：
 *
 *   map.round 等于「已完成的回合数」，也就是当前回合是第 map.round + 1 回合（0 基）。
 *   验证方法：所有包的 map.round 都严格等于 team_ct.score + team_t.score（全中，无例外）。
 *   所以手枪局是 map.round === 0，下半场手枪局是 map.round === 12。
 *
 *   之前这里写成 1 和 13 是错的 —— 会导致手枪局判断永远不命中，
 *   并且把第 2 回合误判成手枪局。改这个值之前请先看一眼 logs/ 里的真实数据。
 *
 *   一个坑：只有「缺 provider」的那种手搓帧会破坏这个恒等式，
 *   真实的每一帧 GSI 包都带 provider（appid 730）。
 */
const PISTOL_ROUND_INDEX = [0, 12];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const WEAPON_LABEL = {
  weapon_ak47: 'AK-47',
  weapon_m4a1: 'M4A4',
  weapon_m4a1_silencer: 'M4A1-S',
  weapon_awp: 'AWP',
  weapon_galilar: 'Galil AR',
  weapon_famas: 'FAMAS',
  weapon_aug: 'AUG',
  weapon_sg556: 'SG 553',
  weapon_ssg08: 'SSG 08',
  weapon_scar20: 'SCAR-20',
  weapon_g3sg1: 'G3SG1',
  weapon_mac10: 'MAC-10',
  weapon_mp9: 'MP9',
  weapon_mp7: 'MP7',
  weapon_mp5sd: 'MP5-SD',
  weapon_ump45: 'UMP-45',
  weapon_p90: 'P90',
  weapon_bizon: 'PP-Bizon',
  weapon_m249: 'M249',
  weapon_negev: 'Negev',
  weapon_nova: 'Nova',
  weapon_xm1014: 'XM1014',
  weapon_mag7: 'MAG-7',
  weapon_sawedoff: 'Sawed-Off',
  weapon_deagle: '沙漠之鹰',
  weapon_glock: 'Glock-18',
  weapon_usp_silencer: 'USP-S',
  weapon_hkp2000: 'P2000',
  weapon_p250: 'P250',
  weapon_fiveseven: 'Five-SeveN',
  weapon_tec9: 'Tec-9',
  weapon_cz75a: 'CZ75-Auto',
  weapon_elite: '双持贝瑞塔',
  weapon_revolver: 'R8 左轮'
};

function prettyWeapon(raw) {
  if (!raw) return '';
  if (WEAPON_LABEL[raw]) return WEAPON_LABEL[raw];
  return String(raw).replace(/^weapon_/, '').replace(/_/g, ' ');
}

/**
 * 败方补偿：连败 streak 次之后这一败能拿多少。
 *
 * 阶梯本身只写在 lib/enemy.js 的 LADDER 一处，这里复用同一个函数 ——
 * 对手和我方走的是同一条规则，各写一套迟早改一处忘一处。
 */
function lossBonus(streak) {
  return enemy.lossBonus(num(streak) + LOSS_STREAK_OFFSET);
}

/** GSI 的武器名 → 道具种类（这套映射原先在战术模块里，跟着搬过来） */
const GRENADE_BY_WEAPON = {
  weapon_smokegrenade: 'smoke',
  weapon_flashbang: 'flash',
  weapon_hegrenade: 'he',
  weapon_molotov: 'fire',
  weapon_incgrenade: 'fire',
  weapon_decoy: 'decoy'
};

/** 从 GSI 的 weapons 子树里数出我身上有几颗什么弹 */
function countGrenades(weapons) {
  const c = { smoke: 0, flash: 0, fire: 0, he: 0, decoy: 0 };
  for (const key of Object.keys(weapons || {})) {
    const w = weapons[key];
    if (!w || !w.name) continue;
    const k = GRENADE_BY_WEAPON[w.name];
    if (k) c[k] = (c[k] || 0) + 1;
  }
  return c;
}

function readOwned(weapons, state) {
  let primaryName = '';
  const PRIMARY_TYPES = ['Rifle', 'SniperRifle', 'Submachine Gun', 'Machine Gun'];
  for (const key of Object.keys(weapons || {})) {
    const w = weapons[key];
    if (!w) continue;
    if (w.type && PRIMARY_TYPES.indexOf(w.type) !== -1) {
      primaryName = prettyWeapon(w.name || key);
    }
  }
  return {
    primary: !!primaryName,
    primaryName: primaryName,
    armor: num(state.armor),
    helmet: !!state.helmet,
    defuseKit: !!state.defusekit,
    alive: num(state.health) > 0,
    grenades: countGrenades(weapons)
  };
}

/**
 * 包是否已经下 —— CT 回防 / T 守包的判断依据。
 *
 * 实测（几百帧真实日志，一帧不落）纠正了两个想当然的写法：
 *   1. gs.bomb 从来没出现过（0 帧），bomb.state 这条路根本走不通，
 *      实际只能靠 round.bomb。
 *   2. round.bomb 在 CS2 里是**字符串**，取值 'planted' / 'defused'，
 *      不是 CS:GO 时代的布尔值。'defused' 是「上一回合包被拆了」的结果，
 *      不能当成「现在地上有包」—— 之前把它算成已下包，是错的一半原因。
 *   3. 倒计时 / 回合结束阶段不可能有包在地上，这时候还报「包已下」
 *      一定是脏数据。所以只在 live 阶段认。
 *
 * 跨回合残留那一半在 lib/gsi.js 的 clearRoundTransients()。
 */
function readBombPlanted(gs) {
  const phase = String((gs.map && gs.map.phase) || '').toLowerCase();
  if (phase && phase !== 'live') return false;

  let raw = '';
  if (gs.bomb && gs.bomb.state) raw = gs.bomb.state;
  else if (gs.round && gs.round.bomb) raw = gs.round.bomb;

  const s = String(raw || '').toLowerCase();
  return s === 'planted' || s === 'defusing';
}

function isPistolRound(roundIndex) {
  if (typeof roundIndex !== 'number' || !Number.isFinite(roundIndex)) return false;
  return PISTOL_ROUND_INDEX.indexOf(roundIndex) !== -1;
}

/**
 * 非正式对局阶段 —— 这些阶段**必须屏蔽对手经济结论**。
 *
 * 为什么单独处理：5E 这类平台在等人进图时会先跑一段热身（死斗式对枪）。
 * 那段时间 GSI 照样推数据，但推的是热身数据：
 *   - 热身里没有经济系统，money 可能很高或乱跳
 *   - 回合号停在 0，而 0 在正式局里恰好是「手枪局」——
 *     不挡掉的话，推算会一本正经地拿热身数据去算对手经济
 *
 * 判据（来自实测 + GSI 文档）：
 *   map.phase = warmup     -> 热身（实测日志里出现过这个取值）
 *   map.mode  = deathmatch -> 死斗
 *   map.phase = gameover   -> 上一局已结束
 *   同一回合内死而复生      -> 热身 / 死斗（正式回合不会复活，见 lib/gsi.js detectRespawn）
 *     这一条是兜底：万一 5E 的热身不走标准阶段名，也能识别出来。
 *     **要求同一回合内复活 ≥2 次**才认：休闲模式「接手机器人」也会造成一次同回合的
 *     0 -> 100，只判一次的话正常回合会被整段误判成热身（真实日志里 26% 的帧中招）。
 *     热身 / 死斗的特征是反复复活，所以 ≥2 次能把两者分开。
 */
function detectNotInMatch(map, ctx) {
  const phase = String((map && map.phase) || '').toLowerCase();
  const mode = String((map && map.mode) || '').toLowerCase();
  if (phase === 'warmup') {
    return { kind: 'warmup', label: '热身中', note: '等人进图的热身 / 死斗阶段，不是正式回合 —— 下面的数据别当判断依据' };
  }
  if (mode === 'deathmatch') {
    return { kind: 'deathmatch', label: '死斗热身', note: '当前是死斗模式，没有经济系统 —— 等正式回合开始' };
  }
  if (phase === 'gameover') {
    return { kind: 'gameover', label: '对局已结束', note: '上一局结束了，等下一局的开局' };
  }
  if (ctx && ctx.respawnRecently) {
    return {
      kind: 'deathmatch',
      label: '热身 / 死斗中',
      note: '检测到你在这个回合里死而复生（' +
        (typeof ctx.respawnAgo === 'number' ? ctx.respawnAgo + ' 秒前' : '刚刚') +
        '）—— 正式回合阵亡要等到下一回合，只有热身 / 死斗才会复活'
    };
  }
  return null;
}

function analyze(gs, ctx) {
  ctx = ctx || {};
  const player = gs.player || {};
  const map = gs.map || {};
  const roundInfo = gs.round || {};
  const state = player.state || {};
  const weapons = player.weapons || {};

  const side = (player.team === 'CT' || player.team === 'T') ? player.team : null;
  const phase = roundInfo.phase || (gs.phase_countdowns && gs.phase_countdowns.phase) || 'unknown';
  const roundIndex = num(map.round);        // 0 基：当前回合是第 roundIndex + 1 回合
  const roundNum = roundIndex + 1;          // 给人看的回合号
  const scoreCT = num(map.team_ct && map.team_ct.score);
  const scoreT = num(map.team_t && map.team_t.score);

  const owned = readOwned(weapons, state);
  const money = num(state.money);

  const myBlock = side === 'CT' ? map.team_ct : (side === 'T' ? map.team_t : null);
  const enemyBlock = side === 'CT' ? map.team_t : (side === 'T' ? map.team_ct : null);
  const myLosses = num(myBlock && myBlock.consecutive_round_losses);
  const enemyLosses = num(enemyBlock && enemyBlock.consecutive_round_losses);

  // ---- 对手经济推算（本模块唯一的核心） ----
  // 输入只有四样：阵营、回合号、每回合开始前的比分快照、GSI 给的对手连败数。
  // 再加两样更准的：模式（休闲和竞技的常数不同）、以及观察到的对手击杀账本。
  // 为什么这几样够、边界在哪，见 lib/enemy.js。
  const enemyEst = enemy.estimate({
    side: side,
    roundIndex: roundIndex,
    roundScore: ctx.roundScore || {},
    theirLosses: enemyLosses,
    mode: map.mode,
    killLedger: ctx.killLedger || {},
    roundPlant: ctx.roundPlant || {}
  });

  // 「对手现在连败几局」优先信重建出来的序列 ——
  // GSI 的 consecutive_round_losses 在回合刚翻转的一两帧里会滞后
  // （实测见过「刚赢完却还写着连败 2」），而从比分重建的序列不会错位。
  const enemyStreak = (typeof enemyEst.streak === 'number') ? enemyEst.streak : enemyLosses;
  const enemyIfLoseNow = lossBonus(enemyStreak);

  const bombPlanted = readBombPlanted(gs);
  const notInMatch = detectNotInMatch(map, ctx);

  /* ------------------------------------------------------------------
   * 「player 块是不是我」—— 这是实测日志才知道的一个坑。
   *
   * 休闲模式里阵亡后可以旁观 / 接手机器人，那一刻 GSI 会把整个 player 块
   * 切成**被旁观者**的（名字、steamid、金钱、武器全变成他的）。
   * 不拦住的话：界面会把敌人的钱显示成「我的金钱」，我方 / 敌方整个反过来
   * （真实日志里翻转 32 次）、连对手经济的推算方向都是反的。
   *
   * 拦在累积器里（lib/gsi.js 的 mergeFrame）：确认不是你时就不并进 state.player，
   * 而是单独收进 state.playerObserved。所以这里只需要读出来。
   * 好处是那份数据不白丢 —— 它是**对手的真实金钱、血量、护甲、武器装备**，
   * 比推算出来的上界准得多，顺手展示。
   * ------------------------------------------------------------------ */
  const observed = (gs.playerObserved && typeof gs.playerObserved === 'object')
    ? gs.playerObserved : null;
  const spectating = !!observed;

  const advice = [];

  if (spectating) {
    const oName = observed.name || '某人';
    const oTeam = (observed.team === 'CT' || observed.team === 'T') ? observed.team : '?';
    const oState = observed.state || {};
    const oWeapons = observed.weapons || {};
    const oGuns = Object.keys(oWeapons)
      .map(function (k) { return oWeapons[k]; })
      .filter(function (w) { return w && w.name && w.name !== 'weapon_knife' && w.name !== 'weapon_knife_t'; })
      .map(function (w) { return w.name.replace(/^weapon_/, '').toUpperCase(); });
    advice.push('你已阵亡，正在旁观 ' + oName + '（' + oTeam + '）—— 上面「我的状态」还是你阵亡前的数值，' +
      '没有被旁观对象污染（阵亡期间买不了东西，所以那些数不会失真）。');
    advice.push('顺手一份对面情报（' + oName + '）：资金 $' + num(oState.money) +
      '，血量 ' + num(oState.health) +
      (oGuns.length ? '，武器 ' + oGuns.join(' / ') : '') +
      '。这是直读的真实值，比对手经济卡里的推算上界准。');
  }

  if (notInMatch) {
    advice.push(notInMatch.label + '：' + notInMatch.note + '。');
    advice.push('这段时间正好用来校准：打开 /debug.html，看三件事 —— ' +
      '① allplayers 有几行（≥2 行且带 money 说明拿到了观战视角的数据）；' +
      '② 正式回合开始后双方连败计数的变化；' +
      '③ 对手经济卡里重建出的胜负序列对不对得上。');
  } else if (!side) {
    advice.push('还没进对局（当前无队伍信息），先等你进入比赛。');
  } else if (enemyEst.available && enemyEst.verdict) {
    advice.push(enemyStreak > 0
      ? '对手已连败 ' + enemyStreak + ' 局：本回合若再输，每人进账 $' + enemyIfLoseNow +
        '（败方补偿是固定阶梯，这个数是精确的，不是推算）。'
      : '对手连败已清零 —— 上回合赢了，$' + enemy.econOf(enemyEst.mode).WIN +
        ' 的胜利奖金已经到账。');
    advice.push('对手经济：' + enemyEst.verdict);
    if (typeof enemyEst.cashLikely === 'number') {
      advice.push('参考余额约 $' + enemyEst.cashLikely +
        '（不是上界，只是估算）：上界 $' + Math.round(enemyEst.cashCeil) +
        ' 假设他们一分钱没花，但观测到对手人均每回合死 ' +
        enemyEst.deathsPerRound.toFixed(2) + ' 次，按每次重买 $' +
        enemyEst.costs.combat + ' 估，已经花掉约 $' + enemyEst.spendEst + '。');
    }
    if (enemyEst.conf === 'low') {
      advice.push('注意置信度是「数据不全」：服务是中途启动的，本半场前几局的比分快照补不回来，' +
        '所以只给范围、不下结论，也不会播语音 —— 播一句错的比不播更糟。');
    }
  } else {
    advice.push('还没拿到足够的对手数据（' +
      ((enemyEst.why && enemyEst.why[0]) || '缺少回合信息') + '）。');
  }

  return {
    ts: Date.now(),
    phase: phase,
    roundNum: roundNum,
    roundIndex: roundIndex,
    side: side,
    notInMatch: notInMatch ? notInMatch.kind : '',
    inWarmup: !!notInMatch,
    notInMatchLabel: notInMatch ? notInMatch.label : '',
    score: { ct: scoreCT, t: scoreT },
    mapName: (map.name || '').replace(/^de_/, ''),
    mapRaw: map.name || '',
    bombPlanted: bombPlanted,
    // 是不是正在旁观别人（休闲模式阵亡后）。true 时上面的 me.* 是你阵亡前的值。
    spectating: spectating,
    // 旁观到的那个人的**真实**数据。GSI 在这些帧里把 player 块切给了他，
    // 所以这份数据是直读的、不是推算的 —— 见上面那大段注释。
    observed: spectating ? {
      name: observed.name || '',
      steamid: observed.steamid || '',
      team: (observed.team === 'CT' || observed.team === 'T') ? observed.team : '',
      slot: num(observed.observer_slot),
      money: num((observed.state || {}).money),
      health: num((observed.state || {}).health),
      armor: num((observed.state || {}).armor),
      helmet: !!(observed.state || {}).helmet,
      equips: num((observed.state || {}).equip_value),
      roundKills: num((observed.state || {}).round_kills),
      kills: num((observed.match_stats || {}).kills),
      deaths: num((observed.match_stats || {}).deaths),
      assists: num((observed.match_stats || {}).assists),
      weapons: Object.keys(observed.weapons || {})
        .map(function (k) { return observed.weapons[k]; })
        .filter(function (w) { return w && w.name; })
        .map(function (w) { return w.name.replace(/^weapon_/, ''); })
    } : null,
    me: {
      money: money,
      primary: owned.primary,
      primaryName: owned.primaryName,
      armor: owned.armor,
      helmet: owned.helmet,
      defuseKit: owned.defuseKit,
      alive: owned.alive,
      grenades: owned.grenades
    },
    myTeam: {
      losses: myLosses,
      nextLossBonus: lossBonus(myLosses)
    },
    // enemy 里既有 GSI 精确给的连败数与下一败补偿，也有推算出来的对手经济
    // （lib/enemy.js），以及它的置信度和推理链。
    // 顺序很关键：精确字段放在**后面**，保证它们不会被推算结果覆盖 ——
    // 之前 enemy.js 里有个同名字段 losses，就是在这里把连败数悄悄盖掉的。
    enemy: Object.assign({}, enemyEst, {
      losses: enemyLosses,        // GSI 原值（可能滞后一两帧）
      streak: enemyStreak,        // 重建序列的值 —— 界面和语音都用这个
      ifLoseNow: enemyIfLoseNow
    }),
    advice: advice
  };
}

module.exports = {
  analyze: analyze,
  lossBonus: lossBonus,
  isPistolRound: isPistolRound,
  countGrenades: countGrenades
};
