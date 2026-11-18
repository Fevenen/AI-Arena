import { createHash } from 'node:crypto';
import { CARD, CARDS, COLORS, COLOR_NAMES, NOBLES, TOKENS } from './catalog.mjs';

export const SEATS = ['east', 'south', 'west', 'north'].map((id, index) =>
  ({ id, name: (index + 1) + ' 号位', order: index + 1, color: ['red', 'blue', 'green', 'violet'][index] }));
export const RULES = [
  '经典璀璨宝石，2–4 人。W=白 U=蓝 G=绿 R=红 B=黑 Y=黄金。',
  '每回合取三个不同色（库存不足则尽可能取）、取两个同色（该色至少剩四个）、预留一张牌或买一张牌。',
  '预留公开牌或牌堆顶牌，黄金有则取一，最多预留三张。购买可用已购卡的永久折扣，黄金替代任意颜色。',
  '取筹码后，多于十枚时选择归还；满足多个贵族时选一个。贵族各值三分。',
  '达到十五分后完成本轮。分数相同则购买牌少者获胜，仍相同则共享胜利。',
].join('\n');
const TIERS = [1, 2, 3];
const stock = (amount = 0, gold = 0) => Object.fromEntries(TOKENS.map(color => [color, color === 'Y' ? gold : amount]));
const sum = counts => TOKENS.reduce((total, color) => total + (counts[color] || 0), 0);
const combinations = (items, count) => count === 0 ? [[]] : items.flatMap((item, i) =>
  combinations(items.slice(i + 1), count - 1).map(rest => [item, ...rest]));

function shuffled(items, seed, label) {
  const array = [...items];
  for (let i = array.length - 1; i > 0; i--) {
    const random = createHash('sha256').update(seed + ':' + label + ':' + i).digest().readUInt32LE();
    const j = random % (i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

export function createInitialState({ seed = 'splendor', seatIds = SEATS.slice(0, 2).map(seat => seat.id) } = {}) {
  const decks = Object.fromEntries(TIERS.map(tier => [
    tier, shuffled(CARDS.filter(card => card.tier === tier).map(card => card.id), seed, 'cards-' + tier),
  ]));
  const market = Object.fromEntries(TIERS.map(tier => [tier, decks[tier].splice(0, 4)]));
  return {
    seats: [...seatIds], turn: seatIds[0], phase: 'action', round: 1, actionCount: 0, finalRound: false,
    bank: stock({ 2: 4, 3: 5, 4: 7 }[seatIds.length], 5), market, decks,
    nobles: shuffled(NOBLES, seed, 'nobles').slice(0, seatIds.length + 1),
    players: Object.fromEntries(seatIds.map(seat => [seat, { tokens: stock(), bonuses: stock(), bought: [], reserved: [], nobles: [], points: 0 }])),
    passCount: 0, outcome: null,
  };
}

function visitOptions(state, player) {
  return state.nobles.filter(noble => COLORS.every(color => player.bonuses[color] >= (noble.cost[color] ?? 0)));
}

function payment(player, card, goldColors) {
  const paid = stock();
  for (const color of COLORS) {
    const need = Math.max(0, (card.cost[color] ?? 0) - player.bonuses[color]);
    const wild = goldColors == null
      ? Math.max(0, need - player.tokens[color])
      : [...goldColors].filter(value => value === color).length;
    if (wild > need || need - wild > player.tokens[color]) return null;
    paid[color] = need - wild;
    paid.Y += wild;
  }
  return paid.Y <= player.tokens.Y ? paid : null;
}

function actionChoices(state, seat) {
  if (state.turn !== seat || state.outcome) return [];
  const player = state.players[seat];
  if (state.phase === 'noble') return visitOptions(state, player).map(noble => 'noble:' + noble.id);
  if (state.phase === 'return') {
    const extra = sum(player.tokens) - 10;
    const owned = TOKENS.flatMap(color => Array(player.tokens[color]).fill(color));
    return [...new Set(combinations(owned, extra).map(tokens => 'return:' + tokens.join('')))];
  }
  const available = COLORS.filter(color => state.bank[color] > 0);
  const take = available.length ? combinations(available, Math.min(3, available.length)).map(colors => 'take:' + colors.join('')) : [];
  const doubles = available.filter(color => state.bank[color] >= 4).map(color => 'take:' + color + color);
  const displayed = Object.values(state.market).flat();
  const reserve = player.reserved.length < 3
    ? [...displayed, ...TIERS.filter(tier => state.decks[tier].length).map(tier => 'deck' + tier)].map(id => 'reserve:' + id)
    : [];
  const buy = [...displayed, ...player.reserved]
    .filter(id => payment(player, CARD[id], null)).map(id => 'buy:' + id);
  const choices = [...buy, ...take, ...doubles, ...reserve];
  return choices.length ? choices : ['pass'];
}

function orderedTokens(value) {
  return TOKENS.map(color => [...value].filter(item => item === color).join('')).join('');
}

export function validateAction(state, seat, submitted) {
  const fail = reason => ({ ok: false, code: 'illegal_action', message: reason, error: reason });
  const raw = submitted?.action;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9:]{1,38}$/.test(raw)) return fail('请提交单个 action 字符串。');
  const [type, target = '', detail, ...extra] = raw.split(':');
  if (extra.length || (detail !== undefined && type !== 'buy')) return fail('动作格式错误。');
  if (state.turn !== seat || state.outcome) return fail('当前无法行动。');
  if ((type === 'take' || type === 'return') && !new RegExp(type === 'take' ? '^[WUGRB]+$' : '^[WUGRBY]+$').test(target)) {
    return fail('筹码颜色或数量不合规则。');
  }
  const key = (type === 'take' || type === 'return') ? type + ':' + orderedTokens(target) : [type, target].filter(Boolean).join(':');
  if ((type === 'pass' && raw !== 'pass') || !actionChoices(state, seat).includes(key)) return fail('本回合没有这个合法动作。');
  if (detail !== undefined && (!/^[WUGRB]+$/.test(detail) || !payment(state.players[seat], CARD[target], detail))) {
    return fail('黄金分配与牌价或筹码余额不符。');
  }
  return { ok: true, action: { action: detail === undefined ? key : key + ':' + orderedTokens(detail) } };
}

function transfer(source, destination, colors) {
  for (const color of colors) { source[color]--; destination[color]++; }
}

function removeMarketCard(state, id) {
  const tier = CARD[id].tier;
  const index = state.market[tier].indexOf(id);
  if (index < 0) return;
  const replacement = state.decks[tier].shift();
  state.market[tier].splice(index, 1, ...(replacement ? [replacement] : []));
}

function takeNoble(state, player, id) {
  state.nobles = state.nobles.filter(noble => noble.id !== id);
  player.nobles.push(id);
  player.points += 3;
}

function finishTurn(state, player) {
  if (player.points >= 15) state.finalRound = true;
  const next = (state.seats.indexOf(state.turn) + 1) % state.seats.length;
  if ((state.finalRound && next === 0) || state.passCount === state.seats.length) {
    const standings = state.seats.map(seat => ({ seat, points: state.players[seat].points, purchases: state.players[seat].bought.length }))
      .sort((a, b) => b.points - a.points || a.purchases - b.purchases);
    const winners = standings.filter(item => item.points === standings[0].points && item.purchases === standings[0].purchases).map(item => item.seat);
    state.outcome = winners.length === 1
      ? { type: 'win', winnerSeat: winners[0], standings }
      : { type: 'draw', winners, standings };
    state.turn = null;
    state.phase = 'finished';
    return;
  }
  if (!next) state.round++;
  state.turn = state.seats[next];
  state.phase = 'action';
}

export function applyAction(state, seat, action) {
  const validation = validateAction(state, seat, action);
  if (!validation.ok) throw new Error(validation.message);
  const next = structuredClone(state);
  const player = next.players[seat];
  const [type, target, detail] = validation.action.action.split(':');
  next.actionCount++;
  if (state.phase === 'action') next.passCount = type === 'pass' ? state.passCount + 1 : 0;
  if (type === 'take') transfer(next.bank, player.tokens, target);
  if (type === 'return') transfer(player.tokens, next.bank, target);
  if (type === 'reserve') {
    if (target.startsWith('deck')) player.reserved.push(next.decks[target.slice(-1)].shift());
    else { player.reserved.push(target); removeMarketCard(next, target); }
    if (next.bank.Y) transfer(next.bank, player.tokens, 'Y');
  }
  if (type === 'buy') {
    const card = CARD[target];
    const paid = payment(player, card, detail);
    for (const color of TOKENS) transfer(player.tokens, next.bank, color.repeat(paid[color]));
    player.reserved = player.reserved.filter(id => id !== target);
    removeMarketCard(next, target);
    player.bought.push(target);
    player.bonuses[card.bonus]++;
    player.points += card.points;
  }
  if (sum(player.tokens) > 10) {
    next.phase = 'return';
  } else if (type === 'noble') {
    takeNoble(next, player, target);
    finishTurn(next, player);
  } else {
    const options = visitOptions(next, player);
    if (options.length > 1) next.phase = 'noble';
    else {
      if (options.length === 1) takeNoble(next, player, options[0].id);
      finishTurn(next, player);
    }
  }
  return { state: next, event: {
    type, label: describeAction(validation.action), actor: seat,
    ...(type === 'buy' ? { card: { id: target, points: CARD[target].points, bonus: CARD[target].bonus, colorName: COLOR_NAMES[CARD[target].bonus] } } : {}),
    scoreBefore: state.players[seat].points, scoreAfter: player.points,
    pointsGained: player.points - state.players[seat].points,
  } };
}

export function publicView(state, seat = null) {
  return {
    seats: state.seats, turn: state.turn, phase: state.phase, round: state.round, actionCount: state.actionCount,
    finalRound: state.finalRound, bank: state.bank, nobles: state.nobles, outcome: state.outcome,
    market: Object.fromEntries(TIERS.map(tier => [tier, state.market[tier].map(id => CARD[id])])),
    deckCounts: Object.fromEntries(TIERS.map(tier => [tier, state.decks[tier].length])),
    players: Object.fromEntries(state.seats.map(id => {
      const { reserved, bought, ...player } = state.players[id];
      return [id, { ...player, reservedCount: reserved.length, boughtCount: bought.length,
        ...(id === seat ? { reserved: reserved.map(key => CARD[key]) } : {}) }];
    })),
    ...(state.players[seat] ? { choices: actionChoices(state, seat) } : {}),
  };
}

export function describeAction(value) {
  const [type, target = '', detail] = String(value?.action ?? '').split(':');
  if (type === 'take' || type === 'return') {
    return (type === 'take' ? '拿取 ' : '归还 ') + [...target].map(color => COLOR_NAMES[color]).join('、');
  }
  if (type === 'buy') return '购买 ' + target + (detail ? '（黄金替代 ' + [...detail].map(color => COLOR_NAMES[color]).join('、') + '）' : '');
  if (type === 'reserve') return target.startsWith('deck') ? '盲预留第 ' + target.slice(-1) + ' 级牌堆' : '预留 ' + target;
  if (type === 'noble') return '接待贵族 ' + target;
  return '跳过';
}

export function describeForModel({ state, seatId }) {
  const { choices, ...view } = publicView(state, seatId);
  const own = view.players[seatId];
  const compactCard = card => [card.id, card.bonus, card.points, card.cost];
  const board = {
    round: view.round, phase: view.phase, finalRound: view.finalRound, bank: view.bank,
    market: Object.values(view.market).flat().map(compactCard), decks: view.deckCounts, nobles: view.nobles,
    players: view.players, reserved: own?.reserved?.map(compactCard),
  };
  if (board.players[seatId]) delete board.players[seatId].reserved;
  return {
    rulesText: RULES + '\n牌数据为 [编号, 折扣色, 声望分, 费用]。动作：take:WUG、buy:1W1、reserve:deck2、return:Y、noble:N1 或 pass。buy 可写 buy:1W1:W 指定用一枚黄金替白，省略时优先用彩色筹码。',
    boardText: JSON.stringify(board),
    responseFormat: '{"action":"take:WUG"}',
  };
}

export function parseModelMove(text) {
  try {
    const value = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!value || typeof value.action !== 'string' || !Object.keys(value).every(key => ['action', 'say'].includes(key))) throw new Error();
    return { ok: true, action: { action: value.action }, say: typeof value.say === 'string' ? value.say : '' };
  } catch {
    return { ok: false, error: '请只输出一个包含 action 字符串的 JSON 对象。' };
  }
}

export function chooseBotAction({ state, seat }) {
  const player = state.players[seat];
  const choices = actionChoices(state, seat);
  const available = [...Object.values(state.market).flat(), ...player.reserved].map(id => CARD[id]);
  function evaluate(key) {
    const [type, target] = key.split(':');
    if (type === 'buy') return 20 + CARD[target].points * 2 + (player.points + CARD[target].points >= 15 ? 20 : 0)
      - sum(payment(player, CARD[target], null)) * 0.2;
    if (type === 'take') {
      const after = { ...player.tokens };
      for (const color of target) after[color]++;
      const missing = card => COLORS.reduce((total, color) =>
        total + Math.max(0, (card.cost[color] ?? 0) - player.bonuses[color] - after[color]), 0) - after.Y;
      return 5 + Math.max(...available.map(card => card.points * .35 - missing(card))) + target.length * .1
        - Math.max(0, sum(after) - 10) * .5;
    }
    if (type === 'return') return -[...target].reduce((total, color) => total + (color === 'Y' ? 8 : 1 / player.tokens[color]), 0);
    if (type === 'reserve') return (state.bank.Y && sum(player.tokens) < 10 ? 4 : -2) + (CARD[target]?.points ?? 0) * .2;
    return 0;
  }
  return { action: choices.reduce((best, candidate) => evaluate(candidate) > evaluate(best) ? candidate : best, choices[0]) };
}

export function commentary({ previous, state, action }) {
  if (state.outcome) return [{
    key: 'splendor-end', type: state.outcome.type === 'draw' ? 'game_draw' : 'game_end', priority: 100,
    summary: '比赛结算，按声望分与已购牌数排序。', details: { standings: state.outcome.standings },
  }];
  const actor = action.seat;
  const player = state.players[actor];
  const before = previous?.players[actor];
  const [type, cardId] = String(action.action?.action ?? '').split(':');
  const card = type === 'buy' ? CARD[cardId] : null;
  const earned = before ? player.points - before.points : 0;
  const nobleCount = before ? player.nobles.length - before.nobles.length : 0;
  const enteredFinalRound = state.finalRound && !previous?.finalRound;
  const developed = card && (player.bought.length === 1 || player.bought.length % 4 === 0);
  if (state.phase !== 'action' || !(earned > 0 || developed || enteredFinalRound)) return [];
  const label = SEATS.find(seat => seat.id === actor)?.name ?? actor;
  const purchase = card
    ? label + '购入' + COLOR_NAMES[card.bonus] + '色折扣卡（卡牌声望 ' + card.points + ' 分）'
    : label + describeAction(action.action);
  return [{
    key: 'splendor-' + state.actionCount, type: 'milestone', priority: 10,
    summary: purchase + '，本次增加 ' + earned + ' 分，累计 ' + player.points + ' 分'
      + (nobleCount ? '，获得 ' + nobleCount + ' 位贵族' : '')
      + (enteredFinalRound ? '，进入最后一轮。' : '。'),
    details: {
      actor, actionType: type,
      ...(card ? { card: { id: card.id, bonus: card.bonus, colorName: COLOR_NAMES[card.bonus], points: card.points } } : {}),
      scoreBefore: before?.points ?? null, scoreAfter: player.points,
      pointsGained: earned, noblesGained: nobleCount, enteredFinalRound,
    },
  }];
}
