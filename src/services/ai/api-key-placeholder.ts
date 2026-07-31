// 用于存储所有占位符API密钥的集合，用于快速匹配判断
const PLACEHOLDER_API_KEYS = new Set([
  // OpenAI格式的通用占位符密钥，常见于示例代码中
  "sk-...",
  // Anthropic API密钥格式的占位符，以sk-ant-开头
  "sk-ant-...",
  // Google/Gemini API密钥格式的占位符，以gsk_开头
  "gsk_...",
  // 最常见的提示文本占位符，提醒用户填入自己的API密钥
  "your-api-key",
  // 带空格的提示文本变体，同样用于引导用户替换密钥
  "your api key",
  // 明确要求用户替换的占位符文本，常见于配置说明文档
  "replace-with-your-api-key",
]);

/**
 * 判断输入的字符串是否为占位符API密钥
 * @param value 待检测的字符串，可能为undefined（即未传入值）
 * @returns 如果是占位符密钥返回true，否则返回false
 */
export function isPlaceholderApiKey(value: string | undefined): boolean {
  // 当输入值为undefined、空字符串等假值时，直接判定为非占位符
  if (!value) {
    return false;
  }

  // 先对输入值做首尾空白去除和小写转换，再匹配占位符集合，实现大小写和空白容错
  return PLACEHOLDER_API_KEYS.has(value.trim().toLowerCase());
}
