import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
const contextUrl = new URL("../src/services/context.js", import.meta.url).href;
const configUrl = new URL("../src/config.js", import.meta.url).href;
const profileContextUrl = new URL(
  "../src/services/user-profile/profile-context.js",
  import.meta.url
).href;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runScenario() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-mem-context-taskbrief-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");

  const script = `
import { mock } from "bun:test";

mock.module(${JSON.stringify(configUrl)}, () => ({
  CONFIG: {
    injectProfile: false,
  },
}));

mock.module(${JSON.stringify(profileContextUrl)}, () => ({
  getUserProfileContext: () => "",
}));

const { formatContextForPrompt } = await import(${JSON.stringify(contextUrl)});
const rendered = formatContextForPrompt(
  null,
  {
    results: [{ similarity: 1, memory: "历史记忆内容" }],
  },
  {
    taskGoal: "实现 task brief 自动注入",
    relatedFiles: ["src/index.ts"],
    relatedSymbols: ["chat.message"],
    historicalDecisions: ["保持最小改动"],
    constraintKinds: ["preserve_db_schema"],
    constraints: ["不修改数据库结构"],
    userPreferences: ["外科手术式修改"],
    risks: ["避免污染当前会话"],
    successCriteria: ["注入结构化 brief"],
  }
);

console.log(JSON.stringify({ rendered }));
`;

  writeFileSync(scriptPath, script, "utf-8");
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
    parsed: JSON.parse(Buffer.from(result.stdout).toString("utf8").trim()),
  };
}

describe("context task brief formatting", () => {
  it("renders task brief alongside project knowledge", () => {
    const result = runScenario();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.parsed.rendered).toContain("<task_brief>");
    expect(result.parsed.rendered).toContain("Task Goal: 实现 task brief 自动注入");
    expect(result.parsed.rendered).toContain("Related Files: src/index.ts");
    expect(result.parsed.rendered).toContain("Constraints:");
    expect(result.parsed.rendered).toContain("不修改数据库结构");
    expect(result.parsed.rendered).toContain("<project_knowledge>");
    expect(result.parsed.rendered).toContain("历史记忆内容");
  });
});
