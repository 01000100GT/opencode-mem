/**
 * 通过 opencode HTTP 服务器实现的结构化输出功能。
 *
 * Structured output via the opencode HTTP server.
 *
 * 取代了旧版的 auth.json/OAuth 令牌处理流程。我们不再手动构造发往模型服务商
 * HTTP 端点的请求，而是将所有请求转发给正在运行的 opencode 服务器——它已经
 * 全权管理用户的所有认证信息（支持所有服务商，包括个人/企业版 GitHub Copilot）、
 * 令牌自动刷新以及服务商路由逻辑。
 *
 * Replaces the older auth.json/OAuth-juggling flow. Instead of forging
 * requests to provider HTTP endpoints ourselves, we delegate to the
 * running opencode server: it already owns the user's auth (any provider,
 * including github-copilot personal/business), token refresh, and provider
 * routing.
 *
 * 每次调用该功能时，我们会先创建一个临时会话，使用 JSON Schema 向其发送提问，
 * 完成后立即删除该会话，避免它出现在用户的 TUI 会话列表中造成干扰。
 *
 * Per call we create a transient session, prompt it with a JSON schema,
 * then delete the session so it does not pollute the user's TUI session
 * list.
 *
 * 主要传输方式是基于插件宿主的客户端配置初始化的已认证 v2 SDK 客户端。
 * 对于未暴露 v2 会话方法的旧版 SDK，我们保留了原生 fetch 作为后备方案。
 *
 * The primary transport is the authenticated v2 SDK client initialized from
 * the plugin host's client configuration. A raw fetch fallback remains for
 * older SDK builds that do not expose the v2 session methods.
 */

// 引入 Zod 库的类型定义，Zod 是一个用于 TypeScript 的类型声明和数据验证工具
import type { z } from "zod";
// 引入 opencode v2 版本 SDK 中客户端类型，用于和 opencode 服务器进行交互
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
// 从本地诊断工具模块导入所需工具函数和类型
import {
  diagnosticUrl,
  readJson,
  responseStatus,
  type FetchEndpoint,
} from "./opencode-diagnostics.js";
// 从本地SDK客户端模块导入懒加载V2客户端创建函数和主机传输层类型
import { createLazyV2Client, type HostTransport } from "./opencode-sdk-client.js";

// 存储已连接的AI服务提供商列表，用于快速查询指定提供商是否完成认证接入
let _connectedProviders: Set<string> = new Set();
// 保存初始化完成的opencode v2版本SDK客户端实例，全局复用同一客户端连接
let _v2Client: OpencodeClient | undefined;
// 记录opencode服务器的基础访问地址，所有API请求都会基于该地址拼接生成
let _v2BaseUrl: string | undefined;
// 存储自定义的fetch请求实现，可替代全局fetch实现代理、日志拦截等自定义请求逻辑
let _hostFetch: typeof fetch | undefined;
// 标记是否启用SDK原生传输层，为true时会优先使用SDK封装的请求能力而非原生fetch
let _useSdkTransport = false;
// 设置自定义的fetch请求实现，用于替代全局fetch，可实现代理、日志拦截等自定义请求逻辑
export function setHostFetch(customFetch: typeof fetch): void {
  // 将传入的自定义fetch实现保存到模块级变量_hostFetch中，供后续所有网络请求使用
  _hostFetch = customFetch;
}

// 重置自定义的fetch请求实现，清空之前设置的_hostFetch变量，恢复使用全局原生fetch
export function resetHostFetch(): void {
  _hostFetch = undefined;
}

// 设置已连接的AI服务提供商列表，将传入的提供商数组转换为Set存储以支持高效的存在性检查
export function setConnectedProviders(providers: string[]): void {
  _connectedProviders = new Set(providers);
}

// 检查指定的AI服务提供商是否已完成连接认证，通过查询全局提供商集合快速判断
export function isProviderConnected(providerName: string): boolean {
  return _connectedProviders.has(providerName);
}

// 设置全局使用的opencode v2 SDK客户端实例，替换原有的客户端实例
export function setV2Client(client: OpencodeClient): void {
  _v2Client = client;
}

// 获取当前全局存储的opencode v2 SDK客户端实例，未初始化时返回undefined
export function getV2Client(): OpencodeClient | undefined {
  return _v2Client;
}

export function createV2Client(serverUrl: URL | string, transport?: HostTransport): OpencodeClient {
  // 将输入的服务器地址统一转换为字符串格式，支持直接传入URL对象或字符串
  const baseUrl = typeof serverUrl === "string" ? serverUrl : serverUrl.toString();
  // 确定最终使用的传输层配置：优先使用传入的transport参数，否则如果存在全局自定义fetch则创建基础配置
  const activeTransport = transport ?? (_hostFetch ? { fetch: _hostFetch } : undefined);
  // 保存服务器基础URL到模块级变量，供后续API调用时使用
  _v2BaseUrl = baseUrl;
  // 标记是否启用SDK原生传输：只要activeTransport存在自定义fetch或请求头就启用
  _useSdkTransport = Boolean(activeTransport?.fetch || activeTransport?.headers);
  // 创建并返回懒加载初始化的V2客户端实例
  return createLazyV2Client(baseUrl, activeTransport);
}

/**
 * 结构化输出生成操作的配置选项接口，定义了调用generateStructuredOutput函数所需的全部参数
 * Generic type parameter T: 结构化输出的目标类型，输出结果会经过Zod验证以匹配该类型
 */
export interface StructuredOutputOptions<T> {
  // 已完成认证初始化的opencode v2 SDK客户端实例，用于与后端服务器通信
  client: OpencodeClient;
  // AI服务提供商的唯一标识符，标识请求发送到哪个模型服务商（如github-copilot等）
  providerID: string;
  // 要调用的具体模型的唯一标识符，指定使用该提供商下的哪个模型进行生成
  modelID: string;
  // 用于定义AI角色定位和行为规则的系统提示词，引导模型遵循指定的输出要求
  systemPrompt: string;
  // 用户的实际提问或请求内容，是模型需要处理的核心输入信息
  userPrompt: string;
  // Zod架构验证对象，用于定义输出数据的结构规范并对生成结果做运行时类型校验
  schema: z.ZodType<T>;
  // 可选参数：会话关联的工作目录路径，用于支持多工作区隔离的会话管理
  directory?: string;
  // 可选参数：当结构化输出验证失败时的自动重试次数，提升生成成功率
  retryCount?: number;
}

/**
 * 通过opencode的HTTP API生成一次结构化输出补全结果。
 * Generate one structured-output completion via opencode's HTTP API.
 * 以下场景会抛出异常：会话创建失败、提示词调用失败、助手消息返回错误（包含StructuredOutputError、ApiError等各类错误）、缺少`info.structured`字段，或者最终的ZodSchema验证不通过。
 * Throws on: session.create failure, prompt failure, AssistantMessage.error
 * (StructuredOutputError / ApiError / ...), missing `info.structured`,
 * or final Zod validation failure.
 */
// 定义生成结构化输出的异步函数，接收结构化输出配置选项作为参数，返回匹配Zod schema的类型化结果
export async function generateStructuredOutput<T>(opts: StructuredOutputOptions<T>): Promise<T> {
  // 从配置选项中解构提取所需的全部参数，包括客户端实例、服务商ID、模型ID、提示词、验证schema等
  const { client, providerID, modelID, systemPrompt, userPrompt, schema, directory, retryCount } =
    opts;

  // 尝试将Zod schema转换为JSON schema格式：优先调用schema自带的toJSONSchema方法，不存在则动态导入zod工具转换
  const jsonSchema =
    (
      schema as unknown as {
        toJSONSchema?: () => Record<string, unknown>;
      }
    ).toJSONSchema?.() ?? (await import("zod")).z.toJSONSchema(schema);

  // 检查是否满足使用SDK原生传输层的条件：已启用SDK传输且客户端支持v2会话管理方法
  if (_useSdkTransport && hasV2SessionClient(client)) {
    // 满足条件则调用SDK客户端专用的生成逻辑，传入所有必要参数并返回执行结果
    return generateViaSdkClient(client, {
      providerID,
      modelID,
      systemPrompt,
      userPrompt,
      directory,
      retryCount,
      jsonSchema,
      schema,
    });
  }

  // 从模块级全局变量中获取v2服务器的基础URL地址
  const baseUrl = _v2BaseUrl;
  // 检查服务器基础URL是否已完成初始化
  if (!baseUrl) {
    // 若未初始化则抛出明确的错误提示，引导用户先调用createV2Client完成配置
    throw new Error(
      "opencode-mem: v2 server base URL not initialized; call createV2Client(serverUrl) first"
    );
  }
  // 调用工具函数去除URL末尾可能存在的斜杠，统一URL格式避免后续路径拼接出错
  const base = stripTrailingSlash(baseUrl);

  // 调用会话创建函数，传入服务器基础地址和可选工作目录参数
  // 异步等待服务器返回新创建的会话唯一标识符
  const sessionID = await createSession(base, directory);
  try {
    // 调用promptSession函数向指定会话发送提示请求，等待模型返回处理结果
    // 传入服务器基础地址和所有必要参数配置，包括会话ID、工作目录、服务商信息等
    const info = await promptSession(base, {
      // 要交互的会话唯一标识符，对应之前创建的临时会话ID
      sessionID,
      // 会话关联的工作目录路径，用于多工作区场景下的会话隔离
      directory,
      // AI服务提供商的唯一标识，指定请求发送到哪个模型服务商（如github-copilot）
      providerID,
      // 要调用的具体模型唯一标识，指定使用该服务商下的哪个模型生成内容
      modelID,
      // 用于定义AI角色定位和行为规则的系统提示词，引导模型遵循输出要求
      systemPrompt,
      // 用户的实际提问或请求内容，是模型需要处理的核心输入信息
      userPrompt,
      // 定义输出数据结构的JSON Schema，强制模型按照指定格式生成内容
      jsonSchema,
      // 结构化输出验证失败时的自动重试次数，提升生成成功率
      retryCount,
    });

    // 检查会话处理过程中是否返回了错误信息
    if (info.error) {
      // 如果存在错误，抛出包含错误名称和格式化详情的异常，便于问题定位
      throw new Error(
        `opencode-mem: opencode reported ${info.error.name}: ${formatAssistantError(info.error)}`
      );
    }

    // 兼容新旧字段命名：优先获取新版的structured_output，若不存在则回退到旧版的structured字段
    const structuredOutput = info.structured_output ?? info.structured;
    // 检查结构化输出是否为空值（undefined或null）
    if (structuredOutput === undefined || structuredOutput === null) {
      // 抛出明确的错误信息，提示服务器返回的结构化输出字段均为空
      throw new Error(
        "opencode-mem: opencode returned no structured output (info.structured_output/info.structured were empty)"
      );
    }

    // 使用Zod验证器对模型返回的结构化输出数据进行运行时类型校验
    // 若数据结构不匹配schema定义的规则，会直接抛出类型验证错误
    // 确保最终返回的结果完全符合我们预先定义的TypeScript类型结构
    return schema.parse(structuredOutput);
  } finally {
    // 采用尽力而为的清理策略：临时会话残留仅影响界面展示，若清理过程出错，绝不能因此中断已成功完成的结构化数据捕获流程
    // Best-effort: leaving a transient session behind is cosmetic, not
    // worth failing a successful capture if cleanup itself errors.
    try {
      // 调用服务端会话删除接口，销毁本次创建的临时会话
      await deleteSession(base, sessionID, directory);
    } catch {
      // 主动吞掉所有清理过程中抛出的异常，避免清理失败影响主流程
      // intentionally swallowed
    }
  }
}

// 定义支持v2会话管理能力的SDK客户端类型约束
// 用于描述具备创建、交互、删除会话全流程能力的客户端实例结构
type V2SessionClient = {
  // session属性承载所有与会话生命周期相关的核心操作方法
  session: {
    // 创建新会话的异步方法，支持传入可选的配置参数，返回服务器端的通用响应数据
    create(parameters?: Record<string, unknown>): Promise<unknown>;
    // 向指定会话发送提示请求的异步方法，接收必填的请求参数，返回服务器端的通用响应数据
    prompt(parameters: Record<string, unknown>): Promise<unknown>;
    // 删除指定会话的异步方法，接收必填的会话标识参数，返回服务器端的通用响应数据
    delete(parameters: Record<string, unknown>): Promise<unknown>;
  };
};

// 为SDK客户端专属的结构化输出流程定义的参数接口，泛型T代表最终输出的目标数据类型
// 该接口集中封装了调用SDK会话方法生成结构化输出所需的全部输入参数
interface SdkStructuredOutputArgs<T> {
  // AI服务提供商的唯一标识符，指定请求发送到哪个模型服务商（如github-copilot）
  providerID: string;
  // 要调用的具体模型的唯一标识符，指定使用该提供商下的哪个模型进行生成
  modelID: string;
  // 用于定义AI角色定位和行为规则的系统提示词，引导模型遵循指定的输出要求
  systemPrompt: string;
  // 用户的实际提问或请求内容，是模型需要处理的核心输入信息
  userPrompt: string;
  // 可选参数：会话关联的工作目录路径，用于支持多工作区场景下的会话隔离
  directory?: string;
  // 可选参数：当结构化输出验证失败时的自动重试次数，提升生成成功率
  retryCount?: number;
  // 用于强制模型输出格式的JSON Schema定义，是描述输出数据结构的原始JSON对象
  jsonSchema: Record<string, unknown>;
  // Zod架构验证对象，用于对模型返回的结构化数据做运行时类型校验，确保符合T的类型定义
  schema: z.ZodType<T>;
}

// 类型守卫函数：检查传入的OpencodeClient实例是否具备完整的v2会话管理能力
// 类型谓词`client is OpencodeClient & V2SessionClient`用于在TypeScript中收窄类型，确保后续可以安全调用会话方法
function hasV2SessionClient(client: OpencodeClient): client is OpencodeClient & V2SessionClient {
  // 从客户端实例中提取session属性，先通过unknown中转绕过类型检查，实现运行时的动态探测
  const session = (client as unknown as { session?: unknown }).session;
  // 验证session属性的类型合法性：必须是不为null的对象类型，否则直接判定不支持v2会话
  if (typeof session !== "object" || session === null) return false;
  // 将session对象转换为字符串键值对的通用记录类型，便于后续检查方法是否存在
  const candidate = session as Record<string, unknown>;
  // 逐一校验会话对象必须实现的三个核心方法，全部为函数类型才判定为符合v2会话客户端规范
  return (
    typeof candidate.create === "function" &&
    typeof candidate.prompt === "function" &&
    typeof candidate.delete === "function"
  );
}

// 定义通过SDK原生客户端生成结构化输出的异步函数，实现与纯fetch流程完全一致的能力
// 泛型T表示经Zod schema验证后的目标数据类型，保障输出结果的类型安全性
async function generateViaSdkClient<T>(
  // 已完成类型收窄的v2 SDK客户端实例，具备完整的会话生命周期管理能力
  client: OpencodeClient & V2SessionClient,
  // 结构化输出生成所需的全部输入参数封装对象，包含模型、提示词、Schema等核心配置
  args: SdkStructuredOutputArgs<T>
): Promise<T> {
  // 调用SDK客户端的会话创建接口，发起异步请求创建临时捕捉会话
  // 传入会话标题和可选的工作目录参数，确保与会话上下文正确关联
  const createdResponse = await client.session.create({
    title: "opencode-mem capture",
    ...(args.directory ? { directory: args.directory } : {}),
  });
  // 使用通用SDK响应解析工具提取服务端返回的核心数据，指定接口标签用于错误日志定位
  // 预期返回数据包含会话唯一标识id，类型收窄为仅含可选id字段的对象结构
  const created = readSdkData<{ id?: string }>(createdResponse, "POST /session");
  // 防御性校验：检查服务端是否返回了合法的会话标识符
  if (!created.id) {
    // 会话创建失败时抛出明确的错误信息，包含失败场景和问题根因，便于快速排查
    throw new Error(
      "opencode-mem: session.create returned no session id; cannot generate structured output"
    );
  }

  // 从会话创建响应中提取唯一标识符，后续所有对该临时会话的操作都将使用这个ID
  const sessionID = created.id;
  try {
    // 调用SDK客户端的会话消息发送接口，向指定会话提交模型推理请求
    // 异步等待服务端处理完成并返回推理结果
    const promptResponse = await client.session.prompt({
      // 目标会话的唯一标识符，指定与哪个临时会话进行交互
      sessionID,
      // 条件性注入工作目录参数：仅当传入了有效目录路径时才添加该字段
      ...(args.directory ? { directory: args.directory } : {}),
      // 配置模型的服务商和模型标识，指定请求路由到哪个AI服务节点
      model: { providerID: args.providerID, modelID: args.modelID },
      // 传入定义AI角色定位和输出规范的系统提示词
      system: args.systemPrompt,
      // 构造标准化的消息片段数组，将用户提问封装为SDK要求的格式
      parts: [{ type: "text", text: args.userPrompt }],
      // 配置输出格式强制约束，要求模型严格遵循指定的JSON Schema生成结果
      format: {
        // 指定输出格式类型为JSON Schema校验模式
        type: "json_schema",
        // 传入预先转换好的JSON Schema结构定义
        schema: args.jsonSchema,
        // 条件性注入重试次数参数：仅当传入了有效重试配置时才添加该字段
        ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
      },
    });
    // 使用SDK通用响应解析工具提取服务端返回的完整消息数据
    // 指定接口标签用于错误日志定位，将返回数据类型收窄为包含完整消息结构的类型
    const data = readSdkData<MessageV2WithParts>(promptResponse, "POST /session/{id}/message");
    // 检查响应数据中是否包含必要的info字段，该字段承载了助手回复的核心元数据
    if (!data.info) {
      throw new Error("opencode-mem: prompt response missing `info`");
    }
    // 检查info字段中是否携带了服务端返回的错误信息，若存在则抛出格式化后的异常
    if (data.info.error) {
      throw new Error(
        `opencode-mem: opencode reported ${data.info.error.name}: ${formatAssistantError(data.info.error)}`
      );
    }

    // 优先获取新版本的结构化输出字段structured_output，若不存在则兼容旧版本的structured字段
    const structuredOutput = data.info.structured_output ?? data.info.structured;
    // 检查结构化输出数据是否为空（undefined或null）
    if (structuredOutput === undefined || structuredOutput === null) {
      // 抛出明确的错误信息，提示服务器返回的两个结构化输出字段均为空
      throw new Error(
        "opencode-mem: opencode returned no structured output (info.structured_output/info.structured were empty)"
      );
    }
    // 使用Zod验证器对模型返回的结构化输出进行运行时类型校验，确保符合预定义的类型结构并返回
    return args.schema.parse(structuredOutput);
    // 使用finally块确保无论主逻辑是否抛出异常，都会执行会话清理操作
  } finally {
    // 包裹try-catch以实现尽力而为的清理策略，避免清理失败影响主流程结果
    try {
      // 调用SDK提供的会话删除接口，销毁本次创建的临时捕捉会话
      await client.session.delete({
        sessionID, // 要删除的会话唯一标识符
        // 若传入了工作目录参数，则同步携带到删除请求中，保持会话上下文一致
        ...(args.directory ? { directory: args.directory } : {}),
      });
    } catch {
      // 针对临时捕捉会话的尽力而为清理：即使删除失败也不会影响核心业务流程
      // Best-effort cleanup for the transient capture session.
    }
  }
}

// 从SDK统一响应格式中解析并提取核心业务数据的工具函数
// 泛型T代表预期的业务数据类型，确保返回结果的类型安全性
// 参数response: SDK接口返回的原始响应对象，结构未知需要运行时校验
// 参数label: 当前请求的接口标识，用于错误日志中定位失败的API调用
function readSdkData<T>(response: unknown, label: string): T {
  // 将原始响应转换为带类型约束的可选对象，兼容SDK返回undefined的异常场景
  // 声明响应可能包含的核心字段：业务数据data、错误信息error、请求对象request、响应对象response
  const result = response as
    | { data?: T; error?: unknown; request?: Request; response?: Response }
    | undefined;
  // 首先校验响应中是否携带了错误标识，SDK会用error字段标记请求失败场景
  if (result?.error !== undefined) {
    // 从响应对象中提取HTTP状态码并格式化，仅当存在完整响应对象时拼接状态信息
    const status = result.response ? ` (${responseStatus(result.response)})` : "";
    // 优先获取响应的URL地址，若响应不存在则回退到请求对象的URL，保证错误日志能定位到具体接口
    const responseUrl = result.response?.url || result.request?.url;
    // 将原始URL转换为可诊断的安全格式，若未获取到有效URL则使用默认描述文本
    const url = responseUrl ? diagnosticUrl(responseUrl) : "the authenticated client";
    // 抛出格式化后的错误信息，包含接口标签、访问地址、HTTP状态，响应体脱敏处理避免敏感信息泄露
    throw new Error(
      `opencode-mem: opencode ${label} failed at ${url}${status}: <redacted response body>`
    );
  }
  // 校验响应中是否存在合法的业务数据，若data字段为空则抛出数据缺失异常
  if (result?.data === undefined) {
    throw new Error(`opencode-mem: opencode ${label} returned no response data`);
  }
  // 所有校验通过后返回类型安全的业务数据，供上层逻辑处理
  return result.data;
}

// 去除URL字符串末尾的斜杠，确保URL格式统一，避免后续路径拼接时出现双斜杠问题
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// 构建URL查询参数，仅当传入有效工作目录时生成包含directory参数的查询字符串，对目录路径进行URL编码处理以防止特殊字符引发的请求异常
function buildQuery(directory?: string): string {
  if (!directory) return "";
  return `?directory=${encodeURIComponent(directory)}`;
}

// 通用的JSON数据异步获取函数，封装了统一的错误处理与响应解析逻辑
// 泛型T代表预期解析得到的目标数据类型，确保返回结果的类型安全性
async function fetchJson<T>(endpoint: FetchEndpoint, init: RequestInit): Promise<T> {
  // 声明响应对象变量，用于存储后续请求成功后返回的HTTP响应实例
  let res: Response;
  // 进入网络请求的异常捕获块，统一处理请求过程中可能抛出的各类错误
  try {
    // 调用当前激活的fetch实现（优先使用自定义fetch，否则回退到全局原生fetch）
    // 传入封装好的Request对象，将端点URL和请求配置合并后发起异步HTTP请求
    res = await activeFetch()(new Request(endpoint.url, init));
  } catch (error) {
    // 提取错误信息：若错误为Error实例则直接取其message属性，否则强制转换为字符串
    const message = error instanceof Error ? error.message : String(error);
    // 抛出格式化后的统一错误对象，包含请求标签、脱敏的诊断URL和具体错误详情
    throw new Error(
      `opencode-mem: failed to fetch ${endpoint.label} at ${diagnosticUrl(endpoint.url)}: ${message}`
    );
  }
  // 调用通用JSON解析工具函数，将HTTP响应体解析为目标类型T的数据并返回
  // 内部会自动处理响应状态码校验、JSON解析失败等异常场景
  return readJson<T>(res, endpoint);
}

// 异步创建临时会话的核心方法：通过opencode服务端REST接口生成专属捕捉会话
// 入参base为opencode服务端的基础URL地址，已通过stripTrailingSlash处理过末尾斜杠
// 入参directory为可选的工作目录路径，用于多工作区场景下的会话隔离
// 返回值为服务端生成的唯一会话ID字符串，后续所有会话操作都依赖该标识
async function createSession(base: string, directory?: string): Promise<string> {
  // 拼接完整的会话创建接口URL：基础地址+/session路径+拼接工作目录查询参数
  // buildQuery方法会自动对目录路径进行URL编码，避免特殊字符引发的请求异常
  const url = `${base}/session${buildQuery(directory)}`;
  // 调用通用fetchJson工具发起POST请求，获取服务端返回的会话核心数据
  // 泛型参数声明预期返回的结构体仅包含可选的id字段，符合服务端响应契约
  const body = await fetchJson<{ id?: string }>(
    // 第一个参数为FetchEndpoint类型的端点描述：label用于错误日志定位，url为完整请求地址
    { label: "POST /session", url },
    // 第二个参数为RequestInit配置对象，承载HTTP请求的核心配置
    {
      // 指定请求方法为POST，符合RESTful接口的资源创建规范
      method: "POST",
      // 设置请求体的编码类型为JSON，服务端才能正确解析传入的参数
      headers: { "Content-Type": "application/json" },
      // 序列化请求体：仅传入会话标题参数，标记该会话为opencode-mem模块的捕捉专用临时会话
      // 该标题会出现在用户的会话列表中（尽管我们后续会主动删除该临时会话）
      body: JSON.stringify({ title: "opencode-mem capture" }),
    }
  );
  // 防御性校验：检查服务端返回的会话数据中是否包含合法的会话ID
  if (!body.id) {
    // 若会话ID缺失则抛出明确的错误异常，包含模块标识、失败场景和根因描述
    throw new Error(
      "opencode-mem: session.create returned no session id; cannot generate structured output"
    );
  }
  // 所有校验通过后，将合法的会话ID返回给上层调用逻辑
  return body.id;
}

// 定义promptSession函数调用所需的参数接口，统一封装会话交互场景下的全部输入参数
interface PromptSessionArgs {
  // 目标会话的唯一标识符，用于定位要向哪个临时会话发送提示请求
  sessionID: string;
  // 可选参数：会话关联的工作目录路径，支持多工作区场景下的会话隔离
  directory?: string;
  // AI服务提供商的唯一标识，指定请求需要路由到哪个模型服务商节点
  providerID: string;
  // 具体调用的模型唯一标识，指定使用该服务商下的哪个模型完成推理
  modelID: string;
  // 定义AI角色定位和输出规范的系统提示词，引导模型生成符合要求的内容
  systemPrompt: string;
  // 用户的实际提问或请求内容，是模型需要处理的核心业务输入
  userPrompt: string;
  // 强制约束模型输出格式的JSON Schema定义，用于标准化结构化输出的数据结构
  jsonSchema: Record<string, unknown>;
  // 可选参数：结构化输出验证失败时的自动重试次数，提升最终生成成功率
  retryCount?: number;
}

// 助手消息核心信息接口，定义了与AI助手交互响应中的关键数据结构
interface AssistantInfo {
  // 旧版结构化输出字段，存储模型生成的非标准化结构化数据（兼容历史版本）
  structured?: unknown;
  // 新版标准化结构化输出字段，存储符合JSON Schema规范的模型生成结果
  structured_output?: unknown;
  // 错误信息字段，存储请求处理过程中发生的异常详情（可选）
  error?: {
    // 错误名称，标识错误的类型分类，用于快速定位错误场景
    name: string;
    // 错误附加数据，存储错误的具体上下文信息（可选）
    data?: {
      // 错误的人类可读描述信息，用于直观展示错误原因
      message?: string;
      // 支持任意额外的错误扩展字段，满足不同场景的错误数据需求
      [key: string]: unknown;
    };
  };
}

// 格式化AI助手返回的错误信息，生成可读的错误字符串
function formatAssistantError(error: NonNullable<AssistantInfo["error"]>): string {
  // 如果错误对象不存在附加数据，直接返回错误名称作为错误信息
  if (!error.data) return error.name;

  // 调用安全错误详情提取函数，从附加数据中过滤出可安全展示的字段信息
  const details = safeAssistantErrorDetails(error.data);
  // 如果错误对象中没有预设的消息文本，直接返回提取到的详情字符串
  if (!error.data.message) return details;

  // 若存在有效详情信息，则将错误消息与详情拼接返回；否则仅返回错误消息文本
  return details ? `${error.data.message}; ${details}` : error.data.message;
}

// 安全提取助手错误详情的工具函数：仅保留非敏感的基础诊断字段，避免泄露敏感信息
function safeAssistantErrorDetails(
  // 输入参数：经过非空校验的错误附加数据，来自AssistantInfo.error.data字段
  data: NonNullable<NonNullable<AssistantInfo["error"]>["data"]>
): string {
  // 初始化存储安全字段的对象，仅允许存入白名单内的基础类型数据
  const safeFields: Record<string, unknown> = {};
  // 遍历白名单内的可公开字段：状态码、服务商ID、模型ID，这些是排查问题的核心信息
  for (const key of ["statusCode", "providerID", "modelID"] as const) {
    // 从原始错误数据中取出当前字段的值
    const value = data[key];
    // 仅保留字符串、数字、布尔类型的基础值，过滤掉对象、数组等复杂类型，防止潜在敏感信息泄露
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safeFields[key] = value;
    }
  }
  // 将安全字段对象转换为键值对数组，用于后续判断是否有有效字段
  const entries = Object.entries(safeFields);
  // 如果没有提取到任何有效安全字段，直接返回空字符串，避免生成无效的details标识
  if (entries.length === 0) return "";
  // 将筛选后的安全字段序列化为JSON字符串，拼接成统一格式的详情文本返回
  return `details=${JSON.stringify(Object.fromEntries(entries))}`;
}

// 表示包含消息内容和结构的v2版本消息接口，用于承载AI助手返回的完整响应数据
interface MessageV2WithParts {
  // 存储助手返回的核心结构化信息，包含生成的输出数据和可能的错误详情
  info: AssistantInfo;
  // 存储消息的原始片段数组，可包含文本、图片等多种类型的内容负载，此处仅标记为未知类型数组以兼容多变的结构
  parts: unknown[];
}

// 向指定会话发送提示请求的异步核心方法，调用OpenCode服务端的消息接口获取AI生成结果
// 入参base为经过斜杠归一化处理的OpenCode服务端基础URL地址
// 入参args为封装了所有会话交互参数的配置对象，包含会话ID、模型信息、提示词等核心数据
// 返回值为包含AI生成结果和状态信息的AssistantInfo对象，承载结构化输出数据或错误详情
async function promptSession(base: string, args: PromptSessionArgs): Promise<AssistantInfo> {
  // 拼接完整的消息发送接口URL，对会话ID进行URL编码避免特殊字符引发请求异常，同时拼接工作目录查询参数实现多工作区隔离
  const url = `${base}/session/${encodeURIComponent(args.sessionID)}/message${buildQuery(args.directory)}`;
  // 构造发送给服务端的请求体对象，符合OpenCode v2 API的消息请求格式规范
  const body: Record<string, unknown> = {
    // 配置模型的服务商和模型标识，指定请求需要路由到哪个AI服务节点的具体模型
    model: { providerID: args.providerID, modelID: args.modelID },
    // 传入定义AI角色定位和输出规范的系统提示词，引导模型遵循指定要求生成内容
    system: args.systemPrompt,
    // 构造标准化的消息片段数组，将用户提问封装为SDK要求的文本类型消息格式
    parts: [{ type: "text", text: args.userPrompt }],
    // `noReply` suppresses assistant generation in current OpenCode builds,
    // which also suppresses `info.structured_output`; structured capture needs
    // the assistant run even though the temporary session is deleted afterward.
    // 配置输出格式强制约束，要求模型严格遵循指定的JSON Schema生成结构化结果
    format: {
      // 指定输出格式类型为JSON Schema校验模式，启用服务端的结构化输出能力
      type: "json_schema",
      // 传入预先从Zod Schema转换而来的JSON Schema结构定义，作为模型输出的格式约束
      schema: args.jsonSchema,
      // 条件性注入重试次数参数：仅当调用方传入了有效重试配置时才添加该字段，控制结构化输出验证失败后的自动重试次数
      ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
    },
  };
  // 调用通用fetchJson工具发起POST请求，解析服务端返回的完整消息数据，指定接口标签用于错误日志定位
  const data = await fetchJson<MessageV2WithParts>(
    { label: "POST /session/{id}/message", url },
    {
      // 指定请求方法为POST，符合RESTful接口的资源创建规范
      method: "POST",
      // 设置请求体的编码类型为JSON，确保服务端能够正确解析传入的请求参数
      headers: { "Content-Type": "application/json" },
      // 将构造好的请求体序列化为JSON字符串，作为请求的有效负载发送给服务端
      body: JSON.stringify(body),
    }
  );
  // 防御性校验服务端返回的响应数据中是否包含必要的info字段，该字段承载了助手回复的核心元数据
  if (!data.info) {
    // 若info字段缺失则抛出明确的错误异常，包含模块标识和错误场景描述，便于快速定位问题
    throw new Error("opencode-mem: prompt response missing `info`");
  }
  // 所有校验通过后，将服务端返回的助手核心信息返回给上层调用逻辑
  return data.info;
}

// 异步删除会话的核心方法：调用OpenCode服务端的REST接口销毁指定的临时会话
// 入参base为经过斜杠归一化处理的OpenCode服务端基础URL地址
// 入参sessionID为要删除的会话唯一标识符，用于定位服务端的目标会话资源
// 入参directory为可选的工作目录路径，保持与会话创建时的上下文一致以支持多工作区隔离
// 返回值为无返回内容的Promise，仅表示异步操作完成，删除失败时会抛出异常供上层调用方处理
async function deleteSession(base: string, sessionID: string, directory?: string): Promise<void> {
  // 拼接完整的会话删除接口URL，对会话ID进行URL编码避免特殊字符引发请求异常，同时拼接工作目录查询参数
  const url = `${base}/session/${encodeURIComponent(sessionID)}${buildQuery(directory)}`;
  // 声明响应对象变量，用于存储后续请求成功后返回的HTTP响应实例
  let res: Response;
  // 进入网络请求的异常捕获块，统一处理请求过程中可能抛出的各类错误
  try {
    // 调用当前激活的fetch实现发起DELETE请求，传入完整的接口URL和请求配置
    res = await activeFetch()(new Request(url, { method: "DELETE" }));
  } catch (error) {
    // 提取错误信息：若错误为Error实例则直接取其message属性，否则强制转换为字符串
    const message = error instanceof Error ? error.message : String(error);
    // 抛出格式化后的统一错误对象，包含请求标签、脱敏的诊断URL和具体错误详情
    throw new Error(
      `opencode-mem: failed to fetch DELETE /session/{id} at ${diagnosticUrl(url)}: ${message}`
    );
  }
  // DELETE /session/:id returns boolean. We only care that it ran; failures
  // are swallowed at the call site.
  // 检查HTTP响应状态是否正常，若返回的状态码不在200-299范围内则判定请求失败
  if (!res.ok) {
    // 抛出格式化后的错误异常，包含接口标识、脱敏的诊断URL和HTTP响应状态码
    throw new Error(
      `opencode-mem: opencode DELETE /session/{id} failed at ${diagnosticUrl(url)} (${responseStatus(res)})`
    );
  }
}

// 获取当前环境下可用的fetch函数实现，用于发起网络请求
// 返回值类型为标准的fetch接口类型，保证与Web API规范一致
function activeFetch(): typeof fetch {
  // 优先返回注入的宿主环境自定义fetch实现，若不存在则回退到全局原生fetch
  return _hostFetch ?? globalThis.fetch;
}
