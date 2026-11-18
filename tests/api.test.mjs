import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArenaApp, VERSION } from '../apps/server/app.mjs';
import { PROJECT_ROOT } from '../apps/server/config-store.mjs';
import { createMockOpenAI } from './helpers/mock-openai.mjs';
import { createMockDafeiyu } from './helpers/mock-dafeiyu.mjs';
import { gomokuGame } from '../packages/games/gomoku/index.mjs';
import { threeSeatGame } from './fixtures/three-seat-game.mjs';

async function startApp({
  models = [],
  dafeiyuUrl = 'http://127.0.0.1:1',
  matchSettings = {},
  gamePlugins = undefined,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-arena-api-'));
  const template = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'arena.example.json'), 'utf8'));
  const config = {
    ...template,
    server: { host: '127.0.0.1', port: 0 },
    models,
    dafeiyu: {
      ...template.dafeiyu,
      bridgeUrl: dafeiyuUrl,
      origin: 'http://127.0.0.1:8787',
      healthIntervalMs: 60000,
    },
    match: {
      ...template.match,
      aiMoveDelayMs: 0,
      initialAiDelayMs: 0,
      autoCommentCooldownMs: 0,
      sseHeartbeatMs: 60000,
      ...matchSettings,
    },
    storage: { matchDir: 'matches' },
  };
  const configPath = path.join(dir, 'arena.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const app = await createArenaApp({
    configPath,
    logger: { info() {}, warn() {}, error() {} },
    ...(gamePlugins ? { gamePlugins } : {}),
  });
  await app.start({ port: 0, host: '127.0.0.1' });
  return {
    dir,
    configPath,
    app,
    base: app.publicUrl,
    async close() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    async closeKeep() {
      await app.close();
    },
  };
}

async function api(base, pathname, { method = 'GET', body = null, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body == null ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data, headers: response.headers, text };
}

async function waitFor(fn, timeoutMs = 10000, message = '条件未满足') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${message}（${timeoutMs}ms）`);
}

test('模型管理 API：Key 不回传，Bearer local/空 Key 测试成功，错误分类清楚', async () => {
  const withKey = await createMockOpenAI({ apiKey: 'secret-key' });
  const noKey = await createMockOpenAI({ apiKey: null });
  const env = await startApp({ dafeiyuUrl: 'http://127.0.0.1:1' });
  try {
    const bootstrap = await api(env.base, '/api/bootstrap');
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.data.app.version, VERSION);
    assert.equal(bootstrap.data.games[0].id, 'gomoku');
    assert.equal(bootstrap.data.builtInBot.available, true);
    const created = await api(env.base, '/api/models', {
      method: 'POST',
      body: {
        name: '带 Key 的测试模型',
        provider: 'openai-compatible',
        baseUrl: `${withKey.baseUrl}/`,
        modelId: withKey.model,
        apiKey: 'secret-key',
        timeoutMs: 5000,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.model.hasApiKey, true);
    assert.equal(created.data.model.baseUrl, withKey.baseUrl);
    assert.equal(created.text.includes('secret-key'), false);
    const id = created.data.model.id;
    const models = await api(env.base, '/api/models');
    assert.equal(models.text.includes('secret-key'), false);
    const tested = await api(env.base, `/api/models/${id}/test`, { method: 'POST' });
    assert.equal(tested.status, 200);
    assert.equal(tested.data.ok, true);
    assert.equal(withKey.requests.at(-1).headers.authorization, 'Bearer secret-key');
    assert.equal(withKey.requests.at(-1).path, '/v1/chat/completions');

    const updated = await api(env.base, `/api/models/${id}`, {
      method: 'PUT',
      body: { apiKey: 'wrong-key', timeoutMs: 3000 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.model.hasApiKey, true);
    assert.equal(updated.text.includes('wrong-key'), false);
    const failed = await api(env.base, `/api/models/${id}/test`, { method: 'POST' });
    assert.equal(failed.data.ok, false);
    assert.equal(failed.data.error.code, 'auth');
    assert.equal(failed.text.includes('wrong-key'), false);

    const noKeyCreated = await api(env.base, '/api/models', {
      method: 'POST',
      body: {
        name: '空 Key 本地模型',
        provider: 'openai-compatible',
        baseUrl: noKey.baseUrl,
        modelId: noKey.model,
        apiKey: '',
        timeoutMs: 5000,
      },
    });
    assert.equal(noKeyCreated.status, 201);
    assert.equal(noKeyCreated.data.model.hasApiKey, false);
    const noKeyTest = await api(env.base, `/api/models/${noKeyCreated.data.model.id}/test`, { method: 'POST' });
    assert.equal(noKeyTest.data.ok, true);
    assert.equal(noKey.requests.at(-1).headers.authorization, undefined);

    const invalid = await api(env.base, '/api/models', {
      method: 'POST',
      body: { name: '', baseUrl: 'nope', modelId: '' },
    });
    assert.equal(invalid.status, 400);

    const dafeiyuUpdated = await api(env.base, '/api/dafeiyu/config', {
      method: 'PUT',
      body: { bridgeUrl: 'http://127.0.0.1:12393', token: 'dafeiyu-secret' },
    });
    assert.equal(dafeiyuUpdated.status, 200);
    assert.equal(dafeiyuUpdated.data.dafeiyu.hasToken, true);
    assert.equal(dafeiyuUpdated.text.includes('dafeiyu-secret'), false);
    const dafeiyuConfig = await api(env.base, '/api/dafeiyu/config');
    assert.equal(dafeiyuConfig.text.includes('dafeiyu-secret'), false);
  } finally {
    await env.close();
    await withKey.close();
    await noKey.close();
  }
});

test('HTTP 对局流程：落子、SSE、暂停/继续、历史、结束与导出', async () => {
  const env = await startApp({ matchSettings: { aiMoveDelayMs: 0, initialAiDelayMs: 0 } });
  let abort = null;
  try {
    const created = await api(env.base, '/api/matches', {
      method: 'POST',
      body: {
        gameId: 'gomoku',
        seats: {
          black: { kind: 'human' },
          white: { kind: 'bot' },
        },
        dafeiyu: { enabled: false },
      },
    });
    assert.equal(created.status, 201);
    const match = created.data.match;
    assert.equal(match.modeLabel.includes('真人'), true);
    assert.equal(match.controls.isHumanTurn, true);

    const controller = new AbortController();
    abort = controller;
    const sseResponse = await fetch(`${env.base}/api/matches/${match.id}/events`, { signal: controller.signal });
    assert.equal(sseResponse.status, 200);
    const reader = sseResponse.body.getReader();
    let sseText = '';
    const readStarted = Date.now();
    while (!sseText.includes('event: match') && Date.now() - readStarted < 3000) {
      const { value, done } = await reader.read();
      if (done) break;
      sseText += new TextDecoder().decode(value);
    }
    assert.match(sseText, /event: match/);
    assert.match(sseText, new RegExp(match.id));

    const action = await api(env.base, `/api/matches/${match.id}/actions`, {
      method: 'POST',
      body: {
        seat: 'black',
        action: { type: 'place', move: 'H8' },
        clientActionId: 'api-action-1',
      },
    });
    assert.equal(action.status, 200);
    assert.equal(action.data.accepted, true);
    const duplicate = await api(env.base, `/api/matches/${match.id}/actions`, {
      method: 'POST',
      body: {
        seat: 'black',
        action: { type: 'place', move: 'H8' },
        clientActionId: 'api-action-1',
      },
    });
    assert.equal(duplicate.data.duplicate, true);
    await waitFor(async () => {
      const state = await api(env.base, `/api/matches/${match.id}`);
      return state.data.match.actionCount === 2;
    }, 6000, '机器人未落子');
    const paused = await api(env.base, `/api/matches/${match.id}/pause`, { method: 'POST', body: {} });
    assert.equal(paused.status, 200);
    assert.equal(paused.data.match.status, 'paused');
    const resumed = await api(env.base, `/api/matches/${match.id}/resume`, { method: 'POST', body: {} });
    assert.equal(resumed.data.match.status, 'playing');
    const ended = await api(env.base, `/api/matches/${match.id}/end`, {
      method: 'POST',
      body: { reason: 'API 测试结束' },
    });
    assert.equal(ended.data.match.status, 'aborted');
    assert.equal(ended.data.match.result, 'aborted');
    abort.abort();
    abort = null;

    const second = await api(env.base, '/api/matches', {
      method: 'POST',
      body: {
        gameId: 'gomoku',
        seats: {
          black: { kind: 'bot' },
          white: { kind: 'bot' },
        },
      },
    });
    const secondId = second.data.match.id;
    await waitFor(async () => {
      const state = await api(env.base, `/api/matches/${secondId}`);
      return state.data.match.status === 'finished';
    }, 30000, '全 AI 对局未结束');
    const finished = await api(env.base, `/api/matches/${secondId}`);
    assert.ok(['win', 'draw', 'black_win', 'white_win'].includes(finished.data.match.result));
    const history = await api(env.base, '/api/matches?status=finished');
    assert.ok(history.data.matches.some((item) => item.id === secondId));
    const historyPlayer = await api(env.base, '/api/matches?player=' + encodeURIComponent('内置机器人'));
    assert.ok(historyPlayer.data.matches.some((item) => item.id === secondId));
    const replay = await api(env.base, `/api/matches/${secondId}/replay`);
    assert.equal(replay.status, 200);
    assert.ok(replay.data.steps.length > 2);
    assert.ok(replay.data.steps.at(-1).view.outcome);
    const exported = await api(env.base, `/api/matches/${secondId}/export`);
    assert.equal(exported.status, 200);
    assert.equal(exported.text.includes('apiKey'), false);
    assert.equal(exported.text.includes('secret-key'), false);
    assert.equal(exported.headers.get('content-disposition')?.startsWith('attachment'), true);
    const html = await api(env.base, '/');
    assert.equal(html.status, 200);
    assert.match(html.text, /viewport/);

    // 保存配置路径与对局，重启后历史回放仍可打开。
    await env.closeKeep();
    const app2 = await createArenaApp({
      configPath: env.configPath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await app2.start({ port: 0, host: '127.0.0.1' });
    try {
      const replayAfter = await api(app2.publicUrl, `/api/matches/${secondId}/replay`);
      assert.equal(replayAfter.status, 200);
      assert.equal(replayAfter.data.totalSteps, replay.data.totalSteps);
      const oldMatch = await api(app2.publicUrl, `/api/matches/${secondId}`);
      assert.equal(oldMatch.data.match.status, 'finished');
    } finally {
      await app2.close();
    }
  } finally {
    abort?.abort();
    if (fs.existsSync(env.configPath)) await env.close();
  }
});

test('API 游戏库可从注入注册表列出第二款游戏，SSE/导出不泄露私有状态', async () => {
  const env = await startApp({ gamePlugins: [gomokuGame, threeSeatGame] });
  try {
    const games = await api(env.base, '/api/games');
    assert.equal(games.status, 200);
    assert.deepEqual(games.data.games.map((game) => game.id), ['gomoku', 'three-seat-test']);
    const bootstrap = await api(env.base, '/api/bootstrap');
    assert.deepEqual(bootstrap.data.games.map((game) => game.id), ['gomoku', 'three-seat-test']);
    const created = await api(env.base, '/api/matches', {
      method: 'POST',
      body: {
        gameId: 'three-seat-test',
        seats: {
          sun: { kind: 'bot' },
          moon: { kind: 'bot' },
          star: { kind: 'bot' },
        },
        dafeiyu: { enabled: false },
      },
    });
    assert.equal(created.status, 201);
    const id = created.data.match.id;
    await waitFor(async () => (await api(env.base, `/api/matches/${id}`)).data.match.status === 'finished', 10000, '三席 API 对局未结束');
    const publicText = (await api(env.base, `/api/matches/${id}`)).text;
    assert.doesNotMatch(publicText, /SUN-SECRET|MOON-SECRET|STAR-SECRET|privateTargets|secretNote/);
    const exported = (await api(env.base, `/api/matches/${id}/export`)).text;
    assert.doesNotMatch(exported, /SUN-SECRET|MOON-SECRET|STAR-SECRET|privateTargets|secretNote/);

    const controller = new AbortController();
    const response = await fetch(`${env.base}/api/matches/${id}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    controller.abort();
    const sseText = new TextDecoder().decode(first.value ?? new Uint8Array());
    assert.match(sseText, /event: match/);
    assert.doesNotMatch(sseText, /SUN-SECRET|MOON-SECRET|STAR-SECRET|privateTargets|secretNote/);
  } finally {
    await env.close();
  }
});

test('离开对局 API 暂停棋手局并释放大肥鱼会话', async () => {
  const pet = await createMockDafeiyu();
  const env = await startApp({ dafeiyuUrl: pet.url });
  try {
    const created = await api(env.base, '/api/matches', {
      method: 'POST',
      body: {
        gameId: 'gomoku',
        seats: {
          black: { kind: 'human' },
          white: { kind: 'dafeiyu', moveMode: 'assisted' },
        },
        dafeiyu: { enabled: true, autoComment: false, voice: false },
      },
    });
    const id = created.data.match.id;
    await waitFor(async () => (await api(env.base, `/api/matches/${id}`)).data.match.dafeiyu.status === 'connected', 5000, '大肥鱼未连接');
    const left = await api(env.base, `/api/matches/${id}/leave`, {
      method: 'POST',
      body: { reason: 'API 测试离开' },
    });
    assert.equal(left.status, 200);
    assert.equal(left.data.match.status, 'paused');
    assert.equal(left.data.match.pause.code, 'page_left');
    assert.equal(left.data.match.dafeiyu.status, 'disconnected');
    await waitFor(() => pet.state.sessions.size === 0, 3000, '会话没有释放');
  } finally {
    await env.close();
    await pet.close();
  }
});

test('最后一个 SSE 页面关闭后暂停普通模型回合，其他页面仍连接时不中断', async () => {
  const mock = await createMockOpenAI({
    delayMs: 7000,
    responder: () => JSON.stringify({ move: 'A1' }),
  });
  const env = await startApp({
    models: [{
      id: 'slow-model',
      name: '慢模型',
      provider: 'openai-compatible',
      baseUrl: mock.baseUrl,
      modelId: mock.model,
      timeoutMs: 9000,
      maxRetries: 0,
    }],
  });
  const viewers = [new AbortController(), new AbortController()];
  try {
    const created = await api(env.base, '/api/matches', {
      method: 'POST',
      body: {
        gameId: 'gomoku',
        seats: { black: { kind: 'human' }, white: { kind: 'model', modelId: 'slow-model' } },
      },
    });
    assert.equal(created.status, 201);
    const matchPath = '/api/matches/' + created.data.match.id;
    await Promise.all(viewers.map(async (viewer) => {
      const stream = await fetch(env.base + matchPath + '/events', { signal: viewer.signal });
      assert.equal(stream.status, 200);
      assert.match(new TextDecoder().decode((await stream.body.getReader().read()).value), /event: match/);
    }));
    const readMatch = async () => (await api(env.base, matchPath)).data.match;
    await waitFor(async () => (await readMatch()).viewers === 2);
    await api(env.base, matchPath + '/actions', {
      method: 'POST',
      body: { seat: 'black', action: { type: 'place', move: 'H8' } },
    });
    await waitFor(() => mock.requests.length === 1);
    viewers[0].abort();
    await waitFor(async () => (await readMatch()).viewers === 1);
    const stillWatching = await api(env.base, matchPath + '/leave', { method: 'POST', body: {} });
    assert.equal(stillWatching.data.match.status, 'playing');
    viewers[1].abort();
    const paused = await waitFor(async () => {
      const snapshot = await readMatch();
      return snapshot.status === 'paused' ? snapshot : null;
    }, 6500);
    assert.equal(paused.viewers, 0);
    assert.equal(paused.pause.code, 'page_left');
    assert.equal(paused.pending, null);
    assert.equal(paused.actionCount, 1);
    assert.equal(mock.requests.length, 1);
  } finally {
    viewers.forEach((viewer) => viewer.abort());
    await env.close();
    await mock.close();
  }
});

test('非法 Origin 被拒绝；本机 Origin 可创建对局', async () => {
  const env = await startApp();
  try {
    const rejected = await api(env.base, '/api/matches', {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
      body: { gameId: 'gomoku', seats: { black: { kind: 'bot' }, white: { kind: 'bot' } } },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.data.error.code, 'origin_rejected');
    const origin = new URL(env.base).origin;
    const accepted = await api(env.base, '/api/matches', {
      method: 'POST',
      headers: { Origin: origin },
      body: {
        gameId: 'gomoku',
        seats: {
          black: { kind: 'human' },
          white: { kind: 'bot' },
        },
      },
    });
    assert.equal(accepted.status, 201);
    const wrongMedia = await fetch(`${env.base}/api/matches`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ gameId: 'gomoku' }),
    });
    assert.equal(wrongMedia.status, 415);
  } finally {
    await env.close();
  }
});

test('大肥鱼健康接口和配置可检查；桌宠离线给出明确状态', async () => {
  const pet = await createMockDafeiyu();
  const env = await startApp({ dafeiyuUrl: pet.url });
  try {
    const health = await api(env.base, '/api/dafeiyu/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.online, true);
    pet.setOnline(false);
    const offline = await api(env.base, '/api/dafeiyu/health');
    assert.equal(offline.data.online, false);
  } finally {
    await env.close();
    await pet.close();
  }
});

test('模型监控与固定局面测速：原生开关、指标持久化、原棋局不变', async()=>{
  const mock=await createMockOpenAI({responder:()=>({content:'{"move":"H8"}'})});
  const model={id:'benchmark-model',name:'测速模型',provider:'openai-compatible',baseUrl:mock.baseUrl,modelId:mock.model,apiKey:'private-benchmark-key',timeoutMs:2000,maxRetries:0,reasoningAdapter:'qwen',thinkingMode:'on',reasoningEffort:'default',maxOutputTokens:1024};
  const env=await startApp({models:[model]});
  try{
    const match=await api(env.base,'/api/matches',{method:'POST',body:{gameId:'gomoku',seats:{black:{kind:'human'},white:{kind:'bot'}}}});
    assert.equal(match.status,201);
    const id=match.data.match.id;
    const preview=await api(env.base,'/api/models/reasoning-preview',{method:'POST',body:model});
    assert.deepEqual(preview.data.profile.efforts,['default']);
    const job=await api(env.base,'/api/monitor/benchmarks',{method:'POST',body:{matchId:id,modelId:model.id,step:0,repetitions:2,variants:[{thinkingMode:'on'},{thinkingMode:'off'}]}});
    assert.equal(job.status,202);
    await waitFor(()=>env.app.benchmarks.list().some(j=>j.status==='completed'),5000);
    const monitor=await api(env.base,'/api/monitor?task=benchmark');
    assert.equal(monitor.data.count,4);
    assert.ok(monitor.data.groups.every(g=>g.legalRate===1));
    assert.equal(new Set(mock.requests.map(r=>r.body.chat_template_kwargs.enable_thinking)).size,2);
    assert.equal(env.app.matchService.matches.get(id).actions.length,0);
    assert.equal(env.app.configStore.modelConfig(model.id).thinkingMode,'on');
    assert.doesNotMatch(JSON.stringify(monitor.data),/private-benchmark-key|"messages"|"content"/);
    const invalid=await api(env.base,'/api/monitor/benchmarks',{method:'POST',body:{matchId:id,modelId:model.id,step:999,repetitions:1,variants:[{}]}});
    assert.equal(invalid.status,400);
  }finally{await env.close();await mock.close();}
});

test('监控对局筛选与模型、桌游筛选相交，导出使用同一范围',async()=>{
  const env=await startApp();
  try{
    for(const row of [
      {matchId:'one',modelId:'a',gameId:'gomoku'},
      {matchId:'two',modelId:'a',gameId:'gomoku'},
      {matchId:'one',modelId:'b',gameId:'splendor'},
    ])env.app.monitor.start({...row,task:'move'}).finish('completed',{elapsedMs:100});
    for(const endpoint of ['/api/monitor','/api/monitor/export']){
      const scoped=await api(env.base,endpoint+'?matchId=one');
      assert.equal(scoped.data.count,2);assert.ok(scoped.data.recent.every(r=>r.matchId==='one'));
      const combined=await api(env.base,endpoint+'?matchId=one&modelId=a&gameId=gomoku');
      assert.equal(combined.data.count,1);assert.equal(combined.data.recent[0].modelId,'a');
      const empty=await api(env.base,endpoint+'?matchId=two&gameId=splendor');assert.equal(empty.data.count,0);
    }
  }finally{await env.close();}
});

test('限时模式保留思考参数，聊天暂停等待当前步完成',async()=>{
  const mock=await createMockOpenAI({delayMs:150,responder:()=>({content:'{"move":"H8"}'})});
  const model={id:'timed-native',name:'原生思考',provider:'openai-compatible',baseUrl:mock.baseUrl,modelId:mock.model,timeoutMs:3000,maxRetries:0,reasoningAdapter:'qwen',thinkingMode:'on',reasoningEffort:'default',maxOutputTokens:4096};
  const env=await startApp({models:[model]});
  try{
    const created=await api(env.base,'/api/matches',{method:'POST',body:{gameId:'gomoku',aiPace:'fast',seats:{black:{kind:'model',modelId:model.id},white:{kind:'human'}}}});
    const id=created.data.match.id;
    await waitFor(()=>mock.requests.length>0,2000);
    const pause=await api(env.base,'/api/matches/'+id+'/pause-after-move',{method:'POST',body:{}});
    assert.equal(pause.status,200);
    await waitFor(()=>env.app.matchService.matches.get(id).status==='paused',3000);
    const match=env.app.matchService.matches.get(id);
    assert.equal(match.actions.length,1);
    assert.equal(mock.requests[0].body.chat_template_kwargs.enable_thinking,true);
    assert.equal(mock.requests[0].body.max_tokens,4096);
    assert.match(match.pause.reason,/当前步/);
    const timing=await api(env.base,'/api/monitor/matches/'+id);
    assert.equal(timing.status,200);
    assert.equal(timing.data.seats[0].moveCount,1);
    assert.ok(timing.data.seats[0].totalMs>0);
    assert.equal(timing.data.seats[1].totalMs,null);
    assert.equal(timing.data.rows[0].cells.black.step,1);
    assert.equal(timing.data.requests.length,1);
    assert.doesNotMatch(JSON.stringify(timing.data),/"messages"|"content"|"apiKey"/);
  }finally{await env.close();await mock.close();}
});
