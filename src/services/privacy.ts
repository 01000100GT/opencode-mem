// 移除字符串中的所有私密内容，将所有<private>标签包裹的内容替换为[REDACTED]
export function stripPrivateContent(content: string): string {
  // 使用正则表达式全局匹配所有<private>标签包裹的任意字符（包含换行），替换为脱敏标记
  return content.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

// 判断内容是否完全由私密内容构成，即脱敏后仅剩脱敏标记或空字符串
export function isFullyPrivate(content: string): boolean {
  // 先调用脱敏函数处理原内容，再去除首尾空白字符
  const stripped = stripPrivateContent(content).trim();
  // 检查处理后的结果是否仅为脱敏标记，或是空字符串，若是则原内容全为私密内容
  return stripped === "[REDACTED]" || stripped === "";
}
