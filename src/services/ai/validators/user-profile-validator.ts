// 导入用户配置数据的类型定义，该类型定义来自上级目录的user-profile模块
import type { UserProfileData } from "../../user-profile/types.js";

// 导出验证结果接口，用于统一描述数据校验后的返回格式
export interface ValidationResult {
  // 校验状态标识，true表示数据通过所有校验规则，false表示存在校验不通过项
  valid: boolean;
  // 校验错误信息集合，存储所有未通过校验的问题描述，空数组表示无错误
  errors: string[];
  // 校验通过后的原始数据，仅当valid为true时存在，类型为用户配置数据类型
  data?: UserProfileData;
}

// 用户配置数据校验器类，封装了所有与用户配置合法性校验相关的核心逻辑
export class UserProfileValidator {
  // 静态校验入口方法，接收任意类型的原始数据，返回标准化的校验结果对象
  static validate(data: any): ValidationResult {
    // 初始化错误信息收集数组，用于存储所有校验不通过的问题描述
    const errors: string[] = [];
    // 第一层基础校验：判断输入数据是否为非空对象，过滤空值、基础类型等非法输入
    if (!data || typeof data !== "object") {
      return { valid: false, errors: ["Response is not an object"] };
    }
    // 第二层类型校验：排除数组类型，确保输入是纯对象而非数组结构
    if (Array.isArray(data)) {
      return { valid: false, errors: ["Response cannot be an array"] };
    }
    // 提取输入对象的所有自有属性键，用于后续遍历校验所有字段的合法性
    const keys = Object.keys(data);
    // 校验对象是否为空，禁止传入无任何属性的空对象
    if (keys.length === 0) {
      return { valid: false, errors: ["Response object is empty"] };
    }
    // 遍历所有属性键，逐个校验字段值的合法性
    for (const key of keys) {
      // 若字段值为undefined或null，记录该字段的非法状态错误
      if (data[key] === undefined || data[key] === null) {
        errors.push(`Field '${key}' is null or undefined`);
      }
    }
    // 基础字段校验完成后检查是否存在错误，若有则提前返回校验失败结果
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    // 若输入数据中包含preferences字段，则调用专项校验方法检查偏好设置的合法性
    if (data.preferences) {
      const prefErrors = this.validatePreferences(data.preferences);
      errors.push(...prefErrors);
    }
    // 若输入数据中包含patterns字段，则调用专项校验方法检查行为模式的合法性
    if (data.patterns) {
      const patternErrors = this.validatePatterns(data.patterns);
      errors.push(...patternErrors);
    }
    // 若输入数据中包含workflows字段，则调用专项校验方法检查工作流配置的合法性
    if (data.workflows) {
      const workflowErrors = this.validateWorkflows(data.workflows);
      errors.push(...workflowErrors);
    }
    // 所有专项校验完成后再次检查错误集合，若存在错误则返回校验失败结果
    if (errors.length > 0) {
      return { valid: false, errors };
    }
    // 所有校验规则全部通过，返回校验成功结果，并将原始数据类型断言为标准用户配置类型
    return { valid: true, errors: [], data: data as UserProfileData };
  }

  // 用户偏好设置专项校验方法的私有静态实现，接收任意类型的偏好数据，返回校验错误信息数组
  private static validatePreferences(preferences: any): string[] {
    // 初始化偏好设置校验的错误信息收集数组，用于存储当前批次校验发现的所有问题
    const errors: string[] = [];
    // 第一层类型校验：验证preferences必须为数组类型，非数组结构直接返回错误
    if (!Array.isArray(preferences)) {
      return ["preferences must be an array"];
    }
    // 遍历偏好数组的每一个元素，对单个偏好配置进行全字段合法性校验
    for (let i = 0; i < preferences.length; i++) {
      // 提取当前循环的单个偏好配置对象，简化后续代码的字段访问
      const pref = preferences[i];
      // 校验单个偏好配置的基础合法性：必须为非空对象，否则记录错误并跳过后续字段校验
      if (!pref || typeof pref !== "object") {
        errors.push(`preferences[${i}] is not an object`);
        continue;
      }
      // 校验category字段：必须存在且为字符串类型，否则记录字段缺失或类型非法错误
      if (!pref.category || typeof pref.category !== "string") {
        errors.push(`preferences[${i}].category is missing or invalid`);
      }
      // 校验description字段：必须存在且为字符串类型，用于描述偏好的具体内容，否则记录错误
      if (!pref.description || typeof pref.description !== "string") {
        errors.push(`preferences[${i}].description is missing or invalid`);
      }
      // 校验confidence字段：必须为数值类型，代表该偏好的置信度评分，缺失或类型非法则记录错误
      if (typeof pref.confidence !== "number") {
        errors.push(`preferences[${i}].confidence is missing or invalid`);
      }
      // 第一层校验evidence字段：必须为数组类型，用于存储支撑该偏好的证据列表
      if (!Array.isArray(pref.evidence)) {
        errors.push(`preferences[${i}].evidence must be an array`);
      }
      // 第二层校验evidence数组：数组长度不能为0，必须存在至少一条支撑偏好的有效证据
      else if (pref.evidence.length === 0) {
        errors.push(`preferences[${i}].evidence cannot be empty`);
      }
    }
    // 返回当前偏好设置批次的所有校验错误信息，空数组表示全部通过校验
    return errors;
  }

  // 用户行为模式专项校验方法的私有静态实现，接收任意类型的模式数据，返回校验错误信息数组
  private static validatePatterns(patterns: any): string[] {
    // 初始化行为模式校验的错误信息收集数组，用于存储当前批次校验发现的所有问题
    const errors: string[] = [];
    // 第一层类型校验：验证patterns必须为数组类型，非数组结构直接返回错误
    if (!Array.isArray(patterns)) {
      return ["patterns must be an array"];
    }
    // 遍历模式数组的每一个元素，对单个行为模式配置进行全字段合法性校验
    for (let i = 0; i < patterns.length; i++) {
      // 提取当前循环的单个行为模式配置对象，简化后续代码的字段访问
      const pattern = patterns[i];
      // 校验单个模式配置的基础合法性：必须为非空对象，否则记录错误并跳过后续字段校验
      if (!pattern || typeof pattern !== "object") {
        errors.push(`patterns[${i}] is not an object`);
        continue;
      }
      // 校验category字段：必须存在且为字符串类型，否则记录字段缺失或类型非法错误
      if (!pattern.category || typeof pattern.category !== "string") {
        errors.push(`patterns[${i}].category is missing or invalid`);
      }
      // 校验description字段：必须存在且为字符串类型，用于描述行为模式的具体内容，否则记录错误
      if (!pattern.description || typeof pattern.description !== "string") {
        errors.push(`patterns[${i}].description is missing or invalid`);
      }
    }
    // 返回当前行为模式批次的所有校验错误信息，空数组表示全部通过校验
    return errors;
  }

  // 工作流配置专项校验方法的私有静态实现，接收任意类型的工作流数据，返回校验错误信息数组
  private static validateWorkflows(workflows: any): string[] {
    // 初始化工作流校验的错误信息收集数组，用于存储当前批次校验发现的所有问题
    const errors: string[] = [];
    // 第一层类型校验：验证workflows必须为数组类型，非数组结构直接返回错误
    if (!Array.isArray(workflows)) {
      return ["workflows must be an array"];
    }
    // 遍历工作流数组的每一个元素，对单个工作流配置进行全字段合法性校验
    for (let i = 0; i < workflows.length; i++) {
      // 提取当前循环的单个工作流配置对象，简化后续代码的字段访问
      const workflow = workflows[i];
      // 校验单个工作流配置的基础合法性：必须为非空对象，否则记录错误并跳过后续字段校验
      if (!workflow || typeof workflow !== "object") {
        errors.push(`workflows[${i}] is not an object`);
        continue;
      }
      // 校验description字段：必须存在且为字符串类型，用于描述工作流的具体内容，否则记录错误
      if (!workflow.description || typeof workflow.description !== "string") {
        errors.push(`workflows[${i}].description is missing or invalid`);
      }
      // 第一层校验steps字段：必须为数组类型，用于存储工作流的所有执行步骤
      if (!Array.isArray(workflow.steps)) {
        errors.push(`workflows[${i}].steps must be an array`);
      }
      // 第二层校验steps数组：数组长度不能为0，必须存在至少一个工作流执行步骤
      else if (workflow.steps.length === 0) {
        errors.push(`workflows[${i}].steps cannot be empty`);
      }
    }
    // 返回当前工作流配置批次的所有校验错误信息，空数组表示全部通过校验
    return errors;
  }
}
