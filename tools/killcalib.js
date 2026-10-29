/**
 * 经济常数校准器
 * ==================================================================
 * 这个脚本回答一个问题：lib/enemy.js 里那些常数**到底对不对**。
 *
 * 做法是从 logs/ 里的真实对局反推，而不是抄文档：
 *
 *   1. 击杀奖励：找「同一帧里击杀数 +1 且金钱变多」的样本，
 *      按当时持有的武器分类，读出实际到账多少。
 *      —— 顺势就能量出「休闲 vs 竞技」那个倍数。
 *
 *   2. 起始资金 / 回合胜利：用「相邻两回合起始的资金之差 = 收入 − 花销」
 *      逐回合验算「自己能拿到的收入」，和 lib/enemy.js 的 MODES 表对账。
 *
 *   3. 击杀频率：按回合差分累计击杀数，看一个玩家每回合大概拿几个人头。
 *      这个数直接决定「人均每回合 ≤ 每杀平均奖励」这条上界有多松。
 *
 *   node tools/killcalib.js            用 logs/ 里最新的日志
 *   node tools/killcalib.js <文件>      指定日志文件
 */

const fs = require('fs');
const path = require('path');
const enemy = require('../lib/enemy');

/* ---------------------------------------------- 读日志 */

const logDir = path.join(__dirname, '..', 'logs');
let logFile = process.argv[2] || '';
if (!logFile) {
  let files = [];
  try { files = fs.readdirSync(logDir).filter(function (f) { return f.endsWith('.jsonl'); }).sort(); } catch (e) { files = []; }
  if (files.length) logFile = path.join(logDir, files[files.length - 1]);
}
if (!logFile || !fs.existsSync(logFile)) {
  console.log('找不到日志文件。先打一局，或者把文件路径作为参数传进来。');
  process.exit(0);
}

const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
const frames = [];
lines.forEach(function (l, i) {
  let o; try { o = JSON.parse(l); } catch (e) { return; }
  const p = o.payload || o;
  // 真实 GSI 帧每帧都带 provider；tools/mock.js 的测试帧带 _mock
  if (!p || p._mock || !p.provider) return;
  frames.push({ i: i, p: p });
});

console.log('');
console.log('日志 ' + path.basename(logFile) + '：真实帧 ' + frames.length + ' / 共 ' + lines.length + ' 行');
if (!frames.length) { console.log('没有真实帧，退出。'); process.exit(0); }

const modes = {};
frames.forEach(function (f) {
  const m = (f.p.map && f.p.map.mode) || '(未知)';
  modes[m] = (modes[m] || 0) + 1;
});
console.log('模式分布：' + Object.keys(modes).map(function (k) { return k + ' × ' + modes[k]; }).join('，'));

/* ---------------------------------------------- 1. 击杀奖励实测
 *
 * 样本判据：同一帧里 round_kills 增加了 1，且 money 增加了。
 * GSI 的 previously 段装的是「本帧被改动字段的旧值」，
 * 所以「旧钱 → 新钱」就是这一帧的收支净额。
 * 只取增量 0 < Δ ≤ 1200 的样本（更大的增量里混着回合奖金，不是纯击杀奖励）。
 */

const byWeapon = new Map();
const allDelta = new Map();
let samples = 0;
let unattributed = 0;

frames.forEach(function (f) {
  const prev = f.p.previously;
  const cur = f.p.player;
  if (!prev || !prev.player || !prev.player.state || !cur || !cur.state) return;
  const st = prev.player.state;
  if (typeof st.money !== 'number' || typeof cur.state.money !== 'number') return;
  if (typeof st.round_kills !== 'number' || typeof cur.state.round_kills !== 'number') return;

  const dk = cur.state.round_kills - st.round_kills;
  const dm = cur.state.money - st.money;
  if (dk !== 1 || dm <= 0 || dm > 1200) return;

  // 排除不可能产生击杀奖励的槽位。原版这一行是拿 guns[0] 当「杀人的那把枪」，
  // 结果几乎永远命中手枪槽（weapon_1），把所有样本都归到 pistol 上 —— 假结论。
  // 只有**恰好剩一把**时才敢归因，否则只统计金额、不归因武器。
  const guns = Object.keys(cur.weapons || {}).map(function (k) { return cur.weapons[k].name; })
    .filter(function (n) {
      return !/weapon_knife|weapon_c4|weapon_flashbang|weapon_smokegrenade|weapon_hegrenade|weapon_molotov|weapon_incgrenade|weapon_decoy|weapon_tagrenade|weapon_healthshot/.test(n);
    });

  if (guns.length === 1) {
    const cls = classify(guns[0]);
    if (!byWeapon.has(cls)) byWeapon.set(cls, []);
    byWeapon.get(cls).push(dm);
  } else {
    unattributed++;
  }
  allDelta.set(dm, (allDelta.get(dm) || 0) + 1);
  samples++;
});

/** 武器名 → 奖励档位（和 lib/enemy.js 的 KILL_REWARD 同键） */
function classify(name) {
  if (!name) return '(无枪)';
  const n = name.replace('weapon_', '');
  if (n.indexOf('awp') === 0) return 'awp';
  if (/^(ak47|m4a1|m4a1_silencer|aug|sg556|galilar|famas|ssg08|scar20|g3sg1)$/.test(n)) return 'rifle';
  if (/^(mac10|mp9|mp7|mp5sd|ump45|bizon)$/.test(n)) return 'smg';
  if (n === 'p90') return 'p90';
  if (/^(nova|mag7|sawedoff)$/.test(n)) return 'shotgun';
  if (n === 'xm1014') return 'xm1014';
  if (/^(negev|m249)$/.test(n)) return 'mg';
  if (/^(hkp2000|usp_silencer|glock|p250|fiveseven|tec9|elite|deagle|revolver)$/.test(n)) return 'pistol';
  if (n === 'cz75a') return 'cz75';
  return n;
}

console.log('');
console.log('=== 1. 击杀奖励实测（单杀帧里金钱的增量）===');
console.log('可判定样本 ' + samples + ' 个' +
  (unattributed ? '（其中 ' + unattributed + ' 个身上有多把枪、无法归因到具体武器，只进金额统计）' : ''));
if (!samples) {
  console.log('  没有样本（可能是这局数据里缺 previously 段）。');
} else {
  const rows = [];
  byWeapon.forEach(function (arr, cls) {
    const tally = {};
    arr.forEach(function (v) { tally[v] = (tally[v] || 0) + 1; });
    const top = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0];
    rows.push({ cls: cls, n: arr.length, val: Number(top), tally: tally });
  });
  rows.sort(function (a, b) { return b.n - a.n; });

  if (rows.length) {
    console.log('  ' + '武器档位'.padEnd(12) + '样本'.padEnd(6) + '实测取值'.padEnd(12) + 'MODES 原值'.padEnd(14) + '推出倍数');
    rows.forEach(function (r) {
      const base = enemy.KILL_REWARD[r.cls];
      const mul = base ? (r.val / base) : null;
      console.log('  ' + r.cls.padEnd(12) +
        String(r.n).padEnd(6) +
        ('$' + r.val).padEnd(12) +
        (base ? ('$' + base) : '—').padEnd(14) +
        (mul !== null ? '×' + mul.toFixed(2) : '—'));
    });
  } else {
    console.log('  没有一个样本能唯一归因到某把枪（都是多把枪在手）。');
  }

  // 用金额分布本身来定倍数 —— 比按武器归因结实，因为它不依赖「谁开的枪」。
  // 休闲模式所有档位都减半，所以取「出现最多的那个金额」和竞技最小档位比。
  const ranked = [...allDelta.entries()].sort(function (a, b) { return b[1] - a[1]; });
  console.log('');
  console.log('  单杀增量的金额分布（次数降序）：' +
    ranked.slice(0, 8).map(function (e) { return '$' + e[0] + '×' + e[1]; }).join('  '));

  const topVal = ranked.length ? ranked[0][0] : null;
  if (topVal !== null) {
    const base = enemy.KILL_REWARD.rifle;
    const mul = topVal / base;
    console.log('');
    console.log('  出现最多的单杀金额 $' + topVal + '，对照 MODES 里的「步枪/手枪」原值 $' + base +
      ' → 倍数 ×' + mul.toFixed(2));
    console.log('  → ' + (Math.abs(mul - 0.5) < 0.06
      ? '正好是「休闲模式击杀奖励减半」，MODES 的 KILL_MUL = 0.5 对得上。'
      : '⚠ 和 0.5 差得比较远，需要复核 MODES 表。'));
  }
}

/* ---------------------------------------------- 2. 自己的资金曲线反推
 *
 * 「回合起点资金之差 = 这一回合拿到的收入 − 这一回合花掉的钱」。
 * 收入 = 基础 + 胜负奖金 + 击杀奖励；花销未知，所以只能单向看到「至少拿了多少」。
 * 这里打印出来，人工对账 MODES 表。
 */

const provIds = new Set();
frames.forEach(function (f) { provIds.add(f.p.provider.steamid); });

// 原版这里写的是 Array.prototype.slice.call(provIds)[0] —— Set 没有 length，
// slice 出来永远是空数组，selfId 变成 undefined，于是整段「共 0 个回合起点」。
const provIdsArr = [...provIds];
const selfId = provIdsArr.length === 1 ? provIdsArr[0] : null;

const seenRound = new Set();
const atRoundStart = [];
frames.forEach(function (f) {
  const pl = f.p.player;
  const r = f.p.map && f.p.map.round;
  if (!pl || (selfId && pl.steamid !== selfId) || typeof r !== 'number') return;
  if (!pl.state || typeof pl.state.money !== 'number') return;
  const key = f.p.map.name + '#' + r;
  if (seenRound.has(key)) return;
  seenRound.add(key);
  atRoundStart.push({
    i: f.i, map: f.p.map.name, round: r, money: pl.state.money,
    kills: pl.match_stats ? pl.match_stats.kills : null
  });
});

console.log('');
console.log('=== 2. 我自己的资金曲线（回合起点快照）===');
console.log('共 ' + atRoundStart.length + ' 个回合起点。每行：本回合收入上界（含未花出去的）。');
const plan = [];
atRoundStart.forEach(function (rec, k) {
  const prev = atRoundStart[k - 1];
  if (!prev) return;
  if (prev.map !== rec.map) { plan.push({ gap: true, rec: rec, prev: prev }); return; }
  const delta = rec.money - prev.money;
  const kills = (rec.kills !== null && prev.kills !== null && rec.kills >= prev.kills)
    ? rec.kills - prev.kills : null;
  plan.push({ prev: prev, rec: rec, delta: delta, kills: kills });
});
plan.slice(0, 20).forEach(function (p) {
  if (p.gap) {
    console.log('  换图 ' + p.prev.map + ' → ' + p.rec.map + '（资金曲线在此断开）');
    return;
  }
  // 反推：如果这一回合赢了，收入 = 基础 + 胜利奖金 + 击杀×奖励
  console.log('  ' + p.prev.map.padEnd(12) +
    '回合 ' + String(p.prev.round).padStart(2) + '→' + String(p.rec.round).padStart(2) +
    '  ' + String(p.prev.money).padStart(6) + ' → ' + String(p.rec.money).padStart(6) +
    '  Δ' + (p.delta >= 0 ? '+' : '') + String(p.delta).padStart(6) +
    (p.kills === null ? '' : '  上回合击杀 ' + p.kills));
});
console.log('');
console.log('  对账提示：若某回合是「赢」，则 Δ + 花销 = 基础 $' + enemy.MODES.competitive.PER_ROUND +
  ' + 胜利奖金（竞技 $' + enemy.MODES.competitive.WIN + ' / 休闲 $' + enemy.MODES.casual.WIN +
  '）+ 击杀数 × 每杀奖励（竞技 $' + enemy.meanKillReward('competitive') +
  ' / 休闲 $' + enemy.meanKillReward('casual') + '）。');

/* ---------------------------------------------- 3. 击杀频率 */

console.log('');
console.log('=== 3. 人均每回合击杀数（决定「每次击杀上界」松不松）===');
const firstOfRound = new Map();
frames.forEach(function (f) {
  const pl = f.p.player;
  const r = f.p.map && f.p.map.round;
  if (!pl || !pl.match_stats || typeof pl.match_stats.kills !== 'number') return;
  if (typeof r !== 'number') return;
  const id = pl.steamid || '?';
  const k = id + '|' + f.p.map.name + '|' + r;
  if (firstOfRound.has(k)) return;
  firstOfRound.set(k, { id: id, name: pl.name, map: f.p.map.name, round: r, kills: pl.match_stats.kills });
});
const perId = new Map();
firstOfRound.forEach(function (v) { if (!perId.has(v.id)) perId.set(v.id, []); perId.get(v.id).push(v); });

let totK = 0, totR = 0, ids = 0;
const detail = [];
perId.forEach(function (arr, id) {
  arr.sort(function (a, b) { return a.round - b.round; });
  let dk = 0, dr = 0, prev = null;
  arr.forEach(function (s) {
    if (prev && prev.map === s.map && s.round > prev.round && s.kills >= prev.kills) {
      dk += s.kills - prev.kills;
      dr += s.round - prev.round;
    }
    prev = s;
  });
  if (dr > 0) { totK += dk; totR += dr; ids++; detail.push({ name: arr[0].name || id, dk: dk, dr: dr }); }
});
if (ids) {
  console.log('  覆盖 ' + ids + ' 名玩家、' + totR + ' 个回合区间，共 ' + totK + ' 个人头。');
  console.log('  人均每回合击杀数：' + (totK / totR).toFixed(2));
  detail.sort(function (a, b) { return (b.dk / b.dr) - (a.dk / a.dr); }).slice(0, 8).forEach(function (d) {
    console.log('    · ' + String(d.name).padEnd(16) + d.dr + ' 回合 ' + String(d.dk).padStart(3) + ' 杀  = ' +
      (d.dk / d.dr).toFixed(2) + ' 杀/回合');
  });
  console.log('');
  console.log('  ⚠ 注意样本来自' + (modes.casual ? '休闲局（10v10，人头比竞技多）' : '这局') +
    '，不能直接当竞技局的击杀频率用。');
  console.log('  竞技 5v5 的经验值约 0.6~0.8 杀/回合/人 —— 所以那里用「人均每回合 ≤ 每杀奖励」做上界是够紧的。');
} else {
  console.log('  样本不足。');
}

/* ---------------------------------------------- 4. 当前生效的常数 */

console.log('');
console.log('=== 4. lib/enemy.js 现在用的常数（对账用）===');
['competitive', 'casual'].forEach(function (m) {
  const e = enemy.MODES[m];
  console.log('  ' + m.padEnd(12) +
    '起始 $' + String(e.START).padEnd(6) +
    '胜利 $' + String(e.WIN).padEnd(6) +
    '上限 $' + String(e.MAX).padEnd(7) +
    '击杀 ×' + e.KILL_MUL +
    (e.FREE_ARMOR ? '  护甲白送' : '') +
    '  每杀奖励 $' + enemy.meanKillReward(m) +
    '  每回合击杀上界 $' + enemy.killCeilPerRound(m));
});
console.log('');
