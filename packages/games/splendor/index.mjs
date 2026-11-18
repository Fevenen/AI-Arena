import { defineGamePlugin } from '../../core/game-api.mjs';
import { SEATS, RULES, createInitialState, publicView, validateAction, applyAction, describeAction,
  describeForModel, parseModelMove, chooseBotAction, commentary } from './rules.mjs';

export default defineGamePlugin({
  id: 'splendor', name: '璀璨宝石', shortName: '璀璨宝石', rulesVersion: '1.0.0',
  description: '经典版。收集宝石、发展产业，从贵族与卡牌取得声望。支持 2–4 席。',
  minPlayers: 2, maxPlayers: 4, seats: SEATS, variableSeats: true, hiddenShuffle: true,
  supportsSpectator: true, rulesText: RULES, ui: { kind: 'splendor' },
  createInitialState, getCurrentActor: state => state.turn, getOutcome: state => state.outcome,
  getPublicState: state => publicView(state), getSeatView: (state, seat) => publicView(state, seat),
  legalActions: (state, seat) => (publicView(state, seat).choices ?? []).map(action => ({ action })),
  validateAction, applyAction, describeAction, describeForModel, parseModelMove, chooseBotAction,
  autoCommentCandidates: commentary,
});
