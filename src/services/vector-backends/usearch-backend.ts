// 从本地types模块导入向量数据库后端所需的核心类型定义
import type {
  BackendInsertItem,
  BackendSearchResult,
  VectorBackend,
  VectorBackendSearchParams,
  VectorKind,
} from "./types.js";
// 从SQLite模块导入分片信息的类型定义
import type { ShardInfo } from "../sqlite/types.js";

// 定义USearch模块的类型，获取动态导入的usearch库的类型
type USearchModule = typeof import("usearch");
// 定义USearch索引实例的类型，提取模块中Index类的实例类型
type USearchIndex = InstanceType<USearchModule["Index"]>;

// 定义缓存索引的接口，用于管理每个分片的USearch索引及其元数据
interface CachedIndex {
  // USearch原生索引实例，负责实际的向量存储和计算
  index: USearchIndex;
  // 业务ID到内部数字键的映射，将字符串ID转换为USearch要求的bigint键
  idToKey: Map<string, bigint>;
  // 内部数字键到业务ID的反向映射，用于搜索结果找回原始业务ID
  keyToId: Map<bigint, string>;
  // 下一个可用的内部数字键，自增生成唯一键
  nextKey: bigint;
  // 该索引的唯一标识键，由分片信息和向量类型生成
  indexKey: string;
  // 标记该索引是否已完成初始化，避免重复构建索引
  initialized: boolean;
}

// 实现VectorBackend接口的USearch向量数据库后端类
export class USearchBackend implements VectorBackend {
  // 存储所有缓存的索引实例，以索引键为键，CachedIndex对象为值
  private readonly indexes = new Map<string, CachedIndex>();

  // 类构造函数，初始化USearch后端实例
  constructor(
    // 私有只读配置选项，包含基础目录和向量维度
    private readonly options: {
      baseDir: string;
      dimensions: number;
    }
  ) {
    // 显式标记baseDir参数已接收，避免TypeScript未使用变量警告
    void this.options.baseDir;
  }

  // 获取后端名称的方法，返回标识该后端的字符串
  getBackendName(): string {
    // 返回USearch后端的唯一标识字符串
    return "usearch";
  }

  // 单条向量插入方法，异步实现向量数据库的写入操作
  async insert(args: {
    // 业务数据的唯一标识符，用于关联向量与实际业务实体
    id: string;
    // 待插入的向量数据，采用Float32Array格式满足USearch的输入要求
    vector: Float32Array;
    // 当前向量所属的分片信息，包含分片的范围、哈希和索引等元数据
    shard: ShardInfo;
    // 向量的类型标识，区分不同业务场景的向量（如内容向量、标签向量）
    kind: VectorKind;
  }): Promise<void> {
    // 根据分片信息和向量类型生成唯一的索引键，用于定位具体的向量索引实例
    const indexKey = this.getIndexKey(args.shard, args.kind);
    // 获取或创建对应索引键的缓存索引实例，若索引不存在则自动初始化空索引
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      // 调用底层upsert方法实现向量的插入或更新，自动处理已存在ID的覆盖逻辑
      this.upsertItem(cache, { id: args.id, vector: args.vector });
      // 将索引标记为已完成初始化，避免后续重建流程重复处理该索引
      cache.initialized = true;
    } catch (error) {
      // 捕获插入过程中的所有异常，封装为统一的错误信息抛出，包含索引键便于定位问题
      throw new Error(`USearch insert failed for ${indexKey}: ${String(error)}`);
    }
  }

  // 批量向量插入方法，异步实现多向量的批量写入操作
  async insertBatch(args: {
    // 待插入的向量数据数组，每个元素包含完整的业务ID和向量数据
    items: BackendInsertItem[];
    // 当前向量所属的分片信息，包含分片的范围、哈希和索引等元数据
    shard: ShardInfo;
    // 向量的类型标识，区分不同业务场景的向量（如内容向量、标签向量）
    kind: VectorKind;
  }): Promise<void> {
    // 根据分片信息和向量类型生成唯一的索引键，定位具体的向量索引实例
    const indexKey = this.getIndexKey(args.shard, args.kind);
    // 获取或创建对应索引键的缓存索引实例，若索引不存在则自动初始化空索引
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      // 调用底层addItems方法实现批量向量的插入，循环处理每个向量的添加逻辑
      this.addItems(cache, args.items);
      // 将索引标记为已完成初始化，避免后续重建流程重复处理该索引
      cache.initialized = true;
    } catch (error) {
      // 捕获批量插入过程中的所有异常，封装为统一的错误信息抛出，包含索引键便于定位问题
      throw new Error(`USearch batch insert failed for ${indexKey}: ${String(error)}`);
    }
  }

  // 单条向量删除方法，异步实现从向量数据库中移除指定向量
  async delete(args: { id: string; shard: ShardInfo; kind: VectorKind }): Promise<void> {
    // 获取或创建对应索引键的缓存索引实例，通过分片信息和向量类型生成索引键
    const cache = await this.getOrCreateIndex(this.getIndexKey(args.shard, args.kind));
    // 从业务ID到内部数字键的映射中查询目标ID对应的内部键
    const key = cache.idToKey.get(args.id);
    // 若内部键不存在（向量已被删除或从未存在），直接返回无需后续操作
    if (key === undefined) return;
    // 调用USearch原生索引的remove方法，从底层索引中移除该向量
    cache.index.remove(key);
    // 从正向ID映射中删除该业务ID的记录，维护映射数据一致性
    cache.idToKey.delete(args.id);
    // 从反向键映射中删除该内部键的记录，维护映射数据一致性
    cache.keyToId.delete(key);
  }

  // 向量搜索核心方法，异步实现基于向量相似度的近邻检索
  async search(args: VectorBackendSearchParams): Promise<BackendSearchResult[]> {
    // 根据分片信息和向量类型生成唯一索引键，定位目标向量索引实例
    const indexKey = this.getIndexKey(args.shard, args.kind);
    // 获取或初始化对应索引的缓存实例，确保索引已完成加载
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      // 调用USearch原生搜索接口，输入查询向量和返回结果数量限制
      const matches = cache.index.search(args.queryVector, args.limit);
      // 将搜索结果的键集合转换为业务可用的结果数组，遍历每个匹配项
      return Array.from(matches.keys as Iterable<bigint>, (key, index) => {
        // 通过内部数字键反向查询对应的业务实体ID
        const id = cache.keyToId.get(key);
        // 若元数据中不存在该键的业务ID，抛出索引损坏异常
        if (!id) {
          throw new Error(
            `USearch index metadata missing for key ${String(key)} in ${cache.indexKey}`
          );
        }
        // 封装为统一的后端搜索结果格式，包含业务ID和相似度距离
        return {
          id,
          // 从距离数组中取出当前结果的距离值，兜底为0避免空值异常
          distance: matches.distances[index] ?? 0,
        };
      });
    } catch (error) {
      // 捕获搜索过程中所有异常，封装为带索引键的统一错误信息抛出
      throw new Error(`USearch search failed for ${indexKey}: ${String(error)}`);
    }
  }

  // 从分片数据重建向量索引的异步方法，实现索引的全量初始化与数据同步
  async rebuildFromShard(args: { db: unknown; shard: ShardInfo; kind: VectorKind }): Promise<void> {
    // 根据分片信息和向量类型生成唯一的索引标识键，用于定位对应分片的向量索引
    const indexKey = this.getIndexKey(args.shard, args.kind);
    // 从缓存索引集合中查询该索引键对应的已有缓存实例
    const existing = this.indexes.get(indexKey);
    // 若索引已存在且完成初始化，直接返回避免重复重建浪费资源
    if (existing?.initialized) {
      return;
    }

    // 根据向量类型选择数据库中对应的存储列名，标签向量使用tags_vector列，普通向量使用vector列
    const column = args.kind === "tags" ? "tags_vector" : "vector";
    // 对传入的数据库实例进行类型断言，适配SQLite的prepare查询接口
    const rows = (
      args.db as {
        prepare: (sql: string) => {
          all: () => Array<{
            id: string;
            vector?: Uint8Array | ArrayBuffer | null;
            tags_vector?: Uint8Array | ArrayBuffer | null;
          }>;
        };
      }
    )
      // 构造SQL查询语句，从memories表中查询所有指定向量列非空的记录，获取内存ID和向量二进制数据
      .prepare(`SELECT id, ${column} FROM memories WHERE ${column} IS NOT NULL`)
      // 执行查询并获取所有匹配的结果行，完成数据库数据拉取
      .all();

    // 创建一个全新的空USearch索引实例，初始化索引所需的所有基础结构
    const cache = await this.createEmptyIndex(indexKey);
    // 将新创建的索引缓存实例存入全局索引集合，完成索引注册
    this.indexes.set(indexKey, cache);

    // 遍历所有从数据库中查询到的内存记录，逐行处理向量数据导入
    for (const row of rows) {
      // 根据向量类型从当前行中提取对应的原始二进制向量数据
      const raw = args.kind === "tags" ? row.tags_vector : row.vector;
      // 将二进制格式的向量数据解码为USearch所需的Float32Array格式
      const vector = this.decodeVector(raw);
      // 若解码后的向量长度为0（数据无效或为空），跳过当前条目的处理
      if (vector.length === 0) continue;
      // 将当前内存的向量数据插入/更新到新建的USearch索引中，完成单条数据索引
      this.upsertItem(cache, { id: row.id, vector });
    }

    // 所有数据处理完成后，将该索引标记为已完成初始化，后续不再触发重建流程
    cache.initialized = true;
  }

  // 删除指定分片下所有向量索引的异步方法，用于分片清理或卸载场景
  async deleteShardIndexes(args: { shard: ShardInfo }): Promise<void> {
    // 遍历所有支持的向量类型（内容向量、标签向量），确保全量清理
    for (const kind of ["content", "tags"] as const) {
      // 根据分片信息和向量类型生成目标索引的唯一标识键
      const indexKey = this.getIndexKey(args.shard, kind);
      // 从全局索引缓存中移除该分片对应类型的索引实例，释放内存资源
      this.indexes.delete(indexKey);
    }
  }

  // 测试专用的批量向量插入方法，用于单元测试或集成测试中快速构建测试索引
  async insertManyForTest(indexKey: string, items: BackendInsertItem[]): Promise<void> {
    // 获取或创建指定索引键的缓存索引实例，确保测试索引存在
    const cache = await this.getOrCreateIndex(indexKey);
    // 调用底层批量添加方法，将测试向量数据插入索引
    this.addItems(cache, items);
    // 将测试索引标记为已完成初始化，避免后续重建流程覆盖测试数据
    cache.initialized = true;
  }

  // 测试专用的向量搜索方法，用于在单元测试或集成测试中直接通过索引键执行检索
  async searchForTest(
    // 目标索引的唯一标识键，指定要搜索的具体向量索引
    indexKey: string,
    // 用于相似度检索的查询向量，采用USearch要求的Float32Array格式
    queryVector: Float32Array,
    // 搜索结果的最大返回数量，限制返回的近邻向量个数
    limit: number
  ): Promise<BackendSearchResult[]> {
    // 获取或创建指定索引键的缓存索引实例，确保测试用索引已初始化
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      // 调用USearch原生索引的搜索接口，输入查询向量和结果数量限制获取匹配结果
      const matches = cache.index.search(queryVector, limit);
      // 将USearch返回的匹配键集合转换为标准化的后端搜索结果数组
      return Array.from(matches.keys as Iterable<bigint>, (key, index) => {
        // 通过内部数字键从反向映射中查询对应的原始业务实体ID
        const id = cache.keyToId.get(key);
        // 如果无法找到对应内部键的业务ID，抛出索引元数据缺失的异常
        if (!id) {
          throw new Error(
            `USearch index metadata missing for key ${String(key)} in ${cache.indexKey}`
          );
        }
        // 封装为符合后端统一格式的搜索结果对象，包含业务ID和相似度距离
        return {
          id,
          // 从匹配结果的距离数组中取出当前结果的距离值，兜底0避免空值异常
          distance: matches.distances[index] ?? 0,
        };
      });
    } catch (error) {
      // 捕获搜索过程中的所有异常，封装为测试场景专属的错误信息抛出
      throw new Error(`USearch test search failed for ${indexKey}: ${String(error)}`);
    }
  }

  // 获取或创建索引实例的私有异步方法，负责根据索引键管理索引的生命周期
  private async getOrCreateIndex(indexKey: string): Promise<CachedIndex> {
    // 尝试从全局索引缓存中获取指定索引键的已存在索引实例
    const existing = this.indexes.get(indexKey);
    // 如果索引实例已存在，直接返回缓存的实例避免重复创建
    if (existing) return existing;

    // 缓存中不存在目标索引，调用创建空索引的方法初始化新的索引实例
    const cache = await this.createEmptyIndex(indexKey);
    // 将新创建的索引实例存入全局缓存，供后续请求复用
    this.indexes.set(indexKey, cache);
    // 返回刚初始化完成的索引实例给调用方
    return cache;
  }

  // 创建空索引实例的私有异步方法，负责初始化USearch索引及配套元数据结构
  private async createEmptyIndex(indexKey: string): Promise<CachedIndex> {
    // 动态加载USearch模块，确保依赖正确导入并获取模块实例
    const usearch = await this.loadUSearch();
    // 返回符合CachedIndex接口结构的完整索引实例，包含所有必要属性
    return {
      // 初始化USearch原生索引实例，配置向量维度为预设值，相似度度量采用余弦距离
      index: new usearch.Index({ dimensions: this.options.dimensions, metric: "cos" }),
      // 初始化业务ID到内部数字键的空映射表，用于建立ID与USearch键的关联
      idToKey: new Map(),
      // 初始化内部数字键到业务ID的反向空映射表，用于搜索结果溯源原始业务ID
      keyToId: new Map(),
      // 初始化下一个可用的内部自增键，从1n开始生成唯一的bigint类型键值
      nextKey: 1n,
      // 传入当前索引的唯一标识键，记录该索引的身份标识
      indexKey,
      // 初始化索引的初始化状态标记，新建索引默认未完成数据加载与初始化
      initialized: false,
    };
  }

  // 私有方法：确保业务ID对应有效的内部数字键，不存在则创建新键并维护双向映射
  private ensureKey(cache: CachedIndex, id: string): bigint {
    // 从业务ID到内部键的映射中查询当前ID是否已存在关联的内部键
    const existing = cache.idToKey.get(id);
    // 若已存在对应内部键，直接返回该键避免重复分配
    if (existing !== undefined) return existing;

    // 分配当前可用的自增内部键作为新ID的关联键
    const key = cache.nextKey;
    // 自增内部键计数器，为下一个新ID预留唯一键值
    cache.nextKey += 1n;
    // 建立业务ID到内部键的正向映射，支持通过业务ID快速查找内部键
    cache.idToKey.set(id, key);
    // 建立内部键到业务ID的反向映射，支持搜索结果溯源原始业务ID
    cache.keyToId.set(key, id);
    // 返回分配的内部键供后续向量操作使用
    return key;
  }

  // 私有方法：批量添加向量条目到索引，循环调用单条插入逻辑实现批量处理
  private addItems(cache: CachedIndex, items: BackendInsertItem[]): void {
    // 遍历所有待插入的向量条目，逐个执行插入或更新操作
    for (const item of items) {
      // 调用单条向量的插入更新方法，处理当前条目的索引写入
      this.upsertItem(cache, item);
    }
  }

  // 私有方法：单条向量的插入或更新，若ID已存在则先删除旧向量再写入新向量
  private upsertItem(cache: CachedIndex, item: BackendInsertItem): void {
    // 查询当前业务ID是否已在索引中存在关联的内部键
    const existing = cache.idToKey.get(item.id);
    // 若该ID已存在向量数据，先从USearch原生索引中移除旧向量
    if (existing !== undefined) {
      cache.index.remove(existing);
    }
    // 获取当前业务ID对应的内部键（不存在则自动创建）
    const key = this.ensureKey(cache, item.id);
    // 将新向量添加到USearch原生索引中，完成向量的写入操作
    cache.index.add(key, item.vector);
  }

  // 将二进制格式的向量数据解码为USearch可直接使用的Float32Array格式
  private decodeVector(value: Uint8Array | ArrayBuffer | null | undefined): Float32Array {
    // 若输入值为空或未定义，直接返回空的Float32Array避免后续处理异常
    if (!value) return new Float32Array();
    // 处理Uint8Array类型的二进制数据，需从其底层ArrayBuffer中提取正确范围的字节
    if (value instanceof Uint8Array) {
      // 基于Uint8Array的偏移和长度，从底层缓冲区中切片出完整的向量数据并转换为Float32Array
      return new Float32Array(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      );
    }
    // 对于原生ArrayBuffer类型，直接转换为Float32Array即可使用
    return new Float32Array(value);
  }

  // 根据分片信息和向量类型生成唯一的索引标识键，用于全局定位不同分片的不同类型向量索引
  private getIndexKey(shard: ShardInfo, kind: VectorKind): string {
    // 拼接分片作用域、分片哈希、分片索引和向量类型，生成全局唯一的索引键字符串
    return `${shard.scope}_${shard.scopeHash}_${shard.shardIndex}_${kind}`;
  }

  // 异步加载USearch原生模块，处理动态导入的异常场景确保错误信息可追踪
  private async loadUSearch(): Promise<USearchModule> {
    try {
      // 动态导入usearch模块，实现懒加载降低初始化时的资源占用
      return await import("usearch");
    } catch (error) {
      // 捕获模块加载失败的异常，封装为带上下文的错误信息抛出便于排查问题
      throw new Error(`Failed to load usearch backend: ${String(error)}`);
    }
  }
}
