import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const taskSupportUrl = new URL("../src/services/task-support.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const opencodeProviderLoaderUrl = new URL(
  "../src/services/ai/opencode-provider-loader.js",
  import.meta.url
).href;
const profileLlmClientUrl = new URL("../src/services/ai/profile-llm-client.js", import.meta.url)
  .href;
const aiProviderFactoryUrl = new URL("../src/services/ai/ai-provider-factory.js", import.meta.url)
  .href;
const providerConfigUrl = new URL("../src/services/ai/provider-config.js", import.meta.url).href;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type ScenarioOptions = {
  useOpencodeAI?: boolean;
  useProviderAI?: boolean;
};

function runScenario(options: ScenarioOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-task-support-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const useOpencodeAI = options.useOpencodeAI ?? false;
  const useProviderAI = options.useProviderAI ?? false;

  const script = `
import { mock } from "bun:test";
let structuredCallCount = 0;

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    memory: { defaultScope: "project" },
    opencodeProvider: ${useOpencodeAI ? '"openai"' : "undefined"},
    opencodeModel: ${useOpencodeAI ? '"gpt-test"' : "undefined"},
    memoryProvider: "openai-chat",
    memoryModel: ${useProviderAI ? '"gpt-fallback"' : "undefined"},
    memoryApiUrl: ${useProviderAI ? '"https://api.test/v1"' : "undefined"},
    memoryApiKey: ${useProviderAI ? '"test-key"' : "undefined"},
  },
}));

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    searchMemories: async () => ({
      success: true,
      results: [
        {
          id: "mem-1",
          memory:
            "为 auto-capture 增加 task brief 时，核心修改文件是 src/services/auto-capture.ts，并要保持 metadata 扩展方式。",
          similarity: 0.93,
          metadata: {
            mem_types: ["file_knowledge", "experience"],
            entities: [
              { entity: "src/services/auto-capture.ts", entity_type: "File" },
              { entity: "metadata 扩展", entity_type: "Decision" },
              { entity: "metadata 没保存进去", entity_type: "Issue" },
            ],
            constraint_kinds: ["preserve_db_schema", "minimize_change"],
            decision_tags: ["architecture_boundary", "scope_control"],
          },
        },
      ],
      total: 1,
      timing: 0,
    }),
    listMemories: async () => ({
      success: true,
      memories: [
        {
          id: "mem-2",
          summary: "用户偏好：外科手术式修改，尽量不改 schema，不要过度工程化。",
          metadata: {
            mem_types: ["profile"],
            entities: [],
          },
        },
      ],
      pagination: { currentPage: 1, totalItems: 1, totalPages: 1 },
    }),
  },
}));

mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    generateStructuredOutput: async () => (
      structuredCallCount += 1,
      structuredCallCount === 1
        ? ${JSON.stringify({
          taskGoal: "AI brief",
          relatedFiles: ["src/ai.ts"],
          relatedSymbols: ["aiFlow"],
          historicalDecisions: ["使用 AI 推理"],
          constraintKinds: ["preserve_db_schema"],
          constraints: ["不修改数据库结构"],
          userPreferences: ["保持简洁"],
          risks: ["AI 幻觉"],
          successCriteria: ["AI brief 标准"],
        })}
        : ${JSON.stringify({
          successCriteria: ["AI 输出的成功标准"],
          verificationHints: ["AI 输出的验证提示"],
          evidenceTemplates: [{ type: "test_result", title: "AI test", payload: "" }],
          remainingRisks: ["AI 输出的剩余风险"],
        })}
    ),
  }),
}));

mock.module(${JSON.stringify(profileLlmClientUrl)}, () => ({
  getOpenCodeClient: async () => ({}),
}));

mock.module(${JSON.stringify(aiProviderFactoryUrl)}, () => ({
  AIProviderFactory: {
    createProvider: () => ({
      executeToolCall: async () => ({
        success: true,
        data: {
          successCriteria: ["Provider 输出的成功标准"],
          verificationHints: ["Provider 输出的验证提示"],
          evidenceTemplates: [{ type: "command_output", title: "Provider cmd", payload: "" }],
          remainingRisks: ["Provider 输出的剩余风险"],
        },
      }),
    }),
  },
}));

mock.module(${JSON.stringify(providerConfigUrl)}, () => ({
  buildMemoryProviderConfig: () => ({
    model: "gpt-fallback",
    apiUrl: "https://api.test/v1",
    apiKey: "test-key",
  }),
}));

const { generateTaskSupport } = await import(${JSON.stringify(taskSupportUrl)});
const brief = await generateTaskSupport({
  mode: "brief",
  task: "为 auto-capture 接入 task brief",
  containerTag: "project-tag",
  sessionID: "session-1",
});
const checklist = await generateTaskSupport({
  mode: "checklist",
  task: "为 auto-capture 接入 task brief",
  containerTag: "project-tag",
  sessionID: "session-1",
});

console.log(JSON.stringify({ brief, checklist }));
`;

  writeFileSync(scriptPath, script, "utf-8");

  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();

  return {
    exitCode: result.exitCode,
    stderr,
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

describe("task support fallback generation", () => {
  it("builds brief and checklist from recalled mem_types and entities without AI", () => {
    const result = runScenario();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.brief.usedAI).toBe(false);
    expect(result.parsed?.brief.brief.relatedFiles).toContain("src/services/auto-capture.ts");
    expect(result.parsed?.brief.brief.userPreferences[0]).toContain("外科手术式修改");
    expect(result.parsed?.brief.brief.constraints).toContain("不修改数据库结构");
    expect(result.parsed?.brief.brief.constraintKinds).toContain("preserve_db_schema");
    expect(result.parsed?.brief.brief.constraintKinds).toContain("minimize_change");
    expect(result.parsed?.brief.brief.risks[0]).toContain("metadata");
    expect(result.parsed?.checklist.usedAI).toBe(false);
    expect(result.parsed?.checklist.checklist.successCriteria[0]).toContain(
      "为 auto-capture 接入 task brief"
    );
    expect(result.parsed?.checklist.checklist.verificationHints.length).toBeGreaterThan(0);
    expect(result.parsed?.checklist.checklist.evidenceTemplates.length).toBeGreaterThan(0);
  });

  it("uses opencode structured output when AI reasoning is available", () => {
    const result = runScenario({ useOpencodeAI: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.brief.usedAI).toBe(true);
    expect(result.parsed?.brief.brief.taskGoal).toBe("AI brief");
    expect(result.parsed?.brief.brief.constraints).toEqual(["不修改数据库结构"]);
    expect(result.parsed?.brief.brief.constraintKinds).toContain("preserve_db_schema");
    expect(result.parsed?.checklist.usedAI).toBe(true);
    expect(result.parsed?.checklist.checklist.successCriteria).toEqual(["AI 输出的成功标准"]);
  });

  it("falls back to external provider tool-call AI when opencode is unavailable", () => {
    const result = runScenario({ useProviderAI: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.brief.usedAI).toBe(true);
    expect(result.parsed?.brief.brief.successCriteria).toEqual(["Provider 输出的成功标准"]);
    expect(result.parsed?.checklist.usedAI).toBe(true);
    expect(result.parsed?.checklist.checklist.successCriteria).toEqual(["Provider 输出的成功标准"]);
  });
});
