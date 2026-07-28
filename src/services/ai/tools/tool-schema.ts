// 聊天补全工具接口，用于描述OpenAI风格的Function Call工具定义
export interface ChatCompletionTool {
  // 工具类型，固定为"function"，表示这是一个函数调用工具
  type: "function";
  // 函数的核心定义对象，包含函数的元数据和参数规则
  function: {
    // 函数名称，作为调用时的唯一标识符，需符合变量命名规范
    name: string;
    // 函数功能描述，供大语言模型理解该工具的用途和适用场景
    description: string;
    // 函数参数的JSON Schema定义，用于约束参数的结构和格式
    parameters: {
      // 参数结构的类型，固定为"object"，表示顶层参数是一个对象
      type: string;
      // 所有参数的属性定义集合，键为参数名，值为参数的Schema规则
      properties: Record<string, any>;
      // 必填参数的名称数组，列出哪些参数是调用时必须提供的
      required: string[];
    };
  };
}

// OpenAI Responses API格式的工具定义接口，用于统一描述模型可调用的函数工具结构
export interface ResponsesAPITool {
  // 工具类型固定为"function"，标识这是一个函数调用类工具，符合Responses API的类型规范
  type: "function";
  // 函数的唯一标识符，作为工具调用时的身份凭证，需满足合法的变量命名规则
  name: string;
  // 函数能力的详细描述文本，用于让大语言模型理解工具的适用场景与核心功能
  description: string;
  // 函数参数的结构定义容器，遵循JSON Schema规范约束入参的格式与校验规则
  parameters: {
    // 参数对象的根类型固定为object，符合Responses API对顶层参数结构的强制要求
    type: string;
    // 所有参数的属性定义集合，键为参数名称，值为对应参数的JSON Schema校验规则
    properties: Record<string, any>;
    // 必填参数的名称数组，标注调用该函数时必须传入的参数列表，缺失会触发参数校验失败
    required: string[];
  };
}

// Anthropic大模型工具调用规范接口，适配Claude系列模型的工具定义格式
export interface AnthropicTool {
  // 工具的唯一标识名称，作为函数调用的身份标识，需符合变量命名规范
  name: string;
  // 工具核心能力的自然语言描述，供Claude模型理解工具的适用场景与功能边界
  description: string;
  // 工具入参的JSON Schema校验容器，遵循Anthropic要求的输入 schema 规范
  input_schema: {
    // 根参数结构固定为object类型，符合Anthropic工具调用的参数结构强制要求
    type: string;
    // 所有参数的属性定义集合，键为参数名，值为对应参数的JSON Schema校验规则
    properties: Record<string, any>;
    // 必填参数的名称数组，标注调用该工具时必须传入的参数列表，缺失会触发参数校验失败
    required: string[];
  };
}

// 多模型工具架构转换核心类，统一封装OpenAI、Anthropic等主流大模型的工具定义格式转换逻辑
// 实现ChatCompletion标准格式到各厂商私有格式的无损映射，为多模型兼容提供标准化的转换能力
export class ToolSchemaConverter {
  // 将标准ChatCompletion格式工具转换为OpenAI Responses API规范的工具定义
  // 输入参数为符合OpenAI ChatCompletion标准的工具对象实例
  // 返回值为完全适配Responses API格式要求的工具对象
  static toResponsesAPI(chatCompletionTool: ChatCompletionTool): ResponsesAPITool {
    // 构造并返回符合Responses API规范的工具结构
    return {
      // 工具类型固定为function，严格遵循Responses API的类型约束
      type: "function",
      // 从源工具中提取函数唯一标识，保持调用标识符的一致性
      name: chatCompletionTool.function.name,
      // 完整迁移函数功能描述文本，确保模型对工具能力的理解无偏差
      description: chatCompletionTool.function.description,
      // 直接复用原参数Schema定义，实现参数规则的无损转换
      parameters: chatCompletionTool.function.parameters,
    };
  }

  // 将标准ChatCompletion格式工具转换为Anthropic Claude模型规范的工具定义
  // 输入参数为符合OpenAI ChatCompletion标准的工具对象实例
  // 返回值为完全适配Anthropic工具调用格式要求的工具对象
  static toAnthropic(chatCompletionTool: ChatCompletionTool): AnthropicTool {
    // 构造并返回符合Anthropic规范的工具结构
    return {
      // 从源工具中提取函数唯一标识，保持调用标识符的一致性
      name: chatCompletionTool.function.name,
      // 完整迁移函数功能描述文本，确保Claude模型对工具能力的理解无偏差
      description: chatCompletionTool.function.description,
      // 直接复用原参数Schema定义，适配Anthropic的input_schema字段要求，实现参数规则的无损转换
      input_schema: chatCompletionTool.function.parameters,
    };
  }

  // 从标准ChatCompletion格式工具出发，批量生成所有主流大模型适配的工具定义集合
  // 输入参数为符合OpenAI ChatCompletion标准的源工具对象
  // 返回值为包含ChatCompletion原生、Responses API、Anthropic三种格式的工具对象聚合体
  static fromChatCompletion(tool: ChatCompletionTool): {
    chatCompletion: ChatCompletionTool;
    responsesAPI: ResponsesAPITool;
    anthropic: AnthropicTool;
  } {
    // 构造并返回多格式工具定义的聚合对象
    return {
      // 保留原始的ChatCompletion格式工具，满足原生OpenAI Chat API调用需求
      chatCompletion: tool,
      // 调用内置转换方法生成适配OpenAI Responses API的工具定义
      responsesAPI: this.toResponsesAPI(tool),
      // 调用内置转换方法生成适配Anthropic Claude系列模型的工具定义
      anthropic: this.toAnthropic(tool),
    };
  }
}
