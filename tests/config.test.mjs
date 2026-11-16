import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, PROJECT_ROOT } from '../apps/server/config-store.mjs';

test('配置文件带 UTF-8 BOM 时仍可读取，且相对 matchDir 按配置目录解析', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-arena-config-'));
  try {
    const template = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'arena.example.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
    template.storage.matchDir = './records';
    const file = path.join(dir, 'arena.json');
    fs.writeFileSync(file, `\uFEFF${JSON.stringify(template, null, 2)}`, 'utf8');
    const store = new ConfigStore({ configPath: file });
    assert.equal(store.matchDir, path.join(dir, 'records'));
    assert.equal(store.server.port, 8787);
    assert.equal(store.listModels().length, 1);
    assert.equal(store.listModels()[0].apiKey, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
