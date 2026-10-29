/* 把一份 GSI 日志按「回合」铺开，用于人工/脚本对账 */
const fs = require('fs'), path = require('path');
const gsi = require('../lib/gsi.js');

const f = process.argv[2] || (function () {
  const d = path.join(__dirname, '..', 'logs');
  return path.join(d, fs.readdirSync(d).filter(x => x.endsWith('.jsonl')).sort().reverse()[0]);
})();

const acc = gsi.createAccumulator();
const rows = [];
let prev = null;

for (const L of fs.readFileSync(f, 'utf8').split('\n')) {
  if (!L.trim()) continue;
  let o; try { o = JSON.parse(L); } catch (e) { continue; }
  const p = o.payload; if (!p || !p.provider) continue;
  gsi.mergeFrame(acc, p);
  const st = acc.state;
  if (!st.map) continue;
  const key = (st.map.name || '?') + '#' + st.map.round;
  const live = st.round && st.round.phase !== 'freezetime';
  const money = st.player && st.player.state && st.player.state.money;
  const equip = st.player && st.player.state && st.player.state.equip_value;
  const kills = st.player && st.player.match_stats && st.player.match_stats.kills;
  let r = rows.find(x => x.key === key);
  if (!r) {
    r = { key, map: st.map.name, round: st.map.round, startMoney: money, minMoney: money,
          endMoney: money, startEquip: equip, killsAtStart: kills, minAfterLive: null,
          ct: st.map.team_ct.score, t: st.map.team_t.score, winner: null, plant: null,
          ctLoss: st.map.team_ct.consecutive_round_losses, tLoss: st.map.team_t.consecutive_round_losses,
          myTeam: st.player && st.player.team };
    rows.push(r);
  }
  for (const m of [money]) if (typeof m === 'number' && m < r.minMoney) r.minMoney = m;
  if (live && typeof money === 'number') {
    if (r.minAfterLive === null || money < r.minAfterLive) r.minAfterLive = money;
  }
  if (typeof money === 'number') r.endMoney = money;
  r.ct = st.map.team_ct.score; r.t = st.map.team_t.score;
  if (st.round && st.round.win_team) r.winner = st.round.win_team;
  if (st.round && st.round.bomb) r.plant = st.round.bomb;
}

console.log('日志:', path.basename(f), '| 回合数', rows.length, '\n');
console.log('地图        回合  我方  开局$   最低$  末$    击杀  比分(CT:T)  胜方  连败(CT/T)  炸弹');
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const k = (i + 1 < rows.length && rows[i + 1].killsAtStart !== undefined && r.killsAtStart !== undefined)
    ? (rows[i + 1].killsAtStart - r.killsAtStart) : null;
  console.log(
    String(r.map).padEnd(11) + String(r.round).padStart(4) +
    String(r.myTeam || '?').padStart(5) +
    String(r.startMoney).padStart(7) + String(r.minMoney).padStart(8) + String(r.endMoney).padStart(7) +
    String(k === null ? '?' : k).padStart(6) +
    ('  ' + r.ct + ':' + r.t).padEnd(12) +
    String(r.winner || '-').padStart(5) +
    ('  ' + r.ctLoss + '/' + r.tLoss).padEnd(12) +
    ' ' + (r.plant || '-')
  );
}
