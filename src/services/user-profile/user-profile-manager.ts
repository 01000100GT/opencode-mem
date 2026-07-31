// 导入SQLite数据库实例获取方法
import { getDatabase } from "../sqlite/sqlite-bootstrap.js";
// 导入Node.js路径拼接工具函数
import { join } from "node:path";
// 导入Node.js文件系统同步操作方法：检查文件存在、读取文件、写入文件
import { existsSync, readFileSync, writeFileSync } from "node:fs";
// 导入数据库连接管理器，负责维护数据库连接池与生命周期
import { connectionManager } from "../sqlite/connection-manager.js";
// 导入全局应用配置，包含存储路径、业务阈值等核心配置项
import { CONFIG } from "../../config.js";
// 导入用户模块相关类型定义：用户档案、档案变更记录、档案数据结构
import type { UserProfile, UserProfileChangelog, UserProfileData } from "./types.js";
// 导入工具函数，确保输入值始终被处理为安全数组（避免null/undefined引发的运行时错误）
import { safeArray } from "./profile-utils.js";
// 导入向量嵌入服务，负责将文本转换为用于语义计算的高维向量
import { EmbeddingService } from "../embedding.js";
// 导入统一日志工具，全链路日志标准化输出与采集
import { log } from "../logger.js";
// 导入数学工具函数：计算两个向量的余弦相似度、对向量执行L2归一化
import { cosineSimilarityNumbers, l2Normalize } from "../../utils/math.js";
// 导入大模型服务提供者加载器，负责初始化并加载AI能力基座
import { loadOpencodeProvider } from "../ai/opencode-provider-loader.js";

// 质心指数移动平均(EMA)权重：保留历史质心85%的权重，仅引入15%的新向量信息
const CENTROID_EMA_WEIGHT = 0.85;
// EMA权重的补数：新向量的权重占比，与CENTROID_EMA_WEIGHT之和恒为1
const CENTROID_EMA_WEIGHT_COMPLEMENT = 0.15;
// 三向量融合权重1：原第一个历史质心的权重占比，控制历史信息的保留程度
const THREE_WAY_CENTROID_W1 = 0.45;
// 三向量融合权重2：原第二个历史质心的权重占比，与第一个历史质心权重保持一致
const THREE_WAY_CENTROID_W2 = 0.45;
// 三向量融合权重3：新输入向量的权重占比，仅引入少量新信息避免质心剧烈漂移
const THREE_WAY_CENTROID_W3 = 0.1;
// 汤普森采样先验分布的alpha参数：控制正样本的初始置信度，取值0.5符合弱先验假设
const THOMPSON_PRIOR_ALPHA = 0.5;
// 汤普森采样先验分布的beta参数：控制负样本的初始置信度，取值1.5使初始采样偏向保守
const THOMPSON_PRIOR_BETA = 1.5;
// 先验分布恢复速率：长期运行中从数据驱动的后验分布逐渐回归到初始先验的速率
const THOMPSON_PRIOR_RECOVERY_RATE = 0.8;
// 方向验证容差：质心更新方向与锚点向量的余弦相似度最低阈值，低于该值则判定为异常更新
const DIRECTION_VALIDATION_TOLERANCE = 0.03;

/**
 * Gamma sampler (Marsaglia-Tsang 2000).
 * Used by sampleBeta for Thompson Sampling weak-hit upgrades.
 */
// 伽马分布采样函数（基于Marsaglia-Tsang 2000算法实现）
// 供贝塔分布采样函数sampleBeta调用，用于汤普森采样中低频次特征的置信度更新逻辑
function sampleGamma(shape: number): number {
  // 处理形状参数小于1的情况，通过递归转换为形状参数>=1的场景
  if (shape < 1) {
    // 生成[0,1)区间的均匀随机数
    const u = Math.random();
    // 利用形状参数+1的采样结果，缩放得到原形状参数的采样值，符合伽马分布的可加性性质
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  // 算法核心参数：原形状参数偏移1/3，是Marsaglia-Tsang算法的关键预处理步骤
  const d = shape - 1 / 3;
  // 计算缩放系数，用于将标准正态分布变量转换为符合要求的尺度
  const c = 1 / Math.sqrt(9 * d);
  // 进入循环采样，直到生成符合 acceptance-rejection 准则的样本
  while (true) {
    let x: number, v: number;
    // 持续生成符合条件的辅助变量v，确保v始终大于0
    do {
      // 生成标准正态分布的随机数x
      x = randn();
      // 计算基础变换后的v值，确保其为正
      v = 1 + c * x;
    } while (v <= 0);
    // 对v执行三次方运算，完成算法中的尺度变换
    v = v * v * v;
    // 生成第二个均匀随机数，用于接受-拒绝检验
    const u = Math.random();
    // 第一重检验：快速截断检验，满足条件则直接返回采样结果，提高采样效率
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    // 第二重检验：对数空间的严格接受准则，若满足则返回采样结果，确保分布准确性
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

// 生成服从标准正态分布的随机数（Box-Muller变换实现）
// 核心原理：将[0,1)区间的均匀分布映射为标准正态分布，是统计学中经典的正态抽样算法
function randn(): number {
  // 初始化两个均匀分布随机变量，初始值设为0以触发后续的非零校验
  let u = 0,
    v = 0;
  // 循环生成u，确保u严格大于0，避免对数运算时出现定义域错误（ln(0)无意义）
  while (u === 0) u = Math.random();
  // 循环生成v，确保v严格大于0，保证极坐标变换的角度参数有效
  while (v === 0) v = Math.random();
  // 应用Box-Muller变换公式，生成符合N(0,1)的标准正态分布随机数
  // 分解计算逻辑：第一部分的sqrt(-2lnu)生成瑞利分布的模长，第二部分cos(2πv)生成均匀分布的角度
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// 生成服从Beta(α,β)分布的随机数
// 基于贝塔分布与伽马分布的关系推导：若X~Gamma(α,1), Y~Gamma(β,1)，则X/(X+Y)~Beta(α,β)
// 该实现为汤普森采样的核心随机数生成器，用于为多臂老虎机问题生成置信度抽样值
function sampleBeta(alpha: number, beta: number): number {
  // 生成第一个服从Gamma(α,1)分布的随机变量x
  const x = sampleGamma(alpha);
  // 生成第二个服从Gamma(β,1)分布的随机变量y
  const y = sampleGamma(beta);
  // 根据贝塔分布的构造定理，计算两个伽马变量的归一化比值，得到Beta分布抽样结果
  return x / (x + y);
}

/**
 * Language-agnostic text normalization for embedding comparison.
 * Strips punctuation and collapses whitespace — the embedding model
 * handles semantic similarity naturally without word-level rules.
 */
// 面向所有语言通用的文本归一化函数，专为向量嵌入比较场景设计
// 核心思路是剥离标点符号并合并冗余空白，后续的向量嵌入模型会天然处理语义相似度，无需额外的词级规则干预
function normalizeDescription(text: string): string {
  // 接收原始输入文本字符串，返回标准化处理后的文本字符串
  return (
    text
      // 第一步：先移除文本首尾的所有空白字符，处理边缘的冗余空格
      .trim()
      // 第二步：匹配所有中英文标点和换行回车符，统一替换为单个空格，消除标点干扰
      .replace(/[，,。！？；;：:、\n\r.]/g, " ")
      // 第三步：将文本中连续出现的多个空格，合并为单个空格，统一空白格式
      .replace(/\s+/g, " ")
      // 第四步：再次修剪首尾空白，处理替换过程中可能产生的新的边缘空格，输出干净文本
      .trim()
  );
}

// 从数据库工厂获取SQLite数据库实例，建立底层数据库操作能力
const Database = getDatabase();
// 提取数据库实例的原型类型，用于生成类型安全的数据库连接类型定义
type DatabaseType = typeof Database.prototype;
// 定义用户画像模块的SQLite数据库文件名，统一存储路径标识
const USER_PROFILES_DB_NAME = "user-profiles.db";

// 用户画像管理器类，负责全生命周期管理用户画像数据的存储、更新、合并与维护
export class UserProfileManager {
  // SQLite数据库实例，使用断言赋值确保后续访问安全性，实际在构造函数中完成初始化
  private db!: DatabaseType;
  // 数据库文件的完整存储路径，由配置的根路径与数据库文件名拼接生成
  private readonly dbPath: string;
  // 冷启动缓冲池，存储数据库就绪前暂存的三类画像数据：偏好、行为模式、工作流
  private coldBuffer: { preferences: any[]; patterns: any[]; workflows: any[] };
  // 冷启动缓冲池的磁盘持久化路径，当数据库无法加载时将缓冲写入本地文件避免数据丢失
  private coldBufferPath: string;
  // 去重检查缓存，存储已完成重复校验的条目唯一标识，避免重复执行耗时的相似度计算
  private dedupCheckedCache: Set<string> = new Set();

  // 类构造函数：初始化所有路径、加载持久化缓冲、尝试建立数据库连接并初始化表结构
  constructor() {
    // 拼接用户画像数据库的完整磁盘路径，兼容配置中storagePath为空的边界场景
    this.dbPath = join(CONFIG.storagePath || "", USER_PROFILES_DB_NAME);
    // 拼接冷启动缓冲文件的完整磁盘路径，统一存储在应用配置的根存储目录下
    this.coldBufferPath = join(CONFIG.storagePath || "", "cold-buffer.json");
    // 从磁盘加载持久化的冷启动缓冲数据，恢复进程退出前未写入数据库的画像数据
    this.coldBuffer = this.loadColdBuffer();
    try {
      // 通过连接管理器获取当前数据库路径的专属连接，复用连接池中的已有连接
      this.db = connectionManager.getConnection(this.dbPath);
      // 执行数据库初始化逻辑，创建所需的表结构与索引，确保 schema 符合预期
      this.initDatabase();
    } catch (e) {
      // 捕获数据库初始化异常，记录错误日志并延迟后续操作，等待下一次时机重试
      log("user-profile-manager: db init failed, deferring", { error: String(e) });
    }
  }

  // 冷启动缓冲加载方法：从磁盘持久化文件中恢复未入库的画像增量数据，返回包含三类画像数据的缓冲对象
  private loadColdBuffer(): { preferences: any[]; patterns: any[]; workflows: any[] } {
    // 启动异常捕获块，处理文件读取、解析过程中可能出现的所有错误
    try {
      // 检查冷启动缓冲文件在磁盘上是否真实存在，避免不存在文件的读取异常
      if (existsSync(this.coldBufferPath)) {
        // 以UTF-8编码格式读取冷启动缓冲文件的原始文本内容
        const raw = readFileSync(this.coldBufferPath, "utf-8");
        // 将读取到的JSON格式字符串解析为内存中的JavaScript对象
        const data = JSON.parse(raw);
        // 仅当缓冲中存在任何有效画像数据时才打印加载日志，避免空缓冲的无意义日志输出
        if (data.preferences?.length || data.patterns?.length || data.workflows?.length) {
          // 输出缓冲加载成功日志，同时记录三类数据的加载数量，便于排查数据堆积问题
          log("profile cold buffer: loaded from disk", {
            prefs: data.preferences?.length || 0,
            pats: data.patterns?.length || 0,
            wfs: data.workflows?.length || 0,
          });
        }
        // 返回类型安全的缓冲对象，对每类数据都做数组类型校验，非法数据则替换为空数组
        return {
          preferences: Array.isArray(data.preferences) ? data.preferences : [],
          patterns: Array.isArray(data.patterns) ? data.patterns : [],
          workflows: Array.isArray(data.workflows) ? data.workflows : [],
        };
      }
    } catch {
      // 文件损坏或不存在，返回空缓冲
    }
    // 所有异常分支或文件不存在的场景，最终都返回空的缓冲对象，保证程序的健壮性
    return { preferences: [], patterns: [], workflows: [] };
  }

  // 持久化冷启动缓冲数据到磁盘的私有方法，无返回值
  private saveColdBuffer(): void {
    // 启动异常捕获块，处理文件写入过程中可能出现的所有IO错误
    try {
      // 将内存中的冷启动缓冲对象序列化为JSON字符串，以UTF-8编码写入指定磁盘路径
      writeFileSync(this.coldBufferPath, JSON.stringify(this.coldBuffer), "utf-8");
    } catch {
      // 磁盘满或无权限时静默失败
    }
  }

  // 初始化数据库表结构的私有方法，无返回值
  // 该方法负责创建必要的数据库表，确保数据存储的结构符合预期
  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        user_name TEXT NOT NULL,
        user_email TEXT NOT NULL,
        profile_data TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_analyzed_at INTEGER NOT NULL,
        total_prompts_analyzed INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT 1
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_profile_changelogs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        change_type TEXT NOT NULL,
        change_summary TEXT NOT NULL,
        profile_data_snapshot TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_profiles_is_active ON user_profiles(is_active)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_profile_changelogs_profile_id ON user_profile_changelogs(profile_id)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_user_profile_changelogs_version ON user_profile_changelogs(version DESC)"
    );
  }

  // 获取指定用户的活跃用户画像方法
  // 接收参数：userId - 目标用户的唯一标识字符串
  // 返回值：转换完成的标准UserProfile类型对象，若未找到匹配记录则返回null
  getActiveProfile(userId: string): UserProfile | null {
    // 预处理SQL查询语句，编译为可执行的预处理语句，避免SQL注入风险并提升执行效率
    const stmt = this.db.prepare(`
      SELECT * FROM user_profiles 
      WHERE user_id = ? AND is_active = 1
      LIMIT 1
    `);

    // 传入用户ID参数执行查询，获取匹配的第一条数据库行记录，类型断言为any以绕过临时类型检查
    const row = stmt.get(userId) as any;
    // 若查询结果为空（无匹配的活跃画像），直接返回null终止流程
    if (!row) return null;

    // 将数据库原始行数据转换为业务层统一的UserProfile标准结构并返回
    return this.rowToProfile(row);
  }

  // 创建用户画像的核心方法，完成新用户画像的初始化与持久化入库
  // 接收参数包含用户唯一标识、基本展示信息、画像结构化数据与已分析的提示词数量
  // 返回新创建的画像唯一ID字符串，用于后续的画像查询与更新操作
  createProfile(
    userId: string,
    displayName: string,
    userName: string,
    userEmail: string,
    profileData: UserProfileData,
    promptsAnalyzed: number
  ): string {
    // 生成全局唯一的画像ID：时间戳（毫秒级）+ 5位随机base36字符串，保证分布式场景下的唯一性
    const id = `profile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    // 捕获当前时间戳，统一作为画像创建时间与最后分析时间的基准值
    const now = Date.now();

    // 对输入的原始画像数据进行清洗标准化，确保所有字段都是合法的非空数组
    // 调用safeArray工具函数处理可能存在的null/undefined输入，避免后续逻辑出现运行时异常
    const cleanedData: UserProfileData = {
      // 清洗偏好数据：将输入转换为安全数组，保留所有合法的偏好条目
      preferences: safeArray(profileData.preferences),
      // 清洗行为模式数据：将输入转换为安全数组，过滤无效的模式条目
      patterns: safeArray(profileData.patterns),
      // 清洗工作流数据：将输入转换为安全数组，确保工作流列表的结构完整性
      workflows: safeArray(profileData.workflows),
    };

    const stmt = this.db.prepare(`
      INSERT INTO user_profiles (
        id, user_id, display_name, user_name, user_email, 
        profile_data, version, created_at, last_analyzed_at, 
        total_prompts_analyzed, is_active
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)
    `);

    stmt.run(
      id,
      userId,
      displayName,
      userName,
      userEmail,
      JSON.stringify(cleanedData),
      now,
      now,
      promptsAnalyzed
    );

    this.addChangelog(id, 1, "create", "Initial profile creation", cleanedData);

    return id;
  }

  updateProfile(
    profileId: string,
    profileData: UserProfileData,
    additionalPromptsAnalyzed: number,
    changeSummary: string
  ): boolean {
    const now = Date.now();

    const cleanedData: UserProfileData = {
      preferences: safeArray(profileData.preferences),
      patterns: safeArray(profileData.patterns),
      workflows: safeArray(profileData.workflows),
    };

    const getVersionStmt = this.db.prepare(`SELECT version FROM user_profiles WHERE id = ?`);
    const versionRow = getVersionStmt.get(profileId) as any;
    const currentVersion = versionRow?.version || 0;
    const newVersion = currentVersion + 1;

    const updateStmt = this.db.prepare(`
      UPDATE user_profiles 
      SET profile_data = ?, 
          version = ?, 
          last_analyzed_at = ?, 
          total_prompts_analyzed = total_prompts_analyzed + ?
      WHERE id = ? AND version = ?
    `);

    const result = updateStmt.run(
      JSON.stringify(cleanedData),
      newVersion,
      now,
      additionalPromptsAnalyzed,
      profileId,
      currentVersion
    );

    if (result.changes === 0) {
      return false;
    }

    this.addChangelog(profileId, newVersion, "update", changeSummary, cleanedData);

    this.cleanupOldChangelogs(profileId);

    return true;
  }

  private addChangelog(
    profileId: string,
    version: number,
    changeType: string,
    changeSummary: string,
    profileData: UserProfileData
  ): void {
    const id = `changelog_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO user_profile_changelogs (
        id, profile_id, version, change_type, change_summary, 
        profile_data_snapshot, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, profileId, version, changeType, changeSummary, JSON.stringify(profileData), now);
  }

  private cleanupOldChangelogs(profileId: string): void {
    const retentionCount = CONFIG.userProfileChangelogRetentionCount;

    const stmt = this.db.prepare(`
      DELETE FROM user_profile_changelogs 
      WHERE profile_id = ? 
      AND id NOT IN (
        SELECT id FROM user_profile_changelogs 
        WHERE profile_id = ? 
        ORDER BY version DESC 
        LIMIT ?
      )
    `);

    stmt.run(profileId, profileId, retentionCount);
  }

  getProfileChangelogs(profileId: string, limit: number = 10): UserProfileChangelog[] {
    const stmt = this.db.prepare(`
      SELECT * FROM user_profile_changelogs 
      WHERE profile_id = ? 
      ORDER BY version DESC 
      LIMIT ?
    `);

    const rows = stmt.all(profileId, limit) as any[];
    return rows.map((row) => this.rowToChangelog(row));
  }

  // 根据变更日志唯一ID查询单条变更记录的方法
  // 接收参数：id - 目标变更日志的唯一标识字符串
  // 返回值：转换完成的标准UserProfileChangelog类型对象，若未找到匹配记录则返回undefined
  getChangelogById(id: string): UserProfileChangelog | undefined {
    // 预处理SQL查询语句，编译为可执行的预处理语句，避免SQL注入风险并提升执行效率
    const stmt = this.db.prepare(`SELECT * FROM user_profile_changelogs WHERE id = ?`);
    // 传入变更日志ID参数执行查询，获取匹配的数据库行记录，类型断言为any以绕过临时类型检查
    const row = stmt.get(id) as any;
    // 若查询结果为空（无匹配的变更日志），直接返回undefined终止流程
    if (!row) return undefined;
    // 将数据库原始行数据转换为业务层统一的UserProfileChangelog标准结构并返回
    return this.rowToChangelog(row);
  }

  // 内存中用户画像数据衰减处理方法，对过期低置信度条目执行清理
  // 接收参数：data - 待处理的原始用户画像结构化数据
  // 返回值：包含处理后的画像数据与是否发生变更的标记对象
  decayInMemory(data: UserProfileData): { data: UserProfileData; hasChanges: boolean } {
    // 获取当前时间戳，作为所有条目老化计算的基准时间
    const now = Date.now();

    // 对偏好数据执行衰减处理，返回处理后的偏好列表与变更标记
    const prefResult = this.decayItems(data.preferences, now);
    // 对行为模式数据执行衰减处理，返回处理后的模式列表与变更标记
    const patResult = this.decayItems(data.patterns, now);
    // 对工作流数据执行衰减处理，返回处理后的工作流列表与变更标记
    const wfResult = this.decayItems(data.workflows, now);

    // 封装处理结果返回，合并所有类别的数据变更与全局变更标记
    return {
      data: {
        ...data,
        preferences: prefResult.items,
        patterns: patResult.items,
        workflows: wfResult.items,
      },
      // 只要任意一类数据发生变更，全局hasChanges即标记为true
      hasChanges: prefResult.hasChanges || patResult.hasChanges || wfResult.hasChanges,
    };
  }

  /**
   * 通用画像条目衰减处理器：负责对用户画像中的各类条目执行老化清理与置信度同步
   * 泛型T约束条目必须为可扩展的键值对结构，支持偏好、模式、工作流等所有画像条目类型
   * @param items - 待处理的原始条目数组，包含当前用户的所有同类型画像条目
   * @param now - 当前时间戳（毫秒级），作为所有条目标记时间的计算基准
   * @returns 处理结果对象：返回过滤后的条目数组、变更标记、处理前条目数、移除条目数
   */
  private decayItems<T extends Record<string, any>>(
    items: T[],
    now: number
  ): { items: T[]; hasChanges: boolean; before: number; removed: number } {
    // 记录处理前的条目总数，用于后续计算移除的条目数量
    const before = items.length;
    // 条目变更标记：记录整个处理周期内是否发生了任何数据修改
    let hasChanges = false;

    // 对所有条目执行过滤+更新逻辑，保留符合存活条件的条目
    const filtered = items.filter((item) => {
      // 执行α参数懒迁移：兼容旧版数据结构，为未初始化α/β的旧条目补全参数
      this.lazyMigrateAlpha(item as any);

      // 补全条目的最后活跃时间标记：缺失则默认设置为当前时间，避免首次处理时报错
      if ((item as any).lastSeen === undefined) (item as any).lastSeen = now;
      // 补全条目的证据链数组：缺失则初始化为空数组，确保后续证据追加操作不会失败
      if ((item as any).evidence === undefined) (item as any).evidence = [];

      // 记录同步前的旧置信度，用于后续检测置信度是否发生了变化
      const oldConf = (item as any).confidence;
      // 调用置信度同步方法：基于当前的α/β参数重新计算条目置信度，更新到条目上
      this.syncConfidence(item as any);
      // 若置信度发生变化，标记全局变更状态为true，触发后续的数据库持久化
      if ((item as any).confidence !== oldConf) hasChanges = true;

      // 计算条目从上次活跃到现在的时间差（毫秒），衡量条目存活时长
      const age = now - ((item as any).lastSeen || now);
      // 将时间差转换为以天为单位的数值，简化过期条件的判断逻辑
      const ageDays = age / (24 * 60 * 60 * 1000);
      // 读取条目的正样本计数器α，若缺失则默认值为1，确保老化判断逻辑合法
      const alpha = (item as any).alpha ?? 1;

      // 条目过期清理规则：低置信度条目（α≤2）且超过30天未活跃，执行删除
      if (alpha <= 2 && ageDays > 30) {
        // 打印条目过期清理日志：记录条目标签、α值、存活天数，用于画像健康度分析
        log("profile decay: removed stale", {
          cat: (item as any).category || (item as any).description?.substring(0, 30),
          alpha,
          ageDays: Math.round(ageDays),
        });
        // 标记全局变更状态为true，触发后续的数据库持久化
        hasChanges = true;
        // 返回false将该条目从过滤后的数组中移除，完成过期清理
        return false;
      }

      // 所有条件都不满足，保留当前条目，返回true将其保留在过滤后的数组中
      return true;
    });

    // 封装处理结果返回：过滤后的条目数组、变更标记、处理前总数、移除的条目数量
    return { items: filtered, hasChanges, before, removed: before - filtered.length };
  }

  // 删除指定用户画像的核心方法，永久移除数据库中的画像记录
  // 接收参数：profileId - 目标画像的全局唯一标识字符串
  // 无返回值，执行删除操作后直接完成流程
  deleteProfile(profileId: string): void {
    // 预处理SQL删除语句，编译为安全的预处理语句，防范SQL注入风险
    const stmt = this.db.prepare(`DELETE FROM user_profiles WHERE id = ?`);
    // 传入目标画像ID参数执行删除，完成数据库记录的物理删除
    stmt.run(profileId);
  }

  // 根据画像唯一ID查询单条完整用户画像的方法
  // 接收参数：profileId - 目标画像的全局唯一标识字符串
  // 返回值：转换完成的标准UserProfile类型对象，未找到匹配记录则返回null
  getProfileById(profileId: string): UserProfile | null {
    // 预处理SQL查询语句，编译为可执行的预处理语句，提升执行效率并保障安全性
    const stmt = this.db.prepare(`SELECT * FROM user_profiles WHERE id = ?`);
    // 传入画像ID参数执行查询，获取匹配的数据库行记录，类型断言绕过临时类型检查
    const row = stmt.get(profileId) as any;
    // 若查询结果为空（无匹配的画像记录），直接返回null终止流程
    if (!row) return null;
    // 将数据库原始行数据转换为业务层统一的UserProfile标准结构并返回
    return this.rowToProfile(row);
  }

  // 获取系统中所有活跃用户画像的批量查询方法
  // 无输入参数，自动查询所有标记为is_active=1的有效用户画像
  // 返回值：包含所有活跃画像的标准UserProfile类型数组，无活跃数据则返回空数组
  getAllActiveProfiles(): UserProfile[] {
    // 预处理SQL批量查询语句，筛选所有标记为活跃的用户画像记录
    const stmt = this.db.prepare(`SELECT * FROM user_profiles WHERE is_active = 1`);
    // 执行批量查询获取所有匹配的数据库行记录，转换为任意类型数组处理临时类型约束
    const rows = stmt.all() as any[];
    // 对所有原始行数据执行批量转换，统一映射为业务层的UserProfile标准结构后返回
    return rows.map((row) => this.rowToProfile(row));
  }

  // 将数据库原始行数据转换为业务层的UserProfile标准对象的私有方法
  // 完成数据库下划线命名字段到代码驼峰命名字段的映射，实现数据层与业务层的解耦
  private rowToProfile(row: any): UserProfile {
    // 返回组装完成的标准化用户画像对象，所有字段严格遵循UserProfile类型定义
    return {
      // 画像全局唯一ID：映射数据库主键row.id，保持原ID的全局唯一性
      id: row.id,
      // 用户主体ID：映射数据库user_id字段，关联到系统的核心用户标识
      userId: row.user_id,
      // 用户对外展示名称：映射数据库display_name字段，用于前端页面的昵称展示
      displayName: row.display_name,
      // 系统登录用户名：映射数据库user_name字段，通常为用户的账号登录名
      userName: row.user_name,
      // 用户绑定邮箱：映射数据库user_email字段，用于账户通知与身份验证
      userEmail: row.user_email,
      // 画像结构化数据：映射数据库profile_data字段，存储所有画像的业务核心数据
      profileData: row.profile_data,
      // 画像版本号：映射数据库version字段，用于实现乐观锁与变更追踪
      version: row.version,
      // 画像创建时间戳：映射数据库created_at字段，记录画像首次生成的时间
      createdAt: row.created_at,
      // 最后分析时间戳：映射数据库last_analyzed_at字段，记录画像最后一次更新的时间
      lastAnalyzedAt: row.last_analyzed_at,
      // 累计分析提示词数量：映射数据库total_prompts_analyzed字段，统计画像的数据源规模
      totalPromptsAnalyzed: row.total_prompts_analyzed,
      // 画像活跃状态标记：将数据库的数值型is_active转换为布尔值，1表示活跃、0表示已停用
      isActive: row.is_active === 1,
    };
  }

  // 将数据库原始行数据转换为业务层的UserProfileChangelog标准对象的私有方法
  // 实现变更日志的数据库字段到业务字段的映射，统一变更记录的格式规范
  private rowToChangelog(row: any): UserProfileChangelog {
    // 返回组装完成的标准化画像变更日志对象，所有字段严格遵循UserProfileChangelog类型定义
    return {
      // 变更日志全局唯一ID：映射数据库主键row.id，保持日志记录的唯一性
      id: row.id,
      // 关联的画像ID：映射数据库profile_id字段，建立日志与所属画像的外键关联
      profileId: row.profile_id,
      // 画像版本号：映射数据库version字段，记录该次变更对应的画像版本
      version: row.version,
      // 变更类型标识：映射数据库change_type字段，区分创建、更新、删除等不同操作类型
      changeType: row.change_type,
      // 变更内容摘要：映射数据库change_summary字段，用自然语言描述本次变更的核心内容
      changeSummary: row.change_summary,
      // 画像数据快照：映射数据库profile_data_snapshot字段，存储变更前的完整画像数据备份
      profileDataSnapshot: row.profile_data_snapshot,
      // 变更生成时间戳：映射数据库created_at字段，记录本次变更发生的时间
      createdAt: row.created_at,
    };
  }

  // 异步方法：合并用户画像的增量数据与存量数据
  // 参数1 existing: 当前已存在的完整用户画像结构化数据
  // 参数2 updates: 待合并的增量画像数据，支持部分字段更新
  // 参数3 embedService: 可选的向量嵌入服务实例，用于语义相似度计算
  // 参数4 profileId: 可选的当前操作的画像全局唯一ID，用于日志与后续校验
  async mergeProfileData(
    existing: UserProfileData,
    updates: Partial<UserProfileData>,
    embedService?: EmbeddingService,
    profileId?: string
  ): Promise<UserProfileData> {
    // 初始化合并后的画像数据容器，先将存量数据的三类核心字段转换为安全数组
    // 确保所有字段都为非空数组，避免null/undefined引发的后续运行时错误
    const merged: UserProfileData = {
      // 处理存量偏好数据：调用ensureArray工具函数确保转换为合法数组
      preferences: this.ensureArray(existing?.preferences),
      // 处理存量行为模式数据：调用ensureArray工具函数确保转换为合法数组
      patterns: this.ensureArray(existing?.patterns),
      // 处理存量工作流数据：调用ensureArray工具函数确保转换为合法数组
      workflows: this.ensureArray(existing?.workflows),
    };

    // 检查增量数据中是否包含偏好字段的更新
    if (updates.preferences) {
      // 调用核心条目合并方法mergeItems，合并存量偏好与增量偏好
      // 传入标记"preference"标识当前处理的是偏好类型数据，完成合并后更新merged.preferences
      merged.preferences = await this.mergeItems(
        merged.preferences,
        this.ensureArray(updates.preferences),
        "preference",
        embedService,
        profileId
      );
    }

    // 检查增量数据中是否包含行为模式字段的更新
    if (updates.patterns) {
      // 调用核心条目合并方法mergeItems，合并存量行为模式与增量行为模式
      // 传入标记"pattern"标识当前处理的是行为模式类型数据，完成合并后更新merged.patterns
      merged.patterns = await this.mergeItems(
        merged.patterns,
        this.ensureArray(updates.patterns),
        "pattern",
        embedService,
        profileId
      );
    }

    // 检查增量数据中是否包含工作流字段的更新
    if (updates.workflows) {
      // 调用核心条目合并方法mergeItems，合并存量工作流与增量工作流
      // 传入标记"workflow"标识当前处理的是工作流类型数据，完成合并后更新merged.workflows
      merged.workflows = await this.mergeItems(
        merged.workflows,
        this.ensureArray(updates.workflows),
        "workflow",
        embedService,
        profileId
      );
    }

    // 仅在传入有效画像ID时执行后处理流程，避免无标识数据的无效校验
    if (profileId) {
      // 当合并后的偏好条目数≥2时启动冲突检测与去重，至少两个条目才存在互斥或重复的可能
      if (merged.preferences.length >= 2) {
        // 调用冲突检测算法，识别偏好条目间的互斥矛盾，确保画像逻辑自洽
        await this.detectConflicts(merged.preferences, "preference", profileId);
        // 调用语义去重方法，合并高度相似的重复偏好，精简画像数据规模
        await this.deduplicateItems(merged.preferences, "preference", profileId);
      }
      // 当合并后的行为模式条目数≥2时启动冲突检测与去重，满足基础校验条件
      if (merged.patterns.length >= 2) {
        // 检测行为模式间的逻辑冲突，比如同时存在"高频使用代码生成"与"从不使用AI工具"的矛盾条目
        await this.detectConflicts(merged.patterns, "pattern", profileId);
        // 合并语义重叠的行为模式，避免同一种行为被重复统计，保证数据准确性
        await this.deduplicateItems(merged.patterns, "pattern", profileId);
      }
      // 当合并后的工作流条目数≥2时启动冲突检测与去重，触发后置校验逻辑
      if (merged.workflows.length >= 2) {
        // 识别工作流间的互斥依赖，比如同时存在"优先本地处理"与"全量云端执行"的冲突配置
        await this.detectConflicts(merged.workflows, "workflow", profileId);
        // 合并流程高度相似的重复工作流，避免画像中存储冗余的流程定义
        await this.deduplicateItems(merged.workflows, "workflow", profileId);
      }
    }

    // 返回完成所有合并、校验、去重流程的最终用户画像结构化数据
    return merged;
  }

  // 合并画像条目的核心私有异步方法，负责将新增的条目与存量条目按规则合并
  // 泛型T约束条目必须包含可选的分类字段与必填的描述字段，适配偏好、模式、工作流三类核心数据
  // 输入参数：existing - 存量条目数组，当前已存储的所有同类型条目
  // 输入参数：incoming - 新增条目数组，待合并的增量条目列表
  // 输入参数：itemType - 条目类型标识，限定为三类合法值，区分处理不同业务场景
  // 输入参数：embedService - 可选的向量嵌入服务实例，用于语义相似度计算
  // 输入参数：profileId - 可选的当前操作的画像全局唯一ID，用于日志追踪
  // 返回值：合并完成的条目数组Promise对象，完成所有合并逻辑后解析返回最终列表
  private async mergeItems<T extends { category?: string; description: string }>(
    existing: T[],
    incoming: T[],
    itemType: "preference" | "pattern" | "workflow",
    embedService?: EmbeddingService,
    profileId?: string
  ): Promise<T[]> {
    // 初始化嵌入服务实例：若传入外部实例则使用外部实例，否则获取全局单例实例
    const embed = embedService ?? EmbeddingService.getInstance();
    // 标记是否启用嵌入能力：仅当嵌入服务完成预热（模型加载就绪）时才启用语义匹配
    const useEmbedding = embed.isWarmedUp;
    // 读取配置中启用嵌入计算的最小描述长度，过短的描述跳过语义匹配避免噪声
    const minDescLen = CONFIG.userProfileEmbeddingMinDescriptionLength;
    // 同分类强匹配阈值：同分类条目相似度超过该值判定为完全匹配，执行合并
    const sameCatStrong = CONFIG.userProfileEmbeddingThresholdSameCat;
    // 同分类弱匹配阈值：同分类条目相似度超过该值但未达强阈值，触发弱匹配逻辑
    const sameCatWeak = CONFIG.userProfileEmbeddingThresholdSameCatWeak;
    // 跨分类强匹配阈值：不同分类条目相似度超过该值判定为匹配，执行跨分类合并
    const crossCatStrong = CONFIG.userProfileEmbeddingThresholdCrossCat;
    // 跨分类弱匹配阈值：不同分类条目相似度超过该值但未达强阈值，触发跨分类弱匹配
    const crossCatWeak = CONFIG.userProfileEmbeddingThresholdCrossCatWeak;
    // 质心漂移阈值：条目质心与锚点的相似度低于该值判定为发生语义漂移
    const driftThreshold = CONFIG.userProfileCentroidDriftThreshold;

    // 若嵌入服务未就绪，打印跳过日志，后续将仅执行精确匹配与冷缓冲逻辑
    if (!useEmbedding) {
      log("profile embedding skipped: model not warmed up");
    }

    // 遍历存量画像条目执行预初始化与兼容性迁移
    for (const item of existing) {
      // 执行α参数懒迁移：为旧版本条目补全无缺的α/β置信度统计参数，兼容历史数据结构
      this.lazyMigrateAlpha(item as any);
      // 补全条目的最后活跃时间标记：若字段缺失，优先复用已有lastUpdated时间，否则使用当前时间戳
      if ((item as any).lastSeen === undefined)
        (item as any).lastSeen = (item as any).lastUpdated || Date.now();
      // 补全条目证据链数组：若字段缺失初始化为空数组，避免后续证据追加操作出现空指针异常
      if ((item as any).evidence === undefined) (item as any).evidence = [];

      // 满足嵌入启用条件时执行语义向量初始化：嵌入服务已就绪、描述长度达标、条目尚未生成质心向量
      if (useEmbedding && item.description.length >= minDescLen && !(item as any).centroid) {
        try {
          // 调用嵌入服务生成标准化文本的向量表示，输入为清洗归一化后的条目描述文本
          const emb = await embed.embed(normalizeDescription(item.description));
          // 将嵌入服务返回的向量转换为普通数组，便于后续JSON序列化与存储
          const arr = Array.from(emb);
          // 初始化条目语义质心向量：作为该条目的动态语义中心，随后续匹配持续更新
          (item as any).centroid = arr;
          // 初始化条目语义锚点向量：作为原始语义基准，用于检测语义漂移与概念演化
          (item as any).anchor = arr;
          // 打印质心迁移成功日志，记录条目前30位描述用于问题排查与状态监控
          log("profile centroid migrated", { desc: item.description.substring(0, 30) });
        } catch (e) {
          // 捕获嵌入生成过程中的所有异常，记录失败日志与错误详情，避免单条目的失败中断整个合并流程
          log("profile centroid migration failed", {
            desc: item.description.substring(0, 30),
            error: String(e),
          });
        }
      }
    }

    // 初始化匹配成功条目计数器：记录所有成功合并到存量的条目总数
    let matchCount = 0;
    // 初始化新增条目计数器：记录所有因无匹配而新建的条目总数
    let newCount = 0;
    // 仅当向量嵌入服务已就绪且当前类型的冷缓冲中存在积压条目时，执行缓冲排空逻辑
    if (useEmbedding && (this.coldBuffer as any)[itemType + "s"].length > 0) {
      // 深拷贝冷缓冲中的所有积压条目，避免原数组引用在清空过程中出现数据异常
      const buffered = [...(this.coldBuffer as any)[itemType + "s"]];
      // 清空当前类型的冷缓冲数组，准备接收新的待处理条目
      (this.coldBuffer as any)[itemType + "s"] = [];
      // 持久化清空后的冷缓冲状态到磁盘，确保下一次启动时不会重复处理已排空的条目
      this.saveColdBuffer();
      // 打印冷缓冲排空日志，记录当前处理的条目类型与缓冲规模，便于排查冷启动性能问题
      log("profile cold start: draining buffer", {
        type: itemType,
        bufferSize: buffered.length,
      });
      // 将冷缓冲中的积压条目合并到本次待处理的增量条目前方，保证历史条目优先处理的顺序
      incoming = [...buffered, ...incoming];
    }
    // 打印条目合并流程启动日志，记录合并前的核心状态参数，用于全流程链路追踪
    log("profile merge start", {
      type: itemType,
      existingCount: existing.length,
      incomingCount: incoming.length,
      embeddingReady: useEmbedding,
    });

    // 遍历所有待合并的新增条目，逐个执行匹配与合并逻辑
    for (const newItem of incoming) {
      // 在存量条目中查找完全匹配的索引：分类和描述文本必须完全一致
      const exactIdx = existing.findIndex(
        (e) => e.category === newItem.category && e.description === newItem.description
      );

      // 若找到完全匹配的存量条目
      if (exactIdx >= 0) {
        // 记录合并前的频率值，用于日志记录前后变化
        const oldFreq = (existing[exactIdx] as any).frequency || 1;
        // 调用已确认匹配的合并方法，将新条目合并到存量条目中，同分类标记为true
        existing[exactIdx] = this.mergeConfirmedMatch(existing[exactIdx], newItem, itemType, true);
        // 匹配成功计数器加一
        matchCount++;
        // 打印完全匹配成功的日志，记录条目类型、索引、分类和频率变化
        log("profile matched: exact", {
          type: itemType,
          idx: exactIdx,
          cat: newItem.category,
          frequency: `${oldFreq}→${(existing[exactIdx] as any).frequency || "?"}`,
        });
        // 当前条目已完成合并，跳过后续处理流程
        continue;
      }

      // 当向量嵌入服务已就绪，且新增条目的描述长度满足最低语义分析要求时，执行语义匹配流程
      if (useEmbedding && newItem.description.length >= minDescLen) {
        // 初始化排名第一的匹配条目评分，初始值为0代表无有效匹配
        let top1Score = 0;
        // 初始化排名第一的匹配条目在存量数组中的索引，-1代表未找到任何匹配
        let top1Idx = -1;
        // 标记排名第一的匹配条目是否与新增条目属于同一分类，用于区分同跨分类匹配场景
        let top1SameCat = false;
        // 记录排名第一的匹配条目的匹配强度等级，仅strong/weak为有效匹配状态，null代表无匹配
        let top1Band: "strong" | "weak" | null = null;
        // 初始化排名第二的匹配条目评分，初始值为0用于后续多候选排序逻辑
        let top2Score = 0;
        // 初始化排名第二的匹配条目在存量数组中的索引，-1代表未找到第二个有效匹配
        let top2Idx = -1;
        // 标记排名第二的匹配条目是否与新增条目属于同一分类，支撑三向合并的分类一致性校验
        let top2SameCat = false;
        // 记录排名第二的匹配条目的匹配强度等级，仅当两个条目均为强匹配时才会触发三向合并逻辑
        let top2Band: "strong" | "weak" | null = null;

        // 调用嵌入服务生成新增条目描述文本的语义向量，先对描述做标准化处理消除文本噪声
        const newEmb = await embed.embed(normalizeDescription(newItem.description));

        // 遍历所有存量画像条目，逐一计算与新增条目的语义相似度，筛选出Top2匹配候选
        for (let i = 0; i < existing.length; i++) {
          // 获取当前循环的存量条目，避免数组越界或空条目引用导致的运行时异常
          const existingItem = existing[i];
          // 若当前存量条目为空（已被之前的合并逻辑移除），直接跳过当前循环的剩余处理
          if (!existingItem) continue;

          // 从存量条目中提取语义质心向量，质心是该条目历次匹配更新后的动态语义中心
          const centroid = (existingItem as any).centroid as number[] | undefined;
          // 若当前存量条目未生成语义质心向量（嵌入服务异常或旧数据未完成迁移），跳过该条目
          if (!centroid) continue;

          // 计算新增条目向量与存量条目质心向量的余弦相似度，余弦相似度越接近1代表语义越接近
          const score = cosineSimilarityNumbers(Array.from(newEmb), centroid);
          // 判断当前存量条目与新增条目是否属于同一业务分类，不同分类使用独立的相似度阈值
          const sameCat = existingItem.category === newItem.category;

          // 根据同跨分类场景选择对应的强匹配阈值，同分类的强阈值更高（要求语义更相似）
          const strongThreshold = sameCat ? sameCatStrong : crossCatStrong;
          // 根据同跨分类场景选择对应的弱匹配阈值，只有超过弱阈值的条目才会进入候选池
          const weakThreshold = sameCat ? sameCatWeak : crossCatWeak;

          // 初始化当前条目的匹配强度等级，null代表未达到任何有效匹配的阈值要求
          let band: "strong" | "weak" | null = null;
          // 若相似度超过当前分类的强匹配阈值，标记为强匹配，可触发直接合并逻辑
          if (score >= strongThreshold) {
            band = "strong";
          } else if (score >= weakThreshold) {
            // 若相似度仅超过弱匹配阈值，标记为弱匹配，需通过汤普森采样检验才能升级合并
            band = "weak";
          } else {
            // 相似度未达到最低弱匹配阈值，直接跳过该条目，不进入后续的Top2排序逻辑
            continue;
          }

          // 当前条目的相似度得分高于历史排名第一的匹配项，触发TOP2排名更新
          if (score > top1Score) {
            // 将原排名第一的所有属性降级保存到排名第二的变量中
            top2Score = top1Score;
            top2Idx = top1Idx;
            top2SameCat = top1SameCat;
            top2Band = top1Band;
            // 将当前条目升级为新的排名第一，保存其所有匹配属性
            top1Score = score;
            top1Idx = i;
            top1SameCat = sameCat;
            top1Band = band;
            // 当前条目未超过第一名，但超过历史排名第二的匹配项，仅更新第二名属性
          } else if (score > top2Score) {
            // 更新排名第二的匹配项属性为当前条目的匹配数据
            top2Score = score;
            top2Idx = i;
            top2SameCat = sameCat;
            top2Band = band;
          }
        }

        // 检查三向合并触发条件：存量条目中存在两个同分类强匹配候选
        if (
          // 第一匹配项索引有效（存在匹配条目）
          top1Idx >= 0 &&
          // 第一匹配项为强匹配等级（相似度达标）
          top1Band === "strong" &&
          // 第二匹配项索引有效（存在第二个高匹配条目）
          top2Idx >= 0 &&
          // 第二匹配项同样为强匹配等级
          top2Band === "strong" &&
          // 第一匹配项与新增条目属于同一业务分类
          top1SameCat &&
          // 第二匹配项与新增条目也属于同一业务分类
          top2SameCat
        ) {
          // 从存量数组中取出第一个匹配条目，非空断言确保安全访问
          const item1 = existing[top1Idx]!;
          // 从存量数组中取出第二个匹配条目，非空断言确保安全访问
          const item2 = existing[top2Idx]!;
          // 将新增条目语义向量转换为普通数组，用于后续质心融合计算
          const newEmbArr = Array.from(newEmb);
          // 调用三向合并核心方法，将两个存量条目与新增条目合并为一个新条目
          const threeWayResult = this.combineThree(
            item1,
            item2,
            newItem,
            itemType,
            newEmbArr,
            top1Score
          );
          // 将合并后的新条目写回存量数组的第一个匹配项位置，覆盖原条目
          existing[top1Idx] = threeWayResult as T;
          // 记录第二个匹配条目的索引，准备从数组中移除该冗余条目
          const removeIdx = top2Idx;
          // 从存量数组中删除第二个匹配条目，完成冗余数据清理
          existing.splice(removeIdx, 1);
          // 匹配计数器累加2：两个存量条目都成功匹配并完成合并
          matchCount += 2;
          // 打印三向合并完成日志，记录合并前后的核心状态参数用于链路追踪
          log("profile matched: three-way merge", {
            type: itemType,
            idx1: top1Idx,
            idx2: removeIdx,
            cat: item1.category,
            score1: Math.round(top1Score * 100) / 100,
            score2: Math.round(top2Score * 100) / 100,
            freq1: (item1 as any).frequency,
            freq2: (item2 as any).frequency,
            combinedFreq: (threeWayResult as any).frequency,
          });
          // 检查合并后的条目是否满足条目演化触发条件
          if (
            // 合并后的条目访问频率达到里程碑节点（触发演化的频率阈值）
            this.isMilestone((threeWayResult as any).frequency || 1) &&
            // 条目积累的证据链长度满足演化最低要求
            (threeWayResult as any).evidence?.length >= this.minEvidenceForEvolve(itemType)
          ) {
            // 调用条目演化方法，对合并后的条目执行语义演化与属性更新
            await this.evolveAndUpdate(threeWayResult as any, itemType, profileId);
          }
          // 当前新增条目已完成三向合并流程，跳过后续所有处理逻辑
          continue;
        }

        // 当存量条目中存在有效Top1匹配且匹配强度为强匹配等级时，触发语义融合分支流程
        if (top1Idx >= 0 && top1Band === "strong") {
          // 从存量数组中取出Top1匹配的存量条目，非空断言确保类型安全访问
          const existingItem = existing[top1Idx]!;
          // 记录存量条目合并前的原始访问频率，用于日志记录合并前后的变化
          const oldFreq = (existingItem as any).frequency || 1;
          // 提取存量条目的语义质心向量，作为本次质心更新的基础源数据
          const centroid = (existingItem as any).centroid as number[];
          // 提取存量条目的语义锚点向量，用于后续检测条目的语义漂移程度
          const anchor = (existingItem as any).anchor as number[];

          // 将新增条目的语义向量转换为普通数组格式，便于后续数值运算
          const newEmbArr = Array.from(newEmb);
          // 采用指数移动平均（EMA）算法更新语义质心向量，保留历史语义的同时融入新观测的语义信息
          const updatedCentroid = l2Normalize(
            centroid.map(
              (v, i) =>
                CENTROID_EMA_WEIGHT * v + CENTROID_EMA_WEIGHT_COMPLEMENT * (newEmbArr[i] ?? 0)
            )
          );

          // 初始化语义漂移低于阈值的连续次数，复用存量条目已有计数，无记录则初始化为0
          let driftBelowCount = ((existingItem as any).driftBelowCount as number) || 0;
          // 仅当锚点向量有效且维度与更新后的质心向量一致时，执行语义漂移检测计算
          if (anchor && anchor.length === updatedCentroid.length) {
            // 计算更新后的质心与原始锚点的余弦相似度，衡量语义偏离原始定义的程度
            const driftScore = cosineSimilarityNumbers(updatedCentroid, anchor);
            // 若漂移得分低于预设的漂移阈值，连续漂移计数器累加1
            if (driftScore < driftThreshold) {
              driftBelowCount++;
            } else {
              // 漂移得分恢复至阈值以上，重置连续漂移计数器为0
              driftBelowCount = 0;
            }
          }

          // 当连续漂移次数达到触发拆分条件（≥2次），执行存量条目冻结与新条目拆分逻辑
          if (driftBelowCount >= 2) {
            // 为新增条目生成独立的语义质心向量，与当前新增观测的语义完全一致
            const driftCentroid = Array.from(newEmb);
            // 为新增条目设置独立的语义锚点向量，作为新条目的原始语义基准
            const driftAnchor = driftCentroid;
            // 深拷贝原有存量条目，创建冻结状态的条目副本，保留原始语义属性不被修改
            const frozenItem = { ...existingItem };
            // 冻结条目保留原始的语义质心向量，停止继续参与质心更新
            (frozenItem as any).centroid = centroid;
            // 记录冻结条目的连续漂移计数，用于后续状态追踪与日志分析
            (frozenItem as any).driftBelowCount = driftBelowCount;
            // 将冻结后的条目写回存量数组的原位置，完成原有条目的冻结操作
            existing[top1Idx] = frozenItem as T;
            // 为拆分出的新概念创建全新的画像条目，添加到存量数组中实现语义拆分
            existing.push(this.initItem(newItem, itemType, driftCentroid, driftAnchor) as T);
            // 新增条目计数器累加1，记录本次拆分生成的新概念条目
            newCount++;
            // 打印语义漂移拆分完成的系统日志，记录拆分的核心参数用于链路追踪与问题排查
            log("profile drift fuse: frozen existing, new item created", {
              type: itemType,
              idx: top1Idx,
              driftBelowCount,
              driftScore: anchor
                ? Math.round(cosineSimilarityNumbers(updatedCentroid, anchor) * 100) / 100
                : null,
            });
            // 当前新增条目已完成漂移拆分流程，跳过后续所有处理逻辑进入下一个新增条目循环
            continue;
          }

          // 调用已确认匹配的合并方法，将新条目与存量条目按规则融合
          const combined = this.mergeConfirmedMatch(
            existingItem,
            newItem,
            itemType,
            top1SameCat
          ) as T;
          // 更新合并后条目的动态语义质心向量，写入指数移动平均计算后的最新值
          (combined as any).centroid = updatedCentroid;
          // 保留原始语义锚点向量不变，锚点作为语义基准不会随每次匹配更新
          (combined as any).anchor = anchor;
          // 同步连续低于漂移阈值的次数，保留当前条目的漂移状态统计
          (combined as any).driftBelowCount = driftBelowCount;
          // 重置弱匹配连续命中计数器，本次为强匹配，清空弱匹配累计计数
          (combined as any).weakHitCount = 0;
          // 清空最近一次弱匹配时间戳，本次强匹配覆盖弱匹配状态记录
          (combined as any).lastWeakHitAt = null;

          // 检查是否需要更新条目的描述文本：相似度超0.9、同分类且新描述更简洁
          if (
            top1Score > 0.9 &&
            top1SameCat &&
            newItem.description.length < (existingItem as any).description?.length
          ) {
            // 用更简洁的新描述覆盖原描述，在语义一致的前提下精简文本长度
            (combined as any).description = newItem.description;
          }

          // 将合并完成的条目写回存量数组的原位置，覆盖原存量条目
          existing[top1Idx] = combined;
          // 匹配成功计数器加一，累计本次合并的有效匹配条目数
          matchCount++;

          // 仅当匹配条目与新增条目属于同一分类时，触发交叉验证合并流程
          if (top1SameCat) {
            // 初始化待合并条目索引数组，记录所有符合合并条件的存量条目位置
            const mergeIndices: number[] = [];
            // 遍历所有存量条目，筛选出与新增条目语义高度重合的冗余条目
            for (let j = 0; j < existing.length; j++) {
              // 跳过当前已合并的主条目，避免重复处理核心合并对象
              if (j === top1Idx) continue;
              // 获取当前循环的存量条目，空条目直接跳过避免空指针异常
              const other = existing[j];
              // 条目无效或分类不一致的条目直接跳过，仅处理同分类下的潜在冗余项
              if (!other || other.category !== existingItem.category) continue;
              // 提取当前条目存储的语义质心向量，无向量数据的条目无法参与语义匹配
              const otherCentroid = (other as any).centroid as number[] | undefined;
              // 质心向量不存在，跳过该条目无法执行相似度计算
              if (!otherCentroid) continue;
              // 计算新增条目向量与当前存量条目的余弦相似度，衡量语义重合度
              const crossScore = cosineSimilarityNumbers(Array.from(newEmb), otherCentroid);
              // 相似度超过同分类强匹配阈值，确认两个条目语义完全一致，需要合并
              if (crossScore >= sameCatStrong) {
                // 将符合合并条件的条目索引存入待删除数组，后续统一清理
                mergeIndices.push(j);
                // 为合并后的主条目执行α参数懒迁移，兼容旧版本数据结构
                this.lazyMigrateAlpha(combined as any);
                // 为待合并的冗余条目执行α参数懒迁移，确保统计参数完整
                this.lazyMigrateAlpha(other as any);
                // 将冗余条目的α统计值累加到主条目，合并置信度统计数据
                (combined as any).alpha += (other as any).alpha || 1;
                // 合并两个条目的β统计值，完整保留历史置信度累积数据
                (combined as any).beta = ((combined as any).beta || 1) + ((other as any).beta || 1);
                // 记录主条目合并前的访问频率，用于后续质心加权计算
                const oldFreq = (combined as any).frequency || 1;
                // 将冗余条目的访问频率累加到主条目，合并总访问次数
                (combined as any).frequency += (other as any).frequency || 1;
                // 合并两个条目的证据链数组，通过Set去重保留唯一证据，最多保留10条最新证据
                (combined as any).evidence = [
                  ...new Set([
                    ...this.ensureArray((combined as any).evidence),
                    ...this.ensureArray((other as any).evidence),
                  ]),
                ].slice(0, 10);
                // 提取主条目当前的语义质心向量，用于后续加权融合计算
                const combinedCentroid = (combined as any).centroid as number[];
                // 计算主条目频率权重，按历史访问次数分配质心融合的权重比例
                const w1 = oldFreq / (oldFreq + ((other as any).frequency || 1));
                // 计算冗余条目频率权重，两个权重之和为1保证向量归一化基础
                const w2 =
                  ((other as any).frequency || 1) / (oldFreq + ((other as any).frequency || 1));
                // 按频率加权融合两个条目的质心向量，并执行L2归一化生成新的语义中心
                const mergedCentroid = l2Normalize(
                  combinedCentroid.map((v, i) => w1 * v + w2 * (otherCentroid[i] ?? 0))
                );
                // 将融合后的新质心向量写回主条目，完成语义中心的更新
                (combined as any).centroid = mergedCentroid;
                // 重新计算主条目置信度，同步合并后的统计参数到confidence字段
                this.syncConfidence(combined as any);
                // 匹配成功计数器累加1，记录本次交叉验证合并的有效条目数
                matchCount++;
                // 打印交叉验证合并完成的系统日志，记录合并的核心参数用于链路追踪
                log("profile matched: cross-validation merge", {
                  type: itemType,
                  idx: top1Idx,
                  mergedIdx: j,
                  cat: other.category,
                  crossScore: Math.round(crossScore * 100) / 100,
                  mergedAlpha: Math.round((combined as any).alpha),
                  combinedFreq: (combined as any).frequency,
                });
              }
            }
            // 从后往前遍历待删除索引数组，避免数组元素前移导致的索引错乱问题
            for (let i = mergeIndices.length - 1; i >= 0; i--) {
              // 从存量数组中删除已合并的冗余条目，完成数据清理
              existing.splice(mergeIndices[i]!, 1);
            }
          }

          // 构造语义漂移信息对象：仅当锚点向量与更新后质心向量维度匹配时计算有效漂移数据
          const driftInfo =
            anchor && anchor.length === updatedCentroid.length
              ? {
                  // 计算质心与锚点的余弦相似度并保留两位小数，量化语义偏离原始基准的程度
                  driftScore:
                    Math.round(cosineSimilarityNumbers(updatedCentroid, anchor) * 100) / 100,
                  // 记录连续低于漂移阈值的次数，追踪语义漂移的累积状态
                  driftBelowCount,
                }
              : {}; // 向量维度不匹配时返回空对象，避免日志输出无效字段

          // 打印强语义匹配成功日志，记录本次合并的核心业务参数用于全链路追踪与问题排查
          log("profile matched: embedding strong", {
            type: itemType, // 当前处理的条目类型（偏好/模式/工作流）
            idx: top1Idx, // 匹配到的存量条目在数组中的索引位置
            cat: existingItem.category, // 条目的业务分类，用于区分同分类/跨分类场景
            score: Math.round(top1Score * 100) / 100, // 语义相似度得分，保留两位小数提升可读性
            sameCat: top1SameCat, // 标记新增条目与存量条目是否属于同一业务分类
            frequency: `${oldFreq}→${(combined as any).frequency || "?"}`, // 记录合并前后访问频率的变化，量化条目活跃度增长
            ...driftInfo, // 解构注入语义漂移相关信息，完成日志参数聚合
          });

          // 提取合并后条目的访问频率，默认值为1处理极端场景下的空值异常
          const newFreq = (combined as any).frequency || 1;
          // 校验是否满足条目演化触发条件：访问频率达到里程碑节点，且证据链长度达标
          if (
            this.isMilestone(newFreq) &&
            (combined as any).evidence?.length >= this.minEvidenceForEvolve(itemType)
          ) {
            // 调用条目演化更新方法，对符合条件的条目执行语义演化与属性同步
            await this.evolveAndUpdate(combined as any, itemType, profileId);
          }

          // 当前新增条目已完成强匹配全流程，跳过后续处理逻辑进入下一新增条目循环
          continue;
        }

        // 当存量条目中存在有效Top1匹配且匹配强度为弱匹配等级时，触发弱匹配分支的后续处理逻辑
        if (top1Idx >= 0 && top1Band === "weak") {
          // 从存量数组中取出Top1匹配的存量条目，非空断言确保类型安全访问
          const existingItem = existing[top1Idx]!;

          // 仅处理新增条目与匹配存量条目属于同一业务分类的场景，跨分类弱匹配执行独立统计逻辑
          if (top1SameCat) {
            // 读取存量条目当前记录的连续低于漂移阈值次数，无历史记录则初始化为0
            const existingDriftBelow = ((existingItem as any).driftBelowCount as number) || 0;
            // 提取存量条目的动态语义质心向量，作为本次质心更新的基础源数据
            const centroid = (existingItem as any).centroid as number[];
            // 提取存量条目的原始语义锚点向量，用于后续检测条目的语义漂移程度
            const anchor = (existingItem as any).anchor as number[];
            // 将新增条目的语义向量转换为普通数组格式，便于后续数值运算
            const newEmbArr = Array.from(newEmb);
            // 采用指数移动平均（EMA）算法更新语义质心向量，保留历史语义的同时融入新观测的语义信息
            const updatedCentroid = l2Normalize(
              centroid.map(
                (v, i) =>
                  CENTROID_EMA_WEIGHT * v + CENTROID_EMA_WEIGHT_COMPLEMENT * (newEmbArr[i] ?? 0)
              )
            );

            // 初始化漂移计数器，首先继承存量条目已有的连续漂移次数
            let driftBelowCount = existingDriftBelow;
            // 仅当锚点向量存在且与更新后的质心向量维度匹配时，才执行语义漂移检测
            if (anchor && anchor.length === updatedCentroid.length) {
              // 计算更新后的质心与原始锚点的余弦相似度，量化当前语义偏离原始基准的程度
              const driftScore = cosineSimilarityNumbers(updatedCentroid, anchor);
              // 如果漂移得分低于预设的漂移阈值，说明语义偏移已超出允许范围
              if (driftScore < driftThreshold) {
                // 连续漂移次数在原有基础上累加1，标记本次漂移持续发生
                driftBelowCount = existingDriftBelow + 1;
              } else {
                // 漂移得分恢复至阈值以上，重置连续漂移计数器，语义未发生持续偏移
                driftBelowCount = 0;
              }
            }

            // 当连续检测到语义漂移的次数达到阈值（≥2次）时，触发存量条目冻结与新条目拆分逻辑
            if (driftBelowCount >= 2) {
              // 为新增条目生成独立的语义质心向量，与当前新增观测的语义完全一致，作为新条目的动态语义中心
              const driftCentroid = Array.from(newEmb);
              // 为新增条目设置独立的语义锚点向量，与初始质心保持一致，作为新条目的原始语义基准，用于后续漂移检测
              const driftAnchor = driftCentroid;
              // 深拷贝原有存量条目，创建冻结状态的条目副本，保留原始语义属性不被后续修改
              const frozenItem = { ...existingItem };
              // 冻结条目保留原始的语义质心向量，停止参与后续的质心更新，固化其历史语义中心
              (frozenItem as any).centroid = centroid;
              // 记录冻结条目的连续漂移次数，保留漂移状态的历史统计，便于后续状态追踪与日志分析
              (frozenItem as any).driftBelowCount = driftBelowCount;
              // 将冻结后的条目写回存量数组的原位置，完成原有存量条目的冻结操作
              existing[top1Idx] = frozenItem as T;
              // 为拆分出的新概念创建全新的画像条目，调用初始化方法设置完整属性后添加到存量数组
              existing.push(this.initItem(newItem, itemType, driftCentroid, driftAnchor) as T);
              // 新增条目计数器累加1，记录本次漂移拆分生成的独立新概念条目
              newCount++;
              // 打印强制合并路径下的漂移拆分系统日志，记录核心参数用于链路追踪与问题排查
              log("profile drift fuse: forced merge path, frozen existing", {
                type: itemType,
                idx: top1Idx,
                driftBelowCount,
                driftScore: anchor
                  ? Math.round(cosineSimilarityNumbers(updatedCentroid, anchor) * 100) / 100
                  : null,
              });
              // 当前新增条目已完成漂移拆分全流程，跳过后续处理逻辑进入下一个新增条目循环
              continue;
            }

            // 浅拷贝存量条目所有属性，创建合并后的新条目对象，避免直接修改原对象导致的引用问题
            const combined = { ...existingItem };
            // 按语义相似度加权累加固有置信度参数alpha：top1Score越高，本次合并对置信度提升贡献越大
            (combined as any).alpha = ((existingItem as any).alpha || 1) + top1Score * 1.0;
            // 访问频率直接加1，本次弱匹配合并计入条目总活跃次数统计
            (combined as any).frequency = ((existingItem as any).frequency || 1) + 1;
            // 合并并去重新增条目与存量条目的证据链，通过Set自动去重，最多保留10条最新证据避免数据冗余
            (combined as any).evidence = [
              ...new Set([
                (newItem as any).description || newItem.description,
                ...this.ensureArray((newItem as any).evidence),
                ...this.ensureArray((existingItem as any as any).evidence),
              ]),
            ].slice(0, 10);
            // 重置弱匹配alpha统计值，本次合并完成后清空弱匹配累积计数，重新开始新一轮汤普森采样统计
            (combined as any).weakAlpha = 1;
            // 重置弱匹配beta统计值，与weakAlpha同步重置，确保弱匹配统计从初始状态重新累积
            (combined as any).weakBeta = 1;
            // 清零弱匹配连续命中计数器，本次强制合并完成后弱匹配状态重置，避免持续触发漂移检测
            (combined as any).weakHitCount = 0;
            // 清空最近一次弱匹配时间戳，同步清除弱匹配状态的时间标记
            (combined as any).lastWeakHitAt = null;
            // 更新条目的最后匹配时间为当前时间戳，记录本次合并的发生时间用于后续活跃度计算
            (combined as any).lastMatchTime = Date.now();
            // 将指数移动平均计算后的最新质心向量写入合并条目，更新条目的动态语义中心
            (combined as any).centroid = updatedCentroid;
            // 保留原始语义锚点向量不变，锚点作为条目的语义基准始终保持初始状态
            (combined as any).anchor = anchor;
            // 同步最新的连续漂移低于阈值次数，保留条目的语义漂移状态统计
            (combined as any).driftBelowCount = driftBelowCount;
            // 重新计算并同步条目的置信度值，根据更新后的alpha、beta和时间参数生成最新置信度
            this.syncConfidence(combined as any);

            // 将合并完成的条目写回存量数组的原位置，覆盖原存量条目完成更新
            existing[top1Idx] = combined;
            // 匹配成功计数器加一，累计本次弱匹配强制合并的有效条目数
            matchCount++;

            // 构造语义漂移详情对象：仅当锚点向量存在且与更新后质心向量维度匹配时才生成有效漂移数据
            const driftInfo =
              anchor && anchor.length === updatedCentroid.length
                ? {
                    // 计算质心与锚点的余弦相似度并保留两位小数，精确量化当前语义相对于原始基准的偏离程度
                    driftScore:
                      Math.round(cosineSimilarityNumbers(updatedCentroid, anchor) * 100) / 100,
                    // 记录连续低于漂移阈值的累计次数，用于追踪语义漂移的持续发生状态
                    driftBelowCount,
                  }
                : {}; // 向量维度不匹配或锚点不存在时返回空对象，避免日志输出无效字段

            // 打印同分类强制合并完成的系统日志，聚合本次合并的核心业务参数用于全链路追踪与问题排查
            log("profile matched: same-cat forced merge", {
              // 当前处理的画像条目类型（偏好/模式/工作流），区分不同业务场景的合并行为
              type: itemType,
              // 匹配到的存量条目在数组中的原始索引位置，用于定位存量数据源
              idx: top1Idx,
              // 条目所属的业务分类，验证本次同分类强制合并的分类一致性
              cat: existingItem.category,
              // 语义相似度得分保留两位小数，提升日志可读性，量化本次匹配的语义重合度
              score: Math.round(top1Score * 100) / 100,
              // 记录合并前后置信度的变化，用箭头分隔直观展示置信度的波动情况
              confidence: `${Math.round(((existingItem as any).confidence || 0) * 100) / 100}→${Math.round((combined as any).confidence * 100) / 100}`,
              // 记录合并前后访问频率的变化，量化条目活跃度的增长幅度
              frequency: `${(existingItem as any).frequency || 1}→${(combined as any).frequency || "?"}`,
              // 解构注入语义漂移相关信息，完成日志参数的完整聚合
              ...driftInfo,
            });

            // 提取合并后条目的访问频率，处理极端场景下的空值异常，默认值设为1
            const newFreq = (combined as any).frequency || 1;
            // 校验是否满足条目演化触发条件：访问频率达到里程碑节点，且证据链长度达标
            if (
              this.isMilestone(newFreq) &&
              (combined as any).evidence?.length >= this.minEvidenceForEvolve(itemType)
            ) {
              // 调用条目演化更新方法，对符合条件的条目执行语义演化与属性同步
              await this.evolveAndUpdate(combined as any, itemType, profileId);
            }

            // 当前新增条目已完成弱匹配强制合并全流程，跳过后续处理逻辑进入下一个新增条目循环
            continue;
          }

          // 累加强化弱匹配置信度的正例项alpha值：原有累积值加上本次匹配得分作为新观测权重
          const weakAlpha = ((existingItem as any).weakAlpha || 1) + top1Score;
          // 累加强化弱匹配置信度的负例项beta值：原有累积值加上(1-本次得分)作为不匹配的权重补充
          const weakBeta = ((existingItem as any).weakBeta || 1) + (1 - top1Score);
          // 设定参与汤普森采样计算的有效alpha值，直接采用累积后的弱匹配alpha
          const effectiveAlpha = weakAlpha;
          // 设定参与汤普森采样计算的有效beta值，直接采用累积后的弱匹配beta
          const effectiveBeta = weakBeta;
          // 初始化弱匹配升级标记，默认暂不满足升级为正式匹配的条件
          let upgraded = false;
          // 当有效alpha与beta的总和超过阈值7时，触发确定性升级判定（跳过随机采样，直接用均值判断）
          if (effectiveAlpha + effectiveBeta > 7) {
            // 计算贝塔分布的均值，若均值≥0.45则判定满足升级条件，标记为可升级
            upgraded = effectiveAlpha / (effectiveAlpha + effectiveBeta) >= 0.45;
          } else {
            // 总样本量不足阈值时，执行汤普森采样随机抽样，若抽样值≥0.5则判定通过升级
            upgraded = sampleBeta(effectiveAlpha, effectiveBeta) >= 0.5;
          }
          // 汤普森采样判定弱匹配升级条件成立，进入正式升级流程
          if (upgraded) {
            // 提取升级前存量条目的原始访问频率，用于日志记录频率变化，空值兜底为1
            const oldFreq = (existingItem as any).frequency || 1;
            // 提取存量条目当前的语义质心向量，作为质心更新的基础数据
            const centroid = (existingItem as any).centroid as number[];
            // 提取存量条目的原始语义锚点向量，用于后续语义漂移检测的基准
            const anchor = (existingItem as any).anchor as number[];
            // 将新增条目的语义向量转换为普通数组格式，适配后续数值运算要求
            const newEmbArr = Array.from(newEmb);
            // 采用指数移动平均算法更新语义质心，保留历史语义同时融入新观测信息
            const updatedCentroid = l2Normalize(
              centroid.map(
                (v, i) =>
                  CENTROID_EMA_WEIGHT * v + CENTROID_EMA_WEIGHT_COMPLEMENT * (newEmbArr[i] ?? 0)
              )
            );
            // 调用标准确认匹配合并方法，将新增条目与存量条目正式融合，跨分类场景参数设为false
            const combined = this.mergeConfirmedMatch(existingItem, newItem, itemType, false) as T;
            // 将更新后的语义质心向量写入合并后的条目，完成动态语义中心的同步
            (combined as any).centroid = updatedCentroid;
            // 保留原始语义锚点向量不变，锚点作为语义基准始终保持初始状态
            (combined as any).anchor = anchor;
            // 累加固有置信度参数alpha，弱匹配升级额外增加0.5的置信度增量
            (combined as any).alpha += 0.5;
            // 重置弱匹配统计的alpha值，升级后从初始状态重新累积弱匹配样本
            (combined as any).weakAlpha = 1;
            // 同步重置弱匹配统计的beta值，与weakAlpha保持初始化状态一致
            (combined as any).weakBeta = 1;
            // 继承存量条目的连续漂移低于阈值次数，保留语义漂移的历史统计状态
            (combined as any).driftBelowCount = (existingItem as any).driftBelowCount || 0;
            // 重新计算并同步条目的置信度值，基于更新后的统计参数生成最新置信度
            this.syncConfidence(combined as any);
            // 将合并完成的条目写回存量数组的原位置，覆盖原存量条目完成升级更新
            existing[top1Idx] = combined;
            // 匹配成功计数器加一，累计本次弱匹配升级的有效匹配条目数
            matchCount++;
            // 打印弱匹配通过汤普森采样升级的系统日志，记录核心参数用于链路追踪与问题排查
            log("profile matched: weak upgrade (thompson)", {
              type: itemType,
              idx: top1Idx,
              cat: existingItem.category,
              score: Math.round(top1Score * 100) / 100,
              weakAlpha: Math.round(weakAlpha * 100) / 100,
              weakBeta: Math.round(weakBeta * 100) / 100,
              forced: effectiveAlpha + effectiveBeta > 7,
              frequency: `${oldFreq}→${(combined as any).frequency || "?"}`,
              incomingDesc: (newItem.description || "").substring(0, 40),
            });
            // 提取升级后条目的访问频率，处理极端场景下的空值异常，默认值设为1
            const newFreq = (combined as any).frequency || 1;
            // 校验是否满足条目演化触发条件：访问频率达到里程碑节点，且证据链长度达标
            if (
              this.isMilestone(newFreq) &&
              (combined as any).evidence?.length >= this.minEvidenceForEvolve(itemType)
            ) {
              // 调用条目演化更新方法，对符合条件的条目执行语义演化与属性同步
              await this.evolveAndUpdate(combined as any, itemType, profileId);
            }
            // 当前新增条目已完成弱匹配升级全流程，跳过后续处理逻辑进入下一个新增条目循环
            continue;
          }
          // 根据弱匹配统计样本总量判断是否需要重置弱匹配累积参数
          // 当总样本量未超过阈值7时，保留本次累积的弱匹配统计值用于后续汤普森采样计算
          if (effectiveAlpha + effectiveBeta <= 7) {
            // 将累积后的有效alpha值写回存量条目，保留历史弱匹配观测数据
            (existingItem as any).weakAlpha = effectiveAlpha;
            // 将累积后的有效beta值写回存量条目，维持正负例观测的完整统计
            (existingItem as any).weakBeta = effectiveBeta;
          } else {
            // 总样本量超过阈值时重置弱匹配统计参数，避免过时观测持续影响采样结果
            // 重置alpha为初始值1，开启新一轮弱匹配观测的累积
            (existingItem as any).weakAlpha = 1;
            // 重置beta为初始值1，与alpha同步完成弱匹配统计的重置
            (existingItem as any).weakBeta = 1;
          }
          // 更新存量条目的最后活跃时间戳为当前时间，记录本次弱匹配的发生时间
          (existingItem as any).lastSeen = Date.now();
          // 记录最近一次弱匹配的发生时间戳，用于弱匹配状态的时序追踪
          (existingItem as any).lastWeakHitAt = Date.now();
          // 打印汤普森采样路径下的弱匹配命中日志，记录核心统计参数用于链路追踪
          log("profile weak hit (thompson)", {
            // 当前处理的画像条目类型，区分偏好/模式/工作流等不同业务场景
            type: itemType,
            // 匹配到的存量条目在数组中的原始索引位置，用于定位存量数据源
            idx: top1Idx,
            // 存量条目所属的业务分类，验证弱匹配的分类归属一致性
            cat: existingItem.category,
            // 语义相似度得分保留两位小数，量化本次匹配的语义重合度
            score: Math.round(top1Score * 100) / 100,
            // 累积后的弱匹配alpha值保留两位小数，记录本次观测的正例权重累积
            weakAlpha: Math.round(weakAlpha * 100) / 100,
            // 累积后的弱匹配beta值保留两位小数，记录本次观测的负例权重累积
            weakBeta: Math.round(weakBeta * 100) / 100,
            // 标记本次是否触发了弱匹配统计参数的强制重置，记录样本量超限状态
            forcedReset: effectiveAlpha + effectiveBeta > 7,
            // 截取新增条目的前40个字符作为描述摘要，快速定位本次匹配的业务内容
            incomingDesc: (newItem.description || "").substring(0, 40),
          });
          // 当前新增条目已完成弱匹配累积全流程，跳过后续处理逻辑进入下一个新增条目循环
          continue;
        }
      }

      // 当系统未启用嵌入向量能力，且新条目描述文本长度达到最短有效描述阈值时，进入冷启动缓冲流程
      if (!useEmbedding && newItem.description.length >= minDescLen) {
        // 标记当前条目是否为用户主动创建的显式条目，满足任一条件即判定为显式条目：
        // 1. 条目分类标记为"explicit"（显式创建）；2. 证据链包含"manual-write"（人工录入标记）
        const isExplicit =
          (newItem as any).category === "explicit" ||
          (Array.isArray((newItem as any).evidence) &&
            (newItem as any).evidence.includes("manual-write"));
        // 仅对非显式的自动采集条目执行冷启动缓冲逻辑，用户主动创建的条目直接跳过缓冲流程
        if (!isExplicit) {
          // 将当前新条目推入对应类型的冷启动缓冲队列，队列键名为itemType拼接"s"的复数形式
          (this.coldBuffer as any)[itemType + "s"].push(newItem);
          // 当对应类型的冷启动缓冲队列长度超过50条上限时，移除队列最早加入的条目实现FIFO限流
          if ((this.coldBuffer as any)[itemType + "s"].length > 50) {
            (this.coldBuffer as any)[itemType + "s"].shift();
          }
          // 持久化更新冷启动缓冲数据，将内存中的队列状态写入存储介质
          this.saveColdBuffer();
          // 输出条目进入冷启动缓冲的系统日志，记录核心上下文参数用于链路追踪与容量监控
          log("profile cold start: buffered", {
            type: itemType,
            cat: newItem.category,
            bufferSize: (this.coldBuffer as any)[itemType + "s"].length,
          });
          // 当前条目已完成冷启动缓冲全流程，跳过后续所有处理逻辑直接进入下一个新增条目循环
          continue;
        }
      }

      // 初始化语义质心向量，用于存储新条目生成的动态语义中心向量
      let initCentroid: number[] | undefined;
      // 初始化语义锚点向量，用于存储新条目生成的原始语义基准向量
      let initAnchor: number[] | undefined;
      // 仅当系统启用嵌入向量能力，且新条目描述长度达到最短有效描述阈值时，执行向量生成逻辑
      if (useEmbedding && newItem.description.length >= minDescLen) {
        // 捕获向量生成过程中可能出现的异常，避免因嵌入服务故障阻断整个流程
        try {
          // 对新条目描述文本先做标准化处理，再调用嵌入模型生成语义向量
          const emb = await embed.embed(normalizeDescription(newItem.description));
          // 将嵌入模型返回的向量转换为普通数组，存入初始化的质心向量变量
          initCentroid = Array.from(emb);
          // 初始锚点向量与质心向量保持完全一致，锚点作为语义基准不会随后续匹配更新
          initAnchor = initCentroid;
          // 静默捕获所有异常，向量生成失败时继续流程，新条目将以无向量状态创建
        } catch {}
      }

      // 调用条目初始化方法创建完整的新画像条目，传入生成的语义向量，追加到存量条目数组末尾
      existing.push(this.initItem(newItem, itemType, initCentroid, initAnchor) as T);
      // 新增条目计数器加一，累计本次流程中成功创建的全新画像条目数量
      newCount++;
      // 打印无匹配新增条目日志，记录新条目核心业务参数用于链路追踪与数据统计
      log("profile no match: appended new", {
        // 当前创建的条目类型（偏好/模式/工作流），区分不同业务场景的新增数据
        type: itemType,
        // 新条目的业务分类，用于后续同分类/跨分类匹配的分类归属校验
        cat: newItem.category,
        // 截取新条目描述的前40个字符作为日志摘要，快速定位新增条目的业务内容
        desc: (newItem.description || "").substring(0, 40),
      });
    }

    // 输出合并完成日志，记录本次处理的核心统计数据
    log("profile merge done", {
      // 当前处理的条目类型，区分偏好/模式/工作流等业务场景
      type: itemType,
      // 本次流程中成功匹配合并的条目总数
      matched: matchCount,
      // 本次流程中新增创建的条目总数
      appended: newCount,
      // 合并完成后存量数组的最终长度
      existingAfter: existing.length,
    });

    // 返回处理完成的条目数组，完成类型断言确保类型安全
    return existing as T[];
  }

  /**
   * Merge a new confirmed observation into an existing profile entry.
   * ONLY call for confirmed matches (exact, strong sameCat/crossCat, Thompson upgrade).
   * Do NOT call for forced merge or cross-validation — those handle fields directly.
   */
  // 将已确认匹配的新增观测数据合并到现有画像条目
  // 仅对已确认匹配的场景调用本方法（精确匹配、同分类/跨分类强匹配、汤普森采样升级场景）
  // 禁止在强制合并或交叉验证流程中调用本方法，上述场景会直接处理字段更新
  private mergeConfirmedMatch(
    existing: any, // 存量画像条目
    newItem: any, // 新增待合并条目
    itemType: string, // 条目类型（偏好/模式/工作流）
    sameCat: boolean // 新增条目与存量条目是否属于同一业务分类
  ): any {
    // 对存量条目执行alpha参数懒迁移，兼容旧版本数据结构，确保统计参数完整性
    this.lazyMigrateAlpha(existing);
    // 合并并去重新增条目与存量条目的证据链，通过Set自动去重保留唯一证据
    const evidence = [
      ...new Set([
        newItem.description, // 新增条目的描述文本
        ...this.ensureArray(newItem.evidence), // 新增条目证据链数组，ensureArray处理空值场景
        ...this.ensureArray(existing.evidence), // 存量条目证据链数组，ensureArray处理空值场景
      ]),
    ].slice(0, 10); // 最多保留10条最新证据，避免数据冗余

    // 当新增条目与存量条目属于同一业务分类时，执行同分类场景的合并逻辑
    if (sameCat) {
      // 创建合并后的结果对象，继承存量条目所有基础属性
      const result = {
        ...existing,
        // 置信度正例参数alpha累增1，同分类匹配贡献完整的置信度权重增量
        alpha: existing.alpha + 1,
        // 置信度负例参数beta保留原存量值，无有效历史值则默认初始化为1
        beta: existing.beta ?? 1,
        // 重置弱匹配统计的alpha值为初始状态，清空历史弱匹配累积观测
        weakAlpha: 1,
        // 同步重置弱匹配统计的beta值为初始状态，与weakAlpha保持初始化一致
        weakBeta: 1,
        // 访问频率在原有基础上累加1，记录本次同分类匹配的活跃次数
        frequency: (existing.frequency || 1) + 1,
        // 传入预处理完成的去重证据链数组，保留合并后的所有唯一证据
        evidence,
        // 更新条目最后活跃时间戳为当前时间，记录本次合并的时间节点
        lastSeen: Date.now(),
        // 更新条目最后匹配时间戳为当前时间，标记本次成功匹配的发生时刻
        lastMatchTime: Date.now(),
        // 若当前处理的是工作流类型条目且新增条目包含有效步骤数组，同步更新工作流步骤
        ...(itemType === "workflow" && newItem.steps?.length ? { steps: newItem.steps } : {}),
      };
      // 调用置信度同步方法，基于更新后的统计参数重新计算条目综合置信度
      this.syncConfidence(result);
      // 返回合并完成的结果对象，完成本次同分类条目的融合流程
      return result;
    }

    // 创建跨分类场景的合并结果对象，继承存量条目全部基础属性
    const result = {
      ...existing,
      // 跨分类匹配置信度正例参数仅累加0.5，平衡跨分类匹配的置信度贡献权重
      alpha: existing.alpha + 0.5,
      // 置信度负例参数beta继承存量值，无有效历史值则初始化为1保证统计合法性
      beta: existing.beta ?? 1,
      // 重置弱匹配统计的alpha值为初始状态，清空历史弱匹配累积观测
      weakAlpha: 1,
      // 同步重置弱匹配统计的beta值为初始状态，与weakAlpha保持初始化一致
      weakBeta: 1,
      // 传入预处理完成的去重证据链数组，保留合并后的所有唯一证据
      evidence,
      // 更新条目最后活跃时间戳为当前时间，记录本次跨分类合并的时间节点
      lastSeen: Date.now(),
      // 更新条目最后匹配时间戳为当前时间，标记本次跨分类成功匹配的发生时刻
      lastMatchTime: Date.now(),
      // 若当前处理的是工作流类型条目且新增条目包含有效步骤数组，同步更新工作流步骤
      ...(itemType === "workflow" && newItem.steps?.length ? { steps: newItem.steps } : {}),
    };
    // 调用置信度同步方法，基于更新后的统计参数重新计算条目综合置信度
    this.syncConfidence(result);
    // 返回合并完成的结果对象，完成本次跨分类条目的融合流程
    return result;
  }

  // 初始化一个新的画像条目实例，为所有统计属性和语义属性设置默认初始值
  private initItem(newItem: any, itemType: string, centroid?: number[], anchor?: number[]): any {
    // 校验新增条目是否携带有效证据链：需为数组且包含至少一条证据记录
    const hasEvidence = Array.isArray(newItem.evidence) && newItem.evidence.length > 0;
    // 构造完整的画像条目对象，继承新条目所有原生属性并初始化系统核心统计字段
    const item = {
      ...newItem,
      // 贝塔分布置信度正例参数alpha：有证据的条目初始化为1，无证据的冷启动条目设为0.3降低初始权重
      alpha: hasEvidence ? 1 : 0.3,
      // 贝塔分布置信度负例参数beta：有证据的条目初始化为1，无证据条目设为1.5拉低初始置信度均值
      beta: hasEvidence ? 1 : 1.5,
      // 弱匹配场景汤普森采样正例参数，所有新条目统一从初始值1开始累积观测
      weakAlpha: 1,
      // 弱匹配场景汤普森采样负例参数，与weakAlpha同步初始化保证统计合法性
      weakBeta: 1,
      // 条目综合置信度：有证据的条目继承传入值或默认0.5，无证据条目初始化为0.2标记低可信度
      confidence: hasEvidence ? (newItem.confidence ?? 0.5) : 0.2,
      // 条目访问频率初始化为1，记录该画像首次被创建的活跃次数
      frequency: 1,
      // 条目最后活跃时间戳，初始化为当前时间标记创建时刻
      lastSeen: Date.now(),
      // 条目最后成功匹配时间戳，创建时与活跃时间保持一致
      lastMatchTime: Date.now(),
      // 条目首次被创建的时间戳，作为条目生命周期的起始锚点永久记录
      firstSeen: Date.now(),
      // 证据链数组，若新条目未传入证据则初始化为空数组避免空值异常
      evidence: newItem.evidence ?? [],
      // 弱匹配连续命中计数器，新条目初始化为0等待后续匹配累积
      weakHitCount: 0,
      // 语义漂移连续低于阈值次数，新条目初始化为0等待后续漂移检测
      driftBelowCount: 0,
      // 条目待验证状态标记，所有新条目默认开启，需通过后续观测验证有效性
      pendingValidation: true,
      // 语义动态质心向量，传入的初始化向量作为条目初始语义中心
      centroid,
      // 语义原始锚点向量，传入的初始化向量作为条目永久语义基准
      anchor,
      // 若当前创建的是工作流类型条目且新条目包含有效步骤数组，同步保留步骤属性到新条目
      ...(itemType === "workflow" && newItem.steps?.length ? { steps: newItem.steps } : {}),
    };
    // 调用置信度同步方法，基于初始化的alpha和beta参数计算条目初始综合置信度
    this.syncConfidence(item);
    // 返回初始化完成的画像条目，完成新条目创建流程
    return item;
  }

  /**
   * Three-way merge: item1 + item2 + newItem → single combined entry.
   * Called when top-1 and top-2 both strongly match the same new observation
   * within the same category, confirming they describe the same behavior.
   * 三向合并：将两个存量条目和一个新条目融合为单一的合并条目
   * 当同分类下的Top1和Top2存量条目都与新增观测强匹配时触发，确认三个条目描述同一用户行为
   */
  private combineThree(
    item1: any,
    item2: any,
    newItem: any,
    itemType: string,
    newEmb: number[],
    top1Score: number
  ): any {
    // 对第一个存量条目执行alpha参数懒迁移，兼容旧版数据结构，保证统计参数完整性
    this.lazyMigrateAlpha(item1);
    // 对第二个存量条目执行alpha参数懒迁移，同上确保两个存量条目都适配最新统计逻辑
    this.lazyMigrateAlpha(item2);
    // 合并三个条目的访问频率：两个存量条目原有频率相加，新增本次匹配的1次活跃计数
    const freq = (item1.frequency || 1) + (item2.frequency || 1) + 1;
    // 收集所有条目的证据链源数据，统一转为数组格式避免空值异常
    const evidenceSources = [
      ...this.ensureArray(newItem.evidence),
      ...this.ensureArray(item1.evidence),
      ...this.ensureArray(item2.evidence),
    ];
    // 对证据链去重并截断至最多保留10条，避免数据冗余，保证证据链的精炼性
    const evidence = [...new Set(evidenceSources)].slice(0, 10);
    // 按权重融合三个条目的语义质心向量，通过L2归一化生成合并后的新质心
    const centroid = l2Normalize(
      item1.centroid.map(
        (v: number, i: number) =>
          // 第一个存量条目质心权重、第二个存量条目质心权重、新增条目质心权重加权求和
          THREE_WAY_CENTROID_W1 * v +
          THREE_WAY_CENTROID_W2 * (item2.centroid[i] ?? 0) +
          THREE_WAY_CENTROID_W3 * (newEmb[i] ?? 0)
      )
    );
    // 语义锚点继承第一个存量条目的原始锚点，保持语义基准的连续性
    const anchor = item1.anchor;
    // 判断新增条目的描述是否比第一个存量条目的描述更简短
    const newIsShorter = newItem.description.length < (item1.description?.length || Infinity);
    // 描述文本选择逻辑：匹配得分超过0.9且新增描述更简短时优先用新描述，否则保留原条目描述
    const description = top1Score > 0.9 && newIsShorter ? newItem.description : item1.description;
    // 工作流步骤处理逻辑：仅对工作流类型条目执行步骤合并，选择步骤更长的条目保留
    const steps =
      itemType === "workflow" && (item1.steps || item2.steps)
        ? item1.steps?.length && item1.steps.length >= (item2.steps?.length || 0)
          ? item1.steps
          : item2.steps
        : newItem.steps;
    // 构造合并后的最终条目对象，继承第一个存量条目的所有基础属性
    const result = {
      ...item1,
      description,
      frequency: freq,
      evidence,
      centroid,
      anchor,
      // 累加固有置信度正例参数：三个条目各自的alpha值相加，合并置信度的正例统计
      alpha: (item1.alpha || 1) + (item2.alpha || 1) + 1,
      // 累加固有置信度负例参数：两个存量条目的beta值相加，合并置信度的负例统计
      beta: (item1.beta || 1) + (item2.beta || 1),
      // 重置弱匹配汤普森采样的正例参数为初始值1，清空历史弱匹配累积观测
      weakAlpha: 1,
      // 同步重置弱匹配汤普森采样的负例参数为初始值1，与weakAlpha保持初始化状态
      weakBeta: 1,
      // 清零弱匹配连续命中计数器，合并后重新开始弱匹配状态统计
      weakHitCount: 0,
      // 清零语义漂移连续低于阈值次数，合并后重置漂移检测的历史统计
      driftBelowCount: 0,
      // 更新条目最后活跃时间戳为当前时间，记录本次合并的时间节点
      lastSeen: Date.now(),
      // 更新条目最后匹配时间戳为当前时间，标记本次成功合并的发生时刻
      lastMatchTime: Date.now(),
      // 若存在有效工作流步骤，将步骤属性注入合并后的条目对象
      ...(steps ? { steps } : {}),
    };
    // 调用置信度同步方法，基于更新后的统计参数重新计算合并条目的综合置信度
    this.syncConfidence(result);
    // 返回合并完成的最终条目对象，完成三向合并全流程
    return result;
  }

  /**
   * 安全类型转换工具方法：将任意输入值统一转换为标准数组格式
   * 核心解决业务场景中证据链等数组型字段可能出现的字符串序列化、空值、非法类型等异常问题
   * @param val - 待转换的输入值，类型可为任意（字符串、数组、null、undefined等）
   * @returns 转换后的标准数组，若输入无法转换则返回空数组保证后续流程安全
   */
  private ensureArray(val: any): any[] {
    // 分支1：输入值为字符串类型，尝试解析JSON格式的序列化数组
    if (typeof val === "string") {
      try {
        // 解析字符串为JSON对象，兼容历史数据中存储的序列化数组字符串
        const parsed = JSON.parse(val);
        // 解析结果为有效数组则直接返回，否则返回空数组避免非法值流入业务逻辑
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        // JSON解析失败捕获异常，记录错误上下文用于问题排查，截断长字符串避免日志溢出
        log("ensureArray: failed to parse JSON string, returning []", {
          val: String(val).substring(0, 100),
          error: String(e),
        });
        // 解析失败时返回空数组，保证上层调用的数组操作不会抛出类型错误
        return [];
      }
    }
    // 分支2：非字符串输入，直接判断类型，合法数组返回原数组，其他所有类型返回空数组
    return Array.isArray(val) ? val : [];
  }

  /**
   * 判断条目访问频率是否达到演化里程碑节点
   * 里程碑是触发条目描述演化和语义质心更新的核心条件
   * @param frequency - 条目当前的累计访问频率
   * @returns 是否满足演化触发的里程碑条件
   */
  private isMilestone(frequency: number): boolean {
    // 访问频率≤20时，仅在固定节点触发演化：第2、5、10、20次访问，控制低访问量下的演化频次
    if (frequency <= 20) return [2, 5, 10, 20].includes(frequency);
    // 访问频率超过20后，每累计20次访问触发一次演化，维持高频条目的定期更新节奏
    return frequency % 20 === 0;
  }

  /**
   * 获取条目演化所需的最低证据链长度要求
   * 只有当条目积累的有效证据数达到该阈值时，才允许触发描述演化流程
   * @param _itemType - 条目类型（偏好/模式/工作流），当前实现统一阈值，预留分类定制能力
   * @returns 触发演化所需的最小证据数量
   */
  private minEvidenceForEvolve(_itemType: string): number {
    // 固定最低需要4条有效证据，确保演化有足够的观测样本支撑，避免基于过少数据的无效演化
    return 4;
  }

  syncConfidence(item: any): void {
    // 读取置信度计算的正例观测数，无有效值时默认初始化为1
    const alpha = item.alpha ?? 1;
    // 读取置信度计算的负例观测数，无有效值时默认初始化为1
    const beta = item.beta ?? 1;
    // 计算贝塔分布的均值，作为置信度的核心基准值
    const betaMean = alpha / (alpha + beta);
    // 从配置中读取置信度衰减阈值天数，转换为毫秒单位用于时间计算
    const decayThreshold = CONFIG.userProfileConfidenceDecayDays * 24 * 60 * 60 * 1000;
    // 读取条目累计访问频率，无有效值时默认初始化为1
    const freq = item.frequency || 1;
    // 计算置信度的半衰期：访问频率越高，半衰期越长，置信度衰减越慢
    const halfLife = decayThreshold * (1 + Math.log2(1 + freq));
    // 计算条目距离最后一次活跃的时间跨度（毫秒）
    const age = Date.now() - (item.lastSeen || Date.now());
    // 计算超出衰减阈值的闲置时长，未超出阈值则为0，不触发衰减
    const ageMs = Math.max(0, age - decayThreshold);
    // 基于指数衰减模型计算时间衰减因子，闲置越久因子值越低
    const timeFactor = Math.exp((-Math.LN2 * ageMs) / halfLife);
    // 读取条目最后一次成功匹配的时间戳，无有效匹配时间则 fallback 到最后活跃时间
    const matchTime = item.lastMatchTime || item.lastSeen || Date.now();
    // 计算距离最后一次成功匹配的天数，用于趋势因子计算
    const matchAge = (Date.now() - matchTime) / (24 * 60 * 60 * 1000);
    // 计算趋势乘数：最近30天内有成功匹配的条目可保留更高置信度，长期无匹配则逐步回落至0.8
    const trendMultiplier = 0.8 + 0.2 * Math.exp(-matchAge / 30);
    // 最终置信度为基准均值 × 时间衰减因子与趋势乘数中的较小值，综合生成条目当前置信度
    item.confidence = betaMean * Math.min(timeFactor, trendMultiplier);
  }

  /**
   * 旧版画像条目数据结构懒迁移方法：为缺失核心统计字段的旧条目补全初始化值，确保所有条目统一适配新版统计逻辑
   * 核心解决版本迭代过程中，存量旧数据缺少alpha/beta等统计参数导致的置信度计算异常问题
   * @param item - 需要迁移的画像条目实例，支持任意类型以兼容旧版数据结构
   */
  private lazyMigrateAlpha(item: any): void {
    // 判定当前条目是否需要执行alpha参数迁移：两种场景触发迁移
    // 1. 旧版条目完全未初始化alpha字段，值为undefined
    // 2. 旧版条目使用过渡期的临时初始值(alpha=0.5且beta=1.5)，需要更新为新版标准初始值
    const needsAlphaMigration =
      item.alpha === undefined || (item.alpha === 0.5 && item.beta === 1.5);
    // 命中迁移条件，执行核心参数补全与校正逻辑
    if (needsAlphaMigration) {
      // 读取条目当前的置信度值，缺失时兜底为1.0（对应完全可信的条目状态）
      const conf = item.confidence ?? 1.0;
      // 高置信度条目（置信度≥1.0，历史上的全可信标记条目）的alpha值计算逻辑
      // 基于条目访问频率生成基础alpha：基础值1 + 访问次数×0.5，保留历史访问量的权重累积
      if (conf >= 1.0) {
        item.alpha = 1 + (item.frequency || 1) * 0.5;
      } else {
        // 普通置信度条目，通过当前置信度反推符合贝塔分布统计的alpha值
        // 公式推导：conf=alpha/(alpha+beta) → alpha=conf*beta/(1-conf)，beta固定为1时简化为conf/(1-conf)
        // 加入0.01的平滑因子避免分母为零的极端计算异常，保证数值稳定性
        item.alpha = conf / (1 - conf + 0.01);
      }
      // 所有迁移条目的beta值统一初始化为1，符合新版贝塔分布统计的基础假设
      item.beta = 1;
    }
    // 补全弱匹配场景汤普森采样的正例统计参数，缺失时默认初始化为1，开启新一轮弱匹配观测累积
    item.weakAlpha = item.weakAlpha ?? 1;
    // 补全弱匹配场景汤普森采样的负例统计参数，缺失时默认初始化为1，与weakAlpha保持统计一致性
    item.weakBeta = item.weakBeta ?? 1;
    // 补全条目最后成功匹配时间戳，缺失时 fallback 到最后活跃时间，再缺失则用当前时间兜底
    // 保证所有条目都有合法的匹配时间标记，用于后续置信度的时间衰减计算
    item.lastMatchTime = item.lastMatchTime ?? item.lastSeen ?? Date.now();
    // 补全条目首次创建时间戳，缺失时 fallback 到最后活跃时间，再缺失则用当前时间兜底
    // 永久记录条目生命周期的起始节点，用于长周期的画像演化分析
    item.firstSeen = item.firstSeen ?? item.lastSeen ?? Date.now();
    // 补全待验证状态标记，旧版条目缺失该字段时默认设为false，即已通过初始验证
    // 避免旧条目持续处于待验证状态，无法参与正常的匹配与演化流程
    if (item.pendingValidation === undefined) {
      item.pendingValidation = false;
    }
    // 调用置信度同步方法，基于更新后的所有统计参数重新计算条目当前的综合置信度
    // 确保迁移完成后条目的置信度值符合新版计算逻辑，状态完全同步
    this.syncConfidence(item);
  }

  /**
   * 画像条目冲突检测与自动修复方法：识别并解决同一分类下的语义冲突偏好
   * 核心定位互斥矛盾的用户偏好（如同时喜欢"吃辣"和"完全不能吃辣"），通过置信度惩罚实现长期自我修正
   * @param items - 当前处理的画像条目数组，包含所有待检测的存量条目
   * @param itemType - 条目类型，区分偏好/模式/工作流等不同业务场景
   * @param profileId - 用户唯一标识，用于链路追踪和多用户隔离
   */
  private async detectConflicts(items: any[], itemType: string, profileId: string): Promise<void> {
    // 初始化冲突候选集，存储所有疑似存在语义冲突的条目对及其余弦相似度
    const candidates: { a: any; b: any; cos: number }[] = [];
    // 缓存条目总数，避免循环中重复读取length属性优化性能
    const limit = items.length;
    // 双层循环遍历所有条目组合，生成全量两两配对的候选池
    for (let i = 0; i < limit; i++) {
      for (let j = i + 1; j < limit; j++) {
        // 仅检测同一分类下的条目，跨分类偏好天然不存在互斥冲突，直接跳过
        if (items[i].category !== items[j].category) continue;
        // 提取两个条目的语义质心向量，用于后续余弦相似度计算
        const c1 = items[i].centroid as number[] | undefined;
        const c2 = items[j].centroid as number[] | undefined;
        // 任意一条目缺失质心向量则无法参与语义计算，跳过该组合
        if (!c1 || !c2) continue;
        // 计算两个质心向量的余弦相似度，量化语义重合程度
        const cos = cosineSimilarityNumbers(c1, c2);
        // 仅将相似度落在[0.65,0.9)区间的条目对纳入冲突候选：
        // 低于0.65语义差异过大不可能冲突，高于0.9会被常规去重逻辑合并，无需重复处理
        if (cos >= 0.65 && cos < 0.9) {
          candidates.push({ a: items[i], b: items[j], cos });
        }
      }
    }
    // 无任何冲突候选则直接退出流程，避免无意义的后续计算
    if (candidates.length === 0) return;
    // 单轮流程最多处理3个冲突，控制LLM调用量避免过量请求，同时防止单次处理过度修改数据
    const maxChecks = 3;
    // 按余弦相似度降序排序，优先处理语义重合度更高的疑似冲突条目
    candidates.sort((x, y) => y.cos - x.cos);
    // 记录已成功处理的冲突数量，用于触发maxChecks阈值终止
    let checked = 0;
    // 存储待删除条目在原数组中的索引，后续统一批量删除避免数组遍历时的索引错乱
    const removeIndices: number[] = [];
    // 遍历所有排序后的冲突候选条目
    for (const { a, b, cos } of candidates) {
      // 已达最大处理数量，终止后续流程控制资源消耗
      if (checked >= maxChecks) break;
      // 任意一个条目已被标记为待删除，跳过该组合避免重复处理
      if (removeIndices.includes(items.indexOf(a)) || removeIndices.includes(items.indexOf(b)))
        continue;
      // 调用大语言模型执行实际语义冲突判定，确认两个条目是否真的互斥
      const conflict = await this.checkConflict(a.description, b.description);
      // LLM判定存在真实语义冲突，进入冲突解决流程
      if (conflict) {
        // 成功处理的冲突计数加一，累计触发阈值
        checked++;
        // 保留访问频率更高的条目作为主条目，高频条目代表用户更稳定的长期行为
        const keeper = (a.frequency || 0) >= (b.frequency || 0) ? a : b;
        // 确定要删除的低频次条目，作为冲突的牺牲对象
        const removed = keeper === a ? b : a;
        // 对保留条目执行懒迁移，补全所有缺失的统计字段确保参数合法性
        this.lazyMigrateAlpha(keeper);
        // 对待删除条目执行懒迁移，确保迁移后的alpha/beta参数可正确合并
        this.lazyMigrateAlpha(removed);
        // 缓存保留条目冲突处理前的原始alpha值，用于日志记录置信度衰减幅度
        const oldAlpha = keeper.alpha || 1;
        // 对保留条目的置信度正例参数施加25%的惩罚，修正历史错误累积的过高置信度
        keeper.alpha *= 0.75;
        // 将惩罚的0.25倍原始alpha值转移到负例参数beta，动态维持贝塔分布的统计合理性
        keeper.beta = (keeper.beta || 1) + 0.25 * oldAlpha;
        // 合并待删除条目剩余的alpha值到保留条目，回收部分有效观测权重
        keeper.alpha += removed.alpha || 0;
        // 合并两个条目的访问频率，保留完整的用户行为活跃次数统计
        keeper.frequency = (keeper.frequency || 0) + (removed.frequency || 0);
        // 合并并去重两个条目的证据链，最多保留10条最新证据避免数据冗余
        keeper.evidence = [
          ...new Set([...this.ensureArray(keeper.evidence), ...this.ensureArray(removed.evidence)]),
        ].slice(0, 10);
        // 特殊处理工作流类型条目：保留步骤更长的工作流定义，更完整的步骤代表更成熟的行为序列
        if (itemType === "workflow") {
          keeper.steps =
            keeper.steps?.length >= (removed.steps?.length || 0) ? keeper.steps : removed.steps;
        }
        // 获取待删除条目在原数组中的索引，用于后续批量删除
        const removedIdx = items.indexOf(removed);
        // 索引合法则加入待删除列表，标记该条目需从原数组中清除
        if (removedIdx >= 0) removeIndices.push(removedIdx);
        // 重新计算保留条目的综合置信度，基于更新后的alpha/beta参数生成最新置信度值
        this.syncConfidence(keeper);
        // 打印冲突解决完成的系统日志，记录核心参数用于链路追踪和问题复盘
        log("profile conflict detected: resolved", {
          type: itemType,
          keeper: (keeper.description || "").substring(0, 40),
          removed: (removed.description || "").substring(0, 40),
          cos: Math.round(cos * 100) / 100,
          alphaDrop: `${Math.round(oldAlpha)}→${Math.round(keeper.alpha)}`,
        });
      }
    }
    // 从后往前遍历待删除索引，倒序删除避免前置删除导致后续索引失效的经典数组操作问题
    for (let i = removeIndices.length - 1; i >= 0; i--) {
      items.splice(removeIndices[i]!, 1);
    }
  }

  /**
   * 检测两个用户行为/偏好描述是否为语义重复条目
   * 核心解决不同表述但描述同一用户行为的冗余条目合并场景，是画像去重流程的核心依赖方法
   * @param descA - 第一个待检测的条目描述文本
   * @param descB - 第二个待检测的条目描述文本
   * @returns 布尔值标记两个描述是否语义等价，true表示为重复条目可合并
   */
  private async checkSemanticDuplicate(descA: string, descB: string): Promise<boolean> {
    const prompt = `Do these two descriptions refer to the same user behavior, preference, or pattern? Answer only whether they are semantically equivalent (same meaning, different wording).

A: "${descA}"
B: "${descB}"

Answer JSON only: { "duplicate": true|false, "reason": "one sentence explanation" }`;

    // 检查是否已配置开源代码模型的提供商标识和具体模型名称，满足基础调用条件才进入原生逻辑分支
    if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
      // 捕获原生调用流程中所有可能的异常，避免单条去重检测失败阻断整个画像处理流程
      try {
        // 动态导入zod库的核心类型定义对象，用于构建LLM输出的结构校验Schema
        const { z } = await import("zod");
        // 从开源代码提供商的加载工具中导入结构化输出生成方法，该方法封装了LLM调用与格式校验逻辑
        const { generateStructuredOutput } = await loadOpencodeProvider();
        // 导入获取开源代码客户端实例的工厂方法，该客户端封装了与模型服务的底层通信能力
        const { getOpenCodeClient } = await import("../ai/profile-llm-client.js");

        // 声明客户端实例变量，初始化为undefined，后续根据连接结果填充有效实例
        let v2Client;
        // 捕获客户端初始化过程中的连接异常，防止服务不可用导致流程崩溃
        try {
          // 调用工厂方法异步获取开源代码客户端的可用实例，建立与模型服务的连接
          v2Client = await getOpenCodeClient();
        } catch (e) {
          // 客户端连接失败时输出系统日志，记录错误上下文便于链路追踪与问题排查
          log("profile dedup check: native provider not connected", { error: String(e) });
        }

        // 仅当成功获取到有效客户端实例时，才执行后续的LLM语义去重检测逻辑
        if (v2Client) {
          // 通过Promise.race实现超时控制，同时发起结构化输出请求和30秒超时定时器，先完成的任务决定结果
          const result: any = await Promise.race([
            // 调用结构化输出生成方法，传入所有必要参数调用LLM完成语义重复检测
            generateStructuredOutput({
              // 传入已初始化的开源代码客户端实例，用于底层API通信
              client: v2Client,
              // 传入配置中的提供商标识，用于多提供商场景下的路由选择
              providerID: CONFIG.opencodeProvider,
              // 传入配置中的具体模型名称，指定本次调用的底层推理模型
              modelID: CONFIG.opencodeModel,
              // 传入给LLM的系统提示词，定义模型的角色定位与输出格式要求
              systemPrompt: "You are a semantic duplicate detector. Output valid JSON.",
              // 传入拼接好的用户提示词，包含待检测的两个条目描述文本
              userPrompt: prompt,
              // 传入zod构建的结构校验Schema，强制要求LLM输出包含duplicate和reason字段的合法JSON
              schema: z.object({ duplicate: z.boolean(), reason: z.string() }),
            }),
            // 初始化超时控制Promise，30秒后主动触发拒绝，避免无限等待模型响应
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("dedup check timeout")), 30000)
            ),
          ]);
          // 成功获取LLM返回结果后，提取duplicate字段作为返回值，非法值时默认返回false保证流程安全
          return result.duplicate || false;
        }
      } catch (e) {
        // 捕获原生调用流程中所有未处理的异常，输出错误日志后回退到外部API调用逻辑
        log("profile dedup check: native provider failed", { error: String(e) });
      }
    }

    // 检查是否配置了内存模型和API地址，确保外部调用的前置条件满足
    if (CONFIG.memoryModel && CONFIG.memoryApiUrl) {
      // 捕获外部API调用全流程异常，避免单个检测失败阻断整个去重流程
      try {
        // 发起POST请求调用大模型聊天补全接口，拼接完整的API请求地址
        const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
          method: "POST", // 指定HTTP请求方法为POST，符合大模型API的通用调用规范
          headers: {
            "Content-Type": "application/json", // 设置请求体类型为JSON，服务端可正确解析参数
            Authorization: `Bearer ${CONFIG.memoryApiKey || ""}`, // 注入API密钥完成身份校验，无密钥时传入空字符串兜底
          },
          body: JSON.stringify({
            model: CONFIG.memoryModel, // 指定调用的大模型名称，与服务端部署的模型标识保持一致
            messages: [
              // 构造大模型要求的对话消息数组，包含系统角色提示和用户查询
              {
                role: "system", // 系统角色消息，定义模型的身份与输出要求
                content: "You are a semantic duplicate detector. Output valid JSON.",
              },
              { role: "user", content: prompt }, // 用户角色消息，传入拼接好的待检测描述和任务要求
            ],
            temperature: 0, // 将采样温度设为0，强制模型输出最确定的结果，避免随机生成的冗余内容干扰检测
            response_format: { type: "json_object" }, // 要求模型返回严格的JSON格式，避免非结构化输出解析失败
          }),
          signal: AbortSignal.timeout(30000), // 设置30秒请求超时，防止无限等待服务端响应阻塞流程
        });
        // 响应状态码非2xx类成功值时直接返回false，标记本次去重检测失败
        if (!response.ok) return false;
        // 解析响应体的JSON数据，提取大模型返回的原始结果
        const data: any = await response.json();
        // 从响应结果中提取模型生成的内容，处理多层可选链避免空值抛出异常
        const content = data.choices?.[0]?.message?.content;
        // 提取的内容为空时返回false，无法完成语义重复判定
        if (!content) return false;
        // 解析JSON格式的模型输出，获取结构化的检测结果
        const parsed = JSON.parse(content);
        // 返回模型判定的重复标记，非法值时默认返回false保证流程安全
        return parsed.duplicate || false;
      } catch (e) {
        // 捕获调用流程中所有未处理的异常，输出错误日志便于链路追踪与问题排查
        log("profile dedup check: external API failed", { error: String(e) });
      }
    }

    // 所有调用路径都未成功获取检测结果时，默认返回false，结束本次去重检测
    return false;
  }

  /**
   * 画像条目语义去重核心方法：识别并合并同一分类下语义重复的冗余条目
   * 通过语义相似度筛选+LLM深度校验的两级流程，消除画像库中的重复行为记录
   * @param items - 当前处理的画像条目数组，包含所有待去重的存量条目
   * @param itemType - 条目类型，区分偏好/模式/工作流等不同业务场景
   * @param profileId - 用户唯一标识，用于链路追踪和多用户隔离
   */
  private async deduplicateItems(
    items: any[],
    itemType: string,
    profileId?: string
  ): Promise<void> {
    // 无有效用户标识或条目数量不足2条时直接退出，无需执行去重流程
    if (!profileId || items.length < 2) return;

    // 从实例缓存中获取已校验过的条目对集合，避免重复调用LLM浪费资源
    const checkedPairs = this.dedupCheckedCache;
    // 单轮去重流程最多允许调用5次LLM，控制API调用成本避免过度消耗
    const maxLLMCalls = 5;
    // 记录当前轮次已发起的LLM调用次数，用于触发maxLLMCalls阈值
    let llmCalls = 0;
    // 记录命中缓存跳过的条目对数量，用于后续日志统计去重效率
    let skippedCached = 0;

    // 创建分类分组映射，将所有条目按业务分类聚合，仅同分类内的条目可能存在重复
    const byCategory = new Map<string, typeof items>();
    // 遍历所有待去重条目，完成分类分组的初始化与填充
    for (const item of items) {
      // 提取条目的业务分类，缺失分类时默认归入"未分类"组保证处理完整性
      const cat = item.category || "_uncategorized";
      // 当前分类尚未创建分组时，初始化空数组作为该分类的条目容器
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      // 将当前条目添加到对应分类的条目数组中，完成分组聚合
      byCategory.get(cat)!.push(item);
    }

    // 遍历所有分类分组，逐组执行同分类内的语义去重检测
    for (const [, group] of byCategory) {
      // 当前分组条目数不足2条，无法产生重复配对，直接跳过该组处理
      if (group.length < 2) continue;

      // 初始化语义重复候选集，存储所有疑似重复的条目对及其余弦相似度
      const candidates: { a: any; b: any; cos: number }[] = [];
      // 双层循环遍历分组内所有条目组合，生成全量两两配对的候选池
      for (let i = 0; i < group.length; i++) {
        // 遍历后续未配对的条目，避免同一组合重复计算
        for (let j = i + 1; j < group.length; j++) {
          // 提取两个条目的语义质心向量，用于后续余弦相似度计算
          const c1 = group[i].centroid as number[] | undefined;
          const c2 = group[j].centroid as number[] | undefined;
          // 任意一个条目缺失质心向量则无法参与语义计算，跳过该组合
          if (!c1 || !c2) continue;
          // 计算两个质心向量的余弦相似度，量化语义重合程度
          const cos = cosineSimilarityNumbers(c1, c2);
          // 相似度≥0.5的条目对纳入候选集：低于阈值语义差异过大，无需调用LLM校验
          if (cos >= 0.5) {
            candidates.push({ a: group[i], b: group[j], cos });
          }
        }
      }

      // 无任何疑似重复的候选条目，直接跳过该组后续处理
      if (candidates.length === 0) continue;
      // 按余弦相似度降序排序候选集，优先处理语义重合度更高的条目对
      candidates.sort((x, y) => y.cos - x.cos);

      // 存储待删除条目在原数组中的索引，后续统一批量处理以避免数组遍历过程中出现索引错乱问题
      const removeIndices: number[] = [];
      // 初始化当前遍历的候选条目对的位置索引，用于记录遍历进度
      let candidateIdx = 0;
      // 遍历所有按相似度排序的去重候选条目对，逐个执行语义重复校验
      for (const { a, b, cos } of candidates) {
        // 每遍历一个候选条目对，索引计数器自增1，记录当前遍历位置
        candidateIdx++;
        // 若本轮去重流程已耗尽最大允许的LLM调用次数，终止后续校验流程控制成本
        if (llmCalls >= maxLLMCalls) {
          // 输出日志记录LLM调用限额用尽的事件，同时统计剩余未处理的候选条目对数量
          log("profile dedup: LLM call limit reached", {
            itemType,
            skipped: candidates.length - candidateIdx + 1,
          });
          // 跳出候选遍历循环，结束本次去重流程的剩余校验
          break;
        }
        // 若当前候选对中的任意一个条目已被标记为待删除，跳过该组合避免重复处理
        if (removeIndices.includes(items.indexOf(a)) || removeIndices.includes(items.indexOf(b)))
          continue;

        // 生成当前条目对的唯一缓存键：将两个描述排序后拼接，截断至前100字符避免键值过长
        const pairKey = [a.description, b.description].sort().join("||").substring(0, 100);
        // 若该条目对的校验结果已存在于缓存中，直接跳过LLM调用节省资源
        if (checkedPairs.has(pairKey)) {
          // 缓存命中计数器自增，用于统计缓存去重的效率
          skippedCached++;
          // 跳过当前候选对的后续校验流程
          continue;
        }

        // 正式发起LLM调用前，调用次数计数器自增，累计消耗的配额
        llmCalls++;
        // 调用语义重复检测方法，通过大语言模型深度校验两个条目是否为同一语义的重复记录
        const isDuplicate = await this.checkSemanticDuplicate(a.description, b.description);

        if (isDuplicate) {
          // 语义重复确认成立，进入条目合并流程
          // 选择访问频率更高的条目作为保留主体，高频行为更能代表用户稳定偏好
          const keeper = (a.frequency || 0) >= (b.frequency || 0) ? a : b;
          // 确定频率较低的条目为待移除对象，完成主副条目划分
          const removed = keeper === a ? b : a;
          // 累加固有访问频率，合并两个条目的活跃次数统计，保留完整行为热度
          keeper.frequency = (keeper.frequency || 0) + (removed.frequency || 0);
          // 对保留条目执行懒迁移，补全所有缺失的统计字段，确保参数合法性
          this.lazyMigrateAlpha(keeper);
          // 对待移除条目执行懒迁移，保证待合并的alpha/beta参数均为新版格式
          this.lazyMigrateAlpha(removed);
          // 合并置信度正例统计参数，将待移除条目的有效观测数全部转移到保留条目
          keeper.alpha += removed.alpha || 0;
          // 合并置信度负例统计参数，完整保留两个条目的历史负观测累积
          keeper.beta = (keeper.beta || 1) + (removed.beta || 1);
          // 合并弱匹配场景的正例采样参数，扣除初始值1避免重复累加基准值
          keeper.weakAlpha = (keeper.weakAlpha || 1) + ((removed.weakAlpha || 1) - 1);
          // 合并弱匹配场景的负例采样参数，同样扣除初始值保证统计一致性
          keeper.weakBeta = (keeper.weakBeta || 1) + ((removed.weakBeta || 1) - 1);
          // 取两个条目中的最新活跃时间，保留条目最后活跃时间戳始终为全局最大值
          keeper.lastSeen = Math.max(keeper.lastSeen || 0, removed.lastSeen || 0);
          // 取两个条目中的最新匹配时间，同步更新最后成功匹配的时间节点
          keeper.lastMatchTime = Math.max(keeper.lastMatchTime || 0, removed.lastMatchTime || 0);
          // 基于合并后的所有统计参数，重新计算保留条目的综合置信度
          this.syncConfidence(keeper);
          // 合并并去重两个条目的证据链，保留最多10条核心观测避免数据冗余
          keeper.evidence = [
            ...new Set([
              ...this.ensureArray(keeper.evidence),
              ...this.ensureArray(removed.evidence),
            ]),
          ].slice(0, 10);
          // 仅当两个条目都处于待验证状态时，合并后的条目才保留待验证标记
          keeper.pendingValidation = !!keeper.pendingValidation && !!removed.pendingValidation;
          // 工作流类型条目特殊处理：保留步骤更完整的工作流定义
          if (itemType === "workflow") {
            keeper.steps =
              keeper.steps?.length >= (removed.steps?.length || 0) ? keeper.steps : removed.steps;
          }
          // 获取待移除条目在原数组中的索引，用于后续批量删除操作
          const removedIdx = items.indexOf(removed);
          // 索引合法则加入待删除列表，标记该条目需从原数组中清除
          if (removedIdx >= 0) removeIndices.push(removedIdx);
          // 从缓存中删除该条目对的校验记录，允许后续重新检测合并后的新条目
          checkedPairs.delete(pairKey);
          // 打印合并完成的系统日志，记录核心参数用于链路追踪与问题复盘
          log("profile dedup: merged duplicate", {
            type: itemType,
            keeper: (keeper.description || "").substring(0, 40),
            removed: (removed.description || "").substring(0, 40),
            cos: Math.round(cos * 100) / 100,
            mergedFreq: keeper.frequency,
          });
        } else {
          // 将本次非重复校验结果写入缓存，避免后续重复调用LLM消耗资源
          checkedPairs.add(pairKey);
          // 记录条目对非重复判定完成的系统日志，保留语义相似度等核心参数用于链路追踪
          log("profile dedup: no duplicate confirmed", {
            type: itemType,
            cos: Math.round(cos * 100) / 100,
          });
        }
      }

      // 从待删除索引数组的末尾开始向前遍历，采用倒序删除策略
      // 这是数组批量删除的经典安全实现：如果按正序删除靠前的元素，会导致后续元素的索引整体前移
      // 原本记录的后续索引值就会失效，误删错误位置的元素，倒序处理彻底规避该问题
      for (let i = removeIndices.length - 1; i >= 0; i--) {
        // 调用数组原生splice方法，从原条目数组中移除标记为待删除的元素
        // 第一个参数是待删除元素在原数组中的精准下标，非空断言操作符!保证类型安全
        // 第二个参数1表示仅删除当前下标位置的1个元素，精确控制删除范围
        items.splice(removeIndices[i]!, 1);
      }
    }

    // 打印画像去重流程全周期完成的系统日志，汇总核心执行指标用于链路追踪与性能优化
    // 记录的指标包含：处理的条目类型、消耗的LLM调用次数、缓存命中跳过的重复检测量、去重后的剩余条目总数
    // 完整的日志数据支撑后续去重算法迭代、资源配额调优与业务异常排查
    log("profile dedup complete", {
      type: itemType,
      llmCalls,
      skippedCached,
      itemsAfter: items.length,
    });

    // 当已校验条目对缓存大小超过1000条时，触发缓存裁剪以控制内存占用
    if (this.dedupCheckedCache.size > 1000) {
      // 将缓存中的所有条目转换为数组，为后续切片操作做准备
      const entries = [...this.dedupCheckedCache];
      // 仅保留数组中后500条最新的校验记录，丢弃更早的半量条目，实现LRU风格的缓存淘汰
      this.dedupCheckedCache = new Set(entries.slice(500));
    }
  }

  /**
   * 画像条目语义冲突检测核心方法：调用大语言模型精确判断两个用户偏好是否存在真实互斥矛盾
   * 是冲突解决流程的核心语义校验环节，仅在余弦相似度初筛后触发，精准识别如"爱吃辣"和"完全不能吃辣"这类真实矛盾
   * @param descA - 第一个待检测冲突的条目描述文本，包含用户行为/偏好的自然语言表述
   * @param descB - 第二个待检测冲突的条目描述文本，与第一个描述来自同一业务分类
   * @returns 布尔值标记两个描述是否存在真实语义冲突，true表示互斥矛盾需进入冲突解决流程
   */
  private async checkConflict(descA: string, descB: string): Promise<boolean> {
    const prompt = `Are these two user preferences contradictory (opposing, incompatible)?

A: "${descA}"
B: "${descB}"

Answer JSON only: { "conflict": true|false, "reason": "one sentence explanation" }`;

    // 仅当配置了开源代码模型提供商和模型名称时，才进入原生模型调用分支
    if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
      // 捕获原生调用流程中所有潜在异常，避免单次冲突检测失败阻断整体流程
      try {
        // 动态导入zod库，用于构建LLM输出的结构校验Schema，保障返回数据格式合法性
        const { z } = await import("zod");
        // 从开源代码提供商加载工具中导入结构化输出生成方法，封装了模型调用与格式校验逻辑
        const { generateStructuredOutput } = await loadOpencodeProvider();
        // 导入获取开源代码客户端实例的工厂方法，封装了与模型服务的底层通信能力
        const { getOpenCodeClient } = await import("../ai/profile-llm-client.js");

        // 声明客户端实例变量，初始化为undefined，后续仅在连接成功时填充有效实例
        let v2Client;
        // 捕获客户端初始化过程中的连接异常，防止服务不可用导致流程崩溃
        try {
          // 调用工厂方法异步获取开源代码客户端的可用实例，建立与模型服务的连接
          v2Client = await getOpenCodeClient();
        } catch (e) {
          // 客户端连接失败时输出系统日志，记录错误上下文便于链路追踪与问题排查
          log("profile conflict check: native provider not connected", { error: String(e) });
        }
        // 仅当成功获取到有效客户端实例时，才执行后续的LLM语义冲突检测逻辑
        if (v2Client) {
          // 通过Promise.race实现超时控制，同时发起结构化输出请求和30秒超时定时器，先完成的任务决定结果
          const result: any = await Promise.race([
            // 调用结构化输出生成方法，传入所有必要参数调用LLM完成语义冲突检测
            generateStructuredOutput({
              // 传入已初始化的开源代码客户端实例，用于底层API通信
              client: v2Client,
              // 传入配置中的提供商标识，用于多提供商场景下的路由选择
              providerID: CONFIG.opencodeProvider,
              // 传入配置中的具体模型名称，指定本次调用的底层推理模型
              modelID: CONFIG.opencodeModel,
              // 传入给LLM的系统提示词，定义模型的角色定位与输出格式要求
              systemPrompt: "You are a preference contradiction detector. Output valid JSON.",
              // 传入拼接好的用户提示词，包含待检测的两个条目描述文本
              userPrompt: prompt,
              // 传入zod构建的结构校验Schema，强制要求LLM输出包含conflict和reason字段的合法JSON
              schema: z.object({ conflict: z.boolean(), reason: z.string() }),
            }),
            // 初始化超时控制Promise，30秒后主动触发拒绝，避免无限等待模型响应
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("conflict check timeout")), 30000)
            ),
          ]);
          // 成功获取LLM返回结果后，提取conflict字段作为返回值，非法值时默认返回false保证流程安全
          return result.conflict || false;
        }
        // 捕获原生调用流程中所有未处理的异常，输出错误日志后回退到外部API调用逻辑
      } catch (e) {
        // 记录原生冲突检测服务调用失败的系统日志，包含完整错误栈信息便于问题排查
        log("profile conflict check: native provider failed", { error: String(e) });
      }
    }

    // 检查是否已配置内存模型和API地址，满足外部调用前置条件时进入外部API分支
    if (CONFIG.memoryModel && CONFIG.memoryApiUrl) {
      // 捕获外部API调用全流程异常，避免单次检测失败阻断整体流程
      try {
        // 发起POST请求调用大模型聊天补全接口，拼接完整的API请求地址
        const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
          // 指定HTTP请求方法为POST，符合大模型API的通用调用规范
          method: "POST",
          // 设置请求头，指定内容类型与身份认证信息
          headers: {
            // 设置请求体类型为JSON，服务端可正确解析参数
            "Content-Type": "application/json",
            // 注入API密钥完成身份校验，无密钥时传入空字符串兜底
            Authorization: `Bearer ${CONFIG.memoryApiKey || ""}`,
          },
          // 序列化请求体参数，构造符合大模型接口要求的调用参数
          body: JSON.stringify({
            // 指定调用的大模型名称，与服务端部署的模型标识保持一致
            model: CONFIG.memoryModel,
            // 构造大模型要求的对话消息数组，包含系统角色提示和用户查询
            messages: [
              {
                // 系统角色消息，定义模型的身份与输出要求
                role: "system",
                // 系统提示词：指定模型为偏好矛盾检测器，要求输出合法JSON格式
                content: "You are a preference contradiction detector. Output valid JSON.",
              },
              // 用户角色消息，传入拼接好的待检测偏好描述和任务要求
              { role: "user", content: prompt },
            ],
            // 将采样温度设为0，强制模型输出最确定的结果，避免随机生成内容干扰检测
            temperature: 0,
            // 要求模型返回严格的JSON格式，避免非结构化输出解析失败
            response_format: { type: "json_object" },
          }),
          // 设置30秒请求超时，防止无限等待服务端响应阻塞流程
          signal: AbortSignal.timeout(30000),
        });
        // 响应状态码非2xx类成功值时直接返回false，标记本次冲突检测失败
        if (!response.ok) return false;
        // 解析响应体的JSON数据，提取大模型返回的原始结果
        const data: any = await response.json();
        // 从响应结果中提取模型生成的内容，处理多层可选链避免空值抛出异常
        const content = data.choices?.[0]?.message?.content;
        // 提取的内容为空时返回false，无法完成语义冲突判定
        if (!content) return false;
        // 立即执行函数解析JSON内容，内置容错修复逻辑处理非法JSON格式
        const parsed = (() => {
          // 首先尝试直接解析原始内容，若格式合法则直接返回解析结果
          try {
            return JSON.parse(content);
          } catch {
            // 原始JSON解析失败时进入修复流程，处理中文引号转义异常等常见格式问题
            // 对原始内容执行两次正则替换，修复未转义的中文双引号问题
            const repaired = content
              // 修复两个中文字符之间的未转义双引号，添加正确的转义符
              .replace(
                /([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])"([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g,
                '$1\\"$2'
              )
              // 修复中文字符后紧跟JSON结构符号前的未转义双引号，添加转义符
              .replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])"(?=\s*[,}\]])/g, '$1\\"');
            // 解析修复后的JSON字符串，返回结构化的检测结果
            return JSON.parse(repaired);
          }
        })();
        // 返回模型判定的冲突标记，非法值时默认返回false保证流程安全
        return parsed.conflict || false;
      } catch (e) {
        // 捕获调用流程中所有未处理的异常，输出错误日志便于链路追踪与问题排查
        log("profile conflict check: external API failed", { error: String(e) });
      }
    }

    return false;
  }

  /**
   * 画像描述进化核心方法：基于积累的行为证据调用大语言模型生成更精准的通用描述
   * 通过整合多条独立观测记录，将碎片化的具体行为提炼为更具概括性的稳定用户偏好描述
   * @param item - 待进化描述的画像条目实体，包含原始描述、证据链等全量属性
   * @param itemType - 条目类型，仅支持偏好/模式/工作流三类核心业务实体
   * @param profileId - 用户唯一标识，用于链路追踪、多用户隔离与流程权限校验
   * @returns 进化成功返回优化后的描述文本，所有异常场景均返回null保证流程安全
   */
  private async evolveDescription(
    item: any,
    itemType: "preference" | "pattern" | "workflow",
    profileId?: string
  ): Promise<string | null> {
    // 缺失合法用户标识时直接终止进化流程，无有效归属的条目无法执行更新操作
    if (!profileId) {
      // 记录描述进化被阻断的系统日志，标记异常原因用于链路追踪
      log("profile description evolution blocked: no profileId");
      // 非法输入场景返回null，符合方法契约的错误处理规范
      return null;
    }

    // 从当前条目提取证据链属性，存储所有支撑该描述的独立观测记录
    const evidence = item.evidence;
    // 校验证据链合法性：非数组格式或证据数量未达该类型条目最低要求时终止流程
    if (!Array.isArray(evidence) || evidence.length < this.minEvidenceForEvolve(itemType)) {
      // 证据为合法数组但数量不足时，输出日志记录资源不足的具体参数，便于阈值调优
      if (Array.isArray(evidence) && evidence.length > 0) {
        log("profile description evolution skipped: insufficient evidence", {
          type: itemType,
          evidenceCount: evidence.length,
          required: this.minEvidenceForEvolve(itemType),
        });
      }
      // 证据条件不满足时返回null，结束本次进化尝试
      return null;
    }

    // 所有前置校验通过，正式发起描述进化流程，记录核心上下文参数用于全链路追踪
    log("profile description evolution attempt", {
      type: itemType,
      desc: (item.description || "").substring(0, 40),
      frequency: item.frequency,
      evidenceCount: evidence.length,
    });

    // 将证据链数组格式化为带有序号的多行文本，符合大模型输入的可读性要求
    // 每条证据前添加1开始的自然数序号，用换行符分隔保证结构清晰
    const evidenceList = evidence.map((e: string, i: number) => `${i + 1}. ${e}`).join("\n");

    const systemPrompt = `You are a user profile description optimizer. Return ONLY a JSON object with a single "description" field: {"description": "..."}
Based on multiple independent observations of the same user behavior, generate a more precise description.
Rules:
- Describe the user's behavioral tendency in general terms
- Natural length — not artificially shortened or inflated
- Same language as the observations
- Do not over-infer beyond what the evidence shows
- Do not include technical implementation details, parameter values, algorithm names, tool names, product names, library names, file paths, error messages, or transient conversation content`;

    const userPrompt = `Current description: ${item.description}

Independent observations:
${evidenceList}

Generate a concise, abstract description of the user's general behavioral tendency.`;

    let newDescription: string | null = null;

    // 检查是否已配置开源模型提供商和模型名称，满足原生模型调用的基础条件
    if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
      // 捕获原生调用流程中的所有异常，避免单次进化失败阻断整体流程
      try {
        // 调用开源模型提供商的专用调用方法，异步获取进化后的描述文本
        newDescription = await this.callOpencodeProvider(systemPrompt, userPrompt);
      } catch (e) {
        // 原生调用失败时记录错误日志，同时标记将降级使用外部API继续尝试
        log("profile description evolution: native provider failed, trying external API", {
          error: String(e),
        });
      }
    }

    // 当原生模型调用未生成有效描述，且外部内存模型及API地址均完成配置时，触发外部API降级调用流程
    if (!newDescription && CONFIG.memoryModel && CONFIG.memoryApiUrl) {
      // 捕获外部API调用全流程异常，避免单次进化失败阻断整体描述更新流程
      try {
        // 调用外部API封装方法，传入系统提示词与用户提示词，异步获取大模型生成的优化描述
        newDescription = await this.callExternalAPI(systemPrompt, userPrompt);
      } catch (e) {
        // 外部API调用失败时记录系统日志，包含完整错误上下文便于链路追踪与问题排查
        log("profile description evolution: external API failed", { error: String(e) });
        // 所有调用路径均失效时返回null，符合方法契约的错误处理规范，终止本次进化流程
        return null;
      }
    }

    // 校验进化结果有效性：未生成有效描述，或新描述与原描述完全一致时，终止进化流程
    if (!newDescription || newDescription === item.description) {
      // 场景1：未获取到任何有效描述文本，所有模型调用渠道均不可用
      if (!newDescription) {
        // 记录进化流程阻塞的系统日志，标记核心原因为无可用模型提供商
        log("profile description evolution blocked: no provider available");
      }
      // 场景2：新生成的描述与原描述无差异，模型未输出有效优化内容
      else {
        // 记录进化流程跳过的系统日志，附带条目类型参数便于业务统计与问题复盘
        log("profile description evolution skipped: no change", { type: itemType });
      }
      // 无论哪种无效场景，均返回null终止本次进化尝试，保证流程安全性
      return null;
    }

    return newDescription;
  }

  // 描述进化与更新异步方法：整合大模型生成能力与语义校验逻辑，完成画像条目的描述升级
  async evolveAndUpdate(item: any, itemType: string, profileId?: string): Promise<void> {
    // 缺失合法用户标识时直接终止流程，无归属的条目不执行任何更新操作
    if (!profileId) return;
    // 捕获全流程异常，避免单次进化失败阻断整个画像更新链路
    try {
      // 调用核心进化方法，获取大模型生成的优化描述文本
      const evolved = await this.evolveDescription(item, itemType as any, profileId);
      // 仅当生成有效描述且与原描述存在差异时，进入后续更新校验流程
      if (evolved && evolved !== item.description) {
        // 获取嵌入服务单例实例，用于生成文本的语义向量
        const embed = EmbeddingService.getInstance();

        // 嵌入服务完成预热初始化时，执行严格的语义方向校验流程
        if (embed.isWarmedUp) {
          // 从条目的证据链中提取合法文本证据，过滤无效短文本并最多保留8条核心观测
          const evidence = this.ensureArray(item.evidence)
            .filter((e: any) => typeof e === "string" && e.length >= 10)
            .slice(0, 8);

          // 有效证据数量不低于3条时，执行质心对齐的语义漂移校验
          if (evidence.length >= 3) {
            // 保存原始描述文本，用于后续日志记录与变更对比
            const oldDesc = item.description;
            // 批量生成所有证据文本的嵌入向量，并行调用提高处理效率
            const evEmbs = await Promise.all(
              // 遍历每条证据文本，先执行描述标准化处理，再调用嵌入服务生成语义向量
              evidence.map((e: string) => embed.embed(normalizeDescription(e)))
            );
            // 对所有证据向量进行累加求和，构建原始的未归一化质心向量
            const sumVec = evEmbs.reduce(
              // 累加器回调函数：逐个将当前证据向量的维度值累加到总和向量中
              (acc: number[], e: any) => {
                // 将当前嵌入向量转换为标准数组格式，统一处理不同的向量存储类型
                const arr = Array.from(e) as number[];
                // 按维度逐一累加向量值，当前维度无数据时补0避免NaN污染
                return acc.map((v, i) => v + (arr[i] ?? 0));
              },
              // 初始化与第一个向量维度一致的零向量，确保向量维度匹配不会出错
              new Array((evEmbs[0] as any).length).fill(0) as number[]
            );
            // 对累加后的总向量执行L2归一化，得到分布标准的语义质心向量
            const evCentroid = l2Normalize(sumVec);

            // 初始化描述更新 adoption 标记，记录新描述是否通过校验并最终采纳
            let adopted = false;
            // 生成原描述文本的语义嵌入向量：先标准化描述格式，再调用嵌入服务生成向量
            const oldEmb = await embed.embed(normalizeDescription(item.description));
            // 生成新进化描述文本的语义嵌入向量，执行与原描述完全一致的预处理流程
            const newEmb = await embed.embed(normalizeDescription(evolved));
            // 计算原描述与证据质心的余弦相似度：衡量原描述与核心观测的语义贴合度
            const cosOld = cosineSimilarityNumbers(Array.from(oldEmb) as number[], evCentroid);
            // 计算新进化描述与证据质心的余弦相似度：验证新描述是否保留原始语义核心
            const cosNew = cosineSimilarityNumbers(Array.from(newEmb) as number[], evCentroid);

            // 判断新描述与证据质心的相似度是否严重低于原描述，超过允许的漂移容忍阈值
            if (cosNew < cosOld - DIRECTION_VALIDATION_TOLERANCE) {
              // 新描述语义方向偏离度过大，拒绝本次进化，记录拒绝原因和核心相似度指标
              log("profile description evolution rejected: direction drift", {
                type: itemType,
                // 原描述与证据质心的余弦相似度，保留三位小数输出便于排查
                cosOld: Math.round(cosOld * 1000) / 1000,
                // 新描述与证据质心的余弦相似度，保留三位小数输出便于排查
                cosNew: Math.round(cosNew * 1000) / 1000,
              });
            } else {
              // 新描述通过语义方向校验，将条目的描述更新为进化后的文本
              item.description = evolved;
              // 标记本次进化的新描述已成功采纳，进入后续质心更新流程
              adopted = true;
            }

            // 仅当新描述通过语义校验成功采纳时，执行质心锚点的更新流程
            if (adopted) {
              // 复用证据聚合生成的标准质心向量作为新条目质心，保证语义核心一致性
              const newCentroid = evCentroid;
              // 提取条目的原有质心向量，用于后续计算新旧质心的语义偏移量
              const oldCentroid = (item as any).centroid as number[] | undefined;
              // 将条目核心质心更新为基于全量证据重构的新质心，同步语义基准
              (item as any).centroid = newCentroid;
              // 同步更新锚点质心，重置语义漂移检测的参照基准，重启漂移计数周期
              (item as any).anchor = newCentroid;
              // 重置连续低于相似度阈值的漂移计数器，通过校验后清零历史偏移记录
              (item as any).driftBelowCount = 0;

              // 仅当条目存在历史质心向量时，才输出质心重构的系统日志，避免空值日志冗余
              if (oldCentroid) {
                log("profile centroid rebuilt from evidence after evolve", {
                  type: itemType,
                  // 计算新旧质心的余弦相似度并保留三位小数，量化描述进化带来的语义偏移程度
                  cosShift:
                    Math.round(cosineSimilarityNumbers(oldCentroid, newCentroid) * 1000) / 1000,
                  // 记录用于重构质心的有效证据数量，支撑质心质量的后续统计分析
                  evidenceCount: evidence.length,
                  // 标记本次质心更新是否通过了≥3条证据的合法性校验，区分全量重构与临时更新
                  validated: evidence.length >= 3,
                });
              }
            }

            // 输出画像描述进化完成的系统日志，完整记录进化前后的核心参数
            // 日志字段包含条目业务类型、原描述文本、新进化描述、采纳状态及条目访问频率
            // 全量数据支撑进化效果复盘、算法优化及业务异常链路追踪
            log("profile description evolved", {
              type: itemType,
              oldDescription: oldDesc,
              newDescription: item.description,
              adopted: oldDesc !== item.description,
              frequency: item.frequency,
            });
            return;
          }
        } else {
          log("profile description evolution: embedding not warmed up, skipping validation", {
            type: itemType,
          });
        }

        // 保存当前条目原始描述文本，用于日志记录进化前后的内容对比
        const oldDesc = item.description;
        // 将条目描述更新为大模型进化生成的优化版本，完成描述升级
        item.description = evolved;
        // 输出画像描述进化完成的系统日志，记录核心参数用于链路追踪与业务统计
        log("profile description evolved", {
          // 画像条目的业务类型，区分偏好/模式/工作流等不同实体分类
          type: itemType,
          // 进化前的原始描述文本，完整保留变更前的内容用于追溯
          oldDescription: oldDesc,
          // 大模型生成的进化后新描述文本，记录优化后的最终内容
          newDescription: evolved,
          // 标记本次进化的描述已成功采纳，未经过语义漂移校验的直接采用场景
          adopted: true,
          // 该条目的累计访问频率，用于分析高热度条目进化的分布特征
          frequency: item.frequency,
        });
      }
    } catch (e) {
      // 记录画像描述进化流程中未捕获的异常信息，记录错误类型与详情用于链路排障
      log("profile description evolve error", { type: itemType, error: String(e) });
    }
  }

  // 开源模型提供商调用核心方法：封装与开源推理服务的底层通信逻辑，统一处理模型调用流程
  // 为描述进化任务提供原生模型能力支撑，所有异常场景均返回null保证流程安全
  private async callOpencodeProvider(
    systemPrompt: string,
    userPrompt: string
  ): Promise<string | null> {
    // 从开源代码提供商加载工具中导入结构化输出生成方法，封装模型调用与格式校验全流程
    const { generateStructuredOutput } = await loadOpencodeProvider();
    // 导入获取开源代码客户端实例的工厂方法，负责与模型服务建立底层连接
    const { getOpenCodeClient } = await import("../ai/profile-llm-client.js");

    // 声明客户端实例变量，初始化为undefined，仅在连接成功时填充有效实例
    let v2Client;
    // 捕获客户端初始化过程中的连接异常，防止服务不可用导致流程崩溃
    try {
      // 调用工厂方法异步获取开源代码客户端的可用实例，建立与模型服务的连接
      v2Client = await getOpenCodeClient();
    } catch (e) {
      // 客户端连接失败时输出系统日志，记录错误上下文便于链路追踪与问题排查
      log("profile description evolution: native provider not connected", {
        provider: CONFIG.opencodeProvider,
        error: String(e),
      });
      // 连接失败直接返回null，触发后续降级调用逻辑
      return null;
    }

    // 动态导入zod库，用于构建LLM输出的结构校验Schema，保障返回数据格式合法性
    const { z } = await import("zod");
    // 定义输出结构校验规则：强制要求模型返回包含description字段的合法JSON字符串
    const schema = z.object({ description: z.string() });

    // 创建Promise.race竞赛场景，同时发起模型调用请求和超时计时，先完成的任务决定最终结果
    const result: any = await Promise.race([
      // 调用开源模型服务的结构化输出生成方法，传入所有必要参数发起LLM推理请求
      generateStructuredOutput({
        // 已成功初始化的开源推理服务客户端实例，负责底层API通信
        client: v2Client,
        // 非空断言获取配置中的模型服务提供商标识，多厂商场景下用于路由分发
        providerID: CONFIG.opencodeProvider!,
        // 非空断言获取配置中本次调用的具体模型名称，指定底层推理模型实例
        modelID: CONFIG.opencodeModel!,
        // 传递给LLM的系统提示词，定义模型角色定位与输出格式约束
        systemPrompt,
        // 传递给LLM的用户请求提示词，包含待处理的具体任务输入数据
        userPrompt,
        // Zod构建的输出结构校验Schema，强制模型返回符合规范的JSON格式结果
        schema,
      }),
      // 创建一个用于超时控制的Promise对象，采用拒绝状态来中断等待流程
      new Promise((_, reject) =>
        // 调用定时器API，设定延迟后触发超时 reject 逻辑
        setTimeout(() => reject(new Error("evolve description timeout")), 120000)
      ),
    ]);

    return result.description || null;
  }

  // 定义私有异步函数，用于调用外部大语言模型（LLM）API接口，接收系统提示词与用户提示词并返回响应字符串或 null
  private async callExternalAPI(systemPrompt: string, userPrompt: string): Promise<string | null> {
    // 记录请求开始时的毫秒级时间戳，用于耗时计算与监控分析
    const t0 = Date.now();
    // 发起异步 HTTP 请求至配置的 Memory API 聊天的 completions 端点，并等待响应
    const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
      // 设置 HTTP 请求方法为 POST
      method: "POST",
      // 配置 HTTP 请求头
      headers: {
        // 设置内容类型为 JSON 格式
        "Content-Type": "application/json",
        // 携带 Bearer Token 身份验证头，配置为空时回退为空字符串
        Authorization: `Bearer ${CONFIG.memoryApiKey || ""}`,
      },
      // 将请求体对象序列化为 JSON 字符串
      body: JSON.stringify({
        // 指定调用的大模型名称
        model: CONFIG.memoryModel,
        // 构建提示词消息数组
        messages: [
          // 设置系统角色及其提示词内容
          { role: "system", content: systemPrompt },
          // 设置用户角色及其提示词内容
          { role: "user", content: userPrompt },
        ],
        // 设置模型采样温度系数为 0.3，以保持输出的确定性与稳定性
        temperature: 0.3,
        // 指定响应格式要求模型返回 JSON 对象
        response_format: { type: "json_object" },
      }),
      // 设置请求超时控制信号，防止请求长时间挂起，超时时间为 60000 毫秒（60秒）
      signal: AbortSignal.timeout(60000),
    });

    // 记录 HTTP 请求完成的日志信息，包含耗时与响应状态码
    log("profile description evolution: external API http done", {
      // 计算并记录 HTTP 请求的耗时（单位：毫秒）
      httpMs: Date.now() - t0,
      // 记录 HTTP 响应的状态码
      status: response.status,
    });

    // 判断 HTTP 响应状态码是否非 2xx 成功状态
    if (!response.ok) {
      // 尝试获取响应体文本内容，若读取解析失败则安全回退为空字符串
      const text = await response.text().catch(() => "");
      // 抛出包含 HTTP 状态码及响应详细信息的 Error 异常
      throw new Error(`External API error: ${response.status} ${text}`);
    }

    // 将响应体异步解析为 JSON 数据对象
    const data: any = await response.json();
    // 使用可选链安全提取 OpenAI 格式响应数据中首个候选消息的内容字符串
    const content = data.choices?.[0]?.message?.content;
    // 若提取的消息内容为空，则抛出响应内容缺失的 Error 异常
    if (!content) throw new Error("No content in API response");

    // 将模型返回的 JSON 字符串解析为 JavaScript 对象
    const parsed = JSON.parse(content);
    // 提取解析对象中的 description 字段属性并返回，若不存在则回退返回 null
    return parsed.description || null;
  }
}

export const userProfileManager = new UserProfileManager();
