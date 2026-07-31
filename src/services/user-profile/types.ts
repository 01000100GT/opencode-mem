export interface UserProfilePreference {
  // 偏好分类标签，用于归类用户的不同兴趣方向
  category: string;
  // 偏好的自然语言描述，清晰说明该偏好的具体内容
  description: string;
  // 模型对该偏好存在的确信度评分，范围通常为0到1
  confidence: number;
  // 该偏好行为在用户历史数据中的出现频次
  frequency: number;
  // 支撑该偏好存在的所有证据片段列表，通常为相关prompt或行为记录ID
  evidence: string[];
  // 该偏好最后一次被观测到的时间戳（毫秒级Unix时间）
  lastSeen: number;
  // 向量空间中该偏好簇的质心坐标，用于聚类计算
  centroid?: number[];
  // 该偏好的锚点向量，作为偏好特征的基准参考点
  anchor?: number[];
  // 弱匹配命中次数，用于标记边界模糊的潜在匹配
  weakHitCount?: number;
  // 最后一次发生弱匹配的时间戳
  lastWeakHitAt?: number;
  // 特征向量偏离锚点超过阈值的累计次数，用于检测偏好漂移
  driftBelowCount?: number;
  // 贝叶斯更新中强正样本的计数先验参数
  alpha?: number;
  // 贝叶斯更新中强负样本的计数先验参数
  beta?: number;
  // 弱正样本的贝叶斯先验计数参数
  weakAlpha?: number;
  // 弱负样本的贝叶斯先验计数参数
  weakBeta?: number;
  // 标记该偏好是否有待人工或模型二次验证确认
  pendingValidation?: boolean;
  // 该偏好最后一次匹配到用户新行为的时间戳
  lastMatchTime?: number;
  // 该偏好第一次被模型观测到的时间戳
  firstSeen?: number;
}

// 用户行为模式档案，用于记录模型从用户行为序列中挖掘出的稳定行为规律
export interface UserProfilePattern {
  // 行为模式的分类标签，用于将模式归类到特定的行为领域或业务场景
  category: string;
  // 行为模式的自然语言描述，精准阐述该模式的核心行为逻辑与触发条件
  description: string;
  // 模型对该行为模式存在的确信度评分，取值范围为0到1，数值越高可信度越强
  confidence: number;
  // 该行为模式在用户全量历史行为数据中的累计出现频次，反映模式的稳定性
  frequency: number;
  // 支撑该行为模式成立的所有证据片段列表，存储关联的prompt或行为记录唯一标识
  evidence: string[];
  // 该行为模式最后一次被观测到的毫秒级Unix时间戳，用于追踪模式的活跃状态
  lastSeen: number;
  // 向量空间中该行为模式簇的质心坐标，用于模式聚类与相似性计算
  centroid?: number[];
  // 该行为模式的锚点向量，作为模式特征的基准参考，用于检测行为特征的偏移
  anchor?: number[];
  // 弱匹配命中的累计次数，用于标记边界模糊、存疑的潜在模式匹配
  weakHitCount?: number;
  // 最后一次发生弱匹配的毫秒级Unix时间戳，用于追踪存疑匹配的时间分布
  lastWeakHitAt?: number;
  // 特征向量偏离锚点向量超过预设阈值的累计次数，用于检测行为模式的漂移
  driftBelowCount?: number;
  // 贝叶斯更新模型中强正样本的计数先验参数，用于置信度的迭代计算
  alpha?: number;
  // 贝叶斯更新模型中强负样本的计数先验参数，用于置信度的迭代计算
  beta?: number;
  // 贝叶斯更新模型中弱正样本的计数先验参数，适配模糊样本的置信度更新逻辑
  weakAlpha?: number;
  // 贝叶斯更新模型中弱负样本的计数先验参数，适配模糊样本的置信度更新逻辑
  weakBeta?: number;
  // 标记该行为模式是否有待人工审核或模型二次验证，标识待确认的模式
  pendingValidation?: boolean;
  // 该行为模式最后一次匹配到用户新增行为的毫秒级Unix时间戳，追踪模式的时效性
  lastMatchTime?: number;
  // 该行为模式第一次被模型观测并提取的毫秒级Unix时间戳，记录模式的起源时间
  firstSeen?: number;
}

// 用户工作流档案，用于记录模型从用户行为序列中挖掘出的多步骤连贯任务执行链条
export interface UserProfileWorkflow {
  // 工作流的自然语言描述，精准阐述该流程的核心业务逻辑与执行链路
  description: string;
  // 构成该工作流的所有执行步骤列表，按时间顺序存储步骤的自然语言描述或唯一标识
  steps: string[];
  // 模型对该工作流存在的确信度评分，取值范围为0到1，数值越高可信度越强
  confidence: number;
  // 该工作流在用户全量历史行为数据中的累计出现频次，反映流程的稳定性与复现性
  frequency: number;
  // 支撑该工作流成立的所有证据片段列表，存储关联的prompt或行为记录唯一标识
  evidence: string[];
  // 该工作流最后一次被观测到的毫秒级Unix时间戳，用于追踪流程的活跃状态
  lastSeen: number;
  // 向量空间中该工作流簇的质心坐标，用于流程聚类与相似性计算
  centroid?: number[];
  // 该工作流的锚点向量，作为流程特征的基准参考，用于检测行为特征的偏移
  anchor?: number[];
  // 弱匹配命中的累计次数，用于标记边界模糊、存疑的潜在流程匹配
  weakHitCount?: number;
  // 最后一次发生弱匹配的毫秒级Unix时间戳，用于追踪存疑匹配的时间分布
  lastWeakHitAt?: number;
  // 特征向量偏离锚点向量超过预设阈值的累计次数，用于检测工作流的特征漂移
  driftBelowCount?: number;
  // 贝叶斯更新模型中强正样本的计数先验参数，用于置信度的迭代计算
  alpha?: number;
  // 贝叶斯更新模型中强负样本的计数先验参数，用于置信度的迭代计算
  beta?: number;
  // 贝叶斯更新模型中弱正样本的计数先验参数，适配模糊样本的置信度更新逻辑
  weakAlpha?: number;
  // 贝叶斯更新模型中弱负样本的计数先验参数，适配模糊样本的置信度更新逻辑
  weakBeta?: number;
  // 标记该工作流是否有待人工审核或模型二次验证，标识待确认的流程
  pendingValidation?: boolean;
  // 该工作流最后一次匹配到用户新增行为的毫秒级Unix时间戳，追踪流程的时效性
  lastMatchTime?: number;
  // 该工作流第一次被模型观测并提取的毫秒级Unix时间戳，记录流程的起源时间
  firstSeen?: number;
}
// 用户画像核心数据集容器，统一聚合所有从用户行为中挖掘出的特征实体
export interface UserProfileData {
  // 用户兴趣偏好集合，存储所有经过模型识别的用户个性化偏好条目
  preferences: UserProfilePreference[];
  // 用户行为模式集合，存储所有从行为序列中提取的稳定可重复行为规律
  patterns: UserProfilePattern[];
  // 用户工作流集合，存储所有识别出的多步骤连贯任务执行流程链条
  workflows: UserProfileWorkflow[];
  // 用户学习路径集合（可选字段），存储模型挖掘的用户循序渐进的学习轨迹，每个路径包含主题、步骤链和描述
  learning_paths?: { topic: string; chain: string[]; description: string }[];
}

// 用户画像主实体，整合基础身份信息、分析数据与特征数据集，是用户画像系统的核心存储对象
export interface UserProfile {
  // 当前画像记录的唯一标识符，用于系统内唯一索引和关联查询
  id: string;
  // 画像所属用户的业务系统用户ID，建立画像与主体用户的绑定关系
  userId: string;
  // 用户对外展示的昵称名称，用于前端界面的用户标识展示
  displayName: string;
  // 用户在系统内注册的唯一用户名，通常用于登录和身份识别
  userName: string;
  // 用户绑定的邮箱地址，用于账户通信和身份验证场景
  userEmail: string;
  // 序列化后的用户特征数据字符串，存储JSON.stringify处理后的UserProfileData对象，适配持久化存储需求
  profileData: string;
  // 画像的版本号，每次更新时自增，用于追踪画像的迭代变更历史
  version: number;
  // 画像记录创建的毫秒级Unix时间戳，记录画像的生成时间
  createdAt: number;
  // 画像最后一次完成全量行为分析的毫秒级Unix时间戳，用于判断画像的时效性和更新触发条件
  lastAnalyzedAt: number;
  // 生成当前画像过程中累计分析的用户提示词（Prompt）总数量，用于评估画像的数据基础规模
  totalPromptsAnalyzed: number;
  // 标记当前画像是否为活跃状态，标识该画像是否持续参与系统的更新和推荐流程
  isActive: boolean;
}

// 用户画像变更日志实体，用于记录画像的每一次迭代更新轨迹，支持版本回溯与变更审计
export interface UserProfileChangelog {
  // 变更日志记录的唯一标识符，用于系统内唯一索引和关联查询
  id: string;
  // 关联的用户画像ID，建立日志与所属画像的绑定关系
  profileId: string;
  // 本次变更对应的画像版本号，与UserProfile中的version字段一一对应
  version: number;
  // 变更类型标识，用于分类不同的画像更新操作（如偏好新增、模式更新等）
  changeType: string;
  // 变更内容的自然语言摘要，简要描述本次更新的核心修改点
  changeSummary: string;
  // 变更完成后用户画像数据的序列化快照，存储JSON.stringify处理后的UserProfileData对象，支持版本回溯
  profileDataSnapshot: string;
  // 本次变更日志记录的创建时间戳（毫秒级Unix时间），记录变更发生的准确时间
  createdAt: number;
}
