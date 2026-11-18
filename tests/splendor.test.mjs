import assert from 'node:assert/strict';
import test from 'node:test';
import splendor from '../packages/games/splendor/index.mjs';
import { CARDS, CARD, COLORS, NOBLES } from '../packages/games/splendor/catalog.mjs';
import { createServiceHarness, waitFor } from './helpers/service-harness.mjs';

const seatIds = splendor.seats.map(seat => seat.id);
const stateFor = (count = 2) => splendor.createInitialState({ seed: 'same-seed', seatIds: seatIds.slice(0, count) });
const take = (state, action) => splendor.applyAction(state, state.turn, { action }).state;

test('Splendor official counts, supply and deterministic setup for 2, 3, and 4 players', () => {
  assert.deepEqual([1, 2, 3].map(tier => CARDS.filter(card => card.tier === tier).length), [40, 30, 20]);
  assert.equal(NOBLES.length, 10);
  for (const count of [2, 3, 4]) {
    const state = stateFor(count);
    assert.deepEqual(state, stateFor(count));
    assert.equal(state.nobles.length, count + 1);
    assert.equal(state.bank.W, [4, 5, 7][count - 2]);
    assert.equal(state.bank.Y, 5);
  }
});

test('return excess chips before passing the turn; same-color take requires four in supply', () => {
  const state = stateFor();
  state.players.east.tokens.Y = 4;
  state.players.east.tokens.W = 4;
  state.bank.W = 0;
  assert.equal(splendor.validateAction(state, 'east', { action: 'take:WW' }).ok, false);
  const pending = take(state, 'take:UGR');
  assert.equal(pending.phase, 'return');
  assert.equal(pending.turn, 'east');
  const returned = take(pending, 'return:Y');
  assert.equal(returned.turn, 'south');
  assert.equal(returned.players.east.tokens.Y, 3);
});

test('blind reservation stays private until purchased and gold can replace a chosen color', () => {
  const state = stateFor();
  const id = state.decks[2][0];
  const reserved = take(state, 'reserve:deck2');
  assert.equal(reserved.players.east.tokens.Y, 1);
  const observer = splendor.getPublicState(reserved);
  assert.equal(observer.players.east.reservedCount, 1);
  assert.equal(observer.players.east.reserved, undefined);
  assert.equal(splendor.getSeatView(reserved, 'south').players.east.reserved, undefined);
  assert.equal(splendor.getSeatView(reserved, 'east').players.east.reserved[0].id, id);
  reserved.turn = 'east';
  const paidWithGold = COLORS.find(color => CARD[id].cost[color] > 0);
  Object.assign(reserved.players.east.tokens, CARD[id].cost);
  const purchased = splendor.applyAction(reserved, 'east', { action: 'buy:' + id + ':' + paidWithGold }).state;
  assert.equal(purchased.players.east.reserved.length, 0);
  assert.equal(purchased.players.east.tokens.Y, 0);
  assert.equal(purchased.players.east.tokens[paidWithGold], 1);
});

test('multiple nobles hold the seat; 15 points finishes only after the last seat in the round', () => {
  const state = stateFor(4);
  state.nobles = NOBLES.slice(0, 2);
  Object.assign(state.players.east.bonuses, { U: 4, G: 4, R: 4 });
  state.players.east.points = 12;
  const pending = take(state, 'take:WUG');
  assert.equal(pending.phase, 'noble');
  const last = take(pending, 'noble:' + state.nobles[0].id);
  assert.equal(last.finalRound, true);
  assert.equal(last.turn, 'south');
  const end = ['south', 'west', 'north'].reduce(current => take(current, 'take:WRB'), last);
  assert.equal(end.outcome.winnerSeat, 'east');
});

test('card identifiers never become points in commentary and zero-point purchases are sparse', () => {
  const previous = stateFor();
  const card = CARDS.find(card => card.id === '1G6');
  previous.market[1][0] = card.id;
  previous.nobles = [];
  previous.players.east.bonuses = Object.fromEntries(COLORS.map(color => [color, 8]));
  const action = { action: { action: 'buy:' + card.id }, seat: 'east' };
  const result = splendor.applyAction(previous, 'east', action.action);
  assert.equal(result.event.card.points, 0);
  const [event] = splendor.autoCommentCandidates({ previous, state: result.state, action });
  assert.equal(event.details.card.points, 0);
  assert.equal(event.details.actor, 'east');
  assert.match(event.summary, /卡牌声望 0 分/);
  assert.equal(event.details.pointsGained, 0);
  const next = structuredClone(result.state);
  next.players.east.bought.push('1W1');
  const quiet = splendor.autoCommentCandidates({ previous: next, state: next, action });
  assert.deepEqual(quiet, []);
});

test('four robots reach a scored ending and live replay/export never exposes the shuffle', async () => {
  const harness = await createServiceHarness({ gamePlugins: [splendor], matchSettings: { aiMoveDelayMs: 0, initialAiDelayMs: 0 } });
  try {
    const seatConfig = Object.fromEntries(seatIds.map(id => [id, { kind: 'bot' }]));
    const match = await harness.service.createMatch({ gameId: 'splendor', playerCount: 4, seats: seatConfig });
    harness.subscribe(match.id);
    const live = harness.service.getReplay(match.id);
    assert.equal(live.seed, null);
    assert.equal(live.initialView.decks, undefined);
    await waitFor(() => harness.service.getMatch(match.id).status === 'finished', { timeoutMs: 30000 });
    assert.equal(harness.service.getMatch(match.id).outcome.standings.length, 4);
    assert.equal(harness.service.exportMatch(match.id).replay.seed, null);
  } finally {
    await harness.cleanup();
  }
});
