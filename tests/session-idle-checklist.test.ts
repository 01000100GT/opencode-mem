import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const indexUrl = new URL("../src/index.js", import.meta.url).href;
const clientUrl = new URL("../src/services/client.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const tagsUrl = new URL("../src/services/tags.js", import.meta.url).href;
const contextUrl = new URL("../src/services/context.js", import.meta.url).href;
const privacyUrl = new URL("../src/services/privacy.js", import.meta.url).href;
const autoCaptureUrl = new URL("../src/services/auto-capture.js", import.meta.url).href;
const learningUrl = new URL("../src/services/user-memory-learning.js", import.meta.url).href;
const promptManagerUrl = new URL(
  "../src/services/user-prompt/user-prompt-manager.js",
  import.meta.url
).href;
const webServerUrl = new URL("../src/services/web-server.js", import.meta.url).href;
const loggerUrl = new URL("../src/services/logger.js", import.meta.url).href;
const languageUrl = new URL("../src/services/language-detector.js", import.meta.url).href;
const taskSupportUrl = new URL("../src/services/task-support.js", import.meta.url).href;
const completionWritebackUrl = new URL("../src/services/completion-writeback.js", import.meta.url)
  .href;
const completionGateAdvisorUrl = new URL(
  "../src/services/completion-gate-advisor.js",
  import.meta.url
).href;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runScenario() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-idle-checklist-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const logCalls = [];
let taskSupportArgs = null;
let promptPayload = null;
let autoCaptureCallCount = 0;
let writebackArgs = null;

globalThis.__idlePromise = null;
globalThis.setTimeout = (fn) => {
  const result = fn();
  globalThis.__idlePromise = result;
  return 1;
};
globalThis.clearTimeout = () => {};

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => {},
    isReady: async () => true,
    close() {},
  },
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    autoCaptureEnabled: false,
    autoCaptureLanguage: "auto",
    showErrorToasts: false,
    memory: { defaultScope: "project" },
    chatMessage: {
      enabled: true,
      injectOn: "always",
      maxMemories: 3,
      excludeCurrentSession: false,
      maxAgeDays: undefined,
    },
    compaction: { enabled: false, memoryLimit: 5 },
  },
  initConfig: () => {},
  isConfigured: () => true,
  getAutoCaptureProviderStatus: () => ({ ready: false, issues: [] }),
}));

mock.module(${JSON.stringify(tagsUrl)}, () => ({
  getTags: () => ({
    project: { tag: "project-tag" },
    user: { userEmail: "u@example.com" },
  }),
}));

mock.module(${JSON.stringify(contextUrl)}, () => ({
  formatContextForPrompt: () => "<memory_context />",
}));

mock.module(${JSON.stringify(privacyUrl)}, () => ({
  stripPrivateContent: (value) => value,
  isFullyPrivate: () => false,
}));

mock.module(${JSON.stringify(autoCaptureUrl)}, () => ({
  performAutoCapture: async () => {
    autoCaptureCallCount += 1;
  },
}));

mock.module(${JSON.stringify(learningUrl)}, () => ({
  performUserProfileLearning: async () => {},
}));

mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    getLastUncapturedPrompt: () => ({
      id: "prompt-1",
      messageId: "prompt-message-1",
      content: "请给这次实现补验证清单",
    }),
  },
}));

mock.module(${JSON.stringify(taskSupportUrl)}, () => ({
  generateTaskSupport: async (args) => {
    taskSupportArgs = args;
    if (args.mode === "brief") {
      return {
        success: true,
        mode: "brief",
        task: args.task,
        scope: args.scope,
        usedAI: true,
        memoriesConsidered: 2,
        memoryRefs: [{ id: "mem-1", summary: "历史约束线索", memTypes: [], entities: [] }],
        brief: {
          taskGoal: args.task,
          relatedFiles: ["src/index.ts"],
          relatedSymbols: ["session.idle"],
          historicalDecisions: ["保持最小改动"],
          constraintKinds: ["preserve_db_schema"],
          constraints: ["不修改数据库结构"],
          userPreferences: ["外科手术式修改"],
          risks: ["避免误判完成"],
          successCriteria: ["输出验证提示"],
        },
      };
    }
    return {
      success: true,
      mode: "checklist",
      task: args.task,
      scope: args.scope,
      usedAI: true,
      memoriesConsidered: 2,
      memoryRefs: [{ id: "mem-1", summary: "历史验证经验", memTypes: [], entities: [] }],
      checklist: {
        successCriteria: ["输出验证提示"],
        verificationHints: ["跑最小 smoke"],
        evidenceTemplates: [{ type: "test_result", title: "bun test", payload: "" }],
        remainingRisks: ["未覆盖全部边界场景"],
      },
    };
  },
}));

mock.module(${JSON.stringify(completionWritebackUrl)}, () => ({
  writeCompletionChecklistMemories: async (args) => {
    writebackArgs = args;
    return {
      success: true,
      skipped: false,
      usedAI: true,
      drafts: [
        {
          mem_type: "skill",
          content: "复用验证流程",
          tags: ["workflow"],
          entities: [],
        },
      ],
      writtenMemoryIds: ["mem-writeback-1"],
    };
  },
}));

mock.module(${JSON.stringify(completionGateAdvisorUrl)}, () => ({
  generateCompletionGateSuggestion: async (args) => ({
    success: true,
    usedAI: true,
    suggestion: {
      status: "partial",
      criteria_check: [
        {
          criteria: "输出验证提示",
          status: "unknown",
          reason: "缺少直接映射证据",
          evidenceTypes: ["test_result"],
        },
      ],
      constraint_check: [
        {
          constraint: args.constraints?.[0] || "不修改数据库结构",
          status: "pass",
          reason: "未发现 schema 相关变更信号",
        },
      ],
      summary: "建议状态 partial",
      next_actions: ["补充针对 success criteria 的 API 验证证据"],
    },
  }),
}));

mock.module(${JSON.stringify(webServerUrl)}, () => ({
  startWebServer: async () => ({ isServerOwner: () => false }),
  WebServer: class {},
}));

mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: (message, data) => {
    logCalls.push({ message, data });
  },
  isDiagEnabled: () => false,
  diagLog: () => {},
}));

mock.module(${JSON.stringify(languageUrl)}, () => ({
  getLanguageName: () => "English",
}));

const { OpenCodeMemPlugin } = await import(${JSON.stringify(indexUrl)});
const plugin = await OpenCodeMemPlugin({
  directory: "/workspace",
  client: {
    provider: { list: async () => ({ data: { connected: [] } }) },
    session: {
      messages: async () => ({
        data: [
          {
            info: { id: "prompt-message-1", role: "user" },
            parts: [{ type: "text", text: "请给这次实现补验证清单" }],
          },
          {
            info: { id: "assistant-1", role: "assistant" },
            parts: [
              { type: "text", text: "我先检查 src/index.ts 并执行 bun test。" },
              {
                type: "tool",
                tool: "bun_test",
                state: {
                  input: { command: "bun test tests/session-idle-checklist.test.ts" },
                  output: "1 passed",
                },
              },
              {
                type: "tool",
                tool: "pytest",
                state: {
                  input: { command: "pytest -q" },
                  output: "1 passed",
                },
              },
            ],
          },
          {
            info: { id: "tool-1", role: "tool" },
            parts: [{ type: "text", text: "stdout: src/index.ts verified" }],
          },
        ],
      }),
      prompt: async (payload) => {
        promptPayload = payload;
      },
    },
    tui: null,
  },
  serverUrl: new URL("http://localhost:4096"),
});

await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
await globalThis.__idlePromise;

console.log(
  JSON.stringify({
    taskSupportArgs,
    writebackArgs,
    promptPayload,
    autoCaptureCallCount,
    logCalls,
  })
);
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

describe("session.idle checklist injection", () => {
  it("injects completion checklist and logs results even when auto-capture is disabled", () => {
    const result = runScenario();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.autoCaptureCallCount).toBe(0);
    expect(result.parsed?.taskSupportArgs?.mode).toBe("checklist");
    expect(result.parsed?.taskSupportArgs?.task).toBe("请给这次实现补验证清单");
    expect(result.parsed?.writebackArgs?.promptId).toBe("prompt-1");
    expect(result.parsed?.writebackArgs?.checklist?.successCriteria).toEqual(["输出验证提示"]);
    expect(result.parsed?.writebackArgs?.constraintKinds).toContain("preserve_db_schema");
    expect(result.parsed?.writebackArgs?.evidence?.toolExecutions?.[0]?.name).toBe("bun_test");
    expect(result.parsed?.writebackArgs?.evidence?.referencedFiles).toContain("src/index.ts");
    expect(result.parsed?.writebackArgs?.evidence?.testResults?.[0]?.type).toBe("test_result");
    expect(result.parsed?.promptPayload?.body?.parts?.[0]?.text).toContain(
      "<completion_checklist>"
    );
    expect(result.parsed?.promptPayload?.body?.parts?.[0]?.text).toContain("输出验证提示");
    expect(result.parsed?.promptPayload?.body?.parts?.[0]?.text).toContain("Evidence Coverage:");
    expect(result.parsed?.promptPayload?.body?.parts?.[0]?.text).toContain("[hit] [test_result]");
    expect(result.parsed?.promptPayload?.body?.parts?.[0]?.text).toContain(
      "Test result via bun_test"
    );
    expect(result.parsed?.promptPayload?.body?.parts?.[0]?.text).toContain(
      "<completion_gate_suggestion>"
    );
    expect(result.parsed?.promptPayload?.body?.parts?.[0]?.text).toContain("status: partial");
    expect(result.parsed?.promptPayload?.body?.parts?.[0]?.text).toContain(
      "不修改数据库结构: pass"
    );
    expect(
      result.parsed?.logCalls.some(
        (entry: any) => entry.message === "session.idle checklist generated"
      )
    ).toBe(true);
    expect(
      result.parsed?.logCalls.some(
        (entry: any) => entry.message === "session.idle checklist injected"
      )
    ).toBe(true);
    expect(
      result.parsed?.logCalls.some(
        (entry: any) => entry.message === "session.idle execution evidence"
      )
    ).toBe(true);
    expect(
      result.parsed?.logCalls.some(
        (entry: any) => entry.message === "session.idle evidence template coverage"
      )
    ).toBe(true);
    expect(
      result.parsed?.logCalls.some(
        (entry: any) => entry.message === "session.idle completion gate suggestion"
      )
    ).toBe(true);
    expect(
      result.parsed?.logCalls.some(
        (entry: any) => entry.message === "session.idle checklist writeback"
      )
    ).toBe(true);
  });
});
