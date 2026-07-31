// 从SQLite类型定义模块导入分片信息类型
import type { ShardInfo } from "../sqlite/types.js";

// 向量类型枚举，用于区分内容向量和标签向量
export type VectorKind = "content" | "tags";

// 向量数据库搜索结果接口，包含匹配项ID和相似度距离
export interface BackendSearchResult {
  id: string; // 匹配文档的唯一标识符
  distance: number; // 向量间的距离值，越小表示相似度越高
}

// 向量插入项接口，封装待插入向量的ID和向量数据
export interface BackendInsertItem {
  id: string; // 待插入向量所属文档的唯一ID
  vector: Float32Array; // 32位浮点型向量数据，用于向量存储
}

// 向量搜索参数接口，封装搜索所需的所有上下文参数
export interface VectorBackendSearchParams {
  db: unknown; // 数据库连接实例，通用类型适配不同后端
  shard: ShardInfo; // 目标分片信息，指定在哪个分片中执行搜索
  kind: VectorKind; // 向量类型，指定搜索内容向量还是标签向量
  queryVector: Float32Array; // 查询向量，用于相似度计算的源向量
  limit: number; // 返回结果的最大数量，控制返回Top-N结果
}

// 向量数据库后端统一接口，定义所有向量存储实现必须遵循的标准契约
export interface VectorBackend {
  // 获取当前后端实例的唯一名称，用于日志追踪、调试和多后端实例区分
  getBackendName(): string;
  // 插入单个向量到指定分片的指定类型向量空间中
  insert(args: {
    // 向量关联的文档唯一标识符，用于后续检索和删除操作
    id: string;
    // 待存储的32位浮点型向量数据，需与同空间内其他向量维度一致
    vector: Float32Array;
    // 目标分片信息，指定向量存储到哪个数据库分片中
    shard: ShardInfo;
    // 向量类型标识，区分内容向量或标签向量，写入不同的向量索引空间
    kind: VectorKind;
  }): Promise<void>;
  // 批量插入多个向量到指定分片的指定类型向量空间中，优化写入性能
  insertBatch(args: {
    // 待插入的向量项数组，每个项包含文档ID和对应的向量数据
    items: BackendInsertItem[];
    // 目标分片信息，指定批量向量存储到哪个数据库分片中
    shard: ShardInfo;
    // 向量类型标识，指定批量写入的向量所属的索引空间
    kind: VectorKind;
  }): Promise<void>;
  // 从指定分片的指定类型向量空间中删除指定ID的向量
  delete(args: { id: string; shard: ShardInfo; kind: VectorKind }): Promise<void>;
  // 在指定分片的指定类型向量空间中执行相似度搜索，返回Top-N匹配结果
  search(args: VectorBackendSearchParams): Promise<BackendSearchResult[]>;
  // 基于指定分片的全量数据库数据，重新构建该分片的向量索引，用于索引损坏或数据迁移后重建
  rebuildFromShard(args: { db: unknown; shard: ShardInfo; kind: VectorKind }): Promise<void>;
  // 删除指定分片下的所有向量索引，用于分片销毁或重置场景，释放索引占用的存储资源
  deleteShardIndexes(args: { shard: ShardInfo }): Promise<void>;
}

// 向量后端工厂配置选项，用于控制向量后端实例的创建逻辑和选型策略
export interface VectorBackendFactoryOptions {
  // 指定优先使用的向量后端类型，支持三种策略：优先尝试usearch、强制使用usearch、强制使用精确扫描
  vectorBackend: "usearch-first" | "usearch" | "exact-scan";
  // 可选的usearch可用性探测函数，用于在usearch-first模式下检测usearch环境是否可用
  probeUSearch?: () => Promise<boolean>;
  // 可选的usearch后端实例创建函数，允许外部自定义usearch后端的初始化逻辑
  createUSearchBackend?: () => VectorBackend;
}
