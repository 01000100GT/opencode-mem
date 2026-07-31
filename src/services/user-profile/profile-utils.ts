// 通用安全数组转换函数，接收任意输入并返回类型安全的一维数组
export const safeArray = <T>(arr: any): T[] => {
  // 输入为空值时直接返回空数组，处理null/undefined等空场景
  if (!arr) return [];
  // 初始化结果变量，后续解析逻辑会修改该变量
  let result = arr;
  // 若输入为字符串类型，尝试解析为JSON对象
  if (typeof result === "string") {
    // 首次尝试直接解析原始字符串
    try {
      result = JSON.parse(result);
    } catch {
      // 首次解析失败时，做容错处理：去除首尾空白+删除末尾多余逗号后再次尝试
      try {
        result = JSON.parse(result.trim().replace(/,$/, ""));
      } catch {
        // 容错解析仍失败，返回空数组
        return [];
      }
    }
  }
  // 解析完成后如果不是数组类型，直接返回空数组
  if (!Array.isArray(result)) return [];

  // 初始化用于存储扁平化结果的数组
  const flattened: T[] = [];
  // 递归遍历函数，用于将多维数组展平为一维
  const walk = (item: any) => {
    // 如果当前项仍是数组，递归遍历每个元素
    if (Array.isArray(item)) {
      item.forEach(walk);
    } else if (item) {
      // 非空非数组元素，加入结果数组
      flattened.push(item);
    }
  };
  // 从原始数组开始执行递归展平逻辑
  walk(result);
  // 返回最终展平的类型安全数组
  return flattened;
};

// 通用安全对象转换函数，接收任意输入和备用对象，返回类型安全的标准对象
export const safeObject = <T extends object>(obj: any, fallback: T): T => {
  // 输入为空值时直接返回备用对象，处理null/undefined等空场景
  if (!obj) return fallback;
  // 初始化结果变量，后续解析逻辑会修改该变量
  let result = obj;
  // 若输入为字符串类型，尝试解析为JSON对象
  if (typeof result === "string") {
    try {
      // 尝试解析字符串为JSON对象
      result = JSON.parse(result);
    } catch {
      // 字符串解析失败，直接返回备用对象
      return fallback;
    }
  }
  // 解析完成后验证是否为非数组的标准对象，验证通过则返回转换后的类型安全对象，否则返回备用对象
  return result && typeof result === "object" && !Array.isArray(result) ? (result as T) : fallback;
};
