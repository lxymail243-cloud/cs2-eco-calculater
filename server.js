'use strict';

/**
 * CS2 Buy Helper —— 本地 GSI 接收器
 *
 * 只监听 127.0.0.1，不需要管理员权限，不接触游戏进程，不读写游戏内存。
 * 接收 CS2 通过官方 Game State Integration 推送的 JSON，推算对手经济，
 * 用 SSE 推给覆盖层页面，同时把原始 payload 追加写入 logs/ 供事后校准。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyze } = require('./lib/economy');
const { createAccumulator, mergeFrame, looksLikeWarmup } = require('./lib/gsi');

const PORT = Number(process.env.PORT) || 31982;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const LOG_DIR = process.env.CS2BH_LOG_DIR
  ? path.resolve(process.env.CS2BH_LOG_DIR)
  : path.join(ROOT, 'logs');
const MAX_BODY = 8 * 1024 * 1024;

/* ------------------------------------------------------------------
 * 日志留存策略
 *
 * 日志里存的是**完整的比赛原始数据**：每一帧的双方比分、你自己的资金曲线、
 * 装备、steamid。它只在「事后校准」时有用（比如验证 map.round 是 0 基、
 * 反推经济常数），没有任何理由长期躺在磁盘上。
 *
 * 所以默认行为是「用完就清」：
 *   · 空闲 5 分钟（既没有新帧、也没有新回合推进）→ 把 logs/ 里的 jsonl 删干净
 *     用「有没有新回合」而不是只看「有没有退出游戏」，
 *     是因为你可能只是去接杯水，也可能切到桌面看别的 —— 用回合推进最贴合实际节奏。
 *   · 启动时先清掉 7 天前的残留，避免旧文件一直堆着。
 *     （这条原来默认「只留今天的」，等于「重启一次服务就删掉昨天的日志」——
 *       2026-10-13 真的因为这个丢了一份数据，所以放宽到 7 天。）
 *
 * 想改就设环境变量：
 *   CS2BH_LOG=0              完全不写日志（也就不用清了）
 *   CS2BH_LOG_IDLE_MIN=15    空闲 15 分钟才清
 *   CS2BH_LOG_IDLE_MIN=0      关掉自动清理，日志一直留着
 *   CS2BH_LOG_KEEP_DAYS=30   启动时只清 30 天前的（默认 7 = 留最近 7 天；0 = 只留今天的）
 *
 * 注意：日志记的是原始帧，selftest 的「真实日志回放」那一组会用到它。
 * 日志被清掉之后那一组会自动跳过，不影响其他校验。
 * ------------------------------------------------------------------ */
function envInt(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

const LOG_ENABLED = process.env.CS2BH_LOG !== '0';
const LOG_IDLE_MIN = envInt('CS2BH_LOG_IDLE_MIN', 5);   // 0 = 不自动清
const LOG_KEEP_DAYS = envInt('CS2BH_LOG_KEEP_DAYS', 7); // 默认留最近 7 天；0 = 只留今天的
const LOG_IDLE_MS = LOG_IDLE_MIN * 60000;
const LOG_SWEEP_MS = envInt('CS2BH_LOG_SWEEP_MS', 30000) || 30000;  // 每 30 秒巡一次

fs.mkdirSync(LOG_DIR, { recursive: true });

let latest = null;
let latestRaw = null;
let lastSignature = '';
let stats = { payloads: 0, lastAt: 0, parseErrors: 0, startedAt: Date.now(), deltas: 0, resets: 0 };

// GSI 只推变化分量，累积成完整状态再分析（原因见 lib/gsi.js 顶部注释）
const acc = createAccumulator();

/*
 * 这里原来有一段「主武器记忆」：按阵营记住最后见过的主武器，
 * 用来判断你是不是队伍里的主狙（拿 AWP 阵亡后仍然建议重起狙）。
 * 它只服务于买枪建议，买枪建议移除后就没有消费者了，整块拆掉。
 * lib/economy.js 的 analyze() 也不再读 ctx.lastPrimary。
 */

const clients = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function todayLogPath() {
  const d = new Date();
  const key = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, 'gsi-' + key + '.jsonl');
}

// 日志活跃度：判断「该不该清」就靠这两个时间戳。
// 用两个而不是一个，是因为需求里说的是「没有新回合」——
// 只有「既没有新帧、又没有新回合」才算真的离开了对局。
let lastFrameAt = 0;      // 最后一帧到达的时间
let lastRoundAt = 0;      // 最后一次回合推进的时间
let lastSeenRound = null;
const logStats = { purges: 0, lastPurgeAt: 0, lastPurgeReason: '', deletedFiles: 0 };

function appendLog(payload) {
  if (!LOG_ENABLED) return;
  const line = JSON.stringify({ recvAt: Date.now(), payload: payload }) + '\n';
  fs.appendFile(todayLogPath(), line, function () {});
}

/** 清空 logs/ 下所有 jsonl。文件被占用（比如你没关 debug 页）时跳过，下一轮再清 */
function purgeLogFiles(reason) {
  let names = [];
  try {
    names = fs.readdirSync(LOG_DIR).filter(function (f) { return f.endsWith('.jsonl'); });
  } catch (e) {
    return [];
  }
  const removed = [];
  names.forEach(function (f) {
    try {
      fs.unlinkSync(path.join(LOG_DIR, f));
      removed.push(f);
    } catch (e) { /* 下一轮再试 */ }
  });
  if (removed.length) {
    logStats.purges++;
    logStats.lastPurgeAt = Date.now();
    logStats.lastPurgeReason = reason;
    logStats.deletedFiles += removed.length;
    console.log('  [日志] 已清理 ' + removed.length + ' 个文件（' + reason + '）：' + removed.join('、'));
  }
  return removed;
}

/** 启动时清掉上一次的残留，别让旧对局数据跨进程留着 */
function purgeStaleLogsOnBoot() {
  if (!LOG_ENABLED) return;
  const today = todayLogPath();
  let names = [];
  try {
    names = fs.readdirSync(LOG_DIR).filter(function (f) { return f.endsWith('.jsonl'); });
  } catch (e) {
    return;
  }
  const removed = [];
  names.forEach(function (f) {
    const full = path.join(LOG_DIR, f);
    let kill = false;
    if (LOG_KEEP_DAYS <= 0) {
      kill = (full !== today);
    } else {
      try {
        kill = (Date.now() - fs.statSync(full).mtimeMs) > LOG_KEEP_DAYS * 86400000;
      } catch (e) { kill = false; }
    }
    if (kill) {
      try { fs.unlinkSync(full); removed.push(f); } catch (e) { /* 忽略 */ }
    }
  });
  if (removed.length) {
    console.log('  [日志] 启动清理：删掉 ' + removed.length + ' 个旧日志（' + removed.join('、') + '）');
  }
}

/**
 * 空闲巡检。
 * 触发条件：距最后一帧 >= 阈值 **且** 距最后一次回合推进 >= 阈值。
 * 已经清过就不再重复清 —— 等下一帧进来，时间戳刷新，计时重来。
 */
function startLogJanitor() {
  if (!LOG_ENABLED || LOG_IDLE_MIN <= 0) return;
  const timer = setInterval(function () {
    const ref = lastFrameAt;
    if (!ref) return;                          // 一直没收到数据，没什么可清的
    const now = Date.now();
    if (now - ref < LOG_IDLE_MS) return;
    if (lastRoundAt && now - lastRoundAt < LOG_IDLE_MS) return;
    if (logStats.lastPurgeAt > ref) return;    // 这一轮已经清过了
    purgeLogFiles('空闲 ' + LOG_IDLE_MIN + ' 分钟无新回合');
  }, LOG_SWEEP_MS);
  if (timer.unref) timer.unref();              // 别拖住进程退出
}

/** 给 /state 和页面用的日志状态快照 */
function logStatus() {
  const now = Date.now();
  const ref = lastFrameAt || 0;
  let purgeIn = null;
  if (LOG_ENABLED && LOG_IDLE_MIN > 0 && ref && logStats.lastPurgeAt <= ref) {
    purgeIn = Math.max(0, Math.round((LOG_IDLE_MS - (now - ref)) / 1000));
  }
  return {
    enabled: LOG_ENABLED,
    idleMinutes: LOG_IDLE_MIN,
    keepDays: LOG_KEEP_DAYS,
    file: path.basename(todayLogPath()),
    secondsSinceFrame: ref ? Math.round((now - ref) / 1000) : null,
    purgeInSeconds: purgeIn,
    purges: logStats.purges,
    deletedFiles: logStats.deletedFiles,
    lastPurgeReason: logStats.lastPurgeReason,
    lastPurgeAgoSeconds: logStats.lastPurgeAt ? Math.round((now - logStats.lastPurgeAt) / 1000) : null
  };
}

function send(res, obj) {
  try {
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
    return true;
  } catch (e) {
    return false;
  }
}

function broadcast(obj) {
  for (const res of Array.from(clients)) {
    if (!send(res, obj)) clients.delete(res);
  }
}

function handleGsiPayload(body) {
  let frame;
  try {
    frame = JSON.parse(body);
  } catch (e) {
    stats.parseErrors++;
    return;
  }
  stats.payloads++;
  stats.lastAt = Date.now();
  lastFrameAt = stats.lastAt;
  appendLog(frame);          // 日志记的是原始帧，事后回放才能复现合并过程
  latestRaw = frame;
  if (!('map' in frame)) stats.deltas++;

  const before = acc.resets;
  const merged = mergeFrame(acc, frame);
  if (acc.resets !== before) stats.resets = acc.resets;

  // 「有没有新回合」是日志自动清理的判断依据之一，回合往前走就算活跃
  if (acc.lastRound !== null && acc.lastRound !== lastSeenRound) {
    lastSeenRound = acc.lastRound;
    lastRoundAt = Date.now();
  }

  let result;
  try {
    // 热身 / 死斗兜底判断：同一回合内出现复活，只可能在热身里发生
    const warm = looksLikeWarmup(acc, merged);
    result = analyze(merged, {
      respawnRecently: warm.hit,
      respawnAgo: warm.secondsAgo,
      roundScore: acc.roundScore,   // 每回合结束的比分快照 —— 用来重建对手的胜负序列
      killLedger: acc.killLedger,   // 观察到的累计击杀账本 —— 有敌方样本就按实测算击杀收入
      roundPlant: acc.roundPlant    // 每个回合埋没埋过包 —— 炸弹结束的胜局奖金是 $3500 不是 $3250
    });
  } catch (e) {
    broadcast({ type: 'error', message: '分析失败: ' + (e && e.message ? e.message : String(e)) });
    return;
  }

  // 只在关键字段变化时广播，避免 100ms 一次的高频刷新导致画面抖动。
  // 道具和炸弹状态也要进来：否则你在购买时间里捡到 / 买进道具，界面不会跟着更新。
  // 对手经济那几个字段更不能漏 —— 现在它是整个工具的核心输出，
  // 推算结论 / 置信度 / 资金上界任何一个变了，界面都得跟着刷。
  const g = result.me.grenades || {};
  const en = result.enemy || {};
  const sig = [
    result.roundIndex, result.phase, result.side, result.mapName,
    result.inWarmup ? 1 : 0,
    result.me.money, result.me.primary ? 1 : 0, result.me.helmet ? 1 : 0,
    result.myTeam.losses,
    en.losses, en.streak, en.tier, en.conf, en.cashCeil,
    result.bombPlanted ? 1 : 0,
    g.smoke || 0, g.flash || 0, g.fire || 0, g.he || 0
  ].join('|');

  latest = result;
  if (sig !== lastSignature) {
    lastSignature = sig;
    broadcast({ type: 'state', analysis: result, stats: stats });
  }
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || HOST));

  // 手动清理日志。必须放在下面那个「通用 POST 处理」**之前** ——
  // 那个分支把所有 POST 都当成 GSI 推送吞掉并直接 return，
  // 放在它后面就永远走不到（这个坑已经踩过一次）。
  if (req.method === 'POST' && url.pathname === '/logs/purge') {
    const removed = purgeLogFiles('手动清理');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, removed: removed }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    let oversized = false;
    req.on('data', function (chunk) {
      body += chunk;
      if (body.length > MAX_BODY) { oversized = true; req.destroy(); }
    });
    req.on('end', function () {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      if (!oversized) handleGsiPayload(body);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    clients.add(res);
    send(res, {
      type: 'state',
      analysis: latest,
      stats: stats,
      hasData: !!latest
    });
    const keep = setInterval(function () {
      try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
    }, 15000);
    req.on('close', function () {
      clearInterval(keep);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      analysis: latest,
      raw: latestRaw,          // 最新一帧原始数据（可能是个增量帧）
      mergedState: acc.state,  // 累积合并后的完整状态 —— 分析引擎用的就是它
      merged: {
        frames: acc.frames,
        resets: acc.resets,
        roundClears: acc.roundClears,  // 回合切换时清掉 round.bomb / win_team 的次数
        lastResetReason: acc.lastResetReason || '',
        mapName: acc.mapName,
        lastRoundIndex: acc.lastRound,
        lastPhase: acc.lastPhase,
        // 击杀账本：收到过多少名玩家的累计击杀数据（>=1 且其中含敌方时，击杀收入就是实测的）
        killLedgerPlayers: Object.keys(acc.killLedger).length,
        spectating: !!acc.spectating,
        // 当前帧的 player 块是不是「别人」（休闲模式阵亡后旁观 / 接手机器人）。
        // 为 true 时 mergedState.player 仍是自己（冻结在阵亡那一刻），
        // 被旁观者的数据在 mergedState.playerObserved 里。详见 lib/gsi.js。
        spectating: !!acc.spectating,
        mySteamid: acc.mySteamid || ''
      },
      stats: stats,
      log: logStatus()
    }, null, 2));
    return;
  }

  // 日志留存策略 + 计数，给页面显示「还有多久自动清」
  if (req.method === 'GET' && url.pathname === '/logs/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(logStatus()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/logs') {
    let files = [];
    try { files = fs.readdirSync(LOG_DIR).filter(function (f) { return f.endsWith('.jsonl'); }).sort().reverse(); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(files));
    return;
  }

  if (req.method === 'GET' && url.pathname.indexOf('/logs/') === 0) {
    const name = path.basename(url.pathname);
    const full = path.join(LOG_DIR, name);
    if (!full.startsWith(LOG_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(full, function (err, data) {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('log not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // 静态文件
  let rel = url.pathname === '/' ? '/overlay.html' : url.pathname;
  rel = rel.replace(/\.\./g, '');
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 not found: ' + rel);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

/**
 * 由 start.bat 设 CS2BH_OPEN=1 触发：服务真正监听成功之后才打开浏览器。
 * 以前是 bat 里盲等 2 秒再开 —— 服务一旦没起来，就会出现
 * 「浏览器打开了但 127.0.0.1 拒绝连接」这种让人摸不着头脑的情况。
 */
function openBrowserWhenReady(url) {
  if (process.env.CS2BH_OPEN !== '1') return;
  setTimeout(function () {
    try {
      const cp = require('child_process');
      if (process.platform === 'win32') {
        cp.spawn('cmd', ['/c', 'start', '', url],
          { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (e) { /* 打不开浏览器不影响服务本身 */ }
  }, 400);
}

server.listen(PORT, HOST, function () {
  const base = 'http://' + HOST + ':' + PORT;

  purgeStaleLogsOnBoot();
  startLogJanitor();

  console.log('');
  console.log('  CS2 Buy Helper 已启动（对手经济推算）');
  console.log('  ------------------------------------------');
  console.log('  覆盖层      ' + base + '/');
  console.log('  抓包/校准   ' + base + '/debug.html');
  console.log('  当前状态    ' + base + '/state');
  console.log('  日志目录    ' + LOG_DIR + (LOG_ENABLED
    ? (LOG_IDLE_MIN > 0
      ? '（空闲 ' + LOG_IDLE_MIN + ' 分钟无新回合后自动清空）'
      : '（自动清理已关闭）')
    : '（已关闭，不写日志）'));
  console.log('  ------------------------------------------');
  console.log('  等待 CS2 推送数据...');
  console.log('');
  openBrowserWhenReady(base);
});

server.on('error', function (err) {
  const base = 'http://' + HOST + ':' + PORT;
  if (err && err.code === 'EADDRINUSE') {
    console.log('');
    console.log('  端口 ' + PORT + ' 已经被占用了。');
    console.log('  多半是上一次的服务还在跑 —— 直接打开 ' + base + '/ 就行，不用重复启动。');
    console.log('  确实要换端口：set PORT=32000 && node server.js');
    console.log('  并同步重写游戏配置：node tools/install.js --port 32000');
    console.log('');
  } else {
    console.log('');
    console.log('  服务启动失败：' + (err && err.message ? err.message : String(err)));
    console.log('');
  }
  process.exit(1);
});

process.on('SIGINT', function () {
  console.log('\n已停止。');
  process.exit(0);
});
