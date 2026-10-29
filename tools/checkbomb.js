'use strict';

/**
 * 回放真实日志，逐帧跑累积器 + 分析引擎，
 * 打印「每个回合是否报告了『包已下』」—— 用来验证炸弹状态不会跨回合残留。
 *
 *   node tools/checkbomb.js
 *
 * 只回放**游戏真的推过来的帧**：tools/mock.js 编的场景带 _mock 标记，
 * 手搓的帧缺 provider（真实 GSI 每一帧都带）—— 这两类会把「有没有残留」的
 * 结论搅浑，一律跳过。
 */

const fs = require('fs');
const path = require('path');
const { analyze } = require('../lib/economy');
const { createAccumulator, mergeFrame, looksLikeWarmup } = require('../lib/gsi');

const logDir = path.join(__dirname, '..', 'logs');
const files = fs.readdirSync(logDir).filter(function (f) { return f.endsWith('.jsonl'); }).sort();
if (!files.length) { console.log('没有日志文件'); process.exit(1); }

const file = path.join(logDir, files[files.length - 1]);
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
console.log('日志: ' + files[files.length - 1] + '（' + lines.length + ' 帧）');
console.log('');

const acc = createAccumulator();
const byRound = new Map();
let skipped = 0;

lines.forEach(function (l, i) {
  let o;
  try { o = JSON.parse(l); } catch (e) { return; }
  const frame = o.payload || o;
  if (!frame || frame._mock || !frame.provider) { skipped++; return; }

  const merged = mergeFrame(acc, frame);
  let r;
  try {
    const warm = looksLikeWarmup(acc, merged);
    r = analyze(merged, {
      respawnRecently: warm.hit,
      respawnAgo: warm.secondsAgo
    });
  } catch (e) { return; }

  const key = String(r.roundIndex);
  const phase = r.phase || '-';
  if (!byRound.has(key)) byRound.set(key, { phase: {}, planted: 0, frames: 0 });
  const rec = byRound.get(key);
  rec.frames++;
  rec.phase[phase] = (rec.phase[phase] || 0) + 1;
  if (r.bombPlanted) rec.planted++;
});

console.log('回合  帧数  阶段分布                        报告「包已下」的帧数');
const keys = Array.from(byRound.keys()).sort(function (a, b) { return Number(a) - Number(b); });
let bad = 0;
keys.forEach(function (k) {
  const rec = byRound.get(k);
  const ph = Object.keys(rec.phase).map(function (p) { return p + '×' + rec.phase[p]; }).join(' ');
  const flag = rec.planted > 0 ? ('  <== ' + rec.planted + ' 帧') : '';
  if (rec.planted > 0 && !rec.phase.live) bad++;
  console.log(
    String(k).padStart(3) + '   ' +
    String(rec.frames).padStart(4) + '  ' +
    ph.padEnd(30) + '  ' +
    String(rec.planted).padStart(4) + flag
  );
});

console.log('');
console.log('累积器统计: 帧数=' + acc.frames + ' 重置=' + acc.resets +
  ' 回合切换清理=' + (acc.roundClears || 0) +
  (skipped ? '（跳过非游戏帧 ' + skipped + ' 帧）' : ''));
console.log('');
if (bad) {
  console.log('[不通过] 有 ' + bad + ' 个「没有 live 帧」的回合报告了「包已下」—— 说明状态在跨回合残留');
} else {
  console.log('[通过] 只有在真正有 live 帧的回合才报告「包已下」');
}
