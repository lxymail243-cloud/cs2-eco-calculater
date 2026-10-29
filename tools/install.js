'use strict';

/**
 * CS2 Buy Helper —— GSI 配置安装器
 *
 * 自动定位 CS2 的 cfg 目录，把 gamestate_integration_buyhelper.cfg 复制进去。
 * 找不到时会告诉你手动该放哪里，不会乱写文件。
 *
 * 用法：
 *   node tools/install.js                    自动查找并安装
 *   node tools/install.js --check            只查找，不复制
 *   node tools/install.js --port 32000       写入指定端口（要与 server.js 的 PORT 一致）
 *   node tools/install.js "D:\SteamLibrary"  手动指定路径（Steam 库根目录 / CS2 目录 / cfg 目录都可以）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC_CFG = path.join(ROOT, 'gamestate_integration_buyhelper.cfg');
const CFG_NAME = 'gamestate_integration_buyhelper.cfg';

const GAME_FOLDER = 'Counter-Strike Global Offensive';
const REL_FROM_LIB = path.join('steamapps', 'common', GAME_FOLDER, 'game', 'csgo', 'cfg');

const C = {
  ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', rst: '\x1b[0m'
};
function line(tag, color, msg) {
  console.log(color + '[' + tag + ']' + C.rst + ' ' + msg);
}
const ok = (m) => line(' OK ', C.ok, m);
const bad = (m) => line('FAIL', C.bad, m);
const warn = (m) => line('WARN', C.warn, m);
const info = (m) => line('INFO', C.dim, m);

// ---------- 参数 ----------
let checkOnly = false;
let portOverride = null;
let manualPath = null;
let skipReg = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--check' || a === '-c') checkOnly = true;
  else if (a === '--no-reg') skipReg = true;
  else if (a === '--port' || a === '-p') portOverride = String(argv[++i] || '').trim();
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else if (!a.startsWith('--')) manualPath = a;
}
function printHelp() {
  console.log([
    'CS2 Buy Helper GSI 配置安装器',
    '',
    '  node tools/install.js                     自动查找并安装',
    '  node tools/install.js --check             只查找，不复制',
    '  node tools/install.js --port 32000        写入指定端口',
    '  node tools/install.js --no-reg            跳过注册表探测（安全策略禁止 reg.exe 时用）',
    '  node tools/install.js "D:\\SteamLibrary"   手动指定路径',
    ''
  ].join('\n'));
}

const PORT = portOverride || String(process.env.PORT || 31982);

// ---------- 定位 CS2 ----------
function candidateFromManual(p) {
  const norm = path.resolve(p);
  if (!fs.existsSync(norm)) return null;

  // 直接就是 cfg 目录
  if (fs.existsSync(path.join(norm, 'gamestate_integration_')) ||
      /[\\/]csgo[\\/]cfg$/i.test(norm.replace(/[\\/]+$/, ''))) {
    return norm;
  }
  // CS2 根目录
  const a = path.join(norm, 'game', 'csgo', 'cfg');
  if (fs.existsSync(a)) return a;
  // steamapps/common 或 Steam 库根目录
  const b = path.join(norm, REL_FROM_LIB);
  if (fs.existsSync(b)) return b;
  const c = path.join(norm, 'common', GAME_FOLDER, 'game', 'csgo', 'cfg');
  if (fs.existsSync(c)) return c;
  return null;
}

function readLibraryFolders(vdfPath) {
  try {
    const txt = fs.readFileSync(vdfPath, 'utf8');
    const out = [];
    const re = /"path"\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(txt)) !== null) out.push(m[1].replace(/\\\\/g, '\\'));
    return out;
  } catch (e) { return []; }
}

function steamRoots() {
  const roots = [];
  const push = (p) => { if (p && roots.indexOf(p) === -1) roots.push(p); };

  // 1) 注册表
  if (process.platform === 'win32' && !skipReg) {
    try {
      const out = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      });
      const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/i);
      if (m) push(m[1].trim().replace(/\//g, '\\'));
    } catch (e) { /* 读不到就靠目录扫描兜底，不是错误 */ }
  }
  // 2) 常见默认位置
  if (process.platform === 'win32') {
    push('C:\\Program Files (x86)\\Steam');
    push('C:\\Program Files\\Steam');
    push('C:\\Steam');
    push('C:\\SteamLibrary');
  } else if (process.platform === 'darwin') {
    push(path.join(os.homedir(), 'Library', 'Application Support', 'Steam'));
  } else {
    push(path.join(os.homedir(), '.steam', 'steam'));
    push(path.join(os.homedir(), '.local', 'share', 'Steam'));
  }
  return roots;
}

function scanAllDrives() {
  if (process.platform !== 'win32') return [];
  const hits = [];
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < letters.length; i++) {
    const d = letters[i] + ':';
    const probes = [
      path.join(d + '\\', 'steamapps', 'libraryfolders.vdf'),
      path.join(d + '\\', 'Steam', 'steamapps', 'libraryfolders.vdf'),
      path.join(d + '\\', 'SteamLibrary', 'steamapps', 'libraryfolders.vdf'),
      path.join(d + '\\', 'Games', 'Steam', 'steamapps', 'libraryfolders.vdf')
    ];
    for (const v of probes) {
      if (fs.existsSync(v)) readLibraryFolders(v).forEach(function (lib) {
        if (hits.indexOf(lib) === -1) hits.push(lib);
      });
    }
    // 也直接看一眼有没有库根
    const direct = path.join(d + '\\', 'SteamLibrary');
    if (fs.existsSync(path.join(direct, REL_FROM_LIB)) && hits.indexOf(direct) === -1) hits.push(direct);
  }
  return hits;
}

function findCfgDir() {
  if (manualPath) {
    const r = candidateFromManual(manualPath);
    if (!r) {
      bad('你指定的路径里没找到 CS2 的 cfg 目录：' + manualPath);
      info('请指向 Steam 库根目录（含 steamapps）、CS2 目录，或直接指向 ...\\game\\csgo\\cfg');
      process.exit(2);
    }
    return { dir: r, how: '手动指定' };
  }

  const roots = steamRoots();
  const libs = [];
  for (const r of roots) {
    if (fs.existsSync(path.join(r, REL_FROM_LIB))) return { dir: path.join(r, REL_FROM_LIB), how: 'Steam 默认目录' };
    readLibraryFolders(path.join(r, 'steamapps', 'libraryfolders.vdf')).forEach(function (l) {
      if (libs.indexOf(l) === -1) libs.push(l);
    });
  }
  for (const l of libs) {
    const p = path.join(l, REL_FROM_LIB);
    if (fs.existsSync(p)) return { dir: p, how: 'Steam 库：' + l };
  }

  const hits = scanAllDrives();
  for (const h of hits) {
    const p = path.join(h, REL_FROM_LIB);
    if (fs.existsSync(p)) return { dir: p, how: '扫描到的 Steam 库：' + h };
  }
  return null;
}

// ---------- 生成配置内容 ----------
function buildCfg() {
  let txt = fs.readFileSync(SRC_CFG, 'utf8');
  if (PORT !== '31982') {
    txt = txt.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:' + PORT);
  }
  return txt;
}

// ---------- 服务器可达性 ----------
function probeServer(done) {
  const req = http.get({
    host: '127.0.0.1', port: Number(PORT), path: '/state', timeout: 1200
  }, function (res) {
    res.resume();
    done(res.statusCode === 200);
  });
  req.on('error', function () { done(false); });
  req.on('timeout', function () { req.destroy(); done(false); });
}

// ---------- 主流程 ----------
console.log('');
console.log('CS2 Buy Helper —— GSI 配置安装');
console.log(C.dim + '端口：' + PORT + '（配置里的 uri 与之一致）' + C.rst);
console.log('');

if (!fs.existsSync(SRC_CFG)) {
  bad('找不到源配置：' + SRC_CFG);
  process.exit(2);
}

const found = findCfgDir();

if (!found) {
  bad('没有自动找到 CS2 的 cfg 目录。');
  console.log('');
  console.log('手动放置即可，两步：');
  console.log('  1. 在 Steam 库 → 右键 CS2 → 管理 → 浏览本地文件');
  console.log('  2. 依次进入 game\\csgo\\cfg\\，把本目录下的 ' + CFG_NAME + ' 复制进去');
  console.log('');
  console.log('或者把路径告诉我再跑一次：');
  console.log('  ' + C.dim + 'node tools/install.js "D:\\SteamLibrary"' + C.rst);
  console.log('');
  process.exit(1);
}

ok('找到 CS2 配置目录（' + found.how + '）');
console.log('     ' + C.dim + found.dir + C.rst);

if (checkOnly) {
  console.log('');
  info('--check 模式，未写入任何文件。去掉 --check 即可安装。');
  console.log('');
  process.exit(0);
}

const target = path.join(found.dir, CFG_NAME);
const content = buildCfg();

let backedUp = null;
if (fs.existsSync(target)) {
  const old = fs.readFileSync(target, 'utf8');
  if (old === content) {
    ok('配置已是最新，无需改动');
  } else {
    backedUp = target + '.bak-' + Date.now();
    fs.copyFileSync(target, backedUp);
    warn('已存在旧配置，先备份到：' + path.basename(backedUp));
  }
}

if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
  try {
    fs.writeFileSync(target, content, 'utf8');
    ok('配置已写入：' + target);
  } catch (e) {
    bad('写入失败：' + e.message);
    info('常见原因：CS2 正在运行、目录只读、或需要管理员权限。关掉游戏再试一次。');
    process.exit(3);
  }
}

// 回读校验
try {
  const back = fs.readFileSync(target, 'utf8');
  const m = back.match(/"uri"\s+"http:\/\/127\.0\.0\.1:(\d+)\//);
  if (m && m[1] === PORT) ok('回读校验通过，端口 = ' + m[1]);
  else warn('回读校验异常，请手动确认 uri 一行为 http://127.0.0.1:' + PORT + '/');
} catch (e) {
  warn('回读校验失败：' + e.message);
}

console.log('');
console.log('接下来：');
console.log('  1. ' + C.warn + '完全重启 CS2' + C.rst + '（GSI 配置只在游戏启动时读取，不改 cfg 里的其它内容）');

probeServer(function (alive) {
  if (alive) {
    ok('本地服务已在运行（127.0.0.1:' + PORT + '），无需再启动');
  } else {
    warn('本地服务没在跑，先去启动它：' + C.dim + 'node server.js' + C.rst);
  }
  console.log('  2. 进一局（5E / 官匹都行），打开 ' + C.dim + 'http://127.0.0.1:' + PORT + '/' + C.rst);
  console.log('  3. 首次建议先看 ' + C.dim + 'http://127.0.0.1:' + PORT + '/debug.html' + C.rst + ' 校准连败计数');
  console.log('');
});
