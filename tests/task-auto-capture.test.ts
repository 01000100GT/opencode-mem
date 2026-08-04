#!/usr/bin/env bun
/**
 * opencode-mem Task Brief / auto-capture 验收测试
 *
 * 覆盖两份需求文档的剩余验收点：
 *   - opencode-mem-2.0-需求文档.md: 12.1 Task Brief Generator、13.1 auto-capture 写入 mem_types/entities
 *   - opencode-mem-2.0-需求补充-Completion-Gate.md: 9.1 任务开始前生成 Task Brief
 *
 * 运行方式: bun run tests/task-auto-capture.test.ts
 *
 * 说明:
 *   - 依赖真实 LLM (memoryProvider/openai-chat + 内网 vLLM)，与 closed-loop-real.test.ts 相同
 *   - PART A: generateTaskSupport 生成 TaskBrief/CompletionChecklist（AI 失败时有 fallback，结构契约确定）
 *   - PART B: performAutoCapture 端到端 —— mock opencode client + savePrompt 注入对话，
 *     验证捕获后记忆 metadata 含 mem_types/entities (需求 13.1 / 15.2)
 *   - opencode 原生 provider 路径 (opencodeProvider) 需真实 opencode 运行环境，不在本测试范围
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// 动态导入编译后的模块
const srcDir = join(import.meta.dir, "../dist");

// 创建临时目录作为测试项目
const testProjectDir = mkdtempSync(join(tmpdir(), "opencode-mem-task-capture-"));
const opencodeConfigDir = join(testProjectDir, ".opencode");
mkdirSync(opencodeConfigDir, { recursive: true });

console.log(`📁 测试项目目录: ${testProjectDir}`);

// 配置真实 LLM provider (auto-capture 需要 autoCaptureProviderStatus.ready)。
// 注意:
//   - memoryModel 必须与 vLLM 服务器实际模型 ID 完全一致 (compqwen3635/..., 少 3635 会 404)
//   - opencodeProvider/opencodeModel 显式置空, 覆盖全局配置 (~/.config/opencode/opencode-mem.jsonc)
//     的 deepseek, 避免测试环境无 opencode client 时走 opencode 路径失败
const testConfigContent = JSON.stringify(
  {
    storagePath: testProjectDir,
    embeddingModel: "Xenova/nomic-embed-text-v1",
    embeddingDtype: "q8",
    vectorBackend: "hnswlib-wasm-first",
    memoryProvider: "openai-chat",
    memoryApiUrl: "http://192.168.7.113:20128/v1",
    memoryApiKey: "sk-a1b7d5da9f448995-c4yg7o-c159be8f",
    memoryModel: "compqwen3635/Qwen3.6-35B-A3B-FP8",
    opencodeProvider: "",
    opencodeModel: "",
    autoCaptureEnabled: true,
    diag: false,
  },
  null,
  2
);

writeFileSync(join(opencodeConfigDir, "opencode-mem.json"), testConfigContent);
console.log(`   配置文件已创建 (真实 LLM provider)`);

// 复用已有模型缓存，避免重新下载 embedding 模型
const modelCache = join(homedir(), ".opencode-mem/data/.cache");
const targetCache = join(testProjectDir, ".cache");
if (existsSync(modelCache)) {
  cpSync(modelCache, targetCache, { recursive: true });
  console.log(`   ♻️ 已复用模型缓存`);
} else {
  console.log(`   ⚠️ 未找到模型缓存 ${modelCache}，将重新下载`);
}

let testsPassed = 0;
let testsFailed = 0;

async function runTest(name: string, fn: () => Promise<boolean>) {
  process.stdout.write(`\n🔄 ${name}... `);
  try {
    const result = await fn();
    if (result) {
      console.log("✅ PASS");
      testsPassed++;
      return true;
    } else {
      console.log("❌ FAIL");
      testsFailed++;
      return false;
    }
  } catch (error) {
    console.log(`❌ FAIL: ${error}`);
    testsFailed++;
    return false;
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("   opencode-mem Task Brief / auto-capture 验收测试");
  console.log("═══════════════════════════════════════════════════════════");

  const { initConfig } = await import(join(srcDir, "config.js"));
  initConfig(testProjectDir);

  const { memoryClient } = await import(join(srcDir, "services/client.js"));
  const { generateTaskSupport } = await import(join(srcDir, "services/task-support.js"));
  const { performAutoCapture } = await import(join(srcDir, "services/auto-capture.js"));
  const { userPromptManager } = await import(
    join(srcDir, "services/user-prompt/user-prompt-manager.js")
  );
  const { getTags } = await import(join(srcDir, "services/tags.js"));

  const tags = getTags(testProjectDir);
  const containerTag = tags.project.tag;
  console.log(`   容器标签: ${containerTag}`);

  // 预热 embedding 模型 (Task Brief 召回 + auto-capture 写入都需要)
  console.log("\n🔥 预热 embedding 模型...");
  const warmupStart = Date.now();
  await memoryClient.warmup();
  console.log(`   预热完成 (${Date.now() - warmupStart}ms)`);

  const status = await memoryClient.getStatus();
  if (!status.ready) {
    console.error("❌ 系统未就绪，测试终止");
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════
  // PART A: Task Brief Generator
  //  需求 12.1 / 补充文档 9.1 —— 编码前生成结构化任务简报
  // ══════════════════════════════════════════════════════════════

  await runTest("PART A1: generateTaskSupport (mode=brief) 生成完整 TaskBrief", async () => {
    // 预置一条相关记忆，确保召回有内容
    const seedAdd = await memoryClient.addMemory(
      "用户模块使用 JWT 做认证，密码用 bcrypt 哈希存储，登录接口位于 src/auth/login.ts。",
      containerTag,
      {
        type: "feature",
        tags: ["auth", "login"],
        mem_types: ["file_knowledge"],
        entities: [
          { entity: "bcrypt", entity_type: "Library" },
          { entity: "JWT", entity_type: "Technology" },
        ],
        source: "api",
        displayName: tags.project.displayName,
        userName: tags.project.userName,
        userEmail: tags.project.userEmail,
        projectPath: tags.project.projectPath,
        projectName: tags.project.projectName,
      }
    );
    if (!seedAdd.success) {
      console.error(`   预置记忆失败: ${seedAdd.error}`);
      return false;
    }
    console.log(`   预置记忆: ${seedAdd.id}`);

    const result = await generateTaskSupport({
      mode: "brief",
      task: "重构用户模块的登录接口，支持刷新令牌机制",
      containerTag,
      sessionID: `task-brief-${Date.now()}`,
    });

    if (!result.success) {
      console.error(`   generateTaskSupport 失败`);
      return false;
    }

    console.log(`   usedAI=${result.usedAI}, memoriesConsidered=${result.memoriesConsidered}`);
    console.log(`   memoryRefs=${result.memoryRefs.length} 条召回`);

    const brief = result.brief;
    if (!brief) {
      console.log(`   ❌ mode=brief 应返回 brief 字段`);
      return false;
    }

    console.log(`   brief.taskGoal = ${brief.taskGoal?.substring(0, 60)}`);
    console.log(`   brief.constraints = ${JSON.stringify(brief.constraints)}`);
    console.log(`   brief.successCriteria = ${JSON.stringify(brief.successCriteria)}`);

    // TaskBrief 结构契约 (task-support.ts TaskBrief 接口)
    if (typeof brief.taskGoal !== "string" || brief.taskGoal.length === 0) {
      console.log(`   ❌ taskGoal 缺失`);
      return false;
    }
    if (!Array.isArray(brief.relatedFiles)) {
      console.log(`   ❌ relatedFiles 应为数组`);
      return false;
    }
    if (!Array.isArray(brief.relatedSymbols)) {
      console.log(`   ❌ relatedSymbols 应为数组`);
      return false;
    }
    if (!Array.isArray(brief.historicalDecisions)) {
      console.log(`   ❌ historicalDecisions 应为数组`);
      return false;
    }
    if (!Array.isArray(brief.constraintKinds)) {
      console.log(`   ❌ constraintKinds 应为数组`);
      return false;
    }
    if (!Array.isArray(brief.constraints)) {
      console.log(`   ❌ constraints 应为数组`);
      return false;
    }
    if (!Array.isArray(brief.userPreferences)) {
      console.log(`   ❌ userPreferences 应为数组`);
      return false;
    }
    if (!Array.isArray(brief.risks)) {
      console.log(`   ❌ risks 应为数组`);
      return false;
    }
    if (!Array.isArray(brief.successCriteria)) {
      console.log(`   ❌ successCriteria 应为数组`);
      return false;
    }

    return true;
  });

  await runTest(
    "PART A2: generateTaskSupport (mode=checklist) 生成 CompletionChecklist",
    async () => {
      const result = await generateTaskSupport({
        mode: "checklist",
        task: "修复搜索接口返回结果缺失的问题",
        containerTag,
        sessionID: `task-checklist-${Date.now()}`,
      });

      if (!result.success) {
        console.error(`   generateTaskSupport 失败`);
        return false;
      }

      const checklist = result.checklist;
      if (!checklist) {
        console.log(`   ❌ mode=checklist 应返回 checklist 字段`);
        return false;
      }

      console.log(`   usedAI=${result.usedAI}, memoriesConsidered=${result.memoriesConsidered}`);
      console.log(`   successCriteria = ${JSON.stringify(checklist.successCriteria)}`);
      console.log(`   evidenceTemplates = ${JSON.stringify(checklist.evidenceTemplates)}`);

      // CompletionChecklist 结构契约 (task-support.ts CompletionChecklist 接口)
      if (!Array.isArray(checklist.successCriteria)) {
        console.log(`   ❌ successCriteria 应为数组`);
        return false;
      }
      if (!Array.isArray(checklist.verificationHints)) {
        console.log(`   ❌ verificationHints 应为数组`);
        return false;
      }
      if (!Array.isArray(checklist.evidenceTemplates)) {
        console.log(`   ❌ evidenceTemplates 应为数组`);
        return false;
      }
      if (!Array.isArray(checklist.remainingRisks)) {
        console.log(`   ❌ remainingRisks 应为数组`);
        return false;
      }

      return true;
    }
  );

  // ══════════════════════════════════════════════════════════════
  // PART B: auto-capture 端到端
  //  需求 13.1 / 15.2 —— 自动捕获产生的记忆 metadata 含 mem_types/entities
  // ══════════════════════════════════════════════════════════════

  await runTest("PART B: performAutoCapture 写入 mem_types/entities", async () => {
    const sessionID = `auto-capture-${Date.now()}`;
    const messageId = `user-msg-${Date.now()}`;

    // 注入一条未捕获的用户 prompt
    const promptId = userPromptManager.savePrompt(
      sessionID,
      messageId,
      testProjectDir,
      "实现一个用户登录接口，用 SQLite 建 users 表，密码用 bcrypt 哈希，返回 JWT token"
    );
    console.log(`   注入 prompt: ${promptId}`);

    // 构造最小可用的 opencode client mock (session.messages + tui.showToast)
    const mockMessages = [
      {
        info: { id: messageId, role: "user" },
        parts: [
          {
            type: "text",
            text: "实现一个用户登录接口，用 SQLite 建 users 表，密码用 bcrypt 哈希，返回 JWT token",
          },
        ],
      },
      {
        info: { id: "assistant-1", role: "assistant" },
        parts: [
          {
            type: "text",
            text: "已完成 src/auth/login.ts，使用 better-sqlite3 建 users 表，bcrypt 校验密码，签发 JWT，并跑通 bun test 验证。",
          },
        ],
      },
    ];

    const mockCtx = {
      client: {
        session: {
          messages: async () => ({ data: mockMessages }),
        },
        tui: {
          showToast: async () => ({}),
        },
      },
    };

    await performAutoCapture(mockCtx as any, sessionID, testProjectDir);
    console.log(`   performAutoCapture 完成 (无异常)`);

    // 验证 prompt 已被标记为捕获并关联记忆
    const capturedPrompt = userPromptManager.getPromptById(promptId);
    if (!capturedPrompt) {
      console.log(`   ❌ prompt 记录不存在`);
      return false;
    }
    console.log(
      `   prompt.captured=${capturedPrompt.captured}, linkedMemoryId=${capturedPrompt.linkedMemoryId}`
    );
    if (!capturedPrompt.captured || !capturedPrompt.linkedMemoryId) {
      console.log(`   ❌ auto-capture 未将 prompt 标记为已捕获 (可能被判定 skip)`);
      return false;
    }

    // 读回记忆，断言 metadata 含 mem_types/entities (需求 15.2 #1/#2)
    const listResult = await memoryClient.listMemories(containerTag, 50, "project");
    if (!listResult.success) {
      console.error(`   列出失败: ${listResult.error}`);
      return false;
    }

    const capturedMemory = listResult.memories.find(
      (m: { id: string | null }) => m.id === capturedPrompt.linkedMemoryId
    );
    if (!capturedMemory) {
      console.log(`   ❌ 未找到捕获的记忆`);
      return false;
    }

    const metadata: any = capturedMemory.metadata || {};
    console.log(`   memory.metadata.source = ${metadata.source}`);
    console.log(`   memory.metadata.mem_types = ${JSON.stringify(metadata.mem_types)}`);
    console.log(`   memory.metadata.entities = ${JSON.stringify(metadata.entities)}`);

    if (metadata.source !== "auto-capture") {
      console.log(`   ❌ 记忆应标记 source=auto-capture`);
      return false;
    }
    if (!Array.isArray(metadata.mem_types)) {
      console.log(`   ❌ mem_types 应为数组 (降级规则: 模型未输出时为空数组)`);
      return false;
    }
    if (!Array.isArray(metadata.entities)) {
      console.log(`   ❌ entities 应为数组 (降级规则: 模型未输出时为空数组)`);
      return false;
    }

    const memTypes = metadata.mem_types as unknown[];
    if (memTypes.length === 0) {
      console.log(`   ⚠️ mem_types 为空数组 (模型可能未输出, 符合降级规则 13.3)`);
    }

    return true;
  });

  // ══════════════════════════════════════════════════════════════
  // 清理与总结
  // ══════════════════════════════════════════════════════════════

  console.log("\n🧹 清理测试数据...");
  memoryClient.close();

  try {
    rmSync(testProjectDir, { recursive: true, force: true });
    console.log(`   已删除: ${testProjectDir}`);
  } catch (e) {
    console.log(`   清理失败: ${e}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("   测试结果总结");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`   ✅ 通过: ${testsPassed}`);
  console.log(`   ❌ 失败: ${testsFailed}`);
  console.log(`   📊 总计: ${testsPassed + testsFailed}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (testsFailed > 0) {
    console.log("\n⚠️  部分测试失败，请检查上述输出");
    process.exit(1);
  } else {
    console.log("\n🎉 所有 Task Brief / auto-capture 测试通过!");
    console.log("\n验收点覆盖:");
    console.log("  1. ✅ Task Brief Generator 生成完整 TaskBrief (需求 12.1 / 补充文档 9.1)");
    console.log("  2. ✅ Completion Checklist 生成 (补充文档 10.1)");
    console.log("  3. ✅ auto-capture 端到端: 捕获记忆含 mem_types/entities (需求 13.1 / 15.2)");
  }
}

main().catch(console.error);
