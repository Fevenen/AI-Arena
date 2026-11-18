import assert from 'node:assert/strict';
import test from 'node:test';

import blokusDuoGame from '../packages/games/blokus-duo/index.mjs';
import { PIECES } from '../packages/games/blokus-duo/pieces.mjs';
import { START_POINTS, createInitialState, seatLabel } from '../packages/games/blokus-duo/rules.mjs';
import { createServiceHarness, waitFor } from './helpers/service-harness.mjs';
import { createMockOpenAI } from './helpers/mock-openai.mjs';

const game = blokusDuoGame;

function apply(state, seat, action) {
  return game.applyAction(state, seat, action).state;
}

function firstTwo(anchorGold = 'E5', anchorBlue = 'J10') {
  let state = createInitialState();
  state = apply(state, 'gold', { type: 'place', pieceId: 'P1-01', orientation: 0, anchor: anchorGold });
  state = apply(state, 'blue', { type: 'place', pieceId: 'P1-01', orientation: 0, anchor: anchorBlue });
  return state;
}

function cellsIncludeStart(cells, start) {
  return cells.some(([row, col]) => row === start.row && col === start.col);
}

function fullBoard(empty = []) {
  const board = Array.from({ length: 14 }, (_, row) => Array.from({ length: 14 }, (_, col) => (
    (row + col) % 2 === 0 ? 'gold' : 'blue'
  )));
  for (const [row, col] of empty) board[row][col] = null;
  return board;
}

test('21 块标准自由多连方、尺寸计数与朝向去重', () => {
  assert.equal(PIECES.length, 21);
  const bySize = new Map();
  for (const piece of PIECES) {
    bySize.set(piece.size, (bySize.get(piece.size) ?? 0) + 1);
    const keys = new Set();
    for (const orientation of piece.orientations) {
      const key = orientation.cells.map(([row, col]) => `${row},${col}`).join(';');
      assert.equal(keys.has(key), false, `${piece.id} 出现重复朝向 ${key}`);
      keys.add(key);
      assert.equal(orientation.index, piece.orientations.indexOf(orientation));
    }
  }
  assert.deepEqual(Object.fromEntries([...bySize].sort((a, b) => a[0] - b[0])), {
    1: 1, 2: 1, 3: 2, 4: 5, 5: 12,
  });
  assert.equal(new Set(PIECES.map((piece) => piece.id)).size, 21);
  assert.equal(PIECES.find((piece) => piece.id === 'P4-04').orientations.length, 1);
  assert.equal(PIECES.find((piece) => piece.id === 'P1-01').orientations.length, 1);
});

test('初始局面、E5/J10 起点和先手/后手第一块', () => {
  const initial = createInitialState();
  assert.equal(game.getCurrentActor(initial), 'gold');
  assert.equal(game.seats[0].id, 'gold');
  assert.equal(game.seats[0].name, '红方');
  assert.equal(game.seats[0].shortName, '红');
  assert.equal(game.seats[0].color, 'red');
  assert.equal(game.seats[1].name, '蓝方');
  assert.equal(game.seats[1].color, 'blue');
  assert.equal(seatLabel('gold'), '红方');
  assert.equal(seatLabel('blue'), '蓝方');
  assert.deepEqual(START_POINTS.map((point) => point.label), ['E5', 'J10']);
  const firstActions = game.legalActions(initial, 'gold');
  assert.ok(firstActions.length > 0);
  for (const action of firstActions) {
    const starts = START_POINTS.filter((start) => cellsIncludeStart(action.cells, start));
    assert.equal(starts.length, 1, `${action.pieceId}@${action.anchor} 应只覆盖一个起始点`);
  }

  let state = apply(initial, 'gold', { type: 'place', pieceId: 'P1-01', orientation: 0, anchor: 'E5' });
  assert.equal(state.turn, 'blue');
  assert.equal(state.chosenStart, 0);
  assert.equal(game.validateAction(state, 'blue', {
    type: 'place', pieceId: 'P1-01', orientation: 0, anchor: 'E5',
  }).code, 'occupied');
  const blueWrong = game.validateAction(state, 'blue', {
    type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'A1',
  });
  assert.equal(blueWrong.ok, false);
  assert.equal(blueWrong.code, 'start_required');
  state = apply(state, 'blue', { type: 'place', pieceId: 'P1-01', orientation: 0, anchor: 'J10' });
  assert.equal(state.turn, 'gold');
  assert.equal(state.firstMoves.gold, true);
  assert.equal(state.firstMoves.blue, true);

  let mirrored = apply(createInitialState(), 'gold', {
    type: 'place', pieceId: 'P1-01', orientation: 0, anchor: 'J10',
  });
  mirrored = apply(mirrored, 'blue', {
    type: 'place', pieceId: 'P1-01', orientation: 0, anchor: 'E5',
  });
  assert.equal(mirrored.chosenStart, 1);
  assert.equal(mirrored.outcome, null);
});

test('角接触、同色贴边、重叠、越界、重复用棋子', () => {
  const state = firstTwo();
  const corner = game.validateAction(state, 'gold', {
    type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'F6',
  });
  assert.equal(corner.ok, true);

  const edge = game.validateAction(state, 'gold', {
    type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'E6',
  });
  assert.equal(edge.ok, false);
  assert.equal(edge.code, 'edge_contact');
  assert.match(edge.message, /己方棋边/);

  const detached = game.validateAction(state, 'gold', {
    type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'A1',
  });
  assert.equal(detached.ok, false);
  assert.equal(detached.code, 'no_corner');

  const overlap = game.validateAction(state, 'gold', {
    type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'E5',
  });
  assert.equal(overlap.ok, false);
  assert.equal(overlap.code, 'occupied');

  const outside = game.validateAction(state, 'gold', {
    type: 'place', pieceId: 'P5-01', orientation: 0, anchor: 'N14',
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'out_of_bounds');

  const custom = structuredClone(state);
  custom.inventories.gold = custom.inventories.gold.filter((id) => id !== 'P2-01');
  const reused = game.validateAction(custom, 'gold', {
    type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'F6',
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.code, 'piece_used');
});

test('异色贴边允许，且仍要求己方角接触', () => {
  const state = firstTwo();
  state.board[4][4] = 'gold'; // E5
  state.board[5][4] = 'blue'; // E6
  state.inventories.gold = state.inventories.gold.filter((id) => id !== 'P1-01');
  state.inventories.blue = state.inventories.blue.filter((id) => id !== 'P1-01');
  const valid = game.validateAction(state, 'gold', {
    type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'F6',
  });
  assert.equal(valid.ok, true, valid.message);
  const noCorner = game.validateAction(state, 'gold', {
    type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'H8',
  });
  assert.equal(noCorner.ok, false);
  assert.equal(noCorner.code, 'no_corner');
});

test('一方无合法摆法时系统跳过，另一方继续；跳过写入动作', () => {
  const state = firstTwo();
  state.inventories.gold = [];
  state.inventories.blue = ['P1-01', 'P2-01'];
  assert.equal(game.legalActions(state, 'gold').length, 0);
  const automatic = game.getAutomaticAction({ state, seatId: 'gold' });
  assert.deepEqual(automatic, { type: 'pass', reason: 'no_legal_move' });
  const checked = game.validateAction(state, 'gold', automatic);
  assert.equal(checked.ok, true);
  const next = apply(state, 'gold', automatic);
  assert.equal(next.turn, 'blue');
  assert.equal(next.passed.gold, true);
  assert.equal(next.lastAction.type, 'pass');
  const blue = game.legalActions(next, 'blue');
  assert.ok(blue.length > 0);
  const blueAction = blue.find((action) => action.pieceId === 'P1-01') ?? blue[0];
  const afterBlue = apply(next, 'blue', blueAction);
  assert.equal(afterBlue.outcome, null);
  assert.equal(afterBlue.turn, 'gold');
  assert.equal(game.getAutomaticAction({ state: afterBlue, seatId: 'gold' })?.type, 'pass');
});

test('双方都无合法摆法时结算；计分、全放奖励、单格收尾奖励与平局', () => {
  const state = firstTwo();
  state.board = fullBoard();
  state.inventories.gold = [];
  state.inventories.blue = ['P5-01', 'P4-01'];
  state.lastPlacedPiece.gold = 'P1-01';
  state.lastPlacedPiece.blue = 'P2-01';
  const pass = game.validateAction(state, 'gold', { type: 'pass', reason: 'no_legal_move' });
  assert.equal(pass.ok, true);
  const next = apply(state, 'gold', { type: 'pass', reason: 'no_legal_move' });
  assert.equal(next.outcome.type, 'win');
  assert.equal(next.outcome.winnerSeat, 'gold');
  assert.equal(next.scores.gold.unusedSquares, 0);
  assert.equal(next.scores.gold.allPiecesBonus, 15);
  assert.equal(next.scores.gold.monominoBonus, 5);
  assert.equal(next.scores.gold.score, 20);
  assert.equal(next.scores.blue.unusedSquares, 9);
  assert.equal(next.scores.blue.score, -9);

  const drawState = firstTwo();
  drawState.board = fullBoard();
  drawState.inventories.gold = [];
  drawState.inventories.blue = [];
  drawState.lastPlacedPiece.gold = 'P2-01';
  drawState.lastPlacedPiece.blue = 'P2-01';
  const draw = apply(drawState, 'gold', { type: 'pass', reason: 'no_legal_move' });
  assert.equal(draw.outcome.type, 'draw');
  assert.equal(draw.outcome.winnerSeat, null);
  assert.equal(draw.scores.gold.score, 15);
  assert.equal(draw.scores.blue.score, 15);
});

test('纯模型与规则辅助的提示、候选 ID 和严格解析', () => {
  const state = firstTwo();
  const pure = game.describeForModel({ state, seatId: 'gold', mode: 'pure' });
  assert.match(pure.responseFormat, /pieceId/);
  assert.doesNotMatch(pure.responseFormat, /candidate/);
  assert.equal(pure.assistedMode, false);
  assert.match(JSON.stringify(pure), /E5|J10/);
  assert.ok(pure.pieces.length >= 20);
  assert.ok(pure.pieces[0].orientations.length >= 1);
  assert.ok(pure.pieces[0].cells.length >= 1);
  const assisted = game.describeForModel({ state, seatId: 'gold', mode: 'assisted' });
  assert.match(assisted.responseFormat, /candidate/);
  const hints = game.getTacticalHints({ state, seatId: 'gold' });
  assert.ok(hints.legalActions.length > 0);
  assert.ok(hints.candidateInfo.total >= hints.candidateInfo.shown);
  assert.equal(hints.candidateInfo.shown, hints.legalActions.length);
  const repeatedHints = game.getTacticalHints({ state, seatId: 'gold' });
  assert.deepEqual(
    repeatedHints.legalActions.map((item) => item.candidateId),
    hints.legalActions.map((item) => item.candidateId),
    '同一局面重复生成的候选 ID 必须稳定',
  );
  const candidate = hints.legalActions[0].candidateId;
  const parsedCandidate = game.parseModelMove(JSON.stringify({ candidate }));
  assert.equal(parsedCandidate.ok, true);
  assert.equal(parsedCandidate.action.candidateId, candidate);

  const parsedFull = game.parseModelMove(JSON.stringify({
    pieceId: 'P2-01', orientation: 0, anchor: 'F6', say: '测试',
  }));
  assert.equal(parsedFull.ok, true);
  assert.equal(parsedFull.action.anchor, 'F6');
  assert.equal(parsedFull.say, '测试');

  assert.equal(game.parseModelMove('我下 F6').ok, false);
  assert.equal(game.parseModelMove(JSON.stringify({ moves: [] })).ok, false);
  assert.equal(game.parseModelMove(JSON.stringify({ candidate: 'c0' })).ok, false);
  assert.equal(game.parseModelMove(JSON.stringify({ pieceId: 'P2-01', orientation: 0, anchor: 'Z99' })).ok, false);
  assert.equal(game.parseModelMove(JSON.stringify({ pieceId: 'P2-01', orientation: 0, anchor: 'F6', candidate: 'c1' })).ok, false);
  assert.equal(game.parseModelMove('```json\n{"candidate":"c1"}\n```').ok, true);
});

test('内置机器人动作合法、可复现，且能跑完整局', () => {
  let state = createInitialState();
  const first = game.chooseBotAction({ state, seat: 'gold', seed: 'same' });
  assert.equal(game.validateAction(state, 'gold', first).ok, true);
  const starts = START_POINTS.filter((start) => cellsIncludeStart(first.cells, start));
  assert.equal(starts.length, 1);
  const repeat = game.chooseBotAction({ state, seat: 'gold', seed: 'same' });
  assert.deepEqual(repeat, first);

  let plies = 0;
  while (!state.outcome && plies < 100) {
    const seat = state.turn;
    const action = game.chooseBotAction({ state, seat, seed: 'full-game' });
    state = apply(state, seat, action);
    plies += 1;
  }
  assert.ok(state.outcome);
  assert.ok(plies > 10);
  assert.ok(state.outcome.scores);
});

test('动作和计分不会修改旧状态；终局后不能继续', () => {
  const initial = createInitialState();
  const before = JSON.stringify(initial);
  const next = apply(initial, 'gold', {
    type: 'place', pieceId: 'P1-01', orientation: 0, anchor: 'E5',
  });
  assert.equal(JSON.stringify(initial), before);
  assert.equal(initial.board[4][4], null);
  assert.equal(next.board[4][4], 'gold');

  next.board = fullBoard();
  next.inventories.gold = [];
  next.inventories.blue = [];
  next.lastPlacedPiece.gold = 'P2-01';
  next.lastPlacedPiece.blue = 'P2-01';
  next.turn = 'gold';
  const finished = apply(next, 'gold', { type: 'pass', reason: 'no_legal_move' });
  assert.equal(finished.outcome.type, 'draw');
  const rejected = game.validateAction(finished, 'gold', {
    type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'A1',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'game_over');
});

function modelInput(name, mock) {
  return {
    name,
    provider: 'openai-compatible',
    baseUrl: mock.baseUrl,
    modelId: mock.model,
    apiKey: mock.apiKey ?? '',
    timeoutMs: 5000,
    maxRetries: 1,
  };
}

test('服务调度会记录系统跳过，并可用权威快照回放', async () => {
  const harness = await createServiceHarness({ gamePlugins: [game] });
  try {
    const created = await harness.service.createMatch({
      gameId: 'blokus-duo',
      seats: { gold: { kind: 'bot' }, blue: { kind: 'bot' } },
      dafeiyu: { enabled: false },
    });
    const finished = await waitFor(() => {
      const current = harness.service.getMatch(created.id);
      return current.status === 'finished' ? current : null;
    }, { timeoutMs: 20000, intervalMs: 100, message: 'Blokus 机器人对局没有结束' });
    assert.ok(finished.actionCount > 10);
    assert.ok(finished.actions.every((action) => ['bot', 'system'].includes(action.source)));
    const replay = harness.service.getReplay(created.id);
    assert.equal(replay.totalSteps, finished.actionCount);
    assert.equal(replay.steps.length, finished.actionCount + 1);
    assert.ok(replay.steps.at(-1).view.outcome.scores.gold);
    assert.doesNotMatch(JSON.stringify(replay), /apiKey|"private"/i);
  } finally {
    await harness.cleanup();
  }
});

test('服务在无合法摆法时自动触发并记录系统跳过', async () => {
  const harness = await createServiceHarness({ gamePlugins: [game] });
  try {
    const created = await harness.service.createMatch({
      gameId: 'blokus-duo',
      seats: { gold: { kind: 'bot' }, blue: { kind: 'bot' } },
      dafeiyu: { enabled: false },
    });
    const match = harness.service.matches.get(created.id);
    const runtime = harness.service._runtime(created.id);
    harness.service._clearSchedule(created.id);
    const state = firstTwo();
    state.inventories.gold = [];
    state.inventories.blue = ['P1-01', 'P2-01'];
    match.state = state;
    match.actions = [];
    match.snapshots = [];
    match.status = 'playing';
    match.outcome = null;
    runtime.stepOnce = false;
    harness.service._scheduleAi(match);
    await waitFor(() => match.actions.length >= 1, {
      timeoutMs: 3000,
      intervalMs: 20,
      message: '系统跳过后没有记录动作',
    });
    assert.equal(match.actions[0].source, 'system');
    assert.equal(match.actions[0].action.type, 'pass');
    assert.match(game.describeAction(match.actions[0].action), /跳过/);
    harness.service._clearSchedule(created.id);
    await harness.service.endMatch(created.id, { reason: 'auto-pass test complete' });
  } finally {
    await harness.cleanup();
  }
});

test('纯模型和规则辅助收到不同提示，模型动作经过后端校验', async () => {
  const mock = await createMockOpenAI({
    responder: (record) => {
      const prompt = record.body.messages.map((message) => message.content).join('\n');
      return prompt.includes('candidate')
        ? '{"candidate":"c1"}'
        : '{"pieceId":"P1-01","orientation":0,"anchor":"E5"}';
    },
  });
  const seatsFor = (mode) => ({
    gold: { kind: 'model', modelId: null, moveMode: mode },
    blue: { kind: 'bot' },
  });
  try {
    const pureHarness = await createServiceHarness({
      gamePlugins: [game],
      models: [modelInput('Blokus pure', mock)],
    });
    try {
      const model = pureHarness.configStore.listModels()[0];
      const created = await pureHarness.service.createMatch({
        gameId: 'blokus-duo',
        seats: { ...seatsFor('pure'), gold: { kind: 'model', modelId: model.id, moveMode: 'pure' } },
        dafeiyu: { enabled: false },
      });
      await waitFor(() => pureHarness.service.getMatch(created.id).actionCount >= 1, {
        timeoutMs: 5000,
        message: '纯模型没有提交动作',
      });
      const pureRequest = mock.requests.find((request) => request.body.messages.some((message) => String(message.content).includes('纯模型模式')));
      assert.ok(pureRequest, '没有收到纯模型请求');
      const purePrompt = pureRequest.body.messages.map((message) => message.content).join('\n');
      assert.match(purePrompt, /纯模型模式/);
      assert.doesNotMatch(purePrompt, /规则辅助信息/);
      assert.match(purePrompt, /pieceId/);
      assert.equal(pureHarness.service.getMatch(created.id).actions[0].seat, 'gold');
      await pureHarness.service.endMatch(created.id, { reason: 'test' });
    } finally {
      await pureHarness.cleanup();
    }

    mock.requests.length = 0;
    const assistedHarness = await createServiceHarness({
      gamePlugins: [game],
      models: [modelInput('Blokus assisted', mock)],
    });
    try {
      const model = assistedHarness.configStore.listModels()[0];
      const created = await assistedHarness.service.createMatch({
        gameId: 'blokus-duo',
        seats: { ...seatsFor('assisted'), gold: { kind: 'model', modelId: model.id, moveMode: 'assisted' } },
        dafeiyu: { enabled: false },
      });
      await waitFor(() => assistedHarness.service.getMatch(created.id).actionCount >= 1, {
        timeoutMs: 5000,
        message: '规则辅助模型没有提交动作',
      });
      const assistedRequest = mock.requests.find((request) => request.body.messages.some((message) => String(message.content).includes('规则辅助模式')));
      assert.ok(assistedRequest, '没有收到规则辅助请求');
      const assistedPrompt = assistedRequest.body.messages.map((message) => message.content).join('\n');
      assert.match(assistedPrompt, /规则辅助信息/);
      assert.match(assistedPrompt, /candidateInfo/);
      assert.match(assistedPrompt, /candidate/);
      const action = assistedHarness.service.getMatch(created.id).actions[0];
      assert.equal(action.seat, 'gold');
      assert.ok(action.action.pieceId);
      assert.ok(action.action.anchor);
      assert.ok(action.modelMeta?.candidateInfo?.total >= 1);
      assert.equal(action.modelMeta.candidateInfo.shown, 80);
      await assistedHarness.service.endMatch(created.id, { reason: 'test' });
    } finally {
      await assistedHarness.cleanup();
    }
  } finally {
    await mock.close();
  }
});

test('重复动作提交幂等，结束对局后的迟到动作被拒绝', async () => {
  const harness = await createServiceHarness({ gamePlugins: [game] });
  try {
    const created = await harness.service.createMatch({
      gameId: 'blokus-duo',
      seats: { gold: { kind: 'human' }, blue: { kind: 'bot' } },
      dafeiyu: { enabled: false },
    });
    const clientActionId = 'blokus-once';
    const first = await harness.service.submitHumanAction(created.id, {
      seat: 'gold',
      action: { type: 'place', pieceId: 'P1-01', orientation: 0, anchor: 'E5' },
      clientActionId,
    });
    assert.equal(first.duplicate, false);
    const duplicate = await harness.service.submitHumanAction(created.id, {
      seat: 'gold',
      action: { type: 'place', pieceId: 'P1-01', orientation: 0, anchor: 'E5' },
      clientActionId,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(harness.service.getMatch(created.id).actionCount, 1);
    await harness.service.endMatch(created.id, { reason: 'test ended' });
    await assert.rejects(
      () => harness.service.submitHumanAction(created.id, {
        seat: 'gold',
        action: { type: 'place', pieceId: 'P2-01', orientation: 0, anchor: 'F6' },
        clientActionId: 'late-action',
      }),
      (error) => error.code === 'archived_match' || error.code === 'match_not_playing',
    );
  } finally {
    await harness.cleanup();
  }
});
