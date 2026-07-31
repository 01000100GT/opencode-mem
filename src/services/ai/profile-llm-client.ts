// 导入OpencodeAI V2版本客户端类型定义，用于类型检查
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
// 导入全局配置对象，包含Opencode服务的核心配置参数
import { CONFIG } from "../../config.js";
// 导入Opencode提供者加载函数，负责初始化和连接不同的AI服务提供者
import { loadOpencodeProvider } from "./opencode-provider-loader.js";

// 缓存已初始化的Opencode客户端实例，避免重复创建连接损耗
let _cachedClient: OpencodeClient | null = null;
// 缓存当前使用的服务提供者名称，用于缓存有效性校验
let _cachedProvider: string | null = null;
// 缓存当前使用的模型名称，用于缓存有效性校验
let _cachedModel: string | null = null;

// 导出获取Opencode客户端的异步函数，返回类型为OpencodeClient实例的Promise对象
export async function getOpenCodeClient(): Promise<OpencodeClient> {
  // 从全局配置中读取当前配置的AI服务提供者名称，非空断言标记确保配置已注入
  const provider = CONFIG.opencodeProvider!;
  // 从全局配置中读取当前配置的模型名称，非空断言标记确保配置已注入
  const model = CONFIG.opencodeModel!;

  // 校验服务提供者和模型名称是否存在配置，缺失则抛出初始化错误
  if (!provider || !model) {
    throw new Error("opencode-mem: opencodeProvider and opencodeModel must be configured");
  }

  // 校验缓存有效性：客户端实例存在且提供者、模型与当前配置完全一致，直接返回缓存实例复用连接
  if (_cachedClient && _cachedProvider === provider && _cachedModel === model) {
    return _cachedClient;
  }

  // 从提供者加载结果中解构出连接状态校验函数和V2客户端获取方法
  const { isProviderConnected, getV2Client } = await loadOpencodeProvider();

  // 校验当前配置的服务提供者是否已成功建立连接，连接失败则抛出配置错误异常
  if (!isProviderConnected(provider)) {
    throw new Error(
      `opencode provider '${provider}' is not connected. Check your opencode provider configuration.`
    );
  }

  // 调用客户端获取方法，尝试获取已初始化的V2版本Opencode客户端实例
  const client = getV2Client();
  // 客户端实例获取失败（未完成初始化）时抛出核心初始化异常
  if (!client) {
    throw new Error("opencode-mem: v2 client not initialized");
  }

  // 将新创建的客户端实例存入缓存，实现后续请求的连接复用
  _cachedClient = client;
  // 记录当前缓存客户端绑定的服务提供者名称，用于后续缓存有效性校验
  _cachedProvider = provider;
  // 记录当前缓存客户端绑定的模型名称，用于后续缓存有效性校验
  _cachedModel = model;
  // 将初始化完成的客户端实例返回给调用方
  return client;
}
