import { CONFIG } from "../config.js";
import {
  MEMORY_CONSTRAINT_KINDS,
  MEMORY_DECISION_TAGS,
  MEMORY_ENTITY_TYPES,
  type ConstraintKind,
  type DecisionTag,
  type MemoryEntity,
  type MemoryEntityType,
} from "../types/index.js";
import { memoryClient } from "./client.js";
import type { CompletionChecklist, TaskMemoryRef } from "./task-support.js";
import { loadOpencodeProvider } from "./ai/opencode-provider-loader.js";
import { getOpenCodeClient } from "./ai/profile-llm-client.js";
import type {
  EvidenceRecord,
  EvidenceRecordType,
  SessionExecutionEvidence,
} from "./session-evidence.js";

const COMPLETION_WRITEBACK_SOURCE = "completion-checklist";
const COMPLETION_WRITEBACK_LIMIT = 50;
const VALID_ENTITY_TYPES = new Set<string>(MEMORY_ENTITY_TYPES);
const VALID_CONSTRAINT_KINDS = new Set<string>(MEMORY_CONSTRAINT_KINDS);
const VALID_DECISION_TAGS = new Set<string>(MEMORY_DECISION_TAGS);

type WritebackMemType = "experience" | "tool_trace" | "skill" | "file_knowledge";

interface WritebackProjectInfo {
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

interface WritebackDraft {
  type: string;
  mem_type: WritebackMemType;
  content: string;
  tags: string[];
  entities: MemoryEntity[];
  constraint_kinds: ConstraintKind[];
  decision_tags: DecisionTag[];
}

interface RawWritebackDraft {
  type?: string;
  mem_type?: string;
  content?: string;
  tags?: string[];
  entities?: Array<{ entity?: string; entity_type?: string }>;
  constraint_kinds?: unknown;
  decision_tags?: unknown;
}

export interface CompletionWritebackRequest {
  task: string;
  sessionID: string;
  promptId: string;
  containerTag: string;
  checklist: CompletionChecklist;
  memoryRefs?: TaskMemoryRef[];
  constraintKinds?: ConstraintKind[];
  evidence?: SessionExecutionEvidence;
  projectInfo?: WritebackProjectInfo;
}

export interface CompletionWritebackResult {
  success: boolean;
  skipped: boolean;
  usedAI: boolean;
  drafts: WritebackDraft[];
  writtenMemoryIds: string[];
  error?: string;
}

export async function writeCompletionChecklistMemories(
  request: CompletionWritebackRequest
): Promise<CompletionWritebackResult> {
  const alreadyWritten = await hasExistingWriteback(request.containerTag, request.promptId);
  if (alreadyWritten) {
    return {
      success: true,
      skipped: true,
      usedAI: false,
      drafts: [],
      writtenMemoryIds: [],
    };
  }

  const fallbackDrafts = buildFallbackDrafts(request);
  const aiDrafts = await maybeGenerateWritebackWithAI(request, fallbackDrafts);
  const drafts = mergeDrafts(aiDrafts, fallbackDrafts);
  const writtenMemoryIds: string[] = [];
  const decisionContext = deriveDecisionContext(request.memoryRefs, request.constraintKinds);

  for (const draft of drafts) {
    const mergedConstraintKinds = mergeConstraintKinds(draft, decisionContext.constraintKinds);
    const mergedDecisionTags = mergeDecisionTags(draft, decisionContext.decisionTags);
    const addResult = await memoryClient.addMemory(draft.content, request.containerTag, {
      type: draft.type as any,
      source: "api",
      tags: uniqueStrings(["completion-gate", draft.mem_type, ...draft.tags]),
      sessionID: request.sessionID,
      promptId: request.promptId,
      captureTimestamp: Date.now(),
      mem_types: [draft.mem_type],
      entities: draft.entities,
      ...(shouldPersistDecisionContext(draft.mem_type)
        ? {
            constraint_kinds: mergedConstraintKinds,
            decision_tags: mergedDecisionTags,
          }
        : {}),
      writebackSource: COMPLETION_WRITEBACK_SOURCE,
      writebackKind: draft.mem_type,
      ...request.projectInfo,
    });

    if (!addResult.success) {
      return {
        success: false,
        skipped: false,
        usedAI: aiDrafts.length > 0,
        drafts,
        writtenMemoryIds,
        error: addResult.error,
      };
    }

    writtenMemoryIds.push(addResult.id);
  }

  return {
    success: true,
    skipped: false,
    usedAI: aiDrafts.length > 0,
    drafts,
    writtenMemoryIds,
  };
}

async function hasExistingWriteback(containerTag: string, promptId: string): Promise<boolean> {
  const recent = await memoryClient.listMemories(
    containerTag,
    COMPLETION_WRITEBACK_LIMIT,
    "project"
  );
  if (!recent.success) {
    return false;
  }

  return recent.memories.some((memory) => {
    const metadata = memory.metadata || {};
    return (
      metadata.promptId === promptId && metadata.writebackSource === COMPLETION_WRITEBACK_SOURCE
    );
  });
}

async function maybeGenerateWritebackWithAI(
  request: CompletionWritebackRequest,
  fallbackDrafts: WritebackDraft[]
): Promise<WritebackDraft[]> {
  const systemPrompt = `You convert a completion checklist into reusable memory writebacks.

Rules:
1. Return valid JSON only.
2. Use only these mem_type values: experience, tool_trace, skill, file_knowledge.
3. Do not claim the task is finished or verified.
4. Stay grounded in the task, checklist, execution evidence, and recalled memory refs.
5. Keep each content concise and reusable.
6. Entities must use only these entity_type values: ${MEMORY_ENTITY_TYPES.join(", ")}.
7. If you output constraint_kinds or decision_tags, use only allowed enum values (or empty arrays).
8. Allowed constraint_kinds: ${MEMORY_CONSTRAINT_KINDS.join(", ")}.
9. Allowed decision_tags: ${MEMORY_DECISION_TAGS.join(", ")}.`;

  const userPrompt = `Task:
${request.task}

Checklist:
${JSON.stringify(request.checklist, null, 2)}

Execution evidence:
${JSON.stringify(request.evidence || {}, null, 2)}

Recalled memory refs:
${JSON.stringify(request.memoryRefs || [], null, 2)}

Fallback drafts:
${JSON.stringify(fallbackDrafts, null, 2)}

Return JSON with:
{
  "memories": [
    {
      "type": "string",
      "mem_type": "experience | tool_trace | skill | file_knowledge",
      "content": "string",
      "tags": ["string"],
      "entities": [{ "entity": "string", "entity_type": "Project | Module | Technology | Framework | Library | File | Function | Class | Issue | Decision" }],
      "constraint_kinds": ["preserve_db_schema | preserve_api_contract | preserve_ui | no_new_table | minimize_change"],
      "decision_tags": ["architecture_boundary | compatibility | scope_control | verification_policy | security_boundary"]
    }
  ]
}`;

  const opencodeResult = await tryGenerateWithOpencode(systemPrompt, userPrompt);
  if (opencodeResult.length > 0) {
    return opencodeResult;
  }

  return tryGenerateWithProvider(systemPrompt, userPrompt, request.sessionID);
}

async function tryGenerateWithOpencode(
  systemPrompt: string,
  userPrompt: string
): Promise<WritebackDraft[]> {
  if (!CONFIG.opencodeProvider || !CONFIG.opencodeModel) {
    return [];
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
        memories: z
          .array(
            z.object({
              mem_type: z.enum(["experience", "tool_trace", "skill", "file_knowledge"]),
              type: z.string(),
              content: z.string(),
              tags: z.array(z.string()).default([]),
              entities: z
                .array(
                  z.object({
                    entity: z.string(),
                    entity_type: z.enum(MEMORY_ENTITY_TYPES),
                  })
                )
                .default([]),
              constraint_kinds: z.array(z.enum(MEMORY_CONSTRAINT_KINDS)).default([]),
              decision_tags: z.array(z.enum(MEMORY_DECISION_TAGS)).default([]),
            })
          )
          .default([]),
      }) as any,
    });

    return normalizeWritebackDrafts((result as any)?.memories);
  } catch {
    return [];
  }
}

async function tryGenerateWithProvider(
  systemPrompt: string,
  userPrompt: string,
  sessionID: string
): Promise<WritebackDraft[]> {
  if (!CONFIG.memoryModel || !CONFIG.memoryApiUrl) {
    return [];
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
          name: "generate_completion_writeback",
          description: "Generate completion checklist writeback memories",
          parameters: {
            type: "object",
            properties: {
              memories: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    mem_type: {
                      type: "string",
                      enum: ["experience", "tool_trace", "skill", "file_knowledge"],
                    },
                    type: { type: "string" },
                    content: { type: "string" },
                    tags: { type: "array", items: { type: "string" } },
                    entities: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          entity: { type: "string" },
                          entity_type: { type: "string", enum: [...MEMORY_ENTITY_TYPES] },
                        },
                        required: ["entity", "entity_type"],
                      },
                    },
                    constraint_kinds: {
                      type: "array",
                      items: { type: "string", enum: [...MEMORY_CONSTRAINT_KINDS] },
                    },
                    decision_tags: {
                      type: "array",
                      items: { type: "string", enum: [...MEMORY_DECISION_TAGS] },
                    },
                  },
                  required: ["type", "mem_type", "content", "tags", "entities"],
                },
              },
            },
            required: ["memories"],
          },
        },
      },
      sessionID
    );

    if (!result.success || !result.data) {
      return [];
    }

    return normalizeWritebackDrafts((result.data as any)?.memories);
  } catch {
    return [];
  }
}

function buildFallbackDrafts(request: CompletionWritebackRequest): WritebackDraft[] {
  const evidence = request.evidence;
  const evidenceTags = collectEvidenceTags(evidence);
  const evidenceEntities = collectEntitiesFromEvidence(evidence);
  const evidenceSummary = summarizeEvidence(evidence);
  const inferredType = inferEventType(request.task, evidence);
  const experience: WritebackDraft = {
    type: inferredType,
    mem_type: "experience",
    content: [
      `Task: ${request.task}`,
      evidenceSummary ? `Observed execution evidence: ${evidenceSummary}` : "",
      ...buildEvidenceCategoryLines(
        "Matched evidence",
        getEvidenceForTemplateType(evidence, "runtime_observation")
      ),
      "Checklist-derived experience:",
      ...request.checklist.remainingRisks.map((item) => `- ${item}`),
      ...request.checklist.successCriteria.slice(0, 2).map((item) => `- ${item}`),
    ]
      .filter(Boolean)
      .join("\n"),
    tags: uniqueStrings(["verification", "risk", ...evidenceTags]),
    entities: mergeEntities(
      collectEntitiesFromRefs(request.memoryRefs, ["Issue", "Decision"]),
      evidenceEntities
    ),
    constraint_kinds: [],
    decision_tags: [],
  };

  const toolTrace: WritebackDraft = {
    type: "verification",
    mem_type: "tool_trace",
    content: [
      `Task: ${request.task}`,
      "Observed execution evidence:",
      ...buildEvidenceCategoryLines(
        "Test results",
        getEvidenceForTemplateType(evidence, "test_result")
      ),
      ...buildEvidenceCategoryLines(
        "API responses",
        getEvidenceForTemplateType(evidence, "api_response")
      ),
      ...buildEvidenceCategoryLines(
        "Command outputs",
        getEvidenceForTemplateType(evidence, "command_output")
      ),
      "Suggested verification steps:",
      ...request.checklist.verificationHints.map((item) => `- ${item}`),
      "Evidence templates:",
      ...request.checklist.evidenceTemplates.map(
        (item) => `- [${item.type}] ${item.title}${item.payload ? `: ${item.payload}` : ""}`
      ),
    ].join("\n"),
    tags: uniqueStrings(["verification", "evidence", ...evidenceTags]),
    entities: mergeEntities(
      collectEntitiesFromRefs(request.memoryRefs, ["File", "Function", "Class"]),
      evidenceEntities
    ),
    constraint_kinds: [],
    decision_tags: [],
  };

  const skill: WritebackDraft = {
    type: "workflow",
    mem_type: "skill",
    content: [
      `Reusable completion workflow for: ${request.task}`,
      ...buildSkillSteps(evidence),
    ].join("\n"),
    tags: uniqueStrings(["workflow", "completion-gate", ...evidenceTags]),
    entities: mergeEntities(
      collectEntitiesFromRefs(request.memoryRefs, ["File", "Decision"]),
      evidenceEntities
    ),
    constraint_kinds: [],
    decision_tags: [],
  };

  const fileKnowledge = buildFileKnowledgeDraft(
    request,
    inferredType,
    evidenceTags,
    evidenceEntities
  );

  return [experience, toolTrace, skill, fileKnowledge].filter(
    (draft): draft is WritebackDraft => !!draft && draft.content.trim().length > 0
  );
}

function buildFileKnowledgeDraft(
  request: CompletionWritebackRequest,
  inferredType: string,
  evidenceTags: string[],
  evidenceEntities: MemoryEntity[]
): WritebackDraft | null {
  const evidence = request.evidence;
  const files = uniqueStrings([...(evidence?.referencedFiles || [])]);
  if (files.length === 0) {
    return null;
  }

  const evidenceItems = evidence ? getAllEvidenceItems(evidence) : [];
  const fileMentions = collectEvidenceMentionsForFiles(files, evidenceItems);
  return {
    type: inferredType,
    mem_type: "file_knowledge",
    content: [
      `Task: ${request.task}`,
      "Files involved:",
      ...files.map((file) => `- ${file}`),
      fileMentions.length > 0 ? "Evidence mentions:" : "",
      ...fileMentions.map((item) => `- [${item.type}] ${item.title}: ${item.payload}`),
      "Checklist-derived notes:",
      ...request.checklist.successCriteria.slice(0, 2).map((item) => `- ${item}`),
      ...request.checklist.remainingRisks.slice(0, 2).map((item) => `- ${item}`),
    ]
      .filter(Boolean)
      .join("\n"),
    tags: uniqueStrings(["file_knowledge", "context", ...evidenceTags]),
    entities: mergeEntities(
      collectEntitiesFromRefs(request.memoryRefs, ["File", "Function", "Class"]),
      evidenceEntities
    ),
    constraint_kinds: [],
    decision_tags: [],
  };
}

function collectEvidenceMentionsForFiles(
  files: string[],
  evidenceItems: EvidenceRecord[]
): EvidenceRecord[] {
  const normalizedFiles = files.map((file) => file.toLowerCase());
  const picked: EvidenceRecord[] = [];
  for (const item of evidenceItems) {
    const haystack = `${item.title}\n${item.payload}`.toLowerCase();
    if (normalizedFiles.some((file) => haystack.includes(file))) {
      picked.push(item);
    }
    if (picked.length >= 5) {
      break;
    }
  }
  return picked;
}

function collectEntitiesFromRefs(
  memoryRefs: TaskMemoryRef[] | undefined,
  allowedTypes: MemoryEntityType[]
): MemoryEntity[] {
  if (!memoryRefs) {
    return [];
  }

  const entities: MemoryEntity[] = [];
  const seen = new Set<string>();

  for (const ref of memoryRefs) {
    for (const entity of ref.entities) {
      if (!allowedTypes.includes(entity.entity_type)) {
        continue;
      }
      const key = `${entity.entity_type}:${entity.entity.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entities.push(entity);
    }
  }

  return entities;
}

function normalizeWritebackDrafts(input: unknown): WritebackDraft[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const drafts = input
    .filter((item): item is RawWritebackDraft => !!item && typeof item === "object")
    .map((item) => ({
      type: normalizeString(item.type),
      mem_type: normalizeWritebackMemType(item.mem_type),
      content: normalizeString(item.content),
      tags: normalizeStringArray(item.tags),
      entities: normalizeEntities(item.entities),
      constraint_kinds: normalizeConstraintKinds(item.constraint_kinds),
      decision_tags: normalizeDecisionTags(item.decision_tags),
    }))
    .filter(
      (item): item is WritebackDraft =>
        !!item.mem_type && item.type.length > 0 && item.content.length > 0
    );

  const uniqueByType = new Map<WritebackMemType, WritebackDraft>();
  drafts.forEach((draft) => {
    if (!uniqueByType.has(draft.mem_type)) {
      uniqueByType.set(draft.mem_type, draft);
    }
  });

  return [...uniqueByType.values()];
}

function normalizeWritebackMemType(input: unknown): WritebackMemType | null {
  return input === "experience" ||
    input === "tool_trace" ||
    input === "skill" ||
    input === "file_knowledge"
    ? input
    : null;
}

function normalizeConstraintKinds(input: unknown): ConstraintKind[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return uniqueStrings(
    input
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => VALID_CONSTRAINT_KINDS.has(item))
  ) as ConstraintKind[];
}

function normalizeDecisionTags(input: unknown): DecisionTag[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return uniqueStrings(
    input
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => VALID_DECISION_TAGS.has(item))
  ) as DecisionTag[];
}

function shouldPersistDecisionContext(memType: WritebackMemType): boolean {
  return memType === "experience" || memType === "skill" || memType === "file_knowledge";
}

function deriveDecisionContext(
  memoryRefs: TaskMemoryRef[] | undefined,
  briefConstraintKinds: ConstraintKind[] | undefined
): { constraintKinds: ConstraintKind[]; decisionTags: DecisionTag[] } {
  const constraintKinds = normalizeConstraintKinds([
    ...(briefConstraintKinds || []),
    ...(memoryRefs?.flatMap((ref) => ref.constraintKinds || []) || []),
  ]);
  const decisionTags = normalizeDecisionTags(
    memoryRefs?.flatMap((ref) => ref.decisionTags || []) || []
  );
  return { constraintKinds, decisionTags };
}

function mergeConstraintKinds(
  draft: WritebackDraft,
  inherited: ConstraintKind[]
): ConstraintKind[] {
  return normalizeConstraintKinds([...(inherited || []), ...draft.constraint_kinds]);
}

function mergeDecisionTags(draft: WritebackDraft, inherited: DecisionTag[]): DecisionTag[] {
  return normalizeDecisionTags([...(inherited || []), ...draft.decision_tags]);
}

function mergeDrafts(
  aiDrafts: WritebackDraft[],
  fallbackDrafts: WritebackDraft[]
): WritebackDraft[] {
  if (aiDrafts.length === 0) {
    return fallbackDrafts;
  }

  const byType = new Map<WritebackMemType, WritebackDraft>();
  for (const draft of fallbackDrafts) {
    byType.set(draft.mem_type, draft);
  }
  for (const draft of aiDrafts) {
    byType.set(draft.mem_type, draft);
  }

  const required: WritebackMemType[] = ["experience", "skill", "file_knowledge"];
  for (const type of required) {
    if (!byType.has(type)) {
      const fallback = fallbackDrafts.find((draft) => draft.mem_type === type);
      if (fallback) {
        byType.set(type, fallback);
      }
    }
  }

  return [...byType.values()];
}

function inferEventType(task: string, evidence?: SessionExecutionEvidence): string {
  const text =
    `${task}\n${evidence?.assistantResponses.join("\n") || ""}\n${flattenEvidencePayloads(evidence).join("\n")}`.toLowerCase();
  if (/bug|fix|error|500|异常|报错|修复/.test(text)) {
    return "bug-fix";
  }
  if (/refactor|重构/.test(text)) {
    return "refactor";
  }
  if (/test|验证|checklist|evidence|smoke|lint/.test(text)) {
    return "verification";
  }
  return "feature";
}

function collectEvidenceTags(evidence?: SessionExecutionEvidence): string[] {
  if (!evidence) {
    return [];
  }

  const toolTags = evidence.toolExecutions
    .map((tool) => tool.name.toLowerCase().trim())
    .filter(Boolean);
  const evidenceTypeTags = getAllEvidenceItems(evidence).map((item) => item.type);
  const fileTags = evidence.referencedFiles.length > 0 ? ["file-evidence"] : [];
  return uniqueStrings([...toolTags, ...evidenceTypeTags, ...fileTags]);
}

function collectEntitiesFromEvidence(evidence?: SessionExecutionEvidence): MemoryEntity[] {
  if (!evidence) {
    return [];
  }

  return evidence.referencedFiles.map((file) => ({
    entity: file,
    entity_type: "File" as const,
  }));
}

function summarizeEvidence(evidence?: SessionExecutionEvidence): string {
  if (!evidence) {
    return "";
  }

  const fragments: string[] = [];
  appendEvidenceCount(fragments, "tests", evidence.testResults);
  appendEvidenceCount(fragments, "apis", evidence.apiResponses);
  appendEvidenceCount(fragments, "commands", evidence.commandOutputs);
  appendEvidenceCount(fragments, "observations", evidence.runtimeObservations);
  if (evidence.referencedFiles.length > 0) {
    fragments.push(`files=${evidence.referencedFiles.join(", ")}`);
  }
  return fragments.join("; ");
}

function buildEvidenceCategoryLines(title: string, items: EvidenceRecord[]): string[] {
  if (items.length === 0) {
    return [];
  }

  return [title + ":", ...items.map((item) => `- ${item.title}: ${item.payload}`)];
}

function buildSkillSteps(evidence?: SessionExecutionEvidence): string[] {
  const steps = ["1. Align success criteria with the current task scope."];
  const evidenceItems = evidence ? getAllEvidenceItems(evidence) : [];

  if (
    evidence?.commandOutputs.length ||
    evidence?.testResults.length ||
    evidence?.apiResponses.length
  ) {
    steps.push(
      `2. Reuse the observed verification evidence types: ${uniqueStrings(
        evidenceItems.map((item) => item.type)
      ).join(" -> ")}.`
    );
  } else {
    steps.push("2. Run the smallest verification path that covers the affected files or flows.");
  }

  if (evidence?.referencedFiles.length) {
    steps.push(`3. Validate the affected files: ${evidence.referencedFiles.join(", ")}.`);
  } else {
    steps.push("3. Validate the affected files or APIs with at least one smoke path.");
  }

  steps.push("4. Record evidence outputs that map back to the checklist.");
  steps.push("5. Keep remaining risks explicit instead of implying completion.");
  return steps;
}

function getEvidenceForTemplateType(
  evidence: SessionExecutionEvidence | undefined,
  type: EvidenceRecordType
): EvidenceRecord[] {
  if (!evidence) {
    return [];
  }

  switch (type) {
    case "test_result":
      return evidence.testResults;
    case "api_response":
      return evidence.apiResponses;
    case "runtime_observation":
      return evidence.runtimeObservations;
    default:
      return evidence.commandOutputs;
  }
}

function appendEvidenceCount(fragments: string[], label: string, items: EvidenceRecord[]): void {
  if (items.length > 0) {
    fragments.push(`${label}=${items.length}`);
  }
}

function flattenEvidencePayloads(evidence?: SessionExecutionEvidence): string[] {
  if (!evidence) {
    return [];
  }

  return getAllEvidenceItems(evidence).map((item) => item.payload);
}

function getAllEvidenceItems(evidence: SessionExecutionEvidence): EvidenceRecord[] {
  const grouped = [
    ...(evidence.evidenceItems || []),
    ...(evidence.commandOutputs || []),
    ...(evidence.testResults || []),
    ...(evidence.apiResponses || []),
    ...(evidence.runtimeObservations || []),
  ];

  const seen = new Set<string>();
  const results: EvidenceRecord[] = [];
  for (const item of grouped) {
    const key = `${item.type}:${item.title}:${item.payload}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(item);
  }
  return results;
}

function mergeEntities(...groups: MemoryEntity[][]): MemoryEntity[] {
  const results: MemoryEntity[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const entity of group) {
      const key = `${entity.entity_type}:${entity.entity.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(entity);
    }
  }

  return results;
}

function normalizeEntities(input: unknown): MemoryEntity[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter(
      (item): item is { entity?: string; entity_type?: string } =>
        !!item && typeof item === "object"
    )
    .map((item) => ({
      entity: normalizeString(item.entity),
      entity_type: VALID_ENTITY_TYPES.has(item.entity_type || "")
        ? (item.entity_type as MemoryEntityType)
        : null,
    }))
    .filter((item): item is MemoryEntity => !!item.entity_type && item.entity.length > 0);
}

function normalizeString(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return uniqueStrings(
    input.filter((item): item is string => typeof item === "string").map((item) => item.trim())
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
