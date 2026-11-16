# 添加模型

本文分两部分：普通使用者如何在网页里接入模型，以及开发者如何为全新供应商协议添加适配器。

## 一、网页接入（无需改代码）

### 1. 准备接口信息

你需要从供应商或本地服务处拿到：

- 是否兼容 **OpenAI Chat Completions**（`POST /chat/completions`）。
- Base URL，例如 `https://api.example.com/v1` 或 `http://127.0.0.1:11434/v1`。
- Model ID。
- 是否需要 API Key；若需要，Key 是什么。
- 请求大概需要多久（决定超时毫秒数）。

### 2. 新增配置

1. 打开 `http://127.0.0.1:8787/#/models`。
2. 点击「新增模型」。
3. 填写字段：

| 字段 | 建议 |
| --- | --- |
| 显示名称 | 例如「本机 KVMem」「DeepSeek」 |
| 接口类型 | 第一版选「OpenAI 兼容接口」 |
| Base URL | 可含 `/v1`、可带末尾斜杠；也可粘贴完整 `/chat/completions` |
| Model ID | 必须与供应商一致 |
| API Key | 可空；有值时按 Bearer 发送 |
| 超时 | 本机首次推理较慢时常设 120000 |
| 重试 | 模型非法落子时的额外尝试次数；建议 1–2 |

4. 点击「测试当前填写」。测试会真实请求模型，对话内容是极小的 `只回复 OK`。
5. 保存后，在「开桌」里将某席改为「普通模型」并选择这项配置。

### 3. 本地 KVMem 示例

首次启动会从 `config/arena.example.json` 生成一个可编辑示例：

```json
{
  "name": "本地 KVMem（示例）",
  "provider": "openai-compatible",
  "baseUrl": "http://127.0.0.1:18200/v1",
  "modelId": "kvmem-polystrata-qwen35",
  "apiKey": "local",
  "timeoutMs": 120000,
  "maxRetries": 2
}
```

这里 `local` 是用户要求的本机字面值示例，不是云服务真实凭据。示例配置保存后也**不会自动使用**，必须由用户在开桌页主动选择。

### 4. Base URL 处理

- `http://127.0.0.1:18200` → `http://127.0.0.1:18200/v1/chat/completions`
- `http://127.0.0.1:18200/v1` → `http://127.0.0.1:18200/v1/chat/completions`
- `http://127.0.0.1:18200/v1/` → 同上
- 已包含 `/chat/completions` 的完整地址保持不变

若你的服务使用非标准路径，直接填完整 endpoint 最稳。

### 5. 空 Key 与自定义 Bearer

- **API Key 留空**：不会发送 `Authorization` 头。
- **API Key 填任意值**：发送 `Authorization: Bearer <值>`。
- Key 永远不会返回给浏览器读取；编辑时留空表示保留原 Key，勾选「清除已保存的 API Key」才会清空。

### 6. 测试失败怎么判断

网页会分三项显示：

- **配置**：URL 不合法、字段缺失、超时超出范围等。不会发出请求。
- **地址**：DNS 解析失败、连接被拒绝、超时、接口 404 等。检查 Base URL、端口、本地服务是否启动。
- **认证与模型**：HTTP 401/403 = Key 失败；HTTP 404 且供应商提示 model 不存在 = Model ID 错误；HTTP 400/422 = 请求被拒绝；HTTP 5xx = 服务端错误。

错误详情会先脱敏，不会包括 Key 本身。若日志或对话异常，请检查 `data\arena.json` 是否为本机私密文件。

## 二、开发者：新增供应商协议

第一版只内置 OpenAI 兼容适配器，但模型调用层是可替换的。

相关文件：

```text
packages/models/
  provider-registry.mjs       适配器注册表
  openai-compatible.mjs       OpenAI 兼容实现
  client.mjs                  统一校验、测试、请求入口
  errors.mjs                  错误分类与脱敏
  index.mjs                   对外导出
apps/server/app.mjs           模型管理 API；provider 列表来自 registry
apps/web/app.js               新增/编辑模型表单，provider 选项来自 API
```

### 适配器契约

在 `provider-registry.mjs` 中注册的对象至少包含：

```js
{
  id: 'my-provider',
  label: '我的供应商协议',
  description: '...',
  defaultBaseUrl: 'https://...',
  defaultModelId: '...',
  fields: [...],                     // 可选：说明性字段
  normalizeBaseUrl(baseUrl),         // 校验并返回规范化地址；非法时抛错
  resolveChatEndpoint(baseUrl),      // 返回真实请求 URL
  createCompletion(config, options), // 核心调用
  testConnection(config, options),   // 连接测试
}
```

`createCompletion` 的参数：

```js
{
  messages: [{ role: 'system'|'user'|'assistant', content: '...' }],
  temperature: 0.2,
  maxTokens: 300,
  signal: AbortSignal,   // 暂停/结束必须可取消
}
```

返回值：

```js
{
  text: '模型返回的文本',
  raw: {},               // 可选原始响应
  endpoint: 'https://...',
  usage: {},             // 可选
}
```

失败时建议抛 `ModelError`（`packages/models/errors.mjs`），字段：

- `code`：`config`、`unreachable`、`timeout`、`auth`、`model_not_found`、`endpoint_not_found`、`rate_limited`、`request_rejected`、`server_error`、`invalid_response`、`cancelled`。
- `stage`：`config` / `network` / `auth` / `model` / `response`。
- `retryable`：是否适合由竞技场自动重试。
- `message`：面向用户的清晰中文。
- `detail`：可选；必须脱敏。

### 示例：一个新的 JSON 协议适配器

以下代码仅示意结构；真正供应商请求体、响应解析和错误码需要按协议实现。

```js
import { ModelError, redactSecret, shorten } from './errors.mjs';
import { registerProvider } from './provider-registry.mjs';

function ensureUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl).replace(/\/+$/, ''));
  } catch {
    throw new ModelError('invalid_url', 'Base URL 不是合法 http(s) 地址。', { stage: 'config' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ModelError('invalid_url', '只支持 http/https。', { stage: 'config' });
  }
  return url;
}

const provider = {
  id: 'my-provider',
  label: '我的供应商（示例）',
  description: '说明协议和适用地址。',
  defaultBaseUrl: 'https://api.example.com',
  defaultModelId: 'example-model',
  normalizeBaseUrl(baseUrl) {
    return ensureUrl(baseUrl).toString().replace(/\/$/, '');
  },
  resolveChatEndpoint(baseUrl) {
    return `${this.normalizeBaseUrl(baseUrl)}/v1/messages`;
  },
  async createCompletion(config, { messages, temperature = 0.2, maxTokens = 300, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 120000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(this.resolveChatEndpoint(config.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.modelId,
          system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
          messages: messages.filter((m) => m.role !== 'system'),
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        if (response.status === 401) {
          throw new ModelError('auth', '认证失败，请检查 API Key。', { stage: 'auth', status: 401 });
        }
        throw new ModelError('request_rejected', `模型请求失败（HTTP ${response.status}）。`, {
          stage: 'model',
          status: response.status,
          detail: redactSecret(shorten(body, 300), config.apiKey),
        });
      }
      const json = JSON.parse(body);
      return {
        text: String(json.choices?.[0]?.message?.content ?? ''),
        raw: json,
        endpoint: this.resolveChatEndpoint(config.baseUrl),
      };
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw new ModelError('unreachable', '地址不可达或请求失败。', { stage: 'network' });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
  async testConnection(config, options) {
    // 可以直接复用 createCompletion；也可以实现供应商自己的轻量探测。
    const started = Date.now();
    try {
      await this.createCompletion(config, {
        ...options,
        messages: [{ role: 'user', content: '只回复 OK。' }],
        maxTokens: 8,
      });
      return {
        ok: true,
        durationMs: Date.now() - started,
        checks: [
          { name: '配置', ok: true, detail: '字段格式正确。' },
          { name: '地址', ok: true, detail: '收到 HTTP 响应。' },
          { name: '认证与模型', ok: true, detail: '模型返回内容。' },
        ],
      };
    } catch (error) {
      const e = error instanceof ModelError ? error : new ModelError('unreachable', '连接失败。');
      return {
        ok: false,
        durationMs: Date.now() - started,
        error: e.toPublic(),
        checks: [
          { name: '配置', ok: e.stage !== 'config', detail: e.stage === 'config' ? e.message : '' },
          { name: '地址', ok: !['network', 'config'].includes(e.stage), detail: e.stage === 'network' ? e.message : '' },
          { name: '认证与模型', ok: !['auth', 'model', 'response'].includes(e.stage), detail: e.message },
        ],
      };
    }
  },
};

registerProvider(provider);
export default provider;
```

然后在 `packages/models/provider-registry.mjs` 中导入并注册（如果放在独立文件），或在现有模块里直接调用 `registerProvider`。网页会自动从 `/api/providers` 拿到 `label` 和选项。

### 适配器开发验收

1. 新增单元测试，覆盖：
   - Base URL 规范化；
   - 空 Key 不发送鉴权头；
   - 自定义 Key 发送 Bearer；
   - 401/403、模型不存在、地址不可达、超时；
   - 错误与日志不含 Key。
2. 运行：
   ```powershell
   node --test --test-concurrency=1
   ```
3. 启动服务，在网页新增该 provider 的模型并完成一次真实「测试连接」。
4. 用该模型完成一局至少数手的对局；确认非法落子会重试并暂停，不会改动棋盘。
5. 确认历史导出和回放中没有 Key。

## 三、当前限制

- 第一版只实现 OpenAI 兼容的 Chat Completions；不支持 Responses API、原生 Anthropic Messages、WebSocket 流式协议等，但可通过适配器扩展。
- 内置机器人不通过模型接口，不会被用来自动替换故障模型。
- API Key 在本机配置文件中以明文保存；这是单机工具的可接受取舍，但不适合多用户共享机器。
