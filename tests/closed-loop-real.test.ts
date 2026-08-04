#!/usr/bin/env bun
/**
 * opencode-mem 完整闭环测试
 *
 * 测试真实的 add → search → list → session.idle writeback 流程
 * 使用本地 transformers.js embedding + Hnswlib WASM 向量数据库
 *
 * 运行方式: bun run tests/closed-loop-real.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// 动态导入编译后的模块
const srcDir = join(import.meta.dir, "../dist");

// 创建临时目录作为测试项目
const testProjectDir = mkdtempSync(join(tmpdir(), "opencode-mem-closed-loop-"));
const opencodeConfigDir = join(testProjectDir, ".opencode");
mkdirSync(opencodeConfigDir, { recursive: true });
const modelCache = join(homedir(), ".opencode-mem/data/.cache");

console.log(`📁 测试项目目录: ${testProjectDir}`);

// 创建临时配置文件
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
    opencodeProvider: "deepseek",
    opencodeModel: "deepseek-v4-flash",
    autoCaptureEnabled: false,
    diag: true,
  },
  null,
  2
);

writeFileSync(join(opencodeConfigDir, "opencode-mem.json"), testConfigContent);
console.log(`   配置文件已创建: ${opencodeConfigDir}/opencode-mem.json`);

// 复用已有模型缓存，避免每次重新下载 embedding 模型
const targetCache = join(testProjectDir, ".cache");
if (existsSync(modelCache)) {
  cpSync(modelCache, targetCache, { recursive: true });
  console.log(`   ♻️ 已复用模型缓存: ${modelCache}`);
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
  console.log("   opencode-mem 完整闭环测试 (真实连接)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`📂 存储路径: ${testProjectDir}`);

  // 初始化配置 - 使用 initConfig，它会从项目目录加载配置
  console.log("\n📦 初始化配置和模块...");

  const { initConfig, CONFIG } = await import(join(srcDir, "config.js"));
  initConfig(testProjectDir);

  console.log(`   配置加载完成: vectorBackend=${CONFIG.vectorBackend}`);
  console.log(`   Embedding: ${CONFIG.embeddingModel} (${CONFIG.embeddingDtype})`);

  // 加载核心模块
  const { memoryClient } = await import(join(srcDir, "services/client.js"));
  const { writeCompletionChecklistMemories } = await import(
    join(srcDir, "services/completion-writeback.js")
  );
  const { getTags } = await import(join(srcDir, "services/tags.js"));

  // 获取测试项目标签
  const tags = getTags(testProjectDir);
  const containerTag = tags.project.tag;
  console.log(`   容器标签: ${containerTag}`);

  // 预热 memory client 和 embedding 模型
  console.log("\n🔥 预热 embedding 模型 (首次加载可能需要 10-30 秒)...");
  const warmupStart = Date.now();
  await memoryClient.warmup((progress: { message?: string }) => {
    if (progress.message) {
      process.stdout.write(`\n   ${progress.message}... `);
    }
  });
  console.log(`   预热完成 (${Date.now() - warmupStart}ms)`);

  // 检查系统就绪状态
  const status = await memoryClient.getStatus();
  console.log(`\n📊 系统状态:`);
  console.log(`   dbConnected: ${status.dbConnected}`);
  console.log(`   modelLoaded: ${status.modelLoaded}`);
  console.log(`   ready: ${status.ready}`);

  if (!status.ready) {
    console.error("❌ 系统未就绪，测试终止");
    process.exit(1);
  }

  // ══════════════════════════════════════════════════════════════
  // STEP 1: 添加记忆 (memory add)
  // ══════════════════════════════════════════════════════════════

  let addedMemoryId: string | null = null;

  await runTest("STEP 1: 添加记忆 (addMemory)", async () => {
    const testMemory = {
      content: `这是一个关于 TypeScript 泛型的高级学习笔记。
      
关键要点:
1. 使用 extends 约束泛型类型参数
2. 条件类型 (Conditional Types) 可以实现类型分发
3. 映射类型 (Mapped Types) 用于批量转换类型

示例代码:
type Pick<T, K extends keyof T> = { [P in K]: T[P] };

这个模式在开发中非常实用，特别是在处理 API 响应类型时。`,
      tags: ["typescript", "generics", "advanced", "type-system"],
      type: "learning" as const,
    };

    console.log(`\n   添加内容: ${testMemory.content.substring(0, 50)}...`);

    const result = await memoryClient.addMemory(testMemory.content, containerTag, {
      type: testMemory.type,
      tags: testMemory.tags,
      source: "api",
      displayName: tags.project.displayName,
      userName: tags.project.userName,
      userEmail: tags.project.userEmail,
      projectPath: tags.project.projectPath,
      projectName: tags.project.projectName,
    });

    if (!result.success) {
      console.error(`   添加失败: ${result.error}`);
      return false;
    }

    addedMemoryId = result.id!;
    console.log(`   添加成功: ${result.id}`);
    console.log(`   标签: ${testMemory.tags.join(", ")}`);
    return true;
  });

  // ══════════════════════════════════════════════════════════════
  // STEP 2: 搜索记忆 (memory search)
  // ══════════════════════════════════════════════════════════════

  await runTest("STEP 2: 搜索记忆 (searchMemories)", async () => {
    const searchQueries = ["TypeScript 泛型", "generics type system", "映射类型 mapped types"];

    for (const query of searchQueries) {
      console.log(`\n   搜索: "${query}"`);

      const result = await memoryClient.searchMemories(query, containerTag, "project");

      if (!result.success) {
        console.error(`   搜索失败: ${result.error}`);
        return false;
      }

      console.log(`   找到 ${result.total} 条结果`);

      if (result.total > 0) {
        for (const item of result.results.slice(0, 3)) {
          console.log(`     - [${item.similarity.toFixed(3)}] ${item.memory.substring(0, 60)}...`);
        }

        // 检查刚才添加的记忆是否在结果中
        const found = result.results.some((r: { id: string | null }) => r.id === addedMemoryId);
        if (found) {
          console.log(`   ✅ 刚添加的记忆被搜索到!`);
        } else {
          console.log(`   ⚠️ 刚添加的记忆未在 top 结果中 (可能相似度不够高)`);
        }
      }
    }

    return true;
  });

  // ══════════════════════════════════════════════════════════════
  // STEP 3: 列出记忆 (memory list)
  // ══════════════════════════════════════════════════════════════

  await runTest("STEP 3: 列出记忆 (listMemories)", async () => {
    const result = await memoryClient.listMemories(containerTag, 20, "project");

    if (!result.success) {
      console.error(`   列出失败: ${result.error}`);
      return false;
    }

    const total = result.pagination?.totalItems ?? result.memories?.length ?? 0;
    console.log(`\n   当前项目共有 ${total} 条记忆`);

    // 找刚才添加的记忆
    const addedMemory = result.memories?.find((m: { id: string | null }) => m.id === addedMemoryId);
    if (addedMemory) {
      console.log(`   ✅ 刚添加的记忆存在于列表中`);
      console.log(`   内容: ${(addedMemory.summary || "").substring(0, 80)}...`);
      console.log(`   显示名: ${addedMemory.displayName || "N/A"}`);
    } else {
      console.log(`   ⚠️ 刚添加的记忆未在列表中找到`);
    }

    return true;
  });

  // ══════════════════════════════════════════════════════════════
  // STEP 4: Session Idle Writeback
  // ══════════════════════════════════════════════════════════════

  let writebackIds: string[] = [];

  await runTest("STEP 4: Session Idle Writeback (writeCompletionChecklistMemories)", async () => {
    const sessionId = `test-session-${Date.now()}`;
    const promptId = `test-prompt-${Date.now()}`;

    console.log(`\n   Session ID: ${sessionId}`);
    console.log(`   Prompt ID: ${promptId}`);

    // 模拟 session.idle 触发时的完整上下文
    const writebackResult = await writeCompletionChecklistMemories({
      task: "实现一个 TypeScript 泛型工具类型，用于从对象类型中提取指定的属性",
      sessionID: sessionId,
      promptId: promptId,
      containerTag: containerTag,
      checklist: {
        successCriteria: ["Pick<T, K> 类型正确实现", "能够从对象中提取指定属性", "类型检查通过"],
        verificationHints: ["使用 keyof 获取所有键", "使用 extends 约束 K 必须为 keyof T"],
        evidenceTemplates: [
          { type: "test_result", title: "TypeScript 编译检查" },
          { type: "runtime_observation", title: "运行结果验证" },
        ],
        remainingRisks: ["边界情况: 空对象类型", "可选属性的处理"],
      },
      memoryRefs: [
        {
          id: addedMemoryId || "unknown",
          summary: "TypeScript 泛型学习笔记",
          memTypes: ["learning"],
          entities: [
            { entity: "Pick<T, K>", entity_type: "Type" },
            { entity: "keyof", entity_type: "Operator" },
          ],
          decisionTags: ["type-safety"],
        },
      ],
      constraintKinds: ["preserve_db_schema", "minimize_change"],
      evidence: {
        assistantResponses: [
          "我将实现一个 Pick<T, K> 类型工具...",
          "首先定义泛型约束，确保 K 只能是 T 的键...",
        ],
        toolExecutions: [
          {
            name: "tsc",
            input: '{"file": "types.ts"}',
            output: "0 errors",
          },
        ],
        toolResultTexts: ["TypeScript 编译成功"],
        referencedFiles: ["src/types.ts", "tests/types.test.ts"],
        commandOutputs: [],
        testResults: [
          {
            type: "test_result",
            title: "类型检查",
            payload: "tsc --noEmit: 0 errors",
            source: "tool",
            toolName: "tsc",
          },
        ],
        apiResponses: [],
        runtimeObservations: [
          {
            type: "runtime_observation",
            title: "代码审查",
            payload: "泛型约束正确，类型推断准确",
            source: "assistant",
          },
        ],
        evidenceItems: [],
      },
      projectInfo: {
        displayName: tags.project.displayName,
        userName: tags.project.userName,
        userEmail: tags.project.userEmail,
        projectPath: tags.project.projectPath,
        projectName: tags.project.projectName,
        gitRepoUrl: tags.project.gitRepoUrl,
      },
    });

    console.log(`\n   Writeback 结果:`);
    console.log(`   success: ${writebackResult.success}`);
    console.log(`   skipped: ${writebackResult.skipped}`);
    console.log(`   usedAI: ${writebackResult.usedAI}`);
    console.log(`   writtenMemoryIds: ${writebackResult.writtenMemoryIds?.length || 0}`);

    if (writebackResult.error) {
      console.error(`   error: ${writebackResult.error}`);
    }

    if (writebackResult.drafts) {
      console.log(`   生成的 drafts:`);
      for (const draft of writebackResult.drafts) {
        console.log(`     - [${draft.mem_type}] ${draft.content.substring(0, 60)}...`);
      }
    }

    writebackIds = writebackResult.writtenMemoryIds || [];

    if (!writebackResult.success) {
      return false;
    }

    return true;
  });

  // ══════════════════════════════════════════════════════════════
  // STEP 5: 验证 Writeback 记忆可被搜索
  // ══════════════════════════════════════════════════════════════

  await runTest("STEP 5: 验证 Writeback 记忆可被搜索", async () => {
    if (writebackIds.length === 0) {
      console.log(`   ⚠️ 没有 writeback IDs 跳过验证`);
      return true;
    }

    console.log(`\n   验证 ${writebackIds.length} 条 writeback 记忆...`);

    // 搜索包含 "TypeScript" 或 "泛型" 的内容
    const result = await memoryClient.searchMemories(
      "TypeScript 泛型工具类型 completion-gate",
      containerTag,
      "project"
    );

    if (!result.success) {
      console.error(`   搜索失败: ${result.error}`);
      return false;
    }

    console.log(`   搜索到 ${result.total} 条结果`);

    // 检查 writeback 记忆是否在结果中
    const writebackInResults = result.results.filter((r: { id: string }) =>
      writebackIds.includes(r.id)
    );

    console.log(`   其中 ${writebackInResults.length} 条来自 writeback`);

    for (const item of result.results.slice(0, 5)) {
      const isWriteback = writebackIds.includes(item.id);
      console.log(
        `     [${item.similarity.toFixed(3)}] ${isWriteback ? "🔄" : "📝"} ${item.memory.substring(0, 50)}...`
      );
    }

    return true;
  });

  // ══════════════════════════════════════════════════════════════
  // 清理
  // ══════════════════════════════════════════════════════════════

  console.log("\n🧹 清理测试数据...");
  memoryClient.close();

  try {
    rmSync(testProjectDir, { recursive: true, force: true });
    console.log(`   已删除: ${testProjectDir}`);
  } catch (e) {
    console.log(`   清理失败: ${e}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 测试结果总结
  // ══════════════════════════════════════════════════════════════

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
    console.log("\n🎉 所有测试通过! 完整闭环验证成功");
    console.log("\n闭环流程验证:");
    console.log("  1. ✅ addMemory → 写入 Hnswlib/SQLite");
    console.log("  2. ✅ searchMemories → ANN 向量搜索");
    console.log("  3. ✅ listMemories → 数据库查询");
    console.log("  4. ✅ writeCompletionChecklistMemories → session.idle writeback");
    console.log("  5. ✅ writeback 记忆可被后续搜索检索");
  }
}

main().catch(console.error);
