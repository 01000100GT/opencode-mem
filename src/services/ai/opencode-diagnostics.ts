// 网络请求端点配置接口，用于标准化接口请求的基础信息
export interface FetchEndpoint {
  // 接口的可读标识名称，用于日志和错误信息中快速定位接口
  readonly label: string;
  // 接口的完整请求地址，包含协议、域名、路径等完整信息
  readonly url: string;
}

// 生成用于诊断日志的标准化URL，移除查询参数避免敏感信息泄露与日志冗余
export function diagnosticUrl(url: string): string {
  try {
    // 尝试将输入字符串解析为标准URL对象，验证URL格式合法性
    const parsed = new URL(url);
    // 清空URL的查询参数部分，去除敏感参数或动态变化的参数
    parsed.search = "";
    // 将处理后的URL对象转换回字符串形式返回
    return parsed.toString();
  } catch {
    // 若URL解析失败（非标准URL格式），采用兼容方案手动切割查询参数
    return url.split("?")[0] ?? url;
  }
}

// 格式化响应状态信息，生成标准化的HTTP状态码与状态文本组合字符串
export function responseStatus(res: Response): string {
  // 预设常见HTTP错误状态码对应的标准状态文本，作为响应原生状态文本的兜底补充
  const statusTextByCode: Record<number, string> = {
    // 服务器内部错误，对应HTTP 500状态码的标准描述
    500: "Internal Server Error",
    // 网关错误，对应HTTP 502状态码的标准描述
    502: "Bad Gateway",
  };
  // 拼接状态码与状态文本：优先使用响应原生状态文本，无则使用预设状态文本，都不存在则返回未知状态标记
  return `${res.status} ${res.statusText || statusTextByCode[res.status] || "Unknown Status"}`;
}

// 响应体脱敏处理函数，对原始响应内容进行脱敏处理，保护敏感数据同时标识空响应场景
function redactedBody(text: string): string {
  // 根据输入文本的存在性返回对应标识：非空文本返回脱敏标记，空文本返回空体标记
  return text ? "<redacted response body>" : "<empty body>";
}

// 异步解析HTTP响应为JSON格式的通用函数，支持泛型类型约束以保障类型安全
export async function readJson<T>(res: Response, endpoint: FetchEndpoint): Promise<T> {
  // 先读取完整响应文本内容，为后续JSON解析和错误日志收集做准备
  const text = await res.text();
  // 生成用于日志输出的标准化诊断URL，隐藏查询参数避免敏感信息泄露
  const url = diagnosticUrl(endpoint.url);
  // 检查HTTP响应状态是否为成功状态（2xx范围），非成功状态抛出业务错误
  if (!res.ok) {
    throw new Error(
      `opencode-mem: opencode ${endpoint.label} failed at ${url} (${responseStatus(res)}): ${redactedBody(text)}`
    );
  }
  // 校验响应体非空，若返回空内容则抛出格式错误，避免后续JSON解析失败
  if (!text) {
    throw new Error(
      `opencode-mem: opencode ${endpoint.label} at ${url} returned an empty response body`
    );
  }
  // 尝试将响应文本解析为JSON对象，捕获解析过程中的格式错误
  try {
    return JSON.parse(text) as T;
  } catch {
    // JSON解析失败时抛出标准化错误，携带脱敏后的响应体辅助问题排查
    throw new Error(
      `opencode-mem: opencode ${endpoint.label} at ${url} returned non-JSON body: ${redactedBody(text)}`
    );
  }
}
