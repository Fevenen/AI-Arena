import { RuleError } from './errors.mjs';

/**
 * 通用回放构建。只使用已接受动作和初始局面重建，不调用模型。
 * 未来游戏若有随机事件，应把随机种子写入 match.seed，并保证插件执行是确定性的。
 */
export function buildReplay({ game, match, limit = null }) {
  const actions = Array.isArray(match.actions) ? match.actions : [];
  let state = game.createInitialState({ seed: match.seed ?? null });
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
