// 导入AI服务提供商的抽象基类和配置接口类型，定义所有提供商的通用契约
import { BaseAIProvider, type ProviderConfig } from "./providers/base-provider.js";
// 导入OpenAI旧版聊天完成API的具体实现类，兼容gpt-3.5-turbo等模型
import { OpenAIChatCompletionProvider } from "./providers/openai-chat-completion.js";
// 导入OpenAI新版Responses API的具体实现类，支持最新的gpt-4o等原生模型特性
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
// 导入Anthropic Claude系列模型的消息API实现类，适配Claude 3/3.5系列模型
import { AnthropicMessagesProvider } from "./providers/anthropic-messages.js";
// 导入Google Gemini大模型的官方API实现类，支持Gemini 1.5 Pro/Flash等模型
import { GoogleGeminiProvider } from "./providers/google-gemini.js";
// 导入AI会话全局管理器实例，负责维护多轮对话上下文与会话生命周期管理
import { aiSessionManager } from "./session/ai-session-manager.js";
// 导入所有支持的AI提供商类型枚举，用于类型检查与工厂模式的参数约束
import type { AIProviderType } from "./session/session-types.js";

export class AIProviderFactory {
  // 根据指定的提供商类型和配置创建对应的AI服务实例，返回统一的抽象基类接口
  static createProvider(providerType: AIProviderType, config: ProviderConfig): BaseAIProvider {
    // 根据传入的提供商类型分支创建对应实现的实例
    switch (providerType) {
      // 匹配OpenAI旧版聊天完成API类型
      case "openai-chat":
        // 实例化OpenAI聊天完成提供商，注入配置与会话管理器依赖
        return new OpenAIChatCompletionProvider(config, aiSessionManager);

      // 匹配OpenAI新版Responses API类型
      case "openai-responses":
        // 实例化OpenAI Responses API提供商，注入配置与会话管理器依赖
        return new OpenAIResponsesProvider(config, aiSessionManager);

      // 匹配Anthropic Claude系列模型API类型
      case "anthropic":
        // 实例化Anthropic消息API提供商，注入配置与会话管理器依赖
        return new AnthropicMessagesProvider(config, aiSessionManager);

      // 匹配Google Gemini大模型API类型
      case "google-gemini":
        // 实例化Google Gemini提供商，注入配置与会话管理器依赖
        return new GoogleGeminiProvider(config, aiSessionManager);

      // 处理所有未匹配到的未知提供商类型
      default:
        // 抛出类型不支持的错误，携带非法的提供商类型参数便于排查
        throw new Error(`Unknown provider type: ${providerType}`);
    }
  }

  // 获取所有系统支持的AI服务提供商类型列表，供前端配置选择、合法性校验等场景使用
  static getSupportedProviders(): AIProviderType[] {
    // 返回枚举化的全量支持提供商标识数组，与switch分支中的创建逻辑保持严格一致
    return ["openai-chat", "openai-responses", "anthropic", "google-gemini"];
  }

  // 调用全局会话管理器的过期清理方法，释放超时未活动的无效会话资源
  static cleanupExpiredSessions(): number {
    // 透传会话管理器的清理结果，返回本次成功清理的过期会话数量
    return aiSessionManager.cleanupExpiredSessions();
  }
}
