// 判断当前项是否处于冻结状态的导出函数，接收任意类型的条目作为参数
export function isFrozen(item: any): boolean {
  // 当条目的漂移低于次数（若不存在则默认0）大于等于2时，判定为冻结状态
  return (item.driftBelowCount || 0) >= 2;
}

// 导出用于对画像条目进行排序的核心函数，接收待排序条目数组与排序指标参数，返回排序后的新数组
export function sortProfileItems(items: any[], metric: "confidence" | "frequency"): any[] {
  // 创建原数组的浅拷贝并调用原生排序方法，避免修改输入的原数组顺序
  return [...items].sort((a, b) => {
    // 计算条目a的冻结状态权重：冻结条目权重为1，非冻结为0，用于优先级排序
    const aFrozen = isFrozen(a) ? 1 : 0;
    // 计算条目b的冻结状态权重，与a的权重逻辑保持一致
    const bFrozen = isFrozen(b) ? 1 : 0;
    // 若两个条目冻结状态不同，优先将非冻结条目排在前面，非冻结（0）会排在冻结（1）之前
    if (aFrozen !== bFrozen) return aFrozen - bFrozen;
    // 当排序指标为置信度时，先按置信度降序排列
    if (metric === "confidence") {
      // 优先用置信度差值排序，置信度相同时则用访问频率补位排序，缺失值按默认值处理
      return (b.confidence || 0) - (a.confidence || 0) || (b.frequency || 1) - (a.frequency || 1);
    }
    // 当排序指标为频率时，直接按访问频率降序排列，缺失频率的条目按0处理
    return (b.frequency || 0) - (a.frequency || 0);
  });
}
