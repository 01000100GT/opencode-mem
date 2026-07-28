// 计算两个Float32Array向量之间的余弦相似度，衡量向量方向的匹配程度
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // 若两个向量长度不一致，无法计算相似度，直接返回0
  if (a.length !== b.length) return 0;

  // 初始化向量点积，用于后续计算余弦相似度的分子
  let dot = 0;
  // 初始化向量a的模长平方和，用于计算向量a的欧几里得长度
  let magA = 0;
  // 初始化向量b的模长平方和，用于计算向量b的欧几里得长度
  let magB = 0;

  // 遍历向量的每一个维度，累加计算点积和模长平方和
  for (let i = 0; i < a.length; i++) {
    // 读取向量a当前维度的值，若为undefined则补0，避免非法值影响计算
    const av = a[i] ?? 0;
    // 读取向量b当前维度的值，若为undefined则补0，避免非法值影响计算
    const bv = b[i] ?? 0;
    // 累加当前维度的乘积，得到两个向量的总点积
    dot += av * bv;
    // 累加向量a当前维度的平方，计算模长平方和
    magA += av * av;
    // 累加向量b当前维度的平方，计算模长平方和
    magB += bv * bv;
  }

  // 若任意一个向量是零向量，无法计算有效相似度，直接返回0
  if (magA === 0 || magB === 0) return 0;

  // 余弦相似度公式：点积除以两个向量欧几里得长度的乘积，最终返回相似度结果
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// 专门为number[]类型设计的余弦相似度计算函数，主要用于处理JSON存储的质心向量计算
// 除输入类型适配number[]外，核心计算逻辑与上方Float32Array版本的实现完全一致
/**
 * Cosine similarity for number[] (JSON-stored centroids), otherwise
 * identical to the Float32Array version above.
 */
export function cosineSimilarityNumbers(a: number[], b: number[]): number {
  // 若两个输入向量维度不匹配，无法计算余弦相似度，直接返回0值
  if (a.length !== b.length) return 0;

  // 初始化向量点积，作为余弦相似度公式的分子项
  let dot = 0;
  // 初始化向量a的模长平方和，用于后续计算欧几里得范数
  let magA = 0;
  // 初始化向量b的模长平方和，用于后续计算欧几里得范数
  let magB = 0;

  // 遍历向量的每一个维度，累加计算点积与模长平方和
  for (let i = 0; i < a.length; i++) {
    // 读取向量a当前维度的值，若为undefined则补0，避免非法值干扰计算稳定性
    const av = a[i] ?? 0;
    // 读取向量b当前维度的值，若为undefined则补0，避免非法值干扰计算稳定性
    const bv = b[i] ?? 0;
    // 累加当前维度的乘积，更新两个向量的总点积
    dot += av * bv;
    // 累加当前维度的平方，更新向量a的模长平方和
    magA += av * av;
    // 累加当前维度的平方，更新向量b的模长平方和
    magB += bv * bv;
  }

  // 若任意一个向量是零向量（模长平方和为0），无法计算有效相似度，直接返回0
  if (magA === 0 || magB === 0) return 0;
  // 应用余弦相似度公式：点积除以两个向量欧几里得长度的乘积，返回最终相似度结果
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// 对输入的number[]类型向量执行L2归一化处理，将向量缩放为欧几里得长度为1的单位向量
export function l2Normalize(vec: number[]): number[] {
  // 初始化向量的模长平方和，用于后续计算L2范数
  let norm = 0;
  // 遍历向量的每个维度，累加计算模长平方和
  for (let i = 0; i < vec.length; i++) {
    // 读取当前维度的值，undefined则补0，累加平方值计算模长平方和
    norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  }
  // 对模长平方和开平方，得到向量的L2范数（欧几里得长度）
  norm = Math.sqrt(norm);
  // 若原向量是零向量（L2范数为0），直接返回原向量避免除零错误
  if (norm === 0) return vec;
  // 向量的每个元素除以L2范数，得到归一化后的单位向量并返回
  return vec.map((v) => v / norm);
}
