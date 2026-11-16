import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceHarness, waitFor } from './helpers/service-harness.mjs';
import { createMockDafeiyu } from './helpers/mock-dafeiyu.mjs';

test('重放真实卡局关键局面：轮到白方大肥鱼时，威胁点评不会抢占落子', async () => {
  const whiteMoves = ['H7', 'I8', 'J9', 'K5'];
  let whiteIndex = 0;
  const mock = await createMockDafeiyu({
    moveResponder: () => {
      const move = whiteMoves[whiteIndex];
      whiteIndex += 1;
      return JSON.stringify({ move, say: whiteIndex < 4 ? '本鲸先挡这里。' : '只剩一条线，挡不住了。' });
    },
    commentDelayMs: 80,
    commentText: (event) => {
      if (event?.type === 'game_end') return '（叹气）这局漏了另一头，输了就输了。';
      return '（瞪眼）黑方 F10 和 K5 都能成五，白方一手堵不住。';
    },
  });
  const harness = await createServiceHarness({
    dafeiyuUrl: mock.url,
    matchSettings: { aiMoveDelayMs: 0, initialAiDelayMs: 0, autoCommentCooldownMs: 0 },
  });
  try {
    const created = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: {
        black: { kind: 'human' },
        white: { kind: 'dafeiyu', moveMode: 'assisted' },
      },
      dafeiyu: { enabled: true, autoComment: true, voice: false },
    });
    harness.subscribe(created.id);
    await waitFor(() => harness.service.getMatch(created.id).dafeiyu.status === 'connected', {
      timeoutMs: 5000,
      message: '大肥鱼没有连接',
    });
    const play = async (move, waitActionCount) => {
      await harness.service.submitHumanAction(created.id, {
        seat: 'black',
        action: { type: 'place', move },
      });
      if (waitActionCount != null) {
        await waitFor(() => harness.service.getMatch(created.id).actionCount >= waitActionCount, {
          timeoutMs: 5000,
          message: `等待白方落子 ${move} 后超时`,
        });
      }
    };
    await play('H8', 2);
    await play('I7', 4);
    await play('G9', 6);
    // 第 7 手 J6 后轮到白方大肥鱼；黑方在 F10/K5 同时有两个一步成五点。
    await play('J6', 7);
    const critical = harness.service.getMatch(created.id);
    assert.equal(critical.turnSeat, 'white');
    assert.equal(critical.status, 'playing');
    assert.equal(critical.pause, null);
    // 白方先走合法棋，随后黑方自然成五。大肥鱼的点评不能把落子锁死。
    await waitFor(() => harness.service.getMatch(created.id).actionCount >= 8, {
      timeoutMs: 5000,
      message: '关键局面白方没有落子',
    });
    const afterWhite = harness.service.getMatch(created.id);
    assert.equal(afterWhite.actionCount, 8);
    assert.equal(afterWhite.actions[7].seat, 'white');
    assert.equal(afterWhite.actions[7].action.move, 'K5');
    assert.equal(afterWhite.status, 'playing');
    assert.equal(afterWhite.pause, null);
    // 让可能存在的威胁点评完成；它不应影响落子。
    await new Promise((resolve) => setTimeout(resolve, 120));
    await play('F10');
    await waitFor(() => harness.service.getMatch(created.id).status === 'finished', {
      timeoutMs: 5000,
      message: '关键局面没有自然结束',
    });
    const finished = harness.service.getMatch(created.id);
    assert.equal(finished.result, 'win');
    assert.equal(finished.winnerSeat, 'black');
    assert.equal(finished.actionCount, 9);
    assert.equal(finished.pause, null);
    assert.equal(finished.actions[8].action.move, 'F10');
    assert.ok(finished.outcome.line.length >= 5);
    assert.equal(finished.errors.some((error) => /另一局|429|busy/i.test(error.message)), false);
    await waitFor(
      () => harness.service.getMatch(created.id).chat.some(
        (chat) => chat.kind === 'comment' && /^end:win:/.test(chat.eventKey ?? ''),
      ),
      { timeoutMs: 5000, message: '终局点评没有写入聊天' },
    );
    const terminalComment = mock.requestsFor('comment').find(
      (request) => request.body?.event?.type === 'game_end',
    );
    assert.ok(terminalComment);
    assert.equal(terminalComment.body.role, 'player');
    assert.equal(terminalComment.body.seat, 'white');
    assert.match(terminalComment.body.event.summary, /F10/);
    assert.doesNotMatch(terminalComment.body.event.summary, /undefined/);
    const finalChat = harness.service.getMatch(created.id).chat.find(
      (chat) => chat.kind === 'comment' && /^end:win:/.test(chat.eventKey ?? ''),
    );
    assert.equal(finalChat.seat, 'white');
    assert.match(finalChat.text, /输了|漏了/);
    const replay = harness.service.getReplay(created.id);
    assert.equal(replay.steps.length, 10);
    assert.equal(replay.steps.at(-1).view.outcome.winnerSeat, 'black');
    assert.equal(mock.requestsFor('move').length, 4);
    assert.ok(mock.requestsFor('comment').length >= 1);
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});

test('大肥鱼正在落子时提问明确返回 busy，不暂停棋局', async () => {
  const mock = await createMockDafeiyu({
    moveDelayMs: 400,
    moveResponder: () => JSON.stringify({ move: 'H7', say: '先挡。' }),
  });
  const harness = await createServiceHarness({
    dafeiyuUrl: mock.url,
    matchSettings: { aiMoveDelayMs: 0, initialAiDelayMs: 0, autoCommentCooldownMs: 0 },
  });
  try {
    const created = await harness.service.createMatch({
      gameId: 'gomoku',
      seats: {
        black: { kind: 'human' },
        white: { kind: 'dafeiyu', moveMode: 'assisted' },
      },
      dafeiyu: { enabled: true, autoComment: false, voice: false },
    });
    harness.subscribe(created.id);
    await waitFor(() => harness.service.getMatch(created.id).dafeiyu.status === 'connected', {
      timeoutMs: 5000,
      message: '大肥鱼没有连接',
    });
    await harness.service.submitHumanAction(created.id, {
      seat: 'black',
      action: { type: 'place', move: 'H8' },
    });
    await waitFor(() => Boolean(harness.service.getMatch(created.id).pending), {
      timeoutMs: 3000,
      message: '大肥鱼没有开始落子',
    });
    await assert.rejects(
      () => harness.service.askDafeiyu(created.id, { text: '你现在怎么想？' }),
      (error) => error.code === 'dafeiyu_busy' && error.status === 429,
    );
    await waitFor(() => harness.service.getMatch(created.id).actionCount >= 2, {
      timeoutMs: 3000,
      message: '白方落子没有完成',
    });
    const match = harness.service.getMatch(created.id);
    assert.equal(match.status, 'playing');
    assert.equal(match.pause, null);
  } finally {
    await harness.cleanup();
    await mock.close();
  }
});
