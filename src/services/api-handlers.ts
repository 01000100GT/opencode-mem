// 导入向量嵌入服务实例，用于将文本转换为向量特征
import { embeddingService } from "./embedding.js";
// 导入数据库分片管理器实例，管理跨项目的 SQLite 分片数据库
import { shardManager } from "./sqlite/shard-manager.js";
// 导入向量搜索服务实例，提供余弦相似度与向量检索功能
import { vectorSearch } from "./sqlite/vector-search.js";
// 导入数据库连接管理器实例，负责数据库连接的复用与生命周期管理
import { connectionManager } from "./sqlite/connection-manager.js";
// 导入日志记录及诊断相关工具函数
import { log, isDiagEnabled, truncateValue, diagLog } from "./logger.js";
// 导入应用全局配置对象 CONFIG
import { CONFIG } from "../config.js";
// 导入记忆类型枚举/类型定义 MemoryType（纯类型导入）
import type { MemoryType } from "../types/index.js";
// 导入用户提示词管理器实例，负责 Prompt 的持久化与检索
import { userPromptManager } from "./user-prompt/user-prompt-manager.js";
// 导入用户画像数据接口定义 UserProfileData（纯类型导入）
import type { UserProfileData } from "./user-profile/types.js";
// 导入用户画像数据项排序工具函数 sortProfileItems
import { sortProfileItems } from "../utils/profile.js";

// 定义统一 API 响应包装接口 ApiResponse，支持泛型类型扩展
interface ApiResponse<T = any> {
  // 标识 API 请求处理是否成功
  success: boolean;
  // 响应成功时返回的数据主体（可选）
  data?: T;
  // 响应失败时返回的错误消息描述（可选）
  error?: string;
}

// 定义记忆/知识条目的核心数据结构
interface Memory {
  // 记忆条目的唯一标识符
  id: string;
  // 记忆的具体文本或核心内容
  content: string;
  // 记忆的分类类型（可选字段，用于对记忆进行大类归类）
  type?: string;
  // 记忆所关联的标签数组（可选字段，用于多维度检索）
  tags?: string[];
  // 记忆的创建时间，通常为符合 ISO 8601 格式的字符串
  createdAt: string;
  // 记忆的最后更新时间（可选字段，在数据被修改时更新）
  updatedAt?: string;
  // 与记忆相关的任意自定义元数据（可选字段，使用键值对格式）
  metadata?: Record<string, unknown>;
  // 创建该记忆的用户的友好显示名称（可选字段）
  displayName?: string;
  // 创建该记忆的用户的账户名称（可选字段）
  userName?: string;
  // 创建该记忆的用户的电子邮箱地址（可选字段）
  userEmail?: string;
  // 该记忆关联的本地项目绝对路径（可选字段）
  projectPath?: string;
  // 该记忆关联的项目名称（可选字段）
  projectName?: string;
  // 该记忆关联的远端 Git 仓库链接（可选字段）
  gitRepoUrl?: string;
  // 标记该记忆是否被置顶（可选字段）
  isPinned?: boolean;
}

// 定义标签关联信息的接口
interface TagInfo {
  // 标签的主名称或唯一键值
  tag: string;
  // 与该标签相关联的关联标签数组（可选字段）
  tags?: string[];
  // 关联此标签的用户的显示名称（可选字段）
  displayName?: string;
  // 关联此标签的用户的账户名称（可选字段）
  userName?: string;
  // 关联此标签的用户的电子邮箱地址（可选字段）
  userEmail?: string;
  // 关联此标签的项目的本地路径（可选字段）
  projectPath?: string;
  // 关联此标签的项目名称（可选字段）
  projectName?: string;
  // 关联此标签的远端 Git 仓库链接（可选字段）
  gitRepoUrl?: string;
}

// 通用的分页响应数据结构包装器
interface PaginatedResponse<T> {
  // 当前分页返回的数据实体数组
  items: T[];
  // 匹配查询条件的总记录数
  total: number;
  // 当前请求的页码
  page: number;
  // 每页包含的数据记录条数限制
  pageSize: number;
  // 根据总记录数和每页大小计算得出的总页数
  totalPages: number;
}

// 定义一个安全地将任意时间戳转换为 ISO 8601 时间格式字符串的函数
function safeToISOString(timestamp: any): string {
  // 使用 try-catch 块来捕获转换或解析过程中可能出现的任何异常，防止进程崩溃
  try {
    // 检查输入的时间戳是否为 null 或者 undefined
    if (timestamp === null || timestamp === undefined) {
      // 如果输入为空，则使用当前系统时间作为默认返回值
      return new Date().toISOString();
    }
    // 将输入转换为数字，此处使用三元表达式处理 BigInt，但两侧操作都为 Number(timestamp)
    const numValue = typeof timestamp === "bigint" ? Number(timestamp) : Number(timestamp);
    // 判断转换后的值是否为无效数字（NaN）或者是非正数（小于0）
    if (isNaN(numValue) || numValue < 0) {
      // 若数值无效或不合法，则同样回退并返回当前系统时间
      return new Date().toISOString();
    }
    // 将合法的毫秒级时间戳转换为 Date 对象，再序列化为 ISO 格式的字符串
    return new Date(numValue).toISOString();
  } catch {
    // 捕获可能由类型转换或 Date 初始化导致的任何未知运行时异常
    return new Date().toISOString();
  }
}

// 安全地解析 JSON 字符串，防止发生解析异常导致运行时崩溃
function safeJSONParse(jsonString: any): any {
  // 判断入参是否为空，或者是否不是字符串类型
  if (!jsonString || typeof jsonString !== "string") {
    // 若输入不符合 JSON 字符串的基本要求，则直接返回 undefined
    return undefined;
  }
  // 开启异常捕获机制，保护 JSON.parse 的调用
  try {
    // 调用标准的 JSON.parse 反序列化字符串
    return JSON.parse(jsonString);
  } catch {
    // 一旦解析出现异常（例如格式非法），则回退返回 undefined
    return undefined;
  }
}

// 将可选的 Float32Array 浮点向量转换为 Uint8Array 字节数组以进行 Blob 序列化
function toBlob(vector?: Float32Array): Uint8Array | null {
  // 检查向量是否存在；如果存在则通过其底层的 ArrayBuffer 构建一个 Uint8Array 视图并返回，否则返回 null
  return vector ? new Uint8Array(vector.buffer) : null;
}

// 定义一个用于校验安全哈希值的正则表达式，仅允许包含大小写字母和数字的字母数字串
const SAFE_HASH_PATTERN = /^[a-zA-Z0-9]+$/;

// 从标签字符串中解析并提取作用域及哈希值的函数
function extractScopeFromTag(tag: string): { scope: "project"; hash: string } {
  // 根据下划线字符 "_" 对标签字符串进行分割，生成部分片段数组
  const parts = tag.split("_");
  // 如果片段数组长度大于等于3，则跳过前两个片段，将其余部分用下划线重新拼接作为哈希值，否则将整个标签字符串作为哈希值
  const hash = parts.length >= 3 ? parts.slice(2).join("_") : tag;

  // 检查系统当前是否开启了诊断日志输出
  if (isDiagEnabled()) {
    // 记录诊断日志，输出从标签中解析哈希的具体调试元数据
    diagLog("api-handlers.ts:extractScopeFromTag", "parsed", {
      // 原始传入的标签字符串
      rawTag: tag,
      // 截断后的哈希字段（防止日志输出超长）
      hash: truncateValue(hash),
      // 目前硬编码的硬性作用域：项目级作用域
      scopeHardcoded: "project",
      // 标记当前诊断流程中是否包含哈希有效性验证
      hasHashValidation: true,
      // 正则校验测试结果：是否属于安全的字母数字格式
      hashValid: SAFE_HASH_PATTERN.test(hash),
    });
  }

  // 验证提取出来的哈希值是否符合安全模式
  if (!SAFE_HASH_PATTERN.test(hash)) {
    // 若不符合安全模式且开启了诊断日志，则记录被拒绝的错误详情
    if (isDiagEnabled()) {
      // 记录拒绝非法哈希的诊断日志
      diagLog("api-handlers.ts:extractScopeFromTag", "rejected invalid hash", {
        // 引起错误的原始标签
        rawTag: tag,
        // 被拒的非法哈希内容
        hash: truncateValue(hash),
      });
    }
    // 抛出运行时错误，拒绝非法字符格式以防注入攻击
    throw new Error("Invalid containerTag: hash segment must be alphanumeric");
  }
  // 返回解析成功的作用域（写死为 project）和验证后的哈希对象
  return { scope: "project", hash };
}

// 根据指定的标签检索其关联的项目本地路径
function getProjectPathFromTag(tag: string): string | undefined {
  // 从分片管理器中获取所有属于 "project" 类型且不限标识的项目分片信息
  const projectShards = shardManager.getAllShards("project", "");
  // 遍历每一个获取到的分片对象
  for (const shard of projectShards) {
    // 通过连接管理器获取当前分片对应数据库路径的连接实例
    const db = connectionManager.getConnection(shard.dbPath);
    // 从向量检索服务中获取当前数据库连接中存储的所有去重后的标签数据
    const tags = vectorSearch.getDistinctTags(db);
    // 遍历当前分片库中的所有标签记录
    for (const t of tags) {
      // 检查当前标签记录的容器标签是否与目标标签匹配，且存在有效的项目路径
      if (t.container_tag === tag && t.project_path) {
        // 如果匹配成功，则立即返回对应的项目绝对路径
        return t.project_path;
      }
    }
  }
  // 如果遍历完所有的分片和标签后均未找到匹配项，则返回未定义 undefined
  return undefined;
}

// 导出一个异步函数，用于处理获取所有标签列表的 API 请求
export async function handleListTags(): Promise<ApiResponse<{ project: TagInfo[] }>> {
  // 开启异常捕获，确保内部错误被安全捕获并以 API 响应格式返回
  try {
    // Tags are stored as SQLite metadata; embedding model is not needed.
    // Calling warmup() here would block on local transformer init in the worker
    // thread and hang every read API. Only handlers that compute similarity
    // (e.g. handleSearch) should warm up the embedding service.
    // 从分片管理器中获取所有属于 "project" 类型且不限标识的项目分片信息
    const projectShards = shardManager.getAllShards("project", "");
    // 创建一个 Map，用于对所有分片中读取出来的标签进行去重和临时存储
    const tagsMap = new Map<string, TagInfo>();
    // 遍历每一个项目分片信息
    for (const shard of projectShards) {
      // 获取当前分片对应数据库路径的连接实例
      const db = connectionManager.getConnection(shard.dbPath);
      // 调用向量检索服务，获取当前分片数据库中所有不重复的标签
      const tags = vectorSearch.getDistinctTags(db);
      // 遍历当前分片查出的每一个标签记录
      for (const t of tags) {
        // 若当前标签包含合法的容器标识且 Map 中尚未记录该标签，则进行去重保存
        if (t.container_tag && !tagsMap.has(t.container_tag)) {
          // 在 Map 中保存或更新格式化后的标签详情对象
          tagsMap.set(t.container_tag, {
            // 将数据库的 container_tag 字段映射为 TagInfo 的 tag
            tag: t.container_tag,
            // 将数据库的 display_name 字段映射为小驼峰的 displayName
            displayName: t.display_name,
            // 将数据库的 user_name 字段映射为小驼峰的 userName
            userName: t.user_name,
            // 将数据库的 user_email 字段映射为小驼峰的 userEmail
            userEmail: t.user_email,
            // 将数据库的 project_path 字段映射为小驼峰的 projectPath
            projectPath: t.project_path,
            // 将数据库的 project_name 字段映射为小驼峰的 projectName
            projectName: t.project_name,
            // 将数据库的 git_repo_url 字段映射为小驼峰的 gitRepoUrl
            gitRepoUrl: t.git_repo_url,
          });
        }
      }
    }
    // 初始化一个用于存放项目级别标签的数组
    const projectTags: TagInfo[] = [];
    // 遍历 Map 中存储的所有去重后的标签详情对象
    for (const tagInfo of tagsMap.values()) {
      // 过滤条件：判断当前标签名是否包含项目级标识符 "_project_"
      if (tagInfo.tag.includes("_project_")) {
        // 如果包含，则将该标签详情对象添加到结果数组中
        projectTags.push(tagInfo);
      }
    }
    // 返回包含成功状态以及过滤后项目标签列表的 API 响应对象
    return { success: true, data: { project: projectTags } };
  } catch (error) {
    // 若上述流程发生异常，则调用日志工具记录当前 handleListTags 的错误信息
    log("handleListTags: error", { error: String(error) });
    // 返回包含失败状态以及字符串化错误描述的 API 响应对象
    return { success: false, error: String(error) };
  }
}

// 导出一个异步函数，用于处理获取记忆列表的 API 请求
export async function handleListMemories(
  // 可选的标签参数，用于按标签过滤记忆
  tag?: string,
  // 当前请求的页码，默认值为 1（即首页）
  page: number = 1,
  // 每页返回的最大数据条数，默认值为 20
  pageSize: number = 20,
  // 是否在返回结果中包含提示词（Prompt）数据，默认为 true
  includePrompts: boolean = true
  // 定义函数返回值类型为统一的 API 响应包装的分页记忆列表
): Promise<ApiResponse<PaginatedResponse<Memory | any>>> {
  // 使用 try-catch 块来捕获并处理函数执行过程中可能发生的任何异常
  try {
    // Listing only reads SQLite rows; no vector ops happen here.
    // See handleListTags comment - keep embedding init out of read paths.
    // 初始化一个空数组，用于存放所有从数据库中查询到的记忆记录
    let allMemories: any[] = [];
    // 判断是否传入了标签参数，若有则按标签进行精确查询
    if (tag) {
      // 从标签字符串中解析出作用域（scope）和哈希值（hash），用于定位具体的数据源分片
      const { scope: tagScope, hash } = extractScopeFromTag(tag);
      // 根据解析出的作用域和哈希值，从分片管理器中获取对应的所有数据库分片列表
      const shards = shardManager.getAllShards(tagScope, hash);
      // 遍历每一个匹配的分片，逐一从中检索记忆数据
      for (const shard of shards) {
        // 通过连接管理器获取当前分片数据库路径对应的数据库连接实例
        const db = connectionManager.getConnection(shard.dbPath);
        // 调用向量检索服务，从当前数据库连接中按标签列出最多 10000 条记忆记录
        const memories = vectorSearch.listMemories(db, tag, 10000);
        // 使用展开运算符将当前分片查询到的所有记忆记录追加到汇总数组中
        allMemories.push(...memories);
      }
    } else {
      // Iterate both project- and user-scoped shards. Previously this only
      // walked project shards, which silently hid user-scope memories from the
      // listing endpoint (Web UI navigation, /api/memories without a tag
      // filter, …). User-scope memories still showed up in /api/search and
      // /api/stats `byType`, but were invisible in /api/stats `byScope` and
      // unbrowseable in the UI — a confusing UX gap. The filter keeps the
      // defense-in-depth check on container_tag, just widens it to both
      // canonical scope markers.
      const projectShards = shardManager.getAllShards("project", "");
      const userShards = shardManager.getAllShards("user", "");
      for (const shard of [...projectShards, ...userShards]) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.getAllMemories(db);
        allMemories.push(
          ...memories.filter(
            (m: any) =>
              m.container_tag?.includes("_project_") || m.container_tag?.includes("_user_")
          )
        );
      }
    }

    const memoriesWithType = allMemories.map((r: any) => {
      const metadata = safeJSONParse(r.metadata);
      return {
        type: "memory",
        id: r.id,
        content: r.content,
        memoryType: r.type,
        tags: r.tags ? r.tags.split(",").map((t: string) => t.trim()) : [],
        createdAt: Number(r.created_at),
        updatedAt: r.updated_at ? Number(r.updated_at) : undefined,
        metadata,
        linkedPromptId: metadata?.promptId,
        displayName: r.display_name,
        userName: r.user_name,
        userEmail: r.user_email,
        projectPath: r.project_path,
        projectName: r.project_name,
        gitRepoUrl: r.git_repo_url,
        isPinned: r.is_pinned === 1,
      };
    });

    let timeline: any[] = memoriesWithType;
    if (includePrompts) {
      const projectPath = tag ? getProjectPathFromTag(tag) : undefined;
      const prompts = userPromptManager.getCapturedPrompts(projectPath);
      const promptsWithType = prompts.map((p) => ({
        type: "prompt",
        id: p.id,
        sessionId: p.sessionId,
        content: p.content,
        createdAt: p.createdAt,
        projectPath: p.projectPath,
        linkedMemoryId: p.linkedMemoryId,
      }));
      timeline = [...memoriesWithType, ...promptsWithType];
    }

    const linkedPairs = new Map<string, { memory: any; prompt: any }>();
    const standalone: any[] = [];
    for (const item of timeline) {
      if (item.type === "memory" && item.linkedPromptId) {
        if (!linkedPairs.has(item.linkedPromptId)) {
          linkedPairs.set(item.linkedPromptId, { memory: item, prompt: null });
        } else {
          linkedPairs.get(item.linkedPromptId)!.memory = item;
        }
      } else if (item.type === "prompt" && item.linkedMemoryId) {
        if (!linkedPairs.has(item.id)) {
          linkedPairs.set(item.id, { memory: null, prompt: item });
        } else {
          linkedPairs.get(item.id)!.prompt = item;
        }
      } else {
        standalone.push(item);
      }
    }

    const sortedTimeline: any[] = [];
    const pairs = Array.from(linkedPairs.values())
      .filter((p) => p.memory && p.prompt)
      .sort((a, b) => b.memory.createdAt - a.memory.createdAt);
    for (const pair of pairs) {
      sortedTimeline.push(pair.memory);
      sortedTimeline.push(pair.prompt);
    }
    standalone.sort((a, b) => b.createdAt - a.createdAt);
    sortedTimeline.push(...standalone);
    timeline = sortedTimeline;

    const total = timeline.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedResults = timeline.slice(offset, offset + pageSize);

    const items = paginatedResults.map((item: any) => {
      if (item.type === "memory") {
        return {
          type: "memory",
          id: item.id,
          content: item.content,
          memoryType: item.memoryType,
          tags: item.tags,
          createdAt: safeToISOString(item.createdAt),
          updatedAt: item.updatedAt ? safeToISOString(item.updatedAt) : undefined,
          metadata: item.metadata,
          linkedPromptId: item.linkedPromptId,
          displayName: item.displayName,
          userName: item.userName,
          userEmail: item.userEmail,
          projectPath: item.projectPath,
          projectName: item.projectName,
          gitRepoUrl: item.gitRepoUrl,
          isPinned: item.isPinned,
        };
      } else {
        return {
          type: "prompt",
          id: item.id,
          sessionId: item.sessionId,
          content: item.content,
          createdAt: safeToISOString(item.createdAt),
          projectPath: item.projectPath,
          linkedMemoryId: item.linkedMemoryId,
        };
      }
    });

    return { success: true, data: { items, total, page, pageSize, totalPages } };
  } catch (error) {
    log("handleListMemories: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleAddMemory(data: {
  content: string;
  containerTag: string;
  type?: MemoryType;
  tags?: string[];
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}): Promise<ApiResponse<{ id: string }>> {
  try {
    if (!data.content || !data.containerTag) {
      return { success: false, error: "content and containerTag are required" };
    }
    await embeddingService.warmup();
    const tags = (data.tags || []).map((t) => t.trim().toLowerCase());
    const embeddingInput =
      tags.length > 0 ? `${data.content}\nTags: ${tags.join(", ")}` : data.content;

    const vector = await embeddingService.embedWithTimeout(embeddingInput);
    let tagsVector: Float32Array | undefined = undefined;
    if (tags.length > 0) {
      tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
    }

    const { scope, hash } = extractScopeFromTag(data.containerTag);

    const shard = shardManager.getWriteShard(scope, hash);

    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const now = Date.now();

    const record = {
      id,
      content: data.content,
      vector,
      tagsVector,
      containerTag: data.containerTag,
      tags: tags.length > 0 ? tags.join(",") : undefined,
      type: data.type,
      createdAt: now,
      updatedAt: now,
      displayName: data.displayName,
      userName: data.userName,
      userEmail: data.userEmail,
      projectPath: data.projectPath,
      projectName: data.projectName,
      gitRepoUrl: data.gitRepoUrl,
      metadata: JSON.stringify({ source: "api" }),
    };
    const db = connectionManager.getConnection(shard.dbPath);

    // Use transaction for atomic SQLite insert
    const insertMemory = db.transaction(() => {
      const insertStmt = db.prepare(`
        INSERT INTO memories (
          id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
          metadata, display_name, user_name, user_email, project_path, project_name, git_repo_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
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
    });
    insertMemory();

    // Vector index update (outside transaction — vector backend is async)
    try {
      const backend = await (vectorSearch as any).getBackend();
      await backend.insert({ id: record.id, vector: record.vector, shard, kind: "content" });
      if (record.tagsVector) {
        await backend.insert({ id: record.id, vector: record.tagsVector, shard, kind: "tags" });
      }
    } catch (error) {
      // Rollback SQLite insert on vector backend failure
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(record.id);
      throw error;
    }

    shardManager.incrementVectorCount(shard.id);
    return { success: true, data: { id } };
  } catch (error) {
    log("handleAddMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDeleteMemory(
  id: string,
  cascade: boolean = false
): Promise<ApiResponse<{ deletedPrompt: boolean }>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const projectShards = shardManager.getAllShards("project", "");
    for (const shard of projectShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memory = vectorSearch.getMemoryById(db, id);
      if (memory) {
        if (cascade) {
          const metadata = safeJSONParse(memory.metadata);
          const linkedPromptId = metadata?.promptId;
          if (linkedPromptId) userPromptManager.deletePrompt(linkedPromptId);
        }
        await vectorSearch.deleteVector(db, id, shard);
        shardManager.decrementVectorCount(shard.id);
        return {
          success: true,
          data: { deletedPrompt: cascade && !!safeJSONParse(memory.metadata)?.promptId },
        };
      }
    }
    return { success: false, error: "Memory not found" };
  } catch (error) {
    log("handleDeleteMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleBulkDelete(
  ids: string[],
  cascade: boolean = false
): Promise<ApiResponse<{ deleted: number }>> {
  try {
    if (!ids || ids.length === 0) return { success: false, error: "ids array is required" };
    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeleteMemory(id, cascade);
      if (result.success) deleted++;
    }
    return { success: true, data: { deleted } };
  } catch (error) {
    log("handleBulkDelete: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUpdateMemory(
  id: string,
  data: { content?: string; type?: MemoryType; tags?: string[] }
): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    await embeddingService.warmup();

    // Find the existing memory first (read-only — no data modified yet)
    const projectShards = shardManager.getAllShards("project", "");
    let foundShard = null,
      existingMemory = null;
    for (const shard of projectShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memory = vectorSearch.getMemoryById(db, id);
      if (memory) {
        foundShard = shard;
        existingMemory = memory;
        break;
      }
    }
    if (!foundShard || !existingMemory) return { success: false, error: "Memory not found" };

    // STEP 1: Generate new embeddings FIRST (safe — no data deleted yet)
    const newContent = data.content || existingMemory.content;
    const tags =
      data.tags ||
      (existingMemory.tags ? existingMemory.tags.split(",").map((t: string) => t.trim()) : []);
    const vector = await embeddingService.embedWithTimeout(newContent);
    let tagsVector: Float32Array | undefined = undefined;
    if (tags.length > 0) {
      tagsVector = await embeddingService.embedWithTimeout(tags.join(", "));
    }

    const db = connectionManager.getConnection(foundShard.dbPath);

    // STEP 2: Wrap SQLite delete + insert in a transaction
    const updateTransaction = db.transaction(() => {
      // Delete old record
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);

      // Insert updated record
      const insertStmt = db.prepare(`
        INSERT INTO memories (
          id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
          metadata, display_name, user_name, user_email, project_path, project_name, git_repo_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
        id,
        newContent,
        toBlob(vector),
        toBlob(tagsVector),
        existingMemory.container_tag,
        tags.length > 0 ? tags.join(",") : null,
        data.type || existingMemory.type,
        existingMemory.created_at,
        Date.now(),
        existingMemory.metadata,
        existingMemory.display_name,
        existingMemory.user_name,
        existingMemory.user_email,
        existingMemory.project_path,
        existingMemory.project_name,
        existingMemory.git_repo_url
      );
    });

    // Execute the SQLite transaction atomically
    updateTransaction();

    // STEP 3: Update vector index (outside transaction — vector backend is async/in-memory)
    const backend = await (vectorSearch as any).getBackend();
    await backend.delete({ id, shard: foundShard, kind: "content" });
    await backend.delete({ id, shard: foundShard, kind: "tags" });
    await backend.insert({ id, vector, shard: foundShard, kind: "content" });
    if (tagsVector) {
      await backend.insert({ id, vector: tagsVector, shard: foundShard, kind: "tags" });
    }

    return { success: true };
  } catch (error) {
    log("handleUpdateMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

interface FormattedPrompt {
  type: "prompt";
  id: string;
  sessionId: string;
  content: string;
  createdAt: string;
  projectPath: string | null;
  linkedMemoryId: string | null;
  similarity?: number;
  isContext?: boolean;
}

interface FormattedMemory {
  type: "memory";
  id: string;
  content: string;
  memoryType?: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string;
  similarity?: number;
  metadata?: Record<string, unknown>;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
  linkedPromptId?: string;
  isContext?: boolean;
}

type SearchResultItem = FormattedPrompt | FormattedMemory;

export async function handleSearch(
  query: string,
  tag?: string,
  page: number = 1,
  pageSize: number = 20
): Promise<ApiResponse<PaginatedResponse<SearchResultItem>>> {
  try {
    if (!query) return { success: false, error: "query is required" };
    await embeddingService.warmup();
    const queryVector = await embeddingService.embedWithTimeout(query);
    let memoryResults: any[] = [];
    let promptResults: any[] = [];
    if (tag) {
      const { scope, hash } = extractScopeFromTag(tag);
      const shards = shardManager.getAllShards(scope, hash);
      for (const shard of shards) {
        try {
          const results = await vectorSearch.searchInShard(shard, queryVector, tag, pageSize * 2);
          memoryResults.push(...results);
        } catch (error) {
          log("Shard search error", { shardId: shard.id, error: String(error) });
        }
      }
      const projectPath = getProjectPathFromTag(tag);
      promptResults = userPromptManager.searchPrompts(query, projectPath, pageSize * 2);
    } else {
      const projectShards = shardManager.getAllShards("project", "");
      const uniqueTags = new Set<string>();
      for (const shard of projectShards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const tags = vectorSearch.getDistinctTags(db);
        for (const t of tags) {
          if (t.container_tag) uniqueTags.add(t.container_tag);
        }
      }
      for (const containerTag of uniqueTags) {
        const { scope, hash } = extractScopeFromTag(containerTag);
        const shards = shardManager.getAllShards(scope, hash);
        for (const shard of shards) {
          try {
            const results = await vectorSearch.searchInShard(
              shard,
              queryVector,
              containerTag,
              pageSize
            );
            memoryResults.push(...results);
          } catch (error) {
            log("Shard search error", { shardId: shard.id, error: String(error) });
          }
        }
      }
      promptResults = userPromptManager.searchPrompts(query, undefined, pageSize * 2);
    }

    const formattedPrompts: FormattedPrompt[] = promptResults.map((p) => ({
      type: "prompt",
      id: p.id,
      sessionId: p.sessionId,
      content: p.content,
      createdAt: safeToISOString(p.createdAt),
      projectPath: p.projectPath,
      linkedMemoryId: p.linkedMemoryId,
      similarity: 1.0,
    }));

    const formattedMemories: FormattedMemory[] = memoryResults.map((r: any) => ({
      type: "memory",
      id: r.id,
      content: r.memory,
      memoryType: r.metadata?.type,
      tags: r.tags,
      createdAt: safeToISOString(r.metadata?.createdAt),
      updatedAt: r.metadata?.updatedAt ? safeToISOString(r.metadata.updatedAt) : undefined,
      similarity: r.similarity,
      metadata: r.metadata,
      displayName: r.displayName,
      userName: r.userName,
      userEmail: r.userEmail,
      projectPath: r.projectPath,
      projectName: r.projectName,
      gitRepoUrl: r.gitRepoUrl,
      isPinned: r.isPinned === 1,
      linkedPromptId: r.metadata?.promptId,
    }));

    const combinedResults = [...formattedMemories, ...formattedPrompts].sort(
      (a: any, b: any) =>
        (b.similarity || 0) - (a.similarity || 0) || b.createdAt.localeCompare(a.createdAt)
    );

    const total = combinedResults.length;
    const totalPages = Math.ceil(total / pageSize);
    const offset = (page - 1) * pageSize;
    const paginatedResults: SearchResultItem[] = combinedResults.slice(offset, offset + pageSize);

    const missingPromptIds = new Set<string>();
    const missingMemoryIds = new Set<string>();
    for (const item of paginatedResults) {
      if (item.type === "memory" && item.linkedPromptId) {
        if (!paginatedResults.some((p) => p.id === item.linkedPromptId))
          missingPromptIds.add(item.linkedPromptId);
      } else if (item.type === "prompt" && item.linkedMemoryId) {
        if (!paginatedResults.some((m) => m.id === item.linkedMemoryId))
          missingMemoryIds.add(item.linkedMemoryId);
      }
    }

    if (missingPromptIds.size > 0) {
      const extraPrompts = userPromptManager.getPromptsByIds(Array.from(missingPromptIds));
      for (const p of extraPrompts) {
        paginatedResults.push({
          type: "prompt",
          id: p.id,
          sessionId: p.sessionId,
          content: p.content,
          createdAt: safeToISOString(p.createdAt),
          projectPath: p.projectPath,
          linkedMemoryId: p.linkedMemoryId,
          similarity: 0,
          isContext: true,
        });
      }
    }

    if (missingMemoryIds.size > 0) {
      const projectShards = shardManager.getAllShards("project", "");
      for (const shard of projectShards) {
        const db = connectionManager.getConnection(shard.dbPath);
        for (const mid of missingMemoryIds) {
          const m = vectorSearch.getMemoryById(db, mid);
          if (m && !paginatedResults.some((existing) => existing.id === m.id)) {
            paginatedResults.push({
              type: "memory",
              id: m.id,
              content: m.content,
              memoryType: m.type,
              tags: m.tags ? m.tags.split(",").map((t: string) => t.trim()) : [],
              createdAt: safeToISOString(m.created_at),
              updatedAt: m.updated_at ? safeToISOString(m.updated_at) : undefined,
              similarity: 0,
              metadata: safeJSONParse(m.metadata),
              displayName: m.display_name,
              userName: m.user_name,
              userEmail: m.user_email,
              projectPath: m.project_path,
              projectName: m.project_name,
              gitRepoUrl: m.git_repo_url,
              isPinned: m.is_pinned === 1,
              linkedPromptId: safeJSONParse(m.metadata)?.promptId,
              isContext: true,
            });
          }
        }
      }
    }

    return { success: true, data: { items: paginatedResults, total, page, pageSize, totalPages } };
  } catch (error) {
    log("handleSearch: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleStats(): Promise<
  ApiResponse<{
    total: number;
    byScope: { user: number; project: number };
    byType: Record<string, number>;
  }>
> {
  try {
    // Stats only counts SQLite rows; no embedding needed.
    // See handleListTags comment - keep embedding init out of read paths.
    const projectShards = shardManager.getAllShards("project", "");
    let userCount = 0,
      projectCount = 0;
    const typeCount: Record<string, number> = {};
    for (const shard of projectShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memories = vectorSearch.getAllMemories(db);
      for (const r of memories) {
        if (r.container_tag?.includes("_user_")) userCount++;
        else if (r.container_tag?.includes("_project_")) projectCount++;
        if (r.type) typeCount[r.type] = (typeCount[r.type] || 0) + 1;
      }
    }
    return {
      success: true,
      data: {
        total: userCount + projectCount,
        byScope: { user: userCount, project: projectCount },
        byType: typeCount,
      },
    };
  } catch (error) {
    log("handleStats: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handlePinMemory(id: string): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const projectShards = shardManager.getAllShards("project", "");
    for (const shard of projectShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memory = vectorSearch.getMemoryById(db, id);
      if (memory) {
        vectorSearch.pinMemory(db, id);
        return { success: true };
      }
    }
    return { success: false, error: "Memory not found" };
  } catch (error) {
    log("handlePinMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleUnpinMemory(id: string): Promise<ApiResponse<void>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const projectShards = shardManager.getAllShards("project", "");
    for (const shard of projectShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memory = vectorSearch.getMemoryById(db, id);
      if (memory) {
        vectorSearch.unpinMemory(db, id);
        return { success: true };
      }
    }
    return { success: false, error: "Memory not found" };
  } catch (error) {
    log("handleUnpinMemory: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunCleanup(): Promise<
  ApiResponse<{ deletedCount: number; userCount: number; projectCount: number }>
> {
  try {
    const { cleanupService } = await import("./cleanup-service.js");
    const result = await cleanupService.runCleanup();
    return { success: true, data: result };
  } catch (error) {
    log("handleRunCleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunDeduplication(): Promise<
  ApiResponse<{ exactDuplicatesDeleted: number; nearDuplicateGroups: any[] }>
> {
  try {
    const { deduplicationService } = await import("./deduplication-service.js");
    const result = await deduplicationService.detectAndRemoveDuplicates();
    return { success: true, data: result };
  } catch (error) {
    log("handleRunDeduplication: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDetectMigration(): Promise<
  ApiResponse<{
    needsMigration: boolean;
    configDimensions: number;
    configModel: string;
    shardMismatches: any[];
  }>
> {
  try {
    const { migrationService } = await import("./migration-service.js");
    const result = await migrationService.detectDimensionMismatch();
    return { success: true, data: result };
  } catch (error) {
    log("handleDetectMigration: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRunMigration(strategy: "fresh-start" | "re-embed"): Promise<
  ApiResponse<{
    success: boolean;
    strategy: string;
    deletedShards: number;
    reEmbeddedMemories: number;
    duration: number;
    error?: string;
  }>
> {
  try {
    const { migrationService } = await import("./migration-service.js");
    const result = await migrationService.migrateToNewModel(strategy);
    return { success: result.success, data: result };
  } catch (error) {
    log("handleRunMigration: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDeletePrompt(
  id: string,
  cascade: boolean = false
): Promise<ApiResponse<{ deletedMemory: boolean }>> {
  try {
    if (!id) return { success: false, error: "id is required" };
    const prompt = userPromptManager.getPromptById(id);
    if (!prompt) return { success: false, error: "Prompt not found" };
    let deletedMemory = false;
    if (cascade && prompt.linkedMemoryId) {
      const result = await handleDeleteMemory(prompt.linkedMemoryId, false);
      if (result.success) deletedMemory = true;
    }
    userPromptManager.deletePrompt(id);
    return { success: true, data: { deletedMemory } };
  } catch (error) {
    log("handleDeletePrompt: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleBulkDeletePrompts(
  ids: string[],
  cascade: boolean = false
): Promise<ApiResponse<{ deleted: number }>> {
  try {
    if (!ids || ids.length === 0) return { success: false, error: "ids array is required" };
    let deleted = 0;
    for (const id of ids) {
      const result = await handleDeletePrompt(id, cascade);
      if (result.success) deleted++;
    }
    return { success: true, data: { deleted } };
  } catch (error) {
    log("handleBulkDeletePrompts: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetUserProfile(userId?: string): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");
    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }
    const profile = userProfileManager.getActiveProfile(targetUserId);
    if (!profile)
      return {
        success: true,
        data: {
          exists: false,
          userId: targetUserId,
          message: "No profile found. Keep chatting to build your profile.",
        },
      };
    const profileData = JSON.parse(profile.profileData);
    profileData.preferences = sortProfileItems(profileData.preferences as any[], "confidence");
    profileData.patterns = sortProfileItems(profileData.patterns as any[], "frequency");
    profileData.workflows = sortProfileItems(profileData.workflows as any[], "frequency");
    return {
      success: true,
      data: {
        exists: true,
        id: profile.id,
        userId: profile.userId,
        displayName: profile.displayName,
        userName: profile.userName,
        userEmail: profile.userEmail,
        version: profile.version,
        createdAt: safeToISOString(profile.createdAt),
        lastAnalyzedAt: safeToISOString(profile.lastAnalyzedAt),
        totalPromptsAnalyzed: profile.totalPromptsAnalyzed,
        profileData,
      },
    };
  } catch (error) {
    log("handleGetUserProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetProfileChangelog(
  profileId: string,
  limit: number = 5
): Promise<ApiResponse<any[]>> {
  try {
    if (!profileId) return { success: false, error: "profileId is required" };
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelogs = userProfileManager.getProfileChangelogs(profileId, limit);
    const formattedChangelogs = changelogs.map((c) => ({
      id: c.id,
      profileId: c.profileId,
      version: c.version,
      changeType: c.changeType,
      changeSummary: c.changeSummary,
      createdAt: safeToISOString(c.createdAt),
    }));
    return { success: true, data: formattedChangelogs };
  } catch (error) {
    log("handleGetProfileChangelog: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleGetProfileSnapshot(changelogId: string): Promise<ApiResponse<any>> {
  try {
    if (!changelogId) return { success: false, error: "changelogId is required" };
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const changelog = userProfileManager.getChangelogById(changelogId);
    if (!changelog) return { success: false, error: "Changelog not found" };
    const profileData = JSON.parse(changelog.profileDataSnapshot);
    return {
      success: true,
      data: {
        version: changelog.version,
        createdAt: safeToISOString(changelog.createdAt),
        profileData,
      },
    };
  } catch (error) {
    log("handleGetProfileSnapshot: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleRefreshProfile(userId?: string): Promise<ApiResponse<any>> {
  try {
    const { getTags } = await import("./tags.js");
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { userPromptManager } = await import("./user-prompt/user-prompt-manager.js");
    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }
    const profile = userProfileManager.getActiveProfile(targetUserId);
    let decayApplied = false;
    if (profile) {
      const pData = JSON.parse(profile.profileData);
      const { data: decayed, hasChanges } = userProfileManager.decayInMemory(pData);
      if (hasChanges) {
        userProfileManager.updateProfile(profile.id, decayed, 0, "Applied confidence decay");
        decayApplied = true;
      }
    }
    const unanalyzedCount = userPromptManager.countUnanalyzedForUserLearning();
    return {
      success: true,
      data: {
        message: decayApplied ? "Profile confidence decay applied" : "Profile refresh queued",
        profileExists: Boolean(profile),
        decayApplied,
        unanalyzedPrompts: unanalyzedCount,
        note: "Confidence decay runs immediately; AI profile learning still runs when the prompt threshold is reached",
      },
    };
  } catch (error) {
    log("handleRefreshProfile: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

// Temporary storage for pending AI cleanup results (userId → result)
const pendingCleanups = new Map<
  string,
  {
    cleaned: UserProfileData;
    oldProfileData: UserProfileData;
    diff: any;
    allMergedIds: string[][];
    allRemovedIds: string[];
    expiresAt: number;
  }
>();

export async function handleAICleanup(
  userId?: string,
  includeIds?: string[]
): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");
    const { aiCleanupProfile, aiCleanupProfileFromIndexed, filterProfileForCleanup } =
      await import("./user-profile/ai-cleanup.js");

    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }

    const profile = userProfileManager.getActiveProfile(targetUserId);
    if (!profile) {
      return { success: false, error: "No profile found to clean up" };
    }

    const profileData: UserProfileData = JSON.parse(profile.profileData);

    let indexed;
    let result;
    if (includeIds && includeIds.length > 0) {
      indexed = filterProfileForCleanup(profileData, includeIds);
      result = await aiCleanupProfileFromIndexed(indexed);
    } else {
      result = await aiCleanupProfile(profileData);
    }

    pendingCleanups.set(targetUserId, {
      cleaned: result.cleaned,
      oldProfileData: profileData,
      diff: result.diff,
      allMergedIds: (result.diff?.merged || []).map((m: any) => m.ids || []),
      allRemovedIds: (result.diff?.removed || []).map((r: any) => r.id),
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    return {
      success: true,
      data: {
        old: profileData,
        new: result.cleaned,
        changes: result.diff,
      },
    };
  } catch (error) {
    log("handleAICleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleApplyCleanup(userId?: string, body?: any): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");

    let targetUserId = userId;
    if (!targetUserId) {
      const tags = getTags(process.cwd());
      targetUserId = tags.user.userEmail || "unknown";
    }

    const pending = pendingCleanups.get(targetUserId);
    if (!pending) {
      return { success: false, error: "No pending cleanup found. Run AI cleanup first." };
    }

    if (Date.now() > pending.expiresAt) {
      pendingCleanups.delete(targetUserId);
      return { success: false, error: "Cleanup session expired. Run AI cleanup again." };
    }

    const profile = userProfileManager.getActiveProfile(targetUserId);
    if (!profile) {
      return { success: false, error: "Profile not found" };
    }

    const cleanedData = body?.profile || pending.cleaned;
    const acceptedMerged: string[][] = body?.acceptedMerged || [];
    const acceptedRemoved: string[] = body?.acceptedRemoved || [];

    // Partial application: start from cleaned data (which has shrunk descriptions)
    // and only apply removals for items the user unchecked.
    if (acceptedMerged.length > 0 || acceptedRemoved.length > 0) {
      const existingData: UserProfileData = JSON.parse(profile.profileData);
      const result: UserProfileData = {
        preferences: [...cleanedData.preferences],
        patterns: [...cleanedData.patterns],
        workflows: [...cleanedData.workflows],
      };

      // Remove items the user chose NOT to merge (revert to old descriptions)
      for (const id of acceptedRemoved) {
        const desc = findItemDesc(pending.oldProfileData, id);
        if (desc) removeByDesc(result, desc, itemTypeFromId(id));
      }

      // For merges: just remove the source items; target is already in cleaned
      for (const ids of acceptedMerged) {
        for (let i = 1; i < ids.length; i++) {
          const srcDesc = findItemDesc(pending.oldProfileData, ids[i] ?? "");
          if (srcDesc) removeByDesc(result, srcDesc, itemTypeFromId(ids[i] ?? ""));
        }
      }

      // Restore source items from unapproved merges
      const acceptedTargetIds = new Set(acceptedMerged.map((g) => g[0]));
      for (const groupIds of pending.allMergedIds || []) {
        if (groupIds.length <= 1) continue;
        if (acceptedTargetIds.has(groupIds[0])) continue;
        for (let i = 1; i < groupIds.length; i++) {
          const srcId = groupIds[i] ?? "";
          if (!srcId) continue;
          const srcDesc = findItemDesc(pending.oldProfileData, srcId);
          if (!srcDesc) continue;
          const srcItem = findItemByDesc(pending.oldProfileData, srcDesc);
          if (srcItem) {
            const { id: _id, ...rest } = srcItem as any;
            if (srcId.startsWith("pref_")) result.preferences.push(rest);
            else if (srcId.startsWith("pat_")) result.patterns.push(rest);
            else if (srcId.startsWith("wf_")) result.workflows.push(rest);
          }
        }
      }

      // Restore items from unapproved removals
      const acceptedRemovedSet = new Set(acceptedRemoved);
      for (const removedId of pending.allRemovedIds || []) {
        if (acceptedRemovedSet.has(removedId)) continue;
        const desc = findItemDesc(pending.oldProfileData, removedId);
        if (!desc) continue;
        const srcItem = findItemByDesc(pending.oldProfileData, desc);
        if (srcItem) {
          const { id: _id, ...rest } = srcItem as any;
          if (removedId.startsWith("pref_")) result.preferences.push(rest);
          else if (removedId.startsWith("pat_")) result.patterns.push(rest);
          else if (removedId.startsWith("wf_")) result.workflows.push(rest);
        }
      }

      const success = userProfileManager.updateProfile(
        profile.id,
        result,
        0,
        "AI cleanup applied (partial)"
      );
      if (!success)
        return { success: false, error: "Profile was modified by another session. Please retry." };
      pendingCleanups.delete(targetUserId);
      return {
        success: true,
        data: { message: "Partial cleanup applied", version: profile.version + 1 },
      };
    }

    const success = userProfileManager.updateProfile(
      profile.id,
      cleanedData,
      0,
      "AI cleanup applied"
    );

    if (!success) {
      return { success: false, error: "Profile was modified by another session. Please retry." };
    }

    pendingCleanups.delete(targetUserId);

    return {
      success: true,
      data: { message: "Cleanup applied successfully", version: profile.version + 1 },
    };
  } catch (error) {
    log("handleApplyCleanup: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

function itemTypeFromId(id: string): string {
  if (id.startsWith("pref_")) return "preferences";
  if (id.startsWith("pat_")) return "patterns";
  return "workflows";
}
function findItemDesc(profile: UserProfileData, id: string): string | null {
  if (typeof id !== "string" || !id.includes("_")) return null;
  const parts = id.split("_");
  const prefix = parts[0];
  const idx = parseInt(parts[1] || "", 10);
  if (isNaN(idx)) return null;

  if (prefix === "pref") return profile.preferences[idx]?.description || null;
  if (prefix === "pat") return profile.patterns[idx]?.description || null;
  if (prefix === "wf") return profile.workflows[idx]?.description || null;

  return null;
}
function findItemByDesc(profile: UserProfileData, desc: string): any | null {
  for (const key of ["preferences", "patterns", "workflows"] as const) {
    const found = (profile as any)[key].find((p: any) => p.description === desc);
    if (found) return found;
  }
  return null;
}
function removeByDesc(profile: UserProfileData, desc: string, itemType?: string) {
  if (!itemType || itemType === "preferences") {
    profile.preferences = profile.preferences.filter((p) => p.description !== desc);
  }
  if (!itemType || itemType === "patterns") {
    profile.patterns = profile.patterns.filter((p) => p.description !== desc);
  }
  if (!itemType || itemType === "workflows") {
    profile.workflows = profile.workflows.filter((w) => w.description !== desc);
  }
}

export async function handleUpdateProfileItem(body?: any): Promise<ApiResponse<any>> {
  try {
    const { userProfileManager } = await import("./user-profile/user-profile-manager.js");
    const { getTags } = await import("./tags.js");

    const tags = getTags(process.cwd());
    const userId = tags.user.userEmail || "unknown";
    if (!userId) return { success: false, error: "Unable to resolve user identity" };

    const profile = userProfileManager.getActiveProfile(userId);
    if (!profile) return { success: false, error: "No profile found" };

    const { type, index, action, category, description, steps } = body || {};
    if (!type || index === undefined || !action) {
      return { success: false, error: "type, index, and action are required" };
    }
    if (!["preferences", "patterns", "workflows"].includes(type)) {
      return { success: false, error: "type must be preferences, patterns, or workflows" };
    }
    if (!["edit", "delete"].includes(action)) {
      return { success: false, error: "action must be edit or delete" };
    }

    const profileData: UserProfileData = JSON.parse(profile.profileData);
    const items: any[] = (profileData as any)[type] || [];
    // Re-sort to match handleGetUserProfile's display order
    const metric = type === "preferences" ? "confidence" : "frequency";
    const sorted = sortProfileItems(items as any[], metric);

    if (index < 0 || index >= sorted.length) {
      return { success: false, error: "index out of range" };
    }

    if (action === "delete") {
      sorted.splice(index, 1);
    } else {
      const item = sorted[index];
      if (!item) return { success: false, error: "Item not found" };
      if (category !== undefined && type !== "workflows") item.category = category;
      if (description !== undefined && description !== item.description) {
        item.description = description;
        item.centroid = undefined;
        item.anchor = undefined;
      }
      if (steps !== undefined && Array.isArray(steps) && type === "workflows") item.steps = steps;
    }

    (profileData as any)[type] = sorted;

    const changeSummary =
      action === "delete"
        ? `Deleted ${type.slice(0, -1)} at index ${index}`
        : `Edited ${type.slice(0, -1)} at index ${index}`;

    const success = userProfileManager.updateProfile(profile.id, profileData, 0, changeSummary);
    if (!success)
      return { success: false, error: "Profile was modified by another session. Please retry." };

    return {
      success: true,
      data: { message: `${action} successful`, version: profile.version + 1 },
    };
  } catch (error) {
    log("handleUpdateProfileItem: error", { error: String(error) });
    return { success: false, error: String(error) };
  }
}

export async function handleDetectTagMigration(): Promise<
  ApiResponse<{ needsMigration: boolean; count: number }>
> {
  try {
    const projectShards = shardManager.getAllShards("project", "");
    let untaggedCount = 0;
    for (const shard of projectShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const rows = db
        .prepare("SELECT COUNT(*) as count FROM memories WHERE tags IS NULL OR tags = ''")
        .get() as any;
      untaggedCount += rows.count;
    }
    return { success: true, data: { needsMigration: untaggedCount > 0, count: untaggedCount } };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

interface MigrationProgress {
  processed: number;
  total: number;
  currentBatch: number;
  totalBatches: number;
  isComplete: boolean;
  errors: string[];
}

let migrationProgress: MigrationProgress = {
  processed: 0,
  total: 0,
  currentBatch: 0,
  totalBatches: 0,
  isComplete: true,
  errors: [],
};

export async function handleGetTagMigrationProgress(): Promise<ApiResponse<MigrationProgress>> {
  return { success: true, data: migrationProgress };
}

export async function handleRunTagMigrationBatch(
  batchSize: number = 5
): Promise<ApiResponse<{ processed: number; total: number; hasMore: boolean }>> {
  try {
    const { AIProviderFactory } = await import("./ai/ai-provider-factory.js");
    const { buildMemoryProviderConfig } = await import("./ai/provider-config.js");
    const providerConfig = buildMemoryProviderConfig(CONFIG, {
      maxIterations: 1,
      iterationTimeout: 30000,
    });
    const provider = AIProviderFactory.createProvider(CONFIG.memoryProvider, providerConfig);
    const projectShards = shardManager.getAllShards("project", "");

    let batchProcessed = 0;
    const allMemories: { memory: any; shard: any }[] = [];

    for (const shard of projectShards) {
      const db = connectionManager.getConnection(shard.dbPath);
      const memories = db.prepare("SELECT * FROM memories").all() as any[];
      for (const m of memories) {
        allMemories.push({ memory: m, shard });
      }
    }

    if (migrationProgress.total === 0) {
      migrationProgress.total = allMemories.length;
      migrationProgress.totalBatches = Math.ceil(allMemories.length / batchSize);
      migrationProgress.isComplete = false;
    }

    const startIdx = migrationProgress.processed;
    const endIdx = Math.min(startIdx + batchSize, allMemories.length);

    for (let i = startIdx; i < endIdx; i++) {
      const item = allMemories[i];
      if (!item) continue;
      const { memory: m, shard } = item;
      const db = connectionManager.getConnection(shard.dbPath);

      try {
        let currentTags = m.tags
          ? m.tags
              .split(",")
              .map((t: string) => t.trim().toLowerCase())
              .filter((t: string) => t)
          : [];

        if (currentTags.length === 0) {
          const prompt = `Generate 2-4 short technical tags for this memory content:\n\n${m.content}\n\nReturn ONLY a comma-separated list of tags.`;
          const result = await provider.executeToolCall(
            "You are a technical tagger.",
            prompt,
            {
              type: "function",
              function: {
                name: "save_tags",
                description: "Save generated tags",
                parameters: {
                  type: "object",
                  properties: { tags: { type: "array", items: { type: "string" } } },
                  required: ["tags"],
                },
              },
            },
            `migration_${m.id}`
          );
          if (result.success && result.data?.tags) {
            currentTags = result.data.tags;
            db.prepare("UPDATE memories SET tags = ? WHERE id = ?").run(
              currentTags.join(","),
              m.id
            );
          }
        }

        const vector = await embeddingService.embedWithTimeout(m.content);
        const tagsVector = currentTags.length
          ? await embeddingService.embedWithTimeout(currentTags.join(", "))
          : undefined;
        const vectorBuffer = new Uint8Array(vector.buffer);
        db.prepare("UPDATE memories SET vector = ?, updated_at = ? WHERE id = ?").run(
          vectorBuffer,
          Date.now(),
          m.id
        );

        await vectorSearch.updateVector(db, m.id, vector, shard, tagsVector);

        migrationProgress.processed++;
        batchProcessed++;
      } catch (e) {
        const errorMsg = String(e);
        migrationProgress.errors.push(errorMsg);
        log("Migration error for memory", { id: m.id, error: errorMsg });
      }
    }

    migrationProgress.currentBatch++;
    const hasMore = migrationProgress.processed < migrationProgress.total;

    if (!hasMore) {
      migrationProgress.isComplete = true;
    }

    return {
      success: true,
      data: { processed: migrationProgress.processed, total: migrationProgress.total, hasMore },
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
