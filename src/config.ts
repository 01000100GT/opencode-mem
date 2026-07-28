import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripJsoncComments } from "./services/jsonc.js";
import { resolveSecretValue } from "./services/secret-resolver.js";
import { isPlaceholderApiKey } from "./services/ai/api-key-placeholder.js";
import { isDiagEnabled, truncateValue, diagLog, diagWarn } from "./services/logger.js";

const CONFIG_DIR = join(homedir(), ".config", "opencode");
const DATA_DIR = join(homedir(), ".opencode-mem");
const CONFIG_FILES = [
  join(CONFIG_DIR, "opencode-mem.jsonc"),
  join(CONFIG_DIR, "opencode-mem.json"),
];

if (!existsSync(CONFIG_DIR)) {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

interface OpenCodeMemConfig {
  storagePath?: string;
  userEmailOverride?: string;
  userNameOverride?: string;
  memory?: {
    defaultScope?: "project" | "all-projects";
  };
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  similarityThreshold?: number;
  maxMemories?: number;
  maxProfileItems?: number;
  injectProfile?: boolean;
  containerTagPrefix?: string;
  autoCaptureEnabled?: boolean;
  autoCaptureMaxIterations?: number;
  autoCaptureIterationTimeout?: number;
  autoCaptureMaxRetries?: number;
  autoCaptureLanguage?: string;
  memoryProvider?: "openai-chat" | "openai-responses" | "anthropic";
  memoryModel?: string;
  memoryApiUrl?: string;
  memoryApiKey?: string;
  memoryTemperature?: number | false;
  memoryExtraParams?: Record<string, unknown>;
  opencodeProvider?: string;
  opencodeModel?: string;
  vectorBackend?: "usearch-first" | "usearch" | "exact-scan";
  aiSessionRetentionDays?: number;
  webServerEnabled?: boolean;
  webServerPort?: number;
  webServerHost?: string;
  webServerAuthPassword?: string;
  webServerAuthUsername?: string;
  maxVectorsPerShard?: number;
  autoCleanupEnabled?: boolean;
  autoCleanupRetentionDays?: number;
  deduplicationEnabled?: boolean;
  deduplicationSimilarityThreshold?: number;
  userProfileAnalysisInterval?: number;
  userProfileMaxContextBytes?: number;
  userProfileDisplayPreferences?: number;
  userProfileDisplayPatterns?: number;
  userProfileDisplayWorkflows?: number;
  userProfileStaleDays?: number;
  userProfileInjectPreferences?: number;
  userProfileInjectPatterns?: number;
  userProfileInjectWorkflows?: number;
  userProfileConfidenceDecayDays?: number;
  userProfileChangelogRetentionCount?: number;
  userProfileEmbeddingThresholdSameCat?: number;
  userProfileEmbeddingThresholdSameCatWeak?: number;
  userProfileEmbeddingThresholdCrossCat?: number;
  userProfileEmbeddingThresholdCrossCatWeak?: number;
  userProfileCentroidDriftThreshold?: number;
  userProfileEmbeddingMinDescriptionLength?: number;
  userProfileMinEvidenceForRetention?: number;
  userProfileValidationEnabled?: boolean;
  showAutoCaptureToasts?: boolean;
  showUserProfileToasts?: boolean;
  showErrorToasts?: boolean;
  compaction?: {
    enabled?: boolean;
    memoryLimit?: number;
  };
  chatMessage?: {
    enabled?: boolean;
    maxMemories?: number;
    excludeCurrentSession?: boolean;
    maxAgeDays?: number;
    injectOn?: "first" | "always";
  };
}

const DEFAULTS: Required<
  Omit<
    OpenCodeMemConfig,
    | "embeddingApiUrl"
    | "embeddingApiKey"
    | "memoryModel"
    | "memoryApiUrl"
    | "memoryApiKey"
    | "memoryProvider"
    | "memoryTemperature"
    | "memoryExtraParams"
    | "opencodeProvider"
    | "opencodeModel"
    | "autoCaptureLanguage"
    | "userEmailOverride"
    | "userNameOverride"
    | "webServerAuthPassword"
    | "webServerAuthUsername"
  >
> & {
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  memoryModel?: string;
  memoryApiUrl?: string;
  memoryApiKey?: string;
  memoryProvider?: "openai-chat" | "openai-responses" | "anthropic";
  memoryTemperature?: number | false;
  memoryExtraParams?: Record<string, unknown>;
  opencodeProvider?: string;
  opencodeModel?: string;
  vectorBackend?: "usearch-first" | "usearch" | "exact-scan";
  autoCaptureLanguage?: string;
  userEmailOverride?: string;
  userNameOverride?: string;
  webServerAuthPassword?: string;
  webServerAuthUsername?: string;
  memory?: {
    defaultScope?: "project" | "all-projects";
  };
} = {
  storagePath: join(DATA_DIR, "data"),
  embeddingModel: "Xenova/nomic-embed-text-v1",
  embeddingDimensions: 768,
  similarityThreshold: 0.6,
  maxMemories: 10,
  maxProfileItems: 5,
  injectProfile: true,
  containerTagPrefix: "opencode",
  autoCaptureEnabled: true,
  autoCaptureMaxIterations: 5,
  autoCaptureIterationTimeout: 30000,
  autoCaptureMaxRetries: 3,
  vectorBackend: "usearch-first",
  aiSessionRetentionDays: 7,
  webServerEnabled: true,
  webServerPort: 4747,
  webServerHost: "127.0.0.1",
  webServerAuthPassword: undefined,
  webServerAuthUsername: undefined,
  maxVectorsPerShard: 50000,
  autoCleanupEnabled: true,
  autoCleanupRetentionDays: 30,
  deduplicationEnabled: true,
  deduplicationSimilarityThreshold: 0.9,
  userProfileAnalysisInterval: 10,
  userProfileMaxContextBytes: 32768,
  userProfileDisplayPreferences: 20,
  userProfileDisplayPatterns: 15,
  userProfileDisplayWorkflows: 10,
  userProfileStaleDays: 2,
  userProfileInjectPreferences: 5,
  userProfileInjectPatterns: 5,
  userProfileInjectWorkflows: 3,
  userProfileConfidenceDecayDays: 30,
  userProfileChangelogRetentionCount: 5,
  userProfileEmbeddingThresholdSameCat: 0.8,
  userProfileEmbeddingThresholdSameCatWeak: 0.5,
  userProfileEmbeddingThresholdCrossCat: 0.9,
  userProfileEmbeddingThresholdCrossCatWeak: 0.8,
  userProfileCentroidDriftThreshold: 0.65,
  userProfileEmbeddingMinDescriptionLength: 5,
  userProfileMinEvidenceForRetention: 3,
  userProfileValidationEnabled: false,
  showAutoCaptureToasts: true,
  showUserProfileToasts: true,
  showErrorToasts: true,
  memory: {
    defaultScope: "project",
  },
  compaction: {
    enabled: true,
    memoryLimit: 10,
  },
  chatMessage: {
    enabled: true,
    maxMemories: 3,
    excludeCurrentSession: true,
    maxAgeDays: undefined,
    injectOn: "first",
  },
};

function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  if (path === "~") {
    return homedir();
  }
  return path;
}

function loadConfigFromPaths(paths: string[]): OpenCodeMemConfig {
  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        const json = stripJsoncComments(content);
        const parsed = JSON.parse(json) as OpenCodeMemConfig;

        if (isDiagEnabled()) {
          const keys = Object.keys(parsed).length;
          diagLog("config.ts:loadConfigFromPaths", "loaded", { path, keys });
        }

        return parsed;
      } catch (err: unknown) {
        if (isDiagEnabled()) {
          const msg = err instanceof Error ? err.message : String(err);
          diagWarn("config.ts:loadConfigFromPaths", "parse failed — silently swallowed", {
            path,
            error: msg.substring(0, 200),
          });
        }
      }
    } else if (isDiagEnabled()) {
      diagLog("config.ts:loadConfigFromPaths", "file not found", { path });
    }
  }
  if (isDiagEnabled()) {
    diagLog("config.ts:loadConfigFromPaths", "no config files found — returning empty");
  }
  return {};
}

const CONFIG_TEMPLATE = `{
  // ============================================
  // OpenCode Memory Plugin Configuration
  // ============================================
  
  // Storage location for vector database
  "storagePath": "~/.opencode-mem/data",

  "userEmailOverride": "",
  "userNameOverride": "",
  
  // ============================================
  // Embedding Model (for similarity search)
  // ============================================
  
  // Default: Nomic Embed v1 (768 dimensions, 8192 context, multilingual)
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  
  // Auto-detected dimensions (no need to set manually)
  // "embeddingDimensions": 768,
  
  // Other recommended models:
  // "embeddingModel": "Xenova/jina-embeddings-v2-base-en",  // 768 dims, English-only, 8192 context
  // "embeddingModel": "Xenova/jina-embeddings-v2-small-en", // 512 dims, faster, 8192 context
  // "embeddingModel": "Xenova/all-MiniLM-L6-v2",            // 384 dims, very fast, 512 context
  // "embeddingModel": "Xenova/all-mpnet-base-v2",           // 768 dims, good quality, 512 context
  
  // Optional: Use OpenAI-compatible API for embeddings
  // "embeddingApiUrl": "https://api.openai.com/v1",
  // "embeddingApiKey": "sk-...",
  // "embeddingModel": "text-embedding-3-small",  // 1536 dims, auto-detected
  
  // ============================================
  // Web Server Settings
  // ============================================
  
  // Enable web UI for managing memories (accessible at http://localhost:4747)
  "webServerEnabled": true,
  
  // Port for web UI server
  "webServerPort": 4747,
  
  // Host address for web UI (use 127.0.0.1 for local only, 0.0.0.0 for network access)
  "webServerHost": "127.0.0.1",

  // HTTP Basic Auth for the web UI (recommended whenever webServerHost != 127.0.0.1).
  // Leave webServerAuthPassword unset to keep the UI open (the previous default).
  // When set, the server demands HTTP Basic Auth credentials on every request.
  // The browser's native Basic Auth dialog handles the prompt; closing the
  // browser discards the cached credentials, so reopening requires signing in again.
  // Accepts the same secret formats as memoryApiKey:
  //   "literal-value"           direct plaintext
  //   "env://SOME_ENV_VAR"      resolved from an environment variable
  //   "file:///path/to/secret"  read from a file (chmod 600 recommended)
  // "webServerAuthPassword": "",
  // "webServerAuthUsername": "",
  
  // ============================================
  // Database Settings
  // ============================================
  
  // Maximum vectors per database shard (auto-creates new shard when limit reached)
  "maxVectorsPerShard": 50000,
  
  // Automatically delete old memories based on retention period
  "autoCleanupEnabled": true,
  
  // Days to keep memories before auto-cleanup (only if autoCleanupEnabled is true)
  "autoCleanupRetentionDays": 30,
  
  // Automatically detect and remove duplicate memories
  "deduplicationEnabled": true,
  
   // Similarity threshold (0-1) for detecting duplicates (higher = stricter)
   "deduplicationSimilarityThreshold": 0.90,
   
  // ============================================
  // Memory Scope Settings
  // ============================================

  // Default scope for memory list/search queries
  // "project" keeps queries within the current project, "all-projects" searches across all project shards
  "memory": {
    "defaultScope": "project"
  },

  // ============================================
  // OpenCode Provider Settings (RECOMMENDED)
  // ============================================

   // Use any provider that is already authenticated in opencode for auto-capture
   // and user profile learning. The plugin calls opencode's session.prompt API
   // (with structured output) instead of talking to provider HTTPS endpoints
   // directly, so opencode owns the auth, token refresh, and provider routing.
   //
   // No separate API key is needed in this plugin — whatever you configured in
   // opencode (OAuth like Claude Pro/Max, GitHub Copilot personal/business,
   // bring-your-own API key, custom provider, ...) just works.
   //
   // If NOT set, falls back to the manual config (memoryApiKey/memoryApiUrl/memoryModel below).
   //
   // Examples (the provider name must be one returned by 'opencode providers list'):
   //   Anthropic (OAuth/API key): "opencodeProvider": "anthropic",      "opencodeModel": "claude-haiku-4-5-20251001"
   //   OpenAI (API key):          "opencodeProvider": "openai",          "opencodeModel": "gpt-4o-mini"
   //   GitHub Copilot:            "opencodeProvider": "github-copilot",  "opencodeModel": "gpt-4o-mini"
   //
   // "opencodeProvider": "anthropic",
   // "opencodeModel": "claude-haiku-4-5-20251001",

   // ============================================
   // Auto-Capture Settings
   // ============================================
  
  // IMPORTANT: Auto-capture only runs after either opencodeProvider/opencodeModel
  // above is configured, or the manual fallback below is uncommented with real values.
  // It runs in background without blocking your main session
  // Note: Ollama may not support tool calling. Use OpenAI, Anthropic, or Groq for best results.
  
  "autoCaptureEnabled": true,
  
  // Provider type: "openai-chat" | "openai-responses" | "anthropic"
  // Note: "openai-chat" is a generic OpenAI API-compatible mode.
  // Any service that follows the OpenAI Chat Completions API can use it via custom "memoryApiUrl".
  "memoryProvider": "openai-chat",
  
  // Manual fallback. Uncomment all 3 lines and replace memoryApiKey before use:
  // "memoryModel": "gpt-4o-mini",
  // "memoryApiUrl": "https://api.openai.com/v1",
  // "memoryApiKey": "sk-...",

  // API Key Formats:
  // Direct value:        "sk-..."
  // From file:           "file://~/.config/litellm-key.txt"
  // From env variable:   "env://LITELLM_API_KEY"
  
  // Examples for different providers:
  // Any OpenAI-compatible endpoint can use the "openai-chat" provider pattern below.
  // Common examples: DeepSeek, Qwen (via Alibaba Cloud ModelStudio),
  // Zhipu GLM (BigModel platform), and Kimi (Moonshot AI platform).

  // OpenAI Chat Completion (default, backward compatible):
  //   "memoryProvider": "openai-chat"
  //   "memoryModel": "gpt-4o-mini"
  //   "memoryApiUrl": "https://api.openai.com/v1"
  //   "memoryApiKey": "sk-..."

  // DeepSeek (OpenAI-compatible example):
  //   "memoryProvider": "openai-chat"
  //   "memoryModel": "deepseek-chat"
  //   "memoryApiUrl": "https://api.deepseek.com/v1"
  //   "memoryApiKey": "sk-..."
  
  // OpenAI Responses API (recommended, with session support):
  //   "memoryProvider": "openai-responses"
  //   "memoryModel": "gpt-4o"
  //   "memoryApiUrl": "https://api.openai.com/v1"
  //   "memoryApiKey": "sk-..."
  
  // Anthropic (with session support):
  //   "memoryProvider": "anthropic"
  //   "memoryModel": "claude-3-5-haiku-20241022"
  //   "memoryApiUrl": "https://api.anthropic.com/v1"
  //   "memoryApiKey": "sk-ant-..."
  
  // Groq (OpenAI-compatible, use openai-chat provider):
  //   "memoryProvider": "openai-chat"
  //   "memoryModel": "llama-3.3-70b-versatile"
  //   "memoryApiUrl": "https://api.groq.com/openai/v1"
  //   "memoryApiKey": "gsk_..."
  
  // Maximum iterations for multi-turn AI analysis (for openai-responses and anthropic)
  "autoCaptureMaxIterations": 5,
   
  // Timeout per iteration in milliseconds (30 seconds default)
  "autoCaptureIterationTimeout": 30000,

  // Maximum number of times to retry capturing a prompt if it fails (due to network, API errors, etc.)
  "autoCaptureMaxRetries": 3,
   
  // Days to keep AI session history before cleanup
  "aiSessionRetentionDays": 7,

  // Temperature for AI API requests (set to false to omit parameter for models that don't support it)
  // Some reasoning models (like o1, o3, gpt-5) don't support temperature parameter
  // Set to false and add "memoryTemperature": false in config when using such models
  "memoryTemperature": 0.3,

  // Extra parameters to include in API request body
  // Useful for local inference servers (e.g. llama-server with --jinja) that support
  // additional parameters like disabling thinking/reasoning mode
  // Example for Qwen3 models: { "enable_thinking": false }
  // "memoryExtraParams": {},

  // Language for auto-capture summaries (default: "auto" for auto-detection)
  // Options: "auto", "en", "id", "zh", "ja", "es", "fr", "de", "ru", "pt", "ar", "ko"
  // "autoCaptureLanguage": "auto",

  // ============================================
  // Toast Notifications
  // ============================================

  // Show toast when memory is auto-captured
  "showAutoCaptureToasts": true,

  // Show toast when user profile is updated
  "showUserProfileToasts": true,

  // Show toast for error messages
  "showErrorToasts": true,

  // ============================================
  // User Profile System
  // ============================================

  // Analyze user prompts every N prompts to build/update your user profile
  // When N uncaptured prompts accumulate, AI will analyze them to identify:
  // - User preferences (code style, communication style, tool preferences)
  // - User patterns (recurring topics, problem domains, technical interests)
  // - User workflows (development habits, sequences, learning style)
  // - Skill level (overall and per-domain assessment)
  "userProfileAnalysisInterval": 10,

  // Days before inactive items (all types) are eligible for removal
  "userProfileStaleDays": 2,

  // Number of preferences shown in UI
  "userProfileDisplayPreferences": 20,
  
  // Number of patterns shown in UI
  "userProfileDisplayPatterns": 15,
  
  // Number of workflows shown in UI
  "userProfileDisplayWorkflows": 10,
  
  // Number of preferences injected into LLM conversation context
  // Keep this small — the strongest signals are enough; more dilute LLM attention
  "userProfileInjectPreferences": 5,
  
  // Number of patterns injected into LLM conversation context
  "userProfileInjectPatterns": 5,
  
  // Number of workflows injected into LLM conversation context
  "userProfileInjectWorkflows": 3,
  
  // Days before preference confidence starts to decay (if not reinforced)
  // Preferences that aren't seen again will gradually lose confidence and be removed
  "userProfileConfidenceDecayDays": 30,
  
  // Number of profile versions to keep in changelog (for rollback/debugging)
  // Older versions are automatically cleaned up
  "userProfileChangelogRetentionCount": 5,

  // Minimum evidence count for a preference/pattern to survive confidence decay
  // Items confirmed fewer times are more likely to be pruned when confidence decays
  "userProfileMinEvidenceForRetention": 3,

  // Enable LLM validation of existing preferences against recent behavior.
  // When enabled, each analysis round checks if top-5 preferences still match recent prompts.
  // Experimental — disabled by default.
  "userProfileValidationEnabled": false,

  // ============================================
  // Search Settings
  // ============================================
  
  // Minimum similarity score (0-1) for memory search results
  "similarityThreshold": 0.6,

  // Maximum number of memories to return in search results
  "maxMemories": 10,

  // ============================================
  // Advanced Settings
  // ============================================
  
  // Inject user profile into AI context (preferences, patterns, workflows)
  "injectProfile": true
}
`;

function ensureConfigExists(): void {
  const configPath = join(CONFIG_DIR, "opencode-mem.jsonc");

  if (!existsSync(configPath)) {
    try {
      writeFileSync(configPath, CONFIG_TEMPLATE, "utf-8");
      console.log(`\n✓ Created config template: ${configPath}`);
      console.log("  Edit this file to customize opencode-mem settings.\n");
      if (isDiagEnabled()) {
        diagLog("config.ts:ensureConfigExists", "template written", { path: configPath });
      }
    } catch (err: unknown) {
      if (isDiagEnabled()) {
        const msg = err instanceof Error ? err.message : String(err);
        diagWarn("config.ts:ensureConfigExists", "template write failed — silently swallowed", {
          path: configPath,
          error: msg.substring(0, 200),
        });
      }
    }
  }
}

ensureConfigExists();

function getEmbeddingDimensions(model: string): number {
  const dimensionMap: Record<string, number> = {
    // Local Xenova models
    "Xenova/nomic-embed-text-v1": 768,
    "Xenova/nomic-embed-text-v1-unsupervised": 768,
    "Xenova/nomic-embed-text-v1-ablated": 768,
    "Xenova/jina-embeddings-v2-base-en": 768,
    "Xenova/jina-embeddings-v2-base-zh": 768,
    "Xenova/jina-embeddings-v2-base-de": 768,
    "Xenova/jina-embeddings-v2-small-en": 512,
    "Xenova/all-MiniLM-L6-v2": 384,
    "Xenova/all-MiniLM-L12-v2": 384,
    "Xenova/all-mpnet-base-v2": 768,
    "Xenova/bge-base-en-v1.5": 768,
    "Xenova/bge-small-en-v1.5": 384,
    "Xenova/gte-small": 384,
    "Xenova/GIST-small-Embedding-v0": 384,
    "Xenova/text-embedding-ada-002": 1536,

    // OpenAI API models
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,

    // Cohere API models
    "embed-english-v3.0": 1024,
    "embed-multilingual-v3.0": 1024,
    "embed-english-light-v3.0": 384,
    "embed-multilingual-light-v3.0": 384,

    // Google API models
    "text-embedding-004": 768,
    "text-multilingual-embedding-002": 768,

    // Voyage AI models
    "voyage-3": 1024,
    "voyage-3-lite": 512,
    "voyage-code-3": 1024,
  };
  return dimensionMap[model] || 768;
}

// 构建完整的运行时配置对象，将用户配置与默认值合并并完成必要的预处理
function buildConfig(fileConfig: OpenCodeMemConfig) {
  // 解析内存API密钥的秘密值，支持从环境变量、本地文件等多种方式读取密钥
  const memoryApiKey = resolveSecretValue(fileConfig.memoryApiKey);

  return {
    // 向量数据库存储路径：先使用用户配置的路径，缺失时 fallback 到默认路径，同时解析路径中的 ~ 为用户家目录绝对路径
    storagePath: expandPath(fileConfig.storagePath ?? DEFAULTS.storagePath),
    // 用户邮箱覆写配置：直接透传用户配置的自定义邮箱，未配置则保持 undefined 用于系统后续获取默认用户信息
    userEmailOverride: fileConfig.userEmailOverride,
    // 用户名称覆写配置：直接透传用户配置的自定义用户名，未配置则保持 undefined 用于系统后续获取默认用户信息
    userNameOverride: fileConfig.userNameOverride,
    // 嵌入模型名称：优先使用用户自定义的嵌入模型，缺失时使用默认的开源嵌入模型以保证功能开箱可用
    embeddingModel: fileConfig.embeddingModel ?? DEFAULTS.embeddingModel,
    // 嵌入向量维度：优先使用用户配置的维度，未配置则根据模型名自动查询匹配的标准维度，保证不同模型的维度兼容性
    embeddingDimensions:
      fileConfig.embeddingDimensions ??
      getEmbeddingDimensions(fileConfig.embeddingModel ?? DEFAULTS.embeddingModel),
    // 嵌入API的自定义接口地址：直接透传用户配置的自定义服务地址，用于对接私有部署或第三方兼容API端点
    embeddingApiUrl: fileConfig.embeddingApiUrl,
    // 嵌入API的访问密钥：仅当配置了自定义API地址时才解析密钥，支持从环境变量读取OPENAI_API_KEY作为兜底，未配置自定义地址则返回undefined
    embeddingApiKey: fileConfig.embeddingApiUrl
      ? resolveSecretValue(fileConfig.embeddingApiKey ?? process.env.OPENAI_API_KEY)
      : undefined,
    // 记忆检索的最低相似度阈值：用户未配置时使用默认值，控制召回结果的相关性筛选严格度
    similarityThreshold: fileConfig.similarityThreshold ?? DEFAULTS.similarityThreshold,
    // 单次搜索返回的最大记忆数量：优先使用用户配置值，未配置则 fallback 到默认上限，控制上下文注入的信息量
    maxMemories: fileConfig.maxMemories ?? DEFAULTS.maxMemories,
    // 用户档案中保留的最大条目数量：用户未配置时使用默认值，平衡档案完整性与LLM上下文负载
    maxProfileItems: fileConfig.maxProfileItems ?? DEFAULTS.maxProfileItems,
    // 是否将用户档案注入大模型对话上下文：用户未配置时默认启用，让AI持续感知用户的偏好、模式与工作流
    injectProfile: fileConfig.injectProfile ?? DEFAULTS.injectProfile,
    // 向量数据库中记忆容器的统一前缀：用户未配置时使用默认前缀，实现多租户/多场景的记忆数据隔离
    containerTagPrefix: fileConfig.containerTagPrefix ?? DEFAULTS.containerTagPrefix,
    // 自动记忆捕获功能总开关：优先使用用户配置的启用状态，未配置则 fallback 到默认值，全局控制后台记忆抓取逻辑的启停
    autoCaptureEnabled: fileConfig.autoCaptureEnabled ?? DEFAULTS.autoCaptureEnabled,
    // 多轮AI分析的最大迭代次数：支持openai-responses和anthropic的会话式模型，限制单条记忆捕获的最大对话轮次，防止无限循环消耗资源
    autoCaptureMaxIterations:
      fileConfig.autoCaptureMaxIterations ?? DEFAULTS.autoCaptureMaxIterations,
    // 单轮AI分析的超时时间：单位为毫秒，默认30秒，避免因API响应缓慢阻塞后台捕获任务队列
    autoCaptureIterationTimeout:
      fileConfig.autoCaptureIterationTimeout ?? DEFAULTS.autoCaptureIterationTimeout,
    // 捕获失败的最大重试次数：针对网络波动、API临时限流等 transient 错误，自动重试提升捕获成功率，超过次数则放弃该条记忆
    autoCaptureMaxRetries: fileConfig.autoCaptureMaxRetries ?? DEFAULTS.autoCaptureMaxRetries,
    // 自动捕获摘要的输出语言配置：直接透传用户设置的语言参数，支持en/zh/ja等多语言，未配置则由AI自动检测输入语言生成摘要
    autoCaptureLanguage: fileConfig.autoCaptureLanguage,
    // 记忆推理服务的提供商类型：优先使用用户配置的提供商，未配置则默认采用openai-chat兼容模式，限定仅支持三种主流API架构
    memoryProvider: (fileConfig.memoryProvider ?? "openai-chat") as
      | "openai-chat" // 标准OpenAI聊天补全API兼容模式，适配绝大多数兼容OpenAI协议的第三方服务
      | "openai-responses" // OpenAI官方Responses API模式，支持原生多轮会话管理与状态保持
      | "anthropic", // Anthropic克劳德系列模型专属API模式，适配其独特的消息格式与会话控制能力
    // 记忆推理所用的具体模型名称：透传用户配置的模型标识符，用于调用对应提供商的具体推理模型
    memoryModel: fileConfig.memoryModel,
    // 记忆推理服务的API端点地址：透传用户配置的自定义服务地址，支持对接私有部署或第三方代理节点
    memoryApiUrl: fileConfig.memoryApiUrl,
    // 解析完成的记忆API访问密钥：使用resolveSecretValue处理后的最终密钥，已支持环境变量、本地文件等多来源解析
    memoryApiKey,
    // 记忆推理的温度系数配置：透传用户配置的温度值，设为false时可跳过温度参数传递，适配不支持该参数的推理模型
    memoryTemperature: fileConfig.memoryTemperature,
    memoryExtraParams: fileConfig.memoryExtraParams, // 记忆推理API请求的额外自定义参数：透传用户配置的请求体扩展字段，支持为本地部署或特殊推理模型传递专属参数（如禁用思考模式、设置生成策略等）
    opencodeProvider: fileConfig.opencodeProvider, // OpenCode内置提供商名称：优先使用用户配置的已认证opencode服务商，依托opencode原生会话能力完成AI分析，无需单独配置API密钥
    opencodeModel: fileConfig.opencodeModel, // OpenCode内置推理模型标识：配合opencodeProvider使用的具体模型标识符，需与opencode服务商支持的模型名称完全匹配
    // 自动捕获功能的提供商状态：调用状态检测函数获取配置就绪情况，返回是否可用及具体模式/问题
    autoCaptureProviderStatus: getAutoCaptureProviderStatus({
      // 传入全局配置中配置的OpenCode内置服务商名称，用于原生集成的AI分析认证
      opencodeProvider: fileConfig.opencodeProvider,
      // 传入全局配置中配置的OpenCode内置推理模型标识，确保调用的模型与服务商支持的一致
      opencodeModel: fileConfig.opencodeModel,
      // 传入手动模式下配置的推理模型名称，用于对接第三方OpenAI兼容API端点
      memoryModel: fileConfig.memoryModel,
      // 传入手动模式下配置的记忆推理服务API端点地址，支持自定义私有部署节点
      memoryApiUrl: fileConfig.memoryApiUrl,
      // 传入解析完成的记忆API访问密钥，已完成环境变量/本地文件等多来源的解析处理
      memoryApiKey,
    }),
    // 向量数据库后端选择：优先使用用户配置的后端类型，未配置时默认采用"usearch-first"模式
    // 支持的三种后端模式：
    // "usearch-first"：优先尝试使用usearch向量库，若加载失败自动降级到精确扫描
    // "usearch"：强制使用usearch向量库，加载失败将抛出致命错误终止进程
    // "exact-scan"：全程使用暴力精确扫描，不依赖任何第三方向量加速库，兼容性最强但性能最低
    vectorBackend: (fileConfig.vectorBackend ?? "usearch-first") as
      | "usearch-first"
      | "usearch"
      | "exact-scan",
    // AI会话记录的保留天数：优先使用用户配置值，未配置则采用默认保留周期，自动清理超时的历史会话数据，节省存储空间
    aiSessionRetentionDays: fileConfig.aiSessionRetentionDays ?? DEFAULTS.aiSessionRetentionDays,
    // Web UI服务器的启用状态：用户未配置时默认开启，控制可视化管理界面的服务启停，提供记忆管理的图形化操作入口
    webServerEnabled: fileConfig.webServerEnabled ?? DEFAULTS.webServerEnabled,
    // Web服务器的监听端口：优先使用用户自定义端口，未配置则采用默认端口4747，确保UI服务与系统其他端口无冲突
    webServerPort: fileConfig.webServerPort ?? DEFAULTS.webServerPort,
    // Web服务器的绑定主机地址：默认绑定本地回环地址127.0.0.1仅允许本机访问，配置为0.0.0.0可开放局域网内访问权限
    webServerHost: fileConfig.webServerHost ?? DEFAULTS.webServerHost,
    // Web UI访问密码：解析认证密码的秘密值，支持从环境变量、本地文件等多种安全方式读取配置
    webServerAuthPassword: resolveSecretValue(fileConfig.webServerAuthPassword),
    // Web UI访问用户名：透传用户配置的HTTP Basic Auth用户名，未配置则保持undefined
    webServerAuthUsername: fileConfig.webServerAuthUsername,
    // 每个数据库分片的最大向量存储数量：优先使用用户配置的分片阈值，未配置则 fallback 到默认值，控制单分片的数据规模避免性能衰减
    maxVectorsPerShard: fileConfig.maxVectorsPerShard ?? DEFAULTS.maxVectorsPerShard,
    // 数据库自动清理功能的启用状态：优先使用用户配置的清理开关，未配置则默认开启，自动清除超期的记忆数据释放存储空间
    autoCleanupEnabled: fileConfig.autoCleanupEnabled ?? DEFAULTS.autoCleanupEnabled,
    // 自动清理的记忆保留天数：优先使用用户配置的保留周期，未配置则采用系统默认值，控制超期记忆的自动清理阈值
    autoCleanupRetentionDays:
      fileConfig.autoCleanupRetentionDays ?? DEFAULTS.autoCleanupRetentionDays,
    // 记忆去重功能的启用状态：优先使用用户配置的开关状态，未配置则默认开启，自动识别并移除重复的记忆条目
    deduplicationEnabled: fileConfig.deduplicationEnabled ?? DEFAULTS.deduplicationEnabled,
    // 去重判断的相似度阈值：优先使用用户配置的阈值，未配置则采用系统默认值，数值越高判定重复的条件越严格
    deduplicationSimilarityThreshold:
      fileConfig.deduplicationSimilarityThreshold ?? DEFAULTS.deduplicationSimilarityThreshold,
    // 用户档案分析的触发间隔：优先使用用户配置的间隔值，未配置则采用默认间隔，每积累指定数量的未分析prompt就触发一次用户档案更新
    userProfileAnalysisInterval:
      fileConfig.userProfileAnalysisInterval ?? DEFAULTS.userProfileAnalysisInterval,
    // 用户档案上下文最大字节数限制：优先使用用户配置值，未配置则采用系统默认值，控制注入到LLM上下文的用户档案总体大小，避免占用过多tokens
    userProfileMaxContextBytes:
      fileConfig.userProfileMaxContextBytes ?? DEFAULTS.userProfileMaxContextBytes,
    // 用户界面中展示的用户偏好数量上限：优先使用用户配置值，未配置则fallback到默认值，控制UI端偏好列表的展示长度，平衡信息完整性与界面可读性
    userProfileDisplayPreferences:
      fileConfig.userProfileDisplayPreferences ?? DEFAULTS.userProfileDisplayPreferences,
    // 用户界面中展示的用户行为模式数量上限：优先使用用户配置值，未配置则fallback到默认值，控制UI端行为模式列表的展示长度，确保核心模式突出展示
    userProfileDisplayPatterns:
      fileConfig.userProfileDisplayPatterns ?? DEFAULTS.userProfileDisplayPatterns,
    // 用户界面中展示的工作流数量上限：优先使用用户配置值，未配置则fallback到默认值，控制UI端工作流列表的展示长度，确保核心工作流清晰呈现
    userProfileDisplayWorkflows:
      fileConfig.userProfileDisplayWorkflows ?? DEFAULTS.userProfileDisplayWorkflows,
    // 注入到LLM对话上下文的用户偏好数量：优先使用用户配置值，未配置则使用默认值，通过控制注入数量保持上下文简洁性，避免过多信息分散模型注意力
    userProfileInjectPreferences:
      fileConfig.userProfileInjectPreferences ?? DEFAULTS.userProfileInjectPreferences,
    // 注入到LLM对话上下文的用户行为模式数量：优先使用用户配置值，未配置则使用默认值，仅将最具代表性的行为模式注入上下文，保证核心行为特征有效传递
    userProfileInjectPatterns:
      fileConfig.userProfileInjectPatterns ?? DEFAULTS.userProfileInjectPatterns,
    // 注入到LLM对话上下文的工作流数量：优先使用用户配置值，未配置则使用默认值，仅注入最核心的工作流程，维持上下文信息密度的合理性
    userProfileInjectWorkflows:
      fileConfig.userProfileInjectWorkflows ?? DEFAULTS.userProfileInjectWorkflows,
    // 用户偏好置信度衰减阈值：如果偏好长期未被强化，经过该天数后置信度开始衰减，优先使用用户配置，未配置则使用系统默认值
    userProfileConfidenceDecayDays:
      fileConfig.userProfileConfidenceDecayDays ?? DEFAULTS.userProfileConfidenceDecayDays,
    // 用户档案变更日志保留数量：控制回滚/调试用的历史版本数，超过限制后自动清理旧版本，优先使用用户配置，未配置则使用默认值
    userProfileChangelogRetentionCount:
      fileConfig.userProfileChangelogRetentionCount ?? DEFAULTS.userProfileChangelogRetentionCount,
    // 同类别向量强匹配阈值：用于判断同一分类下两个嵌入向量是否高度相似，优先使用用户配置，未配置则回退到默认值
    userProfileEmbeddingThresholdSameCat:
      fileConfig.userProfileEmbeddingThresholdSameCat ??
      DEFAULTS.userProfileEmbeddingThresholdSameCat,
    // 同类别向量弱匹配阈值：用于判断同一分类下两个嵌入向量是否存在弱关联，优先使用用户配置，未配置则回退到默认值
    userProfileEmbeddingThresholdSameCatWeak:
      fileConfig.userProfileEmbeddingThresholdSameCatWeak ??
      DEFAULTS.userProfileEmbeddingThresholdSameCatWeak,
    // 跨类别向量匹配阈值：用于判断不同分类下两个嵌入向量是否存在高度关联，优先使用用户配置，未配置则回退到默认值
    userProfileEmbeddingThresholdCrossCat:
      fileConfig.userProfileEmbeddingThresholdCrossCat ??
      DEFAULTS.userProfileEmbeddingThresholdCrossCat,
    // 跨类别向量弱匹配阈值：用于判断不同分类下两个嵌入向量是否存在弱关联，优先使用用户配置，未配置则回退到默认值
    userProfileEmbeddingThresholdCrossCatWeak:
      fileConfig.userProfileEmbeddingThresholdCrossCatWeak ??
      DEFAULTS.userProfileEmbeddingThresholdCrossCatWeak,
    // 用户档案质心漂移阈值：控制用户偏好中心向量的最大变化幅度，超过阈值则认为用户兴趣发生显著转移，优先使用用户配置，未配置则回退到默认值
    userProfileCentroidDriftThreshold:
      fileConfig.userProfileCentroidDriftThreshold ?? DEFAULTS.userProfileCentroidDriftThreshold,
    // 嵌入描述文本最小长度：限制用于生成嵌入向量的描述文本长度下限，过短的文本会被过滤以保证嵌入质量，优先使用用户配置，未配置则回退到默认值
    userProfileEmbeddingMinDescriptionLength:
      fileConfig.userProfileEmbeddingMinDescriptionLength ??
      DEFAULTS.userProfileEmbeddingMinDescriptionLength,
    // 用户档案条目留存的最小证据数量：优先使用用户配置值，未配置则使用系统默认值，仅保留被多次验证的特征防止误判留存无效数据
    userProfileMinEvidenceForRetention:
      fileConfig.userProfileMinEvidenceForRetention ?? DEFAULTS.userProfileMinEvidenceForRetention,
    // 用户档案偏好验证功能的启用状态：优先使用用户配置值，未配置则默认关闭实验性的验证逻辑，仅在用户主动开启时启用
    userProfileValidationEnabled:
      fileConfig.userProfileValidationEnabled ?? DEFAULTS.userProfileValidationEnabled,
    // 用户档案非活跃条目的判定阈值：优先使用用户配置值，未配置则回退到默认值，超过该天数未被强化的条目将被标记为待清理
    userProfileStaleDays: fileConfig.userProfileStaleDays ?? DEFAULTS.userProfileStaleDays,
    // 自动捕获成功后的弹出通知开关：优先使用用户配置值，未配置则默认开启，每次记忆捕获完成后通过toast提示用户
    showAutoCaptureToasts: fileConfig.showAutoCaptureToasts ?? DEFAULTS.showAutoCaptureToasts,
    // 用户档案更新后的弹出通知开关：优先使用用户配置值，未配置则默认开启，每次用户档案完成分析更新后提示用户
    showUserProfileToasts: fileConfig.showUserProfileToasts ?? DEFAULTS.showUserProfileToasts,
    // 系统错误消息的弹出通知开关：优先使用用户配置值，未配置则默认开启，捕获流程或档案分析出错时及时向用户反馈
    showErrorToasts: fileConfig.showErrorToasts ?? DEFAULTS.showErrorToasts,
    memory: {
      // 记忆管理核心配置组
      defaultScope: fileConfig.memory?.defaultScope ?? DEFAULTS.memory.defaultScope, // 记忆的默认作用域配置，优先使用用户自定义值，未配置则回退到系统默认作用域，用于控制记忆的可见范围与生命周期
    },
    compaction: {
      // 记忆压缩归档配置组
      enabled: fileConfig.compaction?.enabled ?? DEFAULTS.compaction.enabled, // 记忆压缩功能总开关，优先使用用户配置的启用状态，未配置则使用默认值，控制老旧记忆是否自动合并归档以节省存储空间
      memoryLimit: fileConfig.compaction?.memoryLimit ?? DEFAULTS.compaction.memoryLimit, // 激活压缩逻辑的记忆数量阈值，当活跃记忆总数超过该值时自动触发压缩流程，优先使用用户配置值，未配置则回退到系统默认阈值
    },
    chatMessage: {
      // 对话消息注入配置组：控制记忆在当前聊天会话中的注入策略
      enabled: fileConfig.chatMessage?.enabled ?? DEFAULTS.chatMessage.enabled, // 记忆注入功能总开关：优先使用用户配置的启用状态，未配置则回退到系统默认值，全局控制是否在聊天消息中自动注入历史记忆
      maxMemories: fileConfig.chatMessage?.maxMemories ?? DEFAULTS.chatMessage.maxMemories, // 单条消息最大注入记忆数量：优先使用用户配置的上限，未配置则使用默认值，限制单次注入的记忆总数避免占用过多上下文Token
      excludeCurrentSession:
        fileConfig.chatMessage?.excludeCurrentSession ?? DEFAULTS.chatMessage.excludeCurrentSession, // 是否排除当前会话记忆：优先使用用户配置，未配置则回退到默认值，开启后仅注入历史会话的记忆，避免重复注入当前会话已有的内容
      maxAgeDays: fileConfig.chatMessage?.maxAgeDays, // 记忆最大留存天数：直接透传用户配置的时间阈值，仅将该天数内生成的有效记忆纳入注入候选池，过滤超期的陈旧记忆
      injectOn: (fileConfig.chatMessage?.injectOn ?? DEFAULTS.chatMessage.injectOn) as
        | "first" // 仅在会话首次交互时注入记忆：仅在用户发送第一条消息时注入匹配的历史记忆，后续对话不再重复注入
        | "always", // 每次交互都注入记忆：在用户每一次发送消息前都重新检索并注入最相关的记忆，保持上下文记忆的持续有效性
    },
  };
}

let _globalFileConfig = loadConfigFromPaths(CONFIG_FILES);
export let CONFIG = buildConfig(_globalFileConfig);

type RuntimeConfig = ReturnType<typeof buildConfig>;

interface AutoCaptureProviderRuntimeConfig {
  opencodeProvider?: string;
  opencodeModel?: string;
  memoryModel?: string;
  memoryApiUrl?: string;
  memoryApiKey?: string;
}

export type AutoCaptureProviderStatus =
  | { ready: true; mode: "opencode" | "manual"; issues: [] }
  | { ready: false; issues: string[] };

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export { isPlaceholderApiKey };

export function getAutoCaptureProviderStatus(
  config: AutoCaptureProviderRuntimeConfig
): AutoCaptureProviderStatus {
  const hasOpencodeProvider = hasValue(config.opencodeProvider);
  const hasOpencodeModel = hasValue(config.opencodeModel);
  if (hasOpencodeProvider && hasOpencodeModel) {
    return { ready: true, mode: "opencode", issues: [] };
  }

  const issues: string[] = [];
  if (!hasOpencodeProvider) issues.push("opencodeProvider is not configured");
  if (!hasOpencodeModel) issues.push("opencodeModel is not configured");

  const hasMemoryModel = hasValue(config.memoryModel);
  const hasMemoryApiUrl = hasValue(config.memoryApiUrl);
  const hasMemoryApiKey = hasValue(config.memoryApiKey);
  const hasPlaceholderMemoryApiKey = isPlaceholderApiKey(config.memoryApiKey);

  if (!hasMemoryModel) issues.push("memoryModel is not configured");
  if (!hasMemoryApiUrl) issues.push("memoryApiUrl is not configured");
  if (!hasMemoryApiKey) issues.push("memoryApiKey is not configured");
  if (hasPlaceholderMemoryApiKey) issues.push("memoryApiKey contains a placeholder value");

  if (hasMemoryModel && hasMemoryApiUrl && hasMemoryApiKey && !hasPlaceholderMemoryApiKey) {
    return { ready: true, mode: "manual", issues: [] };
  }

  return { ready: false, issues };
}

export function hasAutoCaptureProviderConfig(config: RuntimeConfig = CONFIG): boolean {
  return getAutoCaptureProviderStatus(config).ready;
}

export function initConfig(directory: string): void {
  // 定义项目级配置文件的搜索路径，优先支持JSONC带注释格式，兼容标准JSON格式
  const projectPaths = [
    join(directory, ".opencode", "opencode-mem.jsonc"),
    join(directory, ".opencode", "opencode-mem.json"),
  ];
  // 加载全局配置，从预设的全局配置路径列表中读取并解析配置文件
  const globalConfig = loadConfigFromPaths(CONFIG_FILES);
  // 加载当前项目的配置，从当前工作目录的.opencode目录下查找配置文件
  const projectConfig = loadConfigFromPaths(projectPaths);
  // 合并全局配置与项目配置，项目配置会覆盖全局配置中同名的配置项，实现分层配置覆盖逻辑
  const merged: OpenCodeMemConfig = { ...globalConfig, ...projectConfig };
  // 将合并后的原始配置传入buildConfig方法，生成格式化的运行时全局配置对象
  CONFIG = buildConfig(merged);

  // 如果调试日志功能已启用，输出配置合并过程的诊断日志，用于排查配置加载问题
  if (isDiagEnabled()) {
    diagLog("config.ts:initConfig", "merged config", {
      // 当前处理的项目根目录路径
      directory,
      // 全局配置中包含的配置项数量
      globalKeys: Object.keys(globalConfig).length,
      // 当前项目配置中包含的配置项数量
      projectKeys: Object.keys(projectConfig).length,
      // 合并后最终生效的向量数据库存储路径
      storagePath: CONFIG.storagePath,
      // 内存标签的统一前缀，用于分类隔离不同场景的记忆数据
      containerTagPrefix: CONFIG.containerTagPrefix,
      // 自动记忆捕获功能的启用状态，控制是否自动记录用户的交互会话
      autoCaptureEnabled: CONFIG.autoCaptureEnabled,
    });
  }
}

export function isConfigured(): boolean {
  if (isDiagEnabled()) {
    diagLog("config.ts:isConfigured", "always returns true (stub)", {
      autoCaptureProviderStatus: getAutoCaptureProviderStatus(CONFIG),
    });
  }
  return true;
}
