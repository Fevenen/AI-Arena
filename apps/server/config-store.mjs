import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createId } from '../../packages/core/ids.mjs';
import {
  validateModelConfig,
  normalizeBaseUrl,
  resolveChatEndpoint,
  listProviders,
} from '../../packages/models/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const TEMPLATE_PATH = path.join(PROJECT_ROOT, 'config', 'arena.example.json');

function atomicWriteJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  fs.renameSync(temporary, file);
}

function readJsonFile(file) {
  // Windows 记事本/PowerShell 5.1 可能写入 UTF-8 BOM；JSON.parse 不接受 BOM。
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function defaultConfig() {
  return readJsonFile(TEMPLATE_PATH);
}

function normalizeConfig(raw, configPath) {
  const defaults = defaultConfig();
  const config = {
    ...defaults,
    ...raw,
    server: { ...defaults.server, ...(raw.server ?? {}) },
    models: Array.isArray(raw.models) ? raw.models : [],
    dafeiyu: { ...defaults.dafeiyu, ...(raw.dafeiyu ?? {}) },
    match: { ...defaults.match, ...(raw.match ?? {}) },
    storage: { ...defaults.storage, ...(raw.storage ?? {}) },
  };
  const port = Number(config.server.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('配置 server.port 必须是 0 到 65535 的整数');
  }
  config.server.port = port;
  config.server.host = String(config.server.host || '127.0.0.1');
  config.match.aiMoveDelayMs = Math.max(0, Number(config.match.aiMoveDelayMs) || 0);
  config.match.initialAiDelayMs = Math.max(0, Number(config.match.initialAiDelayMs) || 0);
  config.match.autoCommentCooldownMs = Math.max(0, Number(config.match.autoCommentCooldownMs) || 0);
  config.match.maxModelRetries = Math.min(5, Math.max(0, Number(config.match.maxModelRetries) || 0));
  config.match.sseHeartbeatMs = Math.max(5000, Number(config.match.sseHeartbeatMs) || 20000);
  config.storage.matchDir = path.resolve(path.dirname(configPath), String(config.storage.matchDir || 'matches'));
  return config;
}

export class ConfigStore {
  constructor({ configPath = process.env.ARENA_CONFIG || path.join(PROJECT_ROOT, 'data', 'arena.json') } = {}) {
    this.configPath = path.resolve(configPath);
    this.created = false;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.configPath)) {
      const template = defaultConfig();
      const now = new Date().toISOString();
      template.models = template.models.map((model) => ({
        ...model,
        createdAt: now,
        updatedAt: now,
      }));
      atomicWriteJson(this.configPath, template);
      this.created = true;
    }
    let raw;
    try {
      raw = readJsonFile(this.configPath);
    } catch (error) {
      throw new Error(`无法读取配置 ${this.configPath}：${error.message}`);
    }
    this.config = normalizeConfig(raw, this.configPath);
    // 环境变量只用于本机部署/测试；不会写入配置。
    if (process.env.ARENA_HOST) this.config.server.host = process.env.ARENA_HOST;
    if (process.env.ARENA_PORT) {
      const port = Number(process.env.ARENA_PORT);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('ARENA_PORT 必须是 0 到 65535 的整数');
      }
      this.config.server.port = port;
    }
    return this;
  }

  save() {
    const persisted = structuredClone(this.config);
    // storage.matchDir 在内存中已解析为绝对路径；配置文件保留原始相对值。
    try {
      const raw = readJsonFile(this.configPath);
      persisted.storage.matchDir = raw.storage?.matchDir ?? 'matches';
    } catch {
      persisted.storage.matchDir = 'matches';
    }
    atomicWriteJson(this.configPath, persisted);
  }

  get server() {
    return this.config.server;
  }

  get matchSettings() {
    return this.config.match;
  }

  get matchDir() {
    return this.config.storage.matchDir;
  }

  modelConfig(id) {
    return this.config.models.find((model) => model.id === id) ?? null;
  }

  publicModel(model) {
    let endpoint = '';
    try {
      endpoint = resolveChatEndpoint(model.baseUrl);
    } catch {
      endpoint = String(model.baseUrl ?? '');
    }
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      providerLabel: listProviders().find((item) => item.id === model.provider)?.label ?? model.provider,
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      timeoutMs: model.timeoutMs,
      maxRetries: model.maxRetries ?? this.config.match.maxModelRetries,
      hasApiKey: Boolean(model.apiKey),
      isExample: Boolean(model.isExample),
      endpoint,
      createdAt: model.createdAt ?? null,
      updatedAt: model.updatedAt ?? null,
    };
  }

  listModels() {
    return this.config.models.map((model) => this.publicModel(model));
  }

  addModel(input) {
    const validated = validateModelConfig(input);
    if (!validated.ok) {
      const error = new Error(validated.errors.join(' '));
      error.code = 'invalid_model';
      error.details = validated.errors;
      throw error;
    }
    if (this.config.models.some((model) => model.name === validated.value.name)) {
      const error = new Error('已经存在同名模型配置。');
      error.code = 'duplicate_model_name';
      throw error;
    }
    const now = new Date().toISOString();
    const model = {
      id: createId('model'),
      ...validated.value,
      baseUrl: normalizeBaseUrl(validated.value.baseUrl),
      createdAt: now,
      updatedAt: now,
    };
    this.config.models.push(model);
    this.save();
    return this.publicModel(model);
  }

  updateModel(id, input) {
    const index = this.config.models.findIndex((model) => model.id === id);
    if (index < 0) return null;
    const previous = this.config.models[index];
    const merged = {
      ...previous,
      ...input,
      name: input.name ?? previous.name,
      baseUrl: input.baseUrl ?? previous.baseUrl,
      modelId: input.modelId ?? previous.modelId,
      provider: input.provider ?? previous.provider,
      timeoutMs: input.timeoutMs ?? previous.timeoutMs,
      maxRetries: input.maxRetries ?? previous.maxRetries,
    };
    // 未提交 apiKey 表示保留原 Key；显式传空字符串表示清除。
    if (!Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
      merged.apiKey = previous.apiKey;
    }
    const validated = validateModelConfig(merged);
    if (!validated.ok) {
      const error = new Error(validated.errors.join(' '));
      error.code = 'invalid_model';
      error.details = validated.errors;
      throw error;
    }
    if (this.config.models.some((model) => model.id !== id && model.name === validated.value.name)) {
      const error = new Error('已经存在同名模型配置。');
      error.code = 'duplicate_model_name';
      throw error;
    }
    const model = {
      ...previous,
      ...validated.value,
      baseUrl: normalizeBaseUrl(validated.value.baseUrl),
      updatedAt: new Date().toISOString(),
    };
    this.config.models[index] = model;
    this.save();
    return this.publicModel(model);
  }

  removeModel(id) {
    const index = this.config.models.findIndex((model) => model.id === id);
    if (index < 0) return false;
    this.config.models.splice(index, 1);
    this.save();
    return true;
  }

  dafeiyuSettings() {
    return { ...this.config.dafeiyu };
  }

  publicDafeiyuSettings() {
    const settings = this.config.dafeiyu;
    let online = false;
    try {
      online = Boolean(settings.bridgeUrl) && /^https?:\/\//i.test(settings.bridgeUrl);
    } catch {
      online = false;
    }
    return {
      bridgeUrl: settings.bridgeUrl,
      apiBase: settings.apiBase,
      origin: settings.origin || '',
      timeoutMs: settings.timeoutMs,
      healthIntervalMs: settings.healthIntervalMs,
      hasToken: Boolean(settings.token),
      configured: online,
      autoCommentByDefault: Boolean(settings.autoCommentByDefault ?? true),
      voiceByDefault: Boolean(settings.voiceByDefault ?? false),
    };
  }

  updateDafeiyu(input) {
    const current = this.config.dafeiyu;
    const next = { ...current };
    if (typeof input.bridgeUrl === 'string') {
      let url;
      try {
        url = new URL(input.bridgeUrl.trim());
      } catch {
        const error = new Error('大肥鱼服务地址不是合法的 http(s) URL。');
        error.code = 'invalid_dafeiyu_url';
        throw error;
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        const error = new Error('大肥鱼服务地址只支持 http:// 或 https://。');
        error.code = 'invalid_dafeiyu_url';
        throw error;
      }
      next.bridgeUrl = url.toString().replace(/\/$/, '');
    }
    if (typeof input.apiBase === 'string') {
      const apiBase = input.apiBase.trim();
      if (!apiBase.startsWith('/')) {
        const error = new Error('大肥鱼 API 路径必须以 / 开头。');
        error.code = 'invalid_dafeiyu_path';
        throw error;
      }
      next.apiBase = apiBase.replace(/\/$/, '');
    }
    if (typeof input.token === 'string') next.token = input.token;
    if (Object.prototype.hasOwnProperty.call(input, 'clearToken') && input.clearToken === true) {
      next.token = '';
    }
    if (typeof input.origin === 'string') next.origin = input.origin.trim().replace(/\/$/, '');
    if (input.timeoutMs != null) {
      const timeout = Number(input.timeoutMs);
      if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 600000) {
        const error = new Error('大肥鱼超时必须是 1000 到 600000 毫秒。');
        error.code = 'invalid_dafeiyu_timeout';
        throw error;
      }
      next.timeoutMs = timeout;
    }
    this.config.dafeiyu = next;
    this.save();
    return this.publicDafeiyuSettings();
  }
}
