#!/usr/bin/env node
// =============================================================================
//  鸿鹭Agent工作台 · 内网更新源
// =============================================================================
//  一个零依赖的静态更新服务。生产环境也可以直接换成 Nginx / IIS / 共享盘，
//  只要能把 dist/releases 目录以 HTTP 暴露出来就行 —— 协议是完全一样的。
//
//  用法：
//    node deploy/release/update-server/server.js
//    node deploy/release/update-server/server.js --dir dist/releases --port 8090
//
//  支持的能力（比裸静态服务器多的那点东西）：
//    · 多频道：/releases/latest.json?channel=beta  → 读 latest-beta.json
//    · 灰度发布：按客户端 IP 或 X-Client-Id 头命中灰度组时返回灰度清单
//    · 访问日志：谁在什么时候取了哪个版本，便于统计升级覆盖率
//    · 断点续传：支持 Range 请求（运行时包几百 MB 时会用到）
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');

const BASE = path.resolve(__dirname, '..', '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

const DIR = path.resolve(arg('dir', path.join(BASE, 'dist', 'releases')));
const PORT = Number(arg('port', process.env.PORT || 8090));
const HOST = arg('host', '0.0.0.0');
const GRAY_PERCENT = Number(arg('gray', 0)); // 0~100，灰度比例

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8'
};

function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

/** 灰度判定：客户端 ID 的哈希落在前 N% 就算命中 */
function inGray(clientId) {
  if (!GRAY_PERCENT || GRAY_PERCENT >= 100) return GRAY_PERCENT >= 100;
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = (h * 31 + clientId.charCodeAt(i)) >>> 0;
  return (h % 100) < GRAY_PERCENT;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const clientId = String(req.headers['x-client-id'] || clientIp);
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');

  if (!rel) rel = 'latest.json';
  // 兼容 /releases/latest.json 这种带前缀的路径
  rel = rel.replace(/^releases\//, '');

  // ---- 频道 + 灰度：把 latest.json 映射到对应的清单文件
  let file = path.join(DIR, rel);
  const isManifest = /^latest(-[\w-]+)?\.json$/.test(rel);
  if (isManifest) {
    const channel = String(u.query.channel || 'stable');
    if (channel !== 'stable' && fs.existsSync(path.join(DIR, `latest-${channel}.json`))) {
      file = path.join(DIR, `latest-${channel}.json`);
    }
    if (fs.existsSync(path.join(DIR, 'latest-gray.json')) && inGray(clientId)) {
      file = path.join(DIR, 'latest-gray.json');
      console.log(`[${ts()}] GRAY  ${clientIp} -> latest-gray.json`);
    }
  }

  // ---- 防目录穿越
  const root = path.resolve(DIR);
  const resolved = path.resolve(file);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    console.log(`[${ts()}] 403   ${clientIp} ${rel}`);
    return send(res, 403, 'Forbidden');
  }

  let st;
  try { st = fs.statSync(resolved); } catch {
    console.log(`[${ts()}] 404   ${clientIp} ${rel}`);
    return send(res, 404, 'Not Found: ' + rel);
  }
  if (st.isDirectory()) return send(res, 403, 'Forbidden');

  const ext = path.extname(resolved).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.json' ? 'no-cache, no-store' : 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes'
  };

  // ---- Range（断点续传）
  const range = req.headers.range;
  if (range && /^bytes=(\d*)-(\d*)$/.test(range)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (start >= st.size || end >= st.size || start > end) {
      return send(res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${st.size}` });
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(resolved, { start, end }).pipe(res);
    console.log(`[${ts()}] 206   ${clientIp} ${rel} ${start}-${end}`);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(resolved).pipe(res);
  console.log(`[${ts()}] 200   ${clientIp} ${rel} (${(st.size / 1048576).toFixed(2)} MB)`);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  鸿鹭Agent工作台 · 更新源已启动');
  console.log('  ' + '-'.repeat(46));
  console.log('  目录   : ' + DIR);
  console.log('  地址   : http://' + (HOST === '0.0.0.0' ? '<本机IP>' : HOST) + ':' + PORT);
  console.log('  清单   : http://' + HOST + ':' + PORT + '/latest.json');
  console.log('  灰度   : ' + (GRAY_PERCENT ? GRAY_PERCENT + '%（命中者读 latest-gray.json）' : '关闭'));
  console.log('');
  if (!fs.existsSync(DIR)) {
    console.log('  ⚠ 目录不存在，请先执行： node deploy/release/build-release.js --base-url http://<本机IP>:' + PORT);
  }
  console.log('  Ctrl+C 退出');
  console.log('');
});
