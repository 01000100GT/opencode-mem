// 导入SQLite数据库初始化函数，用于获取数据库实例
import { getDatabase } from "./sqlite-bootstrap.js";
// 从Node.js路径模块导入路径拼接和文件名提取工具函数
import { join, basename } from "node:path";
// 从Node.js文件系统模块导入文件存在性检查和文件删除同步方法
import { existsSync, unlinkSync } from "node:fs";
// 导入全局配置对象，包含存储路径、嵌入维度等核心配置参数
import { CONFIG } from "../../config.js";
// 导入数据库连接管理器，负责维护所有SQLite连接的生命周期
import { connectionManager } from "./connection-manager.js";
// 导入日志工具函数，用于记录系统运行状态和错误信息
import { log } from "../logger.js";
// 导入向量搜索模块，提供向量索引创建、删除和查询能力
import { vectorSearch } from "./vector-search.js";
// 导入分片信息类型定义，描述分片的核心属性结构
import type { ShardInfo } from "./types.js";

// 初始化SQLite数据库类实例，创建数据库操作的基础对象
const Database = getDatabase();
// 提取数据库类的实例类型，用于后续类型标注保证类型安全
type DatabaseType = typeof Database.prototype;

// 定义元数据数据库的文件名，存储所有分片的核心元数据信息
const METADATA_DB_NAME = "metadata.db";

// 导出分片管理器类，负责所有数据库分片的生命周期管理与元数据维护
export class ShardManager {
  // 元数据数据库实例，存储所有分片的核心配置与状态信息
  private metadataDb: DatabaseType;
  // 元数据数据库文件的完整存储路径
  private metadataPath: string;

  // 构造函数：初始化分片管理器，创建元数据数据库连接并完成基础表结构初始化
  constructor() {
    // 拼接元数据数据库的完整存储路径，基于全局配置的根存储目录
    this.metadataPath = join(CONFIG.storagePath, METADATA_DB_NAME);
    // 从连接管理器获取元数据数据库的专属连接实例
    this.metadataDb = connectionManager.getConnection(this.metadataPath);
    // 初始化元数据数据库的表结构与索引，确保系统运行所需的存储框架就绪
    this.initMetadataDb();
  }

  private initMetadataDb(): void {
    this.metadataDb.run(`
      CREATE TABLE IF NOT EXISTS shards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        scope_hash TEXT NOT NULL,
        shard_index INTEGER NOT NULL,
        db_path TEXT NOT NULL,
        vector_count INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE(scope, scope_hash, shard_index)
      )
    `);

    this.metadataDb.run(`
      CREATE INDEX IF NOT EXISTS idx_active_shards 
      ON shards(scope, scope_hash, is_active)
    `);
  }

  // 根据分片所属域、哈希标识和索引编号，生成分片数据库文件的完整存储路径
  private getShardPath(scope: "user" | "project", scopeHash: string, shardIndex: number): string {
    // 拼接域分类目录的基础路径，将单数形式的scope转为复数目录名（如users/projects）
    const dir = join(CONFIG.storagePath, `${scope}s`);
    // 组合生成完整的分片数据库文件名，包含域类型、哈希标识和分片序号，确保唯一性
    return join(dir, `${scope}_${scopeHash}_shard_${shardIndex}.db`);
  }

  // 解析元数据中存储的相对路径，转换为系统可直接访问的绝对路径
  private resolveStoredPath(storedPath: string, scope: string): string {
    // 从存储的相对路径中提取纯文件名，剥离原有的路径前缀
    const fileName = basename(storedPath);
    // 根据当前域类型重新拼接绝对路径，兼容跨环境迁移后的路径适配
    return join(CONFIG.storagePath, `${scope}s`, fileName);
  }

  getActiveShard(scope: "user" | "project", scopeHash: string): ShardInfo | null {
    const stmt = this.metadataDb.prepare(`
      SELECT * FROM shards 
      WHERE scope = ? AND scope_hash = ? AND is_active = 1
      ORDER BY shard_index DESC LIMIT 1
    `);

    const row = stmt.get(scope, scopeHash) as any;
    if (!row) return null;

    return {
      id: row.id,
      scope: row.scope,
      scopeHash: row.scope_hash,
      shardIndex: row.shard_index,
      dbPath: this.resolveStoredPath(row.db_path, row.scope),
      vectorCount: row.vector_count,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
    };
  }

  getAllShards(scope: "user" | "project", scopeHash: string): ShardInfo[] {
    let stmt;
    let rows;

    if (scopeHash === "") {
      stmt = this.metadataDb.prepare(`
        SELECT * FROM shards 
        WHERE scope = ?
        ORDER BY shard_index ASC
      `);
      rows = stmt.all(scope) as any[];
    } else {
      stmt = this.metadataDb.prepare(`
        SELECT * FROM shards 
        WHERE scope = ? AND scope_hash = ?
        ORDER BY shard_index ASC
      `);
      rows = stmt.all(scope, scopeHash) as any[];
    }

    // 遍历数据库查询返回的所有行，将原始数据库记录转换为标准的ShardInfo类型对象
    return rows.map((row: any) => ({
      // 分片唯一标识符，直接从数据库记录的id字段取值
      id: row.id,
      // 分片所属的域类型，与数据库中scope字段保持一致
      scope: row.scope,
      // 域的哈希标识，映射数据库中存储的scope_hash字段值
      scopeHash: row.scope_hash,
      // 分片在当前域下的编号，对应数据库中的shard_index字段
      shardIndex: row.shard_index,
      // 分片数据库文件的完整绝对路径，调用路径解析方法转换存储的相对路径
      dbPath: this.resolveStoredPath(row.db_path, row.scope),
      // 分片中当前存储的向量总数，取数据库中vector_count字段的数值
      vectorCount: row.vector_count,
      // 分片是否为活跃可写状态，将数据库的整数标识(1/0)转换为布尔值
      isActive: row.is_active === 1,
      // 分片创建的时间戳，直接读取数据库中created_at字段的毫秒级时间戳
      createdAt: row.created_at,
    }));
  }

  createShard(scope: "user" | "project", scopeHash: string, shardIndex: number): ShardInfo {
    const fullPath = this.getShardPath(scope, scopeHash, shardIndex);
    const storedPath = join(`${scope}s`, basename(fullPath)).replace(/\\/g, "/");
    const now = Date.now();

    const stmt = this.metadataDb.prepare(`
      INSERT INTO shards (scope, scope_hash, shard_index, db_path, vector_count, is_active, created_at)
      VALUES (?, ?, ?, ?, 0, 1, ?)
    `);

    const result = stmt.run(scope, scopeHash, shardIndex, storedPath, now);

    const db = connectionManager.getConnection(fullPath);
    this.initShardDb(db);

    return {
      id: Number(result.lastInsertRowid),
      scope,
      scopeHash,
      shardIndex,
      dbPath: fullPath,
      vectorCount: 0,
      isActive: true,
      createdAt: now,
    };
  }

  private initShardDb(db: DatabaseType): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS shard_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    db.run(`
      INSERT OR REPLACE INTO shard_metadata (key, value) 
      VALUES ('embedding_dimensions', '${CONFIG.embeddingDimensions}')
    `);

    db.run(`
      INSERT OR REPLACE INTO shard_metadata (key, value) 
      VALUES ('embedding_model', '${CONFIG.embeddingModel}')
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        vector BLOB NOT NULL,
        tags_vector BLOB,
        container_tag TEXT NOT NULL,
        tags TEXT,
        type TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT,
        display_name TEXT,
        user_name TEXT,
        user_email TEXT,
        project_path TEXT,
        project_name TEXT,
        git_repo_url TEXT,
        is_pinned INTEGER DEFAULT 0
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_container_tag ON memories(container_tag)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_type ON memories(type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_created_at ON memories(created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_is_pinned ON memories(is_pinned)`);
  }

  private isShardValid(shard: ShardInfo): boolean {
    if (!existsSync(shard.dbPath)) {
      log("Shard DB file missing", { dbPath: shard.dbPath, shardId: shard.id });
      return false;
    }

    try {
      // 从连接管理器获取当前分片数据库的连接实例
      const db = connectionManager.getConnection(shard.dbPath);
      // 执行SQL查询，检查系统核心表memories是否存在于SQLite主元数据表中
      const result = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`)
        .get() as any;
      // 如果查询结果为空，说明memories表缺失，分片数据库结构不完整
      if (!result) {
        // 记录分片数据库缺少核心表的错误日志，包含数据库路径和分片ID便于排查
        log("Shard DB missing 'memories' table", {
          dbPath: shard.dbPath,
          shardId: shard.id,
        });
        // 分片验证不通过，返回false
        return false;
      }
      // 所有检查项均通过，分片数据库有效，返回true
      return true;
    } catch (error) {
      // 捕获分片验证过程中抛出的所有异常，记录错误上下文
      log("Error validating shard DB", {
        dbPath: shard.dbPath,
        error: String(error),
      });
      // 验证过程出现异常，分片无效，返回false
      return false;
    }
  }

  // 确保分片数据库包含所有必需的表结构，实现数据库 schema 的幂等性保障
  private ensureShardTables(shard: ShardInfo): void {
    // 捕获数据库操作过程中可能抛出的所有异常，避免因单个分片初始化失败阻塞核心流程
    try {
      // 从连接管理器获取当前分片数据库的连接实例，复用已有的连接池资源
      const db = connectionManager.getConnection(shard.dbPath);
      // 调用分片数据库初始化方法，若表结构已存在则自动跳过创建，保证操作的幂等性
      this.initShardDb(db);
    } catch (error) {
      // 记录分片表结构初始化失败的错误日志，包含数据库路径与具体异常信息便于问题排查
      log("Error ensuring shard tables", {
        dbPath: shard.dbPath,
        error: String(error),
      });
    }
  }

  // 获取可写入的活跃分片，负责分配当前需要写入的目标分片实例
  getWriteShard(scope: "user" | "project", scopeHash: string): ShardInfo {
    // 首先尝试获取当前域下标记为活跃的最新分片
    let shard = this.getActiveShard(scope, scopeHash);

    // 若不存在任何活跃分片，创建第一个分片（索引从0开始）
    if (!shard) {
      return this.createShard(scope, scopeHash, 0);
    }

    // 校验当前活跃分片的完整性，若分片数据库损坏或缺失则进入重建流程
    if (!this.isShardValid(shard)) {
      // 记录无效分片的上下文日志，便于后续问题排查与审计
      log("Active shard is invalid, recreating", {
        scope,
        scopeHash,
        shardIndex: shard.shardIndex,
        dbPath: shard.dbPath,
      });

      // 关闭连接管理器中该分片的数据库连接，释放资源避免句柄泄漏
      connectionManager.closeConnection(shard.dbPath);

      // 预处理元数据删除SQL语句，从元数据表中清除无效分片的记录
      const deleteStmt = this.metadataDb.prepare(`DELETE FROM shards WHERE id = ?`);
      // 执行删除操作，永久移除该无效分片的元数据
      deleteStmt.run(shard.id);

      // 在原分片的索引位置创建新的分片，复用索引避免序号空洞
      return this.createShard(scope, scopeHash, shard.shardIndex);
    }

    // 检查当前分片的向量数量是否达到单分片最大容量阈值
    if (shard.vectorCount >= CONFIG.maxVectorsPerShard) {
      // 将当前分片标记为只读状态，禁止后续写入操作
      this.markShardReadOnly(shard.id);
      // 创建索引序号+1的新分片作为后续写入的目标分片
      return this.createShard(scope, scopeHash, shard.shardIndex + 1);
    }

    // 所有校验通过，返回当前可用的活跃分片作为写入目标
    return shard;
  }

  private markShardReadOnly(shardId: number): void {
    const stmt = this.metadataDb.prepare(`
      UPDATE shards SET is_active = 0 WHERE id = ?
    `);
    stmt.run(shardId);
  }

  incrementVectorCount(shardId: number): void {
    const stmt = this.metadataDb.prepare(`
      UPDATE shards SET vector_count = vector_count + 1 WHERE id = ?
    `);
    stmt.run(shardId);
  }

  decrementVectorCount(shardId: number): void {
    const stmt = this.metadataDb.prepare(`
      UPDATE shards SET vector_count = vector_count - 1 WHERE id = ? AND vector_count > 0
    `);
    stmt.run(shardId);
  }

  // 根据数据库文件路径查询对应的分片信息，返回标准化的分片对象或空值
  getShardByPath(dbPath: string): ShardInfo | null {
    // 从完整路径中提取数据库文件名，用于匹配元数据中的存储记录
    const fileName = basename(dbPath);
    // 预处理SQL查询语句，通过文件名模糊匹配元数据表中的分片记录
    const stmt = this.metadataDb.prepare(`SELECT * FROM shards WHERE db_path LIKE '%' || ?`);
    // 执行参数化查询，获取匹配的第一条数据库记录
    const row = stmt.get(fileName) as any;
    // 未查询到匹配记录时直接返回空值
    if (!row) return null;

    // 将原始数据库记录转换为统一格式的ShardInfo对象返回
    return {
      // 分片的唯一主键ID，直接从数据库记录中读取
      id: row.id,
      // 分片所属的域类型，与数据库存储的scope字段保持一致
      scope: row.scope,
      // 域的哈希标识，映射数据库中的scope_hash字段值
      scopeHash: row.scope_hash,
      // 分片在当前域下的索引编号，对应数据库的shard_index字段
      shardIndex: row.shard_index,
      // 分片数据库的完整绝对路径，调用路径解析方法转换存储的相对路径
      dbPath: this.resolveStoredPath(row.db_path, row.scope),
      // 分片中当前存储的向量总数，读取数据库的vector_count字段
      vectorCount: row.vector_count,
      // 分片是否为活跃可写状态，将数据库的整数标识转换为布尔值
      isActive: row.is_active === 1,
      // 分片创建的时间戳，直接读取数据库中存储的毫秒级时间戳
      createdAt: row.created_at,
    };
  }

  // 异步删除指定ID的分片，完整清理关联的向量索引、数据库连接、物理文件及元数据
  async deleteShard(shardId: number): Promise<void> {
    // 预处理查询SQL语句，根据分片ID从元数据表中检索完整的分片记录
    const stmt = this.metadataDb.prepare(`SELECT * FROM shards WHERE id = ?`);
    // 执行参数化查询，获取指定分片ID的原始数据库记录，暂存为any类型兼容动态字段
    const row = stmt.get(shardId) as any;

    // 仅当查询到有效分片记录时执行删除流程，避免空指针异常
    if (row) {
      // 将元数据中存储的相对路径解析为系统可直接访问的绝对路径，用于后续文件操作
      const fullPath = this.resolveStoredPath(row.db_path, row.scope);
      // 异步调用向量搜索模块的分片索引删除方法，清理该分片关联的所有向量索引文件
      await vectorSearch.deleteShardIndexes({
        id: row.id,
        scope: row.scope,
        scopeHash: row.scope_hash,
        shardIndex: row.shard_index,
        dbPath: fullPath,
        vectorCount: row.vector_count,
        isActive: row.is_active === 1,
        createdAt: row.created_at,
      });
      // 从连接管理器中关闭该分片的数据库连接，释放文件句柄与系统资源避免泄漏
      connectionManager.closeConnection(fullPath);

      // 捕获物理文件删除过程中可能抛出的IO异常，确保删除流程的健壮性
      try {
        // 先校验分片数据库文件是否真实存在，避免执行无效的删除操作
        if (existsSync(fullPath)) {
          // 同步删除本地存储的分片数据库物理文件，彻底清除分片的持久化存储
          unlinkSync(fullPath);
        }
      } catch (error) {
        // 记录分片文件删除失败的错误日志，附带数据库路径与具体异常信息便于排查
        log("Error deleting shard file", {
          dbPath: fullPath,
          error: String(error),
        });
      }

      // 预处理元数据删除SQL语句，从元数据表中移除该分片的所有配置记录
      const deleteStmt = this.metadataDb.prepare(`DELETE FROM shards WHERE id = ?`);
      // 执行元数据删除操作，完成分片全生命周期的最后一步清理
      deleteStmt.run(shardId);
    }
  }
}

export const shardManager = new ShardManager();
