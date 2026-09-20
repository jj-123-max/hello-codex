#!/usr/bin/env node
// =============================================================================
//  鸿鹭Agent工作台 · Launcher（启动壳 / 在线升级器）
// =============================================================================
//  设计原则：这个文件是"安装后几乎永不更新"的那一层，所以它必须：
//    · 零第三方依赖（只用 Node 内置模块）—— 升级器本身不能成为升级的障碍
//    · 离线可用（拉不到更新源就正常启动本地版本，绝不阻塞用户）
//    · 可回滚（新版起不来自动切回上一版）
//    · 数据与程序严格分离（升级只动 versions/，永不碰 data/）
//
//  安装后目录结构：
//    <ROOT>\
//    ├─ launcher\            ← 本文件 + 配置（壳，几乎不变）
//    ├─ runtime\             ← 内置 Node + dsh 引擎（跟大版本走，按需更新）
//    │   ├─ node\node.exe
//    │   └─ dsh\node_modules\@deepseek-ai\dsh\...
//    ├─ versions\            ← 内容包（业务代码），可多版本共存
//    │   ├─ 1.0.0\
//    │   └─ 1.1.0\
//    ├─ current\             ← 指向当前版本的 junction（方便人肉排查，非权威）
//    └─ data\                ← 用户数据，升级永不触碰
//        ├─ dsh-home\        ← 会话/凭证/dsh 配置
//        ├─ biz\             ← 业务数据 JSON
//        ├─ logs\            ← 网关日志 + launcher.log
//        ├─ workspace\       ← Agent 工作区
//        ├─ .env             ← 用户密钥（首次运行自动生成模板）
//        └─ state.json       ← 版本状态（权威指针）
//
//  用法：
//    node launcher.js                  正常启动（先查更新再起服务）
//    node launcher.js --no-update      跳过更新检查，直接启动
//    node launcher.js --check-only     只检查更新并打印，不启动服务
//    node launcher.js --force          忽略本地版本，强制重装当前清单版本
//    node launcher.js --rollback       回滚到上一个可用版本后启动
//    node launcher.js --selfcheck      校验安装完整性
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const zip = require(path.join(__dirname, '..', 'lib', 'zip.js'));

// ----------------------------------------------------------------- 路径解析
const LAUNCHER_DIR = __dirname;
const ROOT = path.resolve(LAUNCHER_DIR, '..');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const VERSIONS_DIR = path.join(ROOT, 'versions');
const DATA_DIR = path.join(ROOT, 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CURRENT_LINK = path.join(ROOT, 'current');
const LOG_FILE = path.join(LOGS_DIR, 'launcher.log');
const PID_FILE = path.join(DATA_DIR, 'server.pid');

// ------------------------------------------------------------------- 日志
const LOG_MAX_BYTES = 2 * 1024 * 1024;

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function logToFile(line) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
        fs.renameSync(LOG_FILE, LOG_FILE + '.1');
      }
    } catch { /* 文件不存在，忽略 */ }
    fs.appendFileSync(LOG_FILE, `[${ts()}] ${line}\n`);
  } catch { /* 日志写不进去也不能影响启动 */ }
}

const log = {
  info: (m) => { console.log(`[鸿鹭] ${m}`); logToFile('INFO  ' + m); },
  warn: (m) => { console.log(`[鸿鹭] ⚠ ${m}`); logToFile('WARN  ' + m); },
  error: (m) => { console.error(`[鸿鹭] ✗ ${m}`); logToFile('ERROR ' + m); },
  step: (m) => { console.log(`[鸿鹭] → ${m}`); logToFile('STEP  ' + m); }
};

// ------------------------------------------------------------------- 配置
const DEFAULT_CONFIG = {
  appName: '鸿鹭Agent工作台',
  channel: 'stable',
  updateUrl: '',
  checkOnStart: true,
  autoApply: true,
  keepVersions: 3,
  serverEntry: 'src/server.js',
  port: 4000,
  consolePort: 4080,
  openBrowser: true,
  httpTimeoutMs: 8000,
  startupGraceMs: 25000,
  healthPath: '/'
};

function readJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function loadConfig() {
  const base = readJson(path.join(LAUNCHER_DIR, 'launcher.config.json'), {});
  const user = readJson(path.join(DATA_DIR, 'launcher.config.json'), {}); // 用户级覆盖，升级不动
  const cfg = { ...DEFAULT_CONFIG, ...base, ...user };
  if (process.env.HL_UPDATE_URL) cfg.updateUrl = process.env.HL_UPDATE_URL;
  if (process.env.HL_CHANNEL) cfg.channel = process.env.HL_CHANNEL;
  // 统一成数组：字符串 → [字符串]；数组 → 原样（多源按顺序探测，第一个通了就用）
  cfg.updateUrls = normalizeSources(cfg.updateUrl);
  return cfg;
}

/** 极简 .env 解析：KEY=VALUE，忽略 # 注释与空行；已存在的真实环境变量优先 */
function loadDotEnv() {
  const out = {};
  for (const file of [path.join(DATA_DIR, '.env'), path.join(ROOT, '.env')]) {
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k) out[k] = v;
    }
  }
  return out;
}

function ensureEnvTemplate() {
  const p = path.join(DATA_DIR, '.env');
  if (fs.existsSync(p)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, [
    '# 鸿鹭Agent工作台 · 用户环境变量（此文件不会被升级覆盖，请放心填写）',
    '# 改完保存，重启工作台生效。',
    '',
    '# 模型 API Key（必填，向管理员索取）',
    'DEEPSEEK_API_KEY=',
    '',
    '# 若使用内网模型端点，取消注释并填写',
    '# DSB_MODEL_PROVIDER=openai-compatible',
    '# DSB_MODEL_BASE_URL=http://内网模型网关/v1',
    '# DSB_MODEL_NAME=deepseek-v4-flash',
    ''
  ].join('\n'), 'utf8');
  log.info('已生成密钥配置模板: ' + p + '（请填入 DEEPSEEK_API_KEY）');
}

// ------------------------------------------------------------------- 状态
function loadState() {
  return readJson(STATE_FILE, {
    activeVersion: '',
    previousVersion: '',
    failedVersions: [],
    runtimeVersion: '',
    pendingRuntime: null,
    lastCheck: '',
    updatedAt: ''
  });
}

function saveState(s) {
  s.updatedAt = new Date().toISOString();
  writeJsonAtomic(STATE_FILE, s);
}

// --------------------------------------------------------------- HTTP 工具
function request(url, { timeout = 8000, headers = {}, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('更新源地址不合法: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'HongluLauncher/1.0', ...headers },
      timeout
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('重定向次数过多'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, { timeout, headers, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''} @ ${url}`));
      }
      resolve(res);
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时（' + timeout + 'ms）')); });
    req.on('error', reject);
  });
}

async function fetchJson(url, timeout) {
  const res = await request(url, { timeout });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('更新源返回的不是合法 JSON（前 120 字符）：' + text.slice(0, 120));
  }
}

/**
 * 把 updateUrl 规范成非空字符串数组。
 * 支持两种写法（内网用 IP 部署时通常配主备两个地址做容灾）：
 *   "updateUrl": "http://10.0.1.100:8090/latest.json"
 *   "updateUrl": ["http://10.0.1.100:8090/latest.json", "http://10.0.1.101:8090/latest.json"]
 */
function normalizeSources(v) {
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
}

/**
 * 解析清单内的地址：绝对地址原样返回，相对地址基于清单所在地址推导。
 * 这样更新源换 IP / 换端口时，只需改客户端的 updateUrl 一处，
 * 不必重新出清单（清单里写 content-1.1.0.zip 即可）。
 */
function resolveUrl(rel, base) {
  if (!rel) return '';
  const s = String(rel).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s; // 已是绝对地址
  try { return new URL(s, base).toString(); } catch { return s; }
}

/**
 * 依次尝试所有更新源，返回第一个可用的清单。
 * 返回 { manifest, source } —— source 是命中的清单地址，用于解析清单内的相对路径。
 */
async function fetchManifest(cfg) {
  const sources = normalizeSources(cfg.updateUrls != null ? cfg.updateUrls : cfg.updateUrl);
  if (!sources.length) throw new Error('未配置更新源');
  const errors = [];
  for (const src of sources) {
    try {
      const manifest = await fetchJson(src, cfg.httpTimeoutMs);
      return { manifest, source: src };
    } catch (e) {
      errors.push(`${src} → ${e.message}`);
      if (sources.length > 1) log.warn(`更新源不可达：${src}（${e.message}），改试下一个…`);
    }
  }
  throw new Error(`全部 ${sources.length} 个更新源均不可达：\n      ` + errors.join('\n      '));
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

async function downloadTo(url, destFile, timeout, label) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const res = await request(url, { timeout: Math.max(timeout, 30000) });
  const total = Number(res.headers['content-length'] || 0);
  const part = destFile + '.part';
  const out = fs.createWriteStream(part);
  let got = 0, lastPct = -1;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      got += c.length;
      if (total > 0) {
        const pct = Math.floor((got / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write(`\r[鸿鹭] → 下载${label ? ' ' + label : ''} ${pct}%`); }
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  if (total > 0) process.stdout.write('\r\x1b[K');
  fs.renameSync(part, destFile);
  return { bytes: got, total };
}

// ------------------------------------------------------------- 版本工具
function versionDirs() {
  try {
    return fs.readdirSync(VERSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch { return []; }
}

/** 语义化版本比较：1.10.0 > 1.9.0（不是字符串比较） */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function versionPath(v) { return path.join(VERSIONS_DIR, v); }

function isValidVersionDir(dir) {
  return fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'src', 'server.js'));
}

function updateCurrentLink(version) {
  // junction 只是给人看的便利入口；真正的权威指针是 state.json。
  // 失败也不影响启动（某些受限环境不允许创建链接）。
  try {
    if (fs.existsSync(CURRENT_LINK)) {
      try { fs.unlinkSync(CURRENT_LINK); } catch {
        spawnSync('cmd', ['/c', 'rmdir', CURRENT_LINK], { windowsHide: true });
      }
    }
    fs.symlinkSync(versionPath(version), CURRENT_LINK, 'junction');
  } catch { /* 忽略 */ }
}

// ------------------------------------------------------------- 更新：内容包
async function applyContentUpdate(cfg, manifest, state, force, base) {
  const remote = manifest.content || {};
  const ver = manifest.version;
  if (!ver) throw new Error('清单缺少 version 字段');

  const target = versionPath(ver);
  const need = force || state.activeVersion !== ver || !isValidVersionDir(target);
  if (!need) {
    log.info(`内容包已是最新：v${ver}`);
    return false;
  }

  // 失败黑名单：该版本曾启动失败并被自动回滚 → 不再自动重装。
  // 否则会死循环：装 v1.1.0 → 崩 → 回滚 v1.0.0 → 下次启动又装 v1.1.0 → 又崩…
  // （回滚后 activeVersion 已变成旧版，上面那个 need 判断必然为 true）
  if (!force && (state.failedVersions || []).includes(ver)) {
    log.warn(`v${ver} 曾启动失败并被回滚，已跳过自动升级。`);
    log.warn(`若该版本已修复，请删除 ${STATE_FILE} 里 failedVersions 中的 "${ver}"，或运行 launcher.js --force`);
    return false;
  }

  if (cmpVersion(ver, state.activeVersion || '0.0.0') < 0 && !force) {
    log.warn(`服务器版本 v${ver} 低于本地 v${state.activeVersion}，跳过（如需降级请加 --force）`);
    return false;
  }

  log.step(`发现新版本 v${ver}${state.activeVersion ? `（本地 v${state.activeVersion}）` : ''}`);
  if (manifest.notes) log.info('更新说明：' + String(manifest.notes).split('\n')[0]);

  const pkgUrl = resolveUrl(remote.url, base);
  if (!pkgUrl) throw new Error('清单缺少 content.url');
  const pkgFile = path.join(TMP_DIR, `content-${ver}.zip`);
  await downloadTo(pkgUrl, pkgFile, cfg.httpTimeoutMs, `v${ver} 内容包`);

  if (remote.sha256) {
    const actual = sha256File(pkgFile);
    if (actual.toLowerCase() !== String(remote.sha256).toLowerCase()) {
      fs.rmSync(pkgFile, { force: true });
      throw new Error(`内容包校验失败（sha256 不匹配）\n  期望 ${remote.sha256}\n  实际 ${actual}`);
    }
    log.info('sha256 校验通过');
  } else {
    log.warn('清单未提供 sha256，跳过完整性校验（建议在更新源上补齐）');
  }

  const staging = path.join(VERSIONS_DIR, `.staging-${ver}-${Date.now()}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  log.step('解压到临时目录…');
  const r = zip.unzipTo(pkgFile, staging);
  log.info(`解压完成：${r.files} 个文件，${(r.bytes / 1048576).toFixed(1)} MB`);

  if (!isValidVersionDir(staging)) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('内容包结构异常：缺少 package.json / src/server.js');
  }

  // 原子切换：先把旧目录挪走，再把 staging 改名到位
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  fs.renameSync(staging, target);
  fs.rmSync(pkgFile, { force: true });

  state.previousVersion = state.activeVersion || '';
  state.activeVersion = ver;
  saveState(state);
  updateCurrentLink(ver);
  log.info(`已激活 v${ver}`);

  // 清理历史版本
  const keep = Math.max(1, cfg.keepVersions | 0);
  const all = versionDirs().filter((v) => !v.startsWith('.')).sort((a, b) => cmpVersion(b, a));
  for (const v of all.slice(keep)) {
    if (v === state.activeVersion || v === state.previousVersion) continue;
    fs.rmSync(versionPath(v), { recursive: true, force: true });
    log.info('清理旧版本 v' + v);
  }
  return true;
}

// ------------------------------------------------------------- 更新：运行时
async function stageRuntimeUpdate(cfg, manifest, base) {
  const rt = manifest.runtime;
  if (!rt || !rt.url || !rt.version) return false;
  const state = loadState();
  if (state.runtimeVersion === rt.version) return false;

  const stagedDir = path.join(RUNTIME_DIR + '.staged');
  if (fs.existsSync(stagedDir)) fs.rmSync(stagedDir, { recursive: true, force: true });

  log.step(`运行时更新 v${rt.version}（较大，仅在必要时下发）`);
  const pkgFile = path.join(TMP_DIR, `runtime-${rt.version}.zip`);
  await downloadTo(resolveUrl(rt.url, base), pkgFile, cfg.httpTimeoutMs, `运行时 v${rt.version}`);
  if (rt.sha256 && sha256File(pkgFile).toLowerCase() !== String(rt.sha256).toLowerCase()) {
    fs.rmSync(pkgFile, { force: true });
    throw new Error('运行时包 sha256 校验失败');
  }
  fs.mkdirSync(stagedDir, { recursive: true });
  zip.unzipTo(pkgFile, stagedDir);
  fs.rmSync(pkgFile, { force: true });

  state.pendingRuntime = rt.version;
  saveState(state);
  log.info(`运行时 v${rt.version} 已就绪，将在下次启动时生效`);
  return true;
}

/**
 * 应用已暂存的运行时更新。
 * Windows 不允许覆盖正在运行的 node.exe，所以这里派一个游离的 cmd：
 * 等本进程退出 → 换目录 → 重新拉起 launcher。
 */
function applyPendingRuntime() {
  const stagedDir = RUNTIME_DIR + '.staged';
  if (!fs.existsSync(stagedDir)) return false;

  const state = loadState();
  const ver = state.pendingRuntime || 'unknown';
  const helper = path.join(TMP_DIR, 'apply-runtime.cmd');
  const logFile = path.join(LOGS_DIR, 'runtime-update.log');
  const oldDir = RUNTIME_DIR + '.old';

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const cmd = [
    '@echo off',
    'chcp 65001 >nul',
    `echo [%date% %time%] 等待主进程退出... >> "${logFile}"`,
    'ping 127.0.0.1 -n 3 >nul',
    ':wait',
    `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul && (ping 127.0.0.1 -n 2 >nul & goto wait)`,
    `if exist "${oldDir}" rmdir /s /q "${oldDir}" >> "${logFile}" 2>&1`,
    `move "${RUNTIME_DIR}" "${oldDir}" >> "${logFile}" 2>&1`,
    `move "${stagedDir}" "${RUNTIME_DIR}" >> "${logFile}" 2>&1`,
    `if errorlevel 1 ( echo 切换失败，回滚 >> "${logFile}" & move "${oldDir}" "${RUNTIME_DIR}" >> "${logFile}" 2>&1 & goto relaunch )`,
    `if exist "${oldDir}" rmdir /s /q "${oldDir}" >> "${logFile}" 2>&1`,
    ':relaunch',
    `start "" "${path.join(RUNTIME_DIR, 'node', 'node.exe')}" "${path.join(LAUNCHER_DIR, 'launcher.js')}" >> "${logFile}" 2>&1`,
    'del "%~f0" >nul 2>&1'
  ].join('\r\n');

  fs.writeFileSync(helper, cmd, 'utf8');
  log.step(`正在应用运行时 v${ver}，工作台会自动重启…`);
  logToFile('spawn runtime helper: ' + helper);

  const child = spawn('cmd.exe', ['/c', helper], {
    detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  return true;
}

// ------------------------------------------------------------------ 启动
function resolveNodeExe() {
  const bundled = path.join(RUNTIME_DIR, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  if (fs.existsSync(bundled)) return bundled;
  return process.execPath; // 退化为当前 Node
}

function resolveDshBin() {
  const candidates = [
    path.join(RUNTIME_DIR, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  ];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

function buildChildEnv(cfg, version) {
  const dotenv = loadDotEnv();
  const env = { ...process.env, ...dotenv };

  env.DSH_HOME = env.DSB_DSH_HOME || path.join(DATA_DIR, 'dsh-home');
  env.WORKBENCH_DATA_DIR = path.join(DATA_DIR, 'biz');
  env.WORKBENCH_LOG_DIR = path.join(DATA_DIR, 'logs');
  env.DSB_WORKSPACE = env.DSB_WORKSPACE || path.join(DATA_DIR, 'workspace');
  env.PORT = String(cfg.port);
  env.DSB_CONSOLE_PORT = String(cfg.consolePort);
  env.HL_APP_VERSION = version;

  const dshBin = resolveDshBin();
  if (dshBin && !env.DSB_DSH_BIN) env.DSB_DSH_BIN = dshBin;

  // 用户级配置（data/user-config.json，升级不覆盖）→ 映射为网关支持的环境变量
  const uc = readJson(path.join(DATA_DIR, 'user-config.json'), {});
  const map = [
    ['model.baseUrl', 'DSB_MODEL_BASE_URL'],
    ['model.name', 'DSB_MODEL_NAME'],
    ['model.provider', 'DSB_MODEL_PROVIDER'],
    ['model.apiKeyEnv', 'DSB_API_KEY_ENV'],
    ['server.host', 'DSB_HOST'],
    ['console.host', 'DSB_CONSOLE_HOST'],
    ['dsh.taskTimeoutMs', 'DSB_TASK_TIMEOUT'],
    ['workspace.path', 'DSB_WORKSPACE']
  ];
  for (const [dotPath, envKey] of map) {
    const val = dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), uc);
    if (val !== undefined && val !== '') env[envKey] = String(val);
  }

  for (const d of [env.DSH_HOME, env.WORKBENCH_DATA_DIR, env.WORKBENCH_LOG_DIR, env.DSB_WORKSPACE]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* 交给服务自己报错 */ }
  }
  return env;
}

function waitHealthy(port, host, pathname, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > deadline) return resolve(false);
      const req = http.get({ host, port, path: pathname || '/', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve(true);
        setTimeout(tick, 500);
      });
      req.on('error', () => setTimeout(tick, 500));
      req.on('timeout', () => { req.destroy(); setTimeout(tick, 500); });
    };
    tick();
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开浏览器不影响服务 */ }
}

/** 启动服务；返回 { code, signal, crashedFast } */
function launchServer(cfg, version, env) {
  const entry = path.join(versionPath(version), cfg.serverEntry);
  const nodeExe = resolveNodeExe();
  log.info(`启动服务：v${version} · http://127.0.0.1:${cfg.port}`);
  logToFile(`spawn ${nodeExe} ${entry}`);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(nodeExe, [entry], { cwd: versionPath(version), env, stdio: 'inherit' });
    try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch { /* 忽略 */ }
    const cleanup = () => { try { fs.rmSync(PID_FILE, { force: true }); } catch { /* 忽略 */ } };
    const onSignal = () => { try { child.kill(); } catch { /* 忽略 */ } };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    child.on('exit', (code, signal) => {
      cleanup();
      resolve({ code, signal, crashedFast: Date.now() - startedAt < cfg.startupGraceMs });
    });
    child.on('error', (err) => {
      cleanup();
      log.error('服务进程启动失败：' + err.message);
      resolve({ code: -1, signal: null, crashedFast: true });
    });
  });
}

/** 清理上次异常中断留下的残留（下载到一半的包、解压到一半的暂存目录）。
 *  不碰 runtime.staged（那是等待生效的运行时更新）与 apply-runtime.cmd（游离进程在用）。 */
function cleanupStale() {
  try {
    for (const ent of fs.readdirSync(VERSIONS_DIR, { withFileTypes: true })) {
      if (ent.name.startsWith('.staging-')) {
        fs.rmSync(path.join(VERSIONS_DIR, ent.name), { recursive: true, force: true });
        logToFile('清理残留暂存目录: ' + ent.name);
      }
    }
  } catch { /* 目录不存在，忽略 */ }
  try {
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (/\.(zip|part)$/i.test(f)) {
        fs.rmSync(path.join(TMP_DIR, f), { force: true });
        logToFile('清理残留下载文件: ' + f);
      }
    }
  } catch { /* 忽略 */ }
}

/** 停止正在运行的服务（读 pidfile，不依赖 wmic/tasklist 的编码） */
function isRunning() {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) || 0; } catch { return false; }
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopRunning() {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) || 0; } catch { /* 无 pidfile */ }
  if (!pid) { log.warn('未发现运行中的服务（缺少 ' + PID_FILE + '）'); return 0; }
  try {
    process.kill(pid, 'SIGTERM');
    log.info('已发送停止信号给 PID ' + pid);
  } catch {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      log.info('已强制结束 PID ' + pid);
    }
  }
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* 忽略 */ }
  return 0;
}

// -------------------------------------------------------------- 完整性自检
async function selfCheck() {
  const problems = [];
  const state = loadState();
  if (!state.activeVersion) problems.push('state.json 里没有 activeVersion');
  else if (!isValidVersionDir(versionPath(state.activeVersion))) problems.push(`活动版本目录缺失或损坏：versions/${state.activeVersion}`);
  if (!fs.existsSync(path.join(RUNTIME_DIR, 'node'))) problems.push('缺少内置 Node 运行时：runtime/node');
  if (!resolveDshBin()) problems.push('缺少 dsh 引擎：runtime/dsh/node_modules/@deepseek-ai/dsh');
  for (const d of [DATA_DIR, LOGS_DIR, path.join(DATA_DIR, 'biz')]) {
    if (!fs.existsSync(d)) problems.push('缺少数据目录：' + d);
  }
  console.log('[鸿鹭] 安装目录：' + ROOT);
  console.log('[鸿鹭] 活动版本：' + (state.activeVersion || '(无)') + '  上一版本：' + (state.previousVersion || '(无)'));
  console.log('[鸿鹭] 本地版本：' + (versionDirs().join(', ') || '(无)'));
  console.log('[鸿鹭] Node 运行时：' + resolveNodeExe());
  console.log('[鸿鹭] dsh 引擎：' + (resolveDshBin() || '(缺失)'));

  // ---- 更新源连通性：内网用 IP 直连时，这一段是排障的第一现场。
  //      地址写错、端口没开、防火墙拦了，都只在这里能看出来。
  //      （刻意不计入 problems：离线可用是设计原则，源不通不该算安装损坏）
  const cfg = loadConfig();
  const sources = cfg.updateUrls;
  let reachable = 0;
  if (!sources.length) {
    console.log('[鸿鹭] 更新源：未配置（不会在线检查更新）');
  } else {
    console.log(`[鸿鹭] 更新源：${sources.length} 个${sources.length > 1 ? '（按序探测，第一个通的生效）' : ''}`);
    for (const s of sources) {
      const t0 = Date.now();
      try {
        const m = await fetchJson(s, Math.min(cfg.httpTimeoutMs || 8000, 8000));
        reachable++;
        console.log(`        ✓ ${s}  →  清单 v${m.version || '?'}（${Date.now() - t0} ms）`);
      } catch (e) {
        console.log(`        ✗ ${s}  →  ${e.message}`);
      }
    }
    if (!reachable) {
      console.log('[鸿鹭] ⚠ 更新源全部不可达：本地可正常使用，但无法在线升级。');
      console.log('[鸿鹭]   排查顺序：1) 地址/端口写对没  2) 服务器防火墙放行没  3) 客户端到服务器的网络通不通');
      console.log('[鸿鹭]   当前配置在 ' + path.join(DATA_DIR, 'launcher.config.json'));
    }
  }

  if (problems.length) {
    console.log('[鸿鹭] ✗ 发现 ' + problems.length + ' 个问题：');
    problems.forEach((p) => console.log('        - ' + p));
  } else {
    console.log('[鸿鹭] ✓ 完整性检查通过');
  }
  return problems.length === 0;
}

// -------------------------------------------------------------------- 主流程
async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const cfg = loadConfig();

  console.log('');
  console.log(`  ${cfg.appName}  ·  启动器 v1.0`);
  console.log('  ' + '-'.repeat(46));
  logToFile(`=== launcher start pid=${process.pid} root=${ROOT} ===`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  ensureEnvTemplate();
  cleanupStale();

  if (flag('--selfcheck')) return (await selfCheck()) ? 0 : 1;
  if (flag('--stop')) return stopRunning();

  // 0) 已有实例在跑？直接打开浏览器，不重复起服务
  if (!flag('--force-restart') && isRunning()) {
    log.info(`工作台已在运行，直接打开 http://127.0.0.1:${cfg.port}`);
    // 但这里仍要做一次「轻量」更新检查：只比对清单版本，不下载、不切换。
    // 否则一直开着窗口的用户（升级只在启动时生效）永远不会知道有新版本。
    if (cfg.checkOnStart && !flag('--no-update') && cfg.updateUrls.length) {
      try {
        const { manifest } = await fetchManifest(cfg);
        const st = loadState();
        st.lastCheck = new Date().toISOString();
        saveState(st);
        if (manifest.version
          && cmpVersion(manifest.version, st.activeVersion || '0.0.0') > 0
          && !(st.failedVersions || []).includes(manifest.version)) {
          log.warn(`发现新版本 v${manifest.version}（当前运行 v${st.activeVersion || '未知'}）`);
          log.warn('关闭本工作台窗口后重新打开，即会自动升级到新版本。');
        }
      } catch (e) {
        logToFile('WARN  运行中更新检查失败（已忽略）: ' + e.message);
      }
    }
    if (cfg.openBrowser) openBrowser(`http://127.0.0.1:${cfg.port}`);
    return 0;
  }

  // 0.1) 若有暂存的运行时更新，先应用（会重启本进程）
  if (applyPendingRuntime()) return 0;

  const state = loadState();

  // 1) 回滚请求
  if (flag('--rollback')) {
    if (state.previousVersion && isValidVersionDir(versionPath(state.previousVersion))) {
      log.step(`回滚到 v${state.previousVersion}`);
      const cur = state.activeVersion;
      state.activeVersion = state.previousVersion;
      state.previousVersion = cur;
      saveState(state);
      updateCurrentLink(state.activeVersion);
    } else {
      log.warn('没有可回滚的版本');
    }
  }

  // 2) 检查更新（离线/源不可达 → 静默降级为本地启动）
  if (cfg.checkOnStart && !flag('--no-update')) {
    if (!cfg.updateUrls.length) {
      log.info('未配置更新源，跳过在线检查（可在 data\\launcher.config.json 里设置 updateUrl）');
    } else {
      log.step(`检查更新…${cfg.updateUrls.length > 1 ? `（${cfg.updateUrls.length} 个源，按序探测）` : ''}`);
      try {
        const { manifest, source } = await fetchManifest(cfg);
        const st = loadState();
        st.lastCheck = new Date().toISOString();
        saveState(st);
        if (cfg.autoApply || flag('--force')) {
          await applyContentUpdate(cfg, manifest, st, flag('--force'), source);
          await stageRuntimeUpdate(cfg, manifest, source).catch((e) => log.warn('运行时更新暂存失败：' + e.message));
        } else {
          log.info('已关闭自动应用（autoApply=false），仅检查');
        }
      } catch (e) {
        log.warn('更新检查失败，使用本地版本继续启动：' + e.message);
      }
    }
  }

  if (flag('--check-only')) {
    log.info('仅检查模式，退出。');
    return 0;
  }

  // 3) 启动（带一次自动回滚）
  let st = loadState();
  let version = st.activeVersion;

  if (!version || !isValidVersionDir(versionPath(version))) {
    const local = versionDirs().filter((v) => !v.startsWith('.')).sort((a, b) => cmpVersion(b, a));
    if (!local.length) {
      log.error('本地没有任何可用版本，且无法从更新源获取。请联系管理员。');
      log.error('提示：更新源地址配置在 ' + path.join(DATA_DIR, 'launcher.config.json'));
      return 2;
    }
    version = local[0];
    st.activeVersion = version;
    saveState(st);
    updateCurrentLink(version);
    log.warn(`state.json 无效，回退到本地最高版本 v${version}`);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const env = buildChildEnv(cfg, version);
    const health = waitHealthy(cfg.port, '127.0.0.1', cfg.healthPath, cfg.startupGraceMs);
    const proc = launchServer(cfg, version, env);
    if (cfg.openBrowser) health.then((ok) => { if (ok) openBrowser(`http://127.0.0.1:${cfg.port}`); });

    const r = await proc;

    if (r.crashedFast && r.code !== 0 && attempt === 0) {
      const s = loadState();
      if (s.previousVersion && s.previousVersion !== version && isValidVersionDir(versionPath(s.previousVersion))) {
        log.error(`v${version} 启动异常退出（code=${r.code}），自动回滚到 v${s.previousVersion}`);
        const bad = s.activeVersion;
        s.failedVersions = [...new Set([...(s.failedVersions || []), bad])];
        s.activeVersion = s.previousVersion;
        s.previousVersion = bad;
        saveState(s);
        updateCurrentLink(s.activeVersion);
        version = s.activeVersion;
        continue;
      }
      log.error(`服务启动失败（code=${r.code}）。日志：${path.join(LOGS_DIR, 'launcher.log')}`);
      return r.code || 1;
    }

    logToFile(`server exited code=${r.code} signal=${r.signal}`);
    return r.code == null ? 0 : r.code;
  }
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    log.error('启动器异常：' + (err && err.stack ? err.stack : err));
    console.error('\n按任意键退出…');
    try {
      spawnSync('cmd', ['/c', 'pause'], { stdio: 'inherit' });
    } catch { /* 忽略 */ }
    process.exit(1);
  });
