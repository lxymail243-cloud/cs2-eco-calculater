'use strict';

/**
 * GSI 数据帧的累积合并
 *
 * 为什么需要这个文件：
 *   gamestate_integration 配置里开了 "buffer" 和 "throttle"（各 0.1 秒），
 *   这是为了降低推送频率，代价是 GSI 只推送**发生变化的分量**，而不是每次都推全量。
 *
 *   真实日志里的实测结果（具体帧数每次跑 tools/selftest.js 第 0 组现场数，
 *   这里只说结论，免得日志一长这些数字就变成谎话）：
 *     有相当一部分包缺 map 分量（gsi 配置里开了 buffer/throttle 导致的）
 *     也有包有 player 但缺 state / weapons / team
 *     还有包带 previously 字段（GSI 用它表示「改之前是什么」）
 *
 *   也就是说，如果直接把裸包丢给分析引擎，这些帧算出来的回合号会是 0、
 *   阵营会是「未定」—— 界面就会在两个正确值之间来回跳。
 *
 * 合并规则（有一条是反直觉的，来自实测）：
 *   1. 普通字段：深度合并。没推来的字段保留上一次的值。
 *   2. player.weapons 和 allplayers[*].weapons：**整体替换，不做深度合并**。
 *      实测证据：玩家阵亡时武器键数从 6 直接掉到 0，旧键被删除且不带 null 占位。
 *      如果对武器做深度合并，会留下一把「幽灵步枪」，
 *      导致引擎误判你「已经有主武器了，别重复买枪」—— 这是会直接影响建议的错误。
 *   3. 值为 null 的键：视为删除（GSI 删除玩家条目时用这个方式）。
 *
 *   4. round.bomb / round.win_team：**回合一换就清掉**。
 *      实测证据：这两个字段只在变化时推一次，而且 GSI 永远不会推一个
 *      「中性值」把 planted 冲掉 —— 在几百帧的真实日志里，它俩各自只出现在
 *      几十帧里，取值只有 'planted' / 'defused' 和 'CT' / 'T'。
 *      如果不清，下一次包下完以后 round.bomb='planted' 会永久留在状态里，
 *      引擎就会在之后每一个回合都喊「包已经下了，回防」。
 *      （和武器子树是同一类坑，但方向相反：武器是缺键要删，这个是缺键要清。）
 */

// 这些子树必须整体替换，不能深度合并
const REPLACE_SUBTREES = [['player', 'weapons']];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 清掉「只属于上一回合」的字段。
 * 它们在 GSI 里是回合结果，不是持续状态，跨回合保留一定是错的。
 * 注意只删这几个键，round.phase 要留着。
 */
function clearRoundTransients(state) {
  if (isPlainObject(state.round)) {
    delete state.round.bomb;
    delete state.round.win_team;
  }
  delete state.bomb;
}

function clone(v) {
  if (!isPlainObject(v)) return v;
  const out = {};
  for (const k of Object.keys(v)) out[k] = clone(v[k]);
  return out;
}

function deepMergeInto(target, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v === null || v === undefined) {
      delete target[k];
      continue;
    }
    if (isPlainObject(v)) {
      if (!isPlainObject(target[k])) target[k] = {};
      deepMergeInto(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function createAccumulator() {
  return {
    state: {}, mapName: '', lastRound: null, lastPhase: '', lastFrameRound: null,
    frames: 0, resets: 0, roundClears: 0,
    // 每回合的比分快照 { [回合索引]: { ct, t } }。
    // 语义：roundScore[k] = 回合 k **开始之前**的比分（= 回合 k-1 走完之后）。
    // 因为 GSI 把 map.round 推到 k 的时候，k-1 的比分已经加上了。
    // 它是重建「对手每回合输赢」的唯一依据，对手经济推算要用（见 lib/enemy.js）。
    roundScore: {},
    /* 第一半场我的阵营。用来在半场换边后把比分翻回同一个视角（见 mergeFrame）。 */
    refSide: '',
    wasDeadAtRound: null, respawnAt: 0, respawnRound: null,
    /* 每个回合各复活了几次。用来把「真热身/死斗」和「休闲模式的接手机器人」分开 ——
     * 两者都是「同一回合内血从 0 变正」，但热身会在一回合里反复复活（≥2 次），
     * 接手机器人一个回合只发生一次。详见 detectRespawn 的注释。 */
    respawnCount: {},
    /* ---- 「player 块到底是不是我」的身份跟踪（见 mergeFrame 里的长注释）----
     * mySteamid 来自 provider.steamid —— 它是**客户端身份**，每一帧都带、整个进程恒定。
     * sawMe 记「有没有见过 player.steamid === mySteamid 的帧」，
     * 用来区分「自己游玩中途开始旁观」和「从头到尾就是观战者」。
     */
    mySteamid: '', sawMe: false, spectating: false, observedAt: 0,
    /* ---- 观察到的累计击杀账本 ----
     * 结构：{ [steamid]: { name, side, samples: [{ round, kills, at }] } }
     * 每个回合只记**第一笔**采样（回合起始时的累计总击杀数），
     * 相邻两个回合相减 = 前一个回合杀了几个人（见 lib/enemy.js 的 measuredKillsPerRound）。
     *
     * 为什么值得记：GSI 不下发敌方数据，但阵亡后旁观到某人时，
     * `player.match_stats.kills` 就是**那个人**的累计总击杀数 —— 实测日志里
     * 有 125 帧处于这个状态（旁观过 21 个不同身份），累计值单调递增、可用。
     * 休闲模式能旁观敌人 -> 这条数据链真能落到敌方身上；
     * 竞技模式只能旁观队友 -> 记下来了，但对「对手经济」没有输入。
     */
    killLedger: {},
    /* ---- 埋包记录 ----
     * 结构：{ [round]: true }
     * 只要那个回合里出现过 round.bomb = 'planted' 就记一笔。
     * 用途在 lib/enemy.js：以炸弹结束的回合胜方每人多拿 $250，
     * T 埋了包却输掉每人也多拿 $800。这两笔原来完全没算，而 $250 × 一局里的几个回合
     * 足以把「上界够不够长枪」的判断推到另一边。
     *
     * 实测依据：'planted' 出现在**当前**回合的 live 阶段，
     * 'exploded' / 'defused' 出现在该回合的 over 阶段 —— 两者的 map.round 相同，
     * 所以统一用 map.round 当键是安全的。
     */
    roundPlant: {}
  };
}

/**
 * 记一笔「某玩家在本回合第一次被看到时的累计总击杀数 / 死亡数」。
 *
 * 每个回合只留第一笔：那样两个相邻回合的采样点差不多落在同一个时间偏移上，
 * 相减时的截断误差会互相抵消，得到的就近似是「他这一回合杀了几个人」。
 * 同一回合内后来的采样直接丢掉 —— 留着反而会把回合内已发生的击杀算进差值里。
 *
 * 击杀数是**进账**（他杀了我们的人），死亡数是**出账**（他死了，装备没了要重买）。
 * 两份都用同一个「相邻回合做差」的算法，见 lib/enemy.js 的 diffPerRound。
 */
function observeKillsFor(acc, id, name, team, stats, roundIdx) {
  if (!id || roundIdx === null || !stats || typeof stats.kills !== 'number') return;
  const kills = stats.kills;
  const deaths = (typeof stats.deaths === 'number') ? stats.deaths : null;
  const rec = acc.killLedger[id] || { name: '', side: null, samples: [] };
  if (name) rec.name = name;
  if (team === 'CT' || team === 'T') rec.side = team;

  const last = rec.samples[rec.samples.length - 1];
  // 累计值倒退 = 换了局 / 换了半场 -> 之前的样本全部作废
  if (last && kills < last.kills) rec.samples = [];
  const tail = rec.samples[rec.samples.length - 1];
  if (!tail || tail.round !== roundIdx) {
    rec.samples.push({ round: roundIdx, kills: kills, deaths: deaths, at: Date.now() });
    if (rec.samples.length > 64) rec.samples.shift();
  }
  acc.killLedger[id] = rec;
}

/**
 * 从一帧里收击杀 / 死亡样本。三个来源：
 *   1. `player` 块 —— 你自己（正在玩），或者正在旁观的那个人
 *   2. `allplayers` —— 观战 / GOTV 时才有（自己游玩时实测 0 帧，但顺手接上）
 */
function observeKills(acc, frame, roundIdx) {
  if (roundIdx === null) return;
  const pl = frame.player;
  if (pl && pl.match_stats && typeof pl.match_stats.kills === 'number') {
    observeKillsFor(acc, pl.steamid, pl.name, pl.team, pl.match_stats, roundIdx);
  }
  if (isPlainObject(frame.allplayers)) {
    for (const id of Object.keys(frame.allplayers)) {
      const ap = frame.allplayers[id];
      if (!isPlainObject(ap) || !ap.match_stats) continue;
      if (typeof ap.match_stats.kills !== 'number') continue;
      observeKillsFor(acc, id, ap.name, ap.team, ap.match_stats, roundIdx);
    }
  }
}

/**
 * 检测「同一回合内死而复生」—— 这是判断「还在热身 / 死斗」的硬信号。
 *
 * 为什么需要它：5E 这类平台等人进图时会先跑一段死斗式热身。
 * 如果它没走 map.phase = warmup 这条标准路径，光靠阶段名是判不出来的。
 *
 * 而「死了又活」这件事正式比赛里不会发生（阵亡要等到下一回合），
 * 死斗里则每几秒就发生一次。所以：
 *   血量为 0 时记下当前回合索引 -> 之后血量为正且回合索引没变 -> 判定为复活。
 *
 * ★ 实测才发现的一个反例（这是本函数从「判一次」改成「数次数」的原因）：
 *   休闲模式里阵亡后可以**接手机器人**。接手那一刻 GSI 的 player 块会回到你自己
 *   （steamid / 名字都是你的），但血量和武器是**那个机器人的** ——
 *   于是「血从 0 跳到 100、回合号没变」这个特征被触发了。
 *   日志里帧 127→128 就是：上一个是机器人「克拉伦斯」（AWP + 手雷），
 *   下一个是你自己、**武器同样是 AWP + 手雷**，血 100。
 *
 *   后果很严重：真实日志 1135 帧里有 **291 帧（26%）** 被这条规则判成「热身」，
 *   而其中真正处于 warmup 阶段的只有 4 帧 —— 界面会在正常回合里显示「热身中」，
 *   把对手经济的结论全部屏蔽掉。
 *
 *   区分办法：热身 / 死斗里是**反复**复活（一回合内 ≥2 次，死斗每几秒一次），
 *   接手机器人一个回合只发生一次。所以这里改成**按回合计数**，
 *   由 looksLikeWarmup 要求「同一回合至少复活 2 次」才算热身。
 *   拿真实日志验过：8 次复活分散在 8 个**不同**回合，全部只有 1 次
 *   -> 误判归零；而死斗热身一回合内必然远超 2 次 -> 照旧能识别。
 */
function detectRespawn(acc, state) {
  const st = state.player && state.player.state;
  if (!st || typeof st.health !== 'number') return;
  const round = (state.map && typeof state.map.round === 'number') ? state.map.round : null;
  if (st.health <= 0) {
    acc.wasDeadAtRound = round;
    return;
  }
  if (acc.wasDeadAtRound !== null && round !== null && round === acc.wasDeadAtRound) {
    acc.respawnAt = Date.now();
    acc.respawnRound = round;
    const key = String(round);
    acc.respawnCount[key] = (acc.respawnCount[key] || 0) + 1;
    acc.wasDeadAtRound = null;   // 一次死亡只报一次
  }
}

function reset(acc, reason) {
  acc.state = {};
  acc.lastRound = null;
  acc.lastFrameRound = null;
  acc.roundScore = {};     // 换图 / 新对局时比分要跟着清，别把上一局的序列带进来
  acc.refSide = '';        // 换边归一化的参照系也跟着清
  acc.killLedger = {};     // 击杀数是按局累计的，换局必须清 —— 否则差值会变成负数
  acc.roundPlant = {};     // 埋包记录也是按局的，换局要清
  acc.respawnCount = {};   // 复活的计数也跟着清，否则上一局的次数会让新局误判成热身
  acc.wasDeadAtRound = null;
  acc.respawnAt = 0;
  acc.respawnRound = null;
  acc.resets++;
  acc.lastResetReason = reason;
}

/**
 * 把一帧合进累积状态，返回合并后的完整状态。
 *
 * 返回的是累积对象内部的引用（不拷贝），调用方只读即可。
 */
function mergeFrame(acc, frame) {
  if (!isPlainObject(frame)) return acc.state;
  acc.frames++;

  const mapName = frame.map && frame.map.name;
  const roundIdx = frame.map && typeof frame.map.round === 'number' ? frame.map.round : null;

  // ---- 新地图 / 新对局 -> 清空，否则会把上一局的数据带进来 ----
  if (mapName && mapName !== acc.mapName) {
    reset(acc, 'map change -> ' + mapName);
    acc.mapName = mapName;
  } else if (roundIdx === 0 && acc.lastRound !== null && acc.lastRound > 0) {
    // 同一张图重开一局（回合号从 0 重新开始）
    reset(acc, 'new match on same map');
  }
  if (frame.map && frame.map.phase === 'warmup') {
    if (acc.lastRound !== null && acc.lastRound > 0) reset(acc, 'warmup');
  }
  // 热身 -> 正式比赛：把热身期捡到的枪（死斗里能随手捡 AWP）清掉，别带进第一回合
  const nowPhase = String((frame.map && frame.map.phase) || '');
  if (acc.lastPhase === 'warmup' && nowPhase && nowPhase !== 'warmup') {
    reset(acc, 'warmup -> ' + nowPhase);
  }
  if (nowPhase) acc.lastPhase = nowPhase;

  // ---- 回合切换：清掉只属于上一回合的字段 ----
  // 必须在 merge 之前清：这样本帧若带了新值，会正常写进去；
  // 若没带（增量帧常态），状态里就是干净的「本回合还没下包」。
  if (roundIdx !== null) {
    if (acc.lastFrameRound !== null && roundIdx !== acc.lastFrameRound) {
      clearRoundTransients(acc.state);
      acc.roundClears++;
    }
    acc.lastFrameRound = roundIdx;
  }

  /* ==================================================================
   * player 块**不一定是你** —— 这是实测日志才知道的事。
   * ==================================================================
   * 在休闲模式里阵亡后可以旁观敌人，那一刻 GSI 会把整个 `player` 块
   * **切成被旁观者的**：name / steamid / state.money / weapons 全变成他的。
   * 实测帧 115 起的原文就是 `{"steamid":"795","name":"尤里",...,"money":2300,
   * "weapons":{"weapon_1":{"name":"weapon_sg556"...}}}` —— 一个 T 方机器人的钱和枪。
   *
   * 判据：`provider.steamid` 是**客户端身份**，1135 个真实帧里恒定不变；
   * 而 `player.steamid` 会来回跳（实测跳了 102 次）。
   * 用 `provider.steamid` 而不是「第一次见到的 player.steamid」，
   * 是因为后者可能在旁观中才第一次出现 —— 那就把别人当成自己了。
   *
   * 不处理会出四件事（都在真实日志里发生过）：
   *   1. 界面把**敌人的钱**显示成「我的金钱」
   *   2. 我方 / 敌方整个反过来（实测翻转 32 次）
   *   3. 「死而复生」检测被别人的血量骗到 -> 误判成热身
   *   4. `player.state` 的旧键残留（REPLACE_SUBTREES 只换 weapons，见下）
   *
   * 处理办法：确认是别人时，把它单独收进 `state.playerObserved`，
   * **不要**并进 `state.player`。`state.player` 永远是你自己
   * （旁观期间冻结在阵亡那一刻 —— 反正死了也买不了东西，不会失真）。
   * 这份被旁观者的数据反而是白捡的情报：他的真实金钱、血量、护甲、武器全在里面。
   */
  if (frame.provider && frame.provider.steamid && !acc.mySteamid) {
    acc.mySteamid = frame.provider.steamid;
  }
  const pSteam = frame.player && frame.player.steamid;
  const playerIsMe = !acc.mySteamid || !pSteam || pSteam === acc.mySteamid;

  if (playerIsMe) {
    if (acc.mySteamid && pSteam === acc.mySteamid) acc.sawMe = true;
    acc.spectating = false;
    delete acc.state.playerObserved;
    delete acc.state.playerObservedAt;
  } else if (acc.sawMe) {
    // 确认是「旁观别人」。sawMe 为 false 时（从头到尾都是观战者）按老办法合并，保持兼容。
    acc.spectating = true;
    acc.observedAt = Date.now();
    acc.state.playerObserved = clone(frame.player);
    acc.state.playerObservedAt = acc.observedAt;
  }

  // 旁观时要把 player 整块摘掉再合并，否则会覆盖 / 污染 state.player
  let toMerge = frame;
  if (acc.spectating) {
    toMerge = {};
    for (const k of Object.keys(frame)) { if (k !== 'player') toMerge[k] = frame[k]; }
  }

  // 收击杀样本 —— 必须用**原始 frame**，不能用 toMerge：
  // 旁观时 toMerge 里的 player 已经被摘掉了，而那恰恰是最有价值的一路数据。
  observeKills(acc, frame, roundIdx);

  // 记「这一回合埋过包」。同样读原始 frame（round 变了才会推这条增量），
  // 不读合并后的 state —— 合并出的 round.bomb 可能残留上一回合的值。
  if (roundIdx !== null && frame.round && frame.round.bomb === 'planted') {
    acc.roundPlant[roundIdx] = true;
  }

  deepMergeInto(acc.state, toMerge);

  // 记下「这个回合号下见过的最大比分」。比分只增不减，所以对同一回合取 max 即可。
  // 语义：roundScore[k] = 回合 k 开始之前的比分（GSI 推 round=k 时，k-1 的分已经加了）。
  if (roundIdx !== null) {
    const mm = acc.state.map;
    const ct = mm && mm.team_ct;
    const tt = mm && mm.team_t;
    if (ct && tt && typeof ct.score === 'number' && typeof tt.score === 'number') {
      let c = ct.score, t = tt.score;

      /*
       * ---- 半场换边归一化（真实竞技日志里发现的一个真 BUG）----
       *
       * GSI 在 intermission 那帧给的是换边前的比分，下半场第一帧开始两个队的比分
       * 就换了位置。实测 de_ancient：第 12 回合先看到 4:8，紧接着变成 8:4 ——
       * 同一场比赛，只是 CT/T 的标签对调了。
       *
       * 原来的写法是「每个字段各自取最大值」，于是 ct 取到 8、t 取到 8，
       * 拼出 roundScore[12] = {ct:8, t:8} 这个**从未出现过**的比分（总分 16 局！）。
       * 后果：后半场第一个回合的胜负判不出来（buildSequence 里 dct、dt 同时为正 -> null），
       * 而 lib/enemy.js 对判不出胜负的回合按「对手首败」计 ——
       * 整条连败阶梯从后半场第一回合起就错位了。
       *
       * 修法：不猜，直接拿**自己的阵营**当参照系。
       * 我方阵营变了（T -> CT）就说明刚换了边，把这对比分翻回来，
       * 让 roundScore 全程用「第一半场的左右」。
       * 这样 buildSequence 里 winner 的语义不用动，上层一行都不用改。
       */
      const mySide = acc.state.player && acc.state.player.team;
      if (mySide === 'CT' || mySide === 'T') {
        if (!acc.refSide) acc.refSide = mySide;
        if (mySide !== acc.refSide) { const tmp = c; c = t; t = tmp; }
      }

      const cur = acc.roundScore[roundIdx];
      if (!cur || (c + t) > (cur.ct + cur.t)) acc.roundScore[roundIdx] = { ct: c, t: t };
    }
  }

  // ---- 必须整体替换的子树 ----
  for (const path of REPLACE_SUBTREES) {
    // 用 toMerge 而不是 frame：旁观时 player 已被摘掉，
    // 不能让被旁观者的 weapons 覆盖到 state.player.weapons 上
    const srcParent = path.slice(0, -1).reduce(function (o, k) { return o && o[k]; }, toMerge);
    const key = path[path.length - 1];
    if (srcParent && isPlainObject(srcParent[key])) {
      const dstParent = path.slice(0, -1).reduce(function (o, k) { return o && o[k]; }, acc.state);
      if (dstParent) dstParent[key] = clone(srcParent[key]);
    } else if (srcParent && srcParent[key] === null) {
      const dstParent = path.slice(0, -1).reduce(function (o, k) { return o && o[k]; }, acc.state);
      if (dstParent) delete dstParent[key];
    }
  }

  // allplayers 里每个玩家的武器同理，逐个替换；玩家条目为 null 表示离开
  if (isPlainObject(frame.allplayers) && isPlainObject(acc.state.allplayers)) {
    for (const id of Object.keys(frame.allplayers)) {
      const p = frame.allplayers[id];
      if (p === null || p === undefined) {
        delete acc.state.allplayers[id];
        continue;
      }
      if (!isPlainObject(acc.state.allplayers[id])) acc.state.allplayers[id] = {};
      if (isPlainObject(p.weapons)) acc.state.allplayers[id].weapons = clone(p.weapons);
    }
  }

  if (roundIdx !== null) {
    acc.lastRound = acc.lastRound === null ? roundIdx : Math.max(acc.lastRound, roundIdx);
  }
  acc.mapName = mapName || acc.mapName;
  detectRespawn(acc, acc.state);
  return acc.state;
}

/**
 * 当前是否可能处于热身 / 死斗：
 * 最近 detectRespawn 记到的「复活」发生在**当前回合**、时间够新，
 * 而且**这个回合里复活了至少 2 次**。
 *
 * 最后那条是必须的：休闲模式「接手机器人」也会造成一次同回合内的 0 -> 100，
 * 只判一次的话正常回合会被误判成热身（真实日志里 26% 的帧中招，见 detectRespawn）。
 * 热身 / 死斗的特征是**反复**复活，所以要求 ≥2 次就能把两者分开。
 * 回合一推进，这个判断自动失效 —— 不需要额外清理。
 */
const RESPAWN_WINDOW_MS = 120000;
const RESPAWN_MIN_FOR_WARMUP = 2;

function looksLikeWarmup(acc, state) {
  if (!acc.respawnAt) return { hit: false };
  const round = (state.map && typeof state.map.round === 'number') ? state.map.round : null;
  if (round === null || round !== acc.respawnRound) return { hit: false };
  if ((acc.respawnCount[String(round)] || 0) < RESPAWN_MIN_FOR_WARMUP) return { hit: false };
  const age = Date.now() - acc.respawnAt;
  if (age > RESPAWN_WINDOW_MS) return { hit: false };
  return { hit: true, secondsAgo: Math.round(age / 1000) };
}

module.exports = {
  createAccumulator: createAccumulator,
  mergeFrame: mergeFrame,
  observeKills: observeKills,
  deepMergeInto: deepMergeInto,
  clearRoundTransients: clearRoundTransients,
  detectRespawn: detectRespawn,
  looksLikeWarmup: looksLikeWarmup
};
