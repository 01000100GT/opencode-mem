// 导入SQLite数据库实例创建函数
import { getDatabase } from "./sqlite-bootstrap.js";
// 导入文件系统相关工具函数：检查路径存在、创建目录
import { existsSync, mkdirSync } from "node:fs";
// 导入路径处理工具函数：获取路径的父目录
import { dirname } from "node:path";
// 导入日志记录工具
import { log } from "../logger.js";
// 导入全局配置项
import { CONFIG } from "../../config.js";

// 初始化数据库构造函数，通过getDatabase获取SQLite数据库类
const Database = getDatabase();

// 数据库连接管理器类，负责统一管理所有数据库连接的生命周期
export class ConnectionManager {
  // 存储数据库连接的Map，键为数据库文件路径，值为对应的数据库实例
  private connections: Map<string, typeof Database.prototype> = new Map();

  // 初始化数据库实例的核心配置方法，设置SQLite运行时参数并执行 schema 迁移
  private initDatabase(db: typeof Database.prototype): void {
    // 设置数据库忙时等待超时时间为5秒，避免频繁锁冲突导致的立即报错
    db.run("PRAGMA busy_timeout = 5000");
    // 启用WAL（预写日志）模式，大幅提升读写并发性能与数据库可靠性
    db.run("PRAGMA journal_mode = WAL");
    // 设置同步模式为NORMAL，在数据安全性与写入性能之间取得平衡，支持WAL模式下的最佳实践
    db.run("PRAGMA synchronous = NORMAL");
    // 设置数据库缓存大小为64000页（约64MB，负数单位为KB），优化内存使用提升查询速度
    db.run("PRAGMA cache_size = -64000");
    // 将临时表与临时索引存储在内存中，减少磁盘IO提升临时操作性能
    db.run("PRAGMA temp_store = MEMORY");
    // 开启外键约束检查，保证数据库关联数据的一致性与完整性
    db.run("PRAGMA foreign_keys = ON");

    // 执行数据库schema迁移逻辑，自动升级表结构适配新版本需求
    this.migrateSchema(db);
  }

  // 数据库Schema版本迁移方法，负责执行表结构的升级与兼容性处理
  private migrateSchema(db: typeof Database.prototype): void {
    try {
      // 查询memories表的字段元信息，获取所有列的定义数据
      const columns = db.prepare("PRAGMA table_info(memories)").all() as any[];
      // 检查当前表结构中是否已存在tags字段，避免重复添加
      const hasTags = columns.some((c) => c.name === "tags");

      // 仅当表已存在（columns长度大于0）且tags字段不存在时，执行字段添加操作
      if (!hasTags && columns.length > 0) {
        // 为memories表添加tags文本字段，用于存储标签化的分类信息
        db.run("ALTER TABLE memories ADD COLUMN tags TEXT");
      }
    } catch (error) {
      // 捕获Schema迁移过程中的异常，记录错误日志避免阻塞程序运行
      log("Schema migration error", { error: String(error) });
    }
  }

  // 获取指定数据库路径的连接实例，实现连接的复用与懒初始化
  getConnection(dbPath: string): typeof Database.prototype {
    // 检查连接池中是否已存在该路径的数据库连接，存在则直接返回复用
    if (this.connections.has(dbPath)) {
      return this.connections.get(dbPath)!;
    }

    // 提取数据库文件的父目录路径，用于后续目录创建检查
    const dir = dirname(dbPath);
    // 如果数据库文件所在目录不存在，递归创建完整目录层级
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // 创建新的数据库实例，传入数据库文件路径完成初始化
    const db = new Database(dbPath);
    // 执行数据库核心配置初始化，设置运行时参数与Schema迁移
    this.initDatabase(db);
    // 将新建的数据库连接存入连接池，后续请求可直接复用该连接
    this.connections.set(dbPath, db);

    // 返回初始化完成的数据库连接实例供调用方使用
    return db;
  }

  // 关闭指定数据库路径的连接，执行资源清理与连接池移除
  closeConnection(dbPath: string): void {
    // 从连接池中获取指定路径的数据库实例
    const db = this.connections.get(dbPath);
    // 仅当数据库连接存在时执行关闭流程，避免空指针异常
    if (db) {
      // 执行WAL日志截断检查点，将所有脏页刷入磁盘并清理冗余日志文件
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      // 调用数据库原生关闭方法，释放底层文件句柄与系统资源
      db.close();
      // 从连接池中移除该数据库路径的记录，标记连接已完全回收
      this.connections.delete(dbPath);
    }
  }

  // 关闭所有数据库连接的方法，实现应用退出前的完整资源回收
  closeAll(): void {
    // 遍历连接池中所有的数据库连接，逐个执行关闭流程
    for (const [path, db] of this.connections) {
      try {
        // 执行WAL日志截断检查点，将所有脏页持久化到磁盘并清理冗余日志
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
        // 调用数据库原生关闭方法，释放底层文件句柄与系统资源
        db.close();
      } catch (error) {
        // 捕获单库关闭过程中的异常，记录错误信息避免影响其他连接的回收
        log("Error closing database", { path, error: String(error) });
      }
    }
    // 清空连接池映射，完成所有数据库资源的彻底清理
    this.connections.clear();
  }

  // 对所有数据库执行被动检查点的方法，用于后台定时刷新脏页到磁盘
  checkpointAll(): void {
    // 遍历连接池中所有数据库连接，逐个触发检查点操作
    for (const [path, db] of this.connections) {
      try {
        // 执行PASSIVE模式的WAL检查点，仅尝试刷入脏页但不阻塞数据库读写
        db.run("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (error) {
        // 捕获检查点执行异常，记录错误信息不中断其他数据库的操作
        log("Error checkpointing database", { path, error: String(error) });
      }
    }
  }
}

// 导出ConnectionManager的全局单例实例，供全应用统一调用数据库连接管理能力
export const connectionManager = new ConnectionManager();
