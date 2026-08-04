#!/usr/bin/env bash
# ============================================================
# E2E Setup: 准备独立 demo 项目 + 装载本地 opencode-mem plugin
# ============================================================
# 工作目标:
#   1. 在 /tmp/opencode-mem-demo 创建独立项目骨架 (ts + vitest)
#   2. 在 demo/.opencode/plugins/ 软链接 opencode-mem/dist/plugin.js
#   3. 隔离 demo 的存储路径: ~/.opencode-mem-demo-data (不复用 ~/.opencode-mem)
#   4. 屏蔽全局 opencode-mem@2.17.1, 防止与本地开发版本冲突
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DEMO="/tmp/opencode-mem-demo"
DEMO_DATA="$HOME/.opencode-mem-demo-data"
MEM_DIST="$ROOT/dist/plugin.js"
GLOBAL_CFG="$HOME/.config/opencode/opencode.json"
BACKUP_CFG="$HOME/.config/opencode/opencode.json.bak-e2e"

echo "→ root        : $ROOT"
echo "→ demo project: $DEMO"
echo "→ demo data   : $DEMO_DATA"
echo "→ plugin src  : $MEM_DIST"

# 1) 准备 demo 项目骨架 (保留 demo 不删, 仅清理与重建配置/plugin; 删除会破坏 sandbox cwd)
rm -rf "$DEMO/.opencode"
mkdir -p "$DEMO"/src "$DEMO"/tests "$DEMO/.opencode/plugins"

cat > "$DEMO/package.json" <<'EOF'
{
  "name": "opencode-mem-demo",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
EOF

cat > "$DEMO/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
EOF

cat > "$DEMO/vitest.config.ts" <<'EOF'
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
EOF

# 2) opencode 配置 (model/默认 provider, 屏蔽全局 plugin)
cat > "$DEMO/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "mycomp/Qwen3.6-35B-A3B-FP8",
  "default_agent": "build",
  "plugin": [],
  "agent": {
    "build": {
      "disable": false,
      "model": "mycomp/Qwen3.6-35B-A3B-FP8"
    }
  }
}
EOF

# 3) opencode-mem 配置 (复用 vLLM, 不走 opencode host 路径)
cat > "$DEMO/.opencode/opencode-mem.json" <<EOF
{
  "storagePath": "$DEMO_DATA",
  "embeddingModel": "Xenova/nomic-embed-text-v1",
  "embeddingDtype": "q8",
  "vectorBackend": "hnswlib-wasm-first",
  "memoryProvider": "openai-chat",
  "memoryApiUrl": "http://192.168.7.113:20128/v1",
  "memoryApiKey": "sk-a1b7d5da9f448995-c4yg7o-c159be8f",
  "memoryModel": "compqwen3635/Qwen3.6-35B-A3B-FP8",
  "opencodeProvider": "",
  "opencodeModel": "",
  "autoCaptureEnabled": true,
  "diag": true,
  "logLevel": "DEBUG"
}
EOF

# 4) 软链接 plugin 文件 (不复制, dist 改动自动生效)
ln -sf "$MEM_DIST" "$DEMO/.opencode/plugins/opencode-mem.js"

# 5) 隔离存储目录
rm -rf "$DEMO_DATA"
mkdir -p "$DEMO_DATA/.cache"

# 6) 复用已有 embedding 模型缓存, 避免首次下载
if [ -d "$HOME/.opencode-mem/data/.cache" ]; then
  cp -R "$HOME/.opencode-mem/data/.cache/"* "$DEMO_DATA/.cache/" 2>/dev/null || true
  echo "✓ 复用本地 embedding 模型缓存"
fi

# 7) 临时屏蔽全局 opencode-mem plugin (避免与本地版本冲突)
if [ -f "$GLOBAL_CFG" ]; then
  if ! grep -q "opencode.json.bak-e2e" "$HOME/.config/opencode/" 2>/dev/null; then
    cp "$GLOBAL_CFG" "$BACKUP_CFG"
    # 用 python 安全地移除 opencode-mem 2.17.1 引用
    python3 -c "
import json, sys
with open('$GLOBAL_CFG') as f: cfg = json.load(f)
if 'plugin' in cfg:
    cfg['plugin'] = [p for p in cfg['plugin'] if 'opencode-mem' not in p]
with open('$GLOBAL_CFG','w') as f: json.dump(cfg, f, indent=2)
print('✓ 全局 opencode-mem@2.17.1 已临时屏蔽, 备份至', '$BACKUP_CFG')
"
  fi
fi

echo
echo "✓ setup 完成"
echo "  验证 plugin 装载:"
echo "    $ ls -la $DEMO/.opencode/plugins/"
ls -la "$DEMO/.opencode/plugins/"