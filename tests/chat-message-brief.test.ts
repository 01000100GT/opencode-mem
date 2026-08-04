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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runScenario() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-chat-brief-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

const logCalls = [];
let formatArgs = null;
let taskSupportArgs = null;

mock.module(${JSON.stringify(clientUrl)}, () => ({
  memoryClient: {
    warmup: async () => {},
    listMemories: async () => ({
      success: true,
      memories: [
        {
          id: "mem-1",
          summary: "历史记忆：auto-capture 需要最小化修改。",
          createdAt: new Date().toISOString(),
          metadata: {},
        },
      ],
      pagination: { currentPage: 1, totalItems: 1, totalPages: 1 },
    }),
    close() {},
  },
}));

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
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
  formatContextForPrompt: (_userId, projectMemories, taskBrief) => {
    formatArgs = { projectCount: projectMemories.results?.length ?? 0, taskBrief };
    return \`<memory_context><task_brief>\${taskBrief?.taskGoal}</task_brief><count>\${projectMemories.results?.length ?? 0}</count></memory_context>\`;
  },
}));

mock.module(${JSON.stringify(privacyUrl)}, () => ({
  stripPrivateContent: (value) => value,
  isFullyPrivate: () => false,
}));
mock.module(${JSON.stringify(autoCaptureUrl)}, () => ({ performAutoCapture: async () => {} }));
mock.module(${JSON.stringify(learningUrl)}, () => ({ performUserProfileLearning: async () => {} }));
mock.module(${JSON.stringify(promptManagerUrl)}, () => ({
  userPromptManager: {
    savePrompt: () => {},
    setPromptModel: () => {},
  },
}));
mock.module(${JSON.stringify(taskSupportUrl)}, () => ({
  generateTaskSupport: async (args) => {
    taskSupportArgs = args;
    return {
      success: true,
      mode: "brief",
      task: args.task,
      scope: args.scope,
      usedAI: false,
      memoriesConsidered: 1,
      memoryRefs: [{ id: "mem-ref-1", summary: "历史 brief 线索", memTypes: [], entities: [] }],
      brief: {
        taskGoal: "为编码前自动注入 task brief",
        relatedFiles: ["src/index.ts"],
        relatedSymbols: ["chat.message"],
        historicalDecisions: ["保持最小改动"],
        constraintKinds: ["preserve_db_schema"],
        constraints: ["不修改数据库结构"],
        userPreferences: ["外科手术式修改"],
        risks: ["避免污染当前会话"],
        successCriteria: ["注入结构化 brief"],
      },
    };
  },
}));
mock.module(${JSON.stringify(webServerUrl)}, () => ({
  startWebServer: async () => null,
  WebServer: class {},
}));
mock.module(${JSON.stringify(loggerUrl)}, () => ({
  log: (message, data) => {
    logCalls.push({ message, data });
  },
  isDiagEnabled: () => false,
  diagLog: () => {},
}));
mock.module(${JSON.stringify(languageUrl)}, () => ({ getLanguageName: () => "English" }));

const { OpenCodeMemPlugin } = await import(${JSON.stringify(indexUrl)});
const plugin = await OpenCodeMemPlugin({
  directory: "/workspace",
  client: {
    provider: { list: async () => ({ data: { connected: [] } }) },
    session: { messages: async () => ({ data: [] }) },
    tui: null,
  },
  serverUrl: new URL("http://localhost:4096"),
});

const hook = plugin["chat.message"];
if (typeof hook !== "function") {
  throw new Error("chat.message hook not available");
}

const output = {
  message: { id: "msg-out-1" },
  parts: [{ type: "text", text: "把 brief 接到 prompt 注入链路里" }],
};

await hook({ sessionID: "session-1" }, output);

console.log(
  JSON.stringify({
    firstPartText: output.parts[0]?.text,
    firstPartSynthetic: output.parts[0]?.synthetic,
    formatArgs,
    taskSupportArgs,
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

describe("chat.message task brief injection", () => {
  it("injects task brief context before prompt execution and logs the result", () => {
    const result = runScenario();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed?.firstPartText).toContain(
      "<task_brief>为编码前自动注入 task brief</task_brief>"
    );
    expect(result.parsed?.firstPartSynthetic).toBe(true);
    expect(result.parsed?.formatArgs?.taskBrief?.taskGoal).toBe("为编码前自动注入 task brief");
    expect(result.parsed?.formatArgs?.projectCount).toBe(1);
    expect(result.parsed?.taskSupportArgs?.mode).toBe("brief");
    expect(result.parsed?.taskSupportArgs?.task).toBe("把 brief 接到 prompt 注入链路里");
    expect(
      result.parsed?.logCalls.some((entry: any) => entry.message === "chat.message brief generated")
    ).toBe(true);
    expect(
      result.parsed?.logCalls.some(
        (entry: any) => entry.message === "chat.message context prepared"
      )
    ).toBe(true);
  });
});
