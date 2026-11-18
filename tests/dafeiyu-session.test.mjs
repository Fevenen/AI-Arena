import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceHarness, waitFor } from './helpers/service-harness.mjs';
import { createMockDafeiyu } from './helpers/mock-dafeiyu.mjs';

async function connectedMatch(harness, { seat = false, voice = false } = {}) {
  const created = await harness.service.createMatch({
    gameId: 'gomoku',
    seats: seat
      ? { black: { kind: 'human' }, white: { kind: 'dafeiyu', moveMode: 'assisted' } }
      : { black: { kind: 'bot' }, white: { kind: 'bot' } },
    dafeiyu: { enabled: true, autoComment: false, voice },
  });
  harness.subscribe(created.id);
  await waitFor(() => harness.service.getMatch(created.id).dafeiyu.status === 'connected', {
    timeoutMs: 5000,
    message: '大肥鱼没有连接',
  });
  return created.id;
}

test('结束旧局后立即开新局会先释放旧桌宠会话', async () => {
  const mock = await createMockDafeiyu();
  const harness = await createServiceHarness({ dafeiyuUrl: mock.url });
  try {
    const first = await connectedMatch(harness);
    await harness.service.endMatch(first, { reason: '测试结束' });
    assert.equal(mock.state.sessions.size, 1);
    const second = await connectedMatch(harness);
    await waitFor(() => mock.state.sessions.size <= 1, {
      timeoutMs: 3000,
      message: '旧会话没有释放',
    });
    const sessions = [...mock.state.sessions.values()];
    assert.equal(sessions.length, 1);
    assert.ok(mock.requestsFor('leave').length >= 1);
    assert.equal(harness.service.getMatch(second).dafeiyu.status, 'connected');
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('离开棋手对局会释放会话并暂停，重连后可继续', async () => {
  const mock = await createMockDafeiyu();
  const harness = await createServiceHarness({
    dafeiyuUrl: mock.url,
    matchSettings: { aiMoveDelayMs: 1000, initialAiDelayMs: 1000 },
  });
  try {
    const id = await connectedMatch(harness, { seat: true });
    assert.equal(mock.state.sessions.size, 1);
    harness.unsubscribe(id);
    const left = await harness.service.leaveMatch(id, { reason: '页面切换测试' });
    assert.equal(left.status, 'paused');
    assert.equal(left.pause.code, 'page_left');
    assert.equal(left.dafeiyu.status, 'disconnected');
    await waitFor(() => mock.state.sessions.size === 0, {
      timeoutMs: 3000,
      message: '离开后会话没有释放',
    });
    const reconnected = await harness.service.reconnectDafeiyu(id);
    assert.equal(reconnected.dafeiyu.status, 'connected');
    const resumed = harness.service.resumeMatch(id);
    assert.equal(resumed.status, 'playing');
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('关闭语音会取消桌宠里仍在等待的 Arena 播报', async () => {
  const mock = await createMockDafeiyu({ speakStatus: 'queued', speakDelayMs: 150 });
  const harness = await createServiceHarness({ dafeiyuUrl: mock.url });
  try {
    const id = await connectedMatch(harness, { voice: true });
    await harness.service.askDafeiyu(id, { text: '说一句。' });
    await waitFor(() => mock.requestsFor('speak').length >= 1, {
      timeoutMs: 5000,
      message: '没有排队语音',
    });
    await waitFor(
      () => harness.service.getMatch(id).chat.some(
        (chat) => chat.kind === 'answer' && chat.voiceStatus === 'queued',
      ),
      { timeoutMs: 5000, message: '回答没有进入语音排队' },
    );
    const patched = await harness.service.patchDafeiyu(id, { voice: false });
    assert.equal(patched.dafeiyu.voice, false);
    await waitFor(() => mock.requestsFor('speak-cancel').length >= 1, {
      timeoutMs: 5000,
      message: '关闭语音没有取消旧播报',
    });
    assert.ok(mock.state.speechCancelled >= 1);
    // The delayed queue confirmation must not overwrite the cancel status.
    await new Promise((resolve) => setTimeout(resolve, 170));
    const answer = harness.service.getMatch(id).chat.find((chat) => chat.kind === 'answer');
    assert.equal(answer.voiceStatus, 'cancelled');
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('离开/断开时迟到的问答不会回写旧局聊天', async () => {
  const mock = await createMockDafeiyu({ questionDelayMs: 600 });
  const harness = await createServiceHarness({ dafeiyuUrl: mock.url });
  try {
    const id = await connectedMatch(harness);
    const asking = harness.service.askDafeiyu(id, { text: '慢慢回答。' })
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error }));
    await waitFor(() => harness.service.getMatch(id).dafeiyu.busy, {
      timeoutMs: 2000,
      message: '问答没有进入等待',
    });
    harness.unsubscribe(id);
    await harness.service.leaveMatch(id, { reason: '旧局离开' });
    const asked = await asking;
    assert.equal(asked.ok, false);
    assert.ok(['dafeiyu_cancelled', 'dafeiyu_disconnected'].includes(asked.error.code));
    const match = harness.service.getMatch(id);
    assert.equal(match.chat.some((chat) => chat.kind === 'answer'), false);
    assert.equal(match.dafeiyu.status, 'disconnected');
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});
