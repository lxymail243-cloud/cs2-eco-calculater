'use strict';

/**
 * 对手经济推算
 *
 * ============================================================
 * 先说清楚这个模块能做什么、不能做什么 —— 这决定了它的诚实边界
 * ============================================================
 *
 * GSI 给对手的什么（全部实测确认，真实日志逐帧数过 —— 帧数每次跑
 * tools/selftest.js 第 0 组会现场重新数，别在这里写死）：
 *   · map.team_t / team_ct 的 consecutive_round_losses —— **双方各自的连败数，精确**
 *     这是最有价值的一个字段，也是能推对手经济的根基。
 *   · map.team_*.score —— 双方比分。配合「每回合结束时的比分快照」可以重建
 *     对手每一回合是赢是输。
 *   · map.round —— 回合进度。
 *   · round.win_team —— 回合结束时是谁赢的。
 *
 * GSI 不给的（Valve 有意为之，自己游玩时不下发 allplayers）：
 *   · 对手的钱包余额
 *   · 对手买了什么（支出）
 *   · 对手的击杀奖励（不同枪差 8 倍，且无法归因到人）
 *
 * 所以：**精确的对手余额拿不到**。但对手经济的「收入侧」是可以硬算的 ——
 * CS 的收入是完全确定性的：起始 + 每回合基础 + 胜负奖金 + 连败补偿阶梯。
 * 缺的只有「支出侧」。
 *
 * 于是这里做三件事：
 *   1. 用重建出的胜负序列**硬算**对手的人均累计收入（不含击杀奖励，即下界）。
 *   2. 用「一分钱都没花」给出资金的**上界**，再叠加击杀奖励的极端上限 —— 让它更保守。
 *   3. 用理性消费模拟给出一个**典型值**。
 *
 * 关键在这个上界：**当上界都低于买枪门槛时，就能下确定性结论**
 * ——「对面这回合不可能人人有长枪」。这比给一个模糊的金额有用得多，
 * 因为购买决策真正需要的就是这一句。
 */

/* ------------------------------------------------------------------
 * 武器 / 装备价格表（本模块自带，不再依赖 lib/loadout.js）
 *
 * 这里**只有价格**，没有「购买菜单」这个概念 ——
 * 对手买什么跟你的自定义菜单毫无关系：他们买的是常规配置（AK / M4）。
 * 这张表原先是从 lib/loadout.js 借的，那份文件属于「买枪建议」功能，已删除；
 * 移除后只把用得到的这几个价格挪进来自己带着，免得留下一个指向已删除文件的依赖。
 * ------------------------------------------------------------------ */
const PRICE = {
  ak47:        { cost: 2700 },   // T  满买主武器
  m4a1s:       { cost: 2900 },   // CT 满买主武器
  mac10:       { cost: 1050 },   // T  强起微冲
  mp9:         { cost: 1250 },   // CT 强起微冲
  molotov:     { cost: 400 },    // T  燃烧瓶
  incendiary:  { cost: 600 },    // CT 燃烧弹
  armorHelmet: { cost: 1000 },   // 全甲（甲 + 头盔）
  kevlar:      { cost: 650 },    // 半甲
  smoke:       { cost: 300 },
  flash:       { cost: 200 },
  he:          { cost: 300 }
};

/* ------------------------------------------------------------------
 * 经济常数 —— **按模式分两套**
 *
 * ★ 这里原先只有一套（竞技模式的数字），但 logs/ 里的 1135 个真实帧
 *   **全部是休闲局**（map.mode = casual），于是那套数字一直在错着用。
 *   休闲模式的规则和竞技不一样，三项全变：
 *
 *     项目        竞技/优先     休闲      实测依据
 *     起始资金      $800        $1000     回合 0 起点就是 $1000
 *     回合胜利      $3250       $2700     见下面的逐回合验算
 *     资金上限      $16000      $10000    —
 *     击杀奖励      ×1          ×0.5      见 KILL_REWARD 的注释
 *     每回合护甲    要买        白送      休闲每回合免费发 kevlar + helmet
 *
 *   真实数据反推（我自己的资金曲线，用「回合起点快照」逐回合验算）：
 *     回合 0 起点 $1000  →  回合 1 起点 $4150
 *     Δ = $3150 = 休闲胜 $2700 + 3 次击杀 × $150        ← 分毫不差
 *     回合 2 起点 $4250  →  回合 3 起点 $6600
 *     Δ = $2350 = 二连败补偿 $1900 + 3 次击杀 × $150    ← 也分毫不差
 *     回合 1 起点 $4150  →  回合 2 起点 $4250
 *     Δ = +$100 = 胜 $2700 + 2 杀 × $150 − 花销 $2900   ← 而且**没买甲**
 *                                                        （休闲白送，正好对上）
 *   审计脚本：node tools/killcalib.js（拿 logs/ 现算，不写死）
 * ------------------------------------------------------------------ */
const MODES = {
  competitive: { START: 800,  PER_ROUND: 800, WIN: 3250, MAX: 16000, KILL_MUL: 1,   FREE_ARMOR: false },
  casual:      { START: 1000, PER_ROUND: 800, WIN: 2700, MAX: 10000, KILL_MUL: 0.5, FREE_ARMOR: true  }
};

const DEFAULT_MODE = 'competitive';

/**
 * map.mode 原文 → 我们的模式键。
 * 认不出来的一律按竞技算：那是最常见的模式，而且数字更保守
 * （起始更低、上限更高、击杀奖励更高 → 不会低估对手）。
 */
function modeOf(raw) {
  const m = String(raw || '').toLowerCase();
  if (m === 'casual') return 'casual';
  return DEFAULT_MODE;
}

function econOf(modeKey) {
  return MODES[modeKey] || MODES[DEFAULT_MODE];
}

// 败方补偿阶梯：首次失败 $1400，每多连败一次 +$500，封顶 $3400（两个模式相同）
const LADDER = [1400, 1900, 2400, 2900, 3400];

/* ------------------------------------------------------------------
 * 炸弹相关的两笔一次性奖金 —— 都是「直接给钱」，不是概率
 *
 * WIN_BOMB_EXTRA  炸弹引爆 / 被拆掉的回合，胜方**每人**多拿 $250。
 *   实测：同一局 5E 竞技日志里，`round.bomb = exploded` 的那一回合
 *   结算增量是 **+$3500**，其余三个回合都是 **+$3250**。
 *   也就是说胜利奖金不是恒定的 $3250 —— 只有「打光对面 / 时间到」才是 $3250，
 *   回合以炸弹结束（exploded / defused）时是 $3500。原模型漏了这一层。
 *   休闲模式没有样本，沿用同一个 +$250：宁可把收入算高一点（上界偏松），
 *   也不要算低 —— 算低会让「对面不可能有长枪」变成假结论。
 *
 * PLANT_LOSS      T 埋了包却还是输掉，每人 +$800 补偿。
 *   实测佐证：日志里有个 +$2700 的结算 = 1900（二连败）+ 800，正对上这条。
 *   只对 T 生效，CT 没有对应机制。
 *
 * 两条都作用在**收入**上，所以都只会把资金上界抬高 —— 方向上永远安全。
 * ------------------------------------------------------------------ */
const WIN_BOMB_EXTRA = 250;
const PLANT_LOSS = 800;

/* ------------------------------------------------------------------
 * 击杀奖励表（**竞技模式原值**，休闲模式整体 ×0.5）
 *
 * 这张表不是抄文档来的 —— 是从 logs/ 里「同一帧里击杀数 +1 且金钱变多」
 * 的样本反推出来的。休闲模式下每一档都精确减半：
 *
 *   武器              实测增量（休闲）   竞技原值   样本数
 *   步枪/手枪          $150              $300      30+
 *   AWP               $50               $100      16
 *   冲锋枪/微冲         $300              $600      5
 *   XM1014            $300              $600      1
 *
 * 换句话说：休闲模式的击杀奖励就是竞技的一半，这是**实测**，不是推算。
 *
 * ⚠️ 这对经济推算的影响是直接的：同一局里把 $300 当成每杀的收入，
 *    在休闲模式下会高估一倍。之前代码里写死的正是 $300。
 * ------------------------------------------------------------------ */
const KILL_REWARD = {
  pistol:    300,   // USP-S / Glock / P250 / Deagle / Tec-9 …
  smg:       600,   // MAC-10 / MP9 / MP7 / MP5-SD / UMP-45 / PP-Bizon
  p90:       300,
  shotgun:   900,   // Nova / Sawed-Off / MAG-7
  xm1014:    600,
  rifle:     300,   // AK / M4 / AUG / SG553 / FAMAS / Galil / SSG08 / 连狙
  awp:       100,
  mg:        300,   // M249 / Negev
  grenade:   300,
  knife:     1500,
  taser:     100,
  cz75:      100
};

/* 各类武器在一局里的**击杀占比**，用来算加权平均每杀奖励。
 * 权重来自 logs/ 里 58 个单杀样本的实测分布：
 *   步枪/手枪 37、AWP 15、冲锋枪 5、XM1014 1
 * 关键点：AWP 只给 $100，所以**非手枪局**的加权均值一定低于 $300。
 * 这也是「手枪局每杀更值钱」的原因 —— 手枪局里不可能出现 AWP。 */
const KILL_MIX = [
  { tier: 'rifle',  w: 37 },
  { tier: 'awp',    w: 15 },
  { tier: 'smg',    w: 5 },
  { tier: 'xm1014', w: 1 }
];

function weightedKillReward() {
  let sum = 0;
  let w = 0;
  KILL_MIX.forEach(function (m) { sum += KILL_REWARD[m.tier] * m.w; w += m.w; });
  return sum / w;
}

/**
 * 每杀的平均奖励（按模式）。
 *
 * opts.pistol = true → **手枪局**。那一局双方起始资金只够买手枪
 * （$800 / $1000 都买不起 $1050 的微冲，更别说步枪和 AWP），
 * 所以击杀全部落在手枪档（$300），没有 AWP 的 $100 来拖低均值 ——
 * 手枪局的每杀均值因此**略高于普通回合**。
 *
 * 普通回合按 KILL_MIX 的实测占比做加权平均：
 *   (37×300 + 15×100 + 5×600 + 1×600) ÷ 58 ≈ $279（竞技），休闲再 ×0.5 ≈ $140。
 */
function meanKillReward(modeKey, opts) {
  const mul = econOf(modeKey).KILL_MUL;
  if (opts && opts.pistol) return Math.round(KILL_REWARD.pistol * mul);
  return Math.round(weightedKillReward() * mul);
}

/**
 * 「人均 · 每回合」能拿到的击杀奖励 —— 用来把对手的收入上限放宽到击杀奖励这一层。
 *
 * 为什么恰好等于「每杀平均奖励」，而不是乘以某个击杀数：
 *   对手一回合最多拿到 5 个击杀（我们最多死 5 个人），
 *   这 5 个击杀的奖励是**全队**分的，人均就是 5 × 平均奖励 ÷ 5 = 平均奖励。
 *   所以「人均每回合 ≤ 平均击杀奖励」是**团队平均值意义上的严格上界**，
 *   不需要额外假设他们每回合杀几个人。
 *   （单个玩家能超过它 —— 有人一回合杀 4 个就超了 —— 但我们算的本来就是人均。）
 *
 * 这里返回的是**普通回合**的口径；手枪局另有 meanKillReward(mode, {pistol:true})。
 */
function killCeilPerRound(modeKey) {
  return meanKillReward(modeKey);
}

/**
 * 一段回合序列的击杀收入（人均）。
 *
 * 必须逐回合取奖励，不能简单乘 seq.length —— 因为 seq 里可能混着手枪局
 * （例如下半场第 1 个回合，seq 恰好是 [12]），而手枪局每杀更值钱。
 *
 * killsPerRound 传 null → 走上界（假设每人每回合都拿满，人均 ≤ 每杀平均奖励）。
 * 传数字 → 用实测的人均每回合击杀数。
 */
function killIncomeOf(seq, modeKey, killsPerRound) {
  let perRound = 0;
  (seq || []).forEach(function (s) {
    perRound += meanKillReward(modeKey, { pistol: isPistolRound(s.round) });
  });
  if (typeof killsPerRound === 'number') return killsPerRound * perRound;
  return perRound;
}

// 兼容旧名（外部与自测还在引用）：竞技模式下的那个值。
const KILL_BONUS_CEIL = KILL_REWARD.rifle;

// eco 回合的人均花销（一把便宜手枪 + 半甲就是这个量级）。
// 只用来算「对手一直省着打能攒下多少」这一个参考值。
const ECO_KEEP = 500;

const HALF = 12;   // MR12：每半场 12 回合

const TIER_CN = {
  ECO: '存钱局',
  FORCE_BUY: '强起',
  HALF_BUY: '半买',
  FULL_BUY: '满买'
};

/* ------------------------------------------------------------------ */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 败方补偿：连败 streak 次之后这一败能拿多少 */
function lossBonus(streak) {
  const s = Math.max(0, Math.min(LADDER.length - 1, num(streak)));
  return LADDER[s];
}

/** 我的阵营 → 对手阵营 */
function foeOf(side) {
  if (side === 'CT') return 'T';
  if (side === 'T') return 'CT';
  return null;
}

/**
 * 手枪局判定（0 基回合号）。
 * 自己的判断在 lib/economy.js 里（那边用的是用户菜单相关的门槛），
 * 这里只需要知道「双方此刻都只有起始资金」这一件事。
 */
function isPistolRound(roundIndex) {
  if (roundIndex === 0) return true;
  return roundIndex >= HALF && roundIndex % HALF === 0;
}

/**
 * 对手的标准配装。
 * 注意：这跟用户自己那份自定义购买菜单**无关** ——
 * 对手用的是常规配置（AK / M4），不会跟着你的菜单变。
 */
const STD = {
  T: { rifle: 'ak47', fire: 'molotov', smg: 'mac10' },
  CT: { rifle: 'm4a1s', fire: 'incendiary', smg: 'mp9' }
};

function stdCost(side, key, fallback) {
  const s = STD[side] || STD.T;
  const item = PRICE[s[key]];
  return item ? item.cost : fallback;
}

/**
 * 买甲要花多少钱 —— 休闲模式是 $0。
 *
 * 休闲每回合**免费发** kevlar + helmet，所以那边的对手想拿步枪只需要攒枪钱。
 * 不扣掉这 $1000，「对面买不起长枪」这个结论在休闲里会天天误报：
 * 上界 $3300 明明够买把 AK（$2700），却因为算上了 $1000 甲钱被判成买不起。
 */
function armorCost(modeKey) {
  return econOf(modeKey).FREE_ARMOR ? 0 : PRICE.armorHelmet.cost;
}

/** 满买：步枪 + 甲盔 + 烟闪火雷 */
function fullCostOf(side, modeKey) {
  return stdCost(side, 'rifle', 2700)
    + armorCost(modeKey)
    + PRICE.smoke.cost
    + PRICE.flash.cost
    + stdCost(side, 'fire', 400)
    + PRICE.he.cost;
}

/** 「能正常对枪」的门槛：步枪 + 甲盔。低于这条线就凑不出人手一把长枪 */
function combatCostOf(side, modeKey) {
  return stdCost(side, 'rifle', 2700) + armorCost(modeKey);
}

/** 半买门槛：微冲 + 半甲 */
function halfCostOf(side, modeKey) {
  const kev = econOf(modeKey).FREE_ARMOR ? 0 : (PRICE.kevlar ? PRICE.kevlar.cost : 650);
  return stdCost(side, 'smg', 1250) + kev;
}

/**
 * 重建对手在本半场每一回合的胜负。
 *
 * roundScore 的语义（这点很容易搞错，是实测日志才纠正过来的）：
 *   roundScore[k] = 「回合 k**开始之前**」的比分，也就是「回合 k-1 走完之后」的比分。
 *   因为 GSI 把 map.round 推到 k 的那一刻，k-1 那一回合的比分**已经**加上了。
 *
 * 所以「回合 r 谁赢了」= roundScore[r+1] 与 roundScore[r] 之差。
 * 一开始我写成用 r 和 r-1 相减，结果每一回合都被判成「未知」、
 * 覆盖率恒为 0、信心永远是 low —— 这个 off-by-one 就这么隐蔽。
 *
 * winner 为 null 的两种情况：比分快照缺失（服务中途启动），
 * 或者两边分数都没动（加时赛的平局收尾）。都不猜，留给上层降级处理。
 */
function buildSequence(roundScore, from, to, roundPlant) {
  const out = [];
  for (let r = from; r < to; r++) {
    // roundPlant 由累积器记：那一回合里有没有出现过 round.bomb = 'planted'。
    // 有了它才能算出「炸弹结束的回合胜方多拿 $250」和「T 埋包后输了 +$800」。
    const planted = !!(roundPlant && roundPlant[r]);
    const before = roundScore[r];
    const after = roundScore[r + 1];
    if (!before || !after) {
      out.push({ round: r, winner: null, planted: planted });
      continue;
    }
    const dct = num(after.ct) - num(before.ct);
    const dt = num(after.t) - num(before.t);
    let winner = null;
    if (dct > 0 && dt <= 0) winner = 'CT';
    else if (dt > 0 && dct <= 0) winner = 'T';
    out.push({ round: r, winner: winner, planted: planted });
  }
  return out;
}

/**
 * 按胜负序列累加对手的人均**确定性收入**。
 *
 * winner 为 null 的回合（服务中途启动、或该回合的比分快照没记上）
 * 一律按「最少增益」计：算它输了，而且算成首次连败（只拿 $1400）。
 * 这样得到的一定是**下界**，宁可低估对手，也不高估。
 */
function accumulate(seq, foe, econ) {
  econ = econ || econOf(DEFAULT_MODE);   // 不传就按竞技算，外部直接调用时不会炸
  let income = econ.START;   // 手枪局起始
  let streak = 0;
  let wins = 0;
  let losses = 0;
  let unknown = 0;
  let bombWins = 0;          // 以炸弹结束、因此多拿 $250 的胜局数
  let plantLosses = 0;       // T 埋了包却输掉的局数

  seq.forEach(function (s) {
    income += econ.PER_ROUND;
    if (s.winner === null) {
      income += LADDER[0];
      streak += 1;
      losses += 1;
      unknown += 1;
      return;
    }
    if (s.winner === foe) {
      // 炸弹引爆 / 被拆掉结束的回合，胜方每人多 $250（实测 3500 vs 3250）
      if (s.planted) { income += WIN_BOMB_EXTRA; bombWins += 1; }
      income += econ.WIN;
      streak = 0;
      wins += 1;
    } else {
      income += lossBonus(streak);
      // T 埋了包还是输：每人多 $800（CT 没有对应机制）
      if (foe === 'T' && s.planted) { income += PLANT_LOSS; plantLosses += 1; }
      streak += 1;
      losses += 1;
    }
  });

  return {
    income: income, wins: wins, losses: losses, unknown: unknown,
    streakAfter: streak, bombWins: bombWins, plantLosses: plantLosses
  };
}

/* ------------------------------------------------------------------
 * 观察到的对手击杀账本 —— 「用累计击杀数做差」这条路
 * ==================================================================
 * 思路（这是用户提的，而且思路本身完全正确）：
 *   记下某个对手在回合 R 起始时的**累计**总击杀数，再记下他在 R+1 起始时的，
 *   相减就是他 R 这一回合拿了几个人头。乘上每杀奖励，就得到他这一回合的击杀收入。
 *   这比「假设人均每回合 $X」精确得多。
 *
 * 问题是**数据从哪来**。GSI 在自己游玩时不下发 allplayers，
 * 而靠 `player` 块旁观的只有一个人。所以这份账本只有一个来源：
 * 阵亡后旁观到的那个人（`state.playerObserved`）。
 *   · 休闲模式：能旁观敌人 -> 账本能装到**敌方的**数据，这条路真的可用
 *   · 竞技/优先：只能旁观队友   -> 账本里只有队友，对「对手经济」没有输入
 *
 * 所以这个函数是「有就用，没有就老实承认没有」，不假装。
 * 账本由 lib/gsi.js 累积（acc.killLedger），这里只负责取用。
 * ------------------------------------------------------------------ */

/**
 * 从账本里抽「敌方的」每回合击杀数。
 *
 * 只采纳 round 严格递增的相邻两个采样点：那样 Δ击杀 对应的就是 Δ回合，
 * 相除得到人均每回合击杀数。同一个回合号上的采样会被忽略
 * （回合号没变就说不清是哪个回合杀的）。
 *
 * 两级优先级：
 *   1. 只用**本半场**的样本 —— 最相关，因为要算的正是本半场的收入
 *   2. 本半场凑不出差值时，退回**整局**样本
 *      （击杀频率更像「这个人的水平」而不是「这个半场的属性」，
 *       整局数据同样是有效证据；收入仍然只乘本半场的回合数）
 * 这一步是实测驱动的：真实日志里被旁观的那个人只有 3 个采样点、
 * 而且分散在两个半场，严格按本半场过滤会一个都用不上。
 */
function diffPerRound(ledger, foe, from, field) {
  if (!ledger || typeof ledger !== 'object') return null;

  function collect(minRound) {
    let delta = 0;
    let deltaRounds = 0;
    const detail = [];
    Object.keys(ledger).forEach(function (id) {
      const rec = ledger[id];
      if (!rec || !Array.isArray(rec.samples) || rec.samples.length < 2) return;
      if (rec.side !== foe) return;   // 只要敌方 —— 队友的击杀对对手经济没有输入
      let d = 0;
      let dr = 0;
      let last = null;
      rec.samples.forEach(function (s) {
        if (minRound !== null && s.round < minRound) return;
        if (typeof s[field] !== 'number') return;   // 老样本可能没记这个字段
        if (!last) { last = s; return; }
        if (s.round > last.round) {
          d += s[field] - last[field];
          dr += s.round - last.round;
          last = s;   // 只把「每个回合的第一笔」当初值 ——
                      // 同一回合的重复采样一律忽略，否则回合内已经发生的计数
                      // 会被算进下一个回合的差值里，凭空少算。
        }
      });
      if (dr <= 0 || d < 0) return;   // d<0 = 数据回退过（换局），整条丢掉
      delta += d;
      deltaRounds += dr;
      detail.push({ name: rec.name || id, qty: d, rounds: dr });
    });
    return { qty: delta, rounds: deltaRounds, detail: detail };
  }

  let scope = 'half';
  let got = collect(from);
  if (!got.rounds) { scope = 'match'; got = collect(null); }
  if (!got.rounds) return null;

  return {
    perRound: got.qty / got.rounds,
    players: got.detail.length,
    rounds: got.rounds,
    total: got.qty,
    scope: scope,
    detail: got.detail
  };
}

/**
 * 从账本里抽「敌方的」每回合击杀数 —— 见上面 measuredKillsPerRound 的原始说明。
 * 现在内部改用通用差分 diffPerRound，死亡数走同一个算法。
 */
function measuredKillsPerRound(ledger, foe, from) {
  const r = diffPerRound(ledger, foe, from, 'kills');
  if (!r) return null;
  return {
    killsPerRound: r.perRound,
    players: r.players,
    rounds: r.rounds,
    kills: r.total,
    scope: r.scope,
    detail: r.detail.map(function (d) {
      return { name: d.name, rounds: d.rounds, kills: d.qty };
    })
  };
}

/**
 * 从账本里抽「敌方的」每回合**死亡数** —— 和击杀数完全是同一个算法，只是减的是 deaths。
 *
 * 它换个方向回答同一个问题：
 *   击杀数  → 对手**进账**多少（他们杀了我们的人）
 *   死亡数  → 对手**出账**多少（他们死了，身上的枪没了，下一回合得重买）
 *
 * 死亡数不等于花钱数（可能死的时候身上没装备，也可能活着也换了整套），
 * 所以它只能用来给一个**参考余额**，不能进资金上界。见 estimate 里的 cashLikely。
 */
function measuredDeathsPerRound(ledger, foe, from) {
  const r = diffPerRound(ledger, foe, from, 'deaths');
  if (!r) return null;
  return {
    deathsPerRound: r.perRound,
    players: r.players,
    rounds: r.rounds,
    deaths: r.total,
    scope: r.scope,
    detail: r.detail.map(function (d) {
      return { name: d.name, rounds: d.rounds, deaths: d.qty };
    })
  };
}

/* ------------------------------------------------------------------
 * 这里原先有一个「理性消费模拟」：逐回合推对手会花多少，用推出来的**余额**判档。
 * 后来整个删掉了，因为它的前提是错的 —— **余额低不等于没装备**。
 * 对手刚满买完余额当然低（推出来是 $84 那种），可人家身上是一整套枪；
 * 用余额判会给出「对面在存钱」这种完全相反的结论。
 * 实测时它确实在 $84 和 $2500 之间来回跳，档位判定跟着乱抖。
 *
 * 现在改成两层，可信度写清楚：
 *   硬结论 → 资金上界（连上界都买不起，那就一定买不起）
 *   定性   → 连败数（GSI 精确给的，而「连败 N 局攒了多少钱」在 CS 里几乎确定）
 * ------------------------------------------------------------------ */

/**
 * 累计败方补偿：连败 streak 局总共拿了多少。
 * 这是「确定性能算出来的钱」里最有用的一项 —— 连败队伍的钱基本就是它。
 */
function lossCumulative(streak) {
  let sum = 0;
  for (let i = 0; i < streak; i++) sum += lossBonus(i);
  return sum;
}

/* ------------------------------------------------------------------ */

/**
 * 推算对手经济。
 *
 * 输入：
 *   side        我的阵营（'CT' / 'T'）
 *   roundIndex  0 基回合号（= 已完成回合数）
 *   roundScore  { [回合索引]: { ct, t } } —— 每回合结束后的比分快照（lib/gsi.js 累积）
 *   theirLosses 对手当前连败数（GSI 直接给，精确）
 *   mode        map.mode 原文（'casual' / 'competitive' / …）—— 决定用哪套经济常数
 *   killLedger  观察到的对手累计击杀账本（有就用实测值，没有就退回假设值）
 *
 * 输出里 `verdict` 是人话结论，`conf` 是置信度，`why` 是完整推理链，
 * 界面和语音都从这三个字段取内容，不各自编文案。
 */
function estimate(input) {
  input = input || {};
  const side = input.side;
  const foe = foeOf(side);
  const roundIndex = num(input.roundIndex);
  const roundScore = input.roundScore || {};
  const theirLosses = num(input.theirLosses);
  const modeRaw = input.mode;
  const modeKey = modeOf(modeRaw);
  const econ = econOf(modeKey);

  if (!foe) {
    return { available: false, seq: [], why: ['还没确定阵营，算不出对手经济。'] };
  }
  // 只有「回合号本身拿不到」才不能算。
  // 注意不能写 `roundIndex <= 0` —— 索引 0 就是上半场的手枪局，
  // 而手枪局恰恰是**唯一一个完全不需要历史**就能给出确定结论的回合（双方都 $800）。
  // 早先写成 <= 0，结果上半场手枪局的对手卡片显示「还没有可推的对手数据」，
  // 明明是最确定的一回合却说不出话来。
  if (input.roundIndex === undefined || input.roundIndex === null ||
      !Number.isFinite(Number(input.roundIndex)) || Number(input.roundIndex) < 0) {
    return { available: false, foe: foe, seq: [], why: ['还没拿到回合号，算不出对手经济。'] };
  }

  // 本半场的起点：每 12 回合经济重置一次（含加时赛的每一节）
  const from = roundIndex >= HALF ? HALF * Math.floor(roundIndex / HALF) : 0;
  const endedThisHalf = roundIndex - from;

  const costs = {
    full: fullCostOf(foe, modeKey),
    combat: combatCostOf(foe, modeKey),
    half: halfCostOf(foe, modeKey)
  };

  const base = {
    available: true,
    foe: foe,
    halfStart: from,                      // 本半场第一个回合的索引（debug 页画序列要用）
    endedThisHalf: endedThisHalf,
    theirLosses: theirLosses,
    ifLoseNow: lossBonus(theirLosses),   // 对手本回合若再输，每人能拿多少（精确）
    costs: costs,
    mode: modeKey,                        // 实际用了哪套常数
    modeRaw: modeRaw || '',               // map.mode 原文，便于对照
    freeArmor: !!econ.FREE_ARMOR          // 休闲白送护甲 —— 对手凑长枪的门槛因此更低
  };

  // ---- 手枪局：不用推，双方都一样 ----
  if (isPistolRound(roundIndex)) {
    const pOut = Object.assign(base, {
      pistol: true,
      seq: [],
      tier: 'PISTOL',
      tierLabel: '手枪局',
      conf: 'high',
      cashCeil: econ.START,
      cashSave: econ.START,
      streak: 0,
      cumulativeLossBonus: 0,
      killIncome: 0,
      killSource: 'pistol',
      killsPerRound: null,
      // 手枪局里只有手枪，所以就是手枪档 —— 比普通回合的加权均值更高
      killReward: meanKillReward(modeKey, { pistol: true }),
      killRewardPistol: meanKillReward(modeKey, { pistol: true }),
      killPistolRounds: 1,
      deathsPerRound: null,
      deathSource: 'none',
      spendEst: null,
      cashLikely: null,
      bombWins: 0,
      plantLosses: 0,
      verdict: '手枪局，双方都只有 $' + econ.START +
        ' —— 对面买不了长枪，最多半甲加手枪或微冲。',
      why: [
        '手枪局（本半场第 1 回合）双方起始资金固定 $' + econ.START + '，这是规则不是推算。',
        '对面能买的最贵配置是' +
          (econ.FREE_ARMOR ? '一把手枪（休闲每回合白送护甲）'
                           : '半甲 $' + (PRICE.kevlar ? PRICE.kevlar.cost : 650) + ' 加一把手枪') + '。'
      ]
    });
    // 这一支也必须生成 say。早先它只把对象 return 出去、没调 sayLine，
    // 于是 say 是 undefined —— 语音那边 `if (en.available && en.say)` 判不过，
    // 掉进「对面经济正常，大概率完整购买」那条兜底分支，说的和事实完全相反。
    // 手枪局恰恰是最确定的一回合，却说得最错，这个坑很典型。
    pOut.say = sayLine(pOut);
    return pOut;
  }

  // ---- 重建胜负序列 ----
  const seq = buildSequence(roundScore, from, roundIndex, input.roundPlant);
  const acc = accumulate(seq, foe, econ);
  const known = seq.length - acc.unknown;
  const coverage = seq.length ? known / seq.length : 0;

  /* ---- 击杀收入：能用实测就用实测，用不了才退回假设 ----
   *
   * 假设值的来历：对手一回合最多 5 个击杀（我们最多死 5 人），
   * 那 5 份奖励是全队分的，所以**人均每回合 ≤ 每杀平均奖励**（$300 竞技 / $150 休闲）。
   * 这是团队平均值意义上的上界，不需要假设他们每回合杀几个人。
   *
   * 实测值的来历：旁观到敌方某人时，记下他的**累计**总击杀数；
   * 两个回合起点相减 = 他那一回合杀了几个人。乘上每杀奖励就是真实收入。
   * 这条路的覆盖很窄（随时只有一个被旁观者，且只在阵亡期间），
   * 所以只要拿到就比假设值准得多 —— 特别是「他这一回合一个没杀」这种情况，
   * 假设值永远给不出 0，实测值直接给 0。
   */
  const killReward = meanKillReward(modeKey);                       // 普通回合口径
  const killRewardPistol = meanKillReward(modeKey, { pistol: true }); // 手枪局口径
  const pistolRounds = seq.filter(function (s) { return isPistolRound(s.round); }).length;
  const measured = measuredKillsPerRound(input.killLedger, foe, from);
  let killIncome, killSource, killsPerRound;
  if (measured) {
    killsPerRound = measured.killsPerRound;
    killIncome = killIncomeOf(seq, modeKey, measured.killsPerRound);
    killSource = 'measured';
  } else {
    killsPerRound = null;
    killIncome = killIncomeOf(seq, modeKey, null);
    killSource = 'assumed';
  }

  // 资金上界：假设对手一分钱都没花，再叠加击杀奖励的（假设或实测的）上界。
  // 这是「最不可能出现的好情况」，拿它下结论最稳 —— 连它都买不起，就一定买不起。
  const cashCeil = Math.min(econ.MAX, acc.income + killIncome);

  /* ---- 支出侧的参考值：用「死亡数」估对手花了多少 ----
   *
   * 上界的前提是「一分钱没花」，现实里显然不成立。死亡数是**能观测到**的
   * 花钱痕迹：死一次，身上的枪就没了，下一回合得重买。
   * 所以 估算支出 ≈ 人均每回合死亡数 × 重购成本 × 回合数。
   *
   * ⚠️ 它只能当**参考**，绝不能进资金上界、更不能驱动档位判断。
   *    因为这个项目早先试过「理性消费模拟」去推余额，结果发现
   *    **余额低 ≠ 没装备** —— 对手刚满买完余额当然是 0，可人家身上是全套枪。
   *    用余额判档会给出「对面在存钱」这种完全相反的结论。
   *    所以这里只多给一个 cashLikely，档位和结论仍然只认 cashCeil。
   */
  const measuredDeaths = measuredDeathsPerRound(input.killLedger, foe, from);
  let deathsPerRound = null;
  let spendEst = null;
  let cashLikely = null;
  if (measuredDeaths) {
    deathsPerRound = measuredDeaths.deathsPerRound;
    spendEst = Math.round(deathsPerRound * costs.combat * seq.length);
    cashLikely = Math.max(0, Math.round(cashCeil - spendEst));
  }

  // 参考值：假设对手一直在 eco 攒钱，能攒到多少
  const cashSave = Math.max(0, acc.income - ECO_KEEP * seq.length);

  // 「对手现在连败几局」优先用序列推出来的那个。
  // GSI 的 consecutive_round_losses 在回合刚切换的一两帧里会滞后
  // （实测日志里能看到「刚赢完却还写着连败 2」），而序列是从比分推的，不会错位。
  const streak = coverage >= 0.8 ? acc.streakAfter : theirLosses;
  const cumLoss = lossCumulative(streak);

  const out = Object.assign(base, {
    pistol: false,
    seq: seq,                        // 重建出的胜负序列 —— debug 页直接画出来，看得见就不用猜
    income: acc.income,               // 人均累计确定性收入（不含击杀奖励）
    // 注意字段名：这里用 halfWins / halfLosses 而**不是** wins / losses。
    // 因为上层（lib/economy.js）会把这个对象合并进 a.enemy，
    // 而 a.enemy.losses 是「连败数」（GSI 精确给的那个，render/speech/llm 都在用）。
    // 早先这里叫 losses，合并时把连败数盖掉了 —— 界面会显示成「本半场输了几局」，
    // 名字撞车就是这么隐蔽。加上 half 前缀，谁都不会再认错。
    halfWins: acc.wins,
    halfLosses: acc.losses,
    unknownRounds: acc.unknown,
    coverage: coverage,
    cashCeil: cashCeil,
    cashSave: cashSave,
    /*
     * ---- 击杀收入这一层，单独摊开 ----
     * killIncome    本半场人均击杀收入（实测或假设）
     * killSource    'measured' = 旁观到敌方、按累计击杀数做差算出来的
     *               'assumed'  = 没有观测数据，按「人均每回合 ≤ 每杀平均奖励」估的
     * killsPerRound 实测的人均每回合击杀数（只有 measured 时才有值）
     * killReward    用的每杀奖励是多少（随模式变：竞技 $300 / 休闲 $150）
     *                  —— 这个值以前写死成 $300，在休闲局里高估了一倍
     */
    killIncome: killIncome,
    killSource: killSource,
    killsPerRound: killsPerRound,
    killReward: killReward,                 // 普通回合口径（手枪局另有 killRewardPistol）
    killRewardPistol: killRewardPistol,     // 手枪局口径 —— 没有 AWP，均值更高
    killPistolRounds: pistolRounds,         // 本半场序列里有几个手枪局
    killObservedPlayers: measured ? measured.players : 0,
    // ---- 支出侧的参考值（只有旁观到敌方死亡数时才有）----
    deathsPerRound: deathsPerRound,         // 实测人均每回合死亡数
    deathSource: measuredDeaths ? 'measured' : 'none',
    spendEst: spendEst,                     // 估算已花掉多少
    cashLikely: cashLikely,                 // 扣掉估算支出后的余额 —— 参考，不是界
    // ---- 炸弹相关的结算 ----
    bombWins: acc.bombWins,                 // 以炸弹结束、多拿 $250 的胜局数
    plantLosses: acc.plantLosses,           // T 埋包后仍输、多拿 $800 的局数
    streak: streak,
    cumulativeLossBonus: cumLoss,
    why: []
  });

  const why = [];
  why.push('本半场已走完 ' + endedThisHalf + ' 回合，对手 ' + acc.wins + ' 胜 ' + acc.losses + ' 负。');
  why.push('对手人均累计收入至少 $' + Math.round(acc.income) +
    '（起始 $' + econ.START + ' + 每回合基础 $' + econ.PER_ROUND + ' × ' + seq.length +
    ' + 胜负奖金）。这是硬算的，不含击杀奖励。');
  if (killSource === 'measured') {
    why.push('击杀收入 $' + Math.round(killIncome) + ' 是**算出来的**，不是估的：' +
      '旁观到 ' + measured.players + ' 名对手，' + measured.rounds + ' 个回合里拿了 ' +
      measured.kills + ' 个人头，人均每回合 ' + measured.killsPerRound.toFixed(2) +
      ' 杀（样本取自' + (measured.scope === 'half' ? '本半场' : '整局（本半场采样不够）') + '）。');
    measured.detail.forEach(function (d) {
      why.push('  · ' + d.name + '：' + d.rounds + ' 回合 ' + d.kills + ' 杀');
    });
  } else {
    why.push('击杀收入按 $' + Math.round(killIncome) + ' 计：' +
      '对手一回合最多拿 5 个人头（我们最多死 5 人），这几份奖励全队平分，' +
      '所以人均每回合不超过「每杀平均奖励」。' +
      '拿不到他们的击杀数（GSI 只在自己游玩时下发 allplayers，见 README），所以只能用这个上界。');
  }
  why.push('每杀按多少算：普通回合 $' + killReward + '（按实测武器占比加权：' +
    'AWP 只给 $100，会把均值拉低）；手枪局 $' + killRewardPistol +
    '（那一局只有手枪，没有 AWP 可拖）。本半场序列里有 ' + pistolRounds + ' 个手枪局。');

  if (acc.bombWins > 0) {
    why.push('对手有 ' + acc.bombWins + ' 个胜局是以炸弹结束的（引爆 / 拆包），' +
      '每个多拿 $' + WIN_BOMB_EXTRA + ' —— 胜利奖金是 $' + (econ.WIN + WIN_BOMB_EXTRA) +
      ' 而不是 $' + econ.WIN + '。');
  }
  if (acc.plantLosses > 0) {
    why.push('对手作为 T 有 ' + acc.plantLosses + ' 个回合埋了包却输掉，' +
      '每个多拿 $' + PLANT_LOSS + ' 补偿。');
  }

  if (cashLikely !== null) {
    why.push('参考余额 ≈ $' + cashLikely + '：上面的上界假设他们一分钱没花，' +
      '但实测他们人均每回合死 ' + deathsPerRound.toFixed(2) + ' 次 —— ' +
      '死一次就得重买一套（按 $' + costs.combat + ' 算），' +
      '所以估算已经花掉 $' + spendEst + '。**这只是参考值，档位判断不用它**：' +
      '余额低不等于没装备，满买完余额本来就是 0。');
  }
  why.push('资金上界 $' + Math.round(cashCeil) +
    '：假设对面一分钱都没花，再叠上上面那笔击杀收入。低于买枪门槛时就是硬结论。');
  why.push('就算他们一直在 eco 攒钱，也就 $' + Math.round(cashSave) + ' 左右。');
  why.push('对手「步枪' + (econ.FREE_ARMOR ? '」' : ' + 甲盔」') + '需要 $' + costs.combat +
    '，满买需要 $' + costs.full + '。');
  if (modeKey === 'casual') {
    why.push('这是**休闲局**（map.mode = casual）：起始 $' + econ.START +
      '、胜利 $' + econ.WIN + '、上限 $' + econ.MAX + '，击杀奖励减半，而且护甲每回合白送 —— ' +
      '所以对面凑齐长枪只需要 $' + costs.combat + '。数字和竞技不一样。');
  }
  if (streak > 0) {
    why.push('对手当前连败 ' + streak + ' 局，已经累计领了 $' + cumLoss +
      ' 的败方补偿；本回合若再输，每人再进账 $' + lossBonus(streak) + '。');
  }
  if (coverage < 1) {
    why.push('注意：本半场有 ' + acc.unknown + ' 个回合没有比分快照（服务是中途启动的），' +
      '这些回合被按「最少增益」计入了，所以收入是偏低的估计。');
  }

  // ---- 结论 ----
  //
  // 刻意分两层，因为两层的可信度完全不同：
  //   第一层（high）：用**资金上界**判。上界都买不起，那就是确定买不起。
  //     代价是只有开局前几回合上界才够低、才有判别力 —— 之后它会涨到 $16000 饱和。
  //   第二层（mid）：用**连败数**判。连败几局是 GSI 精确给的，
  //     而「连败 N 局攒了多少钱」在 CS 里几乎是确定的（败方补偿是固定阶梯）。
  //     攒到第 3 局就够满买了，只连败 1 局则基本是穷的。
  let conf;
  let verdict;
  let tier;

  if (coverage < 0.5) {
    conf = 'low';
    tier = '';
    verdict = '本半场的胜负记录不完整（服务中途才启动），只能给个大概：' +
      '对面资金上限 $' + Math.round(cashCeil) + '，' +
      (cashCeil < costs.half ? '连微冲加甲都费劲，偏 eco。' : '至少有半买的能力。');
  } else if (cashCeil < costs.half) {
    conf = 'high';
    tier = 'ECO';
    verdict = '对面这回合必然是纯 eco：就算一分钱没花，人均也只有 $' + Math.round(cashCeil) +
      '，买不起「微冲 + 半甲」的 $' + costs.half + '。放心往前压。';
  } else if (cashCeil < costs.combat) {
    conf = 'high';
    tier = 'FORCE_BUY';
    verdict = '对面这回合不可能人手一把长枪：资金上界 $' + Math.round(cashCeil) +
      ' 低于「步枪 + 甲盔」的 $' + costs.combat +
      ' —— 最多是微冲或手枪加甲，除非靠上回合保下来的枪。';
  } else if (streak >= 3) {
    conf = 'mid';
    tier = 'FULL_BUY';
    verdict = '对面已经连败 ' + streak + ' 局，败方补偿累计到每人 $' + cumLoss +
      ' 左右 —— 攒够了，这回合大概率满买强力反扑，别当他们是穷队。';
  } else if (streak === 2) {
    conf = 'mid';
    tier = 'HALF_BUY';
    verdict = '对面连败 2 局，钱刚好够半买或强起：能凑出微冲或便宜步枪加甲，但做不到人人长枪。';
  } else if (streak === 1) {
    conf = 'mid';
    tier = 'ECO';
    verdict = '对面刚输一局，手上钱不多 —— 大概率存钱局，也可能赌一把强起，注意前期 rush。';
  } else {
    conf = 'mid';
    tier = 'FULL_BUY';
    verdict = '对手刚赢（连败已清零），回合胜利的 $' + econ.WIN +
      ' 已经到账 —— 大概率满买，正面要跟他们对拼装备。';
  }

  out.conf = conf;
  out.tier = tier;
  out.verdict = verdict;
  out.tierLabel = TIER_CN[tier] || (tier ? tier : '不确定');
  out.why = why;

  // 语音用的短句：只留最有信息量的那一句
  out.say = sayLine(out);

  return out;
}

/** 给语音播报用的短句 —— 比 verdict 再短一截，一两秒能念完 */
function sayLine(e) {
  if (!e || !e.available) return '';
  // 战绩记录不全时不猜，宁可不说 —— 播一句错的比不播更糟
  if (e.conf === 'low') return '';
  // 手枪局起始资金随模式变（休闲 $1000 / 竞技 $800）。
  // 原先这里写死「八百块」—— 在休闲局里就是念错的，而手枪局恰恰是最确定的一回合。
  if (e.pistol) return '对面手枪局，只有' + (e.cashCeil >= 1000 ? '一千' : '八百') + '块。';
  if (e.conf === 'high' && e.cashCeil < e.costs.half) {
    return '对面没钱，这回合基本是存钱局。';
  }
  if (e.conf === 'high' && e.cashCeil < e.costs.combat) {
    return '对面买不起长枪，最多微冲加甲。';
  }
  if (e.streak >= 3) return '对面连败攒够钱了，这回合可能满买反扑。';
  if (e.tier === 'ECO') return '对面大概在存钱。';
  if (e.tier === 'HALF_BUY') return '对面半买，装备不齐。';
  if (e.tier === 'FORCE_BUY') return '对面可能强起，小心快攻。';
  return '对面大概率满买，准备对拼。';
}

module.exports = {
  estimate: estimate,
  lossBonus: lossBonus,
  lossCumulative: lossCumulative,
  foeOf: foeOf,
  isPistolRound: isPistolRound,
  fullCostOf: fullCostOf,
  combatCostOf: combatCostOf,
  halfCostOf: halfCostOf,
  buildSequence: buildSequence,
  accumulate: accumulate,
  measuredKillsPerRound: measuredKillsPerRound,
  measuredDeathsPerRound: measuredDeathsPerRound,
  diffPerRound: diffPerRound,
  killIncomeOf: killIncomeOf,
  modeOf: modeOf,
  econOf: econOf,
  meanKillReward: meanKillReward,
  killCeilPerRound: killCeilPerRound,
  MODES: MODES,
  KILL_REWARD: KILL_REWARD,
  KILL_MIX: KILL_MIX,
  WIN_BOMB_EXTRA: WIN_BOMB_EXTRA,
  PLANT_LOSS: PLANT_LOSS,
  LADDER: LADDER,
  ECO_KEEP: ECO_KEEP,
  KILL_BONUS_CEIL: KILL_BONUS_CEIL,
  TIER_CN: TIER_CN
};
