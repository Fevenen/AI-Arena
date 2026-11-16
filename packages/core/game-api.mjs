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
  if (plugin.minPlayers < 1 || plugin.maxPlayers < plugin.minPlayers) {
    throw new TypeError('桌游插件人数配置不合法');
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
