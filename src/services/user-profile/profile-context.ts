// 导入用户档案管理器，用于获取和操作用户的完整档案数据
import { userProfileManager } from "./user-profile-manager.js";
// 导入全局配置文件，包含用户档案注入相关的参数配置
import { CONFIG } from "../../config.js";
// 导入用户档案数据的类型定义，提供类型安全保障
import type { UserProfileData } from "./types.js";
// 导入档案条目排序工具函数，用于按指定维度排序各类档案数据
import { sortProfileItems } from "../../utils/profile.js";
// 导入日志记录工具，用于输出档案注入的调试和监控日志
import { log } from "../logger.js";

/**
 * 按类别对条目去重并保留指定数量的顶级结果
 * @param items 待处理的原始条目数组
 * @param topN 需要保留的最大结果数量
 * @returns 去重后保留指定数量的条目数组
 */
function dedupByCategory(items: any[], topN: number): any[] {
  // 若条目总数未超过需保留的数量，直接返回原始数组，无需处理
  if (items.length <= topN) return items;
  // 初始化已见类别集合，用于追踪已加入结果的类别，避免重复
  const seen = new Set<string>();
  // 初始化结果数组，存储去重后的最终条目
  const result: any[] = [];
  // 遍历原始条目数组，按顺序处理每个条目
  for (const item of items) {
    // 若当前条目所属类别已存在，跳过该条目以避免重复
    if (seen.has(item.category)) continue;
    // 将当前条目类别加入已见集合，标记该类别已处理
    seen.add(item.category);
    // 将当前条目加入结果数组
    result.push(item);
    // 若结果数组长度已达到需保留的最大数量，终止遍历
    if (result.length >= topN) break;
  }
  // 返回处理完成的去重结果数组
  return result;
}

/**
 * 基于时间衰减模型对条目进行综合评分排序，融合置信度与时效性权重
 * @param items 待排序的原始条目数组
 * @returns 按综合得分降序排列的新数组（不修改原数组）
 */
function scoreByRecency(items: any[]): any[] {
  // 获取当前时间戳，作为时间衰减计算的基准点
  const now = Date.now();
  // 创建原数组的副本进行排序，避免修改原始输入数组的顺序
  return [...items].sort((a, b) => {
    // 计算条目a的存活天数：当前时间与最后更新时间的差转换为自然日
    const ageA = (now - (a.lastSeen || 0)) / (24 * 60 * 60 * 1000);
    // 计算条目b的存活天数，同上述逻辑保持一致
    const ageB = (now - (b.lastSeen || 0)) / (24 * 60 * 60 * 1000);
    // 计算条目a的综合得分：70%权重来自条目本身的置信度，30%权重来自90天半衰期的指数时间衰减
    const scoreA = (a.confidence || 0) * 0.7 + Math.exp(-ageA / 90) * 0.3;
    // 计算条目b的综合得分，采用与条目a完全一致的加权规则
    const scoreB = (b.confidence || 0) * 0.7 + Math.exp(-ageB / 90) * 0.3;
    // 按得分降序排列，确保高评分条目优先展示
    return scoreB - scoreA;
  });
}

/**
 * 转义XML文本节点中的特殊字符，防止XML解析错误与注入风险
 * @param value 待转义的任意类型输入值
 * @returns 完成特殊字符转义的安全字符串
 */
function escapeXmlText(value: unknown): string {
  // 将输入转换为字符串，空值处理为空字符串避免异常
  return (
    String(value ?? "")
      // 转义&符号，必须优先处理避免二次转义其他已转义的实体
      .replace(/&/g, "&amp;")
      // 转义左尖括号，防止被识别为XML标签的起始符
      .replace(/</g, "&lt;")
      // 转义右尖括号，防止被识别为XML标签的结束符
      .replace(/>/g, "&gt;")
  );
}

/**
 * 转义XML属性值中的特殊字符，强化属性节点的安全性与合法性
 * @param value 待转义的任意类型输入值
 * @returns 完成特殊字符转义的安全属性字符串
 */
function escapeXmlAttr(value: unknown): string {
  // 将输入转换为字符串，空值处理为空字符串保证鲁棒性
  return (
    String(value ?? "")
      // 优先转义&符号，避免后续转义产生的实体被错误解析
      .replace(/&/g, "&amp;")
      // 转义左尖括号，防止属性值内出现非法标签起始符
      .replace(/</g, "&lt;")
      // 转义右尖括号，防止属性值内出现非法标签结束符
      .replace(/>/g, "&gt;")
      // 转义双引号，防止属性值提前闭合引发XML结构破坏
      .replace(/"/g, "&quot;")
  );
}

// 导出获取用户档案上下文的核心函数，接收用户ID参数，返回构建好的XML格式上下文字符串或空值
export function getUserProfileContext(userId: string): string | null {
  // 调用用户档案管理器的活跃档案获取方法，传入当前用户ID拉取对应档案实例
  const profile = userProfileManager.getActiveProfile(userId);
  // 若未获取到该用户的有效活跃档案，直接返回空值终止流程
  if (!profile) {
    return null;
  }
  // 将档案中存储的JSON格式原始数据解析为类型安全的UserProfileData结构化对象
  const profileData: UserProfileData = JSON.parse(profile.profileData);
  // 初始化上下文片段容器数组，用于按顺序拼接所有XML节点内容
  const parts: string[] = [];
  // 读取配置中用户偏好的最大注入数量，配置缺失时默认保留5条偏好数据
  const injectPrefs = CONFIG.userProfileInjectPreferences ?? 5;
  // 读取配置中用户行为模式的最大注入数量，配置缺失时默认保留5条模式数据
  const injectPats = CONFIG.userProfileInjectPatterns ?? 5;
  // 读取配置中用户工作流的最大注入数量，配置缺失时默认保留3条工作流数据
  const injectWfs = CONFIG.userProfileInjectWorkflows ?? 3;

  // 对用户偏好数据进行排序：先检查是否存在有效偏好数据
  const sortedPrefs =
    profileData.preferences.length > 0
      ? // 存在数据时调用排序工具，以置信度为权重降序排列偏好条目
        (sortProfileItems(profileData.preferences as any[], "confidence") as any[])
      : // 无有效数据时返回空数组，避免后续处理报错
        [];
  // 对用户行为模式数据进行排序：先检查是否存在有效行为模式数据
  const sortedPats =
    profileData.patterns.length > 0
      ? // 存在数据时调用排序工具，以出现频率为权重降序排列模式条目
        (sortProfileItems(profileData.patterns as any[], "frequency") as any[])
      : // 无有效数据时返回空数组，避免后续处理报错
        [];
  // 对用户工作流数据进行排序：先检查是否存在有效工作流数据
  const sortedWfs =
    profileData.workflows.length > 0
      ? // 存在数据时调用排序工具，以使用频率为权重降序排列工作流条目
        (sortProfileItems(profileData.workflows as any[], "frequency") as any[])
      : // 无有效数据时返回空数组，避免后续处理报错
        [];

  // 处理最终保留的偏好数据：先截取2倍配置数量的候选集，再应用时间衰减评分排序，最后按类别去重保留配置数量的结果
  const topPrefs = dedupByCategory(
    scoreByRecency(sortedPrefs.slice(0, injectPrefs * 2)),
    injectPrefs
  );
  // 处理最终保留的行为模式数据：直接对已排序的模式数据按类别去重，保留配置数量的结果
  const topPats = dedupByCategory(sortedPats, injectPats);
  // 处理最终保留的工作流数据：仅截取配置数量的顶部条目，无需额外去重处理
  const topWfs = sortedWfs.slice(0, injectWfs);

  // 存在有效用户偏好数据时，构建偏好XML节点块
  if (topPrefs.length > 0) {
    // 写入用户偏好根节点的起始标签，包裹所有子偏好条目
    parts.push("<user_preferences>");
    // 遍历所有过滤后的顶级偏好条目，生成独立XML节点
    topPrefs.forEach((pref: any) => {
      // 构建单条偏好的XML节点：将类别作为属性转义后嵌入，描述文本转义后作为节点内容
      parts.push(
        `<user_preference category="${escapeXmlAttr(pref.category)}">${escapeXmlText(pref.description)}</user_preference>`
      );
    });
    // 写入用户偏好根节点的闭合标签，完成该模块的XML结构封装
    parts.push("</user_preferences>");
  }

  // 存在有效用户行为模式数据时，构建行为模式XML节点块
  if (topPats.length > 0) {
    // 写入用户行为模式根节点的起始标签，包裹所有子模式条目
    parts.push("<user_patterns>");
    // 遍历所有过滤后的顶级行为模式条目，生成独立XML节点
    topPats.forEach((pattern: any) => {
      // 构建单条模式的XML节点：将类别作为属性转义后嵌入，描述文本转义后作为节点内容
      parts.push(
        `<user_pattern category="${escapeXmlAttr(pattern.category)}">${escapeXmlText(pattern.description)}</user_pattern>`
      );
    });
    // 写入用户行为模式根节点的闭合标签，完成该模块的XML结构封装
    parts.push("</user_patterns>");
  }

  // 当存在有效用户工作流数据时，构建工作流XML节点块
  if (topWfs.length > 0) {
    // 写入用户工作流根节点的起始标签，包裹所有子工作流条目
    parts.push("<user_workflows>");
    // 遍历所有过滤后的顶级工作流条目，生成独立XML节点
    topWfs.forEach((workflow: any) => {
      // 读取工作流使用频率，无有效数据时默认设为1次
      const frequency = workflow.frequency || 1;
      // 构建工作流附加信息字符串：若存在步骤列表则拼接步骤链路，否则仅展示使用频率
      const steps = workflow.steps?.length
        ? ` (${frequency}x: ${workflow.steps.join(" → ")})`
        : ` (${frequency}x)`;
      // 构建单条工作流的XML节点：将频率作为属性嵌入，描述文本转义后作为节点内容，附加步骤信息
      parts.push(
        `<user_workflow frequency="${frequency}x">${escapeXmlText(workflow.description)}${steps}</user_workflow>`
      );
    });
    // 写入用户工作流根节点的闭合标签，完成该模块的XML结构封装
    parts.push("</user_workflows>");
  }

  // 当存在有效学习路径数据时，构建学习路径XML节点块
  if ((profileData as any).learning_paths?.length > 0) {
    // 写入学习路径根节点的起始标签，包裹所有子学习路径条目
    parts.push("<learning_paths>");
    // 仅截取前3条学习路径数据，遍历生成独立XML节点
    (profileData as any).learning_paths.slice(0, 3).forEach((path: any) => {
      // 构建单条学习路径的XML节点：将主题作为属性转义后嵌入，描述文本转义后作为节点内容
      parts.push(
        `<learning_path topic="${escapeXmlAttr(path.topic)}">${escapeXmlText(path.description)}</learning_path>`
      );
    });
    // 写入学习路径根节点的闭合标签，完成该模块的XML结构封装
    parts.push("</learning_paths>");
  }

  // 若所有模块都无有效数据，上下文容器为空，直接返回空值终止流程
  if (parts.length === 0) {
    return null;
  }

  // 将所有XML片段按换行符拼接为完整的上下文字符串
  const text = parts.join("\n");

  // 当三类核心档案数据（偏好/行为模式/工作流）存在有效数据时，记录注入日志
  if (topPrefs.length + topPats.length + topWfs.length > 0) {
    // 调用日志工具记录档案注入事件，附带格式化后的关键数据用于监控调试
    log("profile inject", {
      // 格式化用户偏好数据：拼接类别与描述文本，单条截断至80字符避免日志过长
      prefs: topPrefs.map((p: any) => `[${p.category}] ${p.description}`.substring(0, 80)),
      // 格式化行为模式数据：采用与偏好一致的截断规则，统一日志输出格式
      pats: topPats.map((p: any) => `[${p.category}] ${p.description}`.substring(0, 80)),
      // 格式化工作流数据：仅截取描述文本前80字符，精简高频冗余信息
      wfs: topWfs.map((w: any) => w.description.substring(0, 80)),
    });
  }

  // 返回组装完成的XML格式用户档案上下文字符串
  return text;
}
