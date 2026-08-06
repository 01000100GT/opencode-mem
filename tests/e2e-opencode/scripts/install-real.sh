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

# 0) 扫描项目内的 opencode-mem 配置: 项目级配置覆盖全局, 必须先排除干扰
#    残留特征: 嵌入端点指向外部 (非内网) 或 autoCaptureEnabled=false
#    不自动删除: 用户可能有意配置项目级覆盖, 仅提示让用户决策
#    限定到常见项目根目录避免遍历全部 $HOME
echo
echo "→ 扫描项目级配置干扰..."
PROJECT_CFG_CONFLICT=0
# 仅扫描存在的目录, 避免 find 因路径不存在而异常
# 把结果存入临时文件, 避免 here-string 在 set -e + pipefail 下被静默吃掉
TMP_SCAN=$(mktemp)
trap 'rm -f "$TMP_SCAN"' EXIT
: > "$TMP_SCAN"
# 精确扫描 /Users/sss/devprog/devprog_sss (已知用户项目根) - 避免全 $HOME 扫描卡顿
# 深度 5: AI_MEMORY/opencode-mem/.opencode/file 刚好命中
SCAN_ROOTS="/Users/sss/devprog/devprog_sss /Users/sss/Code /Users/sss/projects /Users/sss/work"
for root in $SCAN_ROOTS; do
  if [ -d "$root" ]; then
    timeout 15 find "$root" -maxdepth 5 -name "opencode-mem.jsonc" -path "*/.opencode/*" 2>/dev/null >> "$TMP_SCAN" || true
  fi
done

while IFS= read -r project_cfg; do
  [ -z "$project_cfg" ] && continue
  echo "  发现: $project_cfg"
  # 检测残留特征: 外部 embedding 端点 或 autoCapture=false
  is_residual="no"
  if grep -qE 'embeddingApiUrl.*open\.bigmodel\.cn|embeddingApiUrl.*api\.openai\.com|embeddingApiUrl.*api\.deepseek\.com' "$project_cfg" 2>/dev/null; then
    is_residual="yes"
  fi
  if grep -qE '"autoCaptureEnabled":[[:space:]]*false' "$project_cfg" 2>/dev/null; then
    is_residual="yes"
  fi
  if [ "$is_residual" = "yes" ]; then
    echo "    ⚠️  此配置可能是早期测试残留 (外部 embedding 端点 或 autoCapture 关闭)"
    echo "    ⚠️  项目级配置会覆盖全局, 当前 opencode 加载时不会应用本次修改"
    echo "    ⚠️  建议: mv $project_cfg ${project_cfg}.bak-residual"
    PROJECT_CFG_CONFLICT=1
  fi
done < "$TMP_SCAN"

if [ "$PROJECT_CFG_CONFLICT" -eq 1 ]; then
  echo
  echo "⚠️  检测到项目级配置干扰. 你想:"
  echo "    a) 全部自动备份为 .bak-residual (推荐)"
  echo "    b) 我来处理 (跳过)"
  read -p "  请输入 a 或 b (默认 b): " choice
  if [ "$choice" = "a" ]; then
    while IFS= read -r project_cfg; do
      [ -z "$project_cfg" ] && continue
      is_residual="no"
      if grep -qE 'embeddingApiUrl.*open\.bigmodel\.cn|embeddingApiUrl.*api\.openai\.com|embeddingApiUrl.*api\.deepseek\.com' "$project_cfg" 2>/dev/null; then
        is_residual="yes"
      fi
      if grep -qE '"autoCaptureEnabled":[[:space:]]*false' "$project_cfg" 2>/dev/null; then
        is_residual="yes"
      fi
      if [ "$is_residual" = "yes" ]; then
        mv "$project_cfg" "${project_cfg}.bak-residual"
        echo "    ✓ 已备份: $project_cfg → ${project_cfg}.bak-residual"
      fi
    done < "$TMP_SCAN"
  else
    echo "  跳过自动备份. 已知问题: 项目级配置将继续覆盖全局"
  fi
fi

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
echo
echo "⚠️  重要: 项目级配置覆盖全局. 如果本项目之前有 .opencode/opencode-mem.jsonc, 它会"
echo "    屏蔽上面的全局修改. 安装脚本已扫描并提示, 请确认项目级配置已被清理 (或确认你"
echo "    仍希望它覆盖全局)."