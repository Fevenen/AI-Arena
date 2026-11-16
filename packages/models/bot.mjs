/**
 * 内置简单机器人只通过游戏插件提供的可选策略落子。
 * 它不会被用作模型失败时的兜底，必须由用户在座位上明确选择。
 */
export class BuiltInBot {
  constructor({ game, seat, seed = null }) {
    this.game = game;
    this.seat = seat;
    this.seed = seed;
  }

  async chooseAction(state) {
    if (typeof this.game.chooseBotAction !== 'function') {
      throw new Error(`游戏 ${this.game.id} 暂未提供内置机器人策略。`);
    }
    return this.game.chooseBotAction({ state, seat: this.seat, seed: this.seed });
  }
}
