#!/usr/bin/env node
// =============================================================================
//  鸿鹭Agent工作台 · 发布打包器
// =============================================================================
//  把工程打成「内容包 + 清单」，产物直接丢到内网更新源即可，用户端自动升级。
//
//  用法（在 dsh-base 目录执行）：
//    node deploy/release/build-release.js                        # 用 package.json 的版本号
//    node deploy/release/build-release.js --version 1.2.0        # 指定版本号
//    node deploy/release/build-release.js --notes "新增评估系统"   # 更新说明
//    node deploy/release/build-release.js --base-url http://update.honglu.local/releases
//    node deploy/release/build-release.js --base-url http://10.0.1.100:8090   # 没有域名？直接用 IP
//    node deploy/release/build-release.js --with-runtime --runtime-src dist/智能工作台-dsh-win
//
//  关于 --base-url：
//    留空 → 清单里写相对路径（如 content-1.1.0.zip），客户端基于自己的 updateUrl 推导绝对地址。
//           更新源换 IP / 换端口时，只需改客户端配置，不必重新出清单。
//    填写 → 清单里写绝对地址。适合地址长期固定、由服务端统一管控的场景。
//           ⚠ 填了 IP 就等于把 IP 焊死在清单里：换 IP 必须重新跑本脚本 + 重新同步清单。
//
//  产物（默认输出到 dist/releases/）：
//    content-<版本>.zip     内容包（业务代码，约 1~2 MB，日常升级只发这个）
//    runtime-<版本>.zip     运行时包（Node + dsh 引擎，仅在需要时下发，数百 MB）
//    latest.json            清单（用户端 Launcher 读取的唯一入口）
//    notes/<版本>.md        更新说明
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const zip = require(path.join(__dirname, '..', 'lib', 'zip.js'));

const BASE = path.resolve(__dirname, '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const pkg = JSON.parse(fs.readFileSync(path.join(BASE, 'package.json'), 'utf8'));
const VERSION = String(arg('version', pkg.version || '0.0.1'));
const OUT_DIR = path.resolve(arg('out', path.join(BASE, 'dist', 'releases')));
const BASE_URL = String(arg('base-url', '')).replace(/\/+$/, '');
const NOTES = arg('notes', '');
const WITH_RUNTIME = !!arg('with-runtime', false);
const RUNTIME_SRC = arg('runtime-src', '');
const CHANNEL = String(arg('channel', 'stable'));
const FORCE = !!arg('force', false);

// 内容层包含什么：跑业务必须的那部分。deploy/ 与 data/ 刻意排除——
// 前者是壳（不随内容升级），后者是用户数据（永远不动）。
// 注意：刻意不含 config.json —— 它是"本机覆盖"，里面常有绝对路径，
//       随包下发会污染别人机器。用户配置一律走 data/ 下的文件 + 环境变量。
const INCLUDE = ['package.json', 'package-lock.json', 'config.default.json', 'README.md',
  'src', 'biz-web', 'web', 'custom', 'scripts', 'node_modules'];

// 明确排除：运行时产物、用户数据、壳自身、开发缓存
const EXCLUDE_RE = [
  /^deploy\//,
  /^data\//,
  /^logs\//,
  /^workspace\//,
  /^dist\//,
  /^dsh-home\//,
  /^test\//,
  /^\.git/,
  /^node_modules\/\.bin\//,
  /^node_modules\/\.package-lock\.json$/,
  /\.log$/,
  /\.tmp$/
];

function shouldInclude(rel) {
  const p = rel.replace(/\\/g, '/');
  return !EXCLUDE_RE.some((re) => re.test(p));
}

function mb(bytes) { return (bytes / 1048576).toFixed(2) + ' MB'; }

function main() {
  console.log('');
  console.log('  鸿鹭Agent工作台 · 发布打包');
  console.log('  ' + '-'.repeat(50));
  console.log('  版本    : v' + VERSION);
  console.log('  频道    : ' + CHANNEL);
  console.log('  输出    : ' + OUT_DIR);
  console.log('');

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---------------------------------------------------------- 1) 内容包
  // 先组装一个"干净目录"再打包，避免把 dsh-base 里乱七八糟的东西带进去。
  const stageDir = path.join(OUT_DIR, '.stage-content');
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  let copied = 0;
  for (const item of INCLUDE) {
    const src = path.join(BASE, item);
    if (!fs.existsSync(src)) { console.log('  · 跳过（不存在）: ' + item); continue; }
    copyFiltered(src, path.join(stageDir, item), item);
    copied++;
  }
  console.log(`  内容层：${copied} 个顶层条目`);

  // 保险：内容包里必须有服务入口
  if (!fs.existsSync(path.join(stageDir, 'src', 'server.js'))) {
    console.error('  ✗ 内容包缺少 src/server.js，中止');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(stageDir, 'biz-web', 'index.html'))) {
    console.warn('  ⚠ 内容包缺少 biz-web/index.html，请确认前端已构建');
  }

  const contentFile = path.join(OUT_DIR, `content-${VERSION}.zip`);
  fs.rmSync(contentFile, { force: true });
  const c = zip.zipDir(stageDir, contentFile, { filter: (rel) => shouldInclude(rel) });
  fs.rmSync(stageDir, { recursive: true, force: true });
  console.log(`  ✓ content-${VERSION}.zip  ${c.files} 文件  ${mb(c.bytes)}`);
  console.log(`    sha256 = ${c.sha256}`);

  // ---------------------------------------------------------- 2) 运行时包
  let runtimeMeta = null;
  if (WITH_RUNTIME) {
    const src = RUNTIME_SRC ? path.resolve(String(RUNTIME_SRC)) : '';
    if (!src || !fs.existsSync(src)) {
      console.error('  ✗ --with-runtime 需要 --runtime-src 指向绿色包目录（含 runtime/ 或 dsh-runtime/）');
      process.exit(1);
    }
    const runtimeVersion = String(arg('runtime-version', VERSION));
    const runtimeFile = path.join(OUT_DIR, `runtime-${runtimeVersion}.zip`);
    fs.rmSync(runtimeFile, { force: true });
    console.log('');
    console.log('  正在打包运行时（较大，请稍候）…');
    const r = zip.zipDir(src, runtimeFile, {
      level: 6,
      filter: (rel) => {
        const p = rel.replace(/\\/g, '/');
        return !/^data\//.test(p) && !/^logs\//.test(p) && !/^workspace\//.test(p)
          && !/^dsh-home\/profiles\/node_modules\//.test(p) && !/^versions\//.test(p)
          && !/^current\//.test(p) && !/\.log$/.test(p);
      }
    });
    console.log(`  ✓ runtime-${runtimeVersion}.zip  ${r.files} 文件  ${mb(r.bytes)}`);
    runtimeMeta = {
      version: runtimeVersion,
      url: (BASE_URL ? BASE_URL + '/' : '') + `runtime-${runtimeVersion}.zip`,
      sha256: r.sha256,
      size: r.bytes
    };
  }

  // ---------------------------------------------------------- 3) 更新说明
  fs.mkdirSync(path.join(OUT_DIR, 'notes'), { recursive: true });
  const notesText = (NOTES && NOTES !== true)
    ? String(NOTES)
    : `## v${VERSION}\n\n- （请在此补充本次更新内容）\n`;
  fs.writeFileSync(path.join(OUT_DIR, 'notes', `${VERSION}.md`), notesText, 'utf8');

  // ---------------------------------------------------------- 4) 清单
  const manifest = {
    version: VERSION,
    channel: CHANNEL,
    releasedAt: new Date().toISOString(),
    minLauncher: '1.0.0',
    notes: notesText.split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.replace(/^[-*]\s*/, '')).join('；'),
    notesUrl: (BASE_URL ? BASE_URL + '/' : '') + `notes/${VERSION}.md`,
    content: {
      url: (BASE_URL ? BASE_URL + '/' : '') + `content-${VERSION}.zip`,
      sha256: c.sha256,
      size: c.bytes,
      files: c.files
    }
  };
  if (runtimeMeta) manifest.runtime = runtimeMeta;

  const manifestFile = path.join(OUT_DIR, 'latest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');

  // ---------------------------------------------------------- 汇总
  console.log('');
  console.log('  ' + '-'.repeat(50));
  console.log('  产物：');
  for (const f of fs.readdirSync(OUT_DIR)) {
    const p = path.join(OUT_DIR, f);
    if (fs.statSync(p).isFile()) console.log(`    ${f.padEnd(30)} ${mb(fs.statSync(p).size)}`);
  }
  console.log('');
  console.log('  下一步：把 dist/releases/ 整个目录同步到内网更新源，');
  console.log('         然后覆盖 latest.json（用户端下次启动即自动升级）。');
  if (!BASE_URL) {
    console.log('');
    console.log('  · 未指定 --base-url：清单里写的是相对路径（推荐）。');
    console.log('    客户端会基于自己的 updateUrl 推导绝对地址，');
    console.log('    所以更新源换 IP / 换端口时，只需改客户端配置，不必重新出清单。');
    console.log('    若要让清单自带绝对地址，加： --base-url http://10.0.1.100:8090');
  }
  console.log('');
}

/** 递归复制，套用排除规则；符号链接跳过 */
function copyFiltered(src, dst, relBase) {
  const st = fs.statSync(src);
  if (st.isFile()) {
    if (!shouldInclude(relBase)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return;
  }
  if (!st.isDirectory()) return; // 符号链接等
  fs.mkdirSync(dst, { recursive: true }); // 顶层调用时目标目录还不存在
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    const r = relBase + '/' + ent.name;
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (!shouldInclude(r + '/')) continue;
      copyFiltered(s, d, r);
    } else if (ent.isFile()) {
      if (!shouldInclude(r)) continue;
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

main();
