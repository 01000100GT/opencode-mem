// 工具调用结果返回接口，封装单次工具调用流程的完整状态信息
export interface ToolCallResult {
  // 工具调用是否成功完成，标记整个执行流程的最终状态
  success: boolean;
  // 调用成功时返回的业务数据，仅在success为true时存在合法值
  data?: any;
  // 调用失败时的错误描述信息，仅在success为false时填充具体原因
  error?: string;
  // 本次工具调用实际执行的迭代次数，用于追踪多轮工具调用的资源消耗
  iterations?: number;
}

export interface ProviderConfig {
  // AI服务商使用的模型标识符，指定具体调用的大语言模型版本
  model: string;
  // API接口的基础访问地址，用于指向大模型服务的网关端点
  apiUrl: string;
  // 可选的API身份验证密钥，用于服务端的身份校验与权限管控
  apiKey?: string;
  // 单轮工具调用流程允许的最大迭代次数，防止无限递归消耗资源
  maxIterations?: number;
  // 单次工具调用迭代的超时时间，单位为毫秒，超时则终止当前迭代
  iterationTimeout?: number;
  // 模型生成回复的最大token数量，控制输出内容的长度上限
  maxTokens?: number;
  // 记忆模块的采样温度，设为false则关闭记忆模块的随机性控制
  memoryTemperature?: number | false;
  // 自定义扩展参数集合，用于注入模型原生支持的非标准配置项
  extraParams?: Record<string, unknown>;
}

// 受保护的核心请求参数字典，这些关键字段不允许被自定义扩展参数覆盖
const PROTECTED_KEYS = new Set([
  "model", // 模型标识符字段，控制调用的大模型版本，属于核心配置
  "messages", // 对话消息列表字段，承载多轮交互的上下文历史
  "tools", // 工具定义列表字段，声明模型可调用的工具能力集合
  "tool_choice", // 工具调用强制配置字段，控制模型是否必须使用指定工具
  "temperature", // 生成采样温度字段，调节模型输出的随机性与创造力
  "input", // 单轮输入内容字段，部分模型使用的极简输入格式字段
  "instructions", // 系统指令字段，承载给模型的核心规则与任务要求
  "conversation", // 会话上下文字段，部分厂商使用的对话历史存储字段
]);

// 安全应用扩展参数函数：将自定义配置合并到请求体中，避免覆盖核心保护字段
export function applySafeExtraParams(
  // 待填充的API请求体对象，所有非保护字段的扩展参数将注入此对象
  requestBody: Record<string, any>,
  // 待注入的自定义扩展参数集合，包含模型原生支持的非标准配置项
  extraParams: Record<string, unknown>
): void {
  // 遍历所有扩展参数的键值对，逐个校验并执行合并逻辑
  for (const [key, value] of Object.entries(extraParams)) {
    // 仅当当前参数键不在核心保护字段集合中时，才允许注入请求体
    if (!PROTECTED_KEYS.has(key)) {
      // 将合法的扩展参数写入请求体，完成配置合并
      requestBody[key] = value;
    }
  }
}

// AI服务提供商抽象基类，定义所有大模型服务商必须实现的统一接口规范
export abstract class BaseAIProvider {
  // 实例持有的服务商配置对象，存储该实例关联的模型、API密钥等核心参数
  protected config: ProviderConfig;

  // 基类构造函数，初始化服务商实例时注入配置信息
  constructor(config: ProviderConfig) {
    this.config = config;
  }

  // 抽象方法：执行工具调用流程，协调大模型与工具的多轮交互直至完成
  abstract executeToolCall(
    // 系统提示词，传递给模型的核心规则、任务要求与身份设定指令
    systemPrompt: string,
    // 用户输入提示词，承载当前轮次的用户具体需求与查询内容
    userPrompt: string,
    // 工具定义 schema，描述模型可调用的所有工具的参数格式与能力说明
    toolSchema: any,
    // 会话唯一标识符，用于多轮交互的上下文关联与记忆模块绑定
    sessionId: string
  ): Promise<ToolCallResult>;

  // 抽象方法：获取当前服务商的唯一名称标识，用于日志记录与实例区分
  abstract getProviderName(): string;

  // 抽象方法：查询当前服务商是否支持会话持久化能力，返回是否支持多轮上下文保留
  abstract supportsSession(): boolean;
}
