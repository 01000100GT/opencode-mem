const MAX_TOOL_INPUT_LENGTH = 160;
const MAX_TOOL_OUTPUT_LENGTH = 240;
const FILE_PATH_PATTERN =
  /(?:^|[\s"'`(])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|rs|vue|svelte|css|scss|html|yml|yaml|sql|sh))/g;
const TEST_PATTERN =
  /\b(bun test|npm test|pnpm test|yarn test|vitest|jest|mocha|pytest|cargo test|go test|ctest|playwright)\b/i;
const API_PATTERN =
  /\b(curl|http|https|api|endpoint|response|request|status|graphql|fetch|axios)\b/i;
const OBSERVATION_PATTERN =
  /\b(verified|passed|failed|working|works|rendered|healthy|success|error|warning|observed|stdout)\b/i;

export type EvidenceRecordType =
  | "command_output"
  | "test_result"
  | "api_response"
  | "runtime_observation";

export interface EvidenceRecord {
  type: EvidenceRecordType;
  title: string;
  payload: string;
  source: "assistant" | "tool" | "tool_result";
  toolName?: string;
}

import { redactEvidenceText } from "./evidence-redactor.js";

export interface ToolExecutionEvidence {
  name: string;
  input: string;
  output: string;
}

export interface SessionExecutionEvidence {
  assistantResponses: string[];
  toolExecutions: ToolExecutionEvidence[];
  toolResultTexts: string[];
  referencedFiles: string[];
  commandOutputs: EvidenceRecord[];
  testResults: EvidenceRecord[];
  apiResponses: EvidenceRecord[];
  runtimeObservations: EvidenceRecord[];
  evidenceItems: EvidenceRecord[];
}

export function extractSessionExecutionEvidence(
  messages: any[],
  promptMessageId: string
): SessionExecutionEvidence {
  const responseMessages = getResponseMessages(messages, promptMessageId);
  if (!responseMessages) {
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

  const assistantResponses: string[] = [];
  const toolExecutions: ToolExecutionEvidence[] = [];
  const toolResultTexts: string[] = [];
  const evidenceItems: EvidenceRecord[] = [];

  for (const msg of responseMessages) {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];

    if (msg.info?.role === "assistant") {
      const text = parts
        .filter((part: any) => part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text.trim())
        .filter(Boolean)
        .join("\n");
      if (text) {
        assistantResponses.push(redactEvidenceText(text));
      }

      for (const part of parts.filter((item: any) => item.type === "tool")) {
        const toolExecution = {
          name: normalizeToolName(part.tool),
          input: normalizeToolPayload(part.state?.input, MAX_TOOL_INPUT_LENGTH),
          output: normalizeToolPayload(
            part.state?.output ?? part.state?.result,
            MAX_TOOL_OUTPUT_LENGTH
          ),
        };
        toolExecutions.push(toolExecution);
        evidenceItems.push(buildToolEvidence(toolExecution));
      }
    }

    if (msg.info?.role === "tool") {
      const toolText = parts
        .filter((part: any) => part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text.trim())
        .filter(Boolean)
        .join("\n");
      if (toolText) {
        const payload = redactEvidenceText(truncate(toolText, MAX_TOOL_OUTPUT_LENGTH));
        toolResultTexts.push(payload);
        evidenceItems.push(buildToolResultEvidence(payload));
      }
    }
  }

  const referencedFiles = collectReferencedFiles([
    ...assistantResponses,
    ...toolExecutions.flatMap((tool) => [tool.input, tool.output]),
    ...toolResultTexts,
  ]);

  const normalizedEvidence = dedupeEvidenceItems(evidenceItems);
  const grouped = groupEvidenceByType(normalizedEvidence);

  return {
    assistantResponses: uniqueStrings(assistantResponses),
    toolExecutions: dedupeToolExecutions(toolExecutions),
    toolResultTexts: uniqueStrings(toolResultTexts),
    referencedFiles,
    commandOutputs: grouped.command_output,
    testResults: grouped.test_result,
    apiResponses: grouped.api_response,
    runtimeObservations: grouped.runtime_observation,
    evidenceItems: normalizedEvidence,
  };
}

function getResponseMessages(messages: any[], promptMessageId: string): any[] | null {
  const promptIndex = messages.findIndex((message: any) => message.info?.id === promptMessageId);
  if (promptIndex === -1) {
    return null;
  }

  const responseMessages: any[] = [];
  for (const message of messages.slice(promptIndex + 1)) {
    if (message.info?.role === "user") {
      break;
    }
    responseMessages.push(message);
  }

  return responseMessages;
}

function normalizeToolName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : "";
  return name || "unknown";
}

function normalizeToolPayload(input: unknown, maxLength: number): string {
  if (typeof input === "string") {
    return redactEvidenceText(truncate(input.trim(), maxLength));
  }

  if (!input || typeof input !== "object") {
    return "";
  }

  try {
    return redactEvidenceText(truncate(JSON.stringify(input), maxLength));
  } catch {
    return "";
  }
}

function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }

  return `${input.slice(0, maxLength - 3).trim()}...`;
}

function collectReferencedFiles(chunks: string[]): string[] {
  const results = new Set<string>();

  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }

    for (const match of chunk.matchAll(FILE_PATH_PATTERN)) {
      const file = match[1]?.trim();
      if (file) {
        results.add(file);
      }
    }
  }

  return [...results];
}

function dedupeToolExecutions(items: ToolExecutionEvidence[]): ToolExecutionEvidence[] {
  const seen = new Set<string>();
  const results: ToolExecutionEvidence[] = [];

  for (const item of items) {
    const key = `${item.name}:${item.input}:${item.output}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(item);
  }

  return results;
}

function buildToolEvidence(tool: ToolExecutionEvidence): EvidenceRecord {
  const combined = `${tool.name} ${tool.input} ${tool.output}`.trim();
  const type = inferEvidenceType(combined, tool.name);
  return {
    type,
    title: buildEvidenceTitle(type, tool.name),
    payload: [tool.input ? `input=${tool.input}` : "", tool.output ? `output=${tool.output}` : ""]
      .filter(Boolean)
      .join(" "),
    source: "tool",
    toolName: tool.name,
  };
}

function buildToolResultEvidence(payload: string): EvidenceRecord {
  const inferred = inferEvidenceType(payload, "tool_result");
  return {
    type: inferred,
    title: buildEvidenceTitle(inferred, "tool_result"),
    payload: redactEvidenceText(payload),
    source: "tool_result",
  };
}

function inferEvidenceType(text: string, toolName?: string): EvidenceRecordType {
  const source = `${toolName || ""} ${text}`.trim();
  if (TEST_PATTERN.test(source)) {
    return "test_result";
  }
  if (API_PATTERN.test(source)) {
    return "api_response";
  }
  if (OBSERVATION_PATTERN.test(source) && !toolName) {
    return "runtime_observation";
  }
  return "command_output";
}

function buildEvidenceTitle(type: EvidenceRecordType, toolName: string): string {
  switch (type) {
    case "test_result":
      return `Test result via ${toolName}`;
    case "api_response":
      return `API response via ${toolName}`;
    case "runtime_observation":
      return `Runtime observation via ${toolName}`;
    default:
      return `Command output via ${toolName}`;
  }
}

function dedupeEvidenceItems(items: EvidenceRecord[]): EvidenceRecord[] {
  const seen = new Set<string>();
  const results: EvidenceRecord[] = [];

  for (const item of items) {
    const key = `${item.type}:${item.title}:${item.payload}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(item);
  }

  return results;
}

function groupEvidenceByType(
  items: EvidenceRecord[]
): Record<EvidenceRecordType, EvidenceRecord[]> {
  return {
    command_output: items.filter((item) => item.type === "command_output"),
    test_result: items.filter((item) => item.type === "test_result"),
    api_response: items.filter((item) => item.type === "api_response"),
    runtime_observation: items.filter((item) => item.type === "runtime_observation"),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
