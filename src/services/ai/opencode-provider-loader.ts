// 异步加载opencode-provider模块的函数，返回包含模块所有导出内容的Promise对象
export async function loadOpencodeProvider(): Promise<OpencodeProviderModule> {
  // 动态导入opencode-provider.js模块，将导入结果标注为OpencodeProviderModule类型
  const providerModule: OpencodeProviderModule = await import("./opencode-provider.js");
  // 返回导入的模块实例，供外部调用者使用模块内的所有能力
  return providerModule;
}

// 定义OpencodeProviderModule类型，通过typeof提取导入模块的类型结构，实现类型复用
type OpencodeProviderModule = typeof import("./opencode-provider.js");
