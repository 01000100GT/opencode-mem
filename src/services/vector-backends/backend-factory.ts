// 导入全局配置对象，包含存储路径、嵌入维度等核心系统参数
import { CONFIG } from "../../config.js";
// 导入统一日志工具，用于记录系统运行状态、错误及降级事件
import { log } from "../logger.js";
// 导入精确暴力扫描向量后端，作为所有高性能向量引擎的兜底降级方案
import { ExactScanBackend } from "./exact-scan-backend.js";
// 导入向量后端的通用接口类型与工厂函数配置选项类型定义
import type { VectorBackend, VectorBackendFactoryOptions } from "./types.js";
// 导入hnswlib-wasm纯WASM向量后端，提供近似最近邻搜索能力
import { HnswlibWasmBackend } from "./hnswlib-wasm-backend.js";

// 实现支持故障降级的向量后端代理类，遵循统一的VectorBackend接口规范
class FallbackAwareBackend implements VectorBackend {
  // 存储当前处于活跃状态的向量后端实例，初始为主引擎，故障时自动切换为兜底引擎
  private activeBackend: VectorBackend;

  // 构造降级感知后端实例，初始化核心配置与后端引用
  constructor(
    // 后端运行策略：hnswlib-wasm-first表示优先尝试hnswlib-wasm，故障自动降级；hnswlib-wasm表示强制要求hnswlib-wasm，故障仅记录警告
    private readonly strategy: "hnswlib-wasm-first" | "hnswlib-wasm",
    // 主向量后端实例，通常为高性能的HnswlibWasmBackend，作为优先使用的引擎
    private readonly primary: VectorBackend,
    // 兜底向量后端实例，固定为精确暴力扫描的ExactScanBackend，确保系统永远可用
    private readonly fallback: VectorBackend
  ) {
    // 初始化时将活跃后端设置为主引擎，启动时优先使用高性能方案
    this.activeBackend = primary;
  }

  // 获取当前活跃后端的名称标识，对外统一暴露当前实际运行的引擎类型
  getBackendName(): string {
    return this.activeBackend.getBackendName();
  }

  // 单条向量插入操作的代理转发，所有参数透传给当前活跃的后端实例执行
  async insert(args: Parameters<VectorBackend["insert"]>[0]): Promise<void> {
    await this.activeBackend.insert(args);
  }

  // 批量向量插入操作的代理转发，支持高吞吐量的批量数据写入场景透传
  async insertBatch(args: Parameters<VectorBackend["insertBatch"]>[0]): Promise<void> {
    await this.activeBackend.insertBatch(args);
  }

  // 单条向量删除操作的代理转发，按指定条件删除向量数据的请求透传
  async delete(args: Parameters<VectorBackend["delete"]>[0]): Promise<void> {
    await this.activeBackend.delete(args);
  }

  // 向量相似性搜索操作的代理转发，优先使用活跃后端执行，捕获异常并自动触发降级
  async search(args: Parameters<VectorBackend["search"]>[0]) {
    // 尝试调用当前活跃后端的搜索接口
    try {
      // 透传搜索参数，等待活跃后端返回结果并直接返回
      return await this.activeBackend.search(args);
    } catch (error) {
      // 搜索过程发生异常，记录后端降级日志
      this.logDegrade("search", error);
      // 将活跃后端切换为兜底的精确扫描引擎，后续所有操作都将使用保底方案
      this.activeBackend = this.fallback;
      // 使用兜底引擎重新执行搜索请求，保证业务可用
      return this.fallback.search(args);
    }
  }

  // 分片索引重建操作的代理转发，支持从分片数据中重建向量索引的异常处理
  async rebuildFromShard(args: Parameters<VectorBackend["rebuildFromShard"]>[0]): Promise<void> {
    // 尝试调用当前活跃后端的分片重建接口
    try {
      // 透传重建参数，等待活跃后端完成索引重建流程
      await this.activeBackend.rebuildFromShard(args);
    } catch (error) {
      // 重建过程发生异常，记录后端降级日志
      this.logDegrade("rebuild", error);
      // 将活跃后端切换为兜底的精确扫描引擎，确保后续索引操作可用
      this.activeBackend = this.fallback;
      // 使用兜底引擎重新执行分片重建，维持系统数据一致性
      await this.fallback.rebuildFromShard(args);
    }
  }

  // 分片索引删除操作：同时清理主引擎和兜底引擎的对应分片索引，保证双后端数据一致性
  async deleteShardIndexes(
    args: Parameters<VectorBackend["deleteShardIndexes"]>[0]
  ): Promise<void> {
    // 先调用主引擎的分片索引删除方法，清除高性能引擎中的分片数据
    await this.primary.deleteShardIndexes(args);
    // 再调用兜底引擎的分片索引删除方法，确保精确扫描引擎的分片数据同步清除
    await this.fallback.deleteShardIndexes(args);
  }

  // 私有工具方法：记录向量后端降级事件的统一日志输出，标准化降级事件的格式与字段
  private logDegrade(operation: string, error: unknown): void {
    // 调用全局日志工具输出降级信息，包含触发降级的场景、策略、错误详情等核心元数据
    log("Vector backend degraded to exact-scan", {
      // 记录当前使用的后端运行策略，用于区分强制绑定和自动降级场景的日志含义
      strategy: this.strategy,
      // 根据策略动态设置日志级别：强制使用hnswlib-wasm时仅输出警告，自动降级场景输出普通信息
      severity: this.strategy === "hnswlib-wasm" ? "warning" : "info",
      // 记录触发降级的具体操作类型，便于定位是搜索、重建还是其他流程引发的故障
      operation,
      // 将未知类型的错误转换为字符串，确保日志的可序列化性与可读性
      error: String(error),
    });
  }
}

// 默认的hnswlib-wasm可用性探测函数，用于在运行时检测hnswlib-wasm模块是否能正常加载
// 返回Promise<boolean>，加载成功返回true，加载失败返回false
async function defaultHnswlibProbe(): Promise<boolean> {
  // 尝试动态导入hnswlib-wasm模块，验证其在当前环境是否可用
  try {
    await import("hnswlib-wasm/dist/hnswlib.js");
    // 模块导入成功，确认hnswlib-wasm可用，返回真值
    return true;
  } catch {
    // 模块导入失败，环境不支持hnswlib-wasm，返回假值
    return false;
  }
}

// 导出向量后端工厂函数，根据配置创建合适的向量引擎实例，返回符合统一接口的后端对象
export async function createVectorBackend(
  options: VectorBackendFactoryOptions
): Promise<VectorBackend> {
  // 初始化基础兜底的精确暴力扫描引擎实例，作为所有场景下的最终保障
  const exactScanBackend = new ExactScanBackend();

  // 如果配置明确指定使用纯精确扫描模式，直接返回兜底引擎实例
  if (options.vectorBackend === "exact-scan") {
    return exactScanBackend;
  }

  // 读取配置中的hnswlib-wasm可用性探测函数，未自定义则使用默认的模块导入探测逻辑
  const probeHnswlib = options.probeHnswlib ?? defaultHnswlibProbe;
  // 执行hnswlib-wasm可用性探测，如果探测失败则进入降级流程
  if (!(await probeHnswlib())) {
    // 如果配置要求强制使用hnswlib-wasm引擎，记录降级警告日志
    if (options.vectorBackend === "hnswlib-wasm") {
      log("Vector backend degraded to exact-scan", {
        strategy: "hnswlib-wasm",
        severity: "warning",
        operation: "probe",
        error: "hnswlib-wasm unavailable",
      });
    }
    // 直接返回兜底的精确扫描引擎实例，保障基础能力可用
    return exactScanBackend;
  }

  try {
    // 尝试获取自定义hnswlib后端实例，如果用户未提供自定义创建函数
    // 则使用默认构造函数初始化标准hnswlib-wasm引擎，传入存储路径和向量维度核心配置
    const hnswlibBackend =
      options.createHnswlibBackend?.() ??
      new HnswlibWasmBackend({
        baseDir: CONFIG.storagePath,
        dimensions: CONFIG.embeddingDimensions,
      });

    // 初始化降级感知代理后端，传入运行策略、主引擎实例和兜底引擎实例
    // 按照配置的故障转移策略封装双后端，对外暴露统一的向量操作接口
    return new FallbackAwareBackend(options.vectorBackend, hnswlibBackend, exactScanBackend);
  } catch (error) {
    // 记录hnswlib后端实例创建失败的降级事件，输出标准化日志信息
    log("Vector backend degraded to exact-scan", {
      // 记录当前配置的后端运行策略，明确故障场景的触发条件
      strategy: options.vectorBackend,
      // 根据策略动态设置日志级别：强制hnswlib-wasm场景输出警告，自动降级场景输出普通信息
      severity: options.vectorBackend === "hnswlib-wasm" ? "warning" : "info",
      // 标记降级触发操作为后端实例创建，便于定位初始化阶段的故障根源
      operation: "create",
      // 将捕获的异常转换为字符串，确保日志可序列化且包含错误核心信息
      error: String(error),
    });
    // 创建失败时返回兜底的精确扫描引擎实例，保障系统基础向量操作能力可用
    return exactScanBackend;
  }
}
