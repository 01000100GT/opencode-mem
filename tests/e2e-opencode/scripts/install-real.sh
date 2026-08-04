#!/usr/bin/env bash
# ============================================================
# 正式使用安装: 把本地 opencode-mem 装载到全局 opencode
# ============================================================
# 工作目标:
#   1. 备份当前 ~/.config/opencode/opencode-mem.jsonc (用户实际配置)
#   2. 把本仓 dist/plugin.js symlink 到 ~/.config/opencode/plugins/
#   3. 修改 opencode-mem.jsonc:
#      - memoryModel: compqwen3635/... (修正模型 ID, 之前少 3635)
#      - opencodeProvider/Model: inherit (跟随当前 opencode 会话)
#      - autoCaptureIterationTimeout: 120000 (本仓已修, 同步到全局配置)
#   4. 不动 ~/.opencode-mem/ 数据 (1.6GB 真实数据)
#   5. 不动全局 opencode.json 的其它 plugin
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PLUGIN_DIST="$ROOT/dist/plugin.js"
GLOBAL_PLUGINS="$HOME/.config/opencode/plugins"
USER_GLOBAL_CFG="$HOME/.config/opencode/opencode-mem.jsonc"
BACKUP_CFG="$HOME/.config/opencode/opencode-mem.jsonc.bak-real-use"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "→ root          : $ROOT"
echo "→ plugin dist   : $PLUGIN_DIST"
echo "→ global plugins: $GLOBAL_PLUGINS"
echo "→ user config   : $USER_GLOBAL_CFG"

# 1) 备份用户当前配置
if [ -f "$USER_GLOBAL_CFG" ]; then
  if [ ! -f "$BACKUP_CFG" ]; then
    cp "$USER_GLOBAL_CFG" "$BACKUP_CFG"
    echo "✓ 已备份原配置: $BACKUP_CFG"
  else
    echo "  备份已存在, 跳过: $BACKUP_CFG"
  fi
fi

# 2) symlink plugin 到全局 plugins 目录
mkdir -p "$GLOBAL_PLUGINS"
if [ -L "$GLOBAL_PLUGINS/opencode-mem.js" ] || [ -f "$GLOBAL_PLUGINS/opencode-mem.js" ]; then
  echo "  移除旧文件: $GLOBAL_PLUGINS/opencode-mem.js"
  rm -f "$GLOBAL_PLUGINS/opencode-mem.js"
fi
ln -s "$PLUGIN_DIST" "$GLOBAL_PLUGINS/opencode-mem.js"
echo "✓ symlink 创建: $GLOBAL_PLUGINS/opencode-mem.js → $PLUGIN_DIST"

# 3) 修改配置: 三个关键字段
#    使用 python 安全操作 (jsonc 中含注释, 纯 JSON 无法解析)
python3 << PYEOF
import re
path = "$USER_GLOBAL_CFG"
with open(path) as f:
    content = f.read()

# 修正 memoryModel
content_new = re.sub(
    r'"memoryModel":\s*"compqwen/Qwen3\.6-35B-A3B-FP8"',
    '"memoryModel": "compqwen3635/Qwen3.6-35B-A3B-FP8"',
    content
)
if content_new == content:
    print("  [info] memoryModel 已是 compqwen3635/...")
else:
    print("✓ memoryModel: compqwen/... → compqwen3635/...")
    content = content_new

# opencodeProvider/Model 改为 inherit
content_new = re.sub(
    r'"opencodeProvider":\s*"deepseek"',
    '"opencodeProvider": "inherit"',
    content
)
content_new = re.sub(
    r'"opencodeModel":\s*"deepseek-v4-flash"',
    '"opencodeModel": "inherit"',
    content_new
)
if content_new == content:
    print("  [info] opencodeProvider/Model 已是 inherit")
else:
    print("✓ opencodeProvider/Model: deepseek/deepseek-v4-flash → inherit/inherit")
    content = content_new

# autoCaptureIterationTimeout: 30000 → 120000
content_new = re.sub(
    r'"autoCaptureIterationTimeout":\s*30000',
    '"autoCaptureIterationTimeout": 120000',
    content
)
if content_new == content:
    print("  [info] autoCaptureIterationTimeout 已是 120000")
else:
    print("✓ autoCaptureIterationTimeout: 30000 → 120000")
    content = content_new

with open(path, "w") as f:
    f.write(content)
print(f"✓ 配置已更新: {path}")
PYEOF

echo
echo "✓ 正式安装完成"
echo
echo "下一步:"
echo "  1. 重启 opencode (TUI: 退出重入; 服务: opencode serve 重启)"
echo "  2. 验证: 在任意项目 cd 后, 第一次启动会看到:"
echo "     - chat.message 触发 → TaskBrief + profile inject (看 opencode-mem.log)"
echo "     - http://127.0.0.1:4747 可访问 (Web UI)"
echo "  3. 如果想回退: cp $BACKUP_CFG $USER_GLOBAL_CFG && rm $GLOBAL_PLUGINS/opencode-mem.js"