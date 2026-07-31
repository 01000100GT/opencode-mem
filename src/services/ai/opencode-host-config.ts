// 宿主客户端配置类型，用于聚合管理多SDK实例的核心配置参数
export type HostClientConfig = {
  // 聚合后的基础请求地址，取首个有效SDK配置中的baseUrl，无有效配置则为undefined
  readonly baseUrl: string | undefined;
  // 聚合后的自定义fetch实现，取首个有效SDK配置中的fetch方法，无有效配置则为undefined
  readonly fetch: typeof fetch | undefined;
  // 聚合后的请求头配置，取首个有效SDK配置中的headers，可选字段
  readonly headers?: RequestInit["headers"];
  // 客户端对象所有顶层键名的只读数组，记录客户端挂载的所有实例标识
  readonly clientKeys: readonly string[];
  // 聚合过程中发现的有效SDK配置总数，用于统计多SDK实例的挂载数量
  readonly sdkConfigCount: number;
};

// 生成宿主客户端聚合配置的核心方法，接收包含客户端实例的上下文对象
export function getHostClientConfig(ctx: { readonly client: unknown }): HostClientConfig {
  // 将输入的客户端对象转换为可安全访问属性的记录类型，处理非对象输入场景
  const client = toRecord(ctx.client);
  // 若客户端对象转换失败（输入不是合法对象），返回全空的默认聚合配置
  if (!client) {
    return { baseUrl: undefined, fetch: undefined, clientKeys: [], sdkConfigCount: 0 };
  }

  // 从客户端对象中提取所有合法的SDK配置项，生成配置数组
  const configs = sdkConfigs(client);
  // 从配置数组中提取第一个合法的字符串类型baseUrl，作为聚合后的基础请求地址
  const baseUrl = configs.find((config) => typeof config["baseUrl"] === "string")?.["baseUrl"];
  // 从配置数组中提取第一个合法的fetch实现，作为聚合后的自定义请求方法
  const customFetch = configs.find((config) => isFetch(config["fetch"]))?.["fetch"];
  // 从配置数组中提取第一个合法的请求头配置，作为聚合后的统一请求头
  const headers = configs.find((config) => isHeadersInit(config["headers"]))?.["headers"];

  // 组装并返回最终的聚合配置对象，确保所有字段类型合法
  return {
    // 二次校验baseUrl类型，确保仅在合法时返回字符串，否则返回undefined
    baseUrl: typeof baseUrl === "string" ? baseUrl : undefined,
    // 二次校验自定义fetch的合法性，仅类型合法时返回，否则返回undefined
    fetch: isFetch(customFetch) ? customFetch : undefined,
    // 仅当请求头配置合法时，才将其展开到聚合配置中，避免传入无效字段
    ...(isHeadersInit(headers) ? { headers } : {}),
    // 提取客户端对象的所有顶层键名，生成挂载实例标识的只读数组
    clientKeys: Object.keys(client),
    // 记录提取到的有效SDK配置总数，用于多实例挂载数量统计
    sdkConfigCount: configs.length,
  };
}

// 提取所有有效SDK配置的核心方法，接收客户端根对象，返回所有合法SDK配置的数组
function sdkConfigs(client: Record<string, unknown>): Record<string, unknown>[] {
  // 初始化存储所有有效SDK配置的数组
  const configs: Record<string, unknown>[] = [];
  // 递归提取客户端下所有嵌套的子客户端对象，将所有值转换为合法记录后展平
  const nestedClients = Object.values(client).flatMap((value): Record<string, unknown>[] => {
    // 将当前值转换为可安全访问属性的记录类型，非对象则返回空数组
    const record = toRecord(value);
    // 转换成功则包装为单元素数组参与展平，否则返回空数组过滤掉无效值
    return record ? [record] : [];
  });
  // 构建待校验的候选对象池，包含根客户端和所有提取到的嵌套客户端
  const candidates: Record<string, unknown>[] = [client, ...nestedClients];

  // 遍历所有候选对象，逐一校验是否为合法的SDK客户端实例
  for (const candidate of candidates) {
    // 从候选对象中提取内置的_client字段，转换为安全的记录类型
    const sdkClient = toRecord(candidate["_client"]);
    // 从SDK客户端实例中提取getConfig配置获取方法
    const getConfig = sdkClient?.["getConfig"];
    // 校验getConfig是否为合法的配置获取函数，不合法则跳过当前候选
    if (!isConfigGetter(getConfig)) continue;

    // 调用getConfig方法获取原始配置，转换为安全的记录类型
    const config = toRecord(getConfig.call(sdkClient));
    // 配置转换成功则加入有效配置数组，否则忽略无效配置
    if (config) configs.push(config);
  }

  // 返回所有收集到的有效SDK配置数组
  return configs;
}

// 将任意输入值转换为可安全访问属性的键值对记录类型
// 仅当输入为非null的对象类型时才返回转换结果，否则返回undefined
function toRecord(value: unknown): Record<string, unknown> | undefined {
  // 先校验值的基础类型：如果不是对象类型，或者是null值，直接返回undefined过滤无效输入
  if (typeof value !== "object" || value === null) return undefined;
  // 类型校验通过后，将原对象强制转换为通用键值对记录类型，便于后续安全访问属性
  return value as Record<string, unknown>;
}

// 校验输入值是否为合法的配置获取函数类型守卫
function isConfigGetter(value: unknown): value is (this: unknown) => unknown {
  // 仅需基础函数类型校验，符合TS函数类型定义即可通过
  return typeof value === "function";
}

// 校验输入值是否为合法的自定义fetch实现的类型守卫
function isFetch(value: unknown): value is typeof fetch {
  // 仅需基础函数类型校验，满足fetch的函数签名基础要求即可通过
  return typeof value === "function";
}

// 类型守卫函数：校验输入值是否为合法的请求头配置，符合Fetch标准的HeadersInit类型要求
function isHeadersInit(value: unknown): value is RequestInit["headers"] {
  return (
    // 第一种合法场景：输入为标准Headers类的实例，原生浏览器/Node.js支持的请求头对象
    value instanceof Headers ||
    // 第二种合法场景：输入为二维数组格式的请求头，每个子数组包含[键名, 值]的键值对结构
    Array.isArray(value) ||
    // 第三种合法场景：输入为普通对象字面量格式的键值对，这是最常用的自定义请求头格式
    (typeof value === "object" && value !== null)
  );
}
