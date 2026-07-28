# OpenCode Memory 改动说明与操作手册

> 适用版本：`opencode-mem 2.20.1` 当前 `modify_test` 工作树  
> 文档依据：当前源码与未提交改动，不代表上游已发布版本  
> 最后核对：2026-07-28

## 1. 项目概览

`opencode-mem` 是 OpenCode 的持久化记忆插件。它通过 OpenCode hook 收集会话内容，将技术工作压缩为结构化摘要，生成 embedding，并存入本地分片数据库。后续会话可通过 `memory` 工具、自动上下文注入和 Web UI 使用这些记忆。

核心能力：

- 自动捕获技术对话，跳过问候、闲聊和无结果请求。
- 按项目和用户隔离记忆。
- 提供语义搜索、列表、删除和用户画像查询。
- 支持 OpenCode 已认证 provider，也支持插件直接调用外部 API。
- 支持本地 embedding 或 OpenAI 兼容的远程 embedding API。
- 提供 Web UI、过期数据清理、手动去重和诊断日志。

## 2. 当前工作树改动

本次未提交改动涉及 13 个源码文件，主要分为四组。

### 2.1 诊断日志框架

`src/services/logger.ts:138-155` 新增：

| API                   | 行为                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `isDiagEnabled()`     | 配置文件 `diag: true` 或环境变量 `OPENCODE_MEM_DIAG=1`，任一为 true 即启用                 |
| `setDiagFromConfig()` | 由 `config.ts` 在 `initConfig` 时调用，把 `opencode-mem.jsonc` 的 `diag` 字段注入到 logger |
| `truncateValue()`     | 超过 8 个字符时保留前 8 个字符                                                             |
| `diagLog()`           | 同一进程内，同一 `location + message` 只写一次                                             |
| `diagLogOnce()`       | 当前是 `diagLog()` 的别名                                                                  |
| `diagWarn()`          | 每次调用都记录诊断警告                                                                     |
| `diagAlert()`         | 每次调用都记录高优先级诊断告警                                                             |

诊断开关现在有两种启用方式，**任一为 true 即启用**：

1. 配置文件 `diag: true`（`~/.config/opencode/opencode-mem.jsonc` 或项目级 `.opencode/opencode-mem.jsonc`），在 `initConfig()` 完成后生效，见 `src/config.ts:863-865`。
2. 环境变量 `OPENCODE_MEM_DIAG=1`，在整个进程生命周期内有效，特别适合配置加载前的早期启动阶段或临时调试。

两者互不覆盖：即使配置文件设为 `false`，环境变量 `OPENCODE_MEM_DIAG=1` 仍能开启诊断。两者都未设置时 `isDiagEnabled()` 返回 `false`。

普通日志路径由 `OPENCODE_MEM_LOG_FILE` 控制；未设置时使用 `~/.opencode-mem/opencode-mem.log`，见 `src/services/logger.ts:14-16`。

日志轮转和旧日志清理失败不再静默忽略，而会写入 stderr，见 `src/services/logger.ts:75-78` 和 `src/services/logger.ts:101-104`。此行为不依赖诊断模式。

### 2.2 可观测性覆盖

诊断点已覆盖：

- 全局配置、项目配置、模板创建和配置合并：`src/config.ts:212-243`、`src/config.ts:525-545`、`src/config.ts:776-795`。
- 插件 readiness、hook guard、空闲捕获和 compaction：`src/index.ts:75-108`、`src/index.ts:236-245`、`src/index.ts:606-649`。
- Git 用户、远程仓库、项目根目录和 tag 生成：`src/services/tags.ts:59-152`、`src/services/tags.ts:200-267`。
- client、Web API 和 migration 的 container tag 解析：`src/services/client.ts:44-90`、`src/services/api-handlers.ts:84-110`、`src/services/migration-service.ts:253-280`。
- auto-capture 获取上一条项目记忆失败后的降级：`src/services/auto-capture.ts:272-300`。
- Gemini 请求地址审计和响应体 API key 检测：`src/services/ai/providers/google-gemini.ts:153-225`。
- Web UI CDN 脚本审计：`src/web/index.html:401-437`。

### 2.3 OpenAI 兼容响应修复

`src/services/ai/providers/openai-chat-completion.ts` 增加两类兼容逻辑。

第一类是响应 envelope 修复，见 `src/services/ai/providers/openai-chat-completion.ts:313-321`：

1. 以文本读取成功响应。
2. 如果完整 JSON 对象后附带 `data:` trailer，则截断 trailer。
3. 对保留内容执行 `JSON.parse()`。

它可兼容以下非标准响应：

```text
{"choices":[...]}
data: [DONE]
```

它不等同于 SSE parser，不能解析标准的多事件 SSE：

```text
data: {"choices":[...]}
data: [DONE]
```

第二类是 tool-call 参数修复，见 `src/services/ai/providers/openai-chat-completion.ts:389-435`：

1. 直接解析原始参数。
2. 提取第一段平衡的 JSON 对象或数组。
3. 去除 XML-like 标签。
4. 修复部分未转义引号。
5. 使用 `UserProfileValidator` 验证最终结构。

这主要用于兼容某些 OpenAI-compatible 模型生成的不规范 function-call JSON。该修复只作用于插件的 manual `openai-chat` 路径，不作用于 OpenCode `session.prompt` structured-output 路径。

### 2.4 Web UI 诊断注入

主 server 与 worker 在诊断模式下向 `index.html` 注入 `window.__OPENCODE_MEM_DIAG__`：

- `src/services/web-server.ts:599-610`
- `src/services/web-server-worker.ts:314-325`

页面诊断脚本会检查 Lucide、jsonrepair、marked、DOMPurify 以及 CDN script 的 SRI 属性，见 `src/web/index.html:401-437`。

当前实现存在已知时序问题：诊断 flag 被注入在页面审计脚本之后，因此审计脚本执行时 flag 尚未定义。此项改动目前不能按预期输出浏览器诊断日志，修复前不要把“浏览器控制台无 DIAG 输出”判断为 CDN 正常。

## 3. 配置文件与优先级

### 3.1 OpenCode 主配置

OpenCode provider 定义位于 OpenCode 自己的主配置中，通常为：

- `~/.config/opencode/opencode.json`
- `~/.config/opencode/opencode.jsonc`

准确文件名和认证存储方式属于 OpenCode CLI 行为，应以当前安装版本为准，不由本插件实现。

### 3.2 插件全局配置

插件依次查找：

1. `~/.config/opencode/opencode-mem.jsonc`
2. `~/.config/opencode/opencode-mem.json`

定义见 `src/config.ts:9-14`。首次加载时，如果 JSONC 文件不存在，插件会尝试生成配置模板，见 `src/config.ts:525-548`。

### 3.3 项目级配置

每个项目还可定义：

1. `<project>/.opencode/opencode-mem.jsonc`
2. `<project>/.opencode/opencode-mem.json`

项目配置覆盖全局配置，见 `src/config.ts:776-784`。

重要：当前使用对象展开进行浅合并，不是深合并。项目配置如果声明完整的 `chatMessage`、`compaction` 或 `memory` 对象，会替换对应的全局嵌套对象，再由默认值补齐；不要假设项目文件会逐字段继承全局嵌套配置。

## 4. 推荐配置

### 4.1 使用 OpenCode provider 自动捕获

这是推荐方式。provider 的认证、刷新和路由由 OpenCode 管理，插件不需要单独保存该 provider 的 API key，见 `src/config.ts:331-352`。

```jsonc
{
  "opencodeProvider": "your-provider",
  "opencodeModel": "your-model-id",
  "autoCaptureEnabled": true,
  "showAutoCaptureToasts": true,
  "chatMessage": {
    "enabled": true,
  },
}
```

也可让 auto-capture 继承产生当前 prompt 的模型：

```jsonc
{
  "opencodeProvider": "placeholder-required-for-readiness",
  "opencodeModel": "inherit",
}
```

`inherit` 会读取 `chat.params` hook 为 prompt 记录的 `providerId` 和 `modelId`，见 `src/index.ts:346-361` 与 `src/services/auto-capture.ts:362-375`。如果 prompt 没有模型元数据，捕获会失败。

### 4.2 使用插件直连外部 API

当未配置 OpenCode provider，或 OpenCode structured-output 调用失败时，插件使用 manual provider 路径，见 `src/services/auto-capture.ts:442-460`。

```jsonc
{
  "memoryProvider": "openai-chat",
  "memoryModel": "your-model-id",
  "memoryApiUrl": "https://api.example.com/v1",
  "memoryApiKey": "env://MEMORY_API_KEY",
  "memoryTemperature": 0.3,
  "memoryExtraParams": {
    "enable_thinking": false,
  },
}
```

支持的公开配置类型：

- `openai-chat`
- `openai-responses`
- `anthropic`

`memoryExtraParams` 适用于自定义推理服务；例如部分 Qwen 模型可通过 `enable_thinking: false` 减少 tool-call JSON 污染，模板说明见 `src/config.ts:427-436`。

### 4.3 Secret 写法

以下格式适用于插件自己的 `memoryApiKey`、`embeddingApiKey` 和 `webServerAuthPassword` 等 secret 字段：

| 格式     | 示例                        | 建议                 |
| -------- | --------------------------- | -------------------- |
| 环境变量 | `"env://MEMORY_API_KEY"`    | 推荐                 |
| 文件     | `"file:///secure/path/key"` | 适合本机 secret 文件 |
| 明文     | `"sk-..."`                  | 不建议提交到版本库   |

Secret 解析实现见 `src/services/secret-resolver.ts:34-67`。

### 4.4 Embedding 配置

远程 OpenAI-compatible embedding：

```jsonc
{
  "embeddingApiUrl": "https://api.example.com/v1",
  "embeddingApiKey": "env://EMBEDDING_API_KEY",
  "embeddingModel": "BAAI/bge-m3",
  "embeddingDimensions": 1024,
}
```

本地 embedding：

```jsonc
{
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  "embeddingDimensions": 768,
}
```

维度必须与 endpoint 实际返回值一致。当前内置映射不包含 `BAAI/bge-m3`，未知模型会回退到 768，见 `src/config.ts:550-590`。如果使用常见的 1024 维 BGE-M3 endpoint，应显式设置 `embeddingDimensions: 1024`。更换已有数据库的 embedding 模型或维度前，应先备份数据并确认 migration 行为。

### 4.5 Web UI 配置

仅本机访问：

```jsonc
{
  "webServerEnabled": true,
  "webServerHost": "127.0.0.1",
  "webServerPort": 4747,
}
```

局域网访问必须设置认证并配合主机防火墙：

```jsonc
{
  "webServerHost": "0.0.0.0",
  "webServerAuthUsername": "admin",
  "webServerAuthPassword": "env://OPENCODE_MEM_WEB_PASSWORD",
}
```

页面当前从 CDN 加载 Lucide、marked、DOMPurify 和 jsonrepair，见 `src/web/index.html:9-12`。其中部分依赖使用浮动 `@latest`，且均未配置 SRI；不可信网络环境应避免直接暴露 Web UI。

## 5. Auto-Capture 完整流程

```text
用户发送消息
  -> chat.message hook
  -> chatMessage.enabled 检查
  -> prompt 写入 user-prompts.db
  -> OpenCode 发出 session.idle
  -> 插件额外等待 10 秒
  -> performAutoCapture()
  -> provider readiness 检查
  -> 按时间顺序 claim 未捕获 prompt
  -> 读取该 prompt 后、下一个 user message 前的 assistant 响应
  -> 拼接文本、简化 tool calls、上一条项目记忆
  -> LLM structured output / function call
  -> skip: 删除 prompt
  -> capture: 生成 embedding 并写入项目 shard
  -> 关联 prompt 与 memory，标记已捕获
  -> server owner 执行画像学习、到期清理和 SQLite checkpoint
```

关键实现：

- prompt hook 与 `chatMessage.enabled` gate：`src/index.ts:236-260`。
- idle event 与额外 10 秒 timer：`src/index.ts:604-637`。
- provider readiness：`src/services/auto-capture.ts:27-35`。
- prompt claim、重试和释放：`src/services/auto-capture.ts:46-68`、`src/services/auto-capture.ts:165-207`。
- assistant 响应窗口：`src/services/auto-capture.ts:69-99`、`src/services/auto-capture.ts:211-220`。
- skip 与持久化：`src/services/auto-capture.ts:108-147`。
- OpenCode provider 与 manual fallback：`src/services/auto-capture.ts:346-460`。

注意事项：

- `autoCaptureEnabled: true` 不足以保证捕获；`chatMessage.enabled` 也必须为 `true`，否则不会保存新 prompt。
- “10 秒”是收到 OpenCode `session.idle` 之后的额外 debounce，不是从用户停止输入开始独立计时。
- 当前 `idleTimeout` 和 `isCaptureRunning` 是进程级变量，多会话并发时后来的 idle event 可能替换前一个 timer。
- OpenCode provider 失败后会尝试 manual fallback；如果未配置 manual provider，最终错误可能显示 `External API not configured for auto-capture`，应向前查看上一条 provider failure 日志。

## 6. 记忆范围与 Tag 技术

项目和用户 tag 的结构为：

```text
<containerTagPrefix>_project_<16-char-sha256>
<containerTagPrefix>_user_<16-char-sha256>
```

用户身份优先级：

1. `userEmailOverride`
2. Git 全局 email
3. `userNameOverride`
4. Git 全局 name
5. `USER` / `USERNAME`
6. `anonymous`

项目身份优先级：

1. 向上查找 `.opencode-mem-project` marker。
2. Git common directory、remote URL 或项目路径。
3. 对身份字符串计算 SHA-256 并截取 16 个十六进制字符。

生成逻辑见 `src/services/tags.ts:155-192` 和 `src/services/tags.ts:200-267`。

当前 client、Web API 和 migration 各自实现 tag parser，规则并不完全一致。不要在 `containerTagPrefix` 中加入下划线，否则基于 `split("_")` 的 scope/hash 解析可能错误，相关代码见 `src/services/client.ts:44-90`、`src/services/api-handlers.ts:84-110` 和 `src/services/migration-service.ts:253-280`。

## 7. 使用与验证

### 7.1 memory 工具

```text
memory({ mode: "search", query: "关键词" })
memory({ mode: "list", limit: 10 })
memory({ mode: "profile" })
memory({ mode: "forget", memoryId: "记忆 ID" })
```

项目内默认搜索行为由 `memory.defaultScope` 控制；需要跨项目时可使用 `all-projects` scope。

### 7.2 Web UI

默认地址：

```text
http://127.0.0.1:4747
```

### 7.3 启用诊断

支持两种方式，**任一为 true 即启用**，互不覆盖。

**方式一：配置文件（持久生效）**

在 `~/.config/opencode/opencode-mem.jsonc` 或项目级 `.opencode/opencode-mem.jsonc` 中添加：

```jsonc
{
  "diag": true,
}
```

该字段在 `initConfig()` 完成后生效，适合排查 `session.idle`、auto-capture、配置合并等运行期问题。默认 `false`，配置文件中未写也等同于关闭。

**方式二：环境变量（临时/早期启动）**

必须在启动 OpenCode 之前设置：

```bash
export OPENCODE_MEM_DIAG=1
opencode
```

环境变量在整个进程生命周期内有效，特别适合配置加载前的早期启动阶段。即使配置文件设为 `false`，环境变量仍能强制开启。

**查看日志**

另一个终端查看日志：

```bash
tail -f ~/.opencode-mem/opencode-mem.log
```

筛选关键事件：

```bash
grep -E "\[DIAG|Auto-capture|memory persisted|provider failed|final error" ~/.opencode-mem/opencode-mem.log
```

可覆盖日志位置：

```bash
export OPENCODE_MEM_LOG_FILE=/tmp/opencode-mem.log
```

真实可用的成功/失败日志包括：

```text
Auto-capture memory persisted
Auto-capture skipped
auto-capture: opencode provider failed, falling back to external API
Auto-capture warning (attempt N/M)
Auto-capture final error after N attempts
```

远程 embedding 成功时不会输出 `Embedding model warmed up`；该日志只属于本地 embedding warmup，见 `src/services/embedding.ts:69-104`。

### 7.4 最小端到端验证

1. 启动时设置 `OPENCODE_MEM_DIAG=1`，或在配置文件中设置 `"diag": true`。
2. 在一个新会话中完成明确的技术任务，例如修改一个函数并运行测试。
3. 等待 OpenCode 把会话置为 idle，再等待插件额外的 10 秒。
4. 查找 `Auto-capture memory persisted` 或 `Auto-capture skipped`。
5. 使用 `memory({ mode: "list", limit: 10 })` 验证新记录。
6. 使用摘要中的技术关键词执行 `memory({ mode: "search", query: "..." })`。
7. 在 Web UI 中确认项目、scope、时间和 tags。

## 8. 数据存储与维护

默认存储结构：

```text
~/.opencode-mem/data/
├── metadata.db
├── user-profiles.db
├── user-prompts.db
├── projects/
│   └── project_<hash>_shard_<n>.db
├── users/
│   └── user_<hash>_shard_<n>.db
├── .cache/
└── cold-buffer.json
```

Web API auth token 位于 `~/.opencode-mem/.auth-token`，不在 `storagePath` 内，见 `src/services/auth-token.ts:7`。

### 8.1 自动清理

```jsonc
{
  "autoCleanupEnabled": true,
  "autoCleanupRetentionDays": 30,
}
```

清理依据是 `updated_at`，会跳过 pinned memory，并处理旧 prompt。自动清理由 Web server owner 在 idle maintenance 中触发，且同一进程每天最多执行一次，见 `src/services/cleanup-service.ts:23-118` 与 `src/index.ts:625-630`。

### 8.2 去重

```jsonc
{
  "deduplicationEnabled": true,
  "deduplicationSimilarityThreshold": 0.9,
}
```

去重不是定时自动任务。必须通过 Web UI 或 API 显式执行，见 `src/services/api-handlers.ts:847-856` 和 `src/web/app.js:1918`。执行时会删除完全重复项；相似度超过阈值的近似重复项只形成候选组供检查，见 `src/services/deduplication-service.ts:53-122`。

## 9. 故障排查

### 9.1 Auto-capture 完全没有触发

检查：

- `autoCaptureEnabled` 是否为 `true`。
- `chatMessage.enabled` 是否为 `true`。
- 是否真的收到 OpenCode `session.idle`，并等待了额外 10 秒。
- `autoCaptureProviderStatus.ready` 是否为 `true`。
- OpenCode provider 和 model 是否同时设置，或 manual provider 三项是否完整。

```bash
grep -E "plugin readiness|session.idle guard|autoCaptureProviderStatus|Auto-capture disabled" ~/.opencode-mem/opencode-mem.log
```

### 9.2 OpenCode provider 失败

```bash
grep -E "opencode provider failed|not connected|structured-output|External API not configured" ~/.opencode-mem/opencode-mem.log
```

如果模型经常生成无效结构化结果：

- 先确认该模型支持 structured output/tool calling。
- 使用更稳定的 provider/model。
- 或配置完整 manual fallback。
- Qwen manual `openai-chat` 路径可尝试 `memoryExtraParams.enable_thinking: false`。

### 9.3 Embedding 失败或搜索异常

检查：

- endpoint、API key 和模型名。
- `embeddingDimensions` 是否等于实际返回维度。
- 是否在已有数据上直接更换模型或维度。
- 本地模型是否能访问 Hugging Face，或本地 cache 是否完整。

### 9.4 配置没有生效

诊断模式下检查 `loaded`、`parse failed` 与 `merged config` 日志。注意 `diagLog()` 对相同 `location + message` 每进程只记录一次，因此日志可能只展示第一个全局或项目路径，而不是全部路径。

### 9.5 Container tag 或 shard 错误

检查 `containerTagPrefix` 是否包含下划线、raw tag 是否符合 `<prefix>_<scope>_<hash>`，以及 migration 是否报告 unsafe hash。修改 prefix 会改变数据定位，操作前应备份 `storagePath`。

## 10. 当前已知风险

以下是本次改动审查后仍需处理的事项：

1. Web UI DIAG flag 注入晚于审计脚本，浏览器 CDN audit 实际不会运行。
2. 新增 logger imports 后，部分测试中的 `mock.module("../src/services/logger.js")` 尚未补齐 `isDiagEnabled`、`diagLog`、`diagWarn`、`truncateValue`，测试可能在模块加载阶段失败。
3. 诊断日志可能记录完整项目路径、fallback 用户名、raw container tag 以及截断 email；开启诊断前应评估日志访问权限。
4. Gemini error body 在执行 API key 泄漏检测前已写入普通错误日志；检测只能告警，不能阻止已发生的泄漏。
5. `diagLog()` 是进程级一次性日志，多项目进程只会看到第一个相同诊断点的数据。
6. OpenAI tool-call 修复使用启发式 XML/引号处理，可能改变合法 HTML/XML 文本，且尚无针对性单元测试。
7. JSON + `data: [DONE]` 修复不是完整 SSE 支持。
8. `isConfigured()` 仍固定返回 `true`，见 `src/config.ts:798-805`；实际 auto-capture readiness 依赖 `CONFIG.autoCaptureProviderStatus`。
9. 三处 container tag parser 规则不统一，带下划线的自定义 prefix 存在兼容风险。
10. Gemini provider factory 与公开 config 类型/模板不一致，当前不应把 `google-gemini` 当作稳定公开配置。

## 11. 维护者验证清单

本次文档核对时的实际结果：

- `bun run typecheck`：通过。
- `git diff --check`：通过。
- 文档 `prettier --check`：通过。
- `bun test`：222 项通过，8 项失败。
- 7 项失败来自测试进程中的 logger mock 未导出新增诊断函数，涉及 `api-handlers-container-tag-traversal.test.ts`、`auto-capture.test.ts` 和 `tool-scope.test.ts`。
- 1 项失败来自 `ai-provider-config.test.ts` 的成功响应 mock 只提供 `json()`，而生产代码已改为调用 `text()`，导致预期日志文件未生成。

提交本次改动前至少执行：

```bash
bun run typecheck
bun test
bun run format:check
git diff --check
```

建议补充的高价值测试：

- JSON 后附 `data: [DONE]` 的 OpenAI-compatible response。
- 标准 SSE、多事件 SSE 和 malformed JSON。
- XML tag、未转义引号、字符串内花括号及合法 HTML 的 tool-call 参数。
- Web server 与 worker 的 DIAG flag 注入顺序。
- Gemini error/success body 的 secret redaction。
- `containerTagPrefix` 包含下划线时的统一处理。
- auto-capture previous-memory lookup 降级日志。
- 所有 logger mock 对新导出的诊断函数保持一致。

## 12. 源码导航

| 主题                        | 主要文件                                              |
| --------------------------- | ----------------------------------------------------- |
| 配置、默认值、readiness     | `src/config.ts`                                       |
| OpenCode hooks、memory tool | `src/index.ts`                                        |
| 自动捕获编排                | `src/services/auto-capture.ts`                        |
| OpenAI-compatible provider  | `src/services/ai/providers/openai-chat-completion.ts` |
| Gemini provider             | `src/services/ai/providers/google-gemini.ts`          |
| embedding                   | `src/services/embedding.ts`                           |
| tag 和项目身份              | `src/services/tags.ts`                                |
| 记忆 client                 | `src/services/client.ts`                              |
| 日志与诊断                  | `src/services/logger.ts`                              |
| Web/API handlers            | `src/services/api-handlers.ts`                        |
| Web server                  | `src/services/web-server.ts`                          |
| Web worker                  | `src/services/web-server-worker.ts`                   |
| Web 页面                    | `src/web/index.html`、`src/web/app.js`                |
| 清理                        | `src/services/cleanup-service.ts`                     |
| 去重                        | `src/services/deduplication-service.ts`               |
| migration                   | `src/services/migration-service.ts`                   |
