// 导入基础提供者配置类型定义
import type { ProviderConfig } from "./providers/base-provider.js";
// 导入占位符API密钥校验函数
import { isPlaceholderApiKey } from "./api-key-placeholder.js";

// 记忆提供者运行时配置接口，定义记忆模块所需的全部可配置参数
interface MemoryProviderRuntimeConfig {
  // 记忆模块使用的大语言模型名称
  memoryModel?: string;
  // 记忆模块调用的API接口地址
  memoryApiUrl?: string;
  // 访问记忆API的身份验证密钥
  memoryApiKey?: string;
  // 记忆生成时的温度参数，设为false可禁用温度控制
  memoryTemperature?: number | false;
  // 传递给记忆API的额外自定义参数集合
  memoryExtraParams?: Record<string, unknown>;
  // 自动捕获流程的最大迭代次数限制
  autoCaptureMaxIterations?: number;
  // 自动捕获流程单次迭代的超时时间（毫秒）
  autoCaptureIterationTimeout?: number;
}

// 提供者配置覆写接口，用于在运行时覆盖默认的流程控制参数
interface ProviderConfigOverrides {
  // 流程的最大迭代次数，可覆盖全局默认配置
  maxIterations?: number;
  // 单次迭代的超时时间（毫秒），可覆盖全局默认配置
  iterationTimeout?: number;
}

// 构建记忆提供者配置的核心导出函数，接收运行时配置和可选覆写参数，返回标准提供者配置对象
export function buildMemoryProviderConfig(
  // 记忆模块的运行时配置对象，包含所有记忆功能所需的可配置参数
  config: MemoryProviderRuntimeConfig,
  // 流程控制参数覆写对象，支持在运行时覆盖全局默认的迭代和超时配置，默认值为空对象
  overrides: ProviderConfigOverrides = {}
): ProviderConfig {
  // 从运行时配置中提取记忆模块使用的大语言模型名称
  const memoryModel = config.memoryModel;
  // 从运行时配置中提取记忆模块调用的API接口地址
  const memoryApiUrl = config.memoryApiUrl;
  // 从运行时配置中提取访问记忆API的身份验证密钥
  const memoryApiKey = config.memoryApiKey;
  // 初始化配置校验错误数组，用于收集所有未通过校验的配置问题
  const issues: string[] = [];

  // 校验记忆模型名称是否存在，不存在则添加缺失错误信息
  if (!memoryModel) issues.push("missing memoryModel");
  // 校验记忆API地址是否存在，不存在则添加缺失错误信息
  if (!memoryApiUrl) issues.push("missing memoryApiUrl");
  // 校验记忆API密钥是否存在，不存在则添加缺失错误信息
  if (!memoryApiKey) issues.push("missing memoryApiKey");
  // 校验API密钥是否为占位符值，若是则提示需要替换为真实密钥
  if (isPlaceholderApiKey(memoryApiKey)) issues.push("replace the placeholder memoryApiKey value");

  // 若存在任何配置错误，拼接所有错误信息并抛出异常，终止配置构建流程
  if (issues.length > 0) {
    throw new Error(`External API not configured for memory provider: ${issues.join("; ")}`);
  }

  // 所有配置校验通过，返回符合基础提供者规范的标准配置对象
  return {
    // 标准化模型名称字段，空值兜底为空字符串保证类型安全
    model: memoryModel || "",
    // 标准化API地址字段，空值兜底为空字符串保证类型安全
    apiUrl: memoryApiUrl || "",
    // 标准化API密钥字段，空值兜底为空字符串保证类型安全
    apiKey: memoryApiKey || "",
    // 保留原始记忆生成温度配置，支持数值或禁用状态
    memoryTemperature: config.memoryTemperature,
    // 透传传递给记忆API的额外自定义参数集合
    extraParams: config.memoryExtraParams,
    // 优先级：覆写的最大迭代次数 > 运行时配置的自动捕获最大迭代次数，实现灵活的配置覆盖
    maxIterations: overrides.maxIterations ?? config.autoCaptureMaxIterations,
    // 优先级：覆写的单次迭代超时时间 > 运行时配置的自动捕获单次迭代超时时间，实现灵活的配置覆盖
    iterationTimeout: overrides.iterationTimeout ?? config.autoCaptureIterationTimeout,
  };
}
