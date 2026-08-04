// 导入SQLite数据库实例获取函数
import { getDatabase } from "./sqlite-bootstrap.js";
// 导入数据库连接管理器，负责多数据库连接的管理与复用
import { connectionManager } from "./connection-manager.js";
// 导入日志工具，用于记录系统运行状态与错误信息
import { log } from "../logger.js";
// 导入全局配置对象，包含系统各项参数配置
import { CONFIG } from "../../config.js";
// 导入核心数据类型定义：记忆记录、搜索结果、分片信息
import type { MemoryRecord, SearchResult, ShardInfo } from "./types.js";
// 导入向量数据库后端工厂函数，用于创建指定类型的向量后端实例
import { createVectorBackend } from "../vector-backends/backend-factory.js";
// 导入精确扫描向量后端，作为主向量后端不可用时的降级方案
import { ExactScanBackend } from "../vector-backends/exact-scan-backend.js";
// 导入向量后端通用类型定义，统一各类向量后端的接口规范
import type { VectorBackend } from "../vector-backends/types.js";

// 初始化SQLite数据库实例，获取数据库操作对象
const Database = getDatabase();
// 提取数据库实例的原型类型，用于后续类型注解，保证类型安全
type DatabaseType = typeof Database.prototype;

/**
 * 将Float32Array格式的向量转换为Uint8Array字节流，用于存储到SQLite数据库
 * 如果输入向量为空则返回null，适配数据库空值存储场景
 * @param vector - 输入的浮点型向量，可选参数
 * @returns 转换后的字节数组，或空值null
 */
// 定义向量转二进制流的工具函数，接收可选的Float32Array类型向量参数
// 返回值为Uint8Array字节数组或null，符合SQLite的BLOB字段存储要求
function toBlob(vector?: Float32Array): Uint8Array | null {
  // 三元表达式判断输入向量是否存在
  // 若存在则从向量的底层ArrayBuffer创建Uint8Array视图，复用原内存空间避免拷贝
  // 若不存在则返回null，对应数据库中的空值
  return vector ? new Uint8Array(vector.buffer) : null;
}

// 导出向量搜索核心类，提供统一的向量存储与检索能力封装
export class VectorSearch {
  // 私有只读属性：主向量后端实例的Promise对象，支持异步初始化与延迟加载
  private backendPromise: Promise<VectorBackend> | null = null;
  // 私有只读属性：降级备用向量后端实例，主后端故障时自动切换保障可用性
  private readonly fallbackBackend: VectorBackend;

  // 类构造函数：初始化向量搜索核心组件，支持自定义后端注入与默认配置
  // backend：可选的自定义向量后端实例，若传入则直接使用，否则根据配置创建默认后端
  // fallbackBackend：可选的降级备用后端，默认实例化精确扫描后端作为保底方案
  constructor(backend?: VectorBackend, fallbackBackend: VectorBackend = new ExactScanBackend()) {
    // 初始化主后端Promise：若传入自定义后端则包装为已解决的Promise
    // 注意：不传 backend 时不立即创建——延迟到首次 getBackend() 调用，
    // 确保 CONFIG 已由 initConfig 初始化完毕（否则 vectorBackend 仍为默认值 "usearch-first"）
    if (backend) {
      this.backendPromise = Promise.resolve(backend);
    }
    // 保存降级备用后端实例到类属性，供主后端异常时切换使用
    this.fallbackBackend = fallbackBackend;
  }

  // 获取初始化完成的向量后端实例
  // 首次调用时才根据 CONFIG.vectorBackend 创建后端，确保配置已就绪
  private async getBackend(): Promise<VectorBackend> {
    if (!this.backendPromise) {
      this.backendPromise = createVectorBackend({ vectorBackend: CONFIG.vectorBackend });
    }
    return this.backendPromise;
  }

  // 异步插入向量到数据库的核心方法，接收数据库连接实例、记忆记录对象和可选的分片信息
  async insertVector(db: DatabaseType, record: MemoryRecord, shard?: ShardInfo): Promise<void> {
    // 预编译SQL插入语句，提升重复执行性能，指定所有需要插入的字段列表
    const insertMemory = db.prepare(`
      INSERT INTO memories (
        id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
        metadata, display_name, user_name, user_email, project_path, project_name, git_repo_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 执行预编译的插入语句，按顺序传入所有字段值，完成SQLite层面的记录持久化
    insertMemory.run(
      record.id,
      record.content,
      toBlob(record.vector),
      toBlob(record.tagsVector),
      record.containerTag,
      record.tags || null,
      record.type || null,
      record.createdAt,
      record.updatedAt,
      record.metadata || null,
      record.displayName || null,
      record.userName || null,
      record.userEmail || null,
      record.projectPath || null,
      record.projectName || null,
      record.gitRepoUrl || null
    );

    // 捕获向量后端插入过程中可能抛出的异常，确保数据一致性
    try {
      // 仅在存在分片信息时执行向量后端的存储操作，单分片场景默认跳过
      if (shard) {
        // 等待主向量后端实例初始化完成，获取可执行操作的后端对象
        const backend = await this.getBackend();
        // 向向量后端插入内容向量，记录唯一ID、向量数据、所属分片及类型标记
        await backend.insert({ id: record.id, vector: record.vector, shard, kind: "content" });
        // 仅当记忆记录存在标签向量时，才执行标签向量的插入操作，避免空数据写入
        if (record.tagsVector) {
          // 向向量后端插入标签向量，复用同一记录ID标记，类型标记为tags区分内容向量
          await backend.insert({ id: record.id, vector: record.tagsVector, shard, kind: "tags" });
        }
      }
      // 捕获向量后端插入流程中的所有异常，触发事务回滚逻辑保证数据一致
    } catch (error) {
      // 向量后端插入失败时，从SQLite的memories表中删除刚插入的记录，避免脏数据残留
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(record.id);
      // 将捕获到的异常向上层抛出，通知调用方插入操作失败，由上层处理后续错误逻辑
      throw error;
    }
  }

  // 在单个分片中执行向量搜索的异步方法，整合向量召回与文本过滤逻辑
  // shard: 要搜索的分片信息，包含分片ID、数据库路径等核心元数据
  // queryVector: 输入的查询向量，用于向量相似度匹配的基础依据
  // containerTag: 容器标签过滤器，用于限定搜索范围的标签条件
  // limit: 最终返回的最大结果数量，控制输出结果集大小
  // queryText: 可选的原始查询文本，用于标签精确匹配的Boost增强计算
  async searchInShard(
    shard: ShardInfo,
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    queryText?: string
  ): Promise<SearchResult[]> {
    // 从连接管理器获取当前分片对应的数据库连接实例，复用连接池资源
    const db = connectionManager.getConnection(shard.dbPath);
    // 等待主向量后端实例初始化完成，获取就绪的向量操作核心对象
    const backend = await this.getBackend();
    // 声明内容向量搜索结果存储变量，用于保存内容向量匹配的候选结果
    let contentResults;
    // 声明标签向量搜索结果存储变量，用于保存标签向量匹配的候选结果
    let tagsResults;

    try {
      // 重建内容向量的分片索引，确保查询基于最新数据状态
      await backend.rebuildFromShard({ db, shard, kind: "content" });
      // 重建标签向量的分片索引，保证标签维度的向量检索准确性
      await backend.rebuildFromShard({ db, shard, kind: "tags" });

      // 调用主向量后端执行内容向量搜索，获取4倍于返回限制的候选结果用于后续融合排序
      contentResults = await backend.search({
        db,
        shard,
        kind: "content",
        queryVector,
        limit: limit * 4,
      });
      // 调用主向量后端执行标签向量搜索，同样获取4倍于返回限制的候选集
      tagsResults = await backend.search({
        db,
        shard,
        kind: "tags",
        queryVector,
        limit: limit * 4,
      });
    } catch (error) {
      // 主向量后端执行失败，记录降级告警日志，切换到精确扫描保底方案
      log("Vector search degraded to exact scan in shard", {
        shardId: shard.id,
        backend: backend.getBackendName(),
        error: String(error),
      });

      // 使用降级后端重建内容向量的分片索引，确保降级流程的索引有效性
      await this.fallbackBackend.rebuildFromShard({ db, shard, kind: "content" });
      // 使用降级后端重建标签向量的分片索引，保证标签维度检索的准确性
      await this.fallbackBackend.rebuildFromShard({ db, shard, kind: "tags" });
      // 通过降级后端执行内容向量搜索，获取4倍于返回限制的候选结果用于后续融合排序
      contentResults = await this.fallbackBackend.search({
        db,
        shard,
        kind: "content",
        queryVector,
        limit: limit * 4,
      });
      // 通过降级后端执行标签向量搜索，同样获取4倍于返回限制的候选集
      tagsResults = await this.fallbackBackend.search({
        db,
        shard,
        kind: "tags",
        queryVector,
        limit: limit * 4,
      });
    }

    // 创建分数映射表，存储每个记忆ID对应的内容相似度和标签相似度
    const scoreMap = new Map<string, { contentSim: number; tagsSim: number }>();

    // 遍历内容向量搜索结果，初始化对应记忆的分数
    for (const r of contentResults) {
      // 将距离转换为相似度（1-距离，距离越小相似度越高），标签相似度初始化为0
      scoreMap.set(r.id, { contentSim: 1 - r.distance, tagsSim: 0 });
    }

    // 遍历标签向量搜索结果，更新对应记忆的标签相似度分数
    for (const r of tagsResults) {
      // 尝试从分数映射中获取当前记忆ID的分数条目
      const entry = scoreMap.get(r.id);
      if (entry) {
        // 如果条目已存在（该记忆同时出现在内容搜索结果中），更新标签相似度
        entry.tagsSim = 1 - r.distance;
      } else {
        // 如果条目不存在（该记忆仅出现在标签搜索结果中），创建新条目，内容相似度初始化为0
        scoreMap.set(r.id, { contentSim: 0, tagsSim: 1 - r.distance });
      }
    }

    // 提取所有存在分数的记忆ID数组，用于后续数据库查询
    const ids = Array.from(scoreMap.keys());
    // 如果没有任何匹配的记忆ID，直接返回空结果数组终止搜索流程
    if (ids.length === 0) return [];

    // 根据ids数组的长度生成对应数量的SQL参数占位符"?"，用逗号拼接
    // 例如ids长度为3时，生成"?,?,?"，用于SQL的IN子句
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        containerTag === ""
          ? `
      SELECT * FROM memories
      WHERE id IN (${placeholders})
    `
          : `
      SELECT * FROM memories
      WHERE id IN (${placeholders}) AND container_tag = ?
    `
      )
      .all(...ids, ...(containerTag === "" ? [] : [containerTag])) as any[];

    // 处理查询文本，提取有效关键词用于后续标签匹配增强
    const queryWords = queryText
      ? queryText
          // 将查询文本转换为全小写，统一大小写避免匹配偏差
          .toLowerCase()
          // 按空白字符或逗号分割文本，生成原始词汇数组
          .split(/[\s,]+/)
          // 过滤掉长度小于等于1的无意义词汇，仅保留有效关键词
          .filter((w) => w.length > 1)
      : // 无查询文本时返回空数组，避免后续处理出错
        [];

    // 遍历数据库查询结果行，将原始数据库记录转换为标准化的搜索结果对象
    const hydratedResults = rows.map((row: any) => {
      // 从分数映射中获取当前记忆的相似度分数，非空断言确保数据存在性
      const scores = scoreMap.get(row.id)!;
      // 提取原始标签字符串，数据库无标签时默认使用空字符串
      const memoryTagsStr = row.tags || "";
      // 将标签字符串分割为数组，统一转为小写并去除首尾空格，保证格式一致性
      const memoryTags = memoryTagsStr.split(",").map((t: string) => t.trim().toLowerCase());

      // 初始化精确标签匹配的加分系数，默认无额外加分
      let exactMatchBoost = 0;
      // 仅当查询存在有效关键词且当前记忆有标签时，才执行匹配加分逻辑
      if (queryWords.length > 0 && memoryTags.length > 0) {
        // 统计与记忆标签存在包含关系的查询词数量，双向匹配覆盖更多场景
        const matches = queryWords.filter((w) =>
          memoryTags.some((t: string) => t.includes(w) || w.includes(t))
        ).length;
        // 计算精确匹配加分，取值范围0-1，匹配度越高加分越多，分母避免除零错误
        exactMatchBoost = matches / Math.max(queryWords.length, 1);
      }

      // 最终标签相似度取向量相似度和精确匹配加分的最大值，融合两种匹配方式的优势
      const finalTagsSim = Math.max(scores.tagsSim, exactMatchBoost);
      // 计算综合相似度，内容向量权重60%，标签相似度权重40%，符合主流搜索排序逻辑
      const similarity = scores.contentSim * 0.6 + finalTagsSim * 0.4;

      // 返回标准化的搜索结果对象，统一所有字段的格式和命名规范
      return {
        // 记忆的唯一标识符，与数据库记录ID保持一致
        id: row.id,
        // 记忆的原始内容文本，即存储的核心记忆数据
        memory: row.content,
        // 综合计算得到的最终相似度分数，用于结果排序
        similarity,
        // 原始格式的标签数组，保留原始字符串不做大小写转换，保证展示准确性
        tags: memoryTagsStr ? memoryTagsStr.split(",") : [],
        // 解析后的元数据对象，数据库中存储的JSON字符串转为JS对象，无元数据时返回undefined
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        // 记忆所属的容器标签，用于多租户或多场景的数据隔离
        containerTag: row.container_tag,
        // 记忆的展示名称，用于前端友好展示的标题字段
        displayName: row.display_name,
        // 创建该记忆的用户名，记录数据归属信息
        userName: row.user_name,
        // 创建该记忆的用户邮箱，用于关联用户身份
        userEmail: row.user_email,
        // 记忆所属的项目路径，标识项目层级关系
        projectPath: row.project_path,
        // 记忆所属的项目名称，用于项目维度的聚合展示
        projectName: row.project_name,
        // 关联的Git仓库地址，记录代码仓库来源信息
        gitRepoUrl: row.git_repo_url,
        // 记忆的置顶标记，标记该记忆是否被用户固定展示
        isPinned: row.is_pinned,
      };
    });

    // 按综合相似度降序排列结果，相似度越高的记忆越靠前展示
    hydratedResults.sort((a, b) => b.similarity - a.similarity);
    // 返回处理完成的标准化搜索结果数组，完成分片内的完整搜索流程
    return hydratedResults;
  }

  /**
   * 跨多个分片执行全局向量搜索的核心方法，聚合所有分片的搜索结果并统一排序
   * 实现分布式检索能力，支持跨用户/跨项目的全量数据聚合查询
   * @param shards - 参与搜索的所有分片信息数组，每个分片包含独立的数据库路径和元数据
   * @param queryVector - 用户输入的查询向量，用于相似度匹配的核心依据
   * @param containerTag - 容器标签过滤条件，用于隔离多租户或多场景的数据范围
   * @param limit - 最终返回的最大结果数量，控制输出结果集的大小
   * @param similarityThreshold - 相似度阈值过滤，仅保留综合得分超过阈值的有效结果
   * @param queryText - 可选的原始查询文本，用于标签精确匹配的分数增强计算
   * @returns 排序后的标准化搜索结果数组，按综合相似度降序排列
   */
  async searchAcrossShards(
    shards: ShardInfo[],
    queryVector: Float32Array,
    containerTag: string,
    limit: number,
    similarityThreshold: number,
    queryText?: string
  ): Promise<SearchResult[]> {
    // 为每个分片创建独立的搜索Promise，实现全分片的并行检索
    const shardPromises = shards.map(async (shard) => {
      // 捕获单个分片搜索过程中的异常，避免局部故障影响全局搜索流程
      try {
        // 调用单分片搜索核心方法，获取当前分片内的匹配结果
        return await this.searchInShard(shard, queryVector, containerTag, limit, queryText);
      } catch (error) {
        // 记录分片搜索失败的错误日志，包含分片ID和具体异常信息，便于问题排查
        log("Shard search error", { shardId: shard.id, error: String(error) });
        // 异常分片返回空结果数组，保证全局搜索流程的可用性
        return [];
      }
    });

    // 等待所有分片的搜索任务执行完成，汇聚所有分片的结果集
    const resultsArray = await Promise.all(shardPromises);
    // 将二维的分片结果数组扁平化为一维数组，统一所有分片的结果集合
    const allResults = resultsArray.flat();

    // 对所有聚合后的结果执行全局排序，按综合相似度降序排列，优先展示高匹配度结果
    allResults.sort((a, b) => b.similarity - a.similarity);
    // 过滤相似度低于阈值的无效结果，截取指定数量的Top结果返回，完成跨分片搜索全流程
    return allResults.filter((r) => r.similarity >= similarityThreshold).slice(0, limit);
  }

  // 异步删除向量记录的核心方法，负责从SQLite和向量后端同步删除指定记忆
  // db: 当前分片对应的数据库连接实例，提供SQLite操作能力
  // memoryId: 要删除的记忆唯一标识符，定位需要清理的目标记录
  // shard: 可选的分片信息，包含分片ID、路径等元数据，用于向量后端的定向删除
  async deleteVector(db: DatabaseType, memoryId: string, shard?: ShardInfo): Promise<void> {
    // 预编译SQL删除语句，从memories表中移除指定ID的记忆记录
    // 执行预编译语句完成SQLite层面的记录物理删除
    db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);

    // 仅当存在有效分片信息时，执行向量后端的删除操作，避免无效调用
    if (shard) {
      // 等待主向量后端实例初始化完成，获取可执行操作的后端对象
      const backend = await this.getBackend();
      // 从向量后端删除内容类型向量，同步清理内存或索引中的向量数据
      await backend.delete({ id: memoryId, shard, kind: "content" });
      // 从向量后端删除标签类型向量，完成该记忆所有关联向量的全量清理
      await backend.delete({ id: memoryId, shard, kind: "tags" });
    }
  }

  // 异步更新向量记录的核心方法，同步更新SQLite存储和向量后端索引
  // db: 当前分片对应的数据库连接实例，提供SQLite操作能力
  // memoryId: 要更新的记忆唯一标识符，定位需要修改的目标记录
  // vector: 新的内容向量数据，用于替换原有向量的Float32Array格式数值
  // shard: 可选的分片信息，包含分片ID、路径等元数据，用于向量后端的定向更新
  // tagsVector: 可选的新标签向量数据，支持仅更新内容向量或同时更新标签向量的场景
  async updateVector(
    db: DatabaseType,
    memoryId: string,
    vector: Float32Array,
    shard?: ShardInfo,
    tagsVector?: Float32Array
  ): Promise<void> {
    // 预编译SQL更新语句，修改memories表中指定ID记录的向量字段
    // 将新的内容向量和标签向量转换为数据库可存储的BLOB格式，完成SQLite层面的持久化更新
    db.prepare(`UPDATE memories SET vector = ?, tags_vector = ? WHERE id = ?`).run(
      toBlob(vector),
      toBlob(tagsVector),
      memoryId
    );

    // 仅当存在有效分片信息时，执行向量后端的索引更新操作，保证索引与存储数据一致性
    if (shard) {
      // 等待主向量后端实例初始化完成，获取可执行操作的后端对象
      const backend = await this.getBackend();
      // 在向量后端插入（覆盖）新的内容向量，通过同一记忆ID实现索引更新
      await backend.insert({ id: memoryId, vector, shard, kind: "content" });
      // 若传入了新的标签向量，同步更新向量后端的标签向量索引
      if (tagsVector) {
        await backend.insert({ id: memoryId, vector: tagsVector, shard, kind: "tags" });
      } else {
        // 若未传入新的标签向量，从向量后端删除原有的标签向量记录，处理标签向量清空场景
        await backend.delete({ id: memoryId, shard, kind: "tags" });
      }
    }
  }

  listMemories(db: DatabaseType, containerTag: string, limit: number): any[] {
    const stmt = db.prepare(
      containerTag === ""
        ? `
      SELECT * FROM memories
      ORDER BY created_at DESC
      LIMIT ?
    `
        : `
      SELECT * FROM memories
      WHERE container_tag = ?
      ORDER BY created_at DESC
      LIMIT ?
    `
    );

    return (containerTag === "" ? stmt.all(limit) : stmt.all(containerTag, limit)) as any[];
  }

  // 获取全部记忆记录的方法，接收当前数据库连接实例
  getAllMemories(db: DatabaseType): any[] {
    // 预编译SQL查询语句，从memories表中取出所有记录并按创建时间倒序排列
    const stmt = db.prepare(`SELECT * FROM memories ORDER BY created_at DESC`);
    // 执行查询语句返回全部结果，类型断言为任意数组保持兼容性
    return stmt.all() as any[];
  }

  // 根据记忆ID获取单条记忆记录的方法，接收数据库连接和目标记忆ID
  // 查询失败无匹配记录时返回null，兼容空结果场景的类型处理
  getMemoryById(db: DatabaseType, memoryId: string): any | null {
    // 预编译SQL查询语句，通过唯一ID定位memories表中的目标记录
    const stmt = db.prepare(`SELECT * FROM memories WHERE id = ?`);
    // 执行查询并传入记忆ID作为参数，返回匹配的单条记录
    return stmt.get(memoryId) as any;
  }

  // 根据会话ID批量获取关联记忆记录的方法，从数据库中提取所有绑定到指定会话的记忆数据
  getMemoriesBySessionID(db: DatabaseType, sessionID: string): any[] {
    // 预编译SQL查询语句，从memories表中检索元数据包含指定会话ID的所有记录
    // 通过LIKE模糊匹配元数据JSON中的sessionID字段，保证跨不同元数据结构的兼容性
    // 按创建时间倒序排列，最新创建的记忆优先返回，符合会话时序展示逻辑
    const stmt = db.prepare(`
      SELECT * FROM memories
      WHERE metadata LIKE ?
      ORDER BY created_at DESC
    `);
    // 执行预编译的查询语句，传入构造好的模糊匹配参数，获取匹配的所有数据库行数据
    // 匹配模式构造为JSON片段格式，精准定位元数据中sessionID字段等于目标值的记录
    const rows = stmt.all(`%"sessionID":"${sessionID}"%`) as any[];
    // 遍历所有查询结果行，对原始数据库字段进行格式转换与标准化处理
    return rows.map((row: any) => ({
      // 展开原始行的所有字段，保留数据库存储的原生属性值
      ...row,
      // 处理标签字段：若数据库中存在标签字符串则按逗号分割为数组，否则返回空数组保证格式统一
      tags: row.tags ? row.tags.split(",") : [],
      // 处理元数据字段：若数据库中存在元数据JSON字符串则解析为JS对象，否则返回空对象避免空值异常
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    }));
  }

  // 统计指定容器标签下的向量记录总数，返回符合条件的记忆数量
  countVectors(db: DatabaseType, containerTag: string): number {
    // 预编译SQL统计语句，按容器标签过滤memories表中的记录数
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE container_tag = ?`);
    // 执行预编译语句并传入容器标签参数，获取统计结果对象
    const result = stmt.get(containerTag) as any;
    // 提取统计结果中的记录总数，返回给调用方
    return result.count;
  }

  // 统计当前数据库中所有向量记录的总数，返回全量记忆数量
  countAllVectors(db: DatabaseType): number {
    // 预编译SQL统计语句，统计memories表中的所有记录总数
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM memories`);
    // 执行预编译语句，获取全量统计结果对象
    const result = stmt.get() as any;
    // 提取统计结果中的总记录数，返回给调用方
    return result.count;
  }

  // 获取记忆表中所有去重后的维度标签数据，用于系统维度聚合统计
  getDistinctTags(db: DatabaseType): any[] {
    // 预编译SQL查询语句，从memories表中提取指定字段的唯一组合记录
    const stmt = db.prepare(`
      SELECT DISTINCT
        container_tag,
        display_name,
        user_name,
        user_email,
        project_path,
        project_name,
        git_repo_url
      FROM memories
    `);
    // 执行查询并返回所有符合条件的结果行，类型断言为任意数组保持兼容性
    return stmt.all() as any[];
  }

  // 为指定记忆记录设置置顶标记，将其在列表中优先展示
  pinMemory(db: DatabaseType, memoryId: string): void {
    // 预编译SQL更新语句，将目标记忆的is_pinned字段设置为1表示置顶状态
    const stmt = db.prepare(`UPDATE memories SET is_pinned = 1 WHERE id = ?`);
    // 执行更新语句，传入目标记忆ID作为参数完成置顶状态设置
    stmt.run(memoryId);
  }

  // 取消指定记忆的置顶状态，将其从置顶列表中移除恢复正常排序
  unpinMemory(db: DatabaseType, memoryId: string): void {
    // 预编译SQL更新语句，将目标记忆的is_pinned字段设置为0表示取消置顶
    const stmt = db.prepare(`UPDATE memories SET is_pinned = 0 WHERE id = ?`);
    // 执行更新语句，传入目标记忆ID作为参数完成置顶状态的清除
    stmt.run(memoryId);
  }

  // 为指定分片重建向量索引的异步方法，确保向量检索数据与数据库存储一致
  async rebuildIndexForShard(
    db: DatabaseType,
    scope: string,
    scopeHash: string,
    shardIndex: number
  ): Promise<void> {
    // 等待主向量后端实例初始化完成，获取就绪的向量操作核心对象
    const backend = await this.getBackend();
    // 构造分片信息对象，组装分片的唯一标识、归属范围、索引序号等核心元数据
    const shard = {
      id: 0, // 临时分片ID，重建索引场景下使用默认值即可
      scope: scope as "user" | "project", // 标记分片归属维度，支持用户级或项目级分片
      scopeHash, // 归属维度的唯一哈希值，用于定位具体的用户或项目分片
      shardIndex, // 分片在所属维度内的序号，支持单维度下的多分片水平扩展
      dbPath: "", // 数据库路径字段，重建索引时使用当前数据库连接，无需额外配置路径
      vectorCount: 0, // 向量数量字段，重建流程会自动统计更新，初始化为临时值
      isActive: true, // 标记分片为活跃状态，确保索引重建流程可正常执行
      createdAt: Date.now(), // 分片创建时间戳，使用当前时间作为临时标识
    };
    // 调用向量后端重建内容类型的分片索引，同步数据库内所有内容向量到检索引擎
    await backend.rebuildFromShard({ db, shard, kind: "content" });
    // 调用向量后端重建标签类型的分片索引，同步数据库内所有标签向量到检索引擎
    await backend.rebuildFromShard({ db, shard, kind: "tags" });
  }

  // 删除指定分片关联的所有向量索引的异步方法，清理分片销毁后的冗余索引数据
  async deleteShardIndexes(shard: ShardInfo): Promise<void> {
    // 等待主向量后端实例初始化完成，获取可执行索引操作的后端对象
    const backend = await this.getBackend();
    // 调用向量后端的分片索引删除方法，清除该分片下所有存储的向量索引数据
    await backend.deleteShardIndexes({ shard });
  }
}

// 导出全局唯一的向量搜索核心实例，供系统各模块统一调用向量存储与检索能力
export const vectorSearch = new VectorSearch();
