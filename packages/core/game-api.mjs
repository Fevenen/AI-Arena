import { RuleError } from './errors.mjs';

/** 桌游插件必须实现的稳定接口。字段含义见 docs/add-game.md。 */
const REQUIRED = [
  'id',
  'name',
  'rulesVersion',
  'minPlayers',
  'maxPlayers',
  'createInitialState',
  'getPublicState',
  'getSeatView',
  'validateAction',
  'applyAction',
  'getOutcome',
  'describeForModel',
  'parseModelMove',
];

export function defineGamePlugin(plugin) {
  const missing = REQUIRED.filter((key) => plugin?.[key] == null);
  if (missing.length) {
    throw new TypeError(`桌游插件缺少必要字段：${missing.join(', ')}`);
  }
  if (!Array.isArray(plugin.seats) || !plugin.seats.length) {
    throw new TypeError('桌游插件必须声明 seats');
  }
  const ids = new Set();
  for (const seat of plugin.seats) {
    if (!seat || typeof seat.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(seat.id)) {
      throw new TypeError('每个座位必须有合法的 id');
    }
    if (ids.has(seat.id)) throw new TypeError(`座位 id 重复：${seat.id}`);
    ids.add(seat.id);
  }
  if (plugin.minPlayers < 1 || plugin.maxPlayers < plugin.minPlayers) {
    throw new TypeError('桌游插件人数配置不合法');
  }
  if (plugin.seats.length < plugin.minPlayers || plugin.seats.length > plugin.maxPlayers) {
    throw new TypeError('座位数量必须落在 minPlayers 与 maxPlayers 之间');
  }
  if (typeof plugin.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(plugin.id)) {
    throw new TypeError('桌游 id 只能使用小写字母、数字和连字符');
  }
  return Object.freeze(plugin);
}

export function assertSeat(plugin, seat) {
  if (!plugin.seats.some((item) => item.id === seat)) {
    throw new RuleError('unknown_seat', `未知座位：${seat}`);
  }
}

/** 插件可以覆盖 getCurrentActor；旧插件回退到 state.turn。 */
export function currentSeat(plugin, state) {
  if (typeof plugin.getCurrentActor === 'function') {
    return plugin.getCurrentActor(state);
  }
  return state?.turn ?? null;
}

export function seatByOrder(plugin) {
  return [...plugin.seats].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function seatDefinition(plugin, seatId) {
  return plugin.seats.find((seat) => seat.id === seatId) ?? null;
}

export function actionLabel(plugin, action) {
  if (typeof plugin.describeAction === 'function') {
    try {
      return String(plugin.describeAction(action) || '').trim();
    } catch {
      // fall through to a stable generic representation
    }
  }
  try {
    return JSON.stringify(action);
  } catch {
    return '';
  }
}
