/**
 * GSI 字段清单扫描器 —— 回答「一局对局里到底能抓到什么」。
 *
 *   node tools/fieldscan.js [日志文件]
 *
 * 做三件事：
 *   1. 把真实帧（带 provider、不带 _mock）的每个叶子路径摊平，按 GSI 分量分组计数。
 *      动态键（武器名 / 玩家名 / 手雷名）归一化成 <weapon> <name> <grenade> 占位。
 *   2. 统计「累积器合并之后」的状态里有哪些路径 —— 这才是引擎真正能读到的东西，
 *      因为 GSI 是增量推送，单帧少一半分量是正常的。
 *   3. 列出「配置里点名要了、真实帧里却一帧都没出现」的路径，以及只在特定视角才下发的路径。
 *
 * 判定「真实帧」的判据：带 provider（appid 730）。真实 CS2 每一帧都有；
 * 手搓的测试 payload 没有，tools/mock.js 推的帧带 _mock。
 */

const fs = require('fs');
const path = require('path');
const { createAccumulator, mergeFrame } = require('../lib/gsi');

const logDir = path.join(__dirname, '..', 'logs');
let file = process.argv[2];
if (!file) {
  const files = fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort();
  if (!files.length) { console.log('logs/ 里没有 .jsonl'); process.exit(1); }
  file = path.join(logDir, files[files.length - 1]);
}
const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
console.log('日志: ' + path.basename(file) + ' —— ' + lines.length + ' 行');
console.log('');

/* ---------------------------------------------------------------- 归一化 */

// 这些父节点下的一级键是动态的（武器名 / 玩家名）
const DYN = {
  'player.weapons': '<weapon>',
  'allplayers': '<steamid>',
  'allplayers.<steamid>.weapons': '<weapon>',
  'allgrenades': '<grenade>'
};

function normKey(parentPath, key) {
  if (DYN[parentPath]) return DYN[parentPath];
  // 手雷块：allgrenades.<id> 下也是动态键
  if (/^allgrenades\.<grenade>$/.test(parentPath)) return '<n>';
  return key;
}

function walk(obj, prefix, out) {
  if (obj === null || typeof obj !== 'object') { out.push(prefix); return; }
  if (Array.isArray(obj)) {
    if (!obj.length) { out.push(prefix + '[]'); return; }
    obj.forEach(v => walk(v, prefix + '[]', out));
    return;
  }
  const keys = Object.keys(obj);
  if (!keys.length) { out.push(prefix + '{}'); return; }
  keys.forEach(k => walk(obj[k], prefix ? prefix + '.' + normKey(prefix, k) : k, out));
}

/* -------------------------------------------------- 1. 原始帧的叶子路径 */
const frames = [];
let mock = 0, bad = 0, noProvider = 0;
const pathCount = new Map();   // path -> 出现帧数
const pathSample = new Map();  // path -> 第一个非空样例值

for (const L of lines) {
  let o; try { o = JSON.parse(L); } catch (e) { bad++; continue; }
  const p = o.payload || o;
  if (p._mock) { mock++; continue; }
  if (!p.provider) { noProvider++; continue; }
  frames.push(p);
  const leaves = [];
  walk(p, '', leaves);
  const seen = new Set(leaves);
  for (const lf of seen) {
    pathCount.set(lf, (pathCount.get(lf) || 0) + 1);
    if (!pathSample.has(lf)) {
      // 找一个非空样例
      let cur = p;
      for (const seg of lf.split('.')) {
        if (cur === null || cur === undefined) break;
        if (seg.endsWith('[]')) { cur = Array.isArray(cur) ? cur[0] : undefined; continue; }
        cur = cur[seg];
      }
      if (cur !== undefined && cur !== null && cur !== '') pathSample.set(lf, cur);
    }
  }
}

console.log('真实帧 ' + frames.length + ' 个' +
  (mock ? '（剔掉 ' + mock + ' 个 _mock 测试帧）' : '') +
  (noProvider ? '（剔掉 ' + noProvider + ' 个缺 provider 的手搓帧）' : '') +
  (bad ? '（' + bad + ' 行解析失败）' : ''));
console.log('');

/* --------------------------------------------------- 2. 合并后的最终状态 */
const acc = createAccumulator();
const mergedLeaves = new Set();
const mergedAt = [];   // 采样：每 1/4 位置看一眼合并态
for (let i = 0; i < frames.length; i++) {
  const m = mergeFrame(acc, frames[i]);
  if (i % Math.max(1, Math.floor(frames.length / 4)) === 0) {
    const lvs = [];
    walk(m.state || m, '', lvs);
    mergedAt.push({ i, n: new Set(lvs).size, leaves: new Set(lvs) });
  }
}
const finalLeaves = [];
walk(acc.state || acc, '', finalLeaves);
finalLeaves.forEach(l => mergedLeaves.add(l));

/* ------------------------------------------------------------- 3. 分组输出 */
// 按顶层分量归类
const GROUPS = [
  ['provider', '游戏本体标识'],
  ['map', '地图与比分'],
  ['round', '当前回合状态'],
  ['phase_countdowns', '阶段倒计时'],
  ['player', '我自己（你控制的那个）'],
  ['allplayers', '全场十个人'],
  ['allgrenades', '场上所有投掷物'],
  ['bomb', '炸弹（顶层块）'],
  ['auth', '观战者身份'],
  ['previously', '本帧被改动字段的旧值（GSI 自己标的）'],
  ['added', '本帧新出现的键（GSI 自己标的）']
];

function topOf(p) { return p.split('.')[0].split('[')[0]; }

const buckets = new Map();
for (const p of pathCount.keys()) {
  const t = topOf(p);
  if (!buckets.has(t)) buckets.set(t, []);
  buckets.get(t).push(p);
}
for (const p of mergedLeaves) {
  const t = topOf(p);
  if (!buckets.has(t)) buckets.set(t, []);
  if (buckets.get(t).indexOf(p) === -1) buckets.get(t).push(p);
}

function fmtVal(v) {
  if (typeof v === 'string') return JSON.stringify(v.length > 28 ? v.slice(0, 28) + '…' : v);
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  return typeof v;
}

for (const [key, label] of GROUPS) {
  const ps = buckets.get(key);
  if (!ps || !ps.length) continue;
  ps.sort();
  console.log('── ' + key + '  ' + label + ' ' + '─'.repeat(Math.max(2, 60 - key.length)));
  for (const p of ps) {
    const c = pathCount.get(p) || 0;
    const inMerged = mergedLeaves.has(p);
    const pct = frames.length ? Math.round(c / frames.length * 100) : 0;
    const tag = inMerged ? '✓' : '·';
    const sample = pathSample.has(p) ? ' = ' + fmtVal(pathSample.get(p)) : '';
    console.log('  ' + tag + ' ' + p.padEnd(46) + String(c).padStart(5) + ' 帧 ' +
      String(pct).padStart(3) + '%' + sample);
  }
  console.log('');
}

/* ------------------------------------------- 4. 配置要了但没有出现的路径 */
const MISSING = [
  ['phase_countdowns', '阶段倒计时（本机游玩时不下发；用 round.phase 代替）'],
  ['map.round_wins', 'CS:GO 时代的每回合获胜原因表，CS2 已删'],
  ['map.mid', '地图/对阵标识，CS2 未下发'],
  ['allplayers.*.position', '玩家坐标（仅观战/回放视角下发）'],
  ['allplayers.*.forward', '玩家朝向（仅观战/回放视角下发）'],
  ['allplayers', '全场十个人（仅观战/回放视角下发）'],
  ['bomb', '顶层炸弹块（CS2 用 round.bomb 代替）'],
  ['allgrenades', '投掷物块（仅观战/回放视角下发）'],
  ['round.bomb', '本回合炸弹状态，只在变化时推一次'],
  ['round.win_team', '本回合获胜方，只在变化时推一次']
];
console.log('── 「配置点了名」但真实帧里的出现情况 ' + '─'.repeat(28));
for (const [p, note] of MISSING) {
  // 模糊匹配：把 * 当通配
  const re = new RegExp('^' + p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+') + '$');
  let c = 0;
  for (const k of pathCount.keys()) if (re.test(k)) c++;
  let inMerged = 0;
  for (const k of mergedLeaves) if (re.test(k)) inMerged++;
  const flag = (c || inMerged) ? '出现' : '从未';
  console.log('  ' + flag + ' ' + p.padEnd(30) + String(c).padStart(5) + ' 帧  —— ' + note);
}
console.log('');

/* ------------------------------------------------------- 5. 合并态演变 */
console.log('── 合并后状态的字段数演变（GSI 是增量推送，必须累积） ' + '─'.repeat(14));
for (const s of mergedAt) {
  console.log('  第 ' + String(s.i).padStart(5) + ' 帧之后：' + s.n + ' 个叶子路径');
}
console.log('  最终：' + mergedLeaves.size + ' 个叶子路径');
console.log('');
console.log('图例：✓ = 合并后仍在（引擎读得到）  · = 只在某些帧的原始增量里出现');

/* --------------------------------------------- 6. previously / added 语义 */
const prevFrames = frames.filter(f => f.previously).length;
const addedFrames = frames.filter(f => f.added).length;

/** 数一条路径在 previously 里出现过多少次（= 该字段变动过多少次） */
function prevPathCount(target) {
  return frames.filter(function (f) {
    if (!f.previously) return false;
    let cur = f.previously;
    for (const seg of target.split('.')) {
      if (cur === null || typeof cur !== 'object') return false;
      cur = cur[seg];
    }
    return cur !== undefined;
  }).length;
}
console.log('');
console.log('── GSI 的增量机制（Valve 文档：这两个键出现 = 服务器回了 2xx） ' + '─'.repeat(8));
console.log('  previously  ' + String(prevFrames).padStart(5) + ' 帧  ' +
  Math.round(prevFrames / frames.length * 100) + '%  —— 本帧被改动字段的「改之前是什么」');
console.log('  added       ' + String(addedFrames).padStart(5) + ' 帧  ' +
  Math.round(addedFrames / frames.length * 100) + '%  —— 本帧新冒出来的键');
console.log('');
if (!prevFrames && !addedFrames) {
  console.log('  ⚠ 两个键都不出现 —— 按 Valve 文档，这说明游戏从没收到过 2xx 响应，');
  console.log('    即 POST 的目标地址根本没答话，而不是「没有变化」。');
} else {
  console.log('  两个键都在 → 服务端每次都及时回了 2xx，接收链路是健康的。');
  console.log('  用途：previously 能告诉你「这个值刚刚从 X 变成 Y」，比轮询当前值精确 ——');
  console.log('  例：player.state.money 变了 ' + (prevPathCount('player.state.money')) + ' 次，' +
    '每次都能拿到变动前后的差额。');
}
