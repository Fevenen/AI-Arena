import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, PROJECT_ROOT } from '../../apps/server/config-store.mjs';
import { MatchStore } from '../../apps/server/match-store.mjs';
import { EventHub } from '../../apps/server/event-hub.mjs';
import { MatchService } from '../../apps/server/match-service.mjs';

export async function waitFor(fn, { timeoutMs = 7000, intervalMs = 25, message = '条件未满足' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${message}（${timeoutMs}ms 超时）${lastError ? `: ${lastError.message}` : ''}`);
}

export async function createServiceHarness({
  models = [],
  dafeiyuUrl = 'http://127.0.0.1:1',
  matchSettings = {},
  dafeiyuSettings = {},
  token = '',
  gamePlugins = undefined,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-arena-test-'));
  const template = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'arena.example.json'), 'utf8'));
  const config = {
    ...template,
    server: { host: '127.0.0.1', port: 0 },
    models: [],
    dafeiyu: {
      ...template.dafeiyu,
      bridgeUrl: dafeiyuUrl,
      token,
      origin: 'http://127.0.0.1:8787',
      healthIntervalMs: 5000,
      ...dafeiyuSettings,
    },
    match: {
      ...template.match,
      aiMoveDelayMs: 0,
      initialAiDelayMs: 0,
      autoCommentCooldownMs: 0,
      sseHeartbeatMs: 60000,
      maxModelRetries: 1,
      ...matchSettings,
    },
    storage: { matchDir: 'matches' },
  };
  const configPath = path.join(dir, 'arena.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const configStore = new ConfigStore({ configPath });
  for (const model of models) configStore.addModel(model);
  const store = new MatchStore(configStore.matchDir);
  const hub = new EventHub({ heartbeatMs: 60000 });
  const logger = { info() {}, warn() {}, error() {} };
  const service = new MatchService({
    configStore,
    store,
    hub,
    logger,
    originProvider: () => 'http://127.0.0.1:8787',
    version: 'test',
    ...(gamePlugins ? { gamePlugins } : {}),
  });
  const fakeViewers = new Map();
  function subscribe(matchId) {
    const stream = {
      write() { return true; },
      end() {},
    };
    const unsubscribe = hub.subscribe(matchId, stream);
    fakeViewers.set(matchId, { stream, unsubscribe });
    return unsubscribe;
  }
  function unsubscribe(matchId) {
    fakeViewers.get(matchId)?.unsubscribe();
    fakeViewers.delete(matchId);
  }
  return {
    dir,
    configPath,
    configStore,
    store,
    hub,
    service,
    subscribe,
    unsubscribe,
    subscribeCount(matchId) {
      return hub.count(matchId);
    },
    match(matchId) {
      return service.getMatch(matchId);
    },
    async cleanup({ keepDir = false } = {}) {
      hub.close();
      await service.close();
      if (!keepDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
