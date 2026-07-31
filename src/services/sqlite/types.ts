// 数据分片信息接口，描述单个向量数据库分片的核心元数据
export interface ShardInfo {
  // 分片唯一标识符，全局唯一自增ID
  id: number;
  // 分片所属的作用域，仅支持个人用户级或项目级两种类型
  scope: "user" | "project";
  // 作用域哈希值，对应用户ID或项目ID的哈希摘要，用于分片路由定位
  scopeHash: string;
  // 分片在所属作用域内的序号，标识同一作用域下的分片顺序
  shardIndex: number;
  // 分片对应的数据库文件在本地文件系统的绝对存储路径
  dbPath: string;
  // 当前分片内存储的向量总数，用于负载均衡和分片扩容判断
  vectorCount: number;
  // 分片激活状态标记，true表示该分片可正常提供读写服务
  isActive: boolean;
  // 分片创建时间戳，Unix毫秒级时间戳，用于分片生命周期管理
  createdAt: number;
}

// 记忆记录实体接口，定义单条记忆向量数据的完整结构
export interface MemoryRecord {
  // 记忆记录全局唯一ID，采用UUID或分布式唯一ID生成
  id: string;
  // 记忆的原始文本内容，用户创建记忆时输入的源文本
  content: string;
  // 记忆文本转换后的语义向量，32位浮点数数组存储高维向量
  vector: Float32Array;
  // 标签专属语义向量，可选字段，存储记忆所有标签聚合生成的向量
  tagsVector?: Float32Array;
  // 容器标签，用于对记忆进行粗粒度分类的标识字段
  containerTag: string;
  // 记忆的自定义标签字符串，可选字段，多标签通常以分隔符拼接存储
  tags?: string;
  // 记忆类型标记，可选字段，用于区分代码、文档、对话等不同类型的记忆
  type?: string;
  // 记忆创建时间戳，Unix毫秒级时间戳
  createdAt: number;
  // 记忆最后更新时间戳，Unix毫秒级时间戳，每次修改都会更新
  updatedAt: number;
  // 扩展元数据序列化字符串，可选字段，存储业务自定义的结构化数据
  metadata?: string;
  // 记忆展示名称，用户可编辑的记忆别名，用于前端友好展示
  displayName?: string;
  // 记忆创建者的用户名，记录该记忆所属的用户账号名称
  userName?: string;
  // 记忆创建者的邮箱地址，用于关联用户身份信息
  userEmail?: string;
  // 记忆所属的项目本地绝对路径，仅项目级记忆会填充该字段
  projectPath?: string;
  // 记忆所属的项目名称，项目的自定义展示名称
  projectName?: string;
  // 记忆关联的Git仓库远程地址，仅关联代码仓库的记忆会填充
  gitRepoUrl?: string;
}

// 向量搜索结果接口，定义相似度搜索返回的结果项结构
export interface SearchResult {
  // 匹配到的记忆记录全局唯一ID，与MemoryRecord的id字段一一对应
  id: string;
  // 匹配到的记忆原始文本内容，同MemoryRecord的content字段
  memory: string;
  // 与搜索请求的语义相似度得分，取值范围通常为0到1，值越高匹配度越好
  similarity: number;
  // 记忆的标签数组，可选字段，从原序列化标签字符串拆分后的结构化数组
  tags?: string[];
  // 解析后的扩展元数据对象，可选字段，从原序列化字符串反序列化后的结构化数据
  metadata?: Record<string, unknown>;
  // 记忆的展示名称，同MemoryRecord的displayName字段，用于前端直接展示
  displayName?: string;
  // 记忆创建者的用户名，同MemoryRecord的userName字段
  userName?: string;
  // 记忆创建者的邮箱地址，同MemoryRecord的userEmail字段
  userEmail?: string;
  // 记忆所属的项目本地路径，同MemoryRecord的projectPath字段
  projectPath?: string;
  // 记忆所属的项目名称，同MemoryRecord的projectName字段
  projectName?: string;
  // 记忆关联的Git仓库地址，同MemoryRecord的gitRepoUrl字段
  gitRepoUrl?: string;
}
