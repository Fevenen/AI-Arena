import gomokuGame from './gomoku/index.mjs';

/**
 * 注册桌游：这是新增游戏的唯一注册位置。
 * 每个插件必须通过 packages/core/game-api.mjs 的接口校验。
 */
export const GAME_PLUGINS = Object.freeze([gomokuGame]);

export const GAME_MAP = new Map(GAME_PLUGINS.map((game) => [game.id, game]));

export function listGames() {
  return GAME_PLUGINS.map((game) => ({
    id: game.id,
    name: game.name,
    shortName: game.shortName,
    description: game.description,
    rulesVersion: game.rulesVersion,
    seats: game.seats,
    rulesText: game.rulesText,
    coordinateSystem: game.coordinateSystem,
    ui: game.ui,
    supportsSpectator: game.supportsSpectator,
  }));
}

export function getGame(id) {
  return GAME_MAP.get(id) ?? null;
}
