# Memory 工具完整闭环流程文档

## 概述

opencode-mem 的记忆系统实现了 **add → search/list → session.idle writeback** 的完整闭环。本文档详细说明每个环节的实现原理、API 调用方式和数据流。

---

## 闭环流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Memory 工具完整闭环                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐ │
│   │  memory  │ ──▶ │  memory  │ ──▶ │  memory  │ ──▶ │session.  │ │
│   │   add    │     │  search  │     │   list   │     │  idle    │ │
│   │          │     │          │     │          │     │writeback │ │
│   └──────────┘     └──────────┘     └──────────┘     └──────────┘ │
│        │                                                    │      │
│        │                    ┌──────────┐                   │      │
│        └───────────────────▶│  向量    │◀──────────────────┘      │
│                             │  数据库  │                              │
│                             │ (Hnswlib)│                              │
│                             └──────────┘                              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 1: 添加记忆 (memory add)

### API 签名

```typescript
async addMemory(
  content: string,           // 记忆内容
  containerTag: string,      // 项目标签，如 "project/my-project"
  metadata?: {               // 可选元数据
    type?: MemoryType;       // 记忆类型: learning | pattern | fact | preference | architecture | bug
    tags?: string[];        // 标签数组
    source?: "manual" | "auto-capture" | "import" | "api";
    sessionID?: string;
    tool?: string;
    // ... 其他自定义字段
  }
): Promise<{ success: boolean; id?: string; error?: string; }>
```

### 实现位置

- **入口**: `src/index.ts:762`
- **核心实现**: `src/services/client.ts:179-303`

### 核心逻辑

```typescript
// src/services/client.ts:179-239
async addMemory(content: string, containerTag: string, metadata?: {...}) {
  await this.initialize();  // 确保系统已初始化

  // 1. 生成内容向量 (使用 embedding service)
  const vector = await embeddingService.embedWithTimeout(content);

  // 2. 如果有标签，也为标签生成向量
  let tagsVector: Float32Array | undefined = undefined;
  if (tags.length > 0) {
    tagsVector = await embeddingService.embedWithTimeout(`Topics: ${tags.join(", ")}`);
  }

  // 3. 确定写入的分片
  const { scope, hash } = extractScopeFromContainerTag(containerTag);
  const shard = shardManager.getWriteShard(scope, hash);

  // 4. 生成唯一 ID
  const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

  // 5. 构建记录并写入
  const record: MemoryRecord = {
    id,
    content,
    vector,
    tagsVector,
    containerTag,
    // ... 其他字段
  };

  // 6. 写入向量数据库 (Hnswlib) 和 SQLite
  await vectorSearch.addToShard(shard, record);
  // ... 同步写入 SQLite
}
```

### 数据流向

```
用户输入内容
      │
      ▼
embeddingService.embedWithTimeout()
      │
      ▼
生成 Float32Array 向量 (dim=768)
      │
      ├──▶ Hnswlib 向量索引
      │
      └──▶ SQLite 元数据表
```

---

## Step 2: 搜索记忆 (memory search)

### API 签名

```typescript
async searchMemories(
  query: string,              // 搜索关键词
  containerTag: string,       // 项目标签
  scope: MemoryScope = "project"  // 搜索范围: project | all-projects
): Promise<{
  success: boolean;
  results: SearchResult[];
  total: number;
  timing: number;
}>
```

### 实现位置

- **入口**: `src/index.ts:783`
- **核心实现**: `src/services/client.ts:150-177`

### 核心逻辑

```typescript
// src/services/client.ts:150-177
async searchMemories(query: string, containerTag: string, scope: MemoryScope = "project") {
  await this.initialize();

  // 1. 将搜索词转为向量
  const queryVector = await embeddingService.embedWithTimeout(query);

  // 2. 解析 scope 和 hash
  const resolved = resolveScopeValue(scope, containerTag);

  // 3. 获取所有相关分片
  const shards = shardManager.getAllShards(resolved.scope, resolved.hash);
  if (shards.length === 0) {
    return { success: true, results: [], total: 0, timing: 0 };
  }

  // 4. 在所有分片上执行向量搜索
  const results = await vectorSearch.searchAcrossShards(
    shards,
    queryVector,
    scope === "all-projects" ? "" : containerTag,
    CONFIG.maxMemories,
    CONFIG.similarityThreshold,
    query
  );

  return { success: true, results, total: results.length, timing: 0 };
}
```

### 向量搜索原理

```
搜索词 "TypeScript 泛型"
        │
        ▼
 embeddingService.embedWithTimeout()
        │
        ▼
 查询向量 Q (768维)
        │
        ▼
   Hnswlib ANN 搜索
   (余弦相似度 / L2 距离)
        │
        ▼
 返回 top-k 最近邻
```

---

## Step 3: 列出记忆 (memory list)

### API 签名

```typescript
async listMemories(
  containerTag: string,      // 项目标签
  limit: number = 20,        // 返回数量限制
  scope: MemoryScope = "project"
): Promise<{
  success: boolean;
  memories: MemoryRecord[];
  total: number;
}>
```

### 实现位置

- **入口**: `src/index.ts` (list 模式)
- **核心实现**: `src/services/client.ts`

### 核心逻辑

直接查询 SQLite 数据库，按创建时间倒序返回记忆列表。

---

## Step 4: Session Idle Writeback

### 触发机制

当会话空闲（用户无操作）超过 10 秒时，系统自动触发 `session.idle` 事件。

### 事件处理流程

```typescript
// src/index.ts:1001-1180
if (event.type === "session.idle") {
  const sessionID = event.properties?.sessionID;
  if (!sessionID) return;

  // 延迟 10 秒执行
  idleTimeout = setTimeout(async () => {
    // 1. 自动记忆捕获 (如果启用)
    if (CONFIG.autoCaptureEnabled) {
      await performAutoCapture(ctx, sessionID, directory);
    }

    // 2. 获取最后未捕获的用户 prompt
    const pendingPrompt = userPromptManager.getLastUncapturedPrompt(sessionID);
    if (pendingPrompt) {
      // 3. 生成任务摘要 (brief)
      const briefResult = await generateTaskSupport({
        mode: "brief",
        task: sanitizedTask,
        containerTag: tags.project.tag,
        sessionID,
        scope: CONFIG.memory.defaultScope ?? "project",
      });

      // 4. 生成完成检查清单 (checklist)
      const checklistResult = await generateTaskSupport({
        mode: "checklist",
        task: sanitizedTask,
        containerTag: tags.project.tag,
        sessionID,
        scope: CONFIG.memory.defaultScope ?? "project",
      });

      // 5. 提取执行证据
      const executionEvidence = extractSessionExecutionEvidence(
        idleMessagesResponse.data || [],
        pendingPrompt.messageId
      );

      // 6. 评估证据模板覆盖率
      const evidenceCoverage = evaluateEvidenceTemplateCoverage(
        checklistResult.checklist?.evidenceTemplates,
        executionEvidence
      );

      // 7. 生成完成门建议
      const gateResult = await generateCompletionGateSuggestion({...});

      // 8. 格式化并注入检查清单到会话
      const checklistContext = formatChecklistForPrompt(...);
      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: checklistContext }], noReply: true }
      });

      // 9. ★ 核心: 将 checklist 写入记忆 ★
      const writebackResult = await writeCompletionChecklistMemories({
        task: sanitizedTask,
        sessionID,
        promptId: pendingPrompt.id,
        containerTag: tags.project.tag,
        checklist: checklistResult.checklist!,
        memoryRefs: checklistResult.memoryRefs,
        constraintKinds: briefResult.brief?.constraintKinds,
        evidence: executionEvidence,
        projectInfo: {...}
      });
    }
  }, 10000); // 10 秒延迟
}
```

### writeCompletionChecklistMemories 核心逻辑

```typescript
// src/services/completion-writeback.ts:93-143
async function writeCompletionChecklistMemories(request: CompletionWritebackRequest) {
  // 1. 检查是否已有相同 prompt 的 writeback (避免重复)
  if (await hasExistingWriteback(request.containerTag, request.promptId)) {
    return { success: true, skipped: true, ... };
  }

  // 2. 生成 writeback 草稿 (AI 或 fallback)
  const fallbackDrafts = buildFallbackDrafts(request);
  const aiDrafts = await maybeGenerateWritebackWithAI(request, fallbackDrafts);
  const drafts = mergeDrafts(aiDrafts, fallbackDrafts);

  // 3. 逐条写入记忆
  const writtenMemoryIds: string[] = [];
  for (const draft of drafts) {
    const addResult = await memoryClient.addMemory(draft.content, request.containerTag, {
      type: draft.type,
      source: "api",
      tags: ["completion-gate", draft.mem_type, ...draft.tags],
      sessionID: request.sessionID,
      promptId: request.promptId,
      captureTimestamp: Date.now(),
      writebackSource: COMPLETION_WRITEBACK_SOURCE,
      writebackKind: draft.mem_type,
      // ... 项目信息
    });

    if (!addResult.success) {
      return { success: false, error: addResult.error, ... };
    }
    writtenMemoryIds.push(addResult.id);
  }

  return { success: true, writtenMemoryIds, drafts, ... };
}
```

---

## 完整数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│                         用户会话                                     │
│  user ──▶ prompt ──▶ AI response ──▶ 工具执行 ──▶ 结果            │
└─────────────────────────────────────────────────────────────────────┘
                    │
                    ▼ (session.idle 事件，10秒空闲后触发)
┌─────────────────────────────────────────────────────────────────────┐
│                      session.idle 处理                              │
│                                                                     │
│  1. generateTaskSupport(mode: "brief")    ──▶ 任务摘要             │
│  2. generateTaskSupport(mode: "checklist") ──▶ 完成检查清单        │
│  3. extractSessionExecutionEvidence()    ──▶ 执行证据              │
│  4. evaluateEvidenceTemplateCoverage()   ──▶ 证据覆盖率            │
│  5. generateCompletionGateSuggestion()    ──▶ 完成门建议           │
│  6. formatChecklistForPrompt()           ──▶ 格式化                │
│  7. session.prompt()                     ──▶ 注入会话               │
│  8. writeCompletionChecklistMemories()   ──▶ ★ 写入记忆 ★          │
│                              │                                      │
│                              ▼                                      │
│                    memoryClient.addMemory()                          │
│                              │                                      │
│              ┌───────────────┼───────────────┐                     │
│              ▼               ▼               ▼                     │
│        Hnswlib 向量    SQLite 元数据   writebackSource              │
│        (ANN 索引)      (持久化)        = "completion-checklist"     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       闭环完成                                       │
│                                                                     │
│  后续搜索时，completion-gate 类型的记忆会作为参考上下文:            │
│  - searchMemories() 返回包含 writeback 记忆                        │
│  - AI 在生成回复时可引用历史的完成检查清单                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 验证清单

| 步骤 | 验证项                          | 预期结果                                              |
| ---- | ------------------------------- | ----------------------------------------------------- |
| 1    | `memoryClient.addMemory()`      | 返回 `{ success: true, id: "mem_xxx" }`               |
| 2    | `memoryClient.searchMemories()` | 返回匹配的搜索结果                                    |
| 3    | `memoryClient.listMemories()`   | 返回当前项目的所有记忆                                |
| 4    | `session.idle` 事件             | 自动触发 writeback                                    |
| 5    | writeback 写入                  | 检查 `writebackSource: "completion-checklist"` 的记忆 |

---

## 相关文件索引

| 文件                                   | 职责                                                 |
| -------------------------------------- | ---------------------------------------------------- |
| `src/index.ts`                         | MCP 入口，session.idle 事件处理                      |
| `src/services/client.ts`               | memoryClient.addMemory, searchMemories, listMemories |
| `src/services/completion-writeback.ts` | writeCompletionChecklistMemories 实现                |
| `src/services/task-support.ts`         | generateTaskSupport (brief/checklist)                |
| `src/services/auto-capture.ts`         | performAutoCapture                                   |
| `src/config.ts`                        | CONFIG 配置项                                        |
| `tests/session-idle-checklist.test.ts` | session.idle 单元测试                                |
| `tests/completion-writeback.test.ts`   | writeback 单元测试                                   |

---

## 演示页面

打开 `docs/memory闭环演示.html` 可视化演示完整闭环流程。
