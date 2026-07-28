// AI服务提供商类型枚举，支持当前主流大模型厂商的API接入
// openai-chat: OpenAI的传统Chat Completions API（如gpt-3.5-turbo、gpt-4系列）
// openai-responses: OpenAI新一代Responses API，统一的多模态交互接口
// anthropic: Anthropic公司的Claude系列大模型API
// google-gemini: Google的Gemini系列多模态大模型API
export type AIProviderType = "openai-chat" | "openai-responses" | "anthropic" | "google-gemini";

export interface AIMessage {
  // 消息唯一标识符，可选字段，用于数据库持久化存储
  id?: number;
  // 关联的AI会话全局唯一标识，绑定该消息所属的对话上下文
  aiSessionId: string;
  // 消息在会话内的顺序序号，保证多端消息时序一致性与乱序重排能力
  sequence: number;
  // 消息发送者角色，严格遵循大模型对话协议标准角色定义
  role: "system" | "user" | "assistant" | "tool";
  // 消息的文本主体内容，纯字符串格式的对话核心信息
  content: string;
  // 工具调用请求列表，仅当assistant主动发起工具调用时存在
  toolCalls?: Array<{
    // 工具调用请求的唯一标识，用于关联后续工具返回结果
    id: string;
    // 工具调用的类型，固定为function类型以兼容OpenAI生态协议
    type: "function";
    // 函数调用的核心参数，包含函数名与序列化的参数列表
    function: { name: string; arguments: string };
  }>;
  // 工具返回消息关联的原始工具调用ID，用于建立请求-响应链路
  toolCallId?: string;
  // 多模态内容块列表，支持存储文本、图片、音频等异构媒体数据
  contentBlocks?: Array<{
    // 内容块的媒体类型，标识当前块的格式类别（如text/image/audio）
    type: string;
    // 扩展字段容器，兼容不同厂商的多模态内容自定义属性
    [key: string]: any;
  }>;
  // 消息创建的Unix毫秒级时间戳，用于消息排序与过期清理逻辑
  createdAt: number;
}

// AI会话实体接口，定义了单轮AI对话生命周期内的核心数据结构
export interface AISession {
  // 数据库主键/全局唯一标识符，用于持久化存储与跨服务会话检索
  id: string;
  // 绑定的AI服务提供商类型，关联当前会话使用的大模型厂商配置
  provider: AIProviderType;
  // 业务侧生成的客户端会话标识，用于前端与后端的会话链路绑定
  sessionId: string;
  // 关联的多轮对话聚合标识，支持将多个短期会话归并到同一长期对话上下文
  conversationId?: string;
  // 扩展元数据容器，用于存储业务自定义的会话标签、用户画像、配置参数等非结构化数据
  metadata?: Record<string, any>;
  // 会话创建的Unix毫秒级时间戳，用于会话生命周期管理与审计日志
  createdAt: number;
  // 会话最后一次更新的Unix毫秒级时间戳，用于追踪会话活跃状态与脏数据检查
  updatedAt: number;
  // 会话过期的Unix毫秒级时间戳，用于自动清理非活跃会话与资源回收
  expiresAt: number;
}

// 会话创建参数接口，定义初始化AI会话时需传入的标准化请求参数结构
export interface SessionCreateParams {
  // 指定会话绑定的AI服务提供商类型，决定后端适配的大模型API协议与调用链路
  provider: AIProviderType;
  // 业务端生成的客户端会话唯一标识，用于建立前后端之间的会话绑定与请求路由
  sessionId: string;
  // 可选的长期对话聚合标识，支持将本次会话关联到已存在的历史对话上下文链中
  conversationId?: string;
  // 可选的自定义元数据容器，用于存储业务侧自定义的会话标签、用户属性、配置参数等扩展信息
  metadata?: Record<string, any>;
}

// 会话更新参数接口，定义修改已有AI会话属性时需传入的标准化请求参数结构
export interface SessionUpdateParams {
  // 可选的长期对话聚合标识，支持修改当前会话关联的历史对话上下文链路
  conversationId?: string;
  // 可选的自定义元数据容器，支持增量更新或覆盖会话的扩展属性与配置信息
  metadata?: Record<string, any>;
}
