# OpenCode-Mem 2.0 需求文档

> 版本：Draft v1
> 日期：2026-08-03
> 文档目标：定义 OpenCode-Mem 2.0 如何从“RAG Memory”演进为“Agent Cognitive System”，并明确这些能力如何接入当前的编码、排障和文档写作任务过程。

---

## 1. 背景

当前 `opencode-mem` 已具备以下能力：

- 通过 OpenCode Hook 采集对话与事件。
- 自动把技术对话压缩为摘要记忆。
- 为记忆生成向量并写入 SQLite 分片。
- 在后续对话中通过搜索和上下文注入召回记忆。

当前链路更接近：

```text
Conversation
  -> Capture
  -> Summary
  -> Embedding
  -> Search
```

它已经是一个可用的记忆系统，但仍主要服务于“找回相似摘要”。

OpenCode-Mem 2.0 的目标不是继续堆砌存储组件，而是让系统具备更强的认知闭环能力，即：

```text
提出任务
  -> 理解任务
  -> 召回相关认知
  -> 生成任务上下文
  -> 执行
  -> 验证
  -> 回写经验
```

这意味着系统的重点要从“记住更多”升级为“更准确地参与当前任务过程”。

---

## 2. 问题定义

### 2.1 当前系统的主要短板

1. 记忆以摘要为主，缺少认知层结构。
2. 系统知道“发生过什么”，但不知道“这属于什么知识类型”。
3. 系统知道“有一条相关记忆”，但不知道“它涉及哪些核心实体”。
4. 在编码或写文档前，系统没有稳定生成“任务 brief”。
5. 在编码完成后，系统没有基于历史经验生成“验证提示”。

### 2.2 造成的直接结果

1. 用户提出需求后，系统容易过快进入编码阶段。
2. 召回结果偏“相关”，但不一定偏“有用”。
3. 对需求理解、约束把握、验证策略的帮助有限。
4. Dreaming、Consolidation、Knowledge Compression 缺少可用输入。

---

## 3. 产品目标

OpenCode-Mem 2.0 的核心目标有三项：

1. 让系统在任务开始前，能够生成更准确的任务上下文。
2. 让系统在任务执行后，能够生成更可靠的验证提示与经验沉淀。
3. 在尽量保留现有架构的前提下，引入认知能力，而不是引入高复杂度基础设施。

对应到体验上，系统需要提升两个结果：

1. 生成的代码更符合真实需求和约束。
2. 修改后的代码更容易被正确验证，运行更可靠。

---

## 4. 设计原则

### 4.1 任务过程优先

认知能力必须先接入当前任务过程，而不是先做复杂图谱或新数据库。

### 4.2 简洁优先

Phase 1 不引入 Neo4j、Kafka、复杂 schema 扩张，也不重写现有存储层。

### 4.3 外科手术式修改

优先复用现有：

- Hook 体系
- auto-capture
- SQLite + metadata
- 现有 recall/context 注入机制

### 4.4 认知优先于基础设施

优先建设：

- `mem_types`
- `entities`
- 任务 brief
- 验证提示

后续再考虑：

- `memory_edge`
- Dreaming Lite
- 大规模图存储

### 4.5 契约优先

在改代码前，先明确能力契约：

- 认知记忆类型是什么
- 实体是什么
- 任务过程中的输入输出是什么

---

## 5. 总体愿景

OpenCode-Mem 2.0 的目标链路如下：

```text
Hook
  -> Memory Extractor
  -> Memory Classifier
  -> Entity Extractor
  -> Store
  -> Recall Engine
  -> Task Brief
  -> Execution
  -> Verification Hint
  -> Memory Evolution
```

其中当前阶段最重要的是把能力接入实际任务过程，而不是一次性完成全部演化能力。

---

## 6. 2.0 分阶段范围

### Phase 1

新增两项核心能力：

1. `mem_types`
2. `entity extraction`

目标是以最小改动，把认知结构写入现有记忆。

### Phase 2

新增：

1. `memory_edge`

用于表示轻量关系，不引入图数据库。

### Phase 3

新增：

1. Dreaming Lite
2. 聚类
3. 合并
4. 经验生成
5. 技能生成

### Phase 4

当记忆规模达到百万级以上，再评估：

- Graphiti
- Neo4j
- Mem0 Graph

---

## 7. Phase 1 的产品范围

Phase 1 的交付不是“新页面”或“新数据库”，而是让系统能把当前任务过程中的关键信息写成机器可用的认知字段。

### 7.1 mem_type 体系

第一版固定为以下七类：

- `profile`
- `fact`
- `episodic`
- `experience`
- `skill`
- `tool_trace`
- `file_knowledge`

说明：

1. 一个记忆可以有多个 `mem_types`。
2. `mem_types` 是认知类型，不替代现有 `type`。
3. 现有 `type` 继续保留为工程事件标签，如 `bug-fix`、`feature`、`refactor`。

### 7.2 entity extraction 体系

第一版固定为以下实体类型：

- `Project`
- `Module`
- `Technology`
- `Framework`
- `Library`
- `File`
- `Function`
- `Class`
- `Issue`
- `Decision`

说明：

1. `File`、`Function`、`Class` 仅在上下文明确出现时提取。
2. `Project`、`Technology`、`Framework`、`Issue`、`Decision` 优先作为高价值实体。

### 7.3 Phase 1 的存储方式

Phase 1 先不新增表，先把结构写入 `memories.metadata`。

目标形态：

```json
{
  "source": "auto-capture",
  "sessionID": "xxx",
  "promptId": "xxx",
  "captureTimestamp": 1234567890,
  "mem_types": ["experience", "tool_trace", "skill"],
  "entities": [
    { "entity": "SQLite", "entity_type": "Library" },
    { "entity": "Rust", "entity_type": "Technology" },
    { "entity": "Actor Model", "entity_type": "Decision" }
  ]
}
```

---

## 8. 能力如何接入当前任务过程

这是本需求文档的重点。

系统必须明确接入以下三类任务过程：

1. 编码任务
2. 排障/修复任务
3. 文档写作任务

---

## 9. 编码任务工作流

### 9.1 用户行为

用户提出一个实现类问题，例如：

- “给当前项目加一个 Dreaming Lite”
- “把 auto-capture 扩展为输出 mem_types”
- “重构这个 API handler”

### 9.2 系统必须先做什么

系统不能立刻编码，而必须先进入“任务理解阶段”：

```text
提出问题
  -> 识别任务类型
  -> 识别实体
  -> 召回相关认知记忆
  -> 生成任务 brief
  -> 澄清关键歧义
  -> 定义成功标准
  -> 实施修改
  -> 验证结果
  -> 回写认知记忆
```

### 9.3 任务类型识别

对编码任务，系统至少需要能识别：

- 新功能实现
- 小范围增强
- Bug 修复
- 重构
- 接口调整
- 架构设计讨论

### 9.4 编码任务的召回策略

如果任务被识别为“需求实现”或“功能增强”，优先召回：

- `fact`
- `file_knowledge`
- `profile`
- `Decision`

召回目标：

1. 项目以前如何处理类似问题。
2. 哪些文件、模块、函数与该任务相关。
3. 用户在架构、改动范围、风格上的偏好。
4. 当前项目已明确的历史决策和边界。

### 9.5 编码任务输出的中间产物

系统需要在编码前形成一个简短但结构化的任务 brief，至少包含：

1. 任务目标
2. 相关模块/文件
3. 历史决策
4. 用户偏好与约束
5. 潜在风险点
6. 成功标准

示例：

```text
任务目标：
为 auto-capture 增加 mem_types 与 entities 的结构化输出。

相关文件：
src/services/auto-capture.ts

已知约束：
- 尽量不改当前架构
- 不改 API/UI
- 不新增表

成功标准：
- metadata 内写入 mem_types/entities
- 不破坏现有 type/tags 流程
- fallback 路径同样支持
```

### 9.6 这一流程如何让代码更符合需求

它通过以下方式提升准确性：

1. 在编码前先把用户偏好和边界拉齐。
2. 避免错误理解“要不要动 API/UI/DB schema”。
3. 明确这次改动只应落在哪些文件。
4. 先定义成功标准，再编码，减少方向性错误。

---

## 10. 排障/修复任务工作流

### 10.1 用户行为

用户提出一个错误或异常，例如：

- “SQLite 写入失败”
- “搜索结果不完整”
- “metadata 没保存进去”
- “服务启动后接口返回 500”

### 10.2 系统必须先做什么

系统不能直接猜修法，而应先进入“排障理解阶段”：

```text
问题输入
  -> 识别 Issue 实体
  -> 召回 experience/tool_trace/episodic
  -> 生成排障 brief
  -> 定义复现路径
  -> 执行修复
  -> 执行验证
  -> 回写经验
```

### 10.3 排障任务的召回策略

优先召回：

- `experience`
- `tool_trace`
- `episodic`
- `skill`
- `Issue`

召回目标：

1. 以前是否遇到过类似问题。
2. 当时是如何排查的。
3. 用了哪些命令、文件定位、验证步骤。
4. 是否已经沉淀出可复用的修复套路。

### 10.4 排障任务输出的中间产物

系统需要在修复前生成：

1. 问题陈述
2. 可能涉及模块
3. 建议复现方法
4. 建议验证步骤
5. 需要避免的历史坑

示例：

```text
问题：
新增 metadata 字段后，自动捕获结果可能未正确写入 SQLite。

建议检查：
1. auto-capture 的 structured output 是否解析成功
2. addMemory 动态 metadata 是否被序列化
3. list/search 返回时 metadata 是否被安全解析

建议验证：
1. 新增一条 memory
2. 读取 memory metadata
3. 搜索结果检查兼容性
```

### 10.5 这一流程如何让运行结果更正确

它通过以下方式提升可靠性：

1. 先定义复现路径，避免拍脑袋修复。
2. 先看历史验证方式，避免“修完没测到点上”。
3. 把 tool trace 与经验作为验证提示来源。
4. 强制形成“复现 -> 修复 -> 验证”的闭环。

---

## 11. 文档写作任务工作流

### 11.1 用户行为

用户提出文档类任务，例如：

- “写一份需求文档”
- “补一份设计说明”
- “整理一份排障手册”
- “写 ADR / 改动说明”

### 11.2 系统必须先做什么

系统不能直接生成大段文案，而应先进入“文档素材召回阶段”：

```text
提出文档任务
  -> 识别文档类型
  -> 识别实体
  -> 召回 fact/file_knowledge/decision/experience
  -> 生成文档 brief
  -> 生成结构大纲
  -> 写文档
  -> 回写文档记忆
```

### 11.3 文档任务的召回策略

不同文档类型优先召回不同记忆：

- 需求文档：`fact`、`Decision`、`profile`
- 设计文档：`file_knowledge`、`fact`、`Decision`
- 排障手册：`experience`、`tool_trace`、`skill`
- 改动说明：`episodic`、`fact`、`file_knowledge`

### 11.4 文档任务输出的中间产物

系统需要在写文档前形成：

1. 文档目标
2. 目标读者
3. 相关实体
4. 现有事实
5. 历史决策
6. 推荐结构

### 11.5 文档工作流的价值

它让文档不再从空白开始，而是基于已有认知材料组织输出。

---

## 12. 核心能力定义

### 12.1 Task Brief Generator

这是 2.0 的关键能力之一。

功能：

在真正编码、修复或写文档前，基于任务类型与召回结果，生成一个简短的任务 brief。

目标：

1. 提升需求对齐度。
2. 提升改动边界清晰度。
3. 提升任务执行前的上下文质量。

### 12.2 Verification Hint Generator

这是 2.0 的第二个关键能力。

功能：

在任务实施后，基于历史 `experience`、`tool_trace`、`skill`，给出建议验证步骤。

目标：

1. 提升运行正确性。
2. 减少“代码写完但没验证到关键路径”。
3. 形成更稳定的经验回写闭环。

---

## 13. Phase 1 的功能需求

### 13.1 必须支持的写入能力

系统必须在自动捕获时生成并写入：

1. `summary`
2. `type`
3. `tags`
4. `mem_types`
5. `entities`

### 13.2 必须支持的兼容性要求

1. 旧数据保持可读。
2. 没有 `mem_types`/`entities` 的旧记忆不能报错。
3. `metadata` 中新增字段不能破坏现有 API。
4. OpenCode provider 与 fallback provider 两条路径都应支持新增字段。

### 13.3 必须支持的降级规则

1. 模型未输出 `mem_types` 时写入空数组。
2. 模型未输出 `entities` 时写入空数组。
3. 输出值不合法时做过滤，不让主流程失败。
4. 即使认知字段抽取失败，也不应阻断核心记忆写入。

---

## 14. 非功能需求

### 14.1 性能

1. 不引入显著的额外写入延迟。
2. 不新增额外数据库查询热点。
3. 不增加索引重建压力。

### 14.2 兼容性

1. 不修改现有 memories 表结构。
2. 不要求立即修改前端 UI。
3. 不要求立即增加新的 API filter。

### 14.3 可扩展性

Phase 1 写入的 `mem_types` 和 `entities` 必须能直接作为后续能力输入：

1. Phase 2 的 `memory_edge`
2. Phase 3 的 Dreaming Lite
3. 后续 recall rerank
4. 任务 brief 与验证提示生成

---

## 15. 成功标准

### 15.1 产品成功标准

如果系统在以下场景中能明显改善任务过程，则认为 Phase 1 方向成立：

1. 编码任务前，能更稳定识别改动边界和目标文件。
2. Bug 修复时，能更稳定回忆历史排障流程。
3. 文档写作时，能更稳定抽取事实、决策和经验作为素材。

### 15.2 Phase 1 验收标准

1. 自动捕获产生的新 memory，`metadata` 中包含 `mem_types`。
2. 自动捕获产生的新 memory，`metadata` 中包含 `entities`。
3. 单条 memory 可同时具备多个 `mem_types`。
4. 新字段不影响现有搜索、列表、删除流程。
5. 为后续 task brief 和 verification hint 奠定稳定输入。

---

## 16. 非目标

本阶段明确不做：

1. Neo4j
2. Kafka
3. 大规模 schema 迁移
4. `memory_edge` 表
5. Dreaming Lite
6. dense+sparse 混合召回
7. 百万级图存储基础设施

这些能力进入后续阶段，不在当前需求范围内。

---

## 17. 风险与控制

### 17.1 风险：实体抽取噪声过大

控制方式：

1. 第一版限制实体类型集合。
2. 控制单条记忆的实体数量上限。
3. 对 `File/Function/Class` 提高抽取门槛。

### 17.2 风险：mem_type 语义漂移

控制方式：

1. 固定第一版枚举。
2. 在 prompt 中明确各类型含义。
3. 在测试中覆盖多标签场景。

### 17.3 风险：能力写入了但任务过程没真正使用

控制方式：

1. 需求文档中明确后续必须补 Task Brief Generator。
2. 需求文档中明确后续必须补 Verification Hint Generator。
3. 不把 Phase 1 误认为“2.0 完成”，而把它定义为认知输入层完成。

---

## 18. 后续路线

### 18.1 Phase 1.5

在不大改架构的前提下，让 Phase 1 的认知字段接入任务读取过程：

1. 编码前生成 task brief
2. 修复后生成 verification hint
3. 文档前生成素材 brief

### 18.2 Phase 2

新增：

1. `memory_edge`
2. 轻量关系召回

### 18.3 Phase 3

新增：

1. Dreaming Lite
2. 聚类与合并
3. 经验与技能记忆生成

---

## 19. 最终结论

OpenCode-Mem 2.0 的第一步不应该从更复杂的数据库基础设施开始，而应该先把认知字段写入当前记忆系统，并把这些字段接入真实任务过程。

也就是说，Phase 1 的真正目标不是：

```text
让系统多存两个字段
```

而是：

```text
让系统在编码、排障、文档写作时，
先理解任务，
再回忆相关认知，
再执行，
再验证，
最后沉淀经验。
```

这才是从 Memory System 升级到 Agent Cognitive System 的起点。
