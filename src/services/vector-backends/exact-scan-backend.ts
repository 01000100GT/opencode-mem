// 从本地types模块导入向量后端相关的类型定义
import type {
  // 后端插入数据项类型，封装单条向量插入所需的全部参数
  BackendInsertItem,
  // 后端搜索结果类型，封装单条匹配结果的ID和距离值
  BackendSearchResult,
  // 向量后端接口，定义所有向量存储后端必须实现的核心方法
  VectorBackend,
  // 向量搜索参数类型，封装搜索请求的查询向量、过滤条件等参数
  VectorBackendSearchParams,
  // 向量种类枚举，区分普通内容向量和标签向量两类向量类型
  VectorKind,
} from "./types.js";
// 从sqlite模块导入分片信息类型，描述单个数据分片的配置和状态
import type { ShardInfo } from "../sqlite/types.js";
// 导入余弦相似度计算工具函数，用于衡量两个向量的相似程度
import { cosineSimilarity } from "../../utils/math.js";

// 已排序向量行接口，用于存储待排序的向量数据及其唯一标识
interface RankedRow {
  // 向量对应的记忆数据唯一ID，关联原始数据库中的记录
  id: string;
  // 解码后的浮点32位向量数据，用于计算与查询向量的相似度
  vector: Float32Array;
}

// 数据库向量行接口，用于映射SQL查询返回的原始向量数据记录结构
interface VectorRow {
  // 记忆数据唯一标识ID，与memories表中的主键id字段一一对应
  id: string;
  // 主内容向量的二进制编码数据，存储为Uint8Array或ArrayBuffer格式，可为空值
  vector?: Uint8Array | ArrayBuffer | null;
  // 标签专属向量的二进制编码数据，存储格式与主向量一致，可为空值
  tags_vector?: Uint8Array | ArrayBuffer | null;
}

// 精确扫描后端类，实现VectorBackend接口定义的所有核心方法
// 该后端采用暴力穷举的全量扫描策略，直接计算所有向量与查询向量的相似度
export class ExactScanBackend implements VectorBackend {
  // 获取后端唯一标识名称的方法，实现VectorBackend接口要求的名称获取能力
  getBackendName(): string {
    // 返回固定的后端标识符字符串，用于在系统中唯一标识该精确扫描后端
    return "exact-scan";
  }

  // 向量排序核心方法，对输入的所有候选向量进行相似度排序并返回top-N结果
  // rows: 待排序的向量列表，每个元素包含向量ID和原始浮点向量数据
  // queryVector: 用户输入的查询向量，用于计算所有候选向量与查询的匹配度
  // limit: 返回结果的最大数量，即需要截取的top-N结果长度
  rankVectors(rows: RankedRow[], queryVector: Float32Array, limit: number): BackendSearchResult[] {
    // 链式调用完成向量处理全流程：转换格式→排序→截取结果
    return (
      rows
        // 第一步：将原始RankedRow数组转换为包含距离值的BackendSearchResult格式
        .map((row) => ({
          // 保留原始向量的唯一ID，用于关联原始数据库中的记忆记录
          id: row.id,
          // 将余弦相似度转换为距离值：相似度越高则距离越小（取值范围0~2）
          // 余弦相似度值域为[-1,1]，1-相似度后将相似的向量排在结果前列
          distance: 1 - cosineSimilarity(row.vector, queryVector),
        }))
        // 第二步：按照距离值升序排序，距离越小（相似度越高）的向量排在越前面
        .sort((a, b) => a.distance - b.distance)
        // 第三步：截取前limit个结果，只返回相似度最高的指定数量的匹配记录
        .slice(0, limit)
    );
  }

  // 单条向量数据插入方法，实现VectorBackend接口的插入能力
  // 当前精确扫描后端采用全量扫描策略，无需维护独立索引，因此插入逻辑留空
  async insert(_args: {
    // 待插入向量对应的记忆数据唯一ID，关联原始数据库的记录主键
    id: string;
    // 待插入的解码后浮点32位向量数据，包含完整的向量维度信息
    vector: Float32Array;
    // 目标分片信息，指定向量要写入的数据库分片的配置和状态
    shard: ShardInfo;
    // 向量类型标识，区分是主内容向量还是标签专属向量
    kind: VectorKind;
  }): Promise<void> {}

  // 批量向量数据插入方法，支持一次性插入多条向量记录
  // 精确扫描后端无独立索引需要维护，因此批量插入逻辑同样留空
  async insertBatch(_args: {
    // 待插入的向量项数组，每个元素包含单条向量插入所需的全部参数
    items: BackendInsertItem[];
    // 目标分片信息，指定这批向量要写入的数据库分片配置
    shard: ShardInfo;
    // 向量类型标识，统一指定这批插入向量的类型（主内容/标签）
    kind: VectorKind;
  }): Promise<void> {}

  // 单条向量数据删除方法，从后端存储中移除指定记忆的向量数据
  // 精确扫描模式下直接从数据库中删除原记录，无需额外维护索引，因此逻辑留空
  async delete(_args: { id: string; shard: ShardInfo; kind: VectorKind }): Promise<void> {}

  // 向量搜索核心方法，实现VectorBackend接口的向量检索能力
  // 接收搜索参数，返回按相似度排序的top-N匹配结果列表
  async search(args: VectorBackendSearchParams): Promise<BackendSearchResult[]> {
    // 根据向量类型选择对应的数据库列名，标签向量用tags_vector列，普通向量用vector列
    const column = args.kind === "tags" ? "tags_vector" : "vector";
    // 类型断言数据库对象，获取支持SQL预处理和查询的数据库实例
    const rows = (
      args.db as {
        prepare: (sql: string) => { all: () => VectorRow[] };
      }
    )
      // 预处理SQL语句，从memories表中查询指定列非空的所有有效向量记录
      .prepare(`SELECT id, ${column} FROM memories WHERE ${column} IS NOT NULL`)
      // 执行SQL查询，获取所有符合条件的向量数据行
      .all();

    // 无有效向量记录时直接返回空数组，终止后续计算流程
    if (rows.length === 0) {
      return [];
    }

    // 将数据库原始向量行转换为可排序的RankedRow格式，完成向量解码和过滤
    const rankedRows: RankedRow[] = rows
      // 遍历每个原始行，映射为带ID和解码后浮点向量的标准结构
      .map((row) => ({
        id: row.id,
        // 根据向量类型调用解码方法，将二进制向量数据转换为Float32Array格式
        vector: this.decodeVector(args.kind === "tags" ? row.tags_vector : row.vector),
      }))
      // 过滤掉解码后长度为0的无效向量，避免后续相似度计算出错
      .filter((row) => row.vector.length > 0);

    // 调用核心排序方法，对所有有效向量计算相似度并返回排序后的top-N结果
    return this.rankVectors(rankedRows, args.queryVector, args.limit);
  }

  // 基于分片重建索引的异步方法，实现VectorBackend接口要求的分片数据重建能力
  // 精确扫描后端无需维护额外索引结构，因此重建逻辑留空
  async rebuildFromShard(_args: {
    // 目标分片对应的数据库实例，用于读取重建所需的原始向量数据
    db: unknown;
    // 待重建的分片信息，包含分片的存储路径、状态等核心配置
    shard: ShardInfo;
    // 待重建的向量类型标识，区分主内容向量和标签专属向量两类
    kind: VectorKind;
  }): Promise<void> {}

  // 删除分片关联索引的异步方法，清理指定分片下所有后端维护的索引数据
  // 精确扫描后端无独立索引需要清理，因此删除逻辑留空
  async deleteShardIndexes(_args: { shard: ShardInfo }): Promise<void> {}

  // 向量二进制数据解码私有方法，将数据库存储的原始二进制向量转换为可计算的Float32Array格式
  // value: 数据库中读取的原始向量数据，支持Uint8Array、ArrayBuffer以及空值类型
  // 返回解码完成的标准32位浮点向量，用于后续的相似度计算等核心操作
  private decodeVector(value: Uint8Array | ArrayBuffer | null | undefined): Float32Array {
    // 输入值为空的边界情况处理，直接返回空浮点数组避免后续计算出错
    if (!value) {
      return new Float32Array();
    }

    // 处理Uint8Array类型的输入，从其底层ArrayBuffer中正确截取向量数据的有效范围
    // 解决Uint8Array可能存在的字节偏移问题，确保浮点数组读取的内存区间准确无误
    if (value instanceof Uint8Array) {
      return new Float32Array(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      );
    }

    // 处理原生ArrayBuffer类型的输入，直接构造Float32Array完成解码
    return new Float32Array(value);
  }
}
