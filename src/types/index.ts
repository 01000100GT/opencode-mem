// 记忆类型标识符，用于区分不同种类的记忆实体
export type MemoryType = string;

// Phase 1 认知记忆类型枚举，写入 metadata.mem_types 供后续任务过程消费
export const MEMORY_MEM_TYPES = [
  "profile",
  "fact",
  "episodic",
  "experience",
  "skill",
  "tool_trace",
  "file_knowledge",
] as const;

// 认知记忆类型联合类型，对应需求文档中的固定枚举
export type CognitiveMemoryType = (typeof MEMORY_MEM_TYPES)[number];

// Phase 1 实体类型枚举，写入 metadata.entities 供后续 brief / recall 使用
export const MEMORY_ENTITY_TYPES = [
  "Project",
  "Module",
  "Technology",
  "Framework",
  "Library",
  "File",
  "Function",
  "Class",
  "Issue",
  "Decision",
] as const;

// 实体类型联合类型，对应需求文档中的固定枚举
export type MemoryEntityType = (typeof MEMORY_ENTITY_TYPES)[number];

// 结构化约束类型，用于把历史 Decision memory 中的硬约束稳定写入 metadata
export const MEMORY_CONSTRAINT_KINDS = [
  "preserve_db_schema",
  "preserve_api_contract",
  "preserve_ui",
  "no_new_table",
  "minimize_change",
] as const;

export type ConstraintKind = (typeof MEMORY_CONSTRAINT_KINDS)[number];

// 结构化决策标签，用于表达历史决策的稳定语义，而不是依赖自由文本
export const MEMORY_DECISION_TAGS = [
  "architecture_boundary",
  "compatibility",
  "scope_control",
  "verification_policy",
  "security_boundary",
] as const;

export type DecisionTag = (typeof MEMORY_DECISION_TAGS)[number];

// 结构化实体信息，存储被识别出的高价值项目实体
export interface MemoryEntity {
  entity: string;
  entity_type: MemoryEntityType;
}

// 记忆元数据接口，存储与记忆关联的上下文、来源、环境等扩展信息
export interface MemoryMetadata {
  // 记忆所属的分类类型，对应MemoryType定义的类型标识
  type?: MemoryType;
  // 记忆的生成来源：手动创建、系统自动捕获、外部导入、API接口生成
  source?: "manual" | "auto-capture" | "import" | "api";
  // 生成该记忆的工具名称，用于追溯记忆的产生工具链
  tool?: string;
  // 记忆所属的会话ID，关联同一会话周期内产生的所有记忆
  sessionID?: string;
  // 生成该记忆的推理过程描述，记录记忆产生的逻辑依据
  reasoning?: string;
  // 记忆被系统捕获的时间戳（毫秒级Unix时间）
  captureTimestamp?: number;
  // 关联的提示词ID，追溯记忆生成时使用的prompt标识
  promptId?: string;
  // Phase 1 新增的认知类型标签，允许单条记忆具备多个认知类型
  mem_types?: CognitiveMemoryType[];
  // Phase 1 新增的结构化实体列表，作为后续 recall / brief 的输入
  entities?: MemoryEntity[];
  // 结构化约束类型，作为 Completion Gate / Task Brief 约束推理的输入
  constraint_kinds?: ConstraintKind[];
  // 结构化决策标签，作为历史决策稳定语义的输入
  decision_tags?: DecisionTag[];
  // 记忆的展示名称，用于在UI界面友好显示
  displayName?: string;
  // 生成该记忆的用户名称，关联记忆的创建主体
  userName?: string;
  // 生成该记忆的用户邮箱，用于跨系统关联用户身份
  userEmail?: string;
  // 记忆生成时所在的本地项目绝对路径
  projectPath?: string;
  // 记忆生成时所属的项目名称，用于项目维度的记忆聚合
  projectName?: string;
  // 记忆关联的Git仓库地址，用于代码托管场景的项目溯源
  gitRepoUrl?: string;
  // 通用扩展字段，支持存储任意未预先定义的元数据属性
  [key: string]: unknown;
}

// AI服务提供商类型，定义系统支持的所有大模型服务渠道
export type AIProviderType = "openai-chat" | "openai-responses" | "anthropic";
