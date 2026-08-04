#!/usr/bin/env bun
/**
 * opencode-mem 认知验收测试
 *
 * 针对两份需求文档的未覆盖验收点：
 *   - opencode-mem-2.0-需求文档.md: 15.2 验收标准 (metadata 含 mem_types/entities、单条多类型)、13.2 旧数据兼容、13.3 降级
 *   - opencode-mem-2.0-需求补充-Completion-Gate.md: 5.2 输出契约、6. Task Status (done/partial/blocked)
 *
 * 运行方式: bun run tests/cognitive-acceptance.test.ts
 *
 * 说明:
 *   - 刻意不配置 opencodeProvider/memoryModel/memoryApiUrl，使 Completion Gate
 *     确定性走 fallback (AI 路径置空 = 验证降级路径 usedAI === false)
 *   - 白名单过滤 (normalizeMemTypes) 位于 auto-capture 的 LLM 路径，不在本测试范围；
 *     本测试验证"非法值不阻断核心写入 + 读回安全" (需求 13.3 #4)
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// 动态导入编译后的模块
const srcDir = join(import.meta.dir, "../dist");

// 创建临时目录作为测试项目
const testProjectDir = mkdtempSync(join(tmpdir(), "opencode-mem-cognitive-"));
const opencodeConfigDir = join(testProjectDir, ".opencode");
mkdirSync(opencodeConfigDir, { recursive: true });

console.log(`📁 测试项目目录: ${testProjectDir}`);

// 不配置任何 LLM provider：Completion Gate 走 fallback，验证降级路径可用。
// 注意：必须用空字符串显式覆盖全局配置 (~/.config/opencode/opencode-mem.jsonc)
// 中的 provider，否则 initConfig 会合并全局值导致 Gate 走 AI 路径。
const testConfigContent = JSON.stringify(
  {
    storagePath: testProjectDir,
    embeddingModel: "Xenova/nomic-embed-text-v1",
    embeddingDtype: "q8",
    vectorBackend: "hnswlib-wasm-first",
    opencodeProvider: "",
    opencodeModel: "",
    memoryProvider: "",
    memoryModel: "",
    memoryApiUrl: "",
    memoryApiKey: "",
    autoCaptureEnabled: false,
    diag: false,
  },
  null,
  2
);

writeFileSync(join(opencodeConfigDir, "opencode-mem.json"), testConfigContent);
console.log(`   配置文件已创建 (无 LLM provider, Gate 走 fallback)`);

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

// 空的执行证据，用于构造"无证据"的 Gate 输入
function emptyEvidence() {
  return {
    assistantResponses: [],
    toolExecutions: [],
    toolResultTexts: [],
    referencedFiles: [],
    commandOutputs: [],
    testResults: [],
    apiResponses: [],
    runtimeObservations: [],
    evidenceItems: [],
  };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("   opencode-mem 认知验收测试");
  console.log("═══════════════════════════════════════════════════════════");

  const { initConfig } = await import(join(srcDir, "config.js"));
  initConfig(testProjectDir);

  const { memoryClient } = await import(join(srcDir, "services/client.js"));
  const { generateCompletionGateSuggestion } = await import(
    join(srcDir, "services/completion-gate-advisor.js")
  );
  const { getTags } = await import(join(srcDir, "services/tags.js"));

  const tags = getTags(testProjectDir);
  const containerTag = tags.project.tag;
  console.log(`   容器标签: ${containerTag}`);

  // 预热 embedding 模型
  console.log("\n🔥 预热 embedding 模型...");
  const warmupStart = Date.now();
  await memoryClient.warmup();
  console.log(`   预热完成 (${Date.now() - warmupStart}ms)`);

  const status = await memoryClient.getStatus();
  if (!status.ready) {
    console.error("❌ 系统未就绪，测试终止");
    process.exit(1);
  }

  const projectInfo = {
    source: "api" as const,
    displayName: tags.project.displayName,
    userName: tags.project.userName,
    userEmail: tags.project.userEmail,
    projectPath: tags.project.projectPath,
    projectName: tags.project.projectName,
  };

  // ══════════════════════════════════════════════════════════════
  // STEP 1: metadata 认知字段读回断言
  //  需求文档 15.2 #1/#2 (mem_types/entities) + #3 (单条多类型)
  // ══════════════════════════════════════════════════════════════

  let cognitiveMemoryId: string | null = null;

  await runTest("STEP 1: 读回断言 - metadata 含 mem_types/entities 且单条多类型", async () => {
    const addResult = await memoryClient.addMemory(
      "认知字段验收：SQLite 向量索引与 TypeScript 类型系统集成经验。",
      containerTag,
      {
        type: "learning",
        tags: ["cognitive", "acceptance"],
        mem_types: ["experience", "skill"],
        entities: [
          { entity: "SQLite", entity_type: "Library" },
          { entity: "TypeScript", entity_type: "Technology" },
        ],
        ...projectInfo,
      }
    );

    if (!addResult.success) {
      console.error(`   添加失败: ${addResult.error}`);
      return false;
    }
    cognitiveMemoryId = addResult.id!;
    console.log(`   已写入: ${cognitiveMemoryId} (mem_types: [experience, skill])`);

    const listResult = await memoryClient.listMemories(containerTag, 50, "project");
    if (!listResult.success) {
      console.error(`   列出失败: ${listResult.error}`);
      return false;
    }

    const memory = listResult.memories.find(
      (m: { id: string | null }) => m.id === cognitiveMemoryId
    );
    if (!memory) {
      console.log(`   ❌ 未在列表中读到刚写入的记忆`);
      return false;
    }

    const metadata: any = memory.metadata || {};
    const memTypes = metadata.mem_types;
    const entities = metadata.entities;

    console.log(`   metadata.mem_types = ${JSON.stringify(memTypes)}`);
    console.log(`   metadata.entities = ${JSON.stringify(entities)}`);

    if (!Array.isArray(memTypes) || memTypes.length !== 2) {
      console.log(`   ❌ 单条记忆应同时具备多个 mem_types (需求 #3)`);
      return false;
    }
    if (!memTypes.includes("experience") || !memTypes.includes("skill")) {
      console.log(`   ❌ mem_types 值与写入不一致`);
      return false;
    }

    if (!Array.isArray(entities) || entities.length === 0) {
      console.log(`   ❌ entities 缺失`);
      return false;
    }
    const sqliteEntity = entities.find(
      (e: { entity?: string; entity_type?: string }) =>
        e.entity === "SQLite" && e.entity_type === "Library"
    );
    if (!sqliteEntity) {
      console.log(`   ❌ 期望实体 {entity: SQLite, entity_type: Library} 不存在`);
      return false;
    }

    return true;
  });

  // ══════════════════════════════════════════════════════════════
  // STEP 2: Completion Gate 判定 (fallback 确定性路径)
  //  补充文档 5.2 输出契约 + 6. Task Status + 降级 (usedAI === false)
  // ══════════════════════════════════════════════════════════════

  await runTest("STEP 2: Completion Gate 判定 (blocked/done/partial)", async () => {
    const sessionID = `gate-test-${Date.now()}`;

    // 2a: 无任何证据 -> blocked
    const blockedResult = await generateCompletionGateSuggestion({
      task: "实现一个搜索接口",
      sessionID,
      checklist: {
        successCriteria: ["接口返回 200"],
        verificationHints: [],
        evidenceTemplates: [],
        remainingRisks: [],
      },
      evidence: emptyEvidence(),
      constraints: [],
    });

    if (!blockedResult.success) {
      console.log(`   ❌ Gate 调用失败`);
      return false;
    }
    if (blockedResult.suggestion.status !== "blocked") {
      console.log(`   ❌ 空证据场景应输出 blocked, 实际 = ${blockedResult.suggestion.status}`);
      return false;
    }
    console.log(`   空证据 -> ${blockedResult.suggestion.status}`);

    // 2b: 测试证据齐全 + 无约束 -> done
    const doneResult = await generateCompletionGateSuggestion({
      task: "实现一个工具类型",
      sessionID,
      checklist: {
        successCriteria: ["运行测试且全部通过"],
        verificationHints: [],
        evidenceTemplates: [],
        remainingRisks: [],
      },
      evidence: {
        ...emptyEvidence(),
        testResults: [
          {
            type: "test_result" as const,
            title: "bun test",
            payload: "0 failures",
            source: "tool" as const,
          },
        ],
      },
      constraints: [],
    });

    if (doneResult.suggestion.status !== "done") {
      console.log(`   ❌ 测试证据齐全场景应输出 done, 实际 = ${doneResult.suggestion.status}`);
      return false;
    }
    const passedCriteria = doneResult.suggestion.criteria_check.find(
      (c: { status: string }) => c.status === "pass"
    );
    if (!passedCriteria) {
      console.log(`   ❌ done 场景应至少有一条 pass 的 criteria`);
      return false;
    }
    console.log(`   证据齐全 -> ${doneResult.suggestion.status}`);

    // 2c: 违反 schema 约束 -> partial
    const partialResult = await generateCompletionGateSuggestion({
      task: "重构类型定义",
      sessionID,
      checklist: {
        successCriteria: ["运行测试且全部通过"],
        verificationHints: [],
        evidenceTemplates: [],
        remainingRisks: [],
      },
      evidence: {
        ...emptyEvidence(),
        referencedFiles: ["src/db/migration.sql"],
        testResults: [
          {
            type: "test_result" as const,
            title: "bun test",
            payload: "0 failures",
            source: "tool" as const,
          },
        ],
      },
      constraints: ["不得修改数据库 schema"],
    });

    if (partialResult.suggestion.status !== "partial") {
      console.log(`   ❌ 违反约束场景应输出 partial, 实际 = ${partialResult.suggestion.status}`);
      return false;
    }
    const failedConstraint = partialResult.suggestion.constraint_check.find(
      (c: { status: string }) => c.status === "fail"
    );
    if (!failedConstraint) {
      console.log(`   ❌ partial 场景应存在 fail 的 constraint`);
      return false;
    }
    console.log(`   违反约束 -> ${partialResult.suggestion.status}`);

    // 契约结构验证 (补充文档 5.2)
    const suggestion = doneResult.suggestion;
    if (
      !Array.isArray(suggestion.criteria_check) ||
      !Array.isArray(suggestion.constraint_check) ||
      typeof suggestion.summary !== "string" ||
      !Array.isArray(suggestion.next_actions)
    ) {
      console.log(`   ❌ 输出缺少 criteria_check/constraint_check/summary/next_actions`);
      return false;
    }
    console.log(`   输出契约完整: status/criteria_check/constraint_check/summary/next_actions`);

    // 降级验证: 未配置 provider 时不应使用 AI
    if (blockedResult.usedAI) {
      console.log(`   ❌ 未配置 provider 时不应使用 AI (降级路径验证失败)`);
      return false;
    }
    console.log(`   降级路径验证: usedAI=false (AI 不可用时 fallback 正常建议)`);

    return true;
  });

  // ══════════════════════════════════════════════════════════════
  // STEP 3: 降级与兼容
  //  需求 13.2 旧数据兼容 + 13.3 #4 非法认知字段不阻断核心写入
  // ══════════════════════════════════════════════════════════════

  await runTest("STEP 3: 降级与兼容 (旧数据/非法值)", async () => {
    // 3a: 旧数据兼容 —— 无 mem_types/entities 的记忆可正常读写、检索
    const legacyAdd = await memoryClient.addMemory(
      "旧数据兼容测试：这条记忆没有任何认知字段。",
      containerTag,
      { type: "episodic", tags: ["legacy"], ...projectInfo }
    );
    if (!legacyAdd.success) {
      console.error(`   旧数据写入失败: ${legacyAdd.error}`);
      return false;
    }

    const legacyList = await memoryClient.listMemories(containerTag, 50, "project");
    if (!legacyList.success) {
      console.error(`   旧数据列出失败: ${legacyList.error}`);
      return false;
    }
    const legacyMemory = legacyList.memories.find(
      (m: { id: string | null }) => m.id === legacyAdd.id
    );
    if (!legacyMemory) {
      console.log(`   ❌ 旧数据读取失败`);
      return false;
    }
    const legacyMetadata: any = legacyMemory.metadata || {};
    console.log(
      `   旧数据读取正常, mem_types = ${JSON.stringify(legacyMetadata.mem_types ?? "undefined")}`
    );

    const legacySearch = await memoryClient.searchMemories("旧数据兼容", containerTag, "project");
    if (!legacySearch.success) {
      console.error(`   旧数据检索失败: ${legacySearch.error}`);
      return false;
    }
    console.log(`   旧数据检索正常 (${legacySearch.total} 条)`);

    // 3b: 非法值不阻断写入 —— 非法 mem_type / 非法 entity_type 不应导致写入失败
    const invalidAdd = await memoryClient.addMemory(
      "非法值降级测试：模型输出了不存在的认知类型与实体类型。",
      containerTag,
      {
        type: "episodic",
        tags: ["degrade"],
        mem_types: ["hacker_skill", "experience"],
        entities: [
          { entity: "Foo", entity_type: "NotARealType" },
          { entity: "SQLite", entity_type: "Library" },
        ],
        ...projectInfo,
      }
    );
    if (!invalidAdd.success) {
      console.error(`   非法认知字段阻断写入: ${invalidAdd.error}`);
      return false;
    }
    console.log(`   非法认知字段未阻断写入: ${invalidAdd.id}`);

    const invalidList = await memoryClient.listMemories(containerTag, 50, "project");
    if (!invalidList.success) {
      console.error(`   非法值记忆列出失败: ${invalidList.error}`);
      return false;
    }
    const invalidMemory = invalidList.memories.find(
      (m: { id: string | null }) => m.id === invalidAdd.id
    );
    if (!invalidMemory) {
      console.log(`   ❌ 非法值记忆读取失败`);
      return false;
    }
    const invalidMetadata: any = invalidMemory.metadata || {};
    console.log(`   非法值记忆读取安全, mem_types = ${JSON.stringify(invalidMetadata.mem_types)}`);
    console.log(
      `   注: 存储层不过滤非法值; 白名单过滤位于 auto-capture 的 normalizeMemTypes (LLM 路径, 不在本测试范围)`
    );

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
    console.log("\n🎉 所有认知验收测试通过!");
    console.log("\n验收点覆盖:");
    console.log("  1. ✅ metadata 含 mem_types/entities 且单条多类型 (需求 15.2 #1/#2/#3)");
    console.log("  2. ✅ Completion Gate 输出 done/partial/blocked + 完整契约 (补充文档 5.2/6)");
    console.log("  3. ✅ 降级路径可用 (usedAI=false) + 旧数据兼容 (13.2) + 非法值不阻断 (13.3)");
  }
}

main().catch(console.error);
