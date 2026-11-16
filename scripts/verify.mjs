#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log('[verify] 运行 Node 规则、模型、API 与桥接测试…');
const tests = spawnSync(process.execPath, ['--test', '--test-concurrency=1'], {
  cwd: ROOT,
  stdio: 'inherit',
  windowsHide: true,
});
if (tests.status !== 0) process.exit(tests.status ?? 1);
console.log('[verify] 运行公开文件检查…');
const publicCheck = spawnSync(process.execPath, ['scripts/check-public.mjs'], {
  cwd: ROOT,
  stdio: 'inherit',
  windowsHide: true,
});
if (publicCheck.status !== 0) process.exit(publicCheck.status ?? 1);
console.log('[verify] 全部通过。浏览器冒烟测试可另行运行 node scripts/ui-smoke.mjs。');
