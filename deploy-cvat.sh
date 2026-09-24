#!/usr/bin/env bash
# ============================================================
# CVAT 服务器部署脚本 (Linux)
# 用法: sudo bash deploy-cvat.sh [options]
#
# Options:
#   --skip-build           跳过 docker compose build（已构建过镜像用）
#   --skip-nuclio          跳过 Nuclio 函数部署
#   --no-serverless        不启用 serverless（不包含 Nuclio dashboard）
#   --bailian-key KEY      直接写入百炼 API Key（仅单组织场景，推荐页面 UI 配）
#   --bailian-url URL      直接写入百炼 API URL
#   --bailian-model MODEL  直接写入百炼 Model 名（默认 qwen3-vl-plus）
#   --clean                清理旧容器和匿名卷（⚠️ 会丢旧标注数据！）
#
# 示例:
#   sudo bash deploy-cvat.sh
#   sudo bash deploy-cvat.sh --skip-build
#   sudo bash deploy-cvat.sh --clean --bailian-key "sk-xxx"
# ============================================================

set -euo pipefail

# ---------- 解析参数 ----------
SKIP_BUILD=0
SKIP_NUCLIO=0
NO_SERVERLESS=0
DO_CLEAN=0
BAILIAN_API_KEY=""
BAILIAN_API_URL=""
BAILIAN_MODEL="qwen3-vl-plus"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)     SKIP_BUILD=1 ;;
    --skip-nuclio)    SKIP_NUCLIO=1 ;;
    --no-serverless)  NO_SERVERLESS=1 ;;
    --clean)          DO_CLEAN=1 ;;
    --bailian-key)    BAILIAN_API_KEY="$2"; shift ;;
    --bailian-url)    BAILIAN_API_URL="$2"; shift ;;
    --bailian-model)  BAILIAN_MODEL="$2";   shift ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

# ---------- 颜色输出 ----------
red()    { echo -e "\033[31m$*\033[0m"; }
green()  { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
cyan()   { echo -e "\033[36m$*\033[0m"; }
step()   { echo ""; yellow "[Step $1/7] $2"; }

# ---------- 检查运行环境 ----------
if [[ $EUID -ne 0 ]]; then
  red "请用 sudo 运行: sudo bash $0"
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

cyan "========================================"
cyan " CVAT Deployment Script"
cyan " Dir : $SCRIPT_DIR"
cyan " Time: $(date)"
cyan "========================================"

# ---------- 基础检查 ----------
step 1 "Checking prerequisites..."

REQUIRED_CMDS=(docker tar sha256sum)
for c in "${REQUIRED_CMDS[@]}"; do
  if ! command -v "$c" &>/dev/null; then
    red "缺少命令: $c ，请先安装。"
    exit 1
  fi
done

# docker compose（同时支持 v1 docker-compose 和 v2 docker compose）
if docker compose version &>/dev/null; then
  DC="docker compose"
elif command -v docker-compose &>/dev/null; then
  DC="docker-compose"
else
  red "未找到 docker compose (v1 或 v2)。请先安装 Docker Compose。"
  exit 1
fi
green "  使用: $DC"

# 关键文件检查
REQUIRED_FILES=(
  docker-compose.yml .env.example
  Dockerfile Dockerfile.ui
  components/serverless/docker-compose.serverless.yml
  serverless/qwen/bailian/qwen37-detector/nuclio/function.yaml
  serverless/qwen/bailian/qwen37-detector/nuclio/main.py
  cvat/apps/organizations/migrations/0003_bailiansettings.py
)
for f in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    red "缺少必需文件: $f （可能打包没传全）"
    exit 1
  fi
done
green "  所有必需文件就绪"

# ---------- 可选清理 ----------
if [[ $DO_CLEAN -eq 1 ]]; then
  step 2 "Cleaning old deployment (--clean enabled)..."
  yellow "  ⚠️  即将停止所有 cvat 容器并删除匿名卷，数据会丢失！5 秒后继续，Ctrl+C 取消"
  sleep 5
  if [[ -f docker-compose.override.yml ]]; then
    $DC -f docker-compose.yml -f docker-compose.override.yml -f components/serverless/docker-compose.serverless.yml down -v 2>/dev/null || true
  else
    $DC -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml down -v 2>/dev/null || true
  fi
  docker network rm cvat_cvat 2>/dev/null || true
  green "  清理完成"
else
  step 2 "Stopping existing CVAT containers (preserving volumes)..."
  if [[ -f docker-compose.override.yml ]]; then
    $DC -f docker-compose.yml -f docker-compose.override.yml -f components/serverless/docker-compose.serverless.yml down 2>/dev/null || true
  else
    $DC -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml down 2>/dev/null || true
  fi
  green "  旧容器已停止"
fi

# ---------- 准备环境变量 ----------
step 3 "Configuring environment (.env)..."

if [[ ! -f .env ]]; then
  yellow "  .env 不存在，从 .env.example 拷贝一份"
  cp .env.example .env
  chmod 640 .env

  # 从 hostname 推导 CVAT_HOST 建议
  SUGGESTED_HOST=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [[ -z "$SUGGESTED_HOST" ]]; then SUGGESTED_HOST="localhost"; fi

  green "  ⚠️  请务必编辑 .env，设置至少以下变量："
  echo "    - CVAT_HOST (建议: $SUGGESTED_HOST 或你的公网域名)"
  echo "    - 如在代理后: HTTP_PROXY / HTTPS_PROXY / NO_PROXY / no_proxy"
  echo "    - 管理员: DJANGO_SUPERUSER_USERNAME / DJANGO_SUPERUSER_PASSWORD"
  read -rp "  现在编辑 .env 吗？（回车=稍后手动改，其他键用 nano 打开） " EDIT_NOW
  if [[ -n "$EDIT_NOW" ]]; then
    if command -v nano &>/dev/null; then nano .env
    elif command -v vi &>/dev/null; then vi .env
    else yellow "  未找到 nano/vi，跳过编辑"; fi
  fi
else
  green "  .env 已存在，保留原样"
fi

# docker-compose.override.yml 是「可选的」：
#   - 如果用户已有 override: 保持原样
#   - 如果没有，且 example 里存在 "实际激活的非注释 services": 就拷贝
#   - 如果没有，且 example 基本是注释片段（官方风格）: 不拷贝，避免 compose schema 校验报错
#     (典型报错: services.clickhouse must be a mapping)
if [[ -f docker-compose.override.yml ]]; then
  green "  docker-compose.override.yml 已存在，保留原样"
elif [[ -f docker-compose.override.yml.example ]]; then
  # 去掉注释和空行后，再判断是否有实际激活的 services.* 字段
  ACTIVE_SVC_COUNT=$(grep -vE '^\s*#' docker-compose.override.yml.example \
    | grep -vE '^\s*$' \
    | grep -cE '^\s{0,2}services:|^\s{2,4}[A-Za-z0-9_-]+:' || true)
  if [[ "${ACTIVE_SVC_COUNT:-0}" -ge 3 ]]; then
    yellow "  docker-compose.override.yml 不存在，example 里检测到激活配置，拷贝一份（可按需改）"
    cp docker-compose.override.yml.example docker-compose.override.yml || true
  else
    yellow "  docker-compose.override.yml.example 以注释示例为主，不自动拷贝（避免 compose 校验报错）"
    echo "    如需自定义：cp docker-compose.override.yml.example docker-compose.override.yml && nano docker-compose.override.yml"
  fi
fi

# ---------- 构建自定义镜像 ----------
if [[ $SKIP_BUILD -eq 1 ]]; then
  step 4 "[SKIP] Docker image build"
  yellow "  使用 --skip-build，跳过 cvat_server / cvat_ui 构建"
else
  step 4 "Building custom images (cvat_server, cvat_ui)..."

  # 构建用的 compose 文件组合：build 段只在 docker-compose.dev.yml 里有
  BUILD_COMPOSE_ARG="-f docker-compose.yml"
  if [[ -f docker-compose.dev.yml ]]; then
    BUILD_COMPOSE_ARG="$BUILD_COMPOSE_ARG -f docker-compose.dev.yml"
  else
    red "  docker-compose.dev.yml 缺失！无法 build。确认打包完整？"
    exit 1
  fi

  # 预检查: 本机是否已有基础镜像（支持离线环境）
  NEED_IMAGES=(
    "ubuntu:24.04"                                       # Dockerfile BASE_IMAGE
    "golang:1.26.5"                                      # Dockerfile build-smokescreen
    "node:lts-slim"                                      # Dockerfile.ui stage 1
    "nginxinc/nginx-unprivileged:1.31.2-alpine3.23-slim" # Dockerfile.ui stage 2
    "ubuntu:22.04"                                       # Nuclio qwen37-detector baseImage
  )
  MISSING=""
  for img in "${NEED_IMAGES[@]}"; do
    if ! docker image inspect "$img" &>/dev/null; then
      MISSING="$MISSING $img"
    fi
  done
  if [[ -n "$MISSING" ]]; then
    yellow "  以下构建/函数所需的基础镜像本地不存在，构建时将尝试拉取（若无外网需先 docker load）:"
    echo "    $MISSING"
    yellow "  离线镜像加载命令参考（需先把 tar 传到服务器 /tmp/cvat-images/ ）:"
    echo '    for tar in /tmp/cvat-images/*.tar; do echo ">> $tar"; docker load -i "$tar"; done'
  fi

  # 兼容 DOCKER_BUILDKIT 元镜像拉取弱网问题（一定要关）
  export DOCKER_BUILDKIT=0

  # 从 .env 读取代理变量并 build-arg 传递（Dockerfile 里声明了 ARG http_proxy/https_proxy/no_proxy）
  BUILD_PROXY_ARGS=""
  if [[ -f .env ]]; then
    # shellcheck disable=SC1091
    PROXY_ENV=$(set -a; source .env &>/dev/null; set +a; printf "%s\n%s\n%s\n%s" \
      "${http_proxy:-}" "${https_proxy:-}" "${no_proxy:-}" "${socks_proxy:-}")
    P_HTTP=$(echo "$PROXY_ENV" | sed -n '1p')
    P_HTTPS=$(echo "$PROXY_ENV" | sed -n '2p')
    P_NO=$(echo "$PROXY_ENV" | sed -n '3p')
    P_SOCKS=$(echo "$PROXY_ENV" | sed -n '4p')
    [[ -n "$P_HTTP"  ]] && BUILD_PROXY_ARGS="$BUILD_PROXY_ARGS --build-arg http_proxy=$P_HTTP"
    [[ -n "$P_HTTPS" ]] && BUILD_PROXY_ARGS="$BUILD_PROXY_ARGS --build-arg https_proxy=$P_HTTPS"
    [[ -n "$P_NO"    ]] && BUILD_PROXY_ARGS="$BUILD_PROXY_ARGS --build-arg no_proxy=$P_NO"
    [[ -n "$P_SOCKS" ]] && BUILD_PROXY_ARGS="$BUILD_PROXY_ARGS --build-arg socks_proxy=$P_SOCKS"
  fi

  yellow "  构建 cvat/server ... (可 5-30 分钟，离线镜像齐全则快很多)"
  # shellcheck disable=SC2086
  $DC $BUILD_COMPOSE_ARG build $BUILD_PROXY_ARGS cvat_server 2>&1 | tail -20
  if [[ $? -ne 0 ]]; then
    red "  cvat/server 构建失败！请检查上方 20 行日志判断是缺少哪个依赖镜像"
    unset DOCKER_BUILDKIT
    exit 1
  fi

  yellow "  构建 cvat/ui ... (可 5-30 分钟)"
  # shellcheck disable=SC2086
  $DC $BUILD_COMPOSE_ARG build $BUILD_PROXY_ARGS cvat_ui 2>&1 | tail -20
  if [[ $? -ne 0 ]]; then
    red "  cvat/ui 构建失败！请检查上方 20 行日志"
    unset DOCKER_BUILDKIT
    exit 1
  fi
  unset DOCKER_BUILDKIT

  # 构建完立刻验证镜像存在
  for tag in "cvat/server:dev" "cvat/ui:dev"; do
    if ! docker image inspect "$tag" &>/dev/null; then
      red "  构建结束但 $tag 镜像不存在！检查上面的 build 输出"
      exit 1
    fi
  done
  green "  自定义镜像构建完成（cvat/server:dev + cvat/ui:dev）"
fi

# ---------- 启动服务 ----------
step 5 "Starting CVAT services..."

COMPOSE_FILES_ARG="-f docker-compose.yml"
if [[ -f docker-compose.override.yml ]]; then
  COMPOSE_FILES_ARG="$COMPOSE_FILES_ARG -f docker-compose.override.yml"
fi
if [[ $NO_SERVERLESS -eq 0 ]]; then
  COMPOSE_FILES_ARG="$COMPOSE_FILES_ARG -f components/serverless/docker-compose.serverless.yml"
fi

# shellcheck disable=SC2086
$DC $COMPOSE_FILES_ARG up -d 2>&1 | tail -10
green "  启动指令已发送，等待服务就绪（建议等 30-60s）..."

# 等 DB 就绪再跑迁移
sleep 15
attempt=0
while ! $DC exec -T cvat_db pg_isready -U root -d cvat &>/dev/null; do
  attempt=$((attempt+1))
  if [[ $attempt -gt 30 ]]; then
    red "  cvat_db 30s 内未就绪，跳过自动迁移，请手动: docker compose run --rm cvat_server python manage.py migrate"
    break
  fi
  echo -n "."
  sleep 2
done
echo ""

# 执行数据库迁移（重要：新增了 0003_bailiansettings）
step 5a "Running Django migrations (0003_bailiansettings MUST succeed)..."
# shellcheck disable=SC2086
$DC run --rm cvat_server python manage.py migrate 2>&1 | tail -30 || true
green "  迁移完成（请确认无红色报错）"

# ---------- Nuclio 函数部署 ----------
if [[ $NO_SERVERLESS -eq 1 ]]; then
  step 6 "[SKIP] Nuclio & serverless (--no-serverless)"
elif [[ $SKIP_NUCLIO -eq 1 ]]; then
  step 6 "[SKIP] Nuclio function deploy (--skip-nuclio)"
else
  step 6 "Deploying Nuclio function: qwen37-detector..."

  # 检查 nuctl
  if command -v nuctl &>/dev/null; then
    NUCTL=nuctl
  elif [[ -x "$HOME/nuctl" ]]; then
    NUCTL="$HOME/nuctl"
  else
    yellow "  未找到 nuctl CLI，跳过函数部署。"
    yellow "  安装 nuctl: curl -s https://api.github.com/repos/nuclio/nuclio/releases/latest \\"
    echo "    | jq -r '.assets[] | select(.name | endswith(\"linux_amd64\")) | .browser_download_url' \\"
    echo "    | xargs curl -L -o /usr/local/bin/nuctl && chmod +x /usr/local/bin/nuctl"
    yellow "  装好后手动执行:"
    cat <<EOF
    cd serverless/qwen/bailian/qwen37-detector/nuclio
    sudo DOCKER_BUILDKIT=0 $NUCTL deploy --project-name cvat --path . --file function.yaml \
      --platform local --platform-config '{"attributes":{"network":"cvat_cvat"}}'
EOF
  fi

  if [[ -n "${NUCTL:-}" ]]; then
    yellow "  等待 Nuclio dashboard 启动..."
    sleep 10
    # 检查函数容器构建所需的基础镜像
    if ! docker image inspect ubuntu:22.04 &>/dev/null; then
      yellow "  ubuntu:22.04 不在本地，构建时将尝试拉取"
    fi

    pushd serverless/qwen/bailian/qwen37-detector/nuclio &>/dev/null

    # 构造 env 参数
    NUCTL_ENV_ARGS=()
    if [[ -n "$BAILIAN_API_KEY" ]]; then
      NUCTL_ENV_ARGS+=(--env "BAILIAN_API_KEY=$BAILIAN_API_KEY")
    fi
    if [[ -n "$BAILIAN_API_URL" ]]; then
      NUCTL_ENV_ARGS+=(--env "BAILIAN_API_URL=$BAILIAN_API_URL")
    fi
    if [[ -n "$BAILIAN_MODEL" ]] && [[ "$BAILIAN_MODEL" != "qwen3-vl-plus" ]]; then
      NUCTL_ENV_ARGS+=(--env "BAILIAN_MODEL=$BAILIAN_MODEL")
    fi

    yellow "  执行 nuctl deploy ... (可 3-15 分钟)"
    # shellcheck disable=SC2086
    sudo DOCKER_BUILDKIT=0 "$NUCTL" deploy \
      --project-name cvat \
      --path . \
      --file function.yaml \
      --platform local \
      --platform-config '{"attributes":{"network":"cvat_cvat"}}' \
      "${NUCTL_ENV_ARGS[@]}" 2>&1 | tail -30 || \
      { yellow "  nuctl deploy 返回非 0，但函数可能已经部署，后面去 UI 验证。"; }

    popd &>/dev/null

    # 把函数容器加入 cvat_cvat 网络（兜底，防止 platform-config 未生效）
    sleep 5
    FUNC_CONTAINER=$(docker ps -a --filter "name=nuclio-nuclio-qwen" --format "{{.Names}}" | head -1)
    if [[ -n "$FUNC_CONTAINER" ]]; then
      if ! docker network inspect cvat_cvat --format '{{json .Containers}}' 2>/dev/null | grep -q "$FUNC_CONTAINER"; then
        docker network connect cvat_cvat "$FUNC_CONTAINER" 2>/dev/null || true
        yellow "  已手动将 $FUNC_CONTAINER 接入 cvat_cvat 网络"
      fi
    fi
  fi
fi

# ---------- 健康检查摘要 ----------
step 7 "Health summary..."

sleep 5
echo ""
cyan "=== 容器状态 ==="
# shellcheck disable=SC2086
$DC $COMPOSE_FILES_ARG ps 2>/dev/null || true

CVAT_HOST_VAL=$(grep -E '^CVAT_HOST=' .env 2>/dev/null | cut -d= -f2- | tr -d '\r' || echo "localhost")
if [[ -z "$CVAT_HOST_VAL" || "$CVAT_HOST_VAL" == "localhost" ]]; then
  SUGGESTED_HOST=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [[ -n "$SUGGESTED_HOST" ]]; then
    yellow "  建议: .env 中 CVAT_HOST 目前是 '$CVAT_HOST_VAL'，改成 '$SUGGESTED_HOST' 或域名才能被浏览器访问"
  fi
fi

echo ""
cyan "========================================"
green " 部署流程已跑完！"
cyan "========================================"

cat <<EOF

接下来请按顺序完成：

  1. 访问 CVAT UI:
       http://${CVAT_HOST_VAL}:8080/
     (如 UI 空白或 404/502，先等 30s 再刷新；若仍报错: docker logs cvat_ui --tail 30 ; docker logs traefik --tail 30)

  2. 管理员首次登录:
       账号: DJANGO_SUPERUSER_USERNAME  (如 .env 里配了)
       密码: DJANGO_SUPERUSER_PASSWORD
     没配超管就用注册按钮创建第一个账号，它会是 owner。

  3. 验证百炼配置模型已生效:
       Admin 登录 → 进入默认 Organization → 顶部菜单 Organization → Bailian settings
       → 填入 API URL / Model / API Key → Save
       → 去 Models 页面刷新，确认看到 "Qwen Bailian 3.7 Detector"

  4. Nuclio 函数检查（如开启了 serverless）:
       docker ps -a | grep nuclio
       # 检查已在 cvat_cvat 网络:
       docker network inspect cvat_cvat | grep nuclio

  5. 常见报错快速定位:
       502 Bad Gateway       →  docker logs traefik --tail 50
                                → 确认 cvat_ui / cvat_server 都在 cvat_cvat 网络
       Models 页面空白        →  docker ps -a | grep nuclio ; sudo nuctl get function --platform local
       自动标注无结果/失败     →  docker logs cvat_worker_annotation --tail 50
                                → Requests 页面查看状态
       OPAHealthCheck 500    →  docker restart cvat_opa cvat_server

EOF

if [[ -f DEPLOY_MANIFEST.txt ]]; then
  echo ""
  cyan "打包清单见: $(pwd)/DEPLOY_MANIFEST.txt"
fi
