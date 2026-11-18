import { RuleError } from './errors.mjs';

/**
 * 旧版按步重建回放，保留给测试和第三方调用方。
 * 当前 MatchService 优先使用每步保存的权威公开快照；新游戏应把随机结果写入
 * match.randomEvents，使发牌/掷骰也可重放。
 */
export function buildReplay({ game, match, limit = null }) {
  const actions = Array.isArray(match.actions) ? match.actions : [];
  let state = game.createInitialState({ seed: match.seed ?? null, seatIds: match.seatOrder });
  const steps = [
    {
      step: 0,
      at: match.createdAt,
      view: game.getPublicState(state),
      seatView: null,
      action: null,
    },
  ];

  const max = limit == null ? actions.length : Math.max(0, Math.min(limit, actions.length));
  for (let index = 0; index < max; index += 1) {
    const entry = actions[index];
    let next;
    try {
      next = game.applyAction(state, entry.seat, entry.action);
    } catch (error) {
      throw new RuleError(
        'replay_corrupt',
        `第 ${index + 1} 手无法重建：${error.message}`,
        { actionIndex: index },
      );
    }
    state = next.state;
    steps.push({
      step: index + 1,
      at: entry.at,
      view: game.getPublicState(state),
      seatView: null,
      action: { ...entry, event: next.event ?? null },
    });
  }

  return {
    match: {
      id: match.id,
      gameId: match.gameId,
      gameName: match.gameName,
      rulesVersion: match.rulesVersion,
      status: match.status,
      aiPace: match.aiPace ?? 'quality',
      createdAt: match.createdAt,
      startedAt: match.startedAt,
      finishedAt: match.finishedAt,
      outcome: match.outcome,
      seats: match.seats,
      seed: match.seed ?? null,
    },
    steps,
    totalSteps: steps.length - 1,
    chat: Array.isArray(match.chat) ? match.chat : [],
    errors: Array.isArray(match.errors) ? match.errors : [],
  };
}
