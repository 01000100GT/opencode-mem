import { CONFIG } from "../config.js";
import {
  MEMORY_CONSTRAINT_KINDS,
  MEMORY_DECISION_TAGS,
  MEMORY_ENTITY_TYPES,
  MEMORY_MEM_TYPES,
} from "../types/index.js";
import type {
  CognitiveMemoryType,
  ConstraintKind,
  DecisionTag,
  MemoryEntity,
  MemoryEntityType,
} from "../types/index.js";
import { memoryClient, type MemoryScope } from "./client.js";
import { loadOpencodeProvider } from "./ai/opencode-provider-loader.js";
import { getOpenCodeClient } from "./ai/profile-llm-client.js";

const DEFAULT_RECALL_LIMIT = 6;
const SUPPORT_MEMORY_SCAN_LIMIT = 12;
const MAX_DECISION_NOTES = 3;
const MAX_PREFERENCE_NOTES = 3;
const MAX_RISK_NOTES = 3;
const MAX_SUCCESS_CRITERIA = 4;
const EVIDENCE_TYPES = [
  "test_result",
  "command_output",
  "api_response",
  "diff_summary",
  "runtime_observation",
] as const;
const VALID_MEM_TYPES = new Set<string>(MEMORY_MEM_TYPES);
const VALID_ENTITY_TYPES = new Set<string>(MEMORY_ENTITY_TYPES);
const VALID_CONSTRAINT_KINDS = new Set<string>(MEMORY_CONSTRAINT_KINDS);
const VALID_DECISION_TAGS = new Set<string>(MEMORY_DECISION_TAGS);

type SupportMode = "brief" | "checklist";
type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface TaskSupportRequest {
  mode: SupportMode;
  task: string;
  containerTag: string;
  sessionID: string;
  scope?: MemoryScope;
  limit?: number;
}

export interface TaskMemoryRef {
  id: string;
  summary: string;
  similarity?: number;
  memTypes: CognitiveMemoryType[];
  entities: MemoryEntity[];
  constraintKinds?: ConstraintKind[];
  decisionTags?: DecisionTag[];
}

export interface TaskBrief {
  taskGoal: string;
  relatedFiles: string[];
  relatedSymbols: string[];
  historicalDecisions: string[];
  constraintKinds: ConstraintKind[];
  constraints: string[];
  userPreferences: string[];
  risks: string[];
  successCriteria: string[];
}

export interface EvidenceTemplate {
  type: EvidenceType;
  title: string;
  payload: string;
}

export interface CompletionChecklist {
  successCriteria: string[];
  verificationHints: string[];
  evidenceTemplates: EvidenceTemplate[];
  remainingRisks: string[];
}

export interface TaskSupportResponse {
  success: true;
  mode: SupportMode;
  task: string;
  scope: MemoryScope;
  usedAI: boolean;
  memoriesConsidered: number;
  memoryRefs: TaskMemoryRef[];
  brief?: TaskBrief;
  checklist?: CompletionChecklist;
}

interface TaskSupportGenerator {
  generate(request: TaskSupportRequest): Promise<TaskSupportResponse>;
}

interface TaskSupportMemory {
  id: string;
  content: string;
  similarity?: number;
  memTypes: CognitiveMemoryType[];
  entities: MemoryEntity[];
  constraintKinds: ConstraintKind[];
  decisionTags: DecisionTag[];
}

interface RawEvidenceTemplate {
  type?: string;
  title?: string;
  payload?: string;
}

class DefaultTaskSupportGenerator implements TaskSupportGenerator {
  async generate(request: TaskSupportRequest): Promise<TaskSupportResponse> {
    const scope: MemoryScope = request.scope ?? CONFIG.memory.defaultScope ?? "project";
    const memories = await recallTaskMemories(
      request.task,
      request.containerTag,
      scope,
      request.limit ?? DEFAULT_RECALL_LIMIT
    );

    const memoryRefs = memories.map(toTaskMemoryRef);
    const memoryContext = buildMemoryContext(memories);

    if (request.mode === "brief") {
      const fallbackBrief = buildFallbackBrief(request.task, memories);
      const aiBrief = await maybeGenerateBriefWithAI(
        request.task,
        request.sessionID,
        memoryContext,
        fallbackBrief
      );
      return {
        success: true,
        mode: request.mode,
        task: request.task,
        scope,
        usedAI: !!aiBrief,
        memoriesConsidered: memoryRefs.length,
        memoryRefs,
        brief: aiBrief ?? fallbackBrief,
      };
    }

    const fallbackChecklist = buildFallbackChecklist(request.task, memories);
    const aiChecklist = await maybeGenerateChecklistWithAI(
      request.task,
      request.sessionID,
      memoryContext,
      fallbackChecklist
    );

    return {
      success: true,
      mode: request.mode,
      task: request.task,
      scope,
      usedAI: !!aiChecklist,
      memoriesConsidered: memoryRefs.length,
      memoryRefs,
      checklist: aiChecklist ?? fallbackChecklist,
    };
  }
}

const defaultTaskSupportGenerator = new DefaultTaskSupportGenerator();

export async function generateTaskSupport(
  request: TaskSupportRequest
): Promise<TaskSupportResponse> {
  return defaultTaskSupportGenerator.generate(request);
}

async function recallTaskMemories(
  task: string,
  containerTag: string,
  scope: MemoryScope,
  limit: number
): Promise<TaskSupportMemory[]> {
  const [searchResult, recentResult] = await Promise.all([
    memoryClient.searchMemories(task, containerTag, scope),
    memoryClient.listMemories(containerTag, SUPPORT_MEMORY_SCAN_LIMIT, scope),
  ]);

  const merged = new Map<string, TaskSupportMemory>();

  if (searchResult.success) {
    for (const memory of searchResult.results.slice(0, limit)) {
      merged.set(memory.id, normalizeSearchMemory(memory));
    }
  }

  if (recentResult.success) {
    for (const memory of recentResult.memories) {
      const normalized = normalizeRecentMemory(memory);
      if (!shouldIncludeSupportMemory(normalized) || merged.has(normalized.id)) {
        continue;
      }
      merged.set(normalized.id, normalized);
    }
  }

  return [...merged.values()].slice(0, Math.max(limit, DEFAULT_RECALL_LIMIT) + 3);
}

function normalizeSearchMemory(memory: any): TaskSupportMemory {
  return {
    id: memory.id,
    content: String(memory.memory || memory.chunk || ""),
    similarity: typeof memory.similarity === "number" ? memory.similarity : undefined,
    memTypes: normalizeMemTypes(memory.metadata?.mem_types),
    entities: normalizeEntities(memory.metadata?.entities),
    constraintKinds: normalizeConstraintKinds(memory.metadata?.constraint_kinds),
    decisionTags: normalizeDecisionTags(memory.metadata?.decision_tags),
  };
}

function normalizeRecentMemory(memory: any): TaskSupportMemory {
  return {
    id: memory.id,
    content: String(memory.summary || ""),
    memTypes: normalizeMemTypes(memory.metadata?.mem_types),
    entities: normalizeEntities(memory.metadata?.entities),
    constraintKinds: normalizeConstraintKinds(memory.metadata?.constraint_kinds),
    decisionTags: normalizeDecisionTags(memory.metadata?.decision_tags),
  };
}

function shouldIncludeSupportMemory(memory: TaskSupportMemory): boolean {
  return (
    memory.memTypes.includes("profile") ||
    memory.entities.some(
      (entity) => entity.entity_type === "Decision" || entity.entity_type === "Issue"
    ) ||
    memory.constraintKinds.length > 0 ||
    memory.decisionTags.length > 0
  );
}

function toTaskMemoryRef(memory: TaskSupportMemory): TaskMemoryRef {
  return {
    id: memory.id,
    summary: summarizeText(memory.content, 180),
    similarity: memory.similarity,
    memTypes: memory.memTypes,
    entities: memory.entities,
    constraintKinds: memory.constraintKinds,
    decisionTags: memory.decisionTags,
  };
}

async function maybeGenerateBriefWithAI(
  task: string,
  sessionID: string,
  memoryContext: string,
  fallbackBrief: TaskBrief
): Promise<TaskBrief | null> {
  const systemPrompt = `You generate a structured task brief for a coding assistant.

Rules:
1. Return valid JSON only.
2. Match the task language.
3. Stay grounded in recalled memories and the fallback draft.
4. Keep outputs concise, concrete, and testable.
5. If a field is unsupported, return an empty array instead of guessing.`;

  const userPrompt = `Task:
${task}

Recalled memories:
${memoryContext}

Fallback draft:
${JSON.stringify(fallbackBrief, null, 2)}

Return JSON with:
- taskGoal
- relatedFiles[]
- relatedSymbols[]
- historicalDecisions[]
- constraintKinds[] (allowed values: ${MEMORY_CONSTRAINT_KINDS.join(", ")})
- constraints[]
- userPreferences[]
- risks[]
- successCriteria[]`;

  const opencodeResult = await tryGenerateWithOpencode(systemPrompt, userPrompt, "brief");
  if (opencodeResult) {
    const normalized = normalizeBrief(opencodeResult, fallbackBrief);
    return hasBriefSignal(opencodeResult) ? normalized : null;
  }

  const providerResult = await tryGenerateWithProvider(systemPrompt, userPrompt, sessionID, {
    type: "function" as const,
    function: {
      name: "generate_task_brief",
      description: "Generate a structured task brief",
      parameters: {
        type: "object",
        properties: {
          taskGoal: { type: "string" },
          relatedFiles: { type: "array", items: { type: "string" } },
          relatedSymbols: { type: "array", items: { type: "string" } },
          historicalDecisions: { type: "array", items: { type: "string" } },
          constraintKinds: {
            type: "array",
            items: { type: "string", enum: [...MEMORY_CONSTRAINT_KINDS] },
          },
          constraints: { type: "array", items: { type: "string" } },
          userPreferences: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          successCriteria: { type: "array", items: { type: "string" } },
        },
        required: [
          "taskGoal",
          "relatedFiles",
          "relatedSymbols",
          "historicalDecisions",
          "constraintKinds",
          "constraints",
          "userPreferences",
          "risks",
          "successCriteria",
        ],
      },
    },
  });

  if (!providerResult) {
    return null;
  }

  const normalized = normalizeBrief(providerResult, fallbackBrief);
  return hasBriefSignal(providerResult) ? normalized : null;
}

async function maybeGenerateChecklistWithAI(
  task: string,
  sessionID: string,
  memoryContext: string,
  fallbackChecklist: CompletionChecklist
): Promise<CompletionChecklist | null> {
  const systemPrompt = `You generate a completion checklist for a coding assistant.

Rules:
1. Return valid JSON only.
2. Match the task language.
3. Stay grounded in recalled memories and the fallback draft.
4. Do not claim the task is done; only output verification guidance.
5. Evidence templates must use one of: ${EVIDENCE_TYPES.join(", ")}.`;

  const userPrompt = `Task:
${task}

Recalled memories:
${memoryContext}

Fallback draft:
${JSON.stringify(fallbackChecklist, null, 2)}

Return JSON with:
- successCriteria[]
- verificationHints[]
- evidenceTemplates[] where each item has { type, title, payload }
- remainingRisks[]`;

  const opencodeResult = await tryGenerateWithOpencode(systemPrompt, userPrompt, "checklist");
  if (opencodeResult) {
    const normalized = normalizeChecklist(opencodeResult, fallbackChecklist);
    return hasChecklistSignal(opencodeResult) ? normalized : null;
  }

  const providerResult = await tryGenerateWithProvider(systemPrompt, userPrompt, sessionID, {
    type: "function" as const,
    function: {
      name: "generate_completion_checklist",
      description: "Generate a structured completion checklist",
      parameters: {
        type: "object",
        properties: {
          successCriteria: { type: "array", items: { type: "string" } },
          verificationHints: { type: "array", items: { type: "string" } },
          evidenceTemplates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: [...EVIDENCE_TYPES] },
                title: { type: "string" },
                payload: { type: "string" },
              },
              required: ["type", "title", "payload"],
            },
          },
          remainingRisks: { type: "array", items: { type: "string" } },
        },
        required: ["successCriteria", "verificationHints", "evidenceTemplates", "remainingRisks"],
      },
    },
  });

  if (!providerResult) {
    return null;
  }

  const normalized = normalizeChecklist(providerResult, fallbackChecklist);
  return hasChecklistSignal(providerResult) ? normalized : null;
}

async function tryGenerateWithOpencode(
  systemPrompt: string,
  userPrompt: string,
  mode: SupportMode
): Promise<Record<string, unknown> | null> {
  if (!CONFIG.opencodeProvider || !CONFIG.opencodeModel) {
    return null;
  }

  try {
    const { generateStructuredOutput } = await loadOpencodeProvider();
    const { z } = await import("zod");
    const client = await getOpenCodeClient();

    if (mode === "brief") {
      const result = await generateStructuredOutput({
        client,
        providerID: CONFIG.opencodeProvider,
        modelID: CONFIG.opencodeModel,
        systemPrompt,
        userPrompt,
        schema: z.object({
          taskGoal: z.string(),
          relatedFiles: z.array(z.string()).default([]),
          relatedSymbols: z.array(z.string()).default([]),
          historicalDecisions: z.array(z.string()).default([]),
          constraintKinds: z.array(z.enum(MEMORY_CONSTRAINT_KINDS)).default([]),
          constraints: z.array(z.string()).default([]),
          userPreferences: z.array(z.string()).default([]),
          risks: z.array(z.string()).default([]),
          successCriteria: z.array(z.string()).default([]),
        }) as any,
      });

      return result as Record<string, unknown>;
    }

    const result = await generateStructuredOutput({
      client,
      providerID: CONFIG.opencodeProvider,
      modelID: CONFIG.opencodeModel,
      systemPrompt,
      userPrompt,
      schema: z.object({
        successCriteria: z.array(z.string()).default([]),
        verificationHints: z.array(z.string()).default([]),
        evidenceTemplates: z
          .array(
            z.object({
              type: z.enum(EVIDENCE_TYPES),
              title: z.string(),
              payload: z.string(),
            })
          )
          .default([]),
        remainingRisks: z.array(z.string()).default([]),
      }) as any,
    });

    return result as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function tryGenerateWithProvider(
  systemPrompt: string,
  userPrompt: string,
  sessionID: string,
  toolSchema: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
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
    const result = await provider.executeToolCall(systemPrompt, userPrompt, toolSchema, sessionID);

    if (!result.success || !result.data) {
      return null;
    }

    return result.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeBrief(input: Record<string, unknown>, fallbackBrief: TaskBrief): TaskBrief {
  const constraintKinds = uniqueConstraintKindValues([
    ...fallbackBrief.constraintKinds,
    ...normalizeConstraintKinds(input.constraintKinds),
    ...deriveConstraintKindsFromConstraints(normalizeStringArray(input.constraints)),
  ]);
  const constraints =
    normalizeStringArray(input.constraints) ||
    constraintKinds.map(mapConstraintKindToConstraintText);
  return {
    taskGoal: normalizeString(input.taskGoal) || fallbackBrief.taskGoal,
    relatedFiles: normalizeStringArray(input.relatedFiles) || fallbackBrief.relatedFiles,
    relatedSymbols: normalizeStringArray(input.relatedSymbols) || fallbackBrief.relatedSymbols,
    historicalDecisions:
      normalizeStringArray(input.historicalDecisions) || fallbackBrief.historicalDecisions,
    constraintKinds,
    constraints,
    userPreferences: normalizeStringArray(input.userPreferences) || fallbackBrief.userPreferences,
    risks: normalizeStringArray(input.risks) || fallbackBrief.risks,
    successCriteria: normalizeStringArray(input.successCriteria) || fallbackBrief.successCriteria,
  };
}

function normalizeChecklist(
  input: Record<string, unknown>,
  fallbackChecklist: CompletionChecklist
): CompletionChecklist {
  return {
    successCriteria:
      normalizeStringArray(input.successCriteria) || fallbackChecklist.successCriteria,
    verificationHints:
      normalizeStringArray(input.verificationHints) || fallbackChecklist.verificationHints,
    evidenceTemplates:
      normalizeEvidenceTemplates(input.evidenceTemplates) || fallbackChecklist.evidenceTemplates,
    remainingRisks: normalizeStringArray(input.remainingRisks) || fallbackChecklist.remainingRisks,
  };
}

function hasBriefSignal(input: Record<string, unknown>): boolean {
  return (
    normalizeString(input.taskGoal).length > 0 ||
    normalizeStringArray(input.relatedFiles).length > 0 ||
    normalizeStringArray(input.relatedSymbols).length > 0 ||
    normalizeStringArray(input.historicalDecisions).length > 0 ||
    normalizeConstraintKinds(input.constraintKinds).length > 0 ||
    normalizeStringArray(input.constraints).length > 0 ||
    normalizeStringArray(input.userPreferences).length > 0 ||
    normalizeStringArray(input.risks).length > 0 ||
    normalizeStringArray(input.successCriteria).length > 0
  );
}

function hasChecklistSignal(input: Record<string, unknown>): boolean {
  return (
    normalizeStringArray(input.successCriteria).length > 0 ||
    normalizeStringArray(input.verificationHints).length > 0 ||
    normalizeEvidenceTemplates(input.evidenceTemplates).length > 0 ||
    normalizeStringArray(input.remainingRisks).length > 0
  );
}

function buildMemoryContext(memories: TaskSupportMemory[]): string {
  if (memories.length === 0) {
    return "(no recalled memories)";
  }

  return memories
    .map((memory, index) => {
      const memTypes = memory.memTypes.length > 0 ? memory.memTypes.join(", ") : "none";
      const entities =
        memory.entities.length > 0
          ? memory.entities.map((entity) => `${entity.entity_type}:${entity.entity}`).join(", ")
          : "none";
      const constraintKinds =
        memory.constraintKinds.length > 0 ? memory.constraintKinds.join(", ") : "none";
      const decisionTags = memory.decisionTags.length > 0 ? memory.decisionTags.join(", ") : "none";
      return `${index + 1}. id=${memory.id}
mem_types: ${memTypes}
entities: ${entities}
constraint_kinds: ${constraintKinds}
decision_tags: ${decisionTags}
summary: ${summarizeText(memory.content, 240)}`;
    })
    .join("\n\n");
}

function buildFallbackBrief(task: string, memories: TaskSupportMemory[]): TaskBrief {
  const relatedFiles = collectEntities(memories, ["File"]);
  const relatedSymbols = collectEntities(memories, ["Module", "Function", "Class"]);
  const historicalDecisions = collectMemoryNotes(
    memories,
    (memory) =>
      hasEntityType(memory, "Decision") ||
      memory.memTypes.includes("fact") ||
      memory.memTypes.includes("file_knowledge"),
    MAX_DECISION_NOTES
  );
  const userPreferences = collectMemoryNotes(
    memories,
    (memory) => memory.memTypes.includes("profile"),
    MAX_PREFERENCE_NOTES
  );
  const constraintKinds = collectConstraintKinds(
    task,
    memories,
    historicalDecisions,
    userPreferences
  );
  const constraints = constraintKinds.map(mapConstraintKindToConstraintText);
  const risks = collectRiskNotes(memories);

  const successCriteria = uniqueStrings([
    `完成任务目标：${task}`,
    relatedFiles.length > 0 ? `改动范围优先收敛在：${relatedFiles.join(", ")}` : "",
    `验证本次修改没有破坏现有核心流程`,
    memories.some((memory) => memory.memTypes.length > 0)
      ? `确认新增实现与历史记忆中的约束保持一致`
      : "",
  ]).slice(0, MAX_SUCCESS_CRITERIA);

  return {
    taskGoal: task,
    relatedFiles,
    relatedSymbols,
    historicalDecisions,
    constraintKinds,
    constraints,
    userPreferences,
    risks,
    successCriteria,
  };
}

function buildFallbackChecklist(task: string, memories: TaskSupportMemory[]): CompletionChecklist {
  const brief = buildFallbackBrief(task, memories);
  const evidenceTemplates: EvidenceTemplate[] = [
    {
      type: "diff_summary",
      title: "Changed files summary",
      payload: "",
    },
    {
      type: "test_result",
      title: "Relevant test or smoke result",
      payload: "",
    },
    {
      type: "command_output",
      title: "Key verification command output",
      payload: "",
    },
  ];

  if (brief.relatedFiles.length > 0) {
    evidenceTemplates.push({
      type: "api_response",
      title: "Behavior check for affected path",
      payload: "",
    });
  }

  return {
    successCriteria: brief.successCriteria,
    verificationHints: uniqueStrings([
      brief.relatedFiles.length > 0
        ? `优先检查这些相关文件对应的路径：${brief.relatedFiles.join(", ")}`
        : "",
      `至少执行一次和任务最相关的测试或最小 smoke`,
      `记录关键命令输出，确保成功标准有对应证据`,
      ...collectMemoryNotes(
        memories,
        (memory) =>
          memory.memTypes.includes("tool_trace") || memory.memTypes.includes("experience"),
        2
      ).map((note) => `参考历史排查/实现记录：${note}`),
    ]),
    evidenceTemplates,
    remainingRisks: brief.risks,
  };
}

function collectRiskNotes(memories: TaskSupportMemory[]): string[] {
  const notes = collectMemoryNotes(
    memories,
    (memory) => hasEntityType(memory, "Issue") || memory.memTypes.includes("experience"),
    MAX_RISK_NOTES
  );

  return notes.length > 0 ? notes : ["尚未收集到明确的历史风险，需补最小验证闭环"];
}

function collectConstraintNotes(
  task: string,
  memories: TaskSupportMemory[],
  historicalDecisions: string[],
  userPreferences: string[]
): string[] {
  return collectConstraintKinds(task, memories, historicalDecisions, userPreferences).map(
    mapConstraintKindToConstraintText
  );
}

function containsConstraintSignal(sources: string[], pattern: RegExp): boolean {
  return sources.some((source) => pattern.test(source));
}

function collectConstraintKinds(
  task: string,
  memories: TaskSupportMemory[],
  historicalDecisions: string[],
  userPreferences: string[]
): ConstraintKind[] {
  const sources = [
    task,
    ...historicalDecisions,
    ...userPreferences,
    ...collectMemoryNotes(
      memories,
      (memory) =>
        hasEntityType(memory, "Decision") ||
        memory.memTypes.includes("profile") ||
        memory.memTypes.includes("file_knowledge"),
      MAX_DECISION_NOTES + MAX_PREFERENCE_NOTES
    ),
  ];

  const kinds = uniqueConstraintKinds(memories);

  if (
    !kinds.includes("preserve_db_schema") &&
    containsConstraintSignal(
      sources,
      /(不改|不修改|do not change|don't change).*(schema|表结构|数据库|db|migration)/i
    )
  ) {
    kinds.push("preserve_db_schema");
  }
  if (
    !kinds.includes("preserve_api_contract") &&
    containsConstraintSignal(sources, /(不改|不修改|do not change|don't change).*(api|接口)/i)
  ) {
    kinds.push("preserve_api_contract");
  }
  if (
    !kinds.includes("preserve_ui") &&
    containsConstraintSignal(
      sources,
      /(不改|不修改|do not change|don't change).*(ui|页面|前端|界面)/i
    )
  ) {
    kinds.push("preserve_ui");
  }
  if (
    !kinds.includes("no_new_table") &&
    containsConstraintSignal(
      sources,
      /(不新增|不要新增|do not add|don't add).*(表|schema|migration)/i
    )
  ) {
    kinds.push("no_new_table");
  }
  if (
    !kinds.includes("minimize_change") &&
    containsConstraintSignal(sources, /(最小改动|外科手术式修改|minimal change|surgical)/i)
  ) {
    kinds.push("minimize_change");
  }

  return uniqueConstraintKindValues(kinds);
}

function deriveConstraintKindsFromConstraints(constraints: string[]): ConstraintKind[] {
  const kinds: ConstraintKind[] = [];
  for (const constraint of constraints) {
    for (const kind of MEMORY_CONSTRAINT_KINDS) {
      if (constraint === mapConstraintKindToConstraintText(kind)) {
        kinds.push(kind);
        break;
      }
    }
  }
  return uniqueConstraintKindValues(kinds);
}

function collectMemoryNotes(
  memories: TaskSupportMemory[],
  predicate: (memory: TaskSupportMemory) => boolean,
  limit: number
): string[] {
  const notes: string[] = [];

  for (const memory of memories) {
    if (!predicate(memory)) {
      continue;
    }

    notes.push(summarizeText(memory.content, 140));
    if (notes.length >= limit) {
      break;
    }
  }

  return uniqueStrings(notes);
}

function collectEntities(memories: TaskSupportMemory[], entityTypes: MemoryEntityType[]): string[] {
  const matched = new Set<string>();

  for (const memory of memories) {
    for (const entity of memory.entities) {
      if (entityTypes.includes(entity.entity_type)) {
        matched.add(entity.entity);
      }
    }
  }

  return [...matched];
}

function hasEntityType(memory: TaskSupportMemory, entityType: MemoryEntityType): boolean {
  return memory.entities.some((entity) => entity.entity_type === entityType);
}

function normalizeMemTypes(input: unknown): CognitiveMemoryType[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is CognitiveMemoryType => VALID_MEM_TYPES.has(item));
}

function normalizeEntities(input: unknown): MemoryEntity[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.filter((item): item is MemoryEntity => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const candidate = item as MemoryEntity;
    return (
      typeof candidate.entity === "string" &&
      typeof candidate.entity_type === "string" &&
      VALID_ENTITY_TYPES.has(candidate.entity_type)
    );
  });
}

function normalizeConstraintKinds(input: unknown): ConstraintKind[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is ConstraintKind => VALID_CONSTRAINT_KINDS.has(item));
}

function normalizeDecisionTags(input: unknown): DecisionTag[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is DecisionTag => VALID_DECISION_TAGS.has(item));
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

function normalizeEvidenceTemplates(input: unknown): EvidenceTemplate[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((item): item is RawEvidenceTemplate => !!item && typeof item === "object")
    .map((item) => ({
      type: EVIDENCE_TYPES.includes(item.type as EvidenceType) ? (item.type as EvidenceType) : null,
      title: normalizeString(item.title),
      payload: normalizeString(item.payload),
    }))
    .filter((item): item is EvidenceTemplate => !!item.type && item.title.length > 0)
    .map((item) => ({
      type: item.type,
      title: item.title,
      payload: item.payload,
    }));
}

function uniqueConstraintKinds(memories: TaskSupportMemory[]): ConstraintKind[] {
  const kinds = new Set<ConstraintKind>();
  memories.forEach((memory) => memory.constraintKinds.forEach((kind) => kinds.add(kind)));
  return [...kinds];
}

function uniqueConstraintKindValues(values: ConstraintKind[]): ConstraintKind[] {
  return [...new Set(values)];
}

function mapConstraintKindToConstraintText(kind: ConstraintKind): string {
  switch (kind) {
    case "preserve_db_schema":
      return "不修改数据库结构";
    case "preserve_api_contract":
      return "不修改 API 接口";
    case "preserve_ui":
      return "不修改 UI";
    case "no_new_table":
      return "不新增表或 migration";
    case "minimize_change":
      return "改动范围保持最小";
  }
}

function summarizeText(input: string, maxLength: number): string {
  const text = input.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
