// 导入数据库获取方法，用于初始化和管理SQLite数据库连接
import { getDatabase } from "../../sqlite/sqlite-bootstrap.js";
// 导入路径拼接工具，用于处理文件路径的跨平台拼接
import { join } from "node:path";
// 导入会话相关的类型定义，统一管理AI会话模块的类型约束
import type {
  // AI会话核心实体类型，描述单条完整的会话的所有属性
  AISession,
  // 创建会话时的请求参数类型，定义新建会话需要传入的字段
  SessionCreateParams,
  // 更新会话时的请求参数类型，定义可修改的会话字段
  SessionUpdateParams,
  // AI服务提供商类型枚举，限定支持的AI厂商范围
  AIProviderType,
  // AI对话消息实体类型，描述单条聊天消息的所有属性
  AIMessage,
} from "./session-types.js";
// 导入数据库连接管理器，负责统一管理所有SQLite数据库连接的生命周期与复用
import { connectionManager } from "../../sqlite/connection-manager.js";
// 导入全局应用配置对象，包含系统运行所需的所有核心配置参数
import { CONFIG } from "../../../config.js";

// 获取SQLite数据库实例，通过预定义的数据库初始化方法创建核心数据库操作对象
const Database = getDatabase();
// 提取Database类的实例类型，用于后续数据库连接的类型约束，确保所有数据库操作都符合原型定义
type DatabaseType = typeof Database.prototype;
// AI会话数据库的文件名，存储所有AI对话会话数据的SQLite数据库文件名称
const AI_SESSIONS_DB_NAME = "ai-sessions.db";

// AI会话管理核心类，负责处理所有AI对话会话的生命周期管理、数据持久化及查询操作
export class AISessionManager {
  // SQLite数据库操作实例，负责执行所有底层SQL语句和数据交互
  private db: DatabaseType;
  // 数据库文件的完整存储路径，使用readonly确保路径在实例化后不可修改
  private readonly dbPath: string;
  // 会话的最大保留时长，以毫秒为单位，readonly保证配置值固定不变
  private readonly sessionRetentionMs: number;

  // AISessionManager类的构造函数，负责初始化数据库连接和核心配置
  constructor() {
    // 拼接数据库文件的完整存储路径，组合基础存储目录和会话数据库文件名
    this.dbPath = join(CONFIG.storagePath, AI_SESSIONS_DB_NAME);
    // 从连接管理器获取对应路径的数据库连接，实现连接的复用与统一管理
    this.db = connectionManager.getConnection(this.dbPath);
    // 将配置中的保留天数转换为毫秒值，计算会话从创建到过期的总时长
    this.sessionRetentionMs = CONFIG.aiSessionRetentionDays * 24 * 60 * 60 * 1000;
    // 调用数据库初始化方法，创建所需的数据表和索引
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);

    this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_session_id ON ai_sessions(session_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_expires_at ON ai_sessions(expires_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_sessions_provider ON ai_sessions(provider)");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS ai_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ai_session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        content_blocks TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (ai_session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE
      )
    `);

    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(ai_session_id, sequence)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_ai_messages_role ON ai_messages(ai_session_id, role)"
    );
  }

  // 获取指定会话的详细信息方法，根据会话ID和提供商查询有效会话
  getSession(sessionId: string, provider: AIProviderType): AISession | null {
    // 预处理SQL查询语句，绑定三个占位符实现参数化查询，防止SQL注入并提升性能
    const stmt = this.db.prepare(`
      SELECT * FROM ai_sessions 
      WHERE session_id = ? AND provider = ? AND expires_at > ?
    `);
    // 执行预处理语句，传入会话ID、提供商类型和当前时间戳，获取匹配的第一条会话记录
    const row = stmt.get(sessionId, provider, Date.now()) as any;
    // 若未查询到任何匹配的会话记录，直接返回null表示会话不存在或已过期
    if (!row) return null;
    // 将数据库查询返回的原始行数据转换为业务层的AISession类型对象并返回
    return this.rowToSession(row);
  }

  createSession(params: SessionCreateParams): AISession {
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();
    const expiresAt = now + this.sessionRetentionMs;

    this.db.run(
      `
      INSERT INTO ai_sessions (
        id, provider, session_id, conversation_id, 
        metadata, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        id,
        params.provider,
        params.sessionId,
        params.conversationId || null,
        JSON.stringify(params.metadata || {}),
        now,
        now,
        expiresAt,
      ]
    );

    return this.getSession(params.sessionId, params.provider)!;
  }

  updateSession(sessionId: string, provider: AIProviderType, updates: SessionUpdateParams): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.conversationId !== undefined) {
      fields.push("conversation_id = ?");
      values.push(updates.conversationId);
    }

    if (updates.metadata !== undefined) {
      fields.push("metadata = ?");
      values.push(JSON.stringify(updates.metadata));
    }

    fields.push("updated_at = ?");
    values.push(Date.now());

    values.push(sessionId);
    values.push(provider);

    this.db.run(
      `
      UPDATE ai_sessions 
      SET ${fields.join(", ")}
      WHERE session_id = ? AND provider = ?
    `,
      values
    );
  }

  cleanupExpiredSessions(): number {
    const result = this.db.run(`DELETE FROM ai_sessions WHERE expires_at < ?`, [Date.now()]);
    return result.changes;
  }

  deleteSession(sessionId: string, provider: AIProviderType): void {
    this.db.run(`DELETE FROM ai_sessions WHERE session_id = ? AND provider = ?`, [
      sessionId,
      provider,
    ]);
  }

  addMessage(message: Omit<AIMessage, "id" | "createdAt">): void {
    this.db.run(
      `INSERT INTO ai_messages (
        ai_session_id, sequence, role, content, 
        tool_calls, tool_call_id, content_blocks, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.aiSessionId,
        message.sequence,
        message.role,
        message.content,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId || null,
        message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
        Date.now(),
      ]
    );
  }

  getMessages(aiSessionId: string): AIMessage[] {
    const stmt = this.db.prepare(
      "SELECT * FROM ai_messages WHERE ai_session_id = ? ORDER BY sequence ASC"
    );
    const rows = stmt.all(aiSessionId) as any[];

    return rows.map(this.rowToMessage);
  }

  // 获取指定会话下的最大消息序号，用于新消息的序号生成
  getLastSequence(aiSessionId: string): number {
    // 预处理SQL语句，查询指定会话的消息序列最大值
    const stmt = this.db.prepare(
      "SELECT MAX(sequence) as max_seq FROM ai_messages WHERE ai_session_id = ?"
    );
    // 执行预处理语句，传入会话ID参数获取查询结果行
    const row = stmt.get(aiSessionId) as any;
    // 返回最大序列值，若会话无任何消息则返回-1作为初始序号基准
    return row?.max_seq ?? -1;
  }

  clearMessages(aiSessionId: string): void {
    this.db.run("DELETE FROM ai_messages WHERE ai_session_id = ?", [aiSessionId]);
  }

  // 将数据库查询返回的原始行数据转换为业务层统一的AISession类型对象
  private rowToSession(row: any): AISession {
    return {
      // 映射数据库中的主键ID字段到业务层的id属性
      id: row.id,
      // 转换数据库存储的提供商字符串为AIProviderType枚举类型，保证类型安全
      provider: row.provider as AIProviderType,
      // 映射数据库中的会话业务ID到业务层的sessionId属性
      sessionId: row.session_id,
      // 映射数据库中的关联对话ID到业务层的conversationId属性，支持空值
      conversationId: row.conversation_id,
      // 解析数据库中JSON序列化的元数据字符串为对象，无数据时返回undefined
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      // 映射数据库中的创建时间戳（毫秒级）到业务层的createdAt属性
      createdAt: row.created_at,
      // 映射数据库中的最后更新时间戳到业务层的updatedAt属性
      updatedAt: row.updated_at,
      // 映射数据库中的会话过期时间戳到业务层的expiresAt属性
      expiresAt: row.expires_at,
    };
  }

  // 将数据库查询返回的原始行数据转换为业务层统一的AIMessage类型对象
  private rowToMessage(row: any): AIMessage {
    return {
      // 映射数据库中的主键ID字段到业务层的id属性
      id: row.id,
      // 映射数据库中关联的AI会话外键ID到业务层的aiSessionId属性
      aiSessionId: row.ai_session_id,
      // 映射数据库中的消息序号字段到业务层的sequence属性，保证消息时序
      sequence: row.sequence,
      // 映射数据库中的消息角色字段到业务层的role属性，区分用户/助手/系统消息
      role: row.role,
      // 映射数据库中的消息文本内容字段到业务层的content属性
      content: row.content,
      // 解析数据库中JSON序列化的工具调用列表，无数据时返回undefined
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      // 映射数据库中的工具调用关联ID字段到业务层的toolCallId属性
      toolCallId: row.tool_call_id,
      // 解析数据库中JSON序列化的多模态内容块数组，无数据时返回undefined
      contentBlocks: row.content_blocks ? JSON.parse(row.content_blocks) : undefined,
      // 映射数据库中的消息创建时间戳到业务层的createdAt属性
      createdAt: row.created_at,
    };
  }
}

export const aiSessionManager = new AISessionManager();
