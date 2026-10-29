/* 竞技/休闲经济常数对账：只用「provider.steamid === player.steamid」的帧，
   因为 5E 竞技里死亡镜头会把 player 块切成别人（实测 14 个身份 / 149 次切换）。
   每回合拆成：开局钱 → 买完后的最低点 → 回合结束钱，据此反推「本回合实发收入」。 */
const fs = require('fs'), path = require('path');
const gsi = require('../lib/gsi.js');

const f = process.argv[2] || (function () {
  const d = path.join(__dirname, '..', 'logs');
  return path.join(d, fs.readdirSync(d).filter(x => x.endsWith('.jsonl')).sort().reverse()[0]);
})();

const LADDER = [1400, 1900, 2400, 2900, 3400];
const acc = gsi.createAccumulator();
const rounds = [];          // 按出现顺序
let mySteamid = null;
let cur = null;
let identityFrames = 0, otherFrames = 0;

function keyOf(map, r) { return map + '#' + r; }

for (const L of fs.readFileSync(f, 'utf8').split('\n')) {
  if (!L.trim()) continue;
  let o; try { o = JSON.parse(L); } catch (e) { continue; }
  const p = o.payload; if (!p || !p.provider) continue;
  if (!mySteamid) mySteamid = p.provider.steamid;

  const mine = !!(p.player && p.player.steamid === mySteamid);
  gsi.mergeFrame(acc, p);
  const st = acc.state, m = st.map;
  if (!m || !m.name || typeof m.round !== 'number') continue;

  const k = keyOf(m.name, m.round);
  let r = rounds.length && rounds[rounds.length - 1].key === k ? rounds[rounds.length - 1] : null;
  if (!r) {
    r = { key: k, map: m.name, round: m.round, startMoney: null, minMoney: null, endMoney: null,
          killsAtStart: null, killsEnd: 0, ct: m.team_ct.score, tt: m.team_t.score,
          winner: null, loss: { CT: m.team_ct.consecutive_round_losses, T: m.team_t.consecutive_round_losses },
          myTeam: null, plant: false, myFrames: 0, otherFrames: 0 };
    rounds.push(r);
  }
  if (!mine) { r.otherFrames++; otherFrames++; continue; }
  identityFrames++; r.myFrames++;
  const ps = p.player.state || {}, ms = p.player.match_stats || {};
  if (typeof ps.money !== 'number') continue;
  if (r.startMoney === null) {
    r.startMoney = ps.money; r.minMoney = ps.money;
    r.killsAtStart = typeof ms.kills === 'number' ? ms.kills : null;
    r.myTeam = p.player.team || r.myTeam;
  }
  if (ps.money < r.minMoney) r.minMoney = ps.money;
  r.endMoney = ps.money;
  if (p.team) r.myTeam = p.team;
  if (p.map && p.map.team_ct) { r.ct = p.map.team_ct.score; r.tt = p.map.team_t.score; }
  if (p.map && p.map.team_ct) r.loss = { CT: p.map.team_ct.consecutive_round_losses, T: p.map.team_t.consecutive_round_losses };
  if (p.round && p.round.win_team) r.winner = p.round.win_team;
  if (p.round && p.round.bomb && p.round.bomb !== '') r.plant = true;
  if (typeof ms.kills === 'number' && r.killsAtStart !== null) {
    const d = ms.kills - r.killsAtStart;
    if (d >= 0 && d >= r.killsEnd) r.killsEnd = d;
  }
}

/* ── 打印 ─────────────────────────────────────────────── */
console.log('日志 ' + path.basename(f) + '：我自己的帧 ' + identityFrames + ' / 别人的帧 ' + otherFrames);
console.log('（player 块只有 ' + (100 * identityFrames / (identityFrames + otherFrames)).toFixed(0) + '% 的时间是你自己）\n');
console.log('地图        回合  我方  开局$    买完$   击杀  实发收入   拆解');
console.log('─'.repeat(96));

const stats = { win: [], loss: [] };

function modeOf(map) { return map === 'de_dust2' || map === 'de_ancient' ? 'competitive' : 'casual'; }

for (let i = 0; i < rounds.length; i++) {
  const r = rounds[i], n = rounds[i + 1];
  if (r.startMoney === null) continue;
  const nm = n && n.startMoney !== null && n.map === r.map ? n.startMoney : null;
  const income = nm !== null ? nm - r.minMoney : null;
  let decomp = '';
  if (income !== null) {
    const kills = r.killsEnd;
    const won = r.winner && r.myTeam && r.winner === r.myTeam;
    const lost = r.winner && r.myTeam && r.winner !== r.myTeam;
    const lossN = r.myTeam === 'CT' ? r.loss.CT : r.loss.T;
    const bonus = won ? 3250 : (lost ? (LADDER[Math.min(lossN, 5) - 1] || 3400) : null);
    const expect = bonus !== null ? bonus + kills * 300 : null;
    decomp = (won ? '胜 +3250' : (lost ? '负(连败' + lossN + ') +' + bonus : '?')) + ' + ' + kills + '杀×300 = ' + expect;
    if (expect !== null) (won ? stats.win : stats.loss).push({ income, expect, kills });
  }
  console.log(
    String(r.map).padEnd(11) + String(r.round).padStart(4) +
    String(r.myTeam || '?').padStart(5) +
    String(r.startMoney).padStart(8) + String(r.minMoney).padStart(9) +
    String(r.killsEnd).padStart(6) +
    String(income === null ? '-' : (income >= 0 ? '+' : '') + income).padStart(11) +
    '   ' + decomp
  );
}
