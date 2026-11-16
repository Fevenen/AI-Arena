#!/usr/bin/env node
/**
 * 固定局面棋力评测：纯模型 / 规则辅助 / 内置机器人。
 *
 * 默认读取 data/arena.json 里的第一个模型配置，并尝试真实调用；
 * 真实模型不可达时只跑内置机器人并明确标注。不会把 API Key 写入报告。
 *
 * 运行：
 *   node scripts/model-benchmark.mjs
 *   node scripts/model-benchmark.mjs --bot-only
 *   node scripts/model-benchmark.mjs --config path/to/arena.json --model <id>
 */
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore, PROJECT_ROOT } from '../apps/server/config-store.mjs';
import { gomokuGame } from '../packages/games/gomoku/index.mjs';
import { requestModelCompletion, testModelConnection } from '../packages/models/index.mjs';

const OUT_DIR = path.join(PROJECT_ROOT, 'data', 'benchmarks');
const BOT_SEED = 'benchmark-seed';

function parseArgs(argv) {
  const args = { botOnly: false, configPath: '', modelId: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--bot-only') args.botOnly = true;
    else if (argv[index] === '--config') args.configPath = argv[++index] ?? '';
    else if (argv[index] === '--model') args.modelId = argv[++index] ?? '';
  }
  return args;
}

function play(moves) {
  let state = gomokuGame.createInitialState({ seed: 'benchmark' });
  for (const item of moves) {
    const [seat, move] = item.split(':');
    state = gomokuGame.applyAction(state, seat, { type: 'place', move }).state;
  }
  return state;
}

function baseMoves() {
  return ['black:A1', 'white:O15', 'black:B1', 'white:O13', 'black:C1', 'white:O11', 'black:D1', 'white:M15'];
}

const POSITIONS = [
  {
    id: 'win-in-one',
    name: '一步成五',
    description: '黑方 A1-D1 四连，轮到黑方。',
    moves: baseMoves(),
    seat: 'black',
    correct: (action) => action?.move === 'E1',
  },
  {
    id: 'block-in-one',
    name: '一步必堵',
    description: '黑方 A1-D1 四连，轮到白方。',
    moves: baseMoves().slice(0, 7),
    seat: 'white',
    correct: (action) => action?.move === 'E1',
  },
  {
    id: 'double-threat',
    name: '双杀（J9 后关键局）',
    description: '复现：黑 H8/I7/G9，白 H7/I8/J9。黑方应制造双重威胁。',
    moves: ['black:H8', 'white:H7', 'black:I7', 'white:I8', 'black:G9', 'white:J9'],
    seat: 'black',
    correct: (action) => {
      const hints = gomokuGame.getTacticalHints({
        state: play(['black:H8', 'white:H7', 'black:I7', 'white:I8', 'black:G9', 'white:J9']),
        seatId: 'black',
      });
      return hints.doubleThreatMoves.includes(action?.move);
    },
  },
  {
    id: 'no-solution-legal',
    name: '已无解但必须合法',
    description: '黑方 A1-D1 与 A5-D5 两个一步成五点，白方无法同时堵住，但仍要给出合法动作。',
    moves: [
      'black:A1', 'white:O15', 'black:B1', 'white:O13', 'black:C1', 'white:O11',
      'black:D1', 'white:O9', 'black:A5', 'white:O7', 'black:B5', 'white:O5',
      'black:C5', 'white:O3', 'black:D5', 'white:O1', 'black:M1',
    ],
    seat: 'white',
    correct: () => true,
  },
];

function promptFor(state, seat, mode) {
  const desc = gomokuGame.describeForModel({ state, seatId: seat });
  const hints = mode === 'assisted'
    ? gomokuGame.getTacticalHints({ state, seatId: seat })
    : null;
  return {
    messages: [
      {
        role: 'system',
        content: [
          `你在 AI Arena 评测中执${seat === 'black' ? '黑方' : '白方'}。`,
          '只输出一个 JSON 对象，不要解释、不要 Markdown。',
          '格式：{"move":"H8","say":"可选"}。只能走一个空点。',
          mode === 'assisted'
            ? '可以参考合法候选、立即成五点和必堵点；仍必须给出一个合法动作。'
            : '这是纯模型模式，没有候选或战术提示。',
          desc.rulesText,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `当前棋盘：\n${desc.boardText}`,
          `坐标：列 A-O，行 15-1。`,
          hints ? `规则辅助：${JSON.stringify(hints)}` : '不要使用额外提示，只根据规则和棋盘判断。',
          '现在只返回一个合法 JSON 动作。',
        ].join('\n\n'),
      },
    ],
  };
}

function validateAction(state, seat, action) {
  return gomokuGame.validateAction(state, seat, action);
}

async function runBot(position) {
  const state = play(position.moves);
  const started = Date.now();
  const action = gomokuGame.chooseBotAction({ state, seat: position.seat, seed: BOT_SEED });
  const validation = validateAction(state, position.seat, action);
  return {
    positionId: position.id,
    mode: 'built-in-bot',
    action,
    text: gomokuGame.describeAction(action),
    legal: validation.ok === true,
    correct: validation.ok === true && position.correct(action),
    attempts: 1,
    failures: [],
    elapsedMs: Date.now() - started,
    stalled: false,
  };
}

async function runModel(config, position, mode) {
  const state = play(position.moves);
  const { messages } = promptFor(state, position.seat, mode);
  const failures = [];
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const completion = await requestModelCompletion(config, {
        messages,
        temperature: 0.15,
        maxTokens: 260,
      });
      const parsed = gomokuGame.parseModelMove(completion.text);
      if (!parsed.ok) {
        failures.push({ attempt, code: 'output_invalid', message: parsed.error });
        continue;
      }
      const validation = validateAction(state, position.seat, parsed.action);
      if (!validation.ok) {
        failures.push({ attempt, code: 'illegal', message: validation.message });
        continue;
      }
      return {
        positionId: position.id,
        mode,
        action: parsed.action,
        text: gomokuGame.describeAction(parsed.action),
        legal: true,
        correct: position.correct(parsed.action),
        attempts: attempt,
        failures,
        elapsedMs: Date.now() - started,
        stalled: false,
      };
    } catch (error) {
      failures.push({
        attempt,
        code: error?.code ?? 'request_failed',
        message: String(error?.message ?? error).slice(0, 120),
      });
      if (!error?.retryable || attempt >= 2) break;
    }
  }
  return {
    positionId: position.id,
    mode,
    action: null,
    text: '—',
    legal: false,
    correct: false,
    attempts: failures.length,
    failures,
    elapsedMs: Date.now() - started,
    stalled: failures.some((item) => ['timeout', 'unreachable'].includes(item.code)),
  };
}

function groupRows(label, rows, positions) {
  const total = positions.length;
  const correct = rows.filter((row) => row.correct).length;
  const legal = rows.filter((row) => row.legal).length;
  const elapsed = rows.reduce((sum, row) => sum + row.elapsedMs, 0);
  const stalled = rows.filter((row) => row.stalled).length;
  return {
    label,
    total,
    correct,
    legal,
    accuracy: total ? correct / total : 0,
    legalRate: total ? legal / total : 0,
    avgElapsedMs: total ? Math.round(elapsed / total) : 0,
    stalled,
    positions: rows.map((row) => ({
      ...row,
      expected: positions.find((position) => position.id === row.positionId)?.description ?? '',
    })),
  };
}

function printReport(groups) {
  console.log('\n固定局面棋力评测\n');
  for (const group of groups) {
    console.log(`${group.label}：正确 ${group.correct}/${group.total}，合法 ${group.legal}/${group.total}，平均 ${group.avgElapsedMs}ms，卡局 ${group.stalled}`);
  }
  console.log('\n逐局：');
  for (const group of groups) {
    for (const item of group.positions) {
      console.log(`- ${group.label} / ${item.positionId}: ${item.text} | legal=${item.legal} correct=${item.correct} ${item.elapsedMs}ms attempts=${item.attempts}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.configPath || process.env.ARENA_CONFIG || path.join(PROJECT_ROOT, 'data', 'arena.json'));
  const configStore = new ConfigStore({ configPath });
  const models = configStore.listModels();
  const modelId = args.modelId || models[0]?.id;
  const model = modelId ? configStore.modelConfig(modelId) : null;
  const groups = [];

  const botRows = [];
  for (const position of POSITIONS) botRows.push(await runBot(position));
  groups.push(groupRows('内置机器人', botRows, POSITIONS));

  let modelStatus = null;
  if (!args.botOnly && model) {
    const connection = await testModelConnection(model);
    if (!connection.ok) {
      modelStatus = {
        online: false,
        code: connection.error?.code ?? 'unreachable',
        message: connection.error?.message ?? '模型不可达',
        model: { name: model.name, modelId: model.modelId, baseUrl: model.baseUrl },
      };
      console.log(`[benchmark] 真实模型不可用：${modelStatus.code} ${modelStatus.message}`);
    } else {
      modelStatus = {
        online: true,
        durationMs: connection.durationMs,
        model: { name: model.name, modelId: model.modelId, baseUrl: model.baseUrl },
      };
      for (const mode of ['pure', 'assisted']) {
        const rows = [];
        for (const position of POSITIONS) rows.push(await runModel(model, position, mode));
        groups.push(groupRows(mode === 'pure' ? 'KVMem 纯模型' : 'KVMem 规则辅助', rows, POSITIONS));
      }
    }
  } else if (args.botOnly) {
    modelStatus = { online: false, message: '使用 --bot-only，没有调用真实模型。' };
  } else {
    modelStatus = { online: false, message: '配置里没有模型；只报告内置机器人。' };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    model: modelStatus,
    positions: POSITIONS.map(({ id, name, description, seat, moves }) => ({ id, name, description, seat, moves })),
    groups,
    note: '真实模型不可达时，报告只包含内置机器人；KVMem/规则辅助会明确标记为未执行。',
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `gomoku-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  printReport(groups);
  console.log(`\n报告已保存：${path.relative(PROJECT_ROOT, file)}`);
  if (modelStatus?.online === false) console.log(`真实模型未执行：${modelStatus.message}`);
}

main().catch((error) => {
  console.error(`评测失败：${error.stack ?? error.message}`);
  process.exit(1);
});
