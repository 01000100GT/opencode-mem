// 导入插件模块的类型定义，用于约束插件的结构规范
import type { PluginModule } from "@opencode-ai/plugin";
// 以JSON格式导入当前项目的package.json配置文件，获取项目基础元数据
import pkg from "../package.json" with { type: "json" };
// 动态导入入口文件中的记忆插件主类，提取核心实现
const { OpenCodeMemPlugin } = await import("./index.js");

// 导出插件唯一标识符：优先使用package.json中的合法name字段，兜底使用默认标识
export const id =
  typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "opencode-mem";
// 导出记忆插件主类，供外部模块单独引入使用
// 命名导出（Named Export）
// 导出一个带名字的变量，外部 import 时必须用花括号且名字必须匹配
// 消费方的区别 : // 消费命名导出 → 必须花括号 + 名字一致 ; // ✓ 拿到的是函数本身
// 使用方是: 其他开发者/测试;  import { OpenCodeMemPlugin } from "opencode-mem" → 直接用工厂函数
export { OpenCodeMemPlugin };

// 导出符合OpenCode插件规范的模块对象，完成插件的注册配置
// 默认导出（Default Export）
// 导出一个匿名对象，外部 import 时不需要花括号，名字随便起
// 消费默认导出 → 不用花括号 + 名字随意; // ✓ 拿到的是 { id, server } 这个对象
// export default 是 opencode 宿主在使用.
// 使用时: import plugin from "opencode-mem" → 读 plugin.id 和 plugin.server
export default { id, server: OpenCodeMemPlugin } satisfies PluginModule;
