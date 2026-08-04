import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const autoCaptureUrl = new URL("../src/services/auto-capture.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const languageUrl = new URL("../src/services/language-detector.js", import.meta.url).href;
const opencodeProviderLoaderUrl = new URL(
  "../src/services/ai/opencode-provider-loader.js",
  import.meta.url
).href;
const aiProviderFactoryUrl = new URL("../src/services/ai/ai-provider-factory.js", import.meta.url)
  .href;
const providerConfigUrl = new URL("../src/services/ai/provider-config.js", import.meta.url).href;

type ScenarioOptions = {
  providerMode?: "opencode" | "manual";
  structuredOutput?: Record<string, unknown>;
  manualResult?: Record<string, unknown>;
};

function runScenario(options: ScenarioOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-auto-capture-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const providerMode = options.providerMode ?? "opencode";
  const structuredOutput =
    options.structuredOutput ??
    ({
      summary: "summary-default",
      type: "discussion",
      tags: [],
      mem_types: [],
      entities: [],
      constraint_kinds: [],
      decision_tags: [],
    } satisfies Record<string, unknown>);
  const manualResult = options.manualResult ?? structuredOutput;

  const script = `
import { mock } from "bun:test";

const prompts = [
  {
    id: "prompt-1",
    sessionId: "session-1",
    messageId: "msg-1",
    projectPath: "/workspace",
    content: "First request",
    createdAt: 1,
    captured: false,
    claimed: false,
    capture_attempts: 0,
  },
  {
    id: "prompt-2",
    sessionId: "session-1",
    messageId: "msg-2",
    projectPath: "/workspace",
    content: "Second request",
    createdAt: 2,
    captured: false,
    claimed: false,
    capture_attempts: 0,
  },
];
const addCalls = [];
const summaryPrompts = [];
let manualCallCount = 0;

function pendingForSession(sessionId) {
  return prompts
    .filter((prompt) => prompt.sessionId === sessionId && !prompt.captured && !prompt.claimed)
    .sort((a, b) => a.createdAt - b.createdAt);
}

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureMaxRetries: 1,
    autoCaptureProviderStatus: { ready: true, mode: ${JSON.stringify(providerMode)}, issues: [] },
    autoCaptureLanguage: "en",
    opencodeProvider: ${providerMode === "opencode" ? '"openai"' : "undefined"},
    opencodeModel: ${providerMode === "opencode" ? '"gpt-test"' : "undefined"},
    memoryProvider: "openai-chat",
    memoryModel: ${providerMode === "manual" ? '"gpt-fallback"' : "undefined"},
    memoryApiUrl: ${providerMode === "manual" ? '"https://api.test/v1"' : "undefined"},
    memoryApiKey: ${providerMode === "manual" ? '"test-key"' : "undefined"},
    showAutoCaptureToasts: false,
    showErrorToasts: false,
  },
}));

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    listMemories: async () => ({ success: true, memories: [] }),
    addMemory: async (content, _tag, metadata) => {
      addCalls.push({ content, metadata });
      return { success: true, id: \`mem-\${addCalls.length}\` };
    },
    close() {},
  },
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    project: {
      tag: "opencode_project_test",
      displayName: "Test Project",
      userName: "Test User",
      userEmail: "test@example.com",
      projectPath: "/workspace",
      projectName: "workspace",
      gitRepoUrl: undefined,
    },
  }),
}));

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    getLastUncapturedPrompt(sessionId) {
      return [...pendingForSession(sessionId)].pop() ?? null;
    },
    getUncapturedPromptsForSession(sessionId) {
      return pendingForSession(sessionId);
    },
    claimPrompt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (!prompt || prompt.captured || prompt.claimed) return false;
      prompt.claimed = true;
      return true;
    },
    recordFailedAttempt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) prompt.capture_attempts += 1;
    },
    releaseClaim(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (!prompt || !prompt.claimed || prompt.captured) return false;
      prompt.claimed = false;
      return true;
    },
    linkMemoryToPrompt(id, memoryId) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) prompt.linkedMemoryId = memoryId;
    },
    markAsCaptured(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) {
        prompt.captured = true;
        prompt.claimed = false;
      }
    },
    deletePrompt(id) {
      const prompt = prompts.find((item) => item.id === id);
      if (prompt) {
        prompt.captured = true;
        prompt.claimed = false;
        prompt.deleted = true;
      }
    },
  },
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: () => {},
  isDiagEnabled: () => false,
  diagWarn: () => {},
}));
mock.module(${JSON.stringify(languageUrl)}, () => ({
  detectLanguage: () => "en",
  getLanguageName: () => "English",
}));
mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    isProviderConnected: () => true,
    getV2Client: () => ({}),
    generateStructuredOutput: async ({ userPrompt }) => {
      summaryPrompts.push(userPrompt);
      return ${JSON.stringify(structuredOutput)};
    },
  }),
}));
mock.module(${JSON.stringify(aiProviderFactoryUrl)}, () => ({
  AIProviderFactory: {
    createProvider: () => ({
      executeToolCall: async () => {
        manualCallCount += 1;
        return { success: true, data: ${JSON.stringify(manualResult)} };
      },
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

const { performAutoCapture } = await import(${JSON.stringify(autoCaptureUrl)});
await performAutoCapture(
  {
    client: {
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg-1", role: "user" }, parts: [{ type: "text", text: "First request" }] },
            { info: { id: "assistant-1", role: "assistant" }, parts: [{ type: "text", text: "First response" }] },
            { info: { id: "msg-2", role: "user" }, parts: [{ type: "text", text: "Second request" }] },
            { info: { id: "assistant-2", role: "assistant" }, parts: [{ type: "text", text: "Second response" }] },
          ],
        }),
      },
      tui: { showToast: async () => ({}) },
    },
  },
  "session-1",
  "/workspace"
);

console.log(
  JSON.stringify({
    addPromptIds: addCalls.map((call) => call.metadata.promptId),
    summaries: addCalls.map((call) => call.content),
    metadataSnapshots: addCalls.map((call) => ({
      memTypes: call.metadata.mem_types,
      entities: call.metadata.entities,
      constraintKinds: call.metadata.constraint_kinds,
      decisionTags: call.metadata.decision_tags,
    })),
    manualCallCount,
    summaryPrompts,
  })
);
`;

  writeFileSync(scriptPath, script);

  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(result.stdout).toString("utf8").trim();
  const stderr = Buffer.from(result.stderr).toString("utf8").trim();

  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    parsed: stdout ? JSON.parse(stdout) : null,
  };
}

describe("auto-capture idle processing", () => {
  it("captures mem_types and entities from the opencode structured-output path", () => {
    const result = runScenario({
      providerMode: "opencode",
      structuredOutput: {
        summary: "summary-opencode",
        type: "discussion",
        tags: ["SQLite", "Rust"],
        mem_types: ["experience", "skill", "invalid"],
        entities: [
          { entity: "SQLite", entity_type: "Library" },
          { entity: "Rust", entity_type: "Technology" },
          { entity: "Ignored", entity_type: "Unknown" },
        ],
        constraint_kinds: ["preserve_db_schema", "minimize_change", "invalid"],
        decision_tags: ["architecture_boundary", "scope_control", "invalid"],
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.addPromptIds).toEqual(["prompt-1", "prompt-2"]);
    expect(result.parsed?.summaries).toEqual([
      "summary-opencode\n\nTags: sqlite, rust",
      "summary-opencode\n\nTags: sqlite, rust",
    ]);
    expect(result.parsed?.metadataSnapshots).toEqual([
      {
        memTypes: ["experience", "skill"],
        entities: [
          { entity: "SQLite", entity_type: "Library" },
          { entity: "Rust", entity_type: "Technology" },
        ],
        constraintKinds: ["preserve_db_schema", "minimize_change"],
        decisionTags: ["architecture_boundary", "scope_control"],
      },
      {
        memTypes: ["experience", "skill"],
        entities: [
          { entity: "SQLite", entity_type: "Library" },
          { entity: "Rust", entity_type: "Technology" },
        ],
        constraintKinds: ["preserve_db_schema", "minimize_change"],
        decisionTags: ["architecture_boundary", "scope_control"],
      },
    ]);
    expect(result.parsed?.manualCallCount).toBe(0);
    expect(result.parsed?.summaryPrompts[0]).toContain("First response");
    expect(result.parsed?.summaryPrompts[0]).not.toContain("Second response");
    expect(result.parsed?.summaryPrompts[1]).toContain("Second response");
  });

  it("supports the manual fallback path and degrades invalid cognitive fields to empty arrays", () => {
    const result = runScenario({
      providerMode: "manual",
      manualResult: {
        summary: "summary-manual",
        type: "discussion",
        tags: [],
        mem_types: ["bogus"],
        entities: [
          { entity: "", entity_type: "Library" },
          { entity: "UnknownNode", entity_type: "Unknown" },
        ],
        constraint_kinds: ["not-real"],
        decision_tags: ["not-real"],
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.addPromptIds).toEqual(["prompt-1", "prompt-2"]);
    expect(result.parsed?.metadataSnapshots).toEqual([
      { memTypes: [], entities: [], constraintKinds: [], decisionTags: [] },
      { memTypes: [], entities: [], constraintKinds: [], decisionTags: [] },
    ]);
    expect(result.parsed?.manualCallCount).toBe(2);
    expect(result.parsed?.summaryPrompts).toEqual([]);
  });
});
