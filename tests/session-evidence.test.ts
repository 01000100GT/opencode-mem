import { describe, expect, it } from "bun:test";
import { extractSessionExecutionEvidence } from "../src/services/session-evidence.js";

describe("session execution evidence extraction", () => {
  it("extracts assistant text, tool executions, tool outputs, and referenced files", () => {
    const evidence = extractSessionExecutionEvidence(
      [
        {
          info: { id: "prompt-1", role: "user" },
          parts: [{ type: "text", text: "帮我补验证闭环" }],
        },
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [
            { type: "text", text: "我会先检查 src/index.ts。OPENAI_API_KEY=sk-1234567890" },
            {
              type: "tool",
              tool: "bun_test",
              state: {
                input: { command: "bun test tests/session-idle-checklist.test.ts" },
                output: "1 passed OPENAI_API_KEY=sk-1234567890",
              },
            },
          ],
        },
        {
          info: { id: "tool-1", role: "tool" },
          parts: [{ type: "text", text: "stdout: src/index.ts verified" }],
        },
        {
          info: { id: "next-user", role: "user" },
          parts: [{ type: "text", text: "下一步" }],
        },
      ],
      "prompt-1"
    );

    expect(evidence.assistantResponses[0]).toContain("src/index.ts");
    expect(evidence.toolExecutions[0]).toEqual({
      name: "bun_test",
      input: '{"command":"bun test tests/session-idle-checklist.test.ts"}',
      output: "1 passed OPENAI_API_KEY=****",
    });
    expect(evidence.toolResultTexts[0]).toContain("src/index.ts verified");
    expect(evidence.referencedFiles).toContain("src/index.ts");
    expect(evidence.referencedFiles).toContain("tests/session-idle-checklist.test.ts");
    expect(evidence.testResults[0]).toEqual({
      type: "test_result",
      title: "Test result via bun_test",
      payload:
        'input={"command":"bun test tests/session-idle-checklist.test.ts"} output=1 passed OPENAI_API_KEY=****',
      source: "tool",
      toolName: "bun_test",
    });
    expect(evidence.assistantResponses[0]).toContain("OPENAI_API_KEY=****");
    expect(evidence.runtimeObservations).toEqual([]);
    expect(evidence.commandOutputs[0]).toEqual({
      type: "command_output",
      title: "Command output via tool_result",
      payload: "stdout: src/index.ts verified",
      source: "tool_result",
    });
    expect(evidence.evidenceItems).toHaveLength(2);
  });
});
