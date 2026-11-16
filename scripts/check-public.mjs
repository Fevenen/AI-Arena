#!/usr/bin/env node
/**
 * GitHub 发布前的公开文件检查：
 * - 不包含本机绝对路径或 Windows 用户名；
 * - 不包含常见真实密钥形态；
 * - 运行数据、日志、构建缓存不进入公开源码树；
 * - 仓库包含依赖清单、锁文件、配置示例和忽略规则。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'data',
  'logs',
  'cache',
  'coverage',
  'test-results',
  '.cache',
  '.tmp',
  'tmp',
]);
const TEXT_EXT = new Set([
  '.mjs', '.js', '.json', '.md', '.css', '.html', '.cmd', '.ps1', '.txt', '.yml', '.yaml',
]);
const REQUIRED = [
  'README.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  '.gitignore',
  'config/arena.example.json',
  'apps/server/index.mjs',
  'apps/web/index.html',
  'apps/web/app.js',
  'apps/web/styles.css',
  'packages/core/game-api.mjs',
  'packages/games/gomoku/index.mjs',
  'packages/models/openai-compatible.mjs',
  'tests/gomoku.test.mjs',
  'tests/models.test.mjs',
  'tests/api.test.mjs',
  'docs/add-model.md',
  'docs/add-game.md',
  'docs/dafeiyu.md',
];

const issues = [];
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      files.push(path.join(dir, entry.name));
    }
  }
}

walk(ROOT);

for (const required of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, required))) {
    issues.push(`缺少发布必需文件：${required}`);
  }
}

const trackedData = files.filter((file) => {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  return relative.startsWith('data/') && relative !== 'data/.gitkeep';
});
if (trackedData.length) issues.push(`data/ 下出现了会被公开的文件：${trackedData.join(', ')}`);

const forbidden = [
  { pattern: /D:\\+project/i, label: '本机 D:\\project 路径' },
  { pattern: /[A-Z]:\\+Users\\+[^\\\s]+/i, label: 'Windows 用户目录路径' },
  { pattern: /\/Users\/[^/\s]+/i, label: 'macOS 用户目录路径' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, label: '疑似真实 sk- API Key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: '疑似 GitHub Token' },
  { pattern: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, label: '私钥' },
];

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext) && path.basename(file) !== '.gitignore' && path.basename(file) !== '.gitattributes') {
    continue;
  }
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  // 发布检查脚本自身包含检测规则，不应把它当作泄露内容。
  if (relative === 'scripts/check-public.mjs') continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) {
      issues.push(`${relative} 命中禁止内容：${rule.label}`);
    }
  }
}
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) {
  issues.push('package.json 声明了依赖，但项目声称零运行时依赖；请同步 README 与锁文件。');
}
if (!lock.lockfileVersion || !lock.packages?.['']) {
  issues.push('package-lock.json 结构不完整。');
}
const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
for (const rule of ['data/*', '!data/.gitkeep', '*.log', 'node_modules/']) {
  if (!ignore.includes(rule)) issues.push(`.gitignore 缺少：${rule}`);
}
// Windows CMD 对 LF-only 批处理可能报“命令语法不正确”；发布前强制检查。
const cmdText = fs.readFileSync(path.join(ROOT, 'start.cmd'), 'utf8');
if (!cmdText.includes('\r\n') || /(^|[^\r])\n/.test(cmdText)) {
  issues.push('start.cmd 必须使用 CRLF 换行，否则 Windows 双击可能无法启动。');
}
if (cmdText.charCodeAt(0) === 0xfeff) {
  issues.push('start.cmd 不应包含 UTF-8 BOM。');
}
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/arena.example.json'), 'utf8'));
if (!Array.isArray(example.models) || !example.models.some((model) => model.baseUrl?.includes('127.0.0.1') || model.baseUrl?.includes('localhost'))) {
  issues.push('配置示例缺少本地模型示例。');
}
if (/D:\\|C:\\Users\\/i.test(JSON.stringify(example))) {
  issues.push('配置示例包含本机绝对路径。');
}

if (issues.length) {
  console.error('公开文件检查失败：');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}
console.log(`公开文件检查通过：${files.length} 个文件，无本机路径、真实密钥或运行数据。`);
