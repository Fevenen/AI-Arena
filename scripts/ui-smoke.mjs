#!/usr/bin/env node
/**
 * 可选的本机浏览器冒烟检查（Windows / Edge 或 Chrome）。
 *
 * 该脚本使用临时配置启动一套独立竞技场：不会读写 data/arena.json，
 * 也不会使用真实模型或真实大肥鱼。它实际点击网页、开桌、落子、提问、
 * 中断/重连、终局和回放，并把截图写到 data/ui-check/。
 *
 * 运行：node scripts/ui-smoke.mjs
 * 浏览器：自动查找 Edge/Chrome，也可用 BROWSER_PATH 指定。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArenaApp } from '../apps/server/app.mjs';
import { PROJECT_ROOT } from '../apps/server/config-store.mjs';
import { createMockOpenAI } from '../tests/helpers/mock-openai.mjs';
import { createMockDafeiyu } from '../tests/helpers/mock-dafeiyu.mjs';
import { gomokuGame } from '../packages/games/gomoku/index.mjs';
import splendorGame from '../packages/games/splendor/index.mjs';
import { blokusDuoGame } from '../packages/games/blokus-duo/index.mjs';
import { threeSeatGame } from '../tests/fixtures/three-seat-game.mjs';

const SHOT_DIR = path.join(PROJECT_ROOT, 'data', 'ui-check');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((item) => fs.existsSync(item)) ?? null;
}

async function waitFor(condition, { timeoutMs = 10000, intervalMs = 80, message = '条件未满足' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${message}（${timeoutMs}ms）${lastError ? `：${lastError.message}` : ''}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
  return data;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const handler of this.listeners.get(message.method) ?? []) {
          handler(message.params);
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('浏览器连接已关闭'));
      this.pending.clear();
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接浏览器调试接口超时')), 10000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('连接浏览器调试接口失败'));
      }, { once: true });
    });
    return new CDP(ws);
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('浏览器连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 已关闭。
    }
  }
}

async function launchBrowser(edgePath, startUrl) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-arena-edge-'));
  const child = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,1180',
    'about:blank',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  await waitFor(() => fs.existsSync(portFile), { timeoutMs: 15000, message: 'Edge 未启动调试端口' });
  const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
  const port = Number(lines[0]);
  assert.ok(port > 0, '调试端口无效');
  let targets = [];
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await response.json();
      return targets.length > 0;
    } catch {
      return false;
    }
  }, { timeoutMs: 10000, message: '无法读取浏览器页面列表' });
  const pageTarget = targets.find((target) => target.type === 'page') ?? targets[0];
  const cdp = await CDP.open(pageTarget.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1180,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: startUrl });
  return {
    cdp,
    child,
    profileDir,
    async close() {
      try {
        await cdp.send('Browser.close');
      } catch {
        // 浏览器可能已退出。
      }
      cdp.close();
      await sleep(400);
      if (!child.killed) {
        try {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch {
          // 已退出。
        }
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

async function main() {
  const edgePath = findBrowser();
  if (!edgePath) {
    console.error('未找到 Edge 或 Chrome。可用 BROWSER_PATH 指定浏览器路径。');
    process.exit(2);
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-arena-ui-'));
  const modelMock = await createMockOpenAI({ apiKey: 'ui-smoke-key' });
  const petMock = await createMockDafeiyu({
    commentDelayMs: 40,
    answerText: '黑棋右侧那条线要盯紧，下一手很可能就能做文章。',
  });
  const template = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config', 'arena.example.json'), 'utf8'));
  const config = {
    ...template,
    server: { host: '127.0.0.1', port: 0 },
    models: [],
    dafeiyu: {
      ...template.dafeiyu,
      bridgeUrl: petMock.url,
      origin: '',
      timeoutMs: 20000,
      healthIntervalMs: 5000,
    },
    match: {
      ...template.match,
      aiMoveDelayMs: 80,
      initialAiDelayMs: 120,
      autoCommentCooldownMs: 0,
      sseHeartbeatMs: 15000,
    },
    storage: { matchDir: 'matches' },
  };
  const configPath = path.join(tempDir, 'arena.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  let app = null;
  let browser = null;
  const consoleErrors = [];
  const matchIds = [];
  const screenshots = [];

  const api = (pathname, options = {}) => {
    const opts = { ...options };
    if (opts.body !== undefined) {
      opts.headers = { ...(opts.headers ?? {}), 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(opts.body);
    }
    return fetchJson(`${app.publicUrl}${pathname}`, opts);
  };
  const getMatch = async (id) => (await api(`/api/matches/${encodeURIComponent(id)}`)).match;
  const waitMatch = async (id, predicate, timeoutMs = 12000, message = '对局状态未更新') =>
    waitFor(async () => {
      const match = await getMatch(id);
      return predicate(match) ? match : null;
    }, { timeoutMs, message });

  const evaluate = async (expression) => {
    const result = await browser.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面脚本异常');
    }
    return result.result.value;
  };
  const waitPage = async (expression, timeoutMs = 10000, message = '页面条件未满足') => {
    try {
      return await waitFor(() => evaluate(expression), { timeoutMs, message });
    } catch (error) {
      try {
        const url = await evaluate('location.href');
        const body = await evaluate('document.body.innerText.slice(0, 2500)');
        console.error(`[ui-smoke] 页面等待失败: ${message}`);
        console.error(`[ui-smoke] URL: ${url}`);
        console.error(`[ui-smoke] BODY:\n${body}`);
        console.error(`[ui-smoke] Console errors:\n${consoleErrors.join('\n') || '(none)'}`);
        await screenshot('failure-page.png');
      } catch {
        // 页面可能已经崩溃或关闭。
      }
      throw error;
    }
  };
  const click = async (selector) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('找不到元素: ' + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`);
  };
  const setInput = async (selector, value) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('找不到输入框: ' + ${JSON.stringify(selector)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  };
  const setSelect = async (selector, value) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('找不到下拉框: ' + ${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  };
  const setViewport = async (width, height = 1180) => {
    await browser.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(200);
  };
  const screenshot = async (name) => {
    await sleep(240);
    const result = await browser.cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const file = path.join(SHOT_DIR, name);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    screenshots.push(file);
    return file;
  };
  const endMatchIfActive = async (id) => {
    const match = await getMatch(id);
    if (match.status === 'finished' || match.status === 'aborted') return;
    await api(`/api/matches/${encodeURIComponent(id)}/end`, {
      method: 'POST',
      body: { reason: 'UI 冒烟测试清理' },
    });
  };

  try {
    app = await createArenaApp({
      configPath,
      logger: { info() {}, warn() {}, error() {} },
      gamePlugins: [gomokuGame, threeSeatGame, blokusDuoGame, splendorGame],
    });
    await app.start({ port: 0, host: '127.0.0.1' });
    browser = await launchBrowser(edgePath, `${app.publicUrl}/#/lobby`);
    browser.cdp.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'unknown');
    });
    browser.cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push(params.args?.map((item) => item.value ?? item.description ?? '').join(' ') ?? 'console.error');
      }
    });

    await waitPage("document.querySelector('.library-page') !== null", 10000, '桌游库未渲染');
    await screenshot('01-lobby.png');
    const lobbyText = await evaluate('document.body.innerText');
    assert.match(lobbyText, /桌游库/);
    assert.match(lobbyText, /自由五子棋/);
    assert.equal(/鲸局/.test(lobbyText), false);
    assert.equal(await evaluate("document.querySelector('.lobby-hero') === null"), true);

    // ---- 模型管理：通过真实 DOM 新增并测试连接 ----
    await click('a[href="#/models"]');
    await waitPage("document.querySelector('[data-action=create-model]') !== null", 10000, '模型页未渲染');
    await click('[data-action="create-model"]');
    await waitPage("document.querySelector('form[data-form=model]') !== null");
    await setInput('form[data-form="model"] [name="name"]', '浏览器联测模型');
    await setInput('form[data-form="model"] [name="baseUrl"]', `${modelMock.baseUrl}/`);
    await setInput('form[data-form="model"] [name="modelId"]', modelMock.model);
    await setInput('form[data-form="model"] [name="apiKey"]', 'ui-smoke-key');
    await setInput('form[data-form="model"] [name="timeoutMs"]', '5000');
    await setInput('form[data-form="model"] [name="maxRetries"]', '1');
    await click('[data-action="test-draft"]');
    await waitPage("document.querySelector('#draft-test-result .model-test-result.ok') !== null", 12000, '模型测试未成功');
    await screenshot('02-model-modal.png');
    await click('form[data-form="model"] button[type="submit"]');
    await waitPage("document.querySelector('.modal') === null", 10000, '保存模型后弹窗未关闭');
    await waitPage("[...document.querySelectorAll('.model-card')].some(el => el.innerText.includes('浏览器联测模型'))", 10000, '模型卡片未出现');
    const bodyHasSecret = await evaluate("document.body.innerText.includes('ui-smoke-key')");
    assert.equal(bodyHasSecret, false, '浏览器页面泄露了测试 Key');
    await screenshot('03-models.png');
    const modelList = await api('/api/models');
    const testModel = modelList.models.find((model) => model.name === '浏览器联测模型');
    assert.ok(testModel, '新增模型不在 API 列表中');
    assert.equal(testModel.hasApiKey, true);
    assert.equal(JSON.stringify(modelList).includes('ui-smoke-key'), false);
    await click(`[data-action="test-model"][data-id="${testModel.id}"]`);
    await waitPage("document.querySelector('.model-card .model-test-result.ok') !== null", 12000, '保存后的模型测试失败');

    // ---- 开桌、落子、暂停、继续、结束 ----
    await click('a[href="#/lobby"]');
    await waitPage("document.querySelector('[data-action=quick-demo]') !== null", 10000, '返回开桌失败');
    await setSelect('select[data-change="ai-pace"]', 'fast');
    await click('[data-action="quick-demo"]');
    await waitPage("location.hash.startsWith('#/match/') && document.querySelector('.board-grid') !== null", 12000, '对局页未打开');
    const firstMatchId = await evaluate("location.hash.split('/').at(-1)");
    matchIds.push(firstMatchId);
    assert.equal(await evaluate("document.querySelector('#match-title-chips [data-pace=fast]').textContent"), '限时模式 · 每手 25 秒');
    await waitFor(async () => (await getMatch(firstMatchId)).controls.isHumanTurn, {
      timeoutMs: 10000,
      message: '首局没有进入真人回合',
    });
    assert.equal(await evaluate("document.querySelectorAll('.board-grid .cell').length"), 225);
    await click('[data-coord="H8"]');
    await waitMatch(firstMatchId, (match) => match.actionCount >= 1, 10000, '真人落子没有写入');
    await waitMatch(firstMatchId, (match) => match.actionCount >= 2 && !match.pending, 15000, '内置机器人没有回手');
    const firstMatch = await getMatch(firstMatchId);
    assert.equal(firstMatch.state.board[7][7], 'black');
    await screenshot('04-match.png');
    await click('[data-action="pause-match"]');
    await waitMatch(firstMatchId, (match) => match.status === 'paused', 8000, 'UI 暂停未生效');
    await screenshot('05-paused.png');
    await click('[data-action="resume-match"]');
    await waitMatch(firstMatchId, (match) => match.status === 'playing', 8000, 'UI 继续未生效');
    await click('[data-action="end-match"]');
    await waitPage("document.querySelector('.modal [data-action=confirm-dialog]') !== null", 5000, '结束确认框未出现');
    await click('[data-action="confirm-dialog"]');
    await waitMatch(firstMatchId, (match) => match.status === 'aborted', 8000, 'UI 结束对局未生效');
    await waitPage("document.querySelector('.match-status-banner.finished, .match-status-banner.aborted') !== null", 8000, '终局状态未显示');

    // ---- 历史与回放 ----
    await click('a[href="#/history"]');
    await waitPage("document.querySelector('.history-row') !== null", 10000, '历史记录未显示');
    await waitPage(`document.querySelector('[data-action="open-replay"][data-id="${firstMatchId}"]') !== null`, 8000, '历史中没有该局回放入口');
    assert.equal(await evaluate("[...document.querySelectorAll('.history-row')].find(row=>row.querySelector('[data-id=\"" + firstMatchId + "\"]'))?.querySelector('[data-pace=fast]')?.textContent"), '限时模式 · 每手 25 秒');
    await screenshot('06-history.png');
    await click(`[data-action="open-replay"][data-id="${firstMatchId}"]`);
    await waitPage("document.querySelector('.replay-page') !== null && document.querySelectorAll('.board-grid .cell').length === 225", 10000, '回放页未打开');
    assert.equal(await evaluate("document.querySelector('.replay-page [data-pace=fast]').textContent"), '限时模式 · 每手 25 秒');
    await screenshot('07-replay.png');
    const beforeStep = await evaluate("document.querySelector('.replay-progress .mono').innerText");
    await evaluate("document.querySelector('[data-action=replay-prev]').focus(); true");
    await click('[data-action="replay-prev"]');
    await waitPage(`document.querySelector('.replay-progress .mono').innerText !== ${JSON.stringify(beforeStep)}`, 5000, '回放上一手无效');
    assert.equal(await evaluate("document.activeElement.dataset.action === 'replay-prev' || document.activeElement.dataset.change === 'replay-range'"), true);
    await setViewport(480);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'), true);
    await setViewport(1440);
    await click('[data-action="replay-next"]');
    await waitPage(`document.querySelector('.replay-progress .mono').innerText === ${JSON.stringify(beforeStep)}`, 5000, '回放下一手无效');

    // ---- 大肥鱼观战：手动问答、语音开关、重连 ----
    await click('a[href="#/lobby"]');
    await waitPage("document.querySelector('.library-page') !== null");
    await click('input[data-change="lobby-observer"]');
    await waitPage("document.querySelector('input[data-change=lobby-observer]').checked === true", 5000, '未勾选大肥鱼观战');
    await click('[data-action="start-match"]');
    await waitPage("location.hash.startsWith('#/match/') && document.querySelector('.dafeiyu-side') !== null", 12000, '观战对局未打开');
    const watcherMatchId = await evaluate("location.hash.split('/').at(-1)");
    matchIds.push(watcherMatchId);
    await waitMatch(watcherMatchId, (match) => match.dafeiyu?.status === 'connected', 15000, '大肥鱼未连接');
    await setInput('#chat-input', '黑棋现在有什么威胁？');
    await evaluate("document.querySelector('form[data-form=chat]').requestSubmit(); true");
    await waitMatch(watcherMatchId, (match) => (match.chat ?? []).some((item) => item.kind === 'answer'), 15000, '大肥鱼没有回答');
    await waitPage("document.querySelector('.chat-message.dafeiyu .chat-bubble') !== null", 8000, '回答未显示在聊天区');
    await screenshot('08-dafeiyu-chat.png');
    await click('input[data-change="match-voice"]');
    await waitMatch(watcherMatchId, (match) => match.dafeiyu.voice === true, 6000, '语音开关未生效');
    await setInput('#chat-input', '再说一句，声音也打开。');
    await evaluate("document.querySelector('form[data-form=chat]').requestSubmit(); true");
    await waitFor(() => petMock.requestsFor('speak').length > 0, { timeoutMs: 12000, message: '语音开启后没有调用桌宠播报' });
    await waitPage("[...document.querySelectorAll('.voice-note')].some(el => el.innerText.includes('语音已排队'))", 8000, '语音状态未显示');
    const desktopHeaders = { 'X-Arena-Desktop': '1' };
    const desktopState = () => api('/api/desktop-companion', { headers: desktopHeaders }).then(response => response.state);
    assert.equal((await desktopState()).matchId, watcherMatchId);
    assert.equal((await desktopState()).role, 'observer');
    assert.equal((await desktopState()).voice, true);
    await api('/api/desktop-companion', { method: 'POST', headers: desktopHeaders, body: {
      type: 'voice', matchId: watcherMatchId, value: false,
    } });
    await waitPage("!document.querySelector('input[data-change=match-voice]').checked", 6000, '桌宠关闭语音后网页没有同步');
    await api('/api/desktop-companion', { method: 'POST', headers: desktopHeaders, body: {
      type: 'question', matchId: watcherMatchId, text: '这条问题来自桌宠。',
    } });
    await waitPage("document.querySelector('#chat-log').innerText.includes('这条问题来自桌宠。')", 6000, '桌宠问答没有同步到网页');

    await api(`/api/matches/${encodeURIComponent(watcherMatchId)}/dafeiyu/disconnect`, { method: 'POST' });
    await waitMatch(watcherMatchId, (match) => match.dafeiyu?.status === 'disconnected', 8000, '手动断开未生效');
    await waitPage("document.querySelector('.dafeiyu-side [data-action=reconnect-dafeiyu]') !== null", 8000, '断开后没有重连按钮');
    await click('[data-action="reconnect-dafeiyu"]');
    await waitMatch(watcherMatchId, (match) => match.dafeiyu?.status === 'connected', 15000, 'UI 重连大肥鱼失败');
    await endMatchIfActive(watcherMatchId);

    // ---- 大肥鱼棋手：断线暂停、重连、继续、公开想法 ----
    app.configStore.config.match.initialAiDelayMs = 3000;
    app.configStore.config.match.aiMoveDelayMs = 3000;
    await click('a[href="#/lobby"]');
    await waitPage("document.querySelector('.library-page') !== null", 10000, '从观战对局返回桌游库失败');
    await setSelect('select[data-change="seat-kind"][data-seat="black"]', 'dafeiyu');
    await waitPage("document.querySelector('select[data-change=seat-kind][data-seat=black]').value === 'dafeiyu'", 5000, '黑方未切换为大肥鱼');
    const autoChecked = await evaluate("document.querySelector('input[data-change=lobby-auto]').checked");
    if (autoChecked) await click('input[data-change="lobby-auto"]');
    const voiceChecked = await evaluate("document.querySelector('input[data-change=lobby-voice]').checked");
    if (voiceChecked) await click('input[data-change="lobby-voice"]');
    await click('[data-action="start-match"]');
    await waitPage("location.hash.startsWith('#/match/') && document.querySelector('.dafeiyu-side') !== null", 12000, '棋手对局未打开');
    const playerMatchId = await evaluate("location.hash.split('/').at(-1)");
    matchIds.push(playerMatchId);
    await waitMatch(playerMatchId, (match) => match.dafeiyu?.status === 'connected', 15000, '棋手大肥鱼未连接');
    await api(`/api/matches/${encodeURIComponent(playerMatchId)}/dafeiyu/disconnect`, { method: 'POST' });
    await waitMatch(playerMatchId, (match) => match.status === 'paused' && match.pause?.code === 'dafeiyu_disconnected', 8000, '棋手掉线未暂停');
    await waitPage("document.querySelector('.match-status-banner.paused') !== null", 8000, '暂停状态未显示');
    await screenshot('09-dafeiyu-paused.png');
    await click('[data-action="reconnect-dafeiyu"]');
    await waitMatch(playerMatchId, (match) => match.dafeiyu?.status === 'connected', 15000, '棋手重连失败');
    await waitPage("document.querySelector('[data-action=retry-match]') !== null", 5000, '重连后没有继续/重试按钮');
    await click('[data-action="retry-match"]');
    await waitMatch(playerMatchId, (match) => match.status === 'playing', 8000, '重连后继续失败');
    await waitMatch(playerMatchId, (match) => match.actions.some((item) => item.source === 'dafeiyu'), 15000, '大肥鱼没有实际落子');
    await waitPage("document.querySelector('.chat-message.dafeiyu .chat-bubble') !== null", 8000, '棋手公开想法未显示');
    await screenshot('10-dafeiyu-player.png');
    assert.ok((await getMatch(playerMatchId)).actions.some((action) => action.source === 'dafeiyu'));
    await endMatchIfActive(playerMatchId);

    // ---- 全 AI 观战 + 自动点评 ----
    app.configStore.config.match.initialAiDelayMs = 800;
    app.configStore.config.match.aiMoveDelayMs = 120;
    await click('a[href="#/lobby"]');
    await waitPage("document.querySelector('.library-page') !== null");
    await setSelect('select[data-change="seat-kind"][data-seat="black"]', 'bot');
    await waitPage("document.querySelector('select[data-change=seat-kind][data-seat=black]').value === 'bot'", 5000, '黑方未切换为机器人');
    const observerChecked = await evaluate("document.querySelector('input[data-change=lobby-observer]').checked");
    if (!observerChecked) await click('input[data-change="lobby-observer"]');
    const autoChecked2 = await evaluate("document.querySelector('input[data-change=lobby-auto]').checked");
    if (!autoChecked2) await click('input[data-change="lobby-auto"]');
    await click('[data-action="start-match"]');
    await waitPage("location.hash.startsWith('#/match/') && document.querySelector('.dafeiyu-side') !== null", 12000, '全 AI 观战局未打开');
    const autoMatchId = await evaluate("location.hash.split('/').at(-1)");
    matchIds.push(autoMatchId);
    await waitMatch(autoMatchId, (match) => match.dafeiyu?.status === 'connected', 15000, '自动点评大肥鱼未连接');
    // 全 AI 快速推进时输入中文：组词期间 SSE 更新必须延后，输入节点、焦点和光标不能丢。
    await waitPage("document.querySelector('#chat-input') !== null && !document.querySelector('#chat-input').disabled", 8000, '聊天输入框没有启用');
    await evaluate(`(() => {
      const input = document.querySelector('#chat-input');
      input.focus();
      input.value = '全AI推进中测试';
      input.setSelectionRange(4, 4);
      window.__imeInput = input;
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '测试' }));
      input.value = '全AI推进中测试继续';
      input.setSelectionRange(6, 6);
      return true;
    })()`);
    await waitMatch(autoMatchId, (match) => match.actionCount >= 2, 10000, '全 AI 没有继续推进');
    await sleep(220);
    const imeState = await evaluate(`(() => {
      const input = document.querySelector('#chat-input');
      return {
        sameNode: input === window.__imeInput,
        active: document.activeElement.id,
        value: input.value,
        selectionStart: input.selectionStart,
        composing: input.closest('form') !== null,
      };
    })()`);
    assert.deepEqual(imeState, {
      sameNode: true,
      active: 'chat-input',
      value: '全AI推进中测试继续',
      selectionStart: 6,
      composing: true,
    });
    await evaluate(`(() => {
      const input = document.querySelector('#chat-input');
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '继续' }));
      return true;
    })()`);
    await sleep(200);
    await screenshot('11-ime-composing.png');
    await waitMatch(autoMatchId, (match) => (match.chat ?? []).some((item) => item.kind === 'comment'), 45000, '没有产生自动点评');
    await waitPage("document.querySelector('.chat-message.dafeiyu .chat-bubble') !== null", 8000, '自动点评未显示');
    await screenshot('11-auto-comment.png');
    await endMatchIfActive(autoMatchId);

    // ---- 三座位测试插件：游戏库选择、三席行动、结算、回放 ----
    await click('a[href="#/lobby"]');
    await waitPage("document.querySelector('.library-page') !== null", 10000, '三席测试返回桌游库失败');
    await click('[data-action="select-game"][data-game="three-seat-test"]');
    await waitPage("document.querySelector('select[data-change=seat-kind][data-seat=sun]') !== null", 8000, '三席设置未出现');
    await setSelect('select[data-change="seat-kind"][data-seat="sun"]', 'bot');
    await setSelect('select[data-change="seat-kind"][data-seat="moon"]', 'bot');
    await setSelect('select[data-change="seat-kind"][data-seat="star"]', 'bot');
    await click('[data-action="start-match"]');
    await waitPage("location.hash.startsWith('#/match/') && document.querySelector('.three-seat-grid') !== null", 12000, '三席对局未打开');
    const threeSeatId = await evaluate("location.hash.split('/').at(-1)");
    matchIds.push(threeSeatId);
    await waitMatch(threeSeatId, (match) => match.status === 'finished', 15000, '三席对局没有结束');
    assert.equal(await evaluate("document.querySelectorAll('.match-seat').length"), 3);
    assert.equal(await evaluate("document.querySelectorAll('.three-seat-cell').length"), 9);
    await screenshot('12-three-seat.png');
    await click('a[href^="#/replay/"]');
    await waitPage("document.querySelector('.replay-page') !== null && document.querySelectorAll('.three-seat-cell').length === 9", 10000, '三席回放未打开');
    await screenshot('13-three-replay.png');
    await click('a[href="#/lobby"]');
    await waitPage("document.querySelector('.library-page') !== null", 10000, '三席回放返回桌游库失败');

    // ---- 角斗士棋：大厅、选棋/旋转/预览、真人落子、AI 完整局、回放 ----
    await click('[data-action="select-game"][data-game="blokus-duo"]');
    await waitPage("document.querySelector('[data-seat=gold]') !== null && document.querySelectorAll('.seat-setup').length === 2", 8000, '角斗士棋座位配置未出现');
    await click('[data-action="start-match"]');
    await waitPage("location.hash.startsWith('#/match/') && document.querySelector('.blokus-board') !== null", 12000, '角斗士棋对局未打开');
    const blokusId = await evaluate("location.hash.split('/').at(-1)");
    matchIds.push(blokusId);
    assert.equal(await evaluate("document.querySelectorAll('.blokus-cell').length"), 196);
    assert.equal(await evaluate("document.querySelectorAll('.blokus-piece').length"), 21);
    assert.equal(await evaluate("document.querySelectorAll('.blokus-cell.start-point').length"), 2);

    await evaluate("document.querySelector('.match-page .back-link').focus()");
    await click('[data-action="blokus-piece"][data-piece="P3-02"]');
    assert.equal(await evaluate("document.activeElement.matches('.match-page .back-link')"), true, '角斗士棋刷新不应把焦点抢到棋盘');
    const selectedShape = () => evaluate("Array.from(document.querySelectorAll('.blokus-selected .blokus-mini i'), cell => [cell.style.gridRow, cell.style.gridColumn]).sort()");
    assert.deepEqual(await selectedShape(), [['1', '1'], ['1', '2'], ['2', '1']]);
    await click('[data-action="blokus-flip"]');
    assert.deepEqual(await selectedShape(), [['1', '1'], ['1', '2'], ['2', '2']], 'L 形棋子翻面后的缩略图必须真实镜像');
    await click('[data-action="blokus-flip"]');
    assert.deepEqual(await selectedShape(), [['1', '1'], ['1', '2'], ['2', '1']]);
    await click('[data-action="blokus-cancel"]');

    await evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'test-short-tray';
      style.textContent = '.blokus-tray { max-height: 47px !important }';
      document.head.append(style);
      document.querySelector('.blokus-tray').scrollTop = 50;
    })()`);
    const trayScroll = await evaluate("document.querySelector('.blokus-tray').scrollTop");
    assert.ok(trayScroll > 0);
    await click('[data-action="blokus-piece"][data-piece="P5-09"]');
    assert.equal(await evaluate("document.querySelector('.blokus-tray').scrollTop"), trayScroll);
    await evaluate("document.getElementById('test-short-tray').remove()");
    const firstOrientation = await evaluate("document.querySelector('.blokus-selected small')?.innerText ?? ''");
    await click('[data-action="blokus-rotate"]');
    const rotated = await evaluate("document.querySelector('.blokus-selected small')?.innerText ?? ''");
    assert.notEqual(rotated, firstOrientation);
    await click('[data-action="blokus-flip"]');
    const flipped = await evaluate("document.querySelector('.blokus-selected small')?.innerText ?? ''");
    assert.notEqual(flipped, rotated);
    await click('[data-action="blokus-cancel"]');

    await click('[data-action="blokus-piece"][data-piece="P2-01"]');
    await click('.blokus-cell[data-coord="E6"]');
    assert.ok(await evaluate("document.querySelectorAll('.blokus-cell.preview-invalid').length > 0"));
    assert.match(await evaluate("document.querySelector('.blokus-preview')?.innerText ?? ''"), /起始点|己方棋边/);
    assert.equal((await getMatch(blokusId)).actionCount, 0);
    await screenshot('16-blokus-invalid-preview.png');

    await click('[data-action="blokus-cancel"]');
    await click('[data-action="blokus-piece"][data-piece="P1-01"]');
    await click('.blokus-cell[data-coord="E5"]');
    assert.ok(await evaluate("document.querySelectorAll('.blokus-cell.preview-valid').length === 1"));
    await screenshot('16-blokus-preview.png');
    await click('[data-action="pause-match"]');
    await waitPage("document.querySelectorAll('.blokus-tray .blokus-piece:disabled').length === 21", 8000, '暂停时仍应显示真人自己的棋子托盘');
    await click('[data-action="resume-match"]');
    await waitPage("document.querySelector('[data-action=blokus-confirm]:enabled') !== null", 8000, '恢复后应保留尚未提交的落子预览');
    await click('[data-action="blokus-confirm"]');
    await waitMatch(blokusId, (match) => match.actionCount >= 2 && !match.pending, 15000, '角斗士棋真人/机器人没有完成一手');
    assert.equal((await getMatch(blokusId)).actions[0].seat, 'gold');
    await screenshot('17-blokus-match.png');
    await setViewport(900);
    await screenshot('19-blokus-900.png');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'), true);
    await setViewport(480);
    await screenshot('20-blokus-480.png');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'), true);
    assert.ok(await evaluate("document.querySelectorAll('.blokus-cell').length === 196"));
    await setViewport(1440);
    await endMatchIfActive(blokusId);

    const aiBlokus = await api('/api/matches', {
      method: 'POST',
      body: {
        gameId: 'blokus-duo',
        seats: { gold: { kind: 'bot' }, blue: { kind: 'bot' } },
        dafeiyu: { enabled: false },
      },
    });
    const aiBlokusId = aiBlokus.match.id;
    matchIds.push(aiBlokusId);
    const finishedAi = await waitMatch(
      aiBlokusId,
      (match) => match.status === 'finished' ? match : null,
      20000,
      '角斗士棋双机器人对局没有结束',
    );
    assert.ok(finishedAi.outcome?.scores?.gold);
    await evaluate(`location.hash = '#/replay/${encodeURIComponent(aiBlokusId)}'`);
    await waitPage("document.querySelector('.blokus-board') !== null && document.querySelector('.blokus-final-summary') !== null", 12000, '角斗士棋回放未打开');
    assert.equal(await evaluate("document.querySelectorAll('.blokus-cell').length"), 196);
    assert.match(await evaluate("document.querySelector('.blokus-final-summary').innerText"), /分/);
    await screenshot('18-blokus-replay.png');
    await click('a[href="#/lobby"]');
    await waitPage("document.querySelector('.library-page') !== null", 10000, '角斗士棋回放返回桌游库失败');

    // ---- 璀璨宝石多人牌桌与私有视图 ----
    await click('[data-action="select-game"][data-game="splendor"]');
    await setSelect('select[data-change="player-count"]', '4');
    assert.equal(await evaluate("document.querySelectorAll('.seat-setup').length"), 4);
    await click('[data-action="start-match"]');
    await waitPage("document.querySelector('.splendor-surface') && document.querySelector('[data-move=\"reserve:deck1\"]')", 12000, '璀璨宝石牌桌未打开');
    const splendorId = await evaluate("location.hash.split('/').at(-1)");
    matchIds.push(splendorId);
    await click('[data-move="reserve:deck1"]');
    await waitPage("document.querySelector('.spl-reserved .spl-card') !== null", 12000, '真人席没有看到自己的预留暗牌');
    const splendorReplay = await api('/api/matches/' + splendorId + '/replay');
    assert.equal(splendorReplay.seed, null);
    assert.ok(splendorReplay.steps.every(step => step.view.players.east.reserved === undefined));
    await screenshot('22-splendor-table.png');
    await setViewport(480);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'), true);
    await screenshot('23-splendor-480.png');
    await setViewport(1440);
    await endMatchIfActive(splendorId);
    await click('a[href="#/lobby"]');
    await waitPage("document.querySelector('.library-page') !== null", 10000, '璀璨宝石已结束但未回到桌游库');

    // ---- 常见 Windows 宽度与窄窗口 ----
    await setViewport(900);
    await screenshot('14-lobby-900.png');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'), true);
    await setViewport(480);
    await screenshot('15-lobby-480.png');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'), true);
    await setViewport(1440);

    // ---- 公开配置与安全 ----
    const finalModels = await api('/api/models');
    assert.equal(JSON.stringify(finalModels).includes('ui-smoke-key'), false);
    const exported = await fetch(`${app.publicUrl}/api/matches/${firstMatchId}/export`).then((r) => r.text());
    assert.equal(exported.includes('ui-smoke-key'), false);
    assert.equal(consoleErrors.length, 0, `浏览器出现脚本错误：\n${consoleErrors.join('\n')}`);

    const summary = {
      ok: true,
      url: app.publicUrl,
      browser: edgePath,
      matchIds,
      screenshots: screenshots.map((file) => path.relative(PROJECT_ROOT, file)),
      modelTested: testModel.name,
      dafeiyuRequests: {
        comment: petMock.requestsFor('comment').length,
        question: petMock.requestsFor('question').length,
        move: petMock.requestsFor('move').length,
        speak: petMock.requestsFor('speak').length,
      },
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    for (const id of matchIds) {
      try {
        await endMatchIfActive(id);
      } catch {
        // 已结束或服务已关闭。
      }
    }
    if (browser) await browser.close();
    if (app) await app.close();
    await petMock.close();
    await modelMock.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`UI 冒烟测试失败：${error.stack ?? error.message}`);
  process.exit(1);
});
