// 从OpenCode AI插件模块导入Plugin类型和PluginInput类型，分别用于定义插件的结构和插件接收的输入参数类型
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
// 从OpenCode AI SDK模块导入Part类型，用于表示对话消息中的内容片段结构
import type { Part } from "@opencode-ai/sdk";
// 从OpenCode AI插件模块导入tool工具函数，用于创建插件可对外提供的工具方法
import { tool } from "@opencode-ai/plugin";
// 导入记忆客户端实例，提供记忆的增删改查、预热、关闭等核心操作能力
import { memoryClient } from "./services/client.js";
// 导入记忆上下文格式化工具，将搜索到的记忆列表整理为大模型可识别的提示词格式
import { formatContextForPrompt } from "./services/context.js";
// 导入标签获取工具，用于提取当前项目、用户的唯一标识标签，区分不同场景的记忆数据
import { getTags } from "./services/tags.js";
// 导入隐私处理工具：stripPrivateContent用于擦除内容中的敏感隐私信息，isFullyPrivate用于判断内容是否全部为隐私数据
import { stripPrivateContent, isFullyPrivate } from "./services/privacy.js";
// 导入自动记忆捕获工具，负责自动从对话、代码操作等场景中提取有效信息生成记忆
import { performAutoCapture } from "./services/auto-capture.js";
// 导入用户画像学习工具，通过分析用户的历史交互自动总结用户偏好、习惯等个性化特征
import { performUserProfileLearning } from "./services/user-memory-learning.js";
// 导入用户提示词管理器，负责持久化存储、管理会话中用户发送的所有提示词记录
import { userPromptManager } from "./services/user-prompt/user-prompt-manager.js";
// 导入Web服务器相关能力：startWebServer用于启动记忆可视化Web服务，WebServer是服务器实例类型定义
import { startWebServer, WebServer } from "./services/web-server.js";
// 导入Web服务鉴权类，为记忆可视化Web界面提供账号密码验证能力，保障访问安全
import { WebAuth } from "./services/web-auth.js";

// 从配置模块导入核心配置工具与状态：isConfigured检查配置是否就绪，CONFIG是全局配置实例，initConfig初始化配置，getAutoCaptureProviderStatus获取自动捕获模块的就绪状态
import { isConfigured, CONFIG, initConfig, getAutoCaptureProviderStatus } from "./config.js";
// 从日志服务模块导入日志工具：log是基础日志打印方法，isDiagEnabled检查诊断日志是否开启，diagLog用于输出诊断级别的调试日志
import { log, isDiagEnabled, diagLog } from "./services/logger.js";
// 从类型定义入口文件导入MemoryType类型，用于规范记忆数据的分类属性约束
import type { MemoryType } from "./types/index.js";
// 从语言检测服务模块导入getLanguageName函数，用于将语言编码转换为自然语言名称
import { getLanguageName } from "./services/language-detector.js";
// 从记忆客户端模块导入MemoryScope类型，用于定义记忆检索的作用域（当前项目/所有项目）
import type { MemoryScope } from "./services/client.js";
// 从OpenCode主机配置服务导入getHostClientConfig函数，用于获取与OpenCode宿主环境交互的客户端配置
import { getHostClientConfig } from "./services/ai/opencode-host-config.js";
// 从OpenCode提供者加载器导入loadOpencodeProvider函数，用于加载并初始化OpenCode服务提供者相关能力
import { loadOpencodeProvider } from "./services/ai/opencode-provider-loader.js";

// 导出函数：判断是否为结构化摘要提示消息，用于过滤插件自身生成的系统消息
export function isStructuredSummaryPromptMessage(userMessage: string): boolean {
  // This is the plugin's own structured-summary request. OpenCode echoes it
  // through chat.message like a normal user message, but capturing it would
  // create self-referential memories about the memory prompt instead of the
  // user's conversation.
  // 检查用户消息是否同时包含指定的结构化分析标识和跳过标记，符合条件则判定为系统生成的摘要请求
  return userMessage.includes("Analyze this conversation.") && userMessage.includes('type="skip"');
}

// 导出配置OpenCode宿主传输层的异步函数，负责初始化与OpenCode服务端的通信通道
export async function configureOpencodeHostTransport(ctx: {
  // 上下文参数中的客户端实例，类型为unknown以兼容不同宿主环境的客户端实现
  readonly client: unknown;
  // 可选的服务端地址参数，支持字符串格式的URL或URL对象，用于指定自定义服务端地址
  readonly serverUrl?: string | URL;
}): Promise<void> {
  // 从OpenCode服务提供者模块中解构获取创建V2版本客户端、重置主机fetch配置、设置主机fetch实例、设置V2客户端实例的核心方法
  const { createV2Client, resetHostFetch, setHostFetch, setV2Client } =
    await loadOpencodeProvider();
  // 重置主机环境的fetch配置，清除之前可能存在的旧配置状态，避免配置冲突
  resetHostFetch();
  // 调用宿主配置获取函数，解析当前上下文生成与OpenCode主机通信所需的完整配置对象
  const hostConfig = getHostClientConfig(ctx);
  // 校验主机配置中是否存在可用的自定义fetch实现
  if (hostConfig.fetch) {
    // 若存在主机提供的fetch实例，将其设置为SDK全局使用的网络请求方法，确保与宿主环境的网络策略一致
    setHostFetch(hostConfig.fetch);
  } else {
    // 若主机未提供专用fetch实现，记录降级警告日志，同时输出调试上下文辅助定位问题
    log("OpenCode host fetch unavailable; falling back to global fetch", {
      // 携带当前客户端的身份标识密钥，用于日志链路追踪
      clientKeys: hostConfig.clientKeys,
      // 携带当前SDK已加载的配置项数量，辅助排查配置初始化异常
      sdkConfigCount: hostConfig.sdkConfigCount,
    });
  }

  // 拼接最终服务端地址，优先使用主机配置中的baseUrl，回退到上下文传入的serverUrl
  const serverUrl = hostConfig.baseUrl ?? ctx.serverUrl;
  // 若最终服务端地址存在则初始化V2客户端
  if (serverUrl) {
    // 调用SDK提供的setV2Client方法设置全局V2客户端实例
    setV2Client(
      // 调用createV2Client工厂方法创建V2版本的服务端通信客户端
      createV2Client(serverUrl, {
        // 传入主机环境适配的fetch实现，保证网络请求与宿主环境策略一致
        fetch: hostConfig.fetch,
        // 传入主机配置的请求头，携带身份认证等必要的请求上下文
        headers: hostConfig.headers,
      })
    );
  }
}

// 记录自动捕获提供者的状态日志函数，用于在自动捕获功能未就绪时输出诊断信息
function logAutoCaptureProviderStatus(): void {
  // 如果自动捕获功能已被配置禁用，或者自动捕获提供者状态标记为就绪，则直接返回，无需输出日志
  if (!CONFIG.autoCaptureEnabled || CONFIG.autoCaptureProviderStatus.ready) return;

  // 输出自动捕获功能被禁用的日志，拼接所有异常问题详情以便排查配置错误
  log(
    `Auto-capture disabled by configuration. Issues: ${CONFIG.autoCaptureProviderStatus.issues.join("; ")}.`
  );
}

// 定义并导出OpenCode记忆插件实例，实现Plugin接口，接收插件输入上下文作为参数
export const OpenCodeMemPlugin: Plugin = async (ctx: PluginInput) => {
  // 从插件上下文中解构获取当前工作目录路径
  const { directory } = ctx;
  // 使用当前目录初始化插件核心配置，加载本地配置文件与环境变量
  initConfig(directory);
  // 记录自动记忆捕获模块的提供者状态，若存在配置问题则输出诊断日志
  logAutoCaptureProviderStatus();
  // 获取当前项目与用户的唯一标识标签集合，用于区分不同场景的记忆数据
  const tags = getTags(directory);
  // 声明Web服务器实例变量，初始化为null，用于后续管理记忆可视化服务的生命周期
  let webServer: WebServer | null = null;
  // 声明空闲超时定时器变量，初始化为null，用于处理会话空闲后的自动记忆捕获任务调度
  let idleTimeout: Timer | null = null;

  // 仅当诊断日志功能开启时执行插件就绪状态诊断输出
  if (isDiagEnabled()) {
    // 获取自动记忆捕获模块的当前运行状态，包含就绪标记与异常问题列表
    const providerStatus = getAutoCaptureProviderStatus(CONFIG);
    // 输出插件入口处的诊断日志，记录插件整体就绪状态详情
    diagLog("index.ts:pluginEntry", "plugin readiness", {
      // 插件核心配置是否已完成初始化加载
      isConfigured: isConfigured(),
      // 自动记忆捕获功能是否已就绪可正常运行
      autoCaptureReady: providerStatus.ready,
      // 自动捕获模块启动时遇到的所有配置或环境问题详情
      autoCaptureIssues: providerStatus.issues,
      // 标记插件配置状态与自动捕获模块就绪状态是否存在不一致异常
      mismatch: isConfigured() !== providerStatus.ready,
    });
  }

  // 检查插件核心配置是否未完成初始化
  if (!isConfigured()) {
    // 如果诊断日志功能已开启
    if (isDiagEnabled()) {
      // 输出诊断日志：记录此处isConfigured为false的场景，同时标记该代码块实际为无效死代码（永远不会被执行
      diagLog("index.ts:75", "isConfigured false — empty block (dead code)");
    }
  }

  // 定义全局唯一的Symbol键，用于标记插件是否已完成预热初始化，使用Symbol.for确保跨全局作用域共享同一Symbol实例
  const GLOBAL_PLUGIN_WARMUP_KEY = Symbol.for("opencode-mem.plugin.warmedup");

  // 检查插件是否未完成预热初始化且核心配置已加载完成，只有满足条件才会进入预热流程
  if (!(globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] && isConfigured()) {
    // 如果诊断日志功能已开启，输出预热防护条件的诊断日志
    if (isDiagEnabled()) {
      // 记录预热守卫条件的执行状态：由于isConfigured始终为true，该条件会一直通过
      diagLog("index.ts:93", "warmup guard — isConfigured always true so always passes");
    }
    // Fire-and-forget: warmup is slow (embedding model load + index rebuild).
    // Awaiting it here serializes opencode's plugin loader and starves the TUI,
    // which gave the symptom "opencode hangs ~70s then disconnects on startup".
    // 启动即忘模式：预热过程耗时较长（包含嵌入模型加载与索引重建）
    // 若在此处直接await等待预热完成，会导致OpenCode的插件加载器串行阻塞， starving 终端UI线程
    // 曾经引发的现象是："opencode启动后卡顿约70秒，随后主动断开连接"
    (async () => {
      // 异步IIFE立即执行函数，脱离主线程执行预热逻辑
      try {
        // 调用记忆客户端的预热方法，完成模型加载与索引构建
        await memoryClient.warmup();
        // 预热成功后，在全局对象上标记插件已完成预热初始化
        (globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] = true;
      } catch (error) {
        // 捕获预热过程中的所有异常，记录错误日志避免进程崩溃
        log("Plugin warmup failed", { error: String(error) });
      }
    })();
  }

  // 调用OpenCode宿主传输层配置函数，完成与OpenCode服务端通信通道的初始化
  await configureOpencodeHostTransport(ctx);

  // 异步IIFE立即执行函数：初始化OpenCode服务提供者状态，脱离主线程避免阻塞插件加载流程
  (async () => {
    try {
      // 调用宿主客户端提供的provider列表查询接口，获取当前已连接的服务提供者信息
      const providerResult = await ctx.client.provider.list();
      // 校验返回结果中是否存在有效连接的提供者列表
      if (providerResult.data?.connected) {
        // 从OpenCode提供者加载模块中导入设置已连接提供者集合的核心方法
        const { setConnectedProviders } = await loadOpencodeProvider();
        // 将查询到的已连接提供者列表存入全局状态，供系统后续调度使用
        setConnectedProviders(providerResult.data.connected);
        // 记录服务提供者连接成功日志，携带连接列表与本地配置的提供者信息便于排查
        log("opencode providers connected", {
          list: providerResult.data.connected,
          configured: CONFIG.opencodeProvider || "(not set)",
        });
      } else {
        // 若提供者列表为空或查询失败，记录警告日志并截断过长的返回数据避免日志膨胀
        log("opencode provider list empty or failed", {
          data: JSON.stringify(providerResult.data).substring(0, 100),
        });
      }
    } catch (error) {
      // 捕获整个初始化流程中的所有异常，记录错误信息避免进程崩溃，同时保留错误上下文
      log("Failed to initialize opencode provider state", { error: String(error) });
    }
  })();

  if (CONFIG.webServerEnabled) {
    // 判断配置项中是否开启了Web服务器功能
    const webAuth = new WebAuth({
      // 实例化Web服务鉴权模块，用于提供访问身份验证能力
      password: CONFIG.webServerAuthPassword, // 传入配置中设置的Web服务认证密码
      username: CONFIG.webServerAuthUsername, // 传入配置中设置的Web服务认证用户名
    });

    // 启动Web服务器，传入配置参数，包括端口、主机地址、启用状态和鉴权实例
    startWebServer({
      port: CONFIG.webServerPort, // 服务器端口，从全局配置中读取
      host: CONFIG.webServerHost, // 服务器监听的主机地址，从全局配置中读取
      enabled: CONFIG.webServerEnabled, // 服务器启用状态，从全局配置中读取
      auth: webAuth, // 传入之前实例化的Web鉴权对象，用于身份验证
    })
      // 服务器启动成功后的回调函数，接收启动完成的服务器实例
      .then((server) => {
        // 将启动后的服务器实例赋值给模块级别的webServer变量，便于后续管理
        webServer = server;
        // 调用服务器实例的getUrl方法，获取可访问的完整服务地址
        const url = webServer.getUrl();

        // 为服务器设置所有权接管回调函数，当当前进程接管服务器所有权时触发
        webServer.setOnTakeoverCallback(async () => {
          // 检查插件上下文的客户端是否存在TUI（终端用户界面）实例
          if (ctx.client?.tui) {
            // 调用TUI的showToast方法，在终端显示一个提示消息
            ctx.client.tui
              .showToast({
                // 提示消息的主体内容配置
                body: {
                  title: "Memory Explorer", // 提示框标题，标识为记忆浏览器服务
                  message: "Took over web server ownership", // 提示内容，说明已成功接管服务器所有权
                  variant: "success", // 提示类型为成功，使用成功样式展示
                  duration: 3000, // 提示框展示时长为3000毫秒（3秒）
                },
              })
              // 捕获showToast方法可能抛出的异常，空处理避免影响后续流程
              .catch(() => {});
          }
        });

        // 检查当前进程是否为Web服务器的所有者进程
        if (webServer.isServerOwner()) {
          // 验证插件上下文的客户端是否存在终端用户界面(TUI)实例
          if (ctx.client?.tui) {
            // 调用TUI的Toast提示方法，在终端展示服务启动成功通知
            ctx.client.tui
              .showToast({
                body: {
                  // 提示框标题，标识为记忆资源管理器服务
                  title: "Memory Explorer",
                  // 根据鉴权模块状态拼接提示消息：启用鉴权则标注需认证，否则仅展示服务地址
                  message: webAuth.isEnabled()
                    ? `Web UI started at ${url} (auth required)`
                    : `Web UI started at ${url}`,
                  // 提示类型设置为成功状态，使用成功样式渲染
                  variant: "success",
                  // 提示框持续展示时长为5000毫秒（5秒）
                  duration: 5000,
                },
              })
              // 捕获showToast方法可能抛出的异常，空处理避免影响后续流程
              .catch(() => {});
          }
        } else {
          // 检查插件上下文的客户端是否存在终端用户界面(TUI)实例
          if (ctx.client?.tui) {
            // 调用TUI的Toast提示方法，在终端展示Web服务已就绪通知
            ctx.client.tui
              .showToast({
                body: {
                  // 提示框标题，标识为记忆浏览器服务
                  title: "Memory Explorer",
                  // 提示内容，告知用户Web UI服务已可通过指定地址访问
                  message: `Web UI available at ${url}`,
                  // 提示类型设置为信息状态，使用信息样式渲染
                  variant: "info",
                  // 提示框持续展示时长为3000毫秒（3秒）
                  duration: 3000,
                },
              })
              // 捕获showToast方法可能抛出的异常，空处理避免影响后续流程
              .catch(() => {});
          }
        }
      })
      .catch((error) => {
        // 捕获Web服务器启动过程中发生的所有异常
        // 记录Web服务器启动失败的错误日志，将错误对象转换为字符串存入日志上下文
        log("Web server failed to start", { error: String(error) });

        // 检查插件上下文的客户端是否存在终端用户界面(TUI)实例，确保可以发送前端提示
        if (ctx.client?.tui) {
          // 调用TUI的showToast方法在终端显示错误提示，通知用户Web服务启动失败
          ctx.client.tui
            .showToast({
              body: {
                // 提示框标题，标识为记忆浏览器服务错误
                title: "Memory Explorer Error",
                // 提示内容，拼接具体的错误原因，告知用户启动失败的详情
                message: `Failed to start: ${String(error)}`,
                // 提示类型设置为错误状态，使用错误样式渲染提示框
                variant: "error",
                // 提示框持续展示时长为5000毫秒（5秒），确保用户有足够时间查看错误信息
                duration: 5000,
              },
            })
            // 捕获showToast方法可能抛出的异常，空处理避免内部错误影响后续流程
            .catch(() => {});
        }
      });
  }

  // 定义插件资源清理异步函数，负责释放所有持有的系统资源与连接
  const cleanupPlugin = async () => {
    // 检查空闲超时定时器是否存在，避免空指针调用
    if (idleTimeout) {
      // 清除定时器，终止等待执行的空闲处理任务
      clearTimeout(idleTimeout);
      // 将定时器变量重置为null，标记资源已释放
      idleTimeout = null;
    }
    // 检查Web服务器实例是否存在，若存在则异步停止服务
    if (webServer) await webServer.stop();
    // 检查记忆客户端实例是否存在，若存在则关闭底层数据库连接
    if (memoryClient) memoryClient.close();
  };

  // 定义异步关闭处理器函数，负责插件退出前的资源清理与错误处理
  const shutdownHandler = async () => {
    // 进入try块捕获清理过程中的所有异常，避免未捕获错误导致进程异常退出
    try {
      // 调用插件资源清理函数，等待所有系统资源（定时器、Web服务器、数据库连接）释放完成
      await cleanupPlugin();
    } catch (error) {
      // 捕获清理过程中发生的任何错误，记录关闭流程异常日志，将错误对象转换为字符串存入日志上下文
      log("Shutdown error", { error: String(error) });
      // 设置进程退出码为1，表示异常退出，符合操作系统进程退出状态码规范
      process.exitCode = 1;
    }
  };

  // 监听进程中断信号（Ctrl+C触发），触发优雅关闭流程
  process.on("SIGINT", shutdownHandler);
  // 监听进程终止信号（系统级终止请求），触发优雅关闭流程
  process.on("SIGTERM", shutdownHandler);
  // 监听进程退出事件，做最后保障的资源清理
  process.on("exit", () => {
    // 若Web服务器实例存在，尝试停止服务并忽略可能的错误
    if (webServer) webServer.stop().catch(() => {});
    // 若记忆客户端实例存在，关闭底层数据库连接释放资源
    if (memoryClient) memoryClient.close();
  });

  return {
    // 处理聊天消息事件的异步处理器，接收输入输出参数
    "chat.message": async (input, output) => {
      // 检查核心配置未完成 或 聊天消息功能未启用，满足任一条件则跳过后续处理
      if (!isConfigured() || !CONFIG.chatMessage.enabled) {
        // 如果诊断日志功能已开启，输出诊断日志记录防护条件状态
        if (isDiagEnabled()) {
          // 调用诊断日志函数，记录聊天消息模块的守卫条件实际生效逻辑
          diagLog(
            "index.ts:237",
            "chat.message guard — isConfigured always true, actual gate: CONFIG.chatMessage.enabled",
            {
              // 核心配置的完成状态，传入当前实际值便于日志追踪
              isConfigured: isConfigured(),
              // 聊天消息功能的启用状态，传入当前实际配置值
              chatMessageEnabled: CONFIG.chatMessage.enabled,
            }
          );
        }
        // 条件不满足时直接返回，终止当前事件处理流程
        return;
      }

      try {
        // 从输出的消息片段中筛选出所有文本类型的片段，并通过类型守卫确保片段包含合法的text属性
        const textParts = output.parts.filter(
          (p): p is Part & { type: "text"; text: string } => p.type === "text"
        );

        // 如果筛选后没有找到任何有效文本片段，直接终止后续处理流程
        if (textParts.length === 0) return;
        // 将所有文本片段的内容按换行符拼接，合并为完整的用户消息文本
        const userMessage = textParts.map((p) => p.text).join("\n");
        // 如果拼接后的用户消息去除首尾空白后为空，直接终止后续处理流程
        if (!userMessage.trim()) return;

        // 检查当前消息是否为插件自身生成的结构化摘要系统消息，若是则跳过处理避免生成自引用记忆
        if (isStructuredSummaryPromptMessage(userMessage)) {
          return;
        }

        // 将当前用户提示持久化存储到用户提示管理器中，关联会话ID、消息ID、工作目录和原始消息内容
        userPromptManager.savePrompt(input.sessionID, output.message.id, directory, userMessage);

        // 调用OpenCode宿主会话接口，获取当前会话下的所有历史消息列表
        const messagesResponse = await ctx.client.session.messages({
          // 传入当前会话的唯一标识作为路径参数，指定要查询的会话
          path: { id: input.sessionID },
        });
        // 解构响应数据，若返回数据为空则默认使用空数组，避免后续处理空指针异常
        const messages = messagesResponse.data || [];

        // 检查当前会话历史中是否存在非合成的真实用户消息，用于判断是否需要注入记忆上下文
        const hasNonSyntheticUserMessages = messages.some(
          (m) =>
            // 首先筛选出角色为用户发送的消息
            m.info.role === "user" &&
            // 然后验证该消息并非全为合成内容：只要存在一个文本类型且非合成的片段，条件就成立
            !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
        );

        // 获取当前会话的最后一条消息，若消息列表为空则返回null
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        // 检查最后一条消息是否为会话压缩（compaction）生成的摘要消息，标记会话已完成历史压缩
        const isAfterCompaction = lastMessage?.info?.summary === true;

        // 判断是否需要向当前对话注入历史记忆上下文; shouldInject : 应该注入
        const shouldInject =
          // 配置项要求始终注入记忆上下文
          CONFIG.chatMessage.injectOn === "always" ||
          // 当前会话中不存在真实有效的用户消息（全为合成消息）
          !hasNonSyntheticUserMessages ||
          // 会话已完成历史压缩，且压缩后仅残留1条真实用户消息时触发注入
          (isAfterCompaction &&
            // 过滤出所有真实有效的用户消息（非合成文本消息）
            messages.filter(
              (m) =>
                m.info.role === "user" &&
                !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
            ).length === 1);

        // 如果不需要注入记忆上下文，则直接返回，终止当前事件处理流程
        if (!shouldInject) return;

        // 调用记忆客户端的列表查询接口，异步获取指定项目下的历史记忆数据
        // 第一个参数传入当前项目的唯一标识标签，用于限定记忆的查询范围
        // 第二个参数传入配置中定义的最大记忆数量，控制单次查询返回的记忆条目上限
        const listResult = await memoryClient.listMemories(
          tags.project.tag,
          CONFIG.chatMessage.maxMemories
        );

        // 初始化记忆列表：如果查询成功则使用返回的记忆数据，否则初始化为空数组
        let memories = listResult.success ? listResult.memories : [];

        // 如果配置中开启了排除当前会话的选项，过滤掉当前会话生成的记忆
        if (CONFIG.chatMessage.excludeCurrentSession) {
          // 过滤记忆列表，保留所有元数据中会话ID不等于当前输入会话ID的记忆，避免注入本次对话生成的记忆
          memories = memories.filter((m: any) => m.metadata?.sessionID !== input.sessionID);
        }

        // 如果配置中设置了记忆的最大保留天数，则执行过期记忆过滤
        if (CONFIG.chatMessage.maxAgeDays) {
          // 计算记忆过期的时间截点：当前时间减去最大保留天数对应的毫秒数（一天=86400000毫秒）
          const cutoffDate = Date.now() - CONFIG.chatMessage.maxAgeDays * 86400000;
          // 过滤记忆列表，仅保留创建时间晚于过期截点的未过期记忆
          memories = memories.filter((m: any) => new Date(m.createdAt).getTime() > cutoffDate);
        }

        if (memories.length === 0) return;

        // 构造项目记忆数据结构，用于后续格式化提示词上下文
        const projectMemories = {
          // 记忆结果列表，将原始记忆数组转换为统一格式
          results: memories.map((m: any) => ({
            // 相似度评分，固定为1.0表示与当前查询完全匹配（列表查询无向量相似度计算）
            similarity: 1.0,
            // 记忆内容，提取原始记忆的摘要文本作为展示内容
            memory: m.summary,
          })),
          // 记忆总数量，直接使用原始记忆数组的长度
          total: memories.length,
          // 查询耗时，列表查询为同步操作耗时可忽略，固定为0
          timing: 0,
        };

        // 提取当前用户的邮箱作为唯一用户标识，若无法获取邮箱则设置为null
        const userId = tags.user.userEmail || null;
        // 调用上下文格式化工具，将用户标识与项目记忆数据转换为大模型可识别的提示词格式
        const memoryContext = formatContextForPrompt(userId, projectMemories);

        if (memoryContext) {
          // 构造记忆上下文片段对象，符合SDK消息片段类型规范
          const contextPart: Part = {
            // 生成唯一片段ID，使用时间戳确保全局唯一性
            id: `prt-memory-context-${Date.now()}`,
            // 绑定当前会话ID，关联到正确的对话会话
            sessionID: input.sessionID,
            // 绑定当前消息ID，归属到对应的消息实体
            messageID: output.message.id,
            // 标记片段类型为纯文本格式
            type: "text",
            // 填充格式化完成的记忆上下文文本内容
            text: memoryContext,
            // 标记为合成片段，区别于用户/模型发送的原生消息
            synthetic: true,
          } as any;
          // 将记忆上下文片段插入到消息片段列表首位，确保大模型优先读取
          output.parts.unshift(contextPart);
        }
      } catch (error) {
        // 记录聊天消息处理过程中发生的错误日志，将错误对象转换为字符串存入日志上下文
        log("chat.message: ERROR", { error: String(error) });
        // 检查客户端是否存在终端UI实例，且配置中开启了错误提示弹窗功能
        if (ctx.client?.tui && CONFIG.showErrorToasts) {
          // 调用终端UI的Toast提示方法，在终端展示错误通知
          await ctx.client.tui
            .showToast({
              body: {
                // 提示框标题，标识为记忆系统错误
                title: "Memory System Error",
                // 提示内容，拼接具体的错误原因，告知用户错误详情
                message: String(error),
                // 提示类型设置为错误状态，使用错误样式渲染提示框
                variant: "error",
                // 提示框持续展示时长为5000毫秒（5秒），确保用户有足够时间查看错误信息
                duration: 5000,
              },
            })
            // 捕获showToast方法可能抛出的异常，空处理避免内部错误影响后续流程
            .catch(() => {});
        }
      }
    },

    // 处理聊天参数事件的异步处理器，接收输入参数
    "chat.params": async (input) => {
      // 检查核心配置未完成 或 OpenCode模型模式不是继承模式，满足任一条件则跳过后续处理
      if (!isConfigured() || CONFIG.opencodeModel !== "inherit") {
        // 如果诊断日志功能已开启，输出诊断日志记录防护条件状态
        if (isDiagEnabled()) {
          // 调用诊断日志函数，记录聊天参数模块的守卫条件实际生效逻辑
          diagLog(
            "index.ts:347",
            "chat.params guard — isConfigured always true, actual gate: CONFIG.opencodeModel !== inherit",
            {
              // 核心配置的完成状态，传入当前实际值便于日志追踪
              isConfigured: isConfigured(),
              // OpenCode模型的配置模式，传入当前实际配置值
              opencodeModel: CONFIG.opencodeModel,
            }
          );
        }
        // 条件不满足时直接返回，终止当前事件处理流程
        return;
      }

      try {
        // 调用用户提示管理器的模型设置方法，将当前消息关联的模型提供者ID与模型ID持久化存储
        userPromptManager.setPromptModel(input.message.id, input.model.providerID, input.model.id);
      } catch (error) {
        // 记录聊天参数处理过程中发生的错误日志，将错误对象转换为字符串存入日志上下文
        log("chat.params: ERROR", { error: String(error) });
      }
    },

    tool: {
      memory: tool({
        // 定义记忆管理工具实例，包裹工具配置与执行逻辑
        description: `Manage and query project memory (MATCH USER LANGUAGE: ${getLanguageName(CONFIG.autoCaptureLanguage || "en")}). Use 'search' with technical keywords/tags, 'add' to store knowledge, 'profile' for preferences. Search/list scope: project or all-projects.`, // 工具功能描述：统一管理与查询项目记忆，需匹配用户语言；推荐使用技术关键词/标签进行搜索，add用于存储知识，profile用于处理用户偏好；搜索与列表查询支持限定当前项目或全项目范围
        args: {
          // 工具调用参数定义集合，声明所有支持的入参格式与约束
          mode: tool.schema.enum(["add", "search", "profile", "list", "forget", "help"]).optional(), // 操作模式枚举，支持新增记忆、搜索记忆、管理用户画像、列出记忆、删除记忆、查看帮助，为可选参数
          content: tool.schema.string().optional(), // 记忆内容字符串，用于add或profile模式下提交需要存储的文本内容，可选参数
          query: tool.schema.string().optional(), // 搜索查询字符串，用于search模式下传入关键词进行记忆检索，可选参数
          tags: tool.schema.string().optional(), // 标签字符串，支持逗号分隔多个标签，用于add模式下为记忆标记分类标签，可选参数
          type: tool.schema.string().optional(), // 记忆类型字符串，用于add模式下指定记忆的分类类型，可选参数
          memoryId: tool.schema.string().optional(), // 记忆唯一标识ID，用于forget模式下指定需要删除的记忆ID，可选参数
          limit: tool.schema.number().optional(), // 返回结果数量限制，用于list或search模式下控制返回的记忆条目上限，可选参数
          scope: tool.schema.enum(["project", "all-projects"]).optional(), // 查询作用域枚举，支持限定当前项目或所有项目，用于搜索或列出记忆时指定检索范围，可选参数
        },
        // 记忆工具的核心执行方法，异步处理所有记忆管理操作
        async execute(args: {
          // 操作模式，可选值包含新增、搜索、画像管理、列表查询、删除、帮助，控制本次执行的具体行为
          mode?: "add" | "search" | "profile" | "list" | "forget" | "help";
          // 记忆内容字符串，用于新增记忆或更新用户画像时传入需要存储的文本内容，可选参数
          content?: string;
          // 搜索查询字符串，用于记忆搜索模式下传入关键词，可选参数
          query?: string;
          // 标签字符串，支持逗号分隔多个标签，用于新增记忆时标记分类标签，可选参数
          tags?: string;
          // 记忆类型，属于MemoryType枚举类型，用于新增记忆时指定记忆的业务分类，可选参数
          type?: MemoryType;
          // 记忆唯一标识ID，用于删除记忆模式下指定需要移除的具体记忆条目，可选参数
          memoryId?: string;
          // 返回结果数量限制，用于列表查询或搜索时控制返回的记忆条目上限，可选参数
          limit?: number;
          // 记忆检索作用域，属于MemoryScope枚举类型，限定查询范围为当前项目或所有项目，可选参数
          scope?: MemoryScope;
        }) {
          // 检查记忆系统配置是否未完成初始化，若未配置则进入错误处理分支
          if (!isConfigured()) {
            // 如果诊断日志功能已开启，输出诊断日志记录该守卫条件的执行状态
            if (isDiagEnabled()) {
              // 调用诊断日志函数，记录记忆工具的守卫条件实际永远不会触发（isConfigured始终为true），该代码块为不可达的死代码
              diagLog(
                "index.ts:387",
                "tool memory guard — isConfigured never false so guard is unreachable"
              );
            }
            // 返回配置错误的JSON响应，告知调用方记忆系统未正确配置
            return JSON.stringify({
              success: false,
              error: "Memory system not configured properly.",
            });
          }

          // 检查记忆客户端是否尚未完成预热初始化，异步调用isReady状态检查方法取反获取预热需求标记
          const needsWarmup = !(await memoryClient.isReady());
          // 如果当前确实存在预热需求（客户端未就绪）
          if (needsWarmup) {
            // 返回初始化中的错误响应JSON，告知调用方记忆系统正在后台初始化无法处理请求
            return JSON.stringify({ success: false, error: "Memory system is initializing." });
          }

          // 解析本次工具调用的操作模式，若调用方未指定模式则默认使用help模式展示使用指南
          const mode = args.mode || "help";
          // 获取当前配置的自动捕获语言对应的本地化语言名称，默认回退到英语（en）的语言名称
          const langName = getLanguageName(CONFIG.autoCaptureLanguage || "en");

          try {
            switch (mode) {
              case "help":
                // 处理帮助命令，返回记忆系统的使用指南
                return JSON.stringify({
                  // 标记请求成功
                  success: true,
                  // 指南标题，标识这是记忆系统的使用说明
                  message: "Memory System Usage Guide",
                  // 支持的所有命令列表，包含每个命令的功能描述和参数说明
                  commands: [
                    {
                      // 新增记忆命令标识
                      command: "add",
                      // 功能描述：存储新的记忆内容，提示会匹配用户当前使用的语言
                      description: `Store new memory (MATCH USER LANGUAGE: ${langName})`,
                      // 该命令支持的参数列表，type和tags为可选参数
                      args: ["content", "type?", "tags?"],
                    },
                    {
                      // 搜索记忆命令标识
                      command: "search",
                      // 功能描述：通过关键词搜索历史记忆，提示会匹配用户当前使用的语言
                      description: `Search memories via keywords (MATCH USER LANGUAGE: ${langName})`,
                      // 该命令必填的参数：搜索关键词query
                      args: ["query"],
                    },
                    {
                      // 管理用户画像命令标识
                      command: "profile",
                      // 功能描述：查看当前用户画像，或传入content参数保存自定义偏好设置
                      description:
                        "View user profile or save an explicit preference (provide content to write)",
                      // 该命令可选参数：仅在保存偏好时需要传入content
                      args: ["content?"],
                    },
                    // 列出最近记忆命令标识
                    { command: "list", description: "List recent memories", args: ["limit?"] },
                    // 删除记忆命令标识
                    { command: "forget", description: "Remove memory", args: ["memoryId"] },
                  ],
                  // 标签使用提示：建议搜索时使用技术关键词，标签匹配的权重最高，更容易被检索到
                  tagGuidance: "Use technical keywords for search. Tags rank highest.",
                });

              case "add":
                // 处理新增记忆模式，若未传入记忆内容则返回参数缺失错误
                if (!args.content)
                  return JSON.stringify({ success: false, error: "content required" });
                // 调用隐私内容清理函数，移除输入内容中的敏感隐私信息
                const sanitizedContent = stripPrivateContent(args.content);
                // 检查输入内容是否全为隐私内容，若是则拦截并返回隐私内容被阻止的错误
                if (isFullyPrivate(args.content))
                  return JSON.stringify({ success: false, error: "Private content blocked" });
                // 获取当前项目的标签信息，包含项目标识、路径、名称等核心属性
                const tagInfo = tags.project;
                // 解析传入的标签字符串：若存在标签则按逗号分割，去除首尾空白并转为小写，否则设为undefined
                const parsedTags = args.tags
                  ? args.tags.split(",").map((t) => t.trim().toLowerCase())
                  : undefined;
                // 调用记忆客户端的新增记忆方法，传入清理后的内容、项目标签及完整元数据
                const result = await memoryClient.addMemory(sanitizedContent, tagInfo.tag, {
                  type: args.type, // 记忆类型，使用调用方传入的类型参数
                  tags: parsedTags, // 解析后的标准化标签列表
                  displayName: tagInfo.displayName, // 项目的展示名称，用于界面显示
                  userName: tagInfo.userName, // 当前操作用户的用户名
                  userEmail: tagInfo.userEmail, // 当前操作用户的邮箱地址，用于身份关联
                  projectPath: tagInfo.projectPath, // 项目在本地的绝对路径
                  projectName: tagInfo.projectName, // 项目的正式名称
                  gitRepoUrl: tagInfo.gitRepoUrl, // 项目关联的Git仓库地址，用于版本控制关联
                });
                // 封装新增记忆的执行结果，返回操作状态、成功提示、记忆ID及解析后的标签
                return JSON.stringify({
                  success: result.success,
                  message: `Memory added`,
                  id: result.id,
                  tags: parsedTags,
                });
              case "search":
                // 处理记忆搜索模式，若未传入搜索关键词则返回参数缺失错误
                if (!args.query) return JSON.stringify({ success: false, error: "query required" });
                // 调用记忆客户端的搜索接口，传入查询关键词、当前项目标签和查询作用域
                const searchRes = await memoryClient.searchMemories(
                  args.query, // 用户传入的搜索关键词
                  tags.project.tag, // 当前项目的唯一标识标签，限定默认搜索范围
                  args.scope ?? CONFIG.memory.defaultScope // 使用调用方传入的作用域，否则回退到全局配置的默认作用域
                );
                // 若搜索请求失败，返回包含具体错误信息的JSON响应
                if (!searchRes.success)
                  return JSON.stringify({ success: false, error: searchRes.error });
                // 调用搜索结果格式化工具，将原始搜索结果按规范整理后返回，支持限制返回条目数量
                return formatSearchResults(args.query, searchRes, args.limit);

              case "profile": {
                // 处理用户画像管理模式分支
                if (args.query) {
                  // 校验：若传入了搜索查询参数则返回参数错误
                  return JSON.stringify({
                    success: false,
                    error:
                      "query is not valid for profile mode. Use content to write a preference or omit all args to read.",
                  });
                }

                const {
                  userProfileManager,
                } = // 动态导入用户画像管理器单例实例
                  await import("./services/user-profile/user-profile-manager.js");

                const userId = tags.user.userEmail || "unknown"; // 提取当前用户唯一标识，优先使用邮箱，无法获取则标记为未知用户

                // --- WRITE: explicit preference ---
                // 处理用户提交的显式偏好设置写入逻辑
                if (args.content !== undefined) {
                  // 若调用方传入了偏好内容参数
                  const trimmed = args.content.trim(); // 去除内容首尾空白字符，预处理输入
                  if (!trimmed) {
                    // 若处理后的内容为空字符串
                    return JSON.stringify({ success: false, error: "content must not be blank" }); // 返回参数错误，要求内容不能为空
                  }

                  if (!tags.user.userEmail) {
                    // 若无法获取当前用户的邮箱标识
                    return JSON.stringify({
                      success: false,
                      error:
                        "Cannot save profile preference because no user email could be resolved. Configure userEmailOverride or git user.email.", // 返回错误，提示需配置用户邮箱才能保存偏好
                    });
                  }

                  const sanitizedContent = stripPrivateContent(trimmed); // 调用隐私清理工具，移除内容中的敏感隐私信息
                  // 计算清理后剩余的非脱敏内容长度，判断是否存在有效业务信息
                  const hasNonPrivateContent =
                    // 先移除所有脱敏标记[REDACTED]，再去除首尾空白字符，检查剩余内容长度是否大于0
                    sanitizedContent.replace(/\[REDACTED\]/g, "").trim().length > 0;

                  // 如果原始内容全为隐私数据，或清理后已无有效业务内容，则拦截该请求
                  if (isFullyPrivate(trimmed) || !hasNonPrivateContent) {
                    // 返回错误响应，告知调用方隐私内容已被拦截
                    return JSON.stringify({ success: false, error: "Private content blocked" });
                  }

                  const newPreference = {
                    category: "explicit", // 偏好类别：显式用户偏好，即用户主动输入的自定义设置
                    description: sanitizedContent, // 偏好描述内容：经过隐私脱敏处理的用户原始输入文本
                    confidence: 1.0, // 置信度评分：1.0代表完全确定，因是用户主动输入的偏好，可信度为最高值
                    frequency: 1, // 出现频次：初始化为1，代表该偏好首次被记录，后续可累积统计出现次数
                    evidence: ["manual-write"], // 证据来源：标记为用户手动写入，标识该偏好的生成来源
                    lastSeen: Date.now(), // 最后更新时间戳：记录当前时间，作为该偏好的最新活动时间
                  };

                  // 获取当前用户的活跃画像数据
                  const existingProfile = userProfileManager.getActiveProfile(userId);

                  // 判断用户画像是否已存在，若存在则执行更新逻辑
                  if (existingProfile) {
                    // 解析已存在的画像JSON数据，转换为可操作的JavaScript对象
                    const existingData = JSON.parse(existingProfile.profileData);
                    // 调用画像合并方法，将新偏好与现有画像数据融合，处理冲突与去重
                    const mergedData = await userProfileManager.mergeProfileData(
                      existingData,
                      {
                        // 传入新添加的用户偏好数组，仅包含本次新增的偏好条目
                        preferences: [newPreference],
                      },
                      undefined,
                      // 传入当前画像的唯一标识，确保合并操作作用于正确的画像实例
                      existingProfile.id
                    );
                    // 调用画像更新方法，将合并后的新数据持久化存储到用户画像系统
                    userProfileManager.updateProfile(
                      // 指定要更新的画像ID，与原画像保持一致确保数据归属正确
                      existingProfile.id,
                      // 传入合并完成的画像数据，作为更新后的最新画像内容
                      mergedData,
                      // 画像版本号重置为0，触发系统的版本更新逻辑与存储持久化
                      0,
                      // 更新日志描述，截取前80个字符的偏好内容，便于日志追溯操作详情
                      `Explicit preference added: ${sanitizedContent.slice(0, 80)}`
                    );
                    // 向工具调用方返回操作成功的JSON响应，告知偏好已成功保存
                    return JSON.stringify({
                      success: true,
                      message: "Preference saved to profile",
                    });
                  } else {
                    // 判断用户画像是否已存在，若不存在则执行下面的逻辑
                    // 调用用户画像管理器创建新的用户画像
                    userProfileManager.createProfile(
                      // 传入当前用户的唯一标识ID
                      userId,
                      // 用户的展示名称，优先使用系统获取的显示名，无则使用用户ID兜底
                      tags.user.displayName || userId,
                      // 用户的用户名，优先使用系统获取的用户名，无则使用用户ID兜底
                      tags.user.userName || userId,
                      // 用户的邮箱地址，优先使用系统获取的邮箱，无则使用用户ID兜底
                      tags.user.userEmail || userId,
                      // 画像初始数据结构：包含刚添加的显式偏好，空的行为模式数组和工作流数组
                      { preferences: [newPreference], patterns: [], workflows: [] },
                      // 画像版本号，初始化为0，用于后续版本更新追踪
                      0
                    );
                    // 返回创建成功的JSON响应，告知调用方画像已连同偏好一同创建完成
                    return JSON.stringify({
                      success: true,
                      message: "Profile created with preference",
                    });
                  }
                }

                // --- READ: no content provided ---
                // 从用户画像管理器中获取当前用户的活跃画像数据
                const profile = userProfileManager.getActiveProfile(userId);
                // 如果未找到任何活跃画像数据，直接返回成功响应并将profile字段设为null
                if (!profile) return JSON.stringify({ success: true, profile: null });
                // 解析画像的JSON字符串数据，转换为可操作的JavaScript对象
                const pData = JSON.parse(profile.profileData);
                // 封装并返回完整的画像数据响应，补充版本号和最后分析时间元数据
                return JSON.stringify({
                  success: true,
                  profile: {
                    ...pData, // 展开原始画像数据的所有属性，保留原有数据结构
                    version: profile.version, // 补充画像的版本号，用于追踪画像更新历程
                    lastAnalyzed: profile.lastAnalyzedAt, // 补充画像最后一次系统分析的时间戳
                  },
                });
              }

              case "list":
                // 调用记忆客户端的列表查询接口，异步获取项目下的历史记忆数据
                const listRes = await memoryClient.listMemories(
                  // 传入当前项目的唯一标识标签，用于限定记忆的查询范围
                  tags.project.tag,
                  // 使用调用方传入的数量限制，若未指定则默认返回最多20条记忆
                  args.limit || 20,
                  // 使用调用方传入的查询作用域，若未指定则回退到全局配置的默认作用域
                  args.scope ?? CONFIG.memory.defaultScope
                );
                // 若列表查询请求失败，返回包含具体错误信息的JSON响应
                if (!listRes.success)
                  return JSON.stringify({ success: false, error: listRes.error });
                // 封装列表查询的成功结果，返回查询状态、记忆总数及标准化的记忆列表
                return JSON.stringify({
                  success: true,
                  // 记忆总数量，取查询返回的记忆数组长度
                  count: listRes.memories?.length,
                  // 标准化记忆列表，将原始记忆数据转换为统一格式的对象数组
                  memories: listRes.memories?.map((m: any) => ({
                    // 记忆的唯一标识ID，保留原始记忆的ID属性
                    id: m.id,
                    // 记忆的展示内容，提取原始记忆的摘要文本作为核心内容
                    content: m.summary,
                    // 记忆的创建时间戳，保留原始记忆的创建时间用于排序展示
                    createdAt: m.createdAt,
                  })),
                });

              // 处理删除记忆模式分支
              case "forget":
                // 若调用方未传入记忆唯一标识ID，返回参数缺失错误
                if (!args.memoryId)
                  return JSON.stringify({ success: false, error: "memoryId required" });
                // 调用记忆客户端的删除记忆接口，传入指定的记忆唯一标识ID
                const delRes = await memoryClient.deleteMemory(args.memoryId);
                // 封装删除操作结果，返回操作状态与成功提示信息
                return JSON.stringify({ success: delRes.success, message: `Memory removed` });

              // 处理未匹配到任何已知操作模式的默认分支
              default:
                // 返回无效操作模式的错误响应，提示传入的模式不被支持
                return JSON.stringify({ success: false, error: `Unknown mode: ${mode}` });
            }
          } catch (error) {
            // 捕获工具执行过程中抛出的所有异常
            // 将错误信息转换为字符串后，封装为标准失败响应格式返回
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),
    },

    // 事件处理函数，异步接收包含事件类型和属性的输入对象
    event: async (input: { event: { type: string; properties?: any } }) => {
      // 从输入中解构出事件对象，简化后续代码引用
      const event = input.event;
      // 匹配到会话空闲事件类型时进入处理逻辑
      if (event.type === "session.idle") {
        // 守卫条件：系统未完成配置 或 自动捕获功能未开启，满足任一条件则终止后续处理
        if (!isConfigured() || !CONFIG.autoCaptureEnabled) {
          // 若诊断日志功能已开启，输出守卫条件的实际生效逻辑诊断信息
          if (isDiagEnabled()) {
            // 调用诊断日志函数，记录会话空闲事件的守卫条件实际触发规则，便于调试追踪
            diagLog(
              "index.ts:607",
              "session.idle guard — isConfigured always true, actual gate: CONFIG.autoCaptureEnabled",
              {
                // 核心配置的完成状态，传入当前实际值便于日志追踪
                isConfigured: isConfigured(),
                // 自动捕获功能的开启状态，传入当前实际配置值
                autoCaptureEnabled: CONFIG.autoCaptureEnabled,
              }
            );
          }
          // 条件不满足时直接返回，终止当前事件处理流程
          return;
        }
        // 从事件属性中提取会话唯一标识，使用可选链避免访问undefined属性引发错误
        const sessionID = event.properties?.sessionID;
        // 若无法获取有效会话ID，则直接终止当前空闲事件处理流程
        if (!sessionID) return;

        // 检查是否存在未执行的空闲定时器，若存在则清除之前的定时任务避免重复执行
        if (idleTimeout) clearTimeout(idleTimeout);

        // 设置会话空闲定时器，延迟10秒后执行后台批量处理任务
        idleTimeout = setTimeout(async () => {
          try {
            // 执行自动记忆捕获流程，将本次会话的有效交互内容持久化到记忆系统
            await performAutoCapture(ctx, sessionID, directory);

            // 仅由服务端所有权的节点执行全局维护任务，避免多实例重复操作
            if (webServer?.isServerOwner()) {
              // 执行用户画像学习流程，基于近期交互行为更新用户偏好模型
              await performUserProfileLearning(ctx, directory);
              // 动态导入数据清理服务实例，加载过期数据清理能力
              const { cleanupService } = await import("./services/cleanup-service.js");
              // 校验清理触发条件，若满足则执行全量过期数据清理任务
              if (await cleanupService.shouldRunCleanup()) await cleanupService.runCleanup();
              // 动态导入SQLite连接管理器，加载数据库持久化能力
              const { connectionManager } = await import("./services/sqlite/connection-manager.js");
              // 触发所有数据库连接的检查点操作，将WAL日志持久化到主数据库文件
              connectionManager.checkpointAll();
            }
          } catch (error) {
            // 捕获空闲处理流程中的所有异常，记录错误日志避免进程崩溃
            log("Idle processing error", { error: String(error) });
          } finally {
            // 无论处理成功或失败，重置空闲定时器标记，允许下一次空闲任务调度
            idleTimeout = null;
          }
        }, 10000);
      }

      if (event.type === "session.compacted") {
        if (!isConfigured() || !CONFIG.compaction.enabled) {
          if (isDiagEnabled()) {
            diagLog(
              "index.ts:641",
              "session.compacted guard — isConfigured always true, actual gate: CONFIG.compaction.enabled",
              {
                isConfigured: isConfigured(),
                compactionEnabled: CONFIG.compaction.enabled,
              }
            );
          }
          return;
        }

        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        try {
          const tags = getTags(directory);

          const memoriesResult = await memoryClient.searchMemoriesBySessionID(
            sessionID,
            tags.project.tag,
            CONFIG.compaction.memoryLimit
          );

          if (!memoriesResult.success || memoriesResult.results.length === 0) {
            return;
          }

          const memoryContext = formatMemoriesForCompaction(memoriesResult.results);

          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ id: `prt-compaction-${Date.now()}`, type: "text", text: memoryContext }],
              noReply: true,
            },
          });

          if (ctx.client?.tui) {
            await ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Restored",
                  message: `${memoriesResult.results.length} memories injected after compaction`,
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }

          log("Compaction memory injected", {
            sessionID,
            count: memoriesResult.results.length,
          });
        } catch (error) {
          log("Compaction handler error", { error: String(error) });
        }
      }
    },
  };
};

function formatSearchResults(query: string, results: any, limit?: number): string {
  const memoryResults = results.results || [];
  return JSON.stringify({
    success: true,
    query,
    count: memoryResults.length,
    results: memoryResults.slice(0, limit || 10).map((r: any) => ({
      id: r.id,
      content: r.memory || r.chunk,
      similarity: Math.round(r.similarity * 100),
    })),
  });
}

function formatMemoriesForCompaction(memories: any[]): string {
  let output = `## Restored Session Memory\n\n`;

  memories.forEach((m, i) => {
    output += `### Memory ${i + 1}\n`;
    output += `${m.memory}\n\n`;
    if (m.tags && m.tags.length > 0) {
      output += `Tags: ${m.tags.join(", ")}\n\n`;
    }
  });

  return output;
}
