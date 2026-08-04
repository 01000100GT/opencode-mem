// hnswlib-wasm 向量后端：纯 WASM 实现 HNSW 近似最近邻搜索，
// 彻底告别 native addon。索引仅驻留内存，数据源为 sqlite（rebuild 时全量重建）。
import type {
  BackendInsertItem,
  BackendSearchResult,
  VectorBackend,
  VectorBackendSearchParams,
  VectorKind,
} from "./types.js";
import type { ShardInfo } from "../sqlite/types.js";

// HNSW 图构建参数
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 100;
const HNSW_SEED = 100;
const DEFAULT_MAX_ELEMENTS = 100_000;

// hnswlib-wasm 的模块与索引类型（web 构建，Node 下通过 window hack 加载）
interface HnswIndex {
  initIndex(maxElements: number, m: number, efConstruction: number, randomSeed: number): void;
  addPoint(point: Float32Array, label: number, replaceDeleted: boolean): void;
  markDelete(label: number): void;
  searchKnn(
    queryPoint: Float32Array,
    numNeighbors: number,
    filter?: unknown
  ): { distances: number[]; neighbors: number[] };
  resizeIndex(newMaxElements: number): void;
  getMaxElements(): number;
  getCurrentCount(): number;
  getNumDimensions(): number;
}

interface HnswlibModule {
  HierarchicalNSW: new (
    spaceName: string,
    numDimensions: number,
    autoSaveFilename: string
  ) => HnswIndex;
  loadHnswlib: () => Promise<HnswlibModule>;
}

// 缓存索引接口：管理每个分片的 hnswlib 索引及其 ID 映射元数据
interface CachedIndex {
  index: HnswIndex;
  idToKey: Map<string, number>;
  keyToId: Map<number, string>;
  nextKey: number;
  indexKey: string;
  initialized: boolean;
}

export class HnswlibWasmBackend implements VectorBackend {
  private readonly indexes = new Map<string, CachedIndex>();
  private hnswlibPromise: Promise<HnswlibModule> | null = null;

  constructor(
    private readonly options: {
      baseDir: string;
      dimensions: number;
    }
  ) {
    // baseDir 仅透传，索引不落盘（内存索引 + sqlite 全量重建）
    void this.options.baseDir;
  }

  getBackendName(): string {
    return "hnswlib-wasm";
  }

  async insert(args: {
    id: string;
    vector: Float32Array;
    shard: ShardInfo;
    kind: VectorKind;
  }): Promise<void> {
    const indexKey = this.getIndexKey(args.shard, args.kind);
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      this.upsertItem(cache, { id: args.id, vector: args.vector });
      cache.initialized = true;
    } catch (error) {
      throw new Error(`hnswlib insert failed for ${indexKey}: ${String(error)}`);
    }
  }

  async insertBatch(args: {
    items: BackendInsertItem[];
    shard: ShardInfo;
    kind: VectorKind;
  }): Promise<void> {
    const indexKey = this.getIndexKey(args.shard, args.kind);
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      this.addItems(cache, args.items);
      cache.initialized = true;
    } catch (error) {
      throw new Error(`hnswlib batch insert failed for ${indexKey}: ${String(error)}`);
    }
  }

  async delete(args: { id: string; shard: ShardInfo; kind: VectorKind }): Promise<void> {
    const cache = await this.getOrCreateIndex(this.getIndexKey(args.shard, args.kind));
    const key = cache.idToKey.get(args.id);
    if (key === undefined) return;
    cache.index.markDelete(key);
    cache.idToKey.delete(args.id);
    cache.keyToId.delete(key);
  }

  async search(args: VectorBackendSearchParams): Promise<BackendSearchResult[]> {
    const indexKey = this.getIndexKey(args.shard, args.kind);
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      const { neighbors, distances } = cache.index.searchKnn(
        args.queryVector,
        args.limit,
        undefined
      );
      const results: BackendSearchResult[] = [];
      for (let i = 0; i < neighbors.length; i++) {
        const key = neighbors[i];
        if (key === undefined) continue;
        const id = cache.keyToId.get(key);
        if (!id) {
          throw new Error(`hnswlib index metadata missing for key ${key} in ${cache.indexKey}`);
        }
        results.push({ id, distance: distances[i] ?? 0 });
      }
      return results;
    } catch (error) {
      throw new Error(`hnswlib search failed for ${indexKey}: ${String(error)}`);
    }
  }

  async rebuildFromShard(args: { db: unknown; shard: ShardInfo; kind: VectorKind }): Promise<void> {
    const indexKey = this.getIndexKey(args.shard, args.kind);
    const existing = this.indexes.get(indexKey);
    if (existing?.initialized) {
      return;
    }

    const column = args.kind === "tags" ? "tags_vector" : "vector";
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
      .prepare(`SELECT id, ${column} FROM memories WHERE ${column} IS NOT NULL`)
      .all();

    const cache = await this.createEmptyIndex(indexKey, Math.max(rows.length * 2, 1000));
    this.indexes.set(indexKey, cache);

    for (const row of rows) {
      const raw = args.kind === "tags" ? row.tags_vector : row.vector;
      const vector = this.decodeVector(raw);
      if (vector.length === 0) continue;
      this.upsertItem(cache, { id: row.id, vector });
    }

    cache.initialized = true;
  }

  async deleteShardIndexes(args: { shard: ShardInfo }): Promise<void> {
    for (const kind of ["content", "tags"] as const) {
      const indexKey = this.getIndexKey(args.shard, kind);
      this.indexes.delete(indexKey);
    }
  }

  // 测试专用辅助方法（对齐其他后端的测试入口约定）
  async insertManyForTest(indexKey: string, items: BackendInsertItem[]): Promise<void> {
    const cache = await this.getOrCreateIndex(indexKey);
    this.addItems(cache, items);
    cache.initialized = true;
  }

  async searchForTest(
    indexKey: string,
    queryVector: Float32Array,
    limit: number
  ): Promise<BackendSearchResult[]> {
    const cache = await this.getOrCreateIndex(indexKey);
    try {
      const { neighbors, distances } = cache.index.searchKnn(queryVector, limit, undefined);
      const results: BackendSearchResult[] = [];
      for (let i = 0; i < neighbors.length; i++) {
        const key = neighbors[i];
        if (key === undefined) continue;
        const id = cache.keyToId.get(key);
        if (!id) {
          throw new Error(`hnswlib index metadata missing for key ${key} in ${cache.indexKey}`);
        }
        results.push({ id, distance: distances[i] ?? 0 });
      }
      return results;
    } catch (error) {
      throw new Error(`hnswlib test search failed for ${indexKey}: ${String(error)}`);
    }
  }

  private async getOrCreateIndex(indexKey: string): Promise<CachedIndex> {
    const existing = this.indexes.get(indexKey);
    if (existing) return existing;

    const cache = await this.createEmptyIndex(indexKey, DEFAULT_MAX_ELEMENTS);
    this.indexes.set(indexKey, cache);
    return cache;
  }

  private async createEmptyIndex(indexKey: string, maxElements: number): Promise<CachedIndex> {
    const lib = await this.loadHnswlib();
    const index = new lib.HierarchicalNSW("cosine", this.options.dimensions, "");
    index.initIndex(maxElements, HNSW_M, HNSW_EF_CONSTRUCTION, HNSW_SEED);
    return {
      index,
      idToKey: new Map(),
      keyToId: new Map(),
      nextKey: 1,
      indexKey,
      initialized: false,
    };
  }

  private ensureKey(cache: CachedIndex, id: string): number {
    const existing = cache.idToKey.get(id);
    if (existing !== undefined) return existing;

    const key = cache.nextKey;
    cache.nextKey += 1;
    cache.idToKey.set(id, key);
    cache.keyToId.set(key, id);
    return key;
  }

  private addItems(cache: CachedIndex, items: BackendInsertItem[]): void {
    for (const item of items) {
      this.upsertItem(cache, item);
    }
  }

  private upsertItem(cache: CachedIndex, item: BackendInsertItem): void {
    // 容量不足时扩容；addPoint 对已存在的 label 会替换旧向量（更新语义）
    if (cache.index.getCurrentCount() >= cache.index.getMaxElements()) {
      cache.index.resizeIndex(cache.index.getMaxElements() * 2);
    }
    const key = this.ensureKey(cache, item.id);
    cache.index.addPoint(item.vector, key, true);
  }

  private decodeVector(value: Uint8Array | ArrayBuffer | null | undefined): Float32Array {
    if (!value) return new Float32Array();
    if (value instanceof Uint8Array) {
      return new Float32Array(
        value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
      );
    }
    return new Float32Array(value);
  }

  private getIndexKey(shard: ShardInfo, kind: VectorKind): string {
    return `${shard.scope}_${shard.scopeHash}_${shard.shardIndex}_${kind}`;
  }

  // 懒加载 hnswlib-wasm。该包为 Emscripten web 构建，模块顶层检查
  // typeof window === 'object'；Node 下临时注入 window，加载完成后还原。
  private async loadHnswlib(): Promise<HnswlibModule> {
    if (this.hnswlibPromise) {
      return this.hnswlibPromise;
    }
    const prevWindow = (globalThis as any).window;
    if (prevWindow === undefined) {
      (globalThis as any).window = globalThis;
    }
    try {
      this.hnswlibPromise = (async () => {
        const mod = (await import("hnswlib-wasm/dist/hnswlib.js")) as unknown as {
          loadHnswlib: () => Promise<HnswlibModule>;
        };
        return mod.loadHnswlib();
      })();
      await this.hnswlibPromise;
      return this.hnswlibPromise;
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as any).window;
      }
    }
  }
}
