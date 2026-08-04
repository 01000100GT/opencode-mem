// 从Node.js内置文件系统模块导入所需的文件操作方法
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
// 从Node.js内置路径模块导入路径拼接方法，用于跨平台处理文件路径
import { join } from "node:path";
// 从Node.js内置操作系统模块导入获取用户主目录的方法
import { homedir } from "node:os";
// 导入JSONC注释清理工具，用于剥离配置文件中的JSON注释
import { stripJsoncComments } from "./services/jsonc.js";
// 导入密钥解析工具，支持从环境变量、本地文件等多种来源读取密钥配置
import { resolveSecretValue } from "./services/secret-resolver.js";
// 导入API密钥占位符校验工具，用于判断当前密钥是否为默认占位符而非有效密钥
import { isPlaceholderApiKey } from "./services/ai/api-key-placeholder.js";
// 导入日志诊断相关工具：诊断状态检查、值截断、诊断日志输出、警告日志输出、从配置初始化诊断状态
import {
  isDiagEnabled,
  truncateValue,
  diagLog,
  diagWarn,
  setDiagFromConfig,
} from "./services/logger.js";

// 配置文件根目录，遵循XDG Base Directory规范存储在用户主目录的.config下
const CONFIG_DIR = join(homedir(), ".config", "opencode");
// 应用数据存储根目录，用于持久化向量数据库、运行日志等核心业务数据
const DATA_DIR = join(homedir(), ".opencode-mem");
// 按优先级定义的配置文件搜索路径数组，优先加载JSONC格式（支持注释）， fallback到标准JSON格式
const CONFIG_FILES = [
  // 优先加载支持JSON注释的配置文件，符合现代配置文件的最佳实践
  join(CONFIG_DIR, "opencode-mem.jsonc"),
  // 次优先级加载标准JSON格式的配置文件，保证兼容性
  join(CONFIG_DIR, "opencode-mem.json"),
];

// 检查配置目录是否已创建
if (!existsSync(CONFIG_DIR)) {
  // 递归创建配置目录，确保父级目录不存在时也能完整生成路径
  mkdirSync(CONFIG_DIR, { recursive: true });
}

// 检查应用数据存储目录是否已创建
if (!existsSync(DATA_DIR)) {
  // 递归创建数据存储目录，支持多级嵌套路径的完整创建
  mkdirSync(DATA_DIR, { recursive: true });
}

// 定义OpenCode记忆插件的核心配置接口，所有配置项均为可选以支持默认值填充机制
interface OpenCodeMemConfig {
  // 向量数据库等持久化数据的自定义存储路径，未设置时使用默认数据目录
  storagePath?: string;
  // 强制覆盖系统获取的用户邮箱地址，用于统一用户身份标识
  userEmailOverride?: string;
  // 强制覆盖系统获取的用户名称，用于个性化记忆关联与展示
  userNameOverride?: string;
  memory?: {
    defaultScope?: "project" | "all-projects";
  };
  // 文本向量化模型名称，用于将记忆内容转换为向量表示以支持相似度搜索
  embeddingModel?: string;
  // 向量化输出的维度数量，不同模型通常有固定的维度值，系统会自动识别无需手动配置
  embeddingDimensions?: number;
  // 本地模型的量化精度：fp32/fp16/q8/q4/q4f16。未配置（undefined）时使用 transformers.js 默认行为（fp32）；建议本地模型用 q8 减少内存占用
  embeddingDtype?: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
  // 调用第三方API生成向量时的API基础地址，适用于使用OpenAI兼容接口的远程服务
  embeddingApiUrl?: string;
  // 调用第三方向量API的身份验证密钥，支持从环境变量、本地文件等多种来源加载
  embeddingApiKey?: string;
  // 记忆检索的相似度阈值，只有得分超过该阈值的记忆才会被纳入搜索结果
  similarityThreshold?: number;
  // 单次搜索返回的最大记忆数量，避免上下文过载
  maxMemories?: number;
  // 用户画像中保留的最大条目数，控制画像的精炼程度
  maxProfileItems?: number;
  // 是否自动将用户画像注入到AI对话上下文中，实现个性化交互
  injectProfile?: boolean;
  // 容器标签的前缀字符串，用于为自动捕获的记忆统一添加命名空间标识
  containerTagPrefix?: string;
  // 是否启用自动记忆捕获功能，开启后系统会自动分析对话并提取有效记忆
  autoCaptureEnabled?: boolean;
  // 自动捕获流程中多轮AI分析的最大迭代次数，防止无限循环消耗资源
  autoCaptureMaxIterations?: number;
  // 每轮AI分析迭代的超时时间（毫秒），超过该时长将终止当前迭代
  autoCaptureIterationTimeout?: number;
  // 自动捕获失败后的最大重试次数，网络或API异常时会尝试重新执行捕获流程
  autoCaptureMaxRetries?: number;
  // 自动生成记忆摘要的目标语言，支持auto自动检测或指定特定语言代码
  autoCaptureLanguage?: string;
  // 记忆生成服务的提供商类型，支持三种主流API格式：OpenAI兼容的Chat接口、OpenAI最新的Responses接口、Anthropic原生接口
  memoryProvider?: "openai-chat" | "openai-responses" | "anthropic";
  // 用于记忆提取与分析的大语言模型名称，需与所选提供商的模型命名规范保持一致
  memoryModel?: string;
  // 记忆服务API的基础请求地址，支持自定义部署的兼容接口地址，替换默认官方域名
  memoryApiUrl?: string;
  // 访问记忆服务API的身份验证密钥，支持从环境变量、本地文件等多种安全来源加载
  memoryApiKey?: string;
  // 大语言模型生成温度参数，控制输出的随机性；设为false可完全省略该参数，适配不支持温度调节的推理模型
  memoryTemperature?: number | false;
  // 发送到记忆服务API的额外自定义参数，可适配本地推理服务器或特殊模型的专属配置项
  memoryExtraParams?: Record<string, unknown>;
  // OpenCode内置的AI服务提供商名称，复用系统已认证的鉴权配置，无需重复配置API密钥
  opencodeProvider?: string;
  // 与opencodeProvider配合使用的具体大语言模型名称，需匹配系统支持的模型标识
  opencodeModel?: string;
  // 向量数据库后端模式，"hnswlib-wasm-first"优先使用hnswlib-wasm加速、"hnswlib-wasm"仅用hnswlib-wasm、"exact-scan"仅用精确扫描
  vectorBackend?: "hnswlib-wasm-first" | "hnswlib-wasm" | "exact-scan";
  // AI会话历史的保留天数，超过该期限的会话记录会被自动清理
  aiSessionRetentionDays?: number;
  // 是否启用Web服务器功能，开启后可通过浏览器访问记忆管理界面
  webServerEnabled?: boolean;
  // Web服务器监听的端口号，默认使用4747端口避免与常见服务冲突
  webServerPort?: number;
  // Web服务器绑定的主机地址，127.0.0.1仅本机访问，0.0.0.0可对外暴露服务
  webServerHost?: string;
  // Web服务器HTTP基础认证的密码，支持从环境变量、本地文件等安全来源加载凭证
  webServerAuthPassword?: string;
  // Web服务器HTTP基础认证的用户名，与密码配合完成身份校验，保护管理界面安全
  webServerAuthUsername?: string;
  // 每个数据库分片（shard）允许存储的最大向量数量，超出后自动创建新分片以保证查询性能
  maxVectorsPerShard?: number;
  // 是否启用自动清理机制，到期的历史记忆会被自动删除以节省存储空间
  autoCleanupEnabled?: boolean;
  // 记忆的保留天数，超过该期限的记忆会被自动清理（仅在autoCleanupEnabled开启时生效）
  autoCleanupRetentionDays?: number;
  // 是否启用记忆去重功能，自动检测并移除重复度较高的冗余记忆
  deduplicationEnabled?: boolean;
  // 判定重复记忆的相似度阈值（0-1区间），数值越高判定重复的标准越严格
  deduplicationSimilarityThreshold?: number;
  // 触发用户画像自动分析的间隔阈值，每积累N条未处理的用户对话提示词就启动一次画像更新
  userProfileAnalysisInterval?: number;
  // 画像分析时输入给AI的对话内容最大字节数，避免上下文过长导致性能损耗或分析失效
  userProfileMaxContextBytes?: number;
  // 在Web管理界面中展示的用户偏好条目最大数量，控制UI展示的信息密度
  userProfileDisplayPreferences?: number;
  // 在Web管理界面中展示的用户行为模式条目最大数量，避免界面信息过载
  userProfileDisplayPatterns?: number;
  // 在Web管理界面中展示的用户工作流条目最大数量，保证核心工作流的清晰展示
  userProfileDisplayWorkflows?: number;
  // 画像条目被标记为" stale（失效待清理）"的闲置天数，长期未被触发的条目会进入待清理状态
  userProfileStaleDays?: number;
  // 注入到AI对话上下文中的用户偏好条目最大数量，平衡个性化程度与上下文负载
  userProfileInjectPreferences?: number;
  // 注入到AI对话上下文中的用户行为模式条目最大数量，仅保留高价值的模式特征
  userProfileInjectPatterns?: number;
  // 注入到AI对话上下文中的用户工作流条目最大数量，避免过多工作流稀释核心上下文信息
  userProfileInjectWorkflows?: number;
  // 画像条目置信度开始自然衰减的天数，长期未被强化的条目置信度会逐步降低直至被清理
  userProfileConfidenceDecayDays?: number;
  // 用户画像变更日志的最大保留版本数，超出限制后会自动清理最旧的版本记录
  userProfileChangelogRetentionCount?: number;
  // 同类别画像条目合并的向量相似度强阈值，超过该阈值的两个同类别条目会被合并
  userProfileEmbeddingThresholdSameCat?: number;
  // 同类别画像条目关联的向量相似度弱阈值，超过该阈值的同类别条目会被标记为关联条目
  userProfileEmbeddingThresholdSameCatWeak?: number;
  // 跨类别画像条目合并的向量相似度强阈值，超过该阈值的不同类别条目会被合并为单一特征
  userProfileEmbeddingThresholdCrossCat?: number;
  // 跨类别画像条目关联的向量相似度弱阈值，超过该阈值的跨类别条目会建立关联关系
  userProfileEmbeddingThresholdCrossCatWeak?: number;
  // 画像类别中心向量漂移的容忍阈值，当中心向量偏移超过该阈值时会触发中心向量更新
  userProfileCentroidDriftThreshold?: number;
  // 画像条目描述文本的最小允许长度，低于该长度的条目会被判定为无效并过滤
  userProfileEmbeddingMinDescriptionLength?: number;
  // 画像条目能够保留在系统中的最小证据积累次数，低于该次数的条目会在清理周期中被删除
  userProfileMinEvidenceForRetention?: number;
  // 是否启用用户画像的AI有效性校验，开启后每次分析会校验现有画像与近期行为的匹配度
  userProfileValidationEnabled?: boolean;
  // 是否显示自动记忆捕获完成的Toast通知，成功捕获记忆后弹出轻量提示
  showAutoCaptureToasts?: boolean;
  // 是否显示用户画像更新完成的Toast通知，画像分析完成后告知用户
  showUserProfileToasts?: boolean;
  // 是否显示系统错误的Toast通知，捕获流程或后台任务失败时弹出告警
  showErrorToasts?: boolean;
  // 是否启用诊断日志模式，开启后会输出详细的内部运行日志用于问题排查
  diag?: boolean;
  // 数据库内存压缩配置，控制向量数据库的内存占用优化策略
  compaction?: {
    // 是否启用内存压缩功能，自动清理过期冷数据以释放内存
    enabled?: boolean;
    // 触发压缩的内存阈值（单位：GB），系统内存占用超过该值时自动启动压缩
    memoryLimit?: number;
  };
  // 对话消息上下文注入配置，控制每次AI对话时自动注入的历史记忆规则
  chatMessage?: {
    // 是否启用对话消息的记忆注入功能，开启后会自动将相关历史记忆注入上下文
    enabled?: boolean;
    // 单轮对话最多注入的记忆数量，避免上下文过长超出模型token限制
    maxMemories?: number;
    // 是否排除当前会话的记忆，仅注入历史会话的沉淀记忆避免重复上下文
    excludeCurrentSession?: boolean;
    // 记忆的最大留存天数，超过该期限的历史记忆不会被注入当前对话
    maxAgeDays?: number;
    // 记忆注入的时机："first"仅在对话第一轮注入，"always"每轮对话都注入
    injectOn?: "first" | "always";
  };
}

// 定义默认配置对象的类型约束，通过Required确保非可选字段必须存在，Omit排除所有需动态解析的可选配置项
const DEFAULTS: Required<
  Omit<
    OpenCodeMemConfig,
    // 向量化服务API地址：支持自定义私有部署端点，不属于必填默认配置
    | "embeddingApiUrl"
    // 向量化服务API密钥：敏感配置需动态解析，不预设默认值
    | "embeddingApiKey"
    // 本地模型量化精度：可选增强项，未配置时使用 transformers.js 默认 fp32
    | "embeddingDtype"
    // 记忆分析所用大语言模型名称：需与服务商匹配，无通用默认值
    | "memoryModel"
    // 记忆服务API基础地址：自定义部署时才需配置，默认使用官方地址
    | "memoryApiUrl"
    // 记忆服务API密钥：敏感凭证需从环境变量/文件读取，不硬编码默认值
    | "memoryApiKey"
    // 记忆服务提供商类型：支持openai/anthropic等多种选型，需用户明确配置
    | "memoryProvider"
    // 大模型生成温度参数：部分推理模型不支持该参数，作为可选配置保留
    | "memoryTemperature"
    // API请求自定义参数：适配特殊模型的专属配置，无通用默认值
    | "memoryExtraParams"
    // OpenCode内置服务提供商名称：复用系统已有鉴权配置，需用户指定系统内的服务商标识
    | "opencodeProvider"
    // OpenCode内置服务所用模型名称：需匹配系统支持的模型标识，无法预设默认值
    | "opencodeModel"
    // 自动捕获摘要生成语言：支持自动检测，仅需自定义时配置
    | "autoCaptureLanguage"
    // 用户邮箱强制覆写：仅当系统自动获取的邮箱无效时才需配置
    | "userEmailOverride"
    // 用户名称强制覆写：仅当系统自动获取的用户名无效时才需配置
    | "userNameOverride"
    // Web服务基础认证密码：敏感凭证需安全读取，不预设默认值
    | "webServerAuthPassword"
    // Web服务基础认证用户名：仅开启认证时才需配置，默认不启用鉴权
    | "webServerAuthUsername"
  >
> & {
  // 向量生成服务的自定义API端点地址，用于对接私有部署或第三方兼容接口
  embeddingApiUrl?: string;
  // 向量生成服务的身份验证密钥，支持从环境变量、本地文件等安全来源加载
  embeddingApiKey?: string;
  // 本地模型量化精度：未配置时使用 transformers.js 默认 fp32
  embeddingDtype?: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
  // 记忆分析所用大语言模型的具体名称，需与所选服务商标识的模型命名规范匹配
  memoryModel?: string;
  // 记忆推理服务的自定义API基础地址，可替换官方地址对接私有部署节点
  memoryApiUrl?: string;
  // 记忆推理服务的身份验证密钥，敏感凭证需通过安全渠道动态解析
  memoryApiKey?: string;
  // 记忆服务的提供商类型，限定支持三种主流API架构：OpenAI兼容Chat接口、OpenAI Responses接口、Anthropic原生接口
  memoryProvider?: "openai-chat" | "openai-responses" | "anthropic";
  // 大语言模型生成温度参数，控制输出随机性；设为false可完全省略该参数以适配不支持温度调节的推理模型
  memoryTemperature?: number | false;
  // 发送到记忆服务API的额外自定义参数，用于适配本地推理服务器或特殊模型的专属配置项
  memoryExtraParams?: Record<string, unknown>;
  // OpenCode内置认证的AI服务提供商名称，复用系统已配置的鉴权能力无需重复设置密钥
  opencodeProvider?: string;
  // 与OpenCode内置提供商配合使用的具体模型名称，需匹配系统支持的模型唯一标识
  opencodeModel?: string;
  // 向量数据库的后端加速模式，支持优先使用hnswlib-wasm、仅用hnswlib-wasm、仅用精确扫描三种策略
  vectorBackend?: "hnswlib-wasm-first" | "hnswlib-wasm" | "exact-scan";
  // 自动生成记忆摘要的目标语言，支持auto自动检测或指定具体语言代码
  autoCaptureLanguage?: string;
  // 强制覆盖系统自动获取的用户邮箱地址，用于统一用户身份标识
  userEmailOverride?: string;
  // 强制覆盖系统自动获取的用户名称，用于个性化记忆的关联与展示
  userNameOverride?: string;
  // Web管理界面HTTP基础认证的密码，支持多来源安全加载凭证
  webServerAuthPassword?: string;
  // Web管理界面HTTP基础认证的用户名，与密码配合完成身份校验
  webServerAuthUsername?: string;
  // 记忆核心配置项，包含记忆搜索的默认作用范围等基础参数
  memory?: {
    // 记忆列表与搜索的默认作用域，project限制在当前项目，all-projects可跨所有项目检索
    defaultScope?: "project" | "all-projects";
  };
} = {
  // 向量数据库持久化存储的根目录，所有分片数据、索引文件均存储于此路径下
  storagePath: join(DATA_DIR, "data"),
  // 默认文本向量化模型，采用开源Nomic-embed-v1，支持多语言、长上下文，适配绝大多数本地部署场景
  embeddingModel: "Xenova/nomic-embed-text-v1",
  // 默认嵌入向量维度，与上述开源模型的输出维度严格匹配，若切换模型需同步更新该值
  embeddingDimensions: 768,
  // 记忆检索的最低相似度阈值，仅余弦相似度超过该值的记忆会被纳入召回结果，平衡召回率与精准度
  similarityThreshold: 0.6,
  // 单次检索返回的最大记忆条目数，避免一次性注入过多历史信息导致LLM上下文溢出
  maxMemories: 10,
  // 用户画像系统中保留的最大有效条目总数，超过限制后会自动清理置信度最低的旧条目
  maxProfileItems: 5,
  // 是否开启用户画像自动注入功能，开启后会将用户的偏好、行为模式等信息自动注入LLM对话上下文
  injectProfile: true,
  // 向量数据库中记忆分片的统一标签前缀，用于区分不同应用生成的记忆数据，实现多实例数据隔离
  containerTagPrefix: "opencode",
  // 是否开启自动记忆捕获功能，后台进程会自动分析对话内容提取有效记忆并持久化存储
  autoCaptureEnabled: true,
  // 自动捕获流程中多轮AI分析的最大迭代次数，防止复杂场景下出现无限循环的推理调用
  autoCaptureMaxIterations: 5,
  // 单轮AI分析请求的超时时间，单位为毫秒，超过该时间会终止当前请求并重试
  autoCaptureIterationTimeout: 120000,
  // 自动捕获失败后的最大重试次数，针对网络波动、API限流等临时错误提升捕获成功率
  autoCaptureMaxRetries: 3,
  // 向量数据库后端加速模式，优先加载hnswlib-wasm向量库实现高性能检索，加载失败自动降级为精确扫描
  vectorBackend: "hnswlib-wasm-first",
  // AI会话历史的保留天数，超过该期限的会话记录会被自动清理，避免无效数据占用存储空间
  aiSessionRetentionDays: 7,
  // 是否开启Web管理服务器，开启后可通过浏览器访问可视化界面管理所有记忆数据
  webServerEnabled: true,
  // Web服务器监听的端口号，选用4747作为默认端口，规避与常见HTTP/HTTPS服务的端口冲突
  webServerPort: 4747,
  // Web服务器绑定的主机地址，默认仅绑定本地回环地址，仅允许本机访问管理界面
  webServerHost: "127.0.0.1",
  // Web界面HTTP基础认证的密码，默认不启用认证，需手动配置后才会开启鉴权逻辑
  webServerAuthPassword: undefined,
  // Web界面HTTP基础认证的用户名，与密码配对使用，仅当密码配置后该字段才会生效
  webServerAuthUsername: undefined,
  // 单个数据库分片允许存储的最大向量数量，超过该阈值后自动创建新分片，保证单分片查询性能稳定
  maxVectorsPerShard: 50000,
  // 是否开启自动清理功能，到期的记忆、会话日志等数据会被定期扫描并删除
  autoCleanupEnabled: true,
  // 记忆数据的最长保留天数，仅当autoCleanupEnabled开启时生效，超过该期限的记忆会被清理
  autoCleanupRetentionDays: 30,
  // 是否开启记忆去重功能，自动检测并合并内容高度相似的冗余记忆，节省存储资源并提升检索效率
  deduplicationEnabled: true,
  // 判定记忆重复的相似度阈值，余弦相似度超过该值的两条记忆会被判定为重复，数值越高判定标准越严格
  deduplicationSimilarityThreshold: 0.9,
  // 触发用户画像自动分析的对话阈值，每积累指定数量的未处理用户提示词就启动一次画像更新
  userProfileAnalysisInterval: 10,
  // 每次画像分析时输入给AI的最大上下文字节数，避免过长的历史对话导致AI推理超时或失真
  userProfileMaxContextBytes: 32768,
  // Web管理界面中展示的用户偏好条目最大数量，控制UI信息密度，避免界面过载
  userProfileDisplayPreferences: 20,
  // Web管理界面中展示的用户行为模式条目最大数量，仅保留高频、高置信度的模式特征
  userProfileDisplayPatterns: 15,
  // Web管理界面中展示的用户工作流条目最大数量，核心工作流优先展示，过滤低频临时流程
  userProfileDisplayWorkflows: 10,
  // 画像条目被标记为待清理（stale）的闲置天数，长期未被触发的条目会进入失效队列等待删除
  userProfileStaleDays: 2,
  // 注入到LLM对话上下文的用户偏好条目最大数量，平衡个性化程度与上下文负载，避免信息冗余
  userProfileInjectPreferences: 5,
  // 注入到LLM对话上下文的用户行为模式条目最大数量，仅保留对当前对话最有价值的模式特征
  userProfileInjectPatterns: 5,
  // 注入到LLM对话上下文的用户工作流条目最大数量，避免过多历史工作流稀释当前任务的核心上下文
  userProfileInjectWorkflows: 3,
  // 画像条目置信度开始自然衰减的天数，长期未被强化的条目置信度会逐步降低，最终被系统清理
  userProfileConfidenceDecayDays: 30,
  // 用户画像变更日志的最大保留版本数，超过限制后自动删除最早的版本，仅保留最近的变更记录
  userProfileChangelogRetentionCount: 5,
  // 同类别画像条目合并的强相似度阈值，超过该阈值的两个同类别条目会被自动合并为单一特征
  userProfileEmbeddingThresholdSameCat: 0.8,
  // 同类别画像条目关联的弱相似度阈值，超过该阈值的同类别条目会被标记为关联条目，用于画像关系网络构建
  userProfileEmbeddingThresholdSameCatWeak: 0.5,
  // 跨类别画像条目合并的强相似度阈值，超过该阈值的不同类别条目会被合并，避免跨类别的冗余特征生成
  userProfileEmbeddingThresholdCrossCat: 0.9,
  // 跨类别画像条目关联的弱相似度阈值，超过该阈值的跨类别条目会建立关联关系，支撑跨场景的画像推理
  userProfileEmbeddingThresholdCrossCatWeak: 0.8,
  // 画像类别中心向量的漂移容忍阈值，当类别中心向量偏移超过该值时触发中心向量更新，保证画像特征的稳定性
  userProfileCentroidDriftThreshold: 0.65,
  // 画像条目描述文本的最小允许长度，低于该长度的条目会被判定为无效，无法进入画像系统
  userProfileEmbeddingMinDescriptionLength: 5,
  // 画像条目能够保留在系统中的最小证据积累次数，低于该次数的条目会在清理周期中被优先删除
  userProfileMinEvidenceForRetention: 3,
  // 是否开启用户画像的AI有效性校验，开启后每次分析都会校验现有画像与近期用户行为的匹配度，及时淘汰失效特征
  userProfileValidationEnabled: false,
  // 是否显示自动记忆捕获完成的Toast通知，成功捕获记忆后弹出轻量提示告知用户
  showAutoCaptureToasts: true,
  // 是否显示用户画像更新完成的Toast通知，画像分析完成后弹出提示同步更新状态
  showUserProfileToasts: true,
  // 是否显示系统错误的Toast通知，捕获流程、后台任务失败时弹出告警提示用户排查问题
  showErrorToasts: true,
  // 是否开启诊断日志模式，开启后会输出详细的内部运行日志，用于问题排查与性能调优
  diag: false,
  // 记忆系统核心配置块，定义记忆的全局作用域等基础规则
  memory: {
    // 记忆检索的默认作用域，project表示仅在当前项目内检索记忆，all-projects表示跨所有项目检索
    defaultScope: "project",
  },
  // 数据库内存压缩配置块，控制内存占用的优化策略
  compaction: {
    // 是否开启内存压缩功能，自动清理过期冷数据以释放物理内存
    enabled: true,
    // 触发自动压缩的内存阈值，单位为GB，系统内存占用超过该值时自动启动压缩流程
    memoryLimit: 10,
  },
  // 对话消息上下文注入配置块，控制每次LLM对话时自动注入的历史记忆规则
  chatMessage: {
    // 是否开启对话消息的记忆注入功能，开启后会自动将相关历史记忆注入当前对话上下文
    enabled: true,
    // 单轮对话最多注入的记忆数量，避免注入过多历史信息超出LLM的上下文长度限制
    maxMemories: 3,
    // 是否排除当前会话的记忆，仅注入历史会话的沉淀记忆，避免当前对话的重复内容冗余
    excludeCurrentSession: true,
    // 记忆的最大留存天数，超过该期限的历史记忆不会被注入当前对话，仅保留近期有效记忆
    maxAgeDays: undefined,
    // 记忆注入的时机，first表示仅在对话第一轮注入，always表示每轮对话都执行注入逻辑
    injectOn: "first",
  },
};

// 路径展开工具函数：将包含波浪号前缀的用户目录简写转换为系统绝对路径
// 输入参数path为待处理的原始路径字符串，返回标准化后的绝对路径字符串
function expandPath(path: string): string {
  // 匹配以"~/"开头的相对路径格式，支持类似"~/documents"的用户目录简写
  if (path.startsWith("~/")) {
    // 拼接用户主目录与剩余路径片段，自动处理跨平台的路径分隔符
    return join(homedir(), path.slice(2));
  }
  // 匹配单独的波浪号"~"，直接返回用户主目录的绝对路径
  if (path === "~") {
    return homedir();
  }
  // 非波浪号开头的路径保持原样返回，避免破坏已有的绝对路径或相对路径格式
  return path;
}

// 配置文件加载主函数：按传入的路径顺序依次尝试加载配置，返回首个成功解析的配置对象
function loadConfigFromPaths(paths: string[]): OpenCodeMemConfig {
  // 遍历所有候选配置路径，按优先级顺序尝试加载
  for (const path of paths) {
    // 检查当前路径的配置文件是否存在于本地文件系统中
    if (existsSync(path)) {
      // 捕获配置文件读取与解析过程中可能出现的所有异常，避免单一配置文件损坏导致整个插件启动失败
      try {
        // 同步读取配置文件的完整内容，指定UTF-8编码确保中文等特殊字符正确解析
        const content = readFileSync(path, "utf-8");
        // 调用JSONC注释清理工具，移除配置文件中的所有注释内容，生成符合标准JSON语法的字符串
        const json = stripJsoncComments(content);
        // 将清理后的JSON字符串解析为TypeScript对象，并通过类型断言转换为预定义的配置接口类型
        const parsed = JSON.parse(json) as OpenCodeMemConfig;

        // 检查是否已启用诊断日志模式，仅在开启状态下输出配置加载的详细调试信息
        if (isDiagEnabled()) {
          // 统计解析后的配置对象中包含的自定义配置项总数，用于验证用户配置的加载范围
          const keys = Object.keys(parsed).length;
          // 输出诊断日志，记录配置文件的成功加载，包含文件路径和加载的配置项数量
          diagLog("config.ts:loadConfigFromPaths", "loaded", { path, keys });
        }

        // 将成功解析的配置对象返回给上层调用逻辑，终止当前配置文件的遍历流程
        return parsed;
        // 捕获配置文件读取、注释清理或JSON解析阶段抛出的所有异常，统一进行错误处理
      } catch (err: unknown) {
        // 仅在诊断日志模式启用时，输出配置解析失败的警告信息，避免干扰正常运行的用户
        if (isDiagEnabled()) {
          // 标准化错误信息格式，若捕获的是标准Error对象则取其message属性，否则转换为通用字符串
          const msg = err instanceof Error ? err.message : String(err);
          // 输出警告日志，记录配置解析失败的事件，截断过长的错误信息避免日志体积膨胀
          diagWarn("config.ts:loadConfigFromPaths", "parse failed — silently swallowed", {
            path,
            error: msg.substring(0, 200),
          });
        }
      }
      // 当前配置文件不存在时的分支处理
    } else if (isDiagEnabled()) {
      // 仅在诊断日志模式启用时，记录配置文件未找到的调试信息
      diagLog("config.ts:loadConfigFromPaths", "file not found", { path });
    }
  }
  // 如果诊断日志功能已启用，输出配置文件未找到的提示信息
  if (isDiagEnabled()) {
    // 记录诊断日志，标记所有预设配置路径均未匹配到有效文件，即将返回空配置对象
    diagLog("config.ts:loadConfigFromPaths", "no config files found — returning empty");
  }
  // 所有候选配置文件均加载失败，返回空对象供后续与默认配置合并
  return {};
}

// 配置模板常量定义：存储生成默认配置文件的JSONC模板字符串，作为用户首次使用时的初始化配置蓝本
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
  
  // Quantization dtype for local models: "fp32" | "fp16" | "q8" | "q4" | "q4f16".
  // Omit (default) to use transformers.js default (fp32). "q8" reduces memory
  // ~4x with negligible accuracy loss for retrieval; recommended for local use.
  // "embeddingDtype": "q8",
  
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
   
  // Timeout per iteration in milliseconds (120 seconds default)
  "autoCaptureIterationTimeout": 120000,

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

  // Enable diagnostic logging to troubleshoot internal events (session.idle timing,
  // auto-capture triggers, config loading, etc.). Logs are written to
  // ~/.opencode-mem/opencode-mem.log (or OPENCODE_MEM_LOG_FILE).
  // The env var OPENCODE_MEM_DIAG=1 still works and takes effect earlier at startup.
  "diag": false,

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

/**
 * 确保配置文件存在的核心初始化函数
 * 负责在程序启动时检查全局配置目录中是否存在有效的配置文件，
 * 若不存在则自动生成一份包含完整注释和默认值的模板配置文件，
 * 为用户提供开箱即用的基础配置，并引导用户完成个性化定制
 */
function ensureConfigExists(): void {
  // 拼接生成配置文件的完整绝对路径，配置文件固定命名为opencode-mem.jsonc
  // 路径基准为系统预设的全局配置目录CONFIG_DIR，确保配置文件统一存储
  const configPath = join(CONFIG_DIR, "opencode-mem.jsonc");

  // 检查配置文件是否已存在于目标路径，仅当文件不存在时执行模板生成逻辑
  // 避免重复覆盖用户已修改的自定义配置，保障用户配置的安全性
  if (!existsSync(configPath)) {
    // 捕获配置文件写入过程中可能发生的所有异常，避免因权限不足、磁盘满等
    // 意外错误导致整个插件启动失败，提升程序的鲁棒性
    try {
      // 将预设的CONFIG_TEMPLATE模板内容写入目标路径，使用UTF-8编码确保
      // 模板中的中文注释、特殊符号等字符能够正确存储，无乱码风险
      writeFileSync(configPath, CONFIG_TEMPLATE, "utf-8");
      // 在控制台输出配置文件创建成功的提示信息，使用醒目的对勾符号提升可读性
      // 同时打印配置文件的完整路径，方便用户快速定位到配置文件位置
      console.log(`\n✓ Created config template: ${configPath}`);
      // 输出引导性提示，告知用户可以通过编辑该配置文件自定义插件的所有功能参数
      // 为新手用户提供清晰的操作指引，降低配置门槛
      console.log("  Edit this file to customize opencode-mem settings.\n");
      // 仅当诊断日志模式已启用时，记录配置模板写入成功的调试日志
      // 避免在正常运行时输出冗余日志，保持控制台输出简洁
      if (isDiagEnabled()) {
        diagLog("config.ts:ensureConfigExists", "template written", { path: configPath });
      }
      // 捕获文件写入过程中抛出的所有异常，统一进行错误处理和日志记录
    } catch (err: unknown) {
      // 仅在诊断日志模式启用时输出警告信息，避免干扰普通用户的正常使用体验
      if (isDiagEnabled()) {
        // 标准化错误信息的提取逻辑，若捕获的是标准Error对象则直接取其message属性
        // 若为非标准错误则转换为通用字符串，确保错误信息的一致性
        const msg = err instanceof Error ? err.message : String(err);
        // 输出配置模板写入失败的警告日志，记录失败的文件路径和截断后的错误信息
        // 错误信息截取前200字符避免日志体积过度膨胀，同时保留核心错误线索
        diagWarn("config.ts:ensureConfigExists", "template write failed — silently swallowed", {
          path: configPath,
          error: msg.substring(0, 200),
        });
      }
    }
  }
}

// 立即执行配置文件存在性检查逻辑，作为模块加载后的首个初始化步骤
// 确保在插件的其他核心逻辑启动前，配置文件已经完成创建或校验，
// 避免后续逻辑因找不到配置文件而抛出异常，保障初始化流程的顺序正确性
ensureConfigExists();

// 根据嵌入模型名称获取对应的向量维度，为不同模型自动匹配标准维度值
function getEmbeddingDimensions(model: string): number {
  // 模型-维度映射表，存储所有支持的嵌入模型及其标准向量维度
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
    // 嵌入模型量化精度：未配置（undefined）时不传 dtype 参数，由 transformers.js 使用默认值
    embeddingDtype: fileConfig.embeddingDtype,
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
    // 向量数据库后端选择：优先使用用户配置的后端类型，未配置时默认采用"hnswlib-wasm-first"模式
    // 支持的三种后端模式：
    // "hnswlib-wasm-first"：优先尝试使用hnswlib-wasm向量库，若加载失败自动降级到精确扫描
    // "hnswlib-wasm"：强制使用hnswlib-wasm向量库，加载失败将抛出致命错误终止进程
    // "exact-scan"：全程使用暴力精确扫描，不依赖任何第三方向量加速库，兼容性最强但性能最低
    vectorBackend: (fileConfig.vectorBackend ?? "hnswlib-wasm-first") as
      | "hnswlib-wasm-first"
      | "hnswlib-wasm"
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
    // 诊断日志开关：开启后输出详细的内部事件追踪日志，便于排查 session.idle、auto-capture 等时序问题；环境变量 OPENCODE_MEM_DIAG=1 仍可作为启动早期覆盖
    diag: fileConfig.diag ?? DEFAULTS.diag,
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

// 从预设的全局配置文件路径列表中加载并解析原始配置文件，生成未经过构建处理的基础配置对象
let _globalFileConfig = loadConfigFromPaths(CONFIG_FILES);
// 导出全局运行时配置对象，将原始配置传入构建函数生成带默认值、预处理完成的可用配置，供全项目调用
export let CONFIG = buildConfig(_globalFileConfig);

// 运行时配置类型：从buildConfig函数的返回值自动推导，确保类型与实际构建的配置结构完全同步
type RuntimeConfig = ReturnType<typeof buildConfig>;

// 自动捕获提供商运行时配置接口：定义自动记忆捕获功能所需的核心配置字段，统一校验两类接入模式的参数合法性
interface AutoCaptureProviderRuntimeConfig {
  // OpenCode原生集成的服务商名称：使用平台内置认证能力时必填，无需额外配置API密钥
  opencodeProvider?: string;
  // OpenCode原生集成的推理模型标识：配合opencodeProvider使用，需与服务商支持的模型列表匹配
  opencodeModel?: string;
  // 第三方自定义推理模型名称：手动对接兼容OpenAI/Anthropic协议的API时必填，指定具体调用的模型
  memoryModel?: string;
  // 第三方推理服务的API端点地址：手动模式下必填，指向自定义部署的推理服务地址
  memoryApiUrl?: string;
  // 第三方推理服务的访问密钥：手动模式下必填，用于验证API调用权限的身份凭证
  memoryApiKey?: string;
}

// 自动捕获提供商状态类型：用于统一描述自动记忆捕获功能的配置就绪状态
export type AutoCaptureProviderStatus =
  // 就绪状态：配置有效，可正常启动自动捕获流程
  | { ready: true; mode: "opencode" | "manual"; issues: [] }
  // 未就绪状态：存在配置缺失或错误，无法启动自动捕获流程
  | { ready: false; issues: string[] };

// 通用值有效性校验函数：判断输入字符串是否为非空有效内容
function hasValue(value: string | undefined): boolean {
  // 校验逻辑：必须是字符串类型，且去除首尾空白字符后长度大于0
  return typeof value === "string" && value.trim().length > 0;
}

// 导出isPlaceholderApiKey工具函数，供其他模块调用以检查API密钥是否为占位符值
export { isPlaceholderApiKey };

// 自动记忆捕获功能提供商状态检测函数：校验配置完整性并返回就绪状态与接入模式
// 入参config：自动捕获功能运行时配置对象，包含OpenCode原生集成和第三方手动配置两类参数
// 返回值：标准化的提供商状态对象，标记是否就绪、适用的工作模式及所有配置问题列表
export function getAutoCaptureProviderStatus(
  config: AutoCaptureProviderRuntimeConfig
): AutoCaptureProviderStatus {
  // 校验OpenCode原生服务商名称是否为有效非空字符串
  const hasOpencodeProvider = hasValue(config.opencodeProvider);
  // 校验OpenCode原生推理模型标识是否为有效非空字符串
  const hasOpencodeModel = hasValue(config.opencodeModel);
  // 若两项原生集成配置均有效，则标记为就绪状态，采用opencode原生模式接入
  if (hasOpencodeProvider && hasOpencodeModel) {
    return { ready: true, mode: "opencode", issues: [] };
  }

  // 初始化配置问题收集数组，用于汇总所有未满足的配置项提示
  const issues: string[] = [];
  // 若OpenCode内置服务商名称未配置，添加对应的缺失提示到问题列表
  if (!hasOpencodeProvider) issues.push("opencodeProvider is not configured");
  // 若OpenCode内置推理模型标识未配置，添加对应的缺失提示到问题列表
  if (!hasOpencodeModel) issues.push("opencodeModel is not configured");

  // 校验记忆推理模型名称是否为非空有效值（通过通用值有效性检查函数）
  const hasMemoryModel = hasValue(config.memoryModel);
  // 校验记忆推理服务的API端点地址是否为非空有效值（通过通用值有效性检查函数）
  const hasMemoryApiUrl = hasValue(config.memoryApiUrl);
  // 校验记忆推理服务的API访问密钥是否为非空有效值（通过通用值有效性检查函数）
  const hasMemoryApiKey = hasValue(config.memoryApiKey);
  // 校验记忆API密钥是否为示例占位符值（通过占位符密钥检测函数）
  const hasPlaceholderMemoryApiKey = isPlaceholderApiKey(config.memoryApiKey);

  // 若记忆模型名称未配置，将对应错误信息添加到问题列表中
  if (!hasMemoryModel) issues.push("memoryModel is not configured");
  // 若记忆API端点地址未配置，将对应错误信息添加到问题列表中
  if (!hasMemoryApiUrl) issues.push("memoryApiUrl is not configured");
  // 若记忆API访问密钥未配置，将对应错误信息添加到问题列表中
  if (!hasMemoryApiKey) issues.push("memoryApiKey is not configured");
  // 若记忆API密钥为占位符示例值，将对应错误信息添加到问题列表中
  if (hasPlaceholderMemoryApiKey) issues.push("memoryApiKey contains a placeholder value");

  // 若三项手动配置的核心参数均有效且密钥非占位符，标记为就绪状态，采用manual手动模式接入
  if (hasMemoryModel && hasMemoryApiUrl && hasMemoryApiKey && !hasPlaceholderMemoryApiKey) {
    return { ready: true, mode: "manual", issues: [] };
  }

  // 所有配置校验均未通过，返回未就绪状态并附带所有收集到的配置问题
  return { ready: false, issues };
}

// 检查自动捕获功能提供商的配置是否完整有效
// 支持传入自定义配置对象，默认使用全局单例CONFIG
export function hasAutoCaptureProviderConfig(config: RuntimeConfig = CONFIG): boolean {
  // 调用核心状态检测函数，返回就绪状态标识
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

  // 把配置文件里的 diag 注入到 logger，之后 isDiagEnabled() 以配置为准
  setDiagFromConfig(!!CONFIG.diag);

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

// 导出系统整体配置就绪状态检查函数，供外部模块调用以确认插件是否已完成核心配置加载
export function isConfigured(): boolean {
  // 仅当诊断日志模式已启用时，输出配置检查过程的调试日志，便于开发阶段排查配置初始化问题
  if (isDiagEnabled()) {
    // 记录当前配置检查的桩实现状态，同时输出自动捕获提供商的完整配置状态快照，留存调试上下文
    diagLog("config.ts:isConfigured", "always returns true (stub)", {
      autoCaptureProviderStatus: getAutoCaptureProviderStatus(CONFIG),
    });
  }
  // 当前版本为桩实现，固定返回true表示配置已就绪，后续版本将扩展真实的多维度配置校验逻辑
  return true;
}
