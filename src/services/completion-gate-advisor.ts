import { CONFIG } from "../config.js";
import type { CompletionChecklist } from "./task-support.js";
import type { EvidenceRecordType, SessionExecutionEvidence } from "./session-evidence.js";
import { loadOpencodeProvider } from "./ai/opencode-provider-loader.js";
import { getOpenCodeClient } from "./ai/profile-llm-client.js";

export type CompletionGateStatus = "done" | "partial" | "blocked";
export type CheckStatus = "pass" | "fail" | "unknown";

export interface CriteriaCheck {
  criteria: string;
  status: CheckStatus;
  reason: string;
  evidenceTypes: EvidenceRecordType[];
}

export interface ConstraintCheck {
  constraint: string;
  status: CheckStatus;
  reason: string;
}

export interface CompletionGateSuggestion {
  status: CompletionGateStatus;
  criteria_check: CriteriaCheck[];
  constraint_check: ConstraintCheck[];
  summary: string;
  next_actions: string[];
}

export interface CompletionGateAdvisorRequest {
  task: string;
  sessionID: string;
  checklist: CompletionChecklist;
  evidence: SessionExecutionEvidence;
  constraints?: string[];
}

export async function generateCompletionGateSuggestion(
  request: CompletionGateAdvisorRequest
): Promise<{ success: boolean; usedAI: boolean; suggestion: CompletionGateSuggestion }> {
  const fallback = buildFallbackSuggestion(request);
  const aiSuggestion = await maybeGenerateWithAI(request, fallback);
  return {
    success: true,
    usedAI: !!aiSuggestion,
    suggestion: aiSuggestion ?? fallback,
  };
}

async function maybeGenerateWithAI(
  request: CompletionGateAdvisorRequest,
  fallback: CompletionGateSuggestion
): Promise<CompletionGateSuggestion | null> {
  const systemPrompt = `You are a completion-gate advisor. Your job is to assess success criteria and constraints based on execution evidence, then output a suggestion status.

Rules:
1. Return valid JSON only.
2. Do NOT claim final completion authority; this is a suggestion.
3. Use status: done | partial | blocked.
4. criteria_check/constraint_check must use status: pass | fail | unknown.
5. Stay grounded in evidence. If evidence is missing, use unknown instead of guessing.`;

  const userPrompt = `Task:
${request.task}

Success criteria:
${JSON.stringify(request.checklist.successCriteria || [], null, 2)}

Constraints:
${JSON.stringify(request.constraints || [], null, 2)}

Evidence templates:
${JSON.stringify(request.checklist.evidenceTemplates || [], null, 2)}

Typed evidence summary:
${JSON.stringify(
  {
    testResults: request.evidence.testResults,
    apiResponses: request.evidence.apiResponses,
    commandOutputs: request.evidence.commandOutputs,
    runtimeObservations: request.evidence.runtimeObservations,
  },
  null,
  2
)}

Fallback draft:
${JSON.stringify(fallback, null, 2)}

Return JSON with:
{
  "status": "done|partial|blocked",
  "criteria_check": [{"criteria": "...", "status": "pass|fail|unknown", "reason": "...", "evidenceTypes": ["test_result","command_output","api_response","runtime_observation"]}],
  "constraint_check": [{"constraint": "...", "status": "pass|fail|unknown", "reason": "..."}],
  "summary": "...",
  "next_actions": ["..."]
}`;

  const opencode = await tryGenerateWithOpencode(systemPrompt, userPrompt);
  if (opencode) {
    return opencode;
  }

  return tryGenerateWithProvider(systemPrompt, userPrompt, request);
}

async function tryGenerateWithOpencode(
  systemPrompt: string,
  userPrompt: string
): Promise<CompletionGateSuggestion | null> {
  if (!CONFIG.opencodeProvider || !CONFIG.opencodeModel) {
    return null;
  }

  try {
    const { generateStructuredOutput } = await loadOpencodeProvider();
    const { z } = await import("zod");
    const client = await getOpenCodeClient();

    const result = await generateStructuredOutput({
      client,
      providerID: CONFIG.opencodeProvider,
      modelID: CONFIG.opencodeModel,
      systemPrompt,
      userPrompt,
      schema: z.object({
        status: z.enum(["done", "partial", "blocked"]),
        criteria_check: z
          .array(
            z.object({
              criteria: z.string(),
              status: z.enum(["pass", "fail", "unknown"]),
              reason: z.string(),
              evidenceTypes: z
                .array(
                  z.enum(["test_result", "command_output", "api_response", "runtime_observation"])
                )
                .default([]),
            })
          )
          .default([]),
        constraint_check: z
          .array(
            z.object({
              constraint: z.string(),
              status: z.enum(["pass", "fail", "unknown"]),
              reason: z.string(),
            })
          )
          .default([]),
        summary: z.string(),
        next_actions: z.array(z.string()).default([]),
      }) as any,
    });

    return normalizeSuggestion(result as any);
  } catch {
    return null;
  }
}

async function tryGenerateWithProvider(
  systemPrompt: string,
  userPrompt: string,
  request: CompletionGateAdvisorRequest
): Promise<CompletionGateSuggestion | null> {
  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) {
    return null;
  }

  try {
    const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
    const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");
    const provider = AIProviderFactory.createProvider(
      CONFIG.memoryProvider,
      buildMemoryProviderConfig(CONFIG)
    );

    const result = await provider.executeToolCall(
      systemPrompt,
      userPrompt,
      {
        type: "function" as const,
        function: {
          name: "generate_completion_gate_suggestion",
          description: "Suggest completion status based on criteria, constraints and evidence",
          parameters: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["done", "partial", "blocked"] },
              criteria_check: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    criteria: { type: "string" },
                    status: { type: "string", enum: ["pass", "fail", "unknown"] },
                    reason: { type: "string" },
                    evidenceTypes: {
                      type: "array",
                      items: {
                        type: "string",
                        enum: [
                          "test_result",
                          "command_output",
                          "api_response",
                          "runtime_observation",
                        ],
                      },
                    },
                  },
                  required: ["criteria", "status", "reason", "evidenceTypes"],
                },
              },
              constraint_check: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    constraint: { type: "string" },
                    status: { type: "string", enum: ["pass", "fail", "unknown"] },
                    reason: { type: "string" },
                  },
                  required: ["constraint", "status", "reason"],
                },
              },
              summary: { type: "string" },
              next_actions: { type: "array", items: { type: "string" } },
            },
            required: ["status", "criteria_check", "constraint_check", "summary", "next_actions"],
          },
        },
      },
      request.sessionID
    );

    if (!result.success || !result.data) {
      return null;
    }

    return normalizeSuggestion(result.data as any);
  } catch {
    return null;
  }
}

function buildFallbackSuggestion(request: CompletionGateAdvisorRequest): CompletionGateSuggestion {
  const evidenceCounts = getEvidenceCounts(request.evidence);
  const hasAnyEvidence =
    evidenceCounts.test_result + evidenceCounts.command_output + evidenceCounts.api_response > 0;

  const criteria = request.checklist.successCriteria || [];
  const criteria_check = criteria.map((item) => buildFallbackCriteriaCheck(item, request.evidence));
  const constraint_check = (request.constraints || []).map((constraint) =>
    buildFallbackConstraintCheck(constraint, request.evidence)
  );

  const anyFail = criteria_check.some((item) => item.status === "fail");
  const anyUnknown =
    criteria_check.some((item) => item.status === "unknown") ||
    constraint_check.some((item) => item.status === "unknown");

  const status: CompletionGateStatus = !hasAnyEvidence
    ? "blocked"
    : anyFail
      ? "partial"
      : anyUnknown
        ? "partial"
        : "done";

  return {
    status,
    criteria_check,
    constraint_check,
    summary: `Suggestion based on evidence counts: ${JSON.stringify(evidenceCounts)}`,
    next_actions: buildFallbackNextActions(request, status),
  };
}

function buildFallbackConstraintCheck(
  constraint: string,
  evidence: SessionExecutionEvidence
): ConstraintCheck {
  const text = constraint.toLowerCase();
  const evidenceText = [
    ...evidence.referencedFiles,
    ...evidence.commandOutputs.map((item) => item.payload),
    ...evidence.apiResponses.map((item) => item.payload),
    ...evidence.testResults.map((item) => item.payload),
  ]
    .join("\n")
    .toLowerCase();

  if (/数据库结构|schema|migration|表结构/.test(text)) {
    if (
      /(migration|schema|create table|alter table|drop table|prisma|drizzle|typeorm|sequelize|\.sql\b)/.test(
        evidenceText
      )
    ) {
      return {
        constraint,
        status: "fail",
        reason: "Observed schema-related file or output in the evidence.",
      };
    }

    if (evidence.referencedFiles.length > 0 || evidence.commandOutputs.length > 0) {
      return {
        constraint,
        status: "pass",
        reason: "No schema-change indicators were found in referenced files or command outputs.",
      };
    }
  }

  if (/api|接口/.test(text)) {
    if (/(api|controller|route|endpoint|graphql)/.test(evidenceText)) {
      return {
        constraint,
        status: "unknown",
        reason: "API-related evidence exists, but it does not prove whether the interface changed.",
      };
    }
  }

  if (/ui|界面|页面|前端/.test(text)) {
    if (/\.(vue|tsx|jsx|html|css|scss)\b/.test(evidenceText)) {
      return {
        constraint,
        status: "unknown",
        reason: "UI-related evidence exists, but it does not prove whether the UI changed.",
      };
    }
  }

  if (/最小|minimal|外科手术式/.test(text)) {
    if (evidence.referencedFiles.length > 0 && evidence.referencedFiles.length <= 3) {
      return {
        constraint,
        status: "pass",
        reason: "Observed evidence references a small set of files only.",
      };
    }
  }

  return {
    constraint,
    status: "unknown",
    reason: "No constraint verification evidence recorded.",
  };
}

function buildFallbackCriteriaCheck(
  criteria: string,
  evidence: SessionExecutionEvidence
): CriteriaCheck {
  const text = criteria.toLowerCase();
  const evidenceTypes: EvidenceRecordType[] = [];

  if (/test|测试|smoke|vitest|jest|bun test|pytest/.test(text)) {
    evidenceTypes.push("test_result");
    if (evidence.testResults.length > 0) {
      return {
        criteria,
        status: "pass",
        reason: "At least one test_result evidence was recorded.",
        evidenceTypes,
      };
    }
    return {
      criteria,
      status: "unknown",
      reason: "No test_result evidence was recorded for this criteria.",
      evidenceTypes,
    };
  }

  if (/api|get |post |http|200|接口|返回/.test(text)) {
    evidenceTypes.push("api_response");
    if (evidence.apiResponses.length > 0) {
      return {
        criteria,
        status: "unknown",
        reason: "api_response evidence exists, but criteria-to-response mapping is not proven.",
        evidenceTypes,
      };
    }
    return {
      criteria,
      status: "unknown",
      reason: "No api_response evidence was recorded for this criteria.",
      evidenceTypes,
    };
  }

  if (/command|输出|日志|stdout|diff/.test(text)) {
    evidenceTypes.push("command_output");
    if (evidence.commandOutputs.length > 0) {
      return {
        criteria,
        status: "unknown",
        reason: "command_output evidence exists, but criteria-to-output mapping is not proven.",
        evidenceTypes,
      };
    }
    return {
      criteria,
      status: "unknown",
      reason: "No command_output evidence was recorded for this criteria.",
      evidenceTypes,
    };
  }

  return {
    criteria,
    status: "unknown",
    reason: "No deterministic mapping from criteria to evidence types.",
    evidenceTypes,
  };
}

function buildFallbackNextActions(
  request: CompletionGateAdvisorRequest,
  status: CompletionGateStatus
): string[] {
  if (status === "blocked") {
    return ["Collect at least one test_result, api_response, or command_output evidence item."];
  }

  const missingTemplateTypes = (request.checklist.evidenceTemplates || [])
    .map((t) => t.type)
    .filter((type) => !hasEvidenceType(request.evidence, type as EvidenceRecordType));

  const actions = missingTemplateTypes.map((type) => `Collect missing evidence type: ${type}`);
  return actions.length > 0
    ? actions
    : ["Add explicit verification evidence for each success criteria."];
}

function hasEvidenceType(evidence: SessionExecutionEvidence, type: EvidenceRecordType): boolean {
  switch (type) {
    case "test_result":
      return evidence.testResults.length > 0;
    case "api_response":
      return evidence.apiResponses.length > 0;
    case "runtime_observation":
      return evidence.runtimeObservations.length > 0;
    default:
      return evidence.commandOutputs.length > 0;
  }
}

function getEvidenceCounts(evidence: SessionExecutionEvidence): Record<EvidenceRecordType, number> {
  return {
    test_result: evidence.testResults.length,
    command_output: evidence.commandOutputs.length,
    api_response: evidence.apiResponses.length,
    runtime_observation: evidence.runtimeObservations.length,
  };
}

function normalizeSuggestion(input: any): CompletionGateSuggestion | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const status = input.status;
  if (status !== "done" && status !== "partial" && status !== "blocked") {
    return null;
  }

  const criteria_check = Array.isArray(input.criteria_check) ? input.criteria_check : [];
  const constraint_check = Array.isArray(input.constraint_check) ? input.constraint_check : [];
  const summary = typeof input.summary === "string" ? input.summary : "";
  const next_actions = Array.isArray(input.next_actions)
    ? input.next_actions.filter((item: any) => typeof item === "string")
    : [];

  return {
    status,
    criteria_check: criteria_check
      .filter((item: any) => item && typeof item === "object")
      .map((item: any) => ({
        criteria: typeof item.criteria === "string" ? item.criteria : "",
        status:
          item.status === "pass" || item.status === "fail" || item.status === "unknown"
            ? item.status
            : "unknown",
        reason: typeof item.reason === "string" ? item.reason : "",
        evidenceTypes: Array.isArray(item.evidenceTypes)
          ? item.evidenceTypes.filter(
              (t: any) =>
                t === "test_result" ||
                t === "command_output" ||
                t === "api_response" ||
                t === "runtime_observation"
            )
          : [],
      }))
      .filter((item: CriteriaCheck) => item.criteria.length > 0),
    constraint_check: constraint_check
      .filter((item: any) => item && typeof item === "object")
      .map((item: any) => ({
        constraint: typeof item.constraint === "string" ? item.constraint : "",
        status:
          item.status === "pass" || item.status === "fail" || item.status === "unknown"
            ? item.status
            : "unknown",
        reason: typeof item.reason === "string" ? item.reason : "",
      }))
      .filter((item: ConstraintCheck) => item.constraint.length > 0),
    summary,
    next_actions,
  };
}
