import gomokuGame from './gomoku/index.mjs';
import blokusDuoGame from './blokus-duo/index.mjs';
import splendorGame from './splendor/index.mjs';

/**
 * 注册桌游：这是新增正式游戏的唯一注册位置。
 * 测试/开发环境可以将额外的插件列表传给 createArenaApp，不需要改大厅和调度器。
 */
export const GAME_PLUGINS = Object.freeze([gomokuGame, blokusDuoGame, splendorGame]);

export const GAME_MAP = new Map(GAME_PLUGINS.map((game) => [game.id, game]));

export function serializeGame(game) {
  return {
    id: game.id,
    name: game.name,
    shortName: game.shortName,
    description: game.description,
    rulesVersion: game.rulesVersion,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    variableSeats: game.variableSeats === true,
    seats: game.seats.map((seat) => ({
      id: seat.id,
      name: seat.name,
      order: seat.order ?? 0,
      color: seat.color ?? null,
      shortName: seat.shortName ?? seat.name,
    })),
    rulesText: game.rulesText,
    coordinateSystem: game.coordinateSystem,
    ui: game.ui,
    supportsSpectator: game.supportsSpectator,
  };
}

export function listGames(plugins = GAME_PLUGINS) {
  return plugins.map(serializeGame);
}

export function getGame(id, plugins = GAME_PLUGINS) {
  return plugins.find((game) => game.id === id) ?? null;
}
