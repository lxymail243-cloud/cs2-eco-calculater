'use strict';

/**
 * 重新生成 public/preview.html 里嵌进去的样例。
 *
 * 预览页那 6 个场景**不是手写的** —— 是把 tools/mock.js 的 payload 喂给真实引擎
 * （lib/economy.js 的 analyze）跑出来的结果直接嵌进 HTML，所以预览里看到的
 * 对手经济档位 / 结论 / 推理链，跟实际跑起来完全一致。
 *
 * 反过来说：引擎一改（改了推算口径、调了败方补偿阶梯），就必须重跑本脚本，
 * 否则预览页会停在旧结论上 —— 那比没有预览页还误导。
 *
 *   node tools/genpreview.js
 */

const fs = require('fs');
const path = require('path');
const { makePayload, SCENARIOS } = require('./mock');
const { analyze } = require('../lib/economy');

// 顺序 = 预览页里轮换的顺序。
// 第一个放 early 是有意的：只有开局前几回合的资金上界够低、能给出「确定」级结论，
// 放第一个才看得见这个工具最有价值的那句话。
// casual 紧跟在 early 后面，而且刻意和 early 是**同一个局面**：
// 同一回合、同样连败、对手都是输掉手枪局的 CT —— 唯一区别是模式。
// 两个挨着看，就能直接看出「休闲护甲白送 + 击杀奖励减半」把门槛挪到了哪。
const ORDER = ['early', 'casual', 'full', 'inferno', 'eco', 'retake', 'pistol0'];

/**
 * 造一份「本半场每回合开始前的比分」快照，让预览页也能展示对手经济推算。
 *
 * 不追求真实，只要求总数和场景给的比分对得上 —— 否则页面上会出现
 * 「比分 4:0 但对手 5 胜」这种自相矛盾的展示。
 * 铺法：先让 CT 把分拿完，再让 T 拿 —— 这样对手（通常我打 CT、对手是 T）
 * 会先连败，预览里就能看到「连败攒够了、要反扑」这类判断，
 * 比一排「满编」有信息量。
 */
function fakeRoundScore(payload) {
  const map = payload.map || {};
  const round = typeof map.round === 'number' ? map.round : 0;
  const ctScore = Number(map.team_ct && map.team_ct.score) || 0;
  const tScore = Number(map.team_t && map.team_t.score) || 0;
  const rs = {};
  let ct = 0;
  let t = 0;
  for (let r = 0; r <= round; r++) {
    rs[r] = { ct: ct, t: t };
    if (ct < ctScore) ct++;
    else if (t < tScore) t++;
    else ct++;
  }
  return rs;
}

const samples = ORDER.map(function (name) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error('tools/mock.js 里没有这个场景: ' + name);
  const payload = makePayload(sc);
  return analyze(payload, { roundScore: fakeRoundScore(payload) });
});

const file = path.join(__dirname, '..', 'public', 'preview.html');
let html = fs.readFileSync(file, 'utf8');

const re = /  var SAMPLES = \[[\s\S]*?\n  \];/;
if (!re.test(html)) throw new Error('preview.html 里找不到 SAMPLES 数组，格式可能被改过');

// JSON.stringify 的第 0 行是 '['，整体缩进 2 格后把它还原，
// 这样出来的排版和原来手写的一模一样（var SAMPLES = [ ... ];）
const json = JSON.stringify(samples, null, 2);
let indented = json.split('\n').map(function (l) { return '  ' + l; }).join('\n');
indented = indented.replace(/^ {2}\[/, '[');

const before = html.length;
html = html.replace(re, '  var SAMPLES = ' + indented + ';');
fs.writeFileSync(file, html);

// 回读校验：必须能重新解析出来，且每个样例都带上了对手经济字段
const back = fs.readFileSync(file, 'utf8');
const m = back.match(/  var SAMPLES = (\[[\s\S]*?\n  \]);/);
const parsed = JSON.parse(m[1]);

console.log('已重新生成 ' + path.basename(file));
console.log('  ' + before + ' -> ' + back.length + ' 字节');
console.log('  样例数: ' + parsed.length);
parsed.forEach(function (a, i) {
  const e = a.enemy || {};
  const tier = e.available ? (e.tierLabel || '?') : '(不可用)';
  console.log('  [' + i + '] ' + a.mapName + ' / ' + a.side +
    ' [' + (e.mode || '?') + ']' +
    '  ->  对手' + (e.foe || '?') + ' ' + tier +
    '（' + (e.conf || '-') + '）streak=' + e.streak +
    ' 上界=' + (typeof e.cashCeil === 'number' ? '$' + e.cashCeil : '-') +
    ' 长枪门槛=' + (e.costs ? '$' + e.costs.combat : '-') +
    ' 击杀收入=' + (e.killSource === 'measured'
      ? '实测$' + Math.round(e.killIncome)
      : '假设$' + Math.round(e.killIncome)) +
    ' 语音=' + JSON.stringify(e.say || ''));
});
