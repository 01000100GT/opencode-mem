// 导入用户资料数据的类型定义
import type { UserProfileData } from "./types.js";
// 导入全局配置对象
import { CONFIG } from "../../config.js";
// 导入日志记录工具
import { log } from "../logger.js";
// 导入AI提供商加载函数
import { loadOpencodeProvider } from "../ai/opencode-provider-loader.js";

// AI清理操作的返回结果接口
export interface AICleanupResult {
  // 清理后的用户资料数据
  cleaned: UserProfileData;
  // 清理过程中产生的差异记录
  diff: CleanupDiff;
}

// 清理差异记录的接口，用于追踪所有条目的处理情况
export interface CleanupDiff {
  // 直接保留未做修改的条目描述列表
  kept: string[];
  // 合并的条目组列表，每组包含源条目ID数组和合并后的结果描述
  merged: Array<{ ids: string[]; result: string }>;
  // 被移除的条目列表，包含条目ID和移除原因
  removed: Array<{ id: string; reason: string }>;
}

// 导出用户资料AI清理主函数，接收原始用户资料数据，返回清理完成的结果和变更记录
export async function aiCleanupProfile(profileData: UserProfileData): Promise<AICleanupResult> {
  // 记录流程启动时间戳，用于后续统计各阶段耗时
  const t0 = Date.now();
  // 为原始用户资料的所有条目分配唯一标识ID，构建带索引的资料结构用于后续追踪
  const indexed = addIdsToProfile(profileData);
  // 基于带索引的用户资料构建AI清理任务的提示词，输入给大模型处理
  const prompt = buildAICleanupPrompt(indexed);

  // 打印提示词构建完成的日志，输出各类条目数量、提示词长度和构建耗时
  // 记录AI清理流程中提示词构建完成的关键指标，用于性能监控和问题排查
  log("AI cleanup: prompt built", {
    // 输入到提示词中的用户偏好设置条目总数
    prefCount: indexed.preferences.length,
    // 输入到提示词中的行为模式条目总数
    patCount: indexed.patterns.length,
    // 输入到提示词中的工作流条目总数
    wfCount: indexed.workflows.length,
    // 生成的提示词总字符长度，用于评估是否会超出大模型上下文窗口限制
    promptLen: prompt.length,
    // 提示词构建阶段消耗的毫秒数，统计预处理环节的性能开销
    buildMs: Date.now() - t0,
  });

  // 记录AI调用开始时间戳，用于统计大模型推理耗时
  const aiStart = Date.now();
  // 调用AI清理核心函数，传入构建好的提示词，等待大模型返回清理结果
  const result = await callAICleanup(prompt);
  // 打印AI响应接收日志，记录本次大模型调用的耗时，用于性能监控
  log("AI cleanup: AI response received", { callMs: Date.now() - aiStart });

  // 以条目ID为键，构建AI返回的清理后条目的索引映射，方便后续快速查询
  const cleanedById = buildItemIndex(result.profile);
  // 以条目ID为键，构建原始输入条目的索引映射，用于后续数据比对和恢复
  const originalById = buildItemIndex(indexed);
  // 初始化计数器，分别统计实际使用的AI清理后条目数量、保留的原始条目数量
  const counters = { cleaned: 0, original: 0 };

  // 基于AI返回的映射关系重构用户资料，合并原始数据元信息与AI生成的清理后内容
  const cleaned = rebuildProfileUsing(result.mapping, cleanedById, originalById, counters);
  // 根据原始资料和AI映射生成完整的清理差异记录，追踪所有条目的处理状态
  const diff = generateDiff(indexed, result.mapping);

  // 提取清理后偏好列表的第一个条目作为样本，用于后续日志输出调试
  const sampleCleaned = result.profile.preferences[0];
  // 记录资料重构完成日志，输出各类关键统计指标用于调试和性能分析
  log("AI cleanup: rebuild done", {
    // AI返回结果中清理后的偏好设置条目数量
    cleanedPrefCount: result.profile.preferences.length,
    // AI返回结果中清理后的行为模式条目数量
    cleanedPatCount: result.profile.patterns.length,
    // AI返回结果中清理后的工作流条目数量
    cleanedWfCount: result.profile.workflows.length,
    // 第一个样本条目的唯一标识ID，用于快速定位样本数据
    sampleId: sampleCleaned?.id,
    // 样本条目的描述文本长度，用于验证AI生成内容的完整性
    sampleDescLen: sampleCleaned?.description?.length,
    // 清理后pref_0条目的描述文本长度，用于对比AI修改前后的文本变化
    cleanedItemDescLen: cleanedById.get("pref_0")?.description?.length,
    // 原始pref_0条目的描述文本长度，作为AI修改前的基准参考值
    originalItemDescLen: originalById.get("pref_0")?.description?.length,
    // 最终保留的偏好设置条目总数，反映清理后的实际数据规模
    keptById: cleaned.preferences.length,
    // 成功使用AI生成内容的条目数量，统计AI输出的有效利用率
    usedCleaned: counters.cleaned,
    // 直接沿用原始数据的条目数量，反映未被AI修改的原始条目占比
    usedOriginal: counters.original,
  });

  // 记录AI驱动的用户资料全流程清理任务最终完成状态
  // 输出核心性能指标与清理操作的统计结果
  log("AI cleanup: complete", {
    // 从流程启动到完成的总耗时，单位毫秒，用于评估整体处理效率
    totalMs: Date.now() - t0,
    // 清理过程中直接保留未做修改的条目总数
    kept: diff.kept.length,
    // 成功合并的重复条目组总数，每组对应至少两个原始条目的整合
    merged: diff.merged.length,
    // 被判定为无效/冗余并移除的条目总数
    removed: diff.removed.length,
  });

  // 向调用方返回最终的清理结果与变更追踪日志
  // cleaned: 经过AI去重、合并、清理后的完整用户资料数据
  // diff: 记录所有条目处理状态的差异报告，包含保留、合并、移除的全量明细
  return { cleaned, diff };
}

// 导出基于已索引化资料的AI清理入口函数，接收预处理后的带ID资料，返回标准化清理结果
export async function aiCleanupProfileFromIndexed(
  indexed: IndexedProfile
): Promise<AICleanupResult> {
  // 记录流程启动时间戳，用于全流程耗时统计与性能瓶颈分析
  const t0 = Date.now();
  // 基于过滤后的索引化资料构建符合大模型输入规范的清理提示词
  const prompt = buildAICleanupPrompt(indexed);

  // 打印过滤场景下的提示词构建完成日志，输出核心规模指标与阶段耗时
  log("AI cleanup: prompt built (filtered)", {
    // 本次参与清理的用户偏好设置条目数量，为过滤后的有效规模
    prefCount: indexed.preferences.length,
    // 本次参与清理的行为模式条目数量，为过滤后的有效规模
    patCount: indexed.patterns.length,
    // 本次参与清理的工作流条目数量，为过滤后的有效规模
    wfCount: indexed.workflows.length,
    // 生成的提示词总字符长度，用于验证是否符合大模型上下文窗口限制
    promptLen: prompt.length,
    // 提示词构建阶段消耗的毫秒数，衡量预处理环节的执行效率
    buildMs: Date.now() - t0,
  });

  // 记录AI调用开始的时间戳，用于统计大模型推理阶段的耗时
  const aiStart = Date.now();
  // 调用核心AI清理函数，传入预处理完成的提示词，等待大模型返回结构化处理结果
  const result = await callAICleanup(prompt);
  // 打印过滤场景下的AI响应接收日志，记录本次大模型调用的耗时，用于性能监控
  log("AI cleanup: AI response received (filtered)", { callMs: Date.now() - aiStart });

  // 以清理后条目的ID为键构建索引映射，实现条目的快速查询定位
  const cleanedById = buildItemIndex(result.profile);
  // 以原始条目的ID为键构建索引映射，用于后续数据比对与元信息继承
  const originalById = buildItemIndex(indexed);
  // 初始化条目来源计数器，分别统计AI生成内容的使用量与原始数据的沿用数量
  const counters = { cleaned: 0, original: 0 };

  // 基于AI返回的映射关系重构用户资料，合并原始元信息与AI生成的清理后内容
  const cleaned = rebuildProfileUsing(result.mapping, cleanedById, originalById, counters);
  // 生成完整的清理差异记录，追踪过滤场景下所有条目的处理状态与流转明细
  const diff = generateDiff(indexed, result.mapping);

  // 记录过滤场景下AI清理全流程完成日志，输出核心统计指标用于性能分析与问题排查
  log("AI cleanup: complete (filtered)", {
    // 从流程启动到完成的总耗时，单位毫秒，用于评估整体处理效率
    totalMs: Date.now() - t0,
    // 清理过程中直接保留未做修改的条目总数
    kept: diff.kept.length,
    // 成功合并的重复条目组总数，每组对应至少两个原始条目的整合
    merged: diff.merged.length,
    // 被判定为无效/冗余并移除的条目总数
    removed: diff.removed.length,
  });

  // 向调用方返回过滤场景下的最终清理结果与变更追踪日志
  return { cleaned, diff };
}

/**
 * 为AI清理流程过滤用户资料条目，仅保留指定ID集合内的有效条目
 * 此函数实现了增量清理能力，支持仅对部分条目重新执行AI合并去重
 * 避免全量处理带来的资源浪费，提升高频更新场景下的处理效率
 * @param profileData - 原始的未索引化用户资料完整数据
 * @param includeIds - 需要保留参与清理的条目ID白名单列表
 * @returns 经过过滤并保留原始索引结构的带ID资料子集，符合AI清理输入规范
 */
export function filterProfileForCleanup(
  profileData: UserProfileData,
  includeIds: string[]
): IndexedProfile {
  // 将需要保留的ID数组转换为Set哈希结构，将查找复杂度从O(n)降至O(1)
  // 大幅提升大条目数量场景下的过滤性能，避免嵌套循环的性能损耗
  const idSet = new Set(includeIds);
  // 为原始用户资料的所有条目分配唯一前缀ID，构建标准索引化资料结构
  // 复用统一的ID生成逻辑，确保与全量清理流程的ID命名规则完全一致
  const indexed = addIdsToProfile(profileData);
  // 返回经过过滤的索引化资料，三个类别分别执行白名单过滤
  // 严格保留原资料的分类结构，确保AI清理函数能正确识别各类型条目
  return {
    // 过滤偏好设置条目，仅保留ID在白名单内的有效条目
    preferences: indexed.preferences.filter((p) => idSet.has(p.id)),
    // 过滤行为模式条目，仅保留ID在白名单内的有效条目
    patterns: indexed.patterns.filter((p) => idSet.has(p.id)),
    // 过滤工作流条目，仅保留ID在白名单内的有效条目
    workflows: indexed.workflows.filter((p) => idSet.has(p.id)),
  };
}

/**
 * 索引化资料条目的标准接口定义，为所有用户资料条目统一结构规范
 * 作为所有分类（偏好/模式/工作流）条目的基础类型，保障数据结构一致性
 * 支持扩展任意自定义元数据字段，满足不同业务场景的属性扩展需求
 */
interface IndexedProfileItem {
  // 条目全局唯一标识ID，格式为类别前缀+序号（如pref_0、pat_5）
  // 贯穿全流程的唯一主键，用于追踪条目的创建、合并、删除全生命周期
  id: string;
  // 条目所属的业务分类标签，可选字段，用于更细粒度的条目分组
  // 支持同类别下的二次分类，帮助AI更精准地执行语义合并判断
  category?: string;
  // 条目的核心文本描述，记录条目的具体业务内容，是AI语义分析的核心依据
  // 所有AI合并、去重、清理操作都基于该字段的语义内容进行判断
  description: string;
  // 条目的置信度评分，可选字段，取值范围0-1，标识该条目的可信度
  // 通常由上游采集流程生成，值越高代表条目来源越可靠，AI清理时会优先保留高置信度条目
  confidence?: number;
  // 条目的出现频率统计，可选字段，记录该条目在用户行为中被触发的次数
  // 合并条目时会累加该字段的值，作为条目重要性的核心量化指标
  frequency?: number;
  // 支持任意扩展的自定义元数据字段，满足业务迭代中的属性扩展需求
  // 所有未在接口中显式声明的属性都可以通过该索引签名存储，保证兼容性
  [key: string]: unknown;
}

// 索引化用户资料的顶层结构接口，统一组织三大类用户行为数据
// 保持与原始资料的数据分类一致，为全流程AI处理提供标准化数据骨架
interface IndexedProfile {
  // 用户偏好设置条目数组，存储用户明确表达的喜好、倾向等主观偏好数据
  preferences: IndexedProfileItem[];
  // 用户行为模式条目数组，存储用户在使用过程中形成的稳定操作习惯、行为规律
  patterns: IndexedProfileItem[];
  // 用户工作流条目数组，存储用户完成特定任务的完整步骤序列、流程编排
  workflows: IndexedProfileItem[];
}

// AI处理结果的条目映射接口，精准记录原始条目在清理流程中的最终流向
// 作为核心追踪载体，支撑所有变更溯源、差异分析与数据回流的全链路可观测性
interface AIMapping {
  // 直接保留的原始条目ID列表，这些条目未经过合并或修改，完全保留原始状态
  kept: string[];
  // 合并操作的分组ID数组，每个子数组代表一组被合并的原始条目，首个ID为合并后的宿主条目ID
  merged: string[][];
  // 被移除的无效条目ID列表，这些条目因冗余、无价值或重复被AI判定为需要清理
  removed: string[];
}

// 为原始用户资料的所有条目分配全局唯一ID，完成数据的索引化预处理
// 这是全流程AI清理的首个核心步骤，为每个条目赋予贯穿生命周期的唯一标识
function addIdsToProfile(profile: UserProfileData): IndexedProfile {
  // 遍历三大类原始数据，为每个条目生成带类型前缀的唯一ID，实现条目全局可追踪
  const items = {
    // 处理偏好设置条目，生成pref_前缀的ID（如pref_0、pref_1），与条目类型严格绑定
    preferences: profile.preferences.map((p, i) => ({ ...p, id: `pref_${i}` })),
    // 处理行为模式条目，生成pat_前缀的ID（如pat_0、pat_1），通过前缀快速区分条目类型
    patterns: profile.patterns.map((p, i) => ({ ...p, id: `pat_${i}` })),
    // 处理工作流条目，生成wf_前缀的ID（如wf_0、wf_1），前缀规则统一确保后续处理的一致性
    workflows: profile.workflows.map((w, i) => ({ ...w, id: `wf_${i}` })),
  };
  // 返回完成索引化的用户资料对象，所有条目已携带唯一标识，可进入后续AI处理流程
  return items;
}

function buildAICleanupPrompt(profile: IndexedProfile): string {
  // 将索引化的用户资料序列化为格式化JSON，作为大模型的输入数据载体
  const profileJSON = JSON.stringify(
    {
      // 对所有偏好设置条目执行标准化格式化，仅保留AI处理所需的核心字段
      preferences: profile.preferences.map(formatForAI),
      // 对所有行为模式条目执行标准化格式化，过滤掉AI分析不需要的冗余元数据
      patterns: profile.patterns.map(formatForAI),
      // 对所有工作流条目执行标准化格式化，确保输入结构与大模型预期完全对齐
      workflows: profile.workflows.map(formatForAI),
    },
    null,
    // 使用2个空格缩进格式化JSON输出，提升提示词可读性便于调试排查问题
    2
  );

  return `You are a user profile analyst. The profile below contains duplicate entries within each category (preferences, patterns, workflows). Output a cleaned profile.

Rules:
1. Merge semantically identical entries ONLY within the same section (pref_ with pref_, pat_ with pat_, wf_ with wf_)
2. Do NOT merge across sections — preferences and patterns are different things
3. When merging, keep the most specific description. Do not artificially shorten or inflate — the natural length of the original is fine.
4. Do not add new entries; only merge and remove
5. Prefer merging over removing. If entries share the same topic or describe similar behavior, merge them. Only remove truly irrelevant/generic items that add no value (e.g. "uses tools", "checks things").
6. You MUST return a mapping showing the disposition of each id

Current profile:
${profileJSON}

Return JSON only (no markdown):
{
  "preferences": [
    { "id": "pref_0", "category": "...", "description": "..." }
  ],
  "patterns": [...],
  "workflows": [...],
  "mapping": {
    "kept": ["pref_0", "pat_1"],
    "merged": [["pref_2", "pref_5"], ["pat_3", "pat_8"]],
    "removed": ["pref_4"]
  }
}

The first id in each merged group is the kept entry; the rest are merged into it.`;
}

// 格式化条目以适配AI输入需求，仅提取AI分析所需的核心字段
// 过滤掉所有非必要的元数据，避免冗余信息干扰大模型的语义判断
// 保持输入结构的精简性，严格遵循提示词工程中"最小必要输入"的设计原则
function formatForAI(item: IndexedProfileItem): Record<string, unknown> {
  // 从原始条目中解构提取四个核心字段，这些是AI执行合并去重所需的全部信息
  // id用于追踪条目的流转轨迹，category辅助分类判断，description是语义分析的核心，frequency为重要性权重
  const { id, category, description, frequency } = item;
  // 返回仅包含核心字段的纯对象，严格对齐大模型提示词中定义的输入结构规范
  // 确保AI接收到的数据格式与预期完全一致，避免因结构不匹配导致的处理错误
  return { id, category, description, frequency };
}

async function callAICleanup(
  prompt: string
): Promise<{ profile: IndexedProfile; mapping: AIMapping }> {
  // Use opencode internal session when opencodeProvider is configured (same pattern as auto-capture)
  // 当系统配置了opencode服务商和模型时，优先尝试使用内置的opencode会话能力调用AI
  if (CONFIG.opencodeProvider && CONFIG.opencodeModel) {
    // 包裹核心调用逻辑在try-catch块中，捕获任何调用阶段的异常，保障降级逻辑生效
    try {
      // 动态加载opencode提供商的客户端工厂函数，获取v2版本客户端的创建方法
      const { getV2Client } = await loadOpencodeProvider();
      // 调用工厂方法实例化opencode的v2版本客户端，获取可用的客户端实例
      const v2Client = getV2Client();
      // 校验客户端实例是否成功创建，存在有效实例时才执行后续AI调用流程
      if (v2Client) {
        // 使用实例化的v2客户端发起AI清理请求，传入构建完成的提示词，等待大模型返回结果
        const result = await callViaOpencodeWithClient(v2Client, prompt);
        // 校验AI调用返回的结果是否有效，存在有效结果则直接返回给上层调用者
        if (result) return result;
      }
    } catch (e) {
      // 捕获opencode会话调用过程中抛出的所有异常，记录错误日志并触发降级逻辑
      log("AI cleanup: opencode session failed, falling back to external API", {
        error: String(e),
      });
    }
  }

  // 检查是否配置了外部API所需的模型和地址参数
  // 若两项配置均存在，则调用外部API服务执行AI清理流程
  if (CONFIG.memoryModel && CONFIG.memoryApiUrl) {
    return callViaExternalAPI(prompt);
  }

  // 所有可用的AI服务商均未完成有效配置，无法执行清理任务
  // 抛出明确的错误信息提示用户检查配置项完整性
  throw new Error("No AI provider configured for profile cleanup");
}

// 通过外部API调用AI执行用户资料清理的核心函数
// 接收构建完成的清理提示词，返回标准化的AI处理结果，包含清理后资料与条目映射关系
async function callViaExternalAPI(
  prompt: string
): Promise<{ profile: IndexedProfile; mapping: AIMapping }> {
  // 记录函数调用开始时间戳，用于后续全流程耗时统计与性能监控
  const t0 = Date.now();
  const systemPrompt =
    "You are a user profile cleanup assistant. Merge duplicate entries and return only JSON.";

  const response = await fetch(`${CONFIG.memoryApiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.memoryApiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.memoryModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(60000),
  });

  // 记录外部API调用的HTTP请求完成状态，输出请求耗时与响应状态码，用于监控接口调用性能与可用性
  log("AI cleanup: external API http done", { httpMs: Date.now() - t0, status: response.status });

  // 校验HTTP响应状态是否正常，非2xx状态码视为请求失败
  if (!response.ok) {
    // 抛出包含状态码与状态描述的错误，便于问题定位与排查
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  // 解析响应体为JSON格式，提取大模型返回的原始数据结构
  const data: any = await response.json();
  // 从响应中提取大模型生成的内容文本，按照OpenAI格式规范逐层安全取值
  const content = data.choices?.[0]?.message?.content;
  // 若提取到的内容为空，抛出异常终止流程，避免后续处理空数据
  if (!content) throw new Error("No content in API response");

  // 记录外部API响应解析完成日志，输出总耗时和响应内容长度
  log("AI cleanup: external API parsing done", {
    // 从调用开始到解析完成的总耗时，单位毫秒，用于性能监控
    totalMs: Date.now() - t0,
    // 响应内容的字符长度，评估大模型输出的规模
    respLen: content.length,
  });

  // 解析AI返回的JSON格式响应内容，将字符串转换为结构化的JavaScript对象
  const parsed = JSON.parse(content);
  // 向上层调用方返回标准化的AI处理结果，封装清理后的资料与条目映射关系
  return {
    // 将解析后的根对象强制类型转换为索引化资料结构，对齐内部数据定义规范
    profile: parsed as IndexedProfile,
    // 从解析结果中提取条目映射字段，强制转换为AI映射接口类型，保障流转数据类型一致
    mapping: parsed.mapping as AIMapping,
  };
}

// 通过Opencode客户端执行AI清理任务的核心函数
// 接收Opencode的v2客户端实例和构建好的清理提示词
// 返回标准化的AI处理结果，包含清理后的索引化资料和条目流向映射关系
async function callViaOpencodeWithClient(
  v2Client: any,
  prompt: string
): Promise<{ profile: IndexedProfile; mapping: AIMapping }> {
  // 记录函数调用开始的时间戳，用于全流程耗时统计与性能监控
  const t0 = Date.now();
  const systemPrompt =
    "You are a user profile cleanup assistant. Merge duplicate entries and return only JSON without markdown wrapping.";

  // 使用Promise.race实现会话创建与超时控制的竞争逻辑
  // 若30秒内会话创建未完成，将主动抛出超时异常终止等待
  const created = (await Promise.race([
    // 调用Opencode客户端的会话创建接口，初始化独立的AI交互会话
    v2Client.session.create({
      // 设置会话名称，用于在平台后台标识该会话的业务用途为用户资料清理
      title: "opencode-mem profile cleanup",
      // 指定会话的工作目录为当前进程的工作目录，确保路径权限合规
      directory: process.cwd(),
    }),
    // 独立的超时Promise，30000毫秒（30秒）后触发拒绝逻辑
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("session.create timeout")), 30000)
    ),
  ])) as any;
  // 输出会话创建接口返回的原始结构调试日志，排查不同客户端版本的返回格式差异
  // rawType：记录返回值的基础类型，确认是否为预期的对象类型
  // keys：打印返回对象的所有键名，直观展示接口返回的结构组成
  // hasData：校验返回对象是否包含标准的data字段，适配统一的响应格式
  // dataId：提取data字段内的会话ID，验证核心标识字段是否正常生成
  log("AI cleanup: session.create result", {
    rawType: typeof created,
    keys: Object.keys(created || {}),
    hasData: !!created?.data,
    dataId: created?.data?.id,
  });

  // 从会话创建结果中多兼容方式提取会话唯一标识
  // 适配不同客户端版本返回的结构差异：优先取data.id，其次根节点id，最后sessionID字段
  const sessionID = created?.data?.id || created?.id || created?.sessionID;
  // 会话ID提取失败时抛出明确错误，终止后续流程避免无效执行
  if (!sessionID) throw new Error("session.create returned no session id");

  // 记录会话创建成功的关键日志，输出会话ID和创建耗时，用于性能监控和链路追踪
  log("AI cleanup: session created", { sessionID, createMs: Date.now() - t0 });

  try {
    // 定义opencode客户端prompt请求的最大超时时间，单位毫秒（120秒）
    // 超长等待会阻塞后续流程，设置合理阈值保障系统整体可用性
    const TIMEOUT_MS = 120000;
    // 使用Promise.race实现核心请求与超时计时器的竞争，哪个先完成就采用哪个的结果
    // 既保证正常请求能顺利返回，又能强制终止超时的无效等待
    const promptResult = await Promise.race([
      // 调用opencode客户端的session.prompt方法，向大模型发起推理请求
      v2Client.session.prompt({
        // 传入之前创建的会话唯一标识，绑定本次请求到已初始化的会话上下文
        sessionID,
        // 配置大模型调用的核心参数，指定服务商与具体模型版本
        model: {
          // 优先使用全局配置中的opencode服务商ID，若未配置则降级到默认的bs-aigw服务商
          providerID: CONFIG.opencodeProvider || "bs-aigw",
          // 优先使用全局配置中的opencode模型名称，若未配置则降级到默认的deepseek-v4-flash模型
          modelID: CONFIG.opencodeModel || "deepseek-v4-flash",
        },
        // 传入系统提示词，定义大模型的角色定位与输出规范
        system: systemPrompt,
        // 构造请求的消息体部分，以纯文本格式传入用户侧的核心任务提示词
        parts: [{ type: "text", text: prompt }],
        // 配置noReply参数为true，关闭客户端额外的交互确认流程，直接获取大模型的原始输出
        noReply: true,
      }),
      // 超时控制的兜底Promise，若核心请求在TIMEOUT_MS内未完成，则主动抛出超时异常终止等待
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`opencodeClient prompt timeout after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS
        )
      ),
    ]);

    // 记录prompt请求成功完成的日志，输出从函数启动到本次响应的总耗时，用于性能监控与链路追踪
    log("AI cleanup: session.prompt done", { promptMs: Date.now() - t0 });

    // 对opencode客户端返回的结果执行类型断言，安全提取嵌套层级中的核心info字段
    // 该字段包含大模型生成的文本内容或错误信息，是后续处理的核心数据源
    const info = (
      promptResult as {
        data?: { info?: { text?: string; error?: { name: string; data?: { message?: string } } } };
      }
    ).data?.info;

    // 校验返回结果中是否包含核心info字段，缺失则抛出异常终止流程
    if (!info) throw new Error("prompt response missing info");
    // 检测是否存在服务端返回的错误信息，若存在则拼接错误名称与详情抛出
    if (info.error)
      throw new Error(`opencode reported ${info.error.name}: ${info.error.data?.message ?? ""}`);

    // 提取大模型返回的原始文本内容，去除首尾空白字符，空值时默认赋值为空字符串
    const rawText = info.text?.trim() || "";
    // 使用正则表达式匹配从第一个{到最后一个}的所有内容，提取完整JSON结构
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    // 正则匹配失败说明返回内容不包含合法JSON结构，抛出格式错误异常
    if (!jsonMatch) throw new Error("AI response did not contain valid JSON");

    // 解析匹配到的JSON字符串，转换为结构化的JavaScript对象
    const parsed = JSON.parse(jsonMatch[0]);
    // 将解析后的对象封装为标准返回格式，强制类型转换对齐内部接口定义
    return {
      profile: parsed as IndexedProfile,
      mapping: parsed.mapping as AIMapping,
    };
    // 无论任务成功还是失败，都会进入此finally块执行资源清理
  } finally {
    // 捕获会话删除过程中可能出现的任何异常，避免清理失败影响主流程结果返回
    try {
      // 调用Opencode客户端的会话删除接口，主动释放本次AI交互创建的临时会话资源
      await v2Client.session.delete({ sessionID });
    } catch {} // 静默捕获所有删除异常，无需抛出，保障主流程能正常返回清理结果
  }
}

// 构建条目索引映射函数：将带唯一ID的用户资料条目转为以ID为键的Map，支持O(1)时间复杂度的快速查询
function buildItemIndex(profile: IndexedProfile): Map<string, IndexedProfileItem> {
  // 初始化空Map实例，用于存储条目ID与条目实体的键值对映射
  const map = new Map<string, IndexedProfileItem>();
  // 遍历所有用户偏好设置条目，将每个条目以其唯一ID为键存入Map
  for (const item of profile.preferences) map.set(item.id, item);
  // 遍历所有用户行为模式条目，将每个条目以其唯一ID为键存入Map
  for (const item of profile.patterns) map.set(item.id, item);
  // 遍历所有用户工作流条目，将每个条目以其唯一ID为键存入Map
  for (const item of profile.workflows) map.set(item.id, item);
  // 返回构建完成的条目索引Map，供后续流程快速查询条目实体
  return map;
}

/**
 * 基于AI生成的映射关系重构完整用户资料，合并AI处理后的内容与原始元数据
 * 核心职责是将AI的清理结果转化为符合业务规范的最终用户资料，同时保留所有原始埋点数据
 * @param mapping - AI返回的条目处理映射，记录每个原始ID的最终流向（保留/合并/移除）
 * @param cleanedById - AI清理后的条目索引映射，以条目ID为键快速查询清理后的条目实体
 * @param originalById - 原始输入条目的索引映射，以条目ID为键快速查询原始条目完整数据
 * @param counters - 可选的条目来源计数器，用于统计AI生成内容的使用量和原始数据的沿用数量
 * @returns 重构完成的标准用户资料数据，符合上游业务的格式要求
 */
function rebuildProfileUsing(
  mapping: AIMapping,
  cleanedById: Map<string, IndexedProfileItem>,
  originalById: Map<string, IndexedProfileItem>,
  counters?: { cleaned: number; original: number }
): UserProfileData {
  // 收集所有最终需要保留的条目ID，包括直接保留的条目，以及每组合并条目的宿主条目（每组第一个ID）
  // 过滤掉所有空字符串，确保集合中只存在合法有效的条目ID
  const keptIds = new Set<string>(
    [...mapping.kept, ...mapping.merged.map((g) => g[0] ?? "")].filter(Boolean)
  );

  // 过滤出所有有效合并组，仅保留包含至少两个条目的组（单个条目的合并组无实际业务意义）
  const mergedGroups = mapping.merged.filter((g) => g.length > 1);
  // 初始化所有被合并的源条目ID集合，存储所有作为合并来源的原始条目ID（即每组除宿主外的所有ID）
  const mergedSourceIds = new Set<string>();
  // 遍历所有有效合并组，收集组内除首个宿主ID外的所有源条目ID，存入合并源ID集合
  for (const group of mergedGroups) {
    for (let i = 1; i < group.length; i++) {
      mergedSourceIds.add(group[i] ?? "");
    }
  }

  // 初始化重构结果的基础结构，严格遵循UserProfileData的标准格式，包含三大核心类别
  const result: UserProfileData = { preferences: [], patterns: [], workflows: [] };

  // 遍历所有最终需要保留的条目ID集合，逐一处理每个需要保留的条目
  for (const id of keptIds) {
    // 从AI清理后的条目索引中，根据当前ID获取对应的清理后条目实体
    const cleanedItem = cleanedById.get(id);
    // 从原始输入条目索引中，根据当前ID获取对应的原始条目完整数据
    const originalItem = originalById.get(id);
    // 优先使用AI生成的清理后条目，若不存在则回退使用原始条目，保障数据可用性
    const item = cleanedItem || originalItem;
    // 若获取到的条目实体为空，直接跳过当前循环，避免处理无效数据
    if (!item) continue;

    // 若传入了条目来源计数器，统计当前条目是使用AI生成内容还是原始数据
    if (counters) {
      // 清理后的条目索引中存在当前ID，说明AI生成内容被使用，AI生成条目计数+1
      if (cleanedById.has(id)) counters.cleaned++;
      // 否则使用的是原始条目数据，原始沿用条目计数+1
      else counters.original++;
    }

    // 基于当前条目创建浅拷贝的结果条目，避免修改原始索引中的条目数据
    const resultItem = { ...item };
    // 删除结果条目中的临时ID字段，该字段仅在AI清理流程内部使用，不需要输出给上游业务
    delete (resultItem as any).id;

    if (originalItem) {
      // 定义需要从原始条目中继承的元数据字段列表，这些字段不参与AI语义分析但为业务核心埋点
      const preserveKeys = [
        // 聚类质心坐标，用于向量空间中条目的位置定位，支撑后续相似性匹配计算
        "centroid",
        // 锚点标识，标记该条目为核心可靠条目，作为相似性匹配的基准参考
        "anchor",
        // 弱匹配命中次数，统计该条目被识别为潜在匹配但未达置信阈值的次数
        "weakHitCount",
        // 最后一次弱匹配发生的时间戳，用于追踪条目活跃度与老化状态
        "lastWeakHitAt",
        // 置信度漂移低于阈值的次数，统计该条目因数据老化触发的漂移告警次数
        "driftBelowCount",
        // 条目触发频率，记录该用户行为/偏好被观测到的总次数，是条目重要性的核心指标
        "frequency",
        // 支撑该条目的所有证据源列表，存储所有触发该条目生成的原始行为记录ID
        "evidence",
        // 工作流步骤列表，仅用于工作流类型条目，存储任务执行的完整步骤序列
        "steps",
        // 条目置信度评分，0-1区间取值，标识该条目的可信度与数据质量
        "confidence",
        // 贝叶斯模型的正样本计数，用于统计该条目被确认为有效匹配的次数
        "alpha",
        // 贝叶斯模型的负样本计数，用于统计该条目被识别为无效匹配的次数
        "beta",
        // 弱匹配场景下的贝叶斯正样本计数，统计弱匹配场景下的有效观测次数
        "weakAlpha",
        // 弱匹配场景下的贝叶斯负样本计数，统计弱匹配场景下的无效观测次数
        "weakBeta",
        // 最后一次成功匹配的时间戳，用于追踪条目最新的活跃状态
        "lastMatchTime",
        // 条目首次被观测到的时间戳，记录该用户行为/偏好的生成时间
        "firstSeen",
        // 待验证标记，标识该条目尚未达到置信阈值，仍需更多行为数据确认
        "pendingValidation",
      ];
      // 遍历所有需要保留的元数据字段，执行原始值的继承逻辑
      for (const key of preserveKeys) {
        // 仅当原始条目存在该字段值，且AI生成的结果条目中未定义该字段时执行继承
        // 避免覆盖AI可能主动更新的字段，仅补全AI未处理的底层元数据
        if ((originalItem as any)[key] !== undefined && (resultItem as any)[key] === undefined) {
          (resultItem as any)[key] = (originalItem as any)[key];
        }
      }

      // 当AI生成了新的描述文本且与原始描述存在差异时
      // 清除原有的聚类质心和锚点标记，需要重新计算向量表征
      if (cleanedItem && cleanedItem.description !== originalItem.description) {
        (resultItem as any).centroid = undefined;
        (resultItem as any).anchor = undefined;
      }
    }

    // 检查当前条目是否为某组合并操作的宿主条目（每组合并的首个ID）
    if (mergedGroups.some((g) => g[0] === id)) {
      // 从合并组列表中定位当前条目所属的具体合并分组，非空断言确保宿主条目一定存在对应分组
      const group = mergedGroups.find((g) => g[0] === id)!;
      // 初始化最高频率变量，以宿主条目的原始频率为起始基准值
      let bestFreq = (originalItem as any).frequency || 0;
      // 初始化最优聚类质心坐标，优先沿用宿主条目的原始质心数据
      let bestCentroid = (originalItem as any).centroid;
      // 初始化最优锚点标识，优先保留宿主条目的原始锚点属性
      let bestAnchor = (originalItem as any).anchor;
      // 遍历合并组中除宿主外的所有源条目，从下标1开始跳过宿主条目本身
      for (let i = 1; i < group.length; i++) {
        // 根据当前源条目的ID，从原始条目索引中获取完整的原始数据实体
        const srcOriginal = originalById.get(group[i] ?? "");
        // 仅处理成功获取到原始数据的有效源条目，跳过不存在的无效ID
        if (srcOriginal) {
          // 提取当前源条目的频率值，无有效频率时默认补0避免计算异常
          const srcFreq = (srcOriginal as any).frequency || 0;
          // 如果当前源条目的频率高于已记录的最高频率，更新最优属性集合
          if (srcFreq > bestFreq) {
            bestFreq = srcFreq;
            bestCentroid = (srcOriginal as any).centroid;
            bestAnchor = (srcOriginal as any).anchor;
          }
          // 当当前源条目存在证据源列表时，执行证据源的合并去重逻辑
          if ((srcOriginal as any).evidence) {
            // 获取宿主结果条目当前已有的证据源列表，无数据时初始化为空数组
            const existingEvidence = (resultItem as any).evidence || [];
            // 合并两个来源的证据源，通过Set自动去重后截断保留最多10条，避免列表过长
            const merged = [
              ...new Set([...(srcOriginal as any).evidence, ...existingEvidence]),
            ].slice(0, 10);
            // 将合并后的证据源列表写回结果条目，完成证据链的整合
            (resultItem as any).evidence = merged;
          }
        }
      }
      // Take sum frequency — accumulating confirmed merges
      // 初始化总频率累加器，以当前保留条目的原始频率作为起始值，若原始值为空则默认取0
      let totalFreq = (originalItem as any).frequency || 0;
      // 遍历合并分组中除宿主条目外的所有源条目（从下标1开始跳过保留的宿主条目）
      for (let i = 1; i < group.length; i++) {
        // 根据当前源条目的ID从原始条目索引中获取对应的完整原始数据实体
        const srcOriginal = originalById.get(group[i] ?? "");
        // 仅处理能成功获取到原始数据的有效条目，跳过不存在的无效ID
        if (srcOriginal) {
          // 将当前源条目的频率值累加到总频率中，源条目无有效频率时默认补0避免计算异常
          totalFreq += (srcOriginal as any).frequency || 0;
        }
      }
      // 将合并累加后的总频率赋值给结果条目，统一合并所有被合并条目的访问次数
      (resultItem as any).frequency = totalFreq;
      // 合并所有被合并条目的贝叶斯统计量alpha与beta，更新宿主条目的置信度模型参数
      // Accumulate alpha/beta from merged items
      // 提取宿主条目的原始alpha值，若未定义则使用默认值1（贝叶斯先验默认值）
      const keeperAlpha = (originalItem as any).alpha || 1;
      // 提取宿主条目的原始beta值，若未定义则使用默认值1（贝叶斯先验默认值）
      const keeperBeta = (originalItem as any).beta || 1;
      // 初始化合并后的alpha值，以宿主条目原始值为起始基准
      let mergedAlpha = keeperAlpha;
      // 初始化合并后的beta值，以宿主条目原始值为起始基准
      let mergedBeta = keeperBeta;
      // 遍历分组中除宿主外的所有源条目，累加所有条目的alpha和beta值
      for (let i = 1; i < group.length; i++) {
        // 根据当前源条目ID从原始索引中获取对应的完整原始数据实体
        const srcOriginal = originalById.get(group[i] ?? "");
        // 仅处理成功获取到原始数据的有效源条目，跳过不存在的无效ID
        if (srcOriginal) {
          // 将当前源条目的alpha值累加到合并后的alpha总和中，无有效值时默认取1
          mergedAlpha += (srcOriginal as any).alpha || 1;
          // 将当前源条目的beta值累加到合并后的beta总和中，无有效值时默认取1
          mergedBeta += (srcOriginal as any).beta || 1;
        }
      }
      // 将累加后的合并贝叶斯正样本计数赋值给结果条目，完成置信度模型参数更新
      (resultItem as any).alpha = mergedAlpha;
      // 将累加后的合并贝叶斯负样本计数赋值给结果条目，与alpha共同维护贝叶斯先验分布
      (resultItem as any).beta = mergedBeta;
      // 取所有参与合并条目的最新成功匹配时间戳，保证条目活跃时间的准确性
      (resultItem as any).lastMatchTime = Math.max(
        // 宿主条目原始的最后匹配时间，无有效值时默认取0作为比较基准
        (originalItem as any).lastMatchTime || 0,
        // 遍历所有合并源条目，提取各自的最后匹配时间，统一参与最大值计算
        ...group.slice(1).map((id) => (originalById.get(id ?? "") as any)?.lastMatchTime || 0)
      );
      // 取所有参与合并条目的最新观测时间，确保条目的最后活跃时间能反映所有源条目的最新状态
      (resultItem as any).lastSeen = Math.max(
        // 宿主条目原始的最后观测时间，无有效值时默认取0作为比较基准
        (originalItem as any).lastSeen || 0,
        // 遍历所有合并源条目，提取各自的最后观测时间，统一参与最大值计算
        ...group.slice(1).map((id) => (originalById.get(id ?? "") as any)?.lastSeen || 0)
      );
      // 合并后的条目仅当所有参与合并的原始条目均保持待验证状态时，才继续标记为待验证
      // 若任一源条目已完成验证，则合并后的条目自动解除待验证状态
      (resultItem as any).pendingValidation =
        !!(originalItem as any).pendingValidation &&
        group.slice(1).every((id) => !!(originalById.get(id ?? "") as any)?.pendingValidation);
      // 初始化弱匹配场景下的贝叶斯正样本计数，以宿主条目原始值为基准，无值时使用默认先验1
      let mergedWeakAlpha = (originalItem as any).weakAlpha || 1;
      // 初始化弱匹配场景下的贝叶斯负样本计数，以宿主条目原始值为基准，无值时使用默认先验1
      let mergedWeakBeta = (originalItem as any).weakBeta || 1;
      // 遍历所有合并源条目，累加弱匹配场景下的贝叶斯统计量
      for (let i = 1; i < group.length; i++) {
        // 根据当前源条目ID从原始索引中获取完整的原始数据实体
        const srcOriginal = originalById.get(group[i] ?? "");
        // 仅处理成功获取到原始数据的有效源条目，跳过不存在的无效ID
        if (srcOriginal) {
          // 累加减去默认先验1后的源条目弱匹配正样本计数，避免重复累加基准先验
          mergedWeakAlpha += ((srcOriginal as any).weakAlpha || 1) - 1;
          // 累加减去默认先验1后的源条目弱匹配负样本计数，避免重复累加基准先验
          mergedWeakBeta += ((srcOriginal as any).weakBeta || 1) - 1;
        }
      }
      // 将累加完成的弱匹配正样本计数赋值给结果条目，完成弱匹配置信度模型参数更新
      (resultItem as any).weakAlpha = mergedWeakAlpha;
      // 将累加完成的弱匹配负样本计数赋值给结果条目，与weakAlpha共同维护弱匹配场景的贝叶斯先验分布
      (resultItem as any).weakBeta = mergedWeakBeta;
      // 若存在从合并源条目中筛选出的最优聚类质心，则将其赋值给结果条目
      if (bestCentroid) (resultItem as any).centroid = bestCentroid;
      // 若存在从合并源条目中筛选出的最优锚点标识，则将其赋值给结果条目
      if (bestAnchor) (resultItem as any).anchor = bestAnchor;
    }

    // 根据条目ID的前缀分类，将处理完成的结果条目写入对应业务数组
    // 前缀为pref_的偏好设置条目，存入用户偏好数组
    if (id.startsWith("pref_")) result.preferences.push(resultItem as any);
    // 前缀为pat_的行为模式条目，存入用户行为模式数组
    else if (id.startsWith("pat_")) result.patterns.push(resultItem as any);
    // 前缀为wf_的工作流条目，存入用户工作流数组
    else if (id.startsWith("wf_")) result.workflows.push(resultItem as any);
  }

  // 初始化集合存储所有原始条目的ID，用于后续校验AI处理的完整性
  const allOriginalIds = new Set<string>();
  // 遍历原始条目索引中的所有条目实体，收集全部有效ID
  for (const item of originalById.values()) {
    // 仅将存在有效ID的条目存入集合，过滤无效空值保障数据合法性
    if (item.id) allOriginalIds.add(item.id);
  }
  // 初始化集合存储所有未被AI映射提及的条目ID，用于兜底保留遗漏数据
  const unmentionedIds = new Set<string>();
  // 遍历所有原始条目ID，筛选出既未被保留也未被移除的遗漏条目
  for (const id of allOriginalIds) {
    // 若当前ID不在保留集合中，也不在移除列表内，则标记为未提及的遗漏条目
    if (!keptIds.has(id) && !mapping.removed.includes(id)) {
      unmentionedIds.add(id);
    }
  }
  // 遍历所有未被AI映射提及的遗漏条目ID集合，确保无任何原始数据在清理流程中丢失
  for (const id of unmentionedIds) {
    // 从原始条目索引中根据当前ID查询对应的完整原始数据实体
    const originalItem = originalById.get(id);
    // 若原始条目不存在则直接跳过当前循环，避免处理无效的空数据
    if (!originalItem) continue;
    // 基于原始条目创建浅拷贝的结果条目，隔离修改操作避免污染原始索引数据
    const resultItem = { ...originalItem };
    // 删除结果条目中的临时ID字段，该字段仅为AI清理流程内部使用，无需输出给上游业务
    delete (resultItem as any).id;
    // 根据ID前缀的业务分类规则，将遗漏条目归入正确的结果数组
    // 前缀为pref_的偏好设置条目，存入用户偏好数组
    if (id.startsWith("pref_")) {
      result.preferences.push(resultItem as any);
      // 前缀为pat_的行为模式条目，存入用户行为模式数组
    } else if (id.startsWith("pat_")) {
      result.patterns.push(resultItem as any);
      // 前缀为wf_的工作流条目，存入用户工作流数组
    } else if (id.startsWith("wf_")) {
      result.workflows.push(resultItem as any);
      // ID前缀无法匹配标准分类时，若原始条目存在分类字段，仍归入用户偏好数组兜底存储
    } else if (originalItem.category) {
      result.preferences.push(resultItem as any);
      // 所有无法明确分类的兜底条目，统一归入用户偏好数组避免数据丢失
    } else {
      result.preferences.push(resultItem as any);
    }
  }

  // 所有条目处理完成，返回重构完成的标准用户资料数据
  return result;
}

/**
 * 生成AI清理前后的条目变更差异报告，用于可视化展示资料优化的具体变更内容
 * 核心功能是将机器可读的映射关系转换为用户友好的差异描述，支持前端界面的变更审计与展示
 * @param original - AI清理前的原始索引化用户资料，包含所有待处理的条目完整数据
 * @param mapping - AI生成的条目流向映射关系，定义每个原始条目的最终处理状态（保留/合并/移除）
 * @returns 标准化的清理差异对象，包含所有变更的可读描述，直接支持前端界面渲染
 */
function generateDiff(original: IndexedProfile, mapping: AIMapping): CleanupDiff {
  // 构建原始条目的ID索引映射，通过ID快速查询条目实体，提升批量处理的查询效率
  const index = buildItemIndex(original);

  // 初始化差异报告的核心结构，严格对齐CleanupDiff接口定义的格式规范
  const diff: CleanupDiff = {
    // 处理所有被直接保留的条目，将ID转换为人类可读的描述文本，缺失描述时回退显示原始ID
    kept: mapping.kept.map((id) => index.get(id)?.description || id),
    // 处理所有合并分组，为每个合并组生成包含源ID列表和合并后结果描述的结构化对象
    merged: mapping.merged.map((group) => {
      // 提取合并组的宿主条目ID（每组首个ID为最终保留的条目），空值兜底避免undefined传递
      const first = group[0] ?? "";
      return {
        // 保留原始分组的所有ID列表，用于前端展示完整的合并来源链
        ids: group,
        // 生成合并结果的可读描述，优先使用宿主条目的原始描述，缺失时回退显示宿主ID
        result: index.get(first)?.description || first,
      };
    }),
    // 处理所有被移除的条目，为每个移除条目生成包含ID和移除原因的结构化对象
    removed: mapping.removed.map((id) => ({
      // 保留被移除条目的原始ID，用于关联审计日志和支持撤销操作的溯源需求
      id,
      // 根据条目存在状态生成差异化的移除原因：存在的条目标记为AI判定的重复/过时条目
      // 不存在的条目标记为已失效条目，区分主动清理和数据不一致两种场景
      reason: index.get(id)
        ? "AI determined this is a duplicate or stale entry"
        : "Entry no longer exists",
    })),
  };

  // 返回构建完成的差异报告对象，交付上层调用者用于日志记录或前端展示
  return diff;
}
