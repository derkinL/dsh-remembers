#!/usr/bin/env bash
# 一键安装：把 dsh-remembers 插件装进 DSH profile，并确认记忆服务在跑。
#
# 设计成「你自己在 VPS 上跑一条命令」：
#   ./install.sh                  # 默认装到 web profile
#   DSH_PROFILE=desktop ./install.sh
#   ./install.sh --no-service     # 服务已在跑，只装插件
#
# 不会做的事：不自动装 Docker、不改防火墙、不动你自己的记忆数据。
set -euo pipefail

KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_SRC="$KIT_DIR"                 # 插件在仓库根（dsh plugin add 的要求）
SERVICE_DIR="$KIT_DIR/service"        # 记忆服务在 service/
DSH_PROFILE="${DSH_PROFILE:-web}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$DSH_PROFILE"
PLUGIN_NAME="dsh-remembers"
SKIP_SERVICE=0

for arg in "$@"; do
  case "$arg" in
    --no-service) SKIP_SERVICE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

info() { printf '\033[36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. 环境
# ---------------------------------------------------------------------------
info "检查 Node.js"
command -v node >/dev/null 2>&1 || die "没有 node。先装 Node.js ≥ 22.19（nvm 或 apt 均可）"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  warn "Node $(node -v)，插件要求 ≥22.19。低版本可能起不来。"
fi

info "检查 DSH profile：$PROFILE_DIR"
[ -d "$PROFILE_DIR" ] || die "找不到 profile 目录。
  已安装的 profile 在 $DSH_HOME_DIR/profiles/
  如果 DSH 装在别处，用 DSH_HOME=/your/dsh/home ./install.sh"

[ -f "$PLUGIN_SRC/index.mjs" ] || die "找不到插件源码：$PLUGIN_SRC（是不是只拷了部分文件？）"

# ---------------------------------------------------------------------------
# 2. 服务
# ---------------------------------------------------------------------------
if [ "$SKIP_SERVICE" = "0" ]; then
  info "检查记忆服务"
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    info "服务已在运行"
  else
    warn "127.0.0.1:8080 没有响应。先起服务：
  cd $SERVICE_DIR && ./deploy.sh
  起好后重跑：./install.sh --no-service"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 3. 安装插件（拷贝，不用 pnpm link：路径依赖在 profile 里更容易坏）
# ---------------------------------------------------------------------------
DEST="$PROFILE_DIR/node_modules/$PLUGIN_NAME"
info "安装插件 → $DEST"

if [ -e "$DEST" ]; then
  BACKUP="$DEST.bak.$(date +%Y%m%d%H%M%S)"
  mv "$DEST" "$BACKUP"
  info "已备份旧版本 → $(basename "$BACKUP")"
fi

mkdir -p "$DEST"
# 只拷运行需要的文件。**绝不拷 node_modules**——那是仓库里留给本地测试的替身，
# 拷过去会顶掉宿主真正的 @deepseek-ai/dsh-llm。
# 注意用 if 而不是 `[ -f ] && cp`：后者在 set -e 下遇到缺失文件会直接终止脚本。
for f in index.mjs client.js client.mjs config.mjs cordis.patch.yml package.json README.md; do
  if [ -f "$PLUGIN_SRC/$f" ]; then
    cp "$PLUGIN_SRC/$f" "$DEST/$f"
  else
    warn "缺少 $f（继续，但可能不完整）"
  fi
done

[ -f "$DEST/index.mjs" ] || die "拷贝失败：$DEST/index.mjs 不存在"
if [ -d "$DEST/node_modules" ]; then
  warn "检测到 node_modules，已删除（那会覆盖宿主的 dsh-llm）"
  rm -rf "$DEST/node_modules"
fi

# 语法自检：装完立刻验，别等重启才发现语法错
node --check "$DEST/index.mjs" || die "index.mjs 语法检查失败"

# ---------------------------------------------------------------------------
# 4. 注册到 profile
# ---------------------------------------------------------------------------
PKG="$PROFILE_DIR/package.json"
[ -f "$PKG" ] || die "找不到 $PKG"

info "注册到 dsh.profile.bundles"
node - "$PKG" "$PLUGIN_NAME" <<'NODE'
const fs = require("node:fs");
const [pkgPath, name] = process.argv.slice(2);
// 去掉 BOM：某些编辑器（和 Windows 的 Set-Content）会在 UTF-8 文件头写 \uFEFF，
// 直接 JSON.parse 会抛 "Unexpected token"，而 profile 的 package.json 一旦解析失败
// 整个 profile 就起不来。
const raw = fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, "");
const pkg = JSON.parse(raw);
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
if (bundles.includes(name)) {
  console.log(`  ${name} 已在 bundles 里`);
} else {
  bundles.push(name);
  pkg.dsh.profile.bundles = bundles;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  已加入 bundles：${name}`);
}
NODE

# ---------------------------------------------------------------------------
# 5. 配置检查
# ---------------------------------------------------------------------------
if [ -f "$SERVICE_DIR/.env" ]; then
  TOKEN=$(grep -E '^CMEM_AUTH_TOKEN=..*' "$SERVICE_DIR/.env" | cut -d= -f2- || true)
else
  TOKEN=""
fi

info "插件默认连 http://127.0.0.1:8080"
if [ -n "$TOKEN" ]; then
  warn "服务设了鉴权 token。插件要能拿到同一个，建议写进 DSH 的环境变量：
  export CMEM_AUTH_TOKEN=$TOKEN"
fi

cat <<EOF

────────────────────────────────────────
装好了。重启 DSH 让它加载插件：

  dsh --profile $DSH_PROFILE

重启后看日志里有没有这一行（说明插件起来了）：

  [dsh-remembers] loaded {"version":"1.0.0",...}

验证记忆真的在工作（问它一句，然后看服务端有没有收到检索）：

  curl -s http://127.0.0.1:8080/log?limit=5

期望看到 outcome=ok 或 no_match 的记录。全是空的 = 插件没把消息送上去。
────────────────────────────────────────
EOF
