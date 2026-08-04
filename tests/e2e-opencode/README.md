# OpenCode + opencode-mem 真实 E2E 验证报告

> 验证时间: 2026-08-04
> 工作目录: `/Users/sss/devprog/devprog_sss/AI_MEMORY/opencode-mem`
> 演示项目: `/tmp/opencode-mem-demo`
> 隔离数据: `~/.opencode-mem-demo-data/` (不复用主项目存储)
> opencode-mem 版本: 本地分支 modify_test 上的修改 (含 2 个 src 修复 + 1 个超时配置)

---

## 1. 目标与执行路径

**目标**: 用真实 opencode CLI 装载本地修改过的 opencode-mem plugin，验证在编码任务场景下的认知闭环接入。

**设计路径**:

```
opencode run "<任务>" (--pure 禁用其它插件, --print-logs 输出 trace)
  ↓ 启动时加载项目 .opencode/plugins/opencode-mem.js (symlink → dist/plugin.js)
  ↓ opencode-mem plugin 触发事件钩子:
    ├─ chat.message   → 生成 TaskBrief + 注入用户画像
    ├─ chat.params    → 记录 prompt 模型绑定
    └─ (预期) session.idle → 触发 Completion Gate + writeback (本次未触发, 见 §4)
  ↓ AI (mycomp/Qwen3.6-35B-A3B-FP8) 完成任务: 写 src/multiply.ts + tests/multiply.test.ts
  ↓ bun test 验证: 4 tests pass
```

## 2. 准备工作

| 步骤                                | 命令                                   | 产出                                                                                                       |
| ----------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1. 创建 demo 项目骨架               | `tests/e2e-opencode/scripts/setup.sh`  | `/tmp/opencode-mem-demo/{package.json, tsconfig.json, vitest.config.ts}`                                   |
| 2. 装载 plugin                      | setup.sh 末尾 `ln -sf`                 | `.opencode/plugins/opencode-mem.js → /Users/sss/devprog/devprog_sss/AI_MEMORY/opencode-mem/dist/plugin.js` |
| 3. opencode-mem 配置                | setup.sh                               | demo 项目的 `.opencode/opencode-mem.json` (独立 storagePath, 不复用 ~/.opencode-mem)                       |
| 4. 复用 embedding 缓存              | setup.sh cp                            | 节省首次加载模型下载                                                                                       |
| 5. 临时屏蔽全局 opencode-mem@2.17.1 | setup.sh python 改全局 `opencode.json` | 避免与本地版本冲突 (备份在 `~/.config/opencode/opencode.json.bak-e2e`)                                     |
| 6. 初始化基线代码                   | 手动                                   | `src/{index,sum}.ts` + `tests/{index,sum}.test.ts`, 2 tests pass                                           |

## 3. 真实任务运行

### 3.1 任务指令

```
在 src/ 中添加一个 multiply.ts 函数，导出 multiply(a, b) 返回两数之积。
tests/ 中加 multiply.test.ts 用 vitest 验证 multiply(3, 4)===12 与 multiply(0, 5)===0。
最后执行 bun test 确保全部通过。
```

### 3.2 opencode 命令

```bash
opencode run --print-logs --log-level=DEBUG \
  --model mycomp/Qwen3.6-35B-A3B-FP8 \
  "<上述任务>"
```

### 3.3 运行结果

| 指标                     | 值                                           |
| ------------------------ | -------------------------------------------- |
| opencode exit code       | **0**                                        |
| 生成文件                 | `src/multiply.ts` + `tests/multiply.test.ts` |
| `bun test` 结果          | **4 pass / 0 fail / 4 expect()**             |
| opencode-mem plugin 装载 | ✅ 成功                                      |
| chat.message hook 触发   | ✅ 成功 (1 次 brief + 1 次 context inject)   |

### 3.4 AI 生成的代码（实证可工作）

```typescript
// src/multiply.ts
export const multiply = (a: number, b: number): number => a * b;
```

```typescript
// tests/multiply.test.ts
import { describe, expect, it } from "vitest";
import { multiply } from "../src/multiply";

describe("multiply", () => {
  it("multiplies two positive numbers", () => {
    expect(multiply(3, 4)).toBe(12);
  });
  it("multiplies by zero", () => {
    expect(multiply(0, 5)).toBe(0);
  });
});
```

## 4. opencode-mem Plugin 钩子执行 Trace

完整 trace 文件: `trace/run4_session.log` (19 行, 从 `~/.opencode-mem/opencode-mem.log` 抽取)

### 4.1 启动阶段 (0.0s → 2.6s)

| 时刻       | 事件                                              | 关键数据                                                                                                                                  |
| ---------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| T+0ms      | `config.ts:initConfig merged config`              | `directory=/private/tmp/opencode-mem-demo, globalKeys=39, projectKeys=13, storagePath=~/.opencode-mem-demo-data, autoCaptureEnabled=true` |
| T+30~220ms | `tags.ts:getUserTagInfo / getProjectTagInfo` (×7) | 容器标签 `opencode_project_4c2505524dfba50b`, 用户标签基于 email (`godssj20...`)                                                          |
| T+152ms    | `[DIAG] index.ts:pluginEntry plugin readiness`    | `isConfigured: true, autoCaptureReady: true, mismatch: false`                                                                             |
| T+153ms    | `[DIAG] index.ts:93 warmup guard`                 | `isConfigured always true so always passes`                                                                                               |

### 4.2 模型预热 (T+2.6s)

```
[DIAG] [2026-08-04T16:59:50.934+08:00] Embedding model warmed up: {"model":"Xenova/nomic-embed-text-v1"}
```

(因复用本地 embedding 缓存, 冷启动 ~2.5s; 第一次冷启动预计 30-60s)

### 4.3 Provider 探测 (T+3.5s)

```
opencode providers connected: {
  "list": ["teamorouter","minimax-cn","deepseek","mycomp","9router","zhipuai-coding-plan","opencode"],
  "configured": "(not set)"
}
```

### 4.4 任务触发 → chat.message Hook (T+9.5s)

| 时刻     | 事件                            | 关键数据                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T+9.519s | `chat.message brief generated`  | `usedAI: true, memoriesConsidered: 0, brief: { taskGoal, relatedFiles: [src/multiply.ts, tests/multiply.test.ts], relatedSymbols: [multiply], historicalDecisions: [], constraintKinds: [minimize_change], constraints: ["使用 TypeScript 编写","使用 vitest 进行单元测试","使用 bun 运行测试"], userPreferences: [], risks: ["确保项目已配置 bun 和 vitest 环境"], successCriteria: [3 条] }` |
| T+9.522s | `profile inject`                | 5 preferences + 5 patterns + 3 workflows (来自主项目 `~/.opencode-mem/data`, 与 demo 隔离, 但 profile 是 user-scope 自动共享)                                                                                                                                                                                                                                                                  |
| T+9.523s | `chat.message context prepared` | `hasBrief: true, memoryCount: 0, context: <memory_context>...<task_brief>...</task_brief></memory_context>`                                                                                                                                                                                                                                                                                    |
| T+9.693s | `[DIAG] chat.params guard`      | `opencodeModel: ""` (项目配置中留空, 走非 inherit 路径)                                                                                                                                                                                                                                                                                                                                        |

### 4.5 AI 执行 (T+9.5s → T+~70s)

AI 在收到含 `<memory_context>` 注入的对话上下文后:

1. 用 `ls` 查看项目结构
2. 读取 `src/sum.ts` / `tests/sum.test.ts` / `package.json` 作为参考
3. 写入 `src/multiply.ts` (70 bytes) + `tests/multiply.test.ts` (251 bytes)
4. 跑 `bun test` 验证 4 tests pass
5. 任务完成

### 4.6 session.idle 未触发 ❌

**重要发现**: `opencode run` 模式下, 任务完成后约 1.5 分钟, opencode 直接 `disposing instance`, **session.idle 事件未发出**, 因此 opencode-mem 的 10s 延时 idle handler 永远不跑。

**根因** (来自 [index.ts:1029](../../src/index.ts#L1029) 的 `idleTimeout = setTimeout(..., 10000)`):

- `opencode run` 是非交互式一次性执行, 完成最后一条消息后直接销毁 server 实例
- 与 TUI 模式不同, TUI 模式下用户停止输入才会触发 idle
- 这意味着 `Completion Gate` + `writeback` 这一段**真实运行验证不了**

**已确认 AI 路径在 writeback 内部可用** —— `bun run tests/closed-loop-real.test.ts` 与 `tests/task-auto-capture.test.ts` 已覆盖该路径, 仅 e2e 缺这段验证。

## 5. DB 快照

完整快照: `trace/db_snapshot.json` (生成时间 2026-08-04 16:59:51 UTC)

| 表             | 行数  | 关键内容                                                                                         |
| -------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `ai_sessions`  | 1     | `id=sess_1785833992533_txq79qc, provider=openai-chat, session_id=ses_033ffdb95ffeza3rA5j0YEOFBf` |
| `ai_messages`  | 4     | system (TaskBrief prompt) + user (本次任务) + assistant (tool_call) + tool result                |
| `memories`     | **0** | 本次任务 AI 未调用 `memory` 工具, 故 memories 表为空 (符合预期)                                  |
| `user_prompts` | 1     | `pendingPrompt.messageId` 用于 session.idle, **未触发**                                          |

### Schema 摘要

```sql
CREATE TABLE ai_sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  conversation_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ai_session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,        -- 'system' | 'user' | 'assistant' | 'tool'
  content TEXT NOT NULL,
  tool_calls TEXT,            -- JSON
  tool_call_id TEXT,
  content_blocks TEXT,
  created_at INTEGER NOT NULL
);
```

## 6. 需求文档验收对照

| 验收点                                      | 需求文档            | E2E 验证状态                                                                                                               | 备注                                      |
| ------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Phase 1: `mem_types`/`entities` 写入        | 15.2 #1/#2          | ✅ 已在 [cognitive-acceptance.test.ts](../cognitive-acceptance.test.ts) 覆盖                                               | E2E 未触发 (本次 AI 未调 memory add 工具) |
| Phase 1: 单条多 `mem_types`                 | 15.2 #3             | ✅ 已在认知验收测试覆盖                                                                                                    | 同上                                      |
| Task Brief Generator                        | 12.1 / 补充文档 9.1 | ✅ **E2E 真实触发**: brief 含 taskGoal, relatedFiles, relatedSymbols, constraints, risks, successCriteria                  | `usedAI: true`                            |
| 注入 user profile + task brief 到对话上下文 | 9.1 / 12.1          | ✅ **E2E 真实触发**: `<memory_context>` 注入, 内含 `<user_profile>` (5 prefs + 5 patterns + 3 workflows) 与 `<task_brief>` | `chat.message context prepared` 事件确认  |
| auto-capture 端到端                         | 13.1                | ✅ 已在 [task-auto-capture.test.ts](../task-auto-capture.test.ts) 覆盖 (mock client)                                       | E2E 未触发 (本次 AI 未调 capture 流程)    |
| Completion Gate 输出契约                    | 补充文档 5.2 / 6    | ✅ 已在认知验收测试覆盖 (fallback 路径)                                                                                    | E2E session.idle 未触发, 缺 AI 路径实测   |
| Completion Gate writeback                   | 补充文档 9.3        | ✅ 已在 [closed-loop-real.test.ts](../closed-loop-real.test.ts) 覆盖                                                       | 同上                                      |
| 旧数据兼容 / 降级规则                       | 13.2 / 13.3         | ✅ 已在认知验收测试覆盖                                                                                                    | E2E 无此场景                              |

## 7. 总结

### 7.1 已验证的能力

1. **plugin 真实装载**: 通过 `.opencode/plugins/` symlink, opencode 启动时加载本地 `dist/plugin.js`, 触发 `initConfig` / `warmup` / `provider.list`
2. **Task Brief 真实 AI 生成**: `usedAI: true`, 内容符合契约
3. **用户画像跨项目复用**: 主项目的 profile (5 prefs + 5 patterns + 3 workflows) 注入到 demo 任务上下文
4. **真实 AI 任务闭环**: opencode run 模式下, AI 读取已有代码 → 写新代码 → 跑测试 → 全部通过

### 7.2 已知边界

1. **session.idle 不在 `opencode run` 触发**: TUI 模式才会持续空闲; run 模式一次性退出
   - 替代验证: 闭环测试 [closed-loop-real.test.ts](../closed-loop-real.test.ts) 跑过该路径
   - 如需 e2e 真实验证, 需要切换到 `opencode serve` + attach + 客户端驱动完整会话, 复杂度大幅上升
2. **profile 是 user-scope 自动跨项目共享**: 本次 demo 任务注入了主项目的用户画像 (因 email 解析后 user_id 相同), 这是产品特性而非缺陷
3. **embedding 模型冷启动 ~2.5s** (复用本地缓存), 首次冷启动预计 30-60s

### 7.3 改动清单

| 文件                                        | 改动                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `tests/e2e-opencode/scripts/setup.sh`       | 新增: 准备 demo + symlink plugin + 配置 + 备份全局配置                      |
| `tests/e2e-opencode/scripts/snapshot-db.ts` | 新增: 导出 SQLite 快照为 JSON                                               |
| `tests/e2e-opencode/trace/run3.*.log`       | 排查过程: agent "build" not found (无 `--pure` 失败)                        |
| `tests/e2e-opencode/trace/run4.*.log`       | 成功运行的 stdout + stderr                                                  |
| `tests/e2e-opencode/trace/run4_session.log` | 从 `~/.opencode-mem/opencode-mem.log` 抽取的本次 session 完整 trace (19 行) |
| `tests/e2e-opencode/trace/db_snapshot.json` | SQLite 数据库快照 (3 表, 6 行)                                              |
| `tests/e2e-opencode/README.md`              | 本文档                                                                      |

### 7.4 关键发现 / 决策

| 发现                                                                      | 影响                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 用户全局 `~/.config/opencode/opencode.json` 中 `agent.build.disable=true` | demo 项目 `opencode.json` 必须显式覆盖, 否则 `default agent "build" not found` |
| setup 脚本最初 `rm -rf /tmp/opencode-mem-demo` 会破坏 sandbox cwd         | 改为只清理 `.opencode` 子目录                                                  |
| `opencode run` 不发 `session.idle` 事件                                   | session.idle 相关能力 (Completion Gate + writeback) 仅由闭环测试覆盖, e2e 无   |
| 用户 profile 跨项目自动共享                                               | 是产品设计, 不需要额外修复                                                     |

## 8. 重跑指南

```bash
# 一次性准备 (可重复执行, 会重建 demo 项目内 .opencode 目录)
bash /Users/sss/devprog/devprog_sss/AI_MEMORY/opencode-mem/tests/e2e-opencode/scripts/setup.sh

# 跑实际任务
cd /tmp/opencode-mem-demo
opencode run --print-logs --log-level=DEBUG \
  --model mycomp/Qwen3.6-35B-A3B-FP8 \
  "在 src/ 中添加一个 multiply.ts 函数..." \
  > /Users/sss/devprog/devprog_sss/AI_MEMORY/opencode-mem/tests/e2e-opencode/trace/run5.stdout.log \
  2> /Users/sss/devprog/devprog_sss/AI_MEMORY/opencode-mem/tests/e2e-opencode/trace/run5.stderr.log

# 导出 DB 快照
bun run /Users/sss/devprog/devprog_sss/AI_MEMORY/opencode-mem/tests/e2e-opencode/scripts/snapshot-db.ts

# 清理临时项目 (注意: 会删除 sandbox cwd; 确保已 cd 到其它目录)
# rm -rf /tmp/opencode-mem-demo
# rm -rf ~/.opencode-mem-demo-data

# 恢复全局 opencode 配置 (重要! 还原用户日常环境)
# mv ~/.config/opencode/opencode.json.bak-e2e ~/.config/opencode/opencode.json
```
