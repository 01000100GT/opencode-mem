import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const writebackUrl = new URL("../src/services/completion-writeback.js", import.meta.url).href;
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
  dedupe?: boolean;
};

function runScenario(options: ScenarioOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-writeback-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const useOpencodeAI = options.useOpencodeAI ?? false;
  const useProviderAI = options.useProviderAI ?? false;
  const dedupe = options.dedupe ?? false;

  const script = `
import { mock } from "bun:test";

const addCalls = [];

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
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
    listMemories: async () => ({
      success: true,
      memories: ${
        dedupe
          ? JSON.stringify([
              {
                id: "mem-existing",
                summary: "existing writeback",
                metadata: {
                  promptId: "prompt-1",
                  writebackSource: "completion-checklist",
                },
              },
            ])
          : "[]"
      },
      pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
    }),
    addMemory: async (content, _tag, metadata) => {
      addCalls.push({ content, metadata });
      return { success: true, id: \`mem-\${addCalls.length}\` };
    },
  },
}));

mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    generateStructuredOutput: async () => ({
      memories: [
        {
          type: "feature",
          mem_type: "experience",
          content: "AI 经验沉淀",
          tags: ["ai", "experience"],
          entities: [{ entity: "SQLite", entity_type: "Library" }],
        },
        {
          type: "workflow",
          mem_type: "skill",
          content: "AI 技能沉淀",
          tags: ["ai", "workflow"],
          entities: [{ entity: "src/index.ts", entity_type: "File" }],
        },
      ],
    }),
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
          memories: [
            {
              type: "verification",
              mem_type: "tool_trace",
              content: "Provider 工具轨迹沉淀",
              tags: ["provider", "trace"],
              entities: [{ entity: "verifyFlow", entity_type: "Function" }],
            },
          ],
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

const { writeCompletionChecklistMemories } = await import(${JSON.stringify(writebackUrl)});
const result = await writeCompletionChecklistMemories({
  task: "给 checklist 结果做结构化回写",
  sessionID: "session-1",
  promptId: "prompt-1",
  containerTag: "project-tag",
  constraintKinds: ["preserve_db_schema", "minimize_change"],
  checklist: {
    successCriteria: ["输出验证提示"],
    verificationHints: ["跑最小 smoke"],
    evidenceTemplates: [{ type: "test_result", title: "bun test", payload: "" }],
    remainingRisks: ["存在边界风险"],
  },
  memoryRefs: [
    {
      id: "mem-ref-1",
      summary: "历史验证经验",
      memTypes: ["experience"],
      entities: [{ entity: "src/index.ts", entity_type: "File" }],
      decisionTags: ["scope_control"],
    },
  ],
  evidence: {
    assistantResponses: ["我先检查 src/index.ts 并运行 bun test。"],
    toolExecutions: [
      {
        name: "bun_test",
        input: '{"command":"bun test tests/session-idle-checklist.test.ts"}',
        output: "1 passed",
      },
    ],
    toolResultTexts: ["stdout: src/index.ts verified"],
    referencedFiles: ["src/index.ts", "tests/session-idle-checklist.test.ts"],
    commandOutputs: [
      {
        type: "command_output",
        title: "Command output via tool_result",
        payload: "stdout: src/index.ts verified",
        source: "tool_result",
      },
    ],
    testResults: [
      {
        type: "test_result",
        title: "Test result via bun_test",
        payload: 'input={"command":"bun test tests/session-idle-checklist.test.ts"} output=1 passed',
        source: "tool",
        toolName: "bun_test",
      },
    ],
    apiResponses: [],
    runtimeObservations: [
      {
        type: "runtime_observation",
        title: "Assistant observation",
        payload: "我先检查 src/index.ts 并运行 bun test。",
        source: "assistant",
      },
    ],
    evidenceItems: [
      {
        type: "runtime_observation",
        title: "Assistant observation",
        payload: "我先检查 src/index.ts 并运行 bun test。",
        source: "assistant",
      },
      {
        type: "test_result",
        title: "Test result via bun_test",
        payload: 'input={"command":"bun test tests/session-idle-checklist.test.ts"} output=1 passed',
        source: "tool",
        toolName: "bun_test",
      },
      {
        type: "command_output",
        title: "Command output via tool_result",
        payload: "stdout: src/index.ts verified",
        source: "tool_result",
      },
    ],
  },
  projectInfo: {
    displayName: "Test Project",
    projectPath: "/workspace",
    projectName: "workspace",
  },
});

console.log(JSON.stringify({ result, addCalls }));
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

describe("completion checklist writeback", () => {
  it("writes fallback experience/tool_trace/skill/file_knowledge memories when AI is unavailable", () => {
    const result = runScenario();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.result.usedAI).toBe(false);
    expect(result.parsed?.result.writtenMemoryIds.length).toBe(4);
    expect(result.parsed?.addCalls[0].metadata.type).toBe("verification");
    expect(result.parsed?.addCalls[0].metadata.mem_types).toEqual(["experience"]);
    expect(result.parsed?.addCalls[0].metadata.tags).toContain("bun_test");
    expect(result.parsed?.addCalls[0].metadata.tags).toContain("test_result");
    expect(result.parsed?.addCalls[0].metadata.constraint_kinds).toContain("preserve_db_schema");
    expect(result.parsed?.addCalls[0].metadata.decision_tags).toContain("scope_control");
    expect(result.parsed?.addCalls[0].content).toContain("Matched evidence:");
    expect(result.parsed?.addCalls[0].content).toContain("Assistant observation");
    expect(result.parsed?.addCalls[1].metadata.mem_types).toEqual(["tool_trace"]);
    expect(result.parsed?.addCalls[1].metadata.constraint_kinds).toBeUndefined();
    expect(result.parsed?.addCalls[1].content).toContain("Test results:");
    expect(result.parsed?.addCalls[1].content).toContain("Test result via bun_test");
    expect(result.parsed?.addCalls[1].content).toContain("Command outputs:");
    expect(result.parsed?.addCalls[2].metadata.mem_types).toEqual(["skill"]);
    expect(result.parsed?.addCalls[2].metadata.constraint_kinds).toContain("minimize_change");
    expect(result.parsed?.addCalls[2].metadata.entities).toEqual([
      { entity: "src/index.ts", entity_type: "File" },
      { entity: "tests/session-idle-checklist.test.ts", entity_type: "File" },
    ]);
    expect(result.parsed?.addCalls[2].content).toContain("test_result");
    expect(result.parsed?.addCalls[3].metadata.mem_types).toEqual(["file_knowledge"]);
    expect(result.parsed?.addCalls[3].metadata.constraint_kinds).toContain("preserve_db_schema");
    expect(result.parsed?.addCalls[3].content).toContain("Files involved:");
    expect(result.parsed?.addCalls[0].metadata.writebackSource).toBe("completion-checklist");
  });

  it("uses opencode AI writeback drafts when available", () => {
    const result = runScenario({ useOpencodeAI: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.result.usedAI).toBe(true);
    expect(result.parsed?.result.writtenMemoryIds.length).toBe(4);
    expect(result.parsed?.addCalls[0].content).toBe("AI 经验沉淀");
    expect(result.parsed?.addCalls[0].metadata.type).toBe("feature");
    expect(result.parsed?.addCalls[2].content).toBe("AI 技能沉淀");
    expect(result.parsed?.addCalls[3].metadata.mem_types).toEqual(["file_knowledge"]);
  });

  it("falls back to provider AI when opencode is unavailable", () => {
    const result = runScenario({ useProviderAI: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.result.usedAI).toBe(true);
    expect(result.parsed?.result.writtenMemoryIds.length).toBe(4);
    expect(result.parsed?.addCalls[1].metadata.type).toBe("verification");
    expect(result.parsed?.addCalls[1].metadata.mem_types).toEqual(["tool_trace"]);
    expect(result.parsed?.addCalls[1].content).toBe("Provider 工具轨迹沉淀");
    expect(result.parsed?.addCalls[3].metadata.mem_types).toEqual(["file_knowledge"]);
  });

  it("skips duplicate writeback for the same prompt", () => {
    const result = runScenario({ dedupe: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.result.skipped).toBe(true);
    expect(result.parsed?.addCalls).toEqual([]);
  });
});
