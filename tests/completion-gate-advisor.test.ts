import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const advisorUrl = new URL("../src/services/completion-gate-advisor.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const opencodeProviderLoaderUrl = new URL(
  "../src/services/ai/opencode-provider-loader.js",
  import.meta.url
).href;
const profileLlmClientUrl = new URL("../src/services/ai/profile-llm-client.js", import.meta.url)
  .href;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type ScenarioOptions = {
  useOpencodeAI?: boolean;
};

function runScenario(options: ScenarioOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-gate-advisor-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  const useOpencodeAI = options.useOpencodeAI ?? false;

  const script = `
import { mock } from "bun:test";

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    opencodeProvider: ${useOpencodeAI ? '"openai"' : "undefined"},
    opencodeModel: ${useOpencodeAI ? '"gpt-test"' : "undefined"},
    memoryProvider: "openai-chat",
    memoryModel: undefined,
    memoryApiUrl: undefined,
    memoryApiKey: undefined,
  },
}));

mock.module(${JSON.stringify(opencodeProviderLoaderUrl)}, () => ({
  loadOpencodeProvider: async () => ({
    generateStructuredOutput: async () => ({
      status: "partial",
      criteria_check: [
        {
          criteria: "API 返回 200",
          status: "unknown",
          reason: "missing api_response evidence",
          evidenceTypes: ["api_response"],
        },
      ],
      constraint_check: [],
      summary: "AI suggestion",
      next_actions: ["collect api_response evidence"],
    }),
  }),
}));

mock.module(${JSON.stringify(profileLlmClientUrl)}, () => ({
  getOpenCodeClient: async () => ({}),
}));

const { generateCompletionGateSuggestion } = await import(${JSON.stringify(advisorUrl)});
const result = await generateCompletionGateSuggestion({
  task: "修复登录 BUG",
  sessionID: "session-1",
  checklist: {
    successCriteria: ["API 返回 200"],
    verificationHints: [],
    evidenceTemplates: [{ type: "api_response", title: "GET /api/login", payload: "" }],
    remainingRisks: [],
  },
  evidence: {
    assistantResponses: [],
    toolExecutions: [],
    toolResultTexts: [],
    referencedFiles: [],
    commandOutputs: [],
    testResults: [],
    apiResponses: [],
    runtimeObservations: [],
    evidenceItems: [],
  },
  constraints: ["不修改数据库结构"],
});

console.log(JSON.stringify(result));
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

describe("completion gate advisor", () => {
  it("uses opencode AI when available", () => {
    const result = runScenario({ useOpencodeAI: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.usedAI).toBe(true);
    expect(result.parsed?.suggestion?.status).toBe("partial");
    expect(result.parsed?.suggestion?.criteria_check?.[0]?.criteria).toBe("API 返回 200");
  });

  it("falls back to blocked when no evidence and no AI", () => {
    const result = runScenario({ useOpencodeAI: false });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.usedAI).toBe(false);
    expect(result.parsed?.suggestion?.status).toBe("blocked");
  });

  it("evaluates schema constraint conservatively in fallback mode", () => {
    const result = runScenario({ useOpencodeAI: false });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.suggestion?.constraint_check?.[0]?.constraint).toBe("不修改数据库结构");
    expect(result.parsed?.suggestion?.constraint_check?.[0]?.status).toBe("unknown");
  });
});
