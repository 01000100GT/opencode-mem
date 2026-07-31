// 从OpenAI SDK的v2客户端模块导入OpencodeClient类型定义
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

// 定义创建OpencodeClient实例的函数类型，接收包含baseUrl的配置对象
type CreateOpencodeClient = (config: { readonly baseUrl: string }) => OpencodeClient;

// 导出主机端传输配置类型，用于自定义网络请求能力
export type HostTransport = {
  // 可选的自定义fetch实现，可替换默认的全局fetch函数
  readonly fetch?: typeof fetch;
  // 可选的请求头配置，会附加到所有发送的请求中
  readonly headers?: RequestInit["headers"];
};

// 获取Opencode SDK客户端模块的导入说明符，用于动态导入v2版本的客户端模块
function getOpencodeSdkClientSpecifier(): string {
  // 将SDK基础包名和客户端子路径拼接为完整的模块导入路径，确保路径拼接的可靠性
  return ["@opencode-ai/sdk", "/v2/client"].join("");
}

// 创建Opencode SDK客户端实例的异步函数，接收服务端地址和可选的传输层配置
async function createSdkClient(
  baseUrl: string,
  transport?: HostTransport
): Promise<OpencodeClient> {
  // 动态导入SDK客户端模块，通过预定义的模块说明符加载v2版本的客户端实现
  const sdk = (await import(getOpencodeSdkClientSpecifier())) as {
    // 声明SDK中创建客户端实例的工厂方法类型，确保类型安全
    readonly createOpencodeClient: (
      // 从CreateOpencodeClient类型中提取原始配置参数类型T，扩展传输层配置字段
      config: CreateOpencodeClient extends (config: infer T) => OpencodeClient
        ? T & { readonly fetch?: typeof fetch; readonly headers?: RequestInit["headers"] }
        : never
    ) => OpencodeClient;
  };
  // 调用SDK的工厂方法创建客户端实例，传入基础地址和传输层配置
  return sdk.createOpencodeClient({
    baseUrl,
    // 仅当传输层配置中存在自定义fetch实现时，才将其合并到配置对象中
    ...(transport?.fetch ? { fetch: transport.fetch } : {}),
    // 仅当传输层配置中存在自定义请求头时，才将其合并到配置对象中
    ...(transport?.headers ? { headers: transport.headers } : {}),
  });
}

// 导出创建懒加载式v2客户端实例的工厂函数，接收服务端地址和可选传输层配置，返回符合OpencodeClient接口的代理对象
export function createLazyV2Client(baseUrl: string, transport?: HostTransport): OpencodeClient {
  // 声明SDK客户端实例的异步Promise容器，初始化为undefined，用于实现单例懒加载
  let sdkClientPromise: Promise<OpencodeClient> | undefined;
  // 定义内部获取SDK客户端实例的工具函数，确保仅初始化一次客户端连接
  const getSdkClient = (): Promise<OpencodeClient> => {
    // 使用空值合并赋值操作符，仅当promise未初始化时调用createSdkClient创建实例，实现惰性初始化
    sdkClientPromise ??= createSdkClient(baseUrl, transport);
    // 返回已初始化的客户端Promise，确保多次调用共享同一实例
    return sdkClientPromise;
  };

  // 返回代理实现的OpencodeClient接口对象，所有方法都会动态等待真实SDK客户端初始化完成
  return {
    // 实现session会话管理模块的代理方法组，转发所有调用到真实SDK客户端实例
    session: {
      // 代理session.create方法，自动推导原方法的参数类型，确保类型安全转发
      create: async (...args: Parameters<OpencodeClient["session"]["create"]>) => {
        // 等待真实SDK客户端实例初始化完成，确保调用时客户端已就绪
        const client = await getSdkClient();
        // 将所有参数原样转发给真实客户端的create方法，返回执行结果
        return client.session.create(...args);
      },
      // 代理session.prompt方法，自动推导原方法的参数类型，保持接口一致性
      prompt: async (...args: Parameters<OpencodeClient["session"]["prompt"]>) => {
        // 等待真实SDK客户端实例初始化完成，处理异步加载的时序问题
        const client = await getSdkClient();
        // 将所有参数原样转发给真实客户端的prompt方法，返回执行结果
        return client.session.prompt(...args);
      },
      // 代理session.delete方法，自动推导原方法的参数类型，完整实现接口约定
      delete: async (...args: Parameters<OpencodeClient["session"]["delete"]>) => {
        // 等待真实SDK客户端实例初始化完成，避免调用未就绪的客户端方法
        const client = await getSdkClient();
        // 将所有参数原样转发给真实客户端的delete方法，返回执行结果
        return client.session.delete(...args);
      },
    },
    // 使用类型断言将代理对象标记为OpencodeClient类型，绕过TypeScript的结构类型检查
  } as OpencodeClient;
}
