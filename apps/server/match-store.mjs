import fs from 'node:fs';
import path from 'node:path';

function summarize(match) {
  return {
    id: match.id,
    gameId: match.gameId,
    gameName: match.gameName,
    rulesVersion: match.rulesVersion,
    status: match.status,
    createdAt: match.createdAt,
    startedAt: match.startedAt,
    finishedAt: match.finishedAt,
    updatedAt: match.updatedAt,
    outcome: match.outcome,
    result: match.result,
    resultLabel: match.resultLabel,
    seats: match.seats,
    moveCount: Array.isArray(match.actions) ? match.actions.length : 0,
    modeLabel: match.modeLabel,
    dafeiyuEnabled: Boolean(match.dafeiyu?.enabled),
    dafeiyuName: match.dafeiyu?.personaName ?? '大肥鱼',
  };
}

export class MatchStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.summaries = new Map();
  }

  fileFor(id) {
    if (!/^match-[a-f0-9-]+$/i.test(id)) throw new Error('非法对局 ID');
    return path.join(this.dir, `${id}.json`);
  }

  loadAll() {
    const matches = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      try {
        const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const match = JSON.parse(text);
        if (!match?.id || !file.endsWith(`${match.id}.json`)) continue;
        matches.push(match);
        this.summaries.set(match.id, summarize(match));
      } catch (error) {
        // 损坏的单局记录不应阻止服务启动；保留文件供人工恢复。
        console.error(`[arena] 跳过无法读取的对局记录 ${name}: ${error.message}`);
      }
    }
    matches.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return matches;
  }

  save(match) {
    const file = this.fileFor(match.id);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const text = `${JSON.stringify(match, null, 2)}\n`;
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    this.summaries.set(match.id, summarize(match));
  }

  getSummary(id) {
    return this.summaries.get(id) ?? null;
  }

  list() {
    return [...this.summaries.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

}
