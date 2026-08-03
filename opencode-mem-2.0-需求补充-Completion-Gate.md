# OpenCode-Mem 2.0 需求补充文档：Completion Gate 与任务闭环

> 版本：Draft v1
> 日期：2026-08-03
> 关联文档：`opencode-mem-2.0-需求文档.md`
> 文档目标：补齐“任务是否完成”的判定机制（Completion Gate）与 OpenCode / OpenCode-Mem 的职责边界，确保认知能力能稳定接入真实开发任务过程。

---

## 1. 背景与动机

在 OpenCode-Mem 2.0 的目标里，我们强调从 `Memory System` 升级为 `Agent Cognitive System`。但如果缺少对“任务完成”的可判定机制，系统将出现两个常见问题：

1. **改了代码但无法证明完成**：只能陈述做了哪些修改，无法证明满足成功标准。
2. **验证不成体系**：验证步骤零散、重复、遗漏关键路径，导致“看似完成，运行不正确”。

因此必须引入 `Completion Gate`：一个把“成功标准”与“验证证据”绑定起来的任务闭环关口。

---

## 2. 术语

- **Task Brief**：任务开始前生成的结构化简报（目标、约束、相关实体、成功标准草案）。
- **Success Criteria**：可验证的成功标准列表。
- **Evidence**：证明成功标准达成的证据（测试/命令输出/接口返回/截图/日志摘要等）。
- **Verification Hint**：来自历史经验的验证提示（更像建议），不等同于最终判定。
- **Completion Gate**：对 Success Criteria 与 Evidence 进行对齐检查，输出任务状态。
- **Task Status**：任务状态枚举：`done | partial | blocked`。

---

## 3. 核心原则

### 3.1 判定属于“执行层”，不是“记忆层”

`opencode-mem` 擅长提供：

- 认知召回（mem_types/entities 驱动）
- 任务 brief（帮助更准确理解需求与边界）
- 验证提示（从经验/tool_trace/skill 提炼）
- 回写经验（沉淀可复用的执行与验证模式）

但它不应成为“最终完成状态”的唯一来源，因为它不掌握所有运行时证据与工具执行真实结果。

因此：

- **最终判定（Completion Gate）主责任在 OpenCode/Agent 执行层**
- **opencode-mem 提供判定输入建议与结构化证据模板**

### 3.2 先定义标准，再执行，再验证，再判定

任务闭环必须固定为：

```text
定义 Success Criteria
  -> 执行
  -> 生成 Evidence
  -> Completion Gate 判定
  -> 回写经验
```

---

## 4. 职责边界（OpenCode vs OpenCode-Mem）

### 4.1 OpenCode（任务执行与判定层）

必须具备或承载以下能力：

1. Task 状态机：`running -> done/partial/blocked`
2. Success Criteria 的收集与存储（针对当前任务）
3. 工具执行记录与输出聚合（命令、测试、lint、构建、接口调用等）
4. Evidence 的采集、归档与摘要
5. Completion Gate 判定与最终状态输出

### 4.2 OpenCode-Mem（认知与记忆层）

必须具备或承载以下能力：

1. `mem_types/entities` 写入（Phase 1）
2. Recall：按任务类型召回合适的认知记忆
3. Task Brief Generator：生成任务简报（含成功标准建议）
4. Verification Hint Generator：生成验证提示（含常见坑与建议检查项）
5. 回写：把本次任务的经验/验证步骤沉淀为 `experience/tool_trace/skill/file_knowledge`

---

## 5. Completion Gate 的输入输出契约

### 5.1 输入（Inputs）

Completion Gate 需要以下输入（可以由 OpenCode 汇总并在任务结束时一次性判定）：

1. `task_id`：任务标识
2. `task_brief`：任务简报（可为空，但建议有）
3. `success_criteria[]`：成功标准列表（必须）
4. `constraints[]`：本次任务的硬约束（必须）
5. `changed_files[]`：本次修改涉及的文件列表（可选但强烈建议）
6. `tool_runs[]`：工具执行记录（可选但强烈建议）
7. `evidence[]`：证据列表（必须）
8. `remaining_risks[]`：已知未覆盖的风险（可选）
9. `blockers[]`：阻塞项（可选）

### 5.2 输出（Outputs）

Completion Gate 输出：

1. `status: done | partial | blocked`
2. `criteria_check[]`：逐条标准检查结果（pass/fail/unknown + reason）
3. `constraint_check[]`：逐条约束检查结果
4. `summary`：一段可读总结
5. `next_actions[]`：若非 done，给出下一步行动建议

---

## 6. Task Status 语义定义

### 6.1 done

满足：

- 关键 Success Criteria 全部 `pass`
- 硬约束（constraints）全部 `pass`
- Evidence 可追溯，且覆盖关键路径

### 6.2 partial

满足：

- 部分 Success Criteria `pass`，但仍存在关键项 `fail/unknown`
- 或约束满足，但验证证据不足（例如没跑测试）
- 或功能完成但存在明确剩余风险未覆盖

### 6.3 blocked

满足：

- 无法继续推进，必须依赖用户输入或外部状态
- 或复现步骤无法成立、关键依赖不可用、权限/环境缺失

---

## 7. Success Criteria 的格式建议

Success Criteria 必须是可验证的。推荐格式：

```text
SC1: 当触发 auto-capture 写入记忆时，metadata 中包含 mem_types（数组）与 entities（数组）
SC2: 不修改 memories 表结构（无 migration）
SC3: 兼容旧数据：旧 memories 的 metadata 缺失新字段时不报错
SC4: 两条 AI 路径均可用（opencode provider 或 fallback 至少一条成功；若两条都要求则拆成两个标准）
SC5: 现有 list/search/add 流程不回归（至少跑一次验证）
```

推荐为每条成功标准绑定一种证据类型（见第 8 节）。

---

## 8. Evidence（证据）体系

### 8.1 证据类型

常见证据类型建议枚举：

- `test_result`：单测/集成测试结果
- `command_output`：命令输出（截断与脱敏）
- `api_response`：HTTP 请求与响应摘要（截断与脱敏）
- `diff_summary`：改动文件与关键行范围摘要
- `runtime_observation`：运行时观察（例如“页面渲染正常”）

### 8.2 证据最小字段

每条证据至少包含：

- `type`
- `title`
- `timestamp`
- `payload`（结构化内容或截断文本）

### 8.3 证据与成功标准绑定建议

每条 Success Criteria 推荐至少绑定一个 Evidence：

- SC1（metadata 写入） -> `api_response` 或 `command_output`（读取 DB/接口返回显示 metadata）
- SC2（不改表结构） -> `diff_summary`（无 migration 文件变更；或 schema 未变）
- SC3（兼容旧数据） -> `test_result` 或 `api_response`
- SC5（流程不回归） -> `test_result`（或最小 smoke）+ `api_response`

---

## 9. 与认知记忆的接入点

Completion Gate 与认知记忆的接入点分为三段：

### 9.1 任务开始前：生成 Task Brief（建议）

由 opencode-mem 提供：

- 召回相关 `fact/file_knowledge/decision/profile/experience`
- 生成 `task_brief`
- 给出 `success_criteria_suggestion`
- 给出 `verification_hints`

说明：这些是“建议”，最终 Success Criteria 仍由 OpenCode/用户确认或由 Agent 在任务开始时固化。

### 9.2 任务执行中：累积 Evidence（必须）

由 OpenCode 记录：

- 工具执行与输出
- 关键接口调用结果
- 改动文件清单
- 测试结果

### 9.3 任务结束：Completion Gate 判定（必须）+ 回写（建议）

由 OpenCode 输出最终状态；同时把关键信息交给 opencode-mem 回写：

- `experience`：本次关键结论与坑
- `tool_trace`：执行了哪些排查/验证步骤
- `skill`：可复用的流程总结
- `file_knowledge`：涉及哪些文件/模块的关键语义

---

## 10. 推荐的最小实现路线（不改 OpenCode 的情况下）

如果短期不能修改 OpenCode，则建议在 opencode-mem 内先提供“辅助判定”能力，但不做“最终判定”。

### 10.1 辅助判定（opencode-mem）

输出一个 `completion_checklist`，包含：

- success_criteria（建议）
- verification_hints（建议）
- evidence_templates（建议）

示例：

```json
{
  "success_criteria": [
    "metadata.mem_types/entities 写入成功",
    "旧数据兼容",
    "不修改 SQLite schema"
  ],
  "verification_hints": [
    "写入一条新 memory 后通过 list/search 查看 metadata",
    "跑现有测试或最小 smoke",
    "确认 fallback 路径不报错"
  ],
  "evidence_templates": [
    { "type": "test_result", "title": "bun test", "payload": "" },
    { "type": "api_response", "title": "GET /api/memories", "payload": "" }
  ]
}
```

### 10.2 最终判定（仍建议由执行层完成）

即使只有 checklist，也建议在任务结束时强制输出：

- done/partial/blocked
- 基于 checklist 的逐条说明

---

## 11. Phase 1 与 Completion Gate 的验收关系

Phase 1（mem_types + entities 写入 metadata）本身的验收可以由 Completion Gate 覆盖：

### 11.1 Phase 1 最小成功标准（建议）

1. 新写入的 memory 在 metadata 内出现 `mem_types`（数组）
2. 新写入的 memory 在 metadata 内出现 `entities`（数组）
3. 输出非法值可降级（不阻断写入）
4. 不改 DB schema
5. 不回归现有 list/search/add

### 11.2 Phase 1 最小证据（建议）

1. 一条新增 memory 的读取结果包含 metadata 新字段（api_response/command_output）
2. 一次现有测试或最小 smoke（test_result）
3. 代码改动摘要（diff_summary）

---

## 12. 风险与对策

### 12.1 风险：把判定塞进 opencode-mem 导致职责混乱

对策：

- opencode-mem 仅提供建议与模板
- 最终状态由 OpenCode/执行层维护

### 12.2 风险：成功标准变成模糊描述

对策：

- 强制标准可验证
- 强制绑定 evidence

### 12.3 风险：证据记录泄露敏感信息

对策：

- evidence payload 截断
- 不记录 key/token
- 日志脱敏

---

## 13. 总结

Completion Gate 的价值是把“认知能力”真正接入任务过程，让系统从“记忆更多”升级为“任务更可靠”：

1. 任务开始：先生成更准的 Task Brief
2. 任务执行：累积 Evidence
3. 任务结束：Completion Gate 给出 done/partial/blocked
4. 回写：把经验沉淀为可复用认知记忆

其中关键边界是：

- **OpenCode（执行层）负责最终判定**
- **opencode-mem（认知层）负责提供判定所需的结构化输入与经验复用**
