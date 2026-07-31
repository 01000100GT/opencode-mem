// SQLite 绑定引导程序 —— 可同时在 Bun 和 Node 环境下正常工作
/**
 * SQLite binding bootstrap — works under Bun and Node.
 *
 * 解析优先级顺序:
 * Resolution order:
 *   1. Bun 运行环境 → 使用内置的 `bun:sqlite`（原生自带，性能最佳，无需额外安装）
 *   1. Bun runtime → `bun:sqlite` (built-in, fastest, zero-install)
 *   2. Node 运行环境 → 使用内置的 `node:sqlite` 中的 `DatabaseSync`（Node 22.5+ 为实验性支持，Node 24+ 已转为稳定功能）
 *   2. Node runtime → `node:sqlite` `DatabaseSync` (built-in, Node 22.5+ experimental,
 *      stable in Node 24+)
 *   3. 兜底方案 → 使用 `better-sqlite3`（需作为 peer 依赖安装，完整原生二进制实现）
 *   3. Fallback → `better-sqlite3` (peer dependency, full native binary)
 *
 * 该适配层是必要的，因为 opencode 1.15.x 版本在 Node 而非 Bun 环境下加载插件 —— `bun:sqlite` 是仅 Bun 提供的内置模块，Node 的 ESM 加载器会直接拒绝 `bun:` 这种 URL 协议。
 * Required because opencode 1.15.x loads plugins under Node, not Bun — `bun:sqlite`
 * is a Bun-only built-in and Node's ESM loader rejects the `bun:` URL scheme.
 *
 * 环境检测与模块解析仅在首次调用该模块时执行一次，解析完成的 Database 类会被缓存复用。
 * The detection runs once at first call; the resolved Database class is cached.
 */
import { createRequire } from "node:module";

// We don't import types from "bun:sqlite" here because that ambient import
// breaks Node-side type-checking when @types/bun is not installed. Callers
// treat the return value as an opaque sqlite-style Database constructor.
// 不在此处导入bun:sqlite的类型，避免未安装@types/bun时破坏Node环境的类型检查
// 调用方将返回值视为不透明的SQLite风格数据库构造函数使用
type DatabaseCtor = new (filename?: string, options?: unknown) => unknown;
// 定义数据库构造函数类型，接收可选的文件名和配置参数，返回任意类型实例
let Database: DatabaseCtor | undefined;
// 声明缓存的数据库构造函数实例，初始为undefined
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
// 检测当前运行环境是否为Bun，通过全局对象上是否存在Bun属性判断

export function getDatabase(): DatabaseCtor {
  // 导出获取数据库构造函数的方法，单例模式确保仅初始化一次
  if (Database) return Database;
  // 如果已初始化过数据库构造函数，直接返回缓存的实例

  const req = createRequire(import.meta.url);
  // 创建当前模块的require函数，用于兼容ESM环境下加载CommonJS风格的内置模块

  if (isBun) {
    // 如果是Bun运行环境，优先加载Bun内置的bun:sqlite模块
    Database = req("bun:sqlite").Database as DatabaseCtor;
    // 从bun:sqlite中提取Database构造函数，存入缓存变量
    return Database;
    // 返回刚初始化的数据库构造函数
  }

  // Node运行环境下，优先尝试加载Node.js内置的`node:sqlite`模块
  // Node runtime — try built-in `node:sqlite` first. It exposes `DatabaseSync`
  // 该模块提供的`DatabaseSync`类拥有与bun:sqlite一致的同步API集合，包含prepare/all/get/close等核心方法
  // with the synchronous prepare/all/get/close API surface that matches
  // bun:sqlite. One gap: bun:sqlite (and better-sqlite3) expose `db.run(sql)`
  // 但存在一个API差异：bun:sqlite和better-sqlite3都支持`db.run(sql)`的调用方式
  // 用于直接执行无参数绑定的单条SQL语句，该用法在本项目中被广泛用于执行PRAGMA配置和创建索引的场景
  // for executing a single SQL statement without bindings — used throughout
  // this project for PRAGMA and CREATE INDEX setup. `node:sqlite`'s
  // 而Node.js原生的`node:sqlite`模块中，DatabaseSync类使用`db.exec(sql)`来实现完全相同的功能
  // DatabaseSync uses `db.exec(sql)` for that surface, so we subclass to
  // 因此我们需要通过子类继承的方式，将`db.run(sql)`别名映射到`db.exec(sql)`上
  // alias `db.run(sql)` onto `db.exec(sql)` (param-bound `db.run(sql, ...)`
  // 同时保留带参数的`db.run(sql, ...)`调用逻辑，后续调用方如果传入参数，会自动降级为预处理语句执行
  // is preserved for any future callers, falling back to a prepared statement).
  try {
    // 定义Node.js原生sqlite模块的语句同步接口，描述预处理语句的核心方法签名
    interface NodeStatementSync {
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
    }
    // 定义Node.js原生sqlite模块的数据库同步接口，描述数据库连接的核心能力
    interface NodeDatabaseSync {
      exec(sql: string): unknown;
      prepare(sql: string): NodeStatementSync;
      close(): void;
    }
    // 定义NodeDatabaseSync的构造函数类型，用于描述该类的实例化参数结构
    type NodeDatabaseSyncCtor = new (filename?: string, options?: unknown) => NodeDatabaseSync;
    // 从node:sqlite模块中提取DatabaseSync类，通过类型断言确保类型匹配
    const DatabaseSync = (req("node:sqlite") as { DatabaseSync: NodeDatabaseSyncCtor })
      .DatabaseSync;
    // 创建兼容层子类，继承Node原生的DatabaseSync类，统一不同环境下的API行为
    class DatabaseSyncCompat extends DatabaseSync {
      // 实现跨环境兼容的run方法，接收SQL语句和任意数量的绑定参数，返回执行结果
      run(sql: string, ...params: unknown[]): unknown {
        // 当没有传入任何绑定参数时，直接使用原生exec方法执行SQL
        if (params.length === 0) {
          return this.exec(sql);
        }
        // bun:sqlite和better-sqlite3支持传入单个数组作为绑定值
        // 调用形式为`db.run(sql, [a, b])`；但node:sqlite的DatabaseSync会将数组
        // 误识别为命名参数对象，抛出`Unknown named parameter '0'`错误
        // 需要将数组展开为独立参数，才能让位置型`?`占位符正确绑定值
        // 项目中多个模块如services/ai/session/ai-session-manager.ts都使用了这种数组传参形式
        if (params.length === 1 && Array.isArray(params[0])) {
          // 预处理SQL语句，将数组参数展开后传入原生run方法执行
          return this.prepare(sql).run(...(params[0] as unknown[]));
        }
        // 非数组形式的多参数场景，直接预处理SQL并展开参数传入原生run方法
        return this.prepare(sql).run(...params);
      }
      // bun:sqlite和better-sqlite3都提供了`db.transaction(fn)`方法，该方法会返回一个可调用的包装函数
      // 将传入的fn函数包裹在BEGIN/COMMIT事务中，若函数执行过程中抛出异常则自动执行ROLLBACK回滚
      // bun:sqlite and better-sqlite3 expose `db.transaction(fn)` that returns
      // a callable wrapping `fn` in BEGIN/COMMIT (auto-ROLLBACK on throw).
      // 但node:sqlite的DatabaseSync类中没有实现这个等价的事务方法，该方法在本项目中被
      // `api-handlers.handleAddMemory`和`services/client.addMemory`两个核心模块调用
      // 如果缺失该方法，POST /api/memories接口以及所有自动记忆捕获的流程都会直接崩溃
      // `node:sqlite`'s DatabaseSync has no equivalent. Used by
      // `api-handlers.handleAddMemory` and `services/client.addMemory`, so
      // POST /api/memories and any auto-capture path crash without it.
      //
      // 当前仅实现了基础的单事务模式（对应标准的BEGIN语句），better-sqlite3提供的
      // .deferred（延迟事务）、.immediate（立即事务）、.exclusive（排他事务）这三种
      // 高级事务变体，在当前项目的代码中从未被使用过，因此无需做兼容适配
      // Single-mode semantics only (BEGIN); the `.deferred` / `.immediate` /
      // `.exclusive` variants from better-sqlite3 are not exercised by this
      // codebase.
      // 定义泛型transaction方法，接收一个任意参数和返回值的函数fn，返回类型相同的包装函数
      transaction<Fn extends (...args: unknown[]) => unknown>(fn: Fn): Fn {
        // 保存当前数据库实例的引用，避免函数内部this指向混乱
        const self = this;
        // 创建包装函数，保留原函数的this签名和参数类型，确保调用行为一致
        const wrapped = function (this: unknown, ...args: Parameters<Fn>): ReturnType<Fn> {
          // 执行SQL的BEGIN语句，开启数据库事务
          self.exec("BEGIN");
          try {
            // 调用用户传入的业务函数，传递原始上下文和参数，获取执行结果
            const result = fn.apply(this, args) as ReturnType<Fn>;
            // 业务逻辑执行成功，提交事务，将所有修改持久化到数据库
            self.exec("COMMIT");
            // 返回业务函数的执行结果，保证调用方拿到正确的返回值
            return result;
          } catch (err) {
            // 捕获业务逻辑执行过程中抛出的异常，进入事务回滚流程
            try {
              // 执行SQL的ROLLBACK语句，回滚事务内的所有数据库修改
              self.exec("ROLLBACK");
            } catch {
              /* rollback failures after partial state are best-effort */
            }
            // 回滚完成后，重新抛出原异常，让调用方能够感知到执行失败
            throw err;
          }
        };
        // 将包装函数断言为原函数类型，保留类型兼容性，满足TypeScript类型检查
        return wrapped as unknown as Fn;
      }
    }
    // 将兼容层子类的类型通过双重断言转换为统一的DatabaseCtor类型
    // 抹平TypeScript类型系统中不同环境数据库类的类型差异，满足模块对外的类型契约
    Database = DatabaseSyncCompat as unknown as DatabaseCtor;
    // 返回刚完成初始化与类型适配的数据库构造函数实例
    // 该实例后续会被全局缓存，所有调用方都会复用这个已完成API兼容处理的实例
    return Database;
  } catch {
    // node:sqlite isn't available (Node < 22.5, or experimental flag not set
    // in some embedded runtimes). Fall back to better-sqlite3 — wire-compatible
    // API, requires a native postinstall but ships prebuilt binaries for
    // common platforms.
    // 内置node:sqlite模块不可用，进入兜底方案加载better-sqlite3
    // 常见不可用场景包括Node.js版本低于22.5、部分嵌入式运行环境未开启实验性开关
    // better-sqlite3提供与前两者完全兼容的API接口，虽需安装原生依赖但为主流平台预编译了二进制包
    try {
      // 通过require加载better-sqlite3模块，并转换为统一的数据库构造函数类型
      const betterSqlite = req("better-sqlite3") as DatabaseCtor;
      // 将加载完成的构造函数存入全局缓存变量
      Database = betterSqlite;
      // 返回初始化完成的数据库构造函数
      return Database;
    } catch (error) {
      // 兜底方案也加载失败，抛出致命错误提示用户配置环境
      throw new Error(
        "opencode-mem: no SQLite binding available. Install better-sqlite3, " +
          "or run on Node ≥22.5 with `--experimental-sqlite`, or use Bun. " +
          `Underlying error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
