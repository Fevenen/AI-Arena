import { defineGamePlugin } from '../../core/game-api.mjs';
import {
  applyAction,
  autoCommentCandidates,
  chooseBotAction,
  createInitialState,
  describeAction,
  describeForModel,
  getAutomaticAction,
  getOutcome,
  getPublicState,
  getSeatView,
  getTacticalHints,
  legalActions,
  parseModelMove,
  validateAction,
} from './rules.mjs';

export const RULES_VERSION = '1.0.0';

export const RULES_TEXT = [
  '角斗士棋：双人对决（Blokus Duo），14×14 棋盘，双方各 21 块标准自由多连方棋子。',
  '棋盘列 A–N 从左到右，行 1–14 从上到下；两个起始点是 E5 和 J10。',
  '先手第一块必须覆盖 E5 或 J10；后手第一块必须覆盖另一个起始点。',
  '第一块之后，每块至少与己方已有棋子的一个角接触；任意格不得与己方棋子边接触。',
  '异色棋子可以贴边；棋子不能重叠、越界或重复使用。',
  '无合法摆法时系统自动跳过；双方都无法摆法，或一方放完全部 21 块时结算。',
  '计分：未放棋子每格 -1；放完全部棋子 +15；最后一块是单格棋再 +5。',
  '最高分获胜；同分按平局处理（官方未规定额外破平方式）。',
].join('\n');

export const COORDINATE_SYSTEM = {
  columns: 'A–N，从左到右',
  rows: '1–14，从上到下',
  anchor: '动作锚点取棋子朝向包围盒的左上格；界面会显示实际覆盖格。',
  example: 'E5',
};

export const blokusDuoGame = defineGamePlugin({
  id: 'blokus-duo',
  name: '角斗士棋：双人对决',
  shortName: '角斗士棋',
  description: '14×14 双人 Blokus Duo。用 21 块多连方抢地盘，角接触扩张，先放完或高分获胜。',
  rulesVersion: RULES_VERSION,
  minPlayers: 2,
  maxPlayers: 2,
  supportsSpectator: true,
  seats: [
    { id: 'gold', name: '红方', shortName: '红', color: 'red', order: 1 },
    { id: 'blue', name: '蓝方', shortName: '蓝', color: 'blue', order: 2 },
  ],
  rulesText: RULES_TEXT,
  coordinateSystem: COORDINATE_SYSTEM,
  createInitialState,
  getPublicState,
  getSeatView,
  getCurrentActor: (state) => state.turn,
  legalActions,
  validateAction,
  applyAction,
  getOutcome,
  describeForModel,
  parseModelMove,
  describeAction,
  getTacticalHints,
  getAutomaticAction: ({ state }) => getAutomaticAction(state),
  chooseBotAction,
  autoCommentCandidates,
  ui: {
    kind: 'blokus-duo',
    rows: 14,
    columns: 14,
    showCoordinates: true,
  },
});

export default blokusDuoGame;
