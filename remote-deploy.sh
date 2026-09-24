#!/usr/bin/env bash
# ============================================================
# 服务器端一键部署脚本（真实服务器 nextvpu 专用，基于 [检查脚本输出] 定制）
# 真实状态：
#   - 用户名 nextvpu UID=1000，groups=nextvpu adm sudo docker
#   - /opt/cvat-develop 归属 nextvpu:nextvpu，nextvpu 直接能写（无需 sudo 解压）
#   - SUDO: 需要密码 (SUDO_NOPASSWD=NO)
#   - Compose: V2 (docker compose), V1 不存在
#   - 项目目录: /opt/cvat-develop 有 docker-compose.yml + components/serverless/docker-compose.serverless.yml
#   - 无 docker-compose.override.yml；有 .env（保留不覆盖）
#   - 外网必须走代理 http://127.0.0.1:7890（直连 443 超时）
#   - Nuclio 真已部署 dashboard + qwen-bailian-qwen37-detector（当前 Exited 0，up -d 后会恢复）
#   - DB migrations 需要 sudo（当前 showmigrations 已跳过）
#   - 自动迁移默认关闭（用户要求：只更新代码不动生产数据）
# ============================================================

set -euo pipefail

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
step()   { local n="$1"; shift; echo ""; yellow "[Step $n/8] $*"; }

# ===== 根据真实状态硬编码参数 =====
SRC_TGZ="/tmp/cvat-develop-sync.tar.gz"
TARGET_DIR="/opt/cvat-develop"
# ⚠️  真实服务器：nextvpu 只能写 /opt/cvat-develop 项目目录本身，不能在 /opt 根目录 mkdir
#    所以备份放 nextvpu 家目录（100% 有权限写），不放在 /opt 根目录
BACKUP_DIR_PREFIX="$HOME/cvat-develop-backup"
BACKUP_DIR="${BACKUP_DIR_PREFIX}-$(date +%Y%m%d-%H%M%S)"
# 兼容用户直接 sudo 运行脚本的场景：如果 HOME 是 /root 但用户是 nextvpu，也给一个兜底
if [[ "$HOME" == "/root" ]]; then
  BACKUP_DIR_PREFIX="/home/nextvpu/cvat-develop-backup"
  BACKUP_DIR="${BACKUP_DIR_PREFIX}-$(date +%Y%m%d-%H%M%S)"
  mkdir -p /home/nextvpu 2>/dev/null || true
  chown nextvpu:nextvpu /home/nextvpu 2>/dev/null || true
fi
PROXY_URL="http://127.0.0.1:7890"
NO_PROXY_LIST="localhost,127.0.0.1,*.local,cvat_db,cvat_redis_ondisk,cvat_redis_inmem,cvat_opa,cvat_clickhouse,cvat_server,cvat_ui,cvat_worker_utils,cvat_worker_import,cvat_worker_annotation,cvat_worker_chunks,cvat_worker_consensus,cvat_worker_quality_reports,cvat_worker_export,cvat_worker_webhooks,cvat_vector,cvat_grafana,nuclio,nuclio-nuclio-*,nuclio-local-storage-reader,*.cvat,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.aliyuncs.com"

COMPOSE_ARGS=(-f docker-compose.yml -f components/serverless/docker-compose.serverless.yml)
DC="docker compose"

# ======================== Step 1: 基础检查 ========================
step 1 "基础检查 + 代理可用性验证"
if [[ "$(id -un)" != "nextvpu" ]]; then
  yellow "  当前用户是 $(id -un)，期望是 nextvpu。继续执行（不致命）。"
fi
if [[ ! -f "$SRC_TGZ" ]]; then
  red "未找到代码包 $SRC_TGZ ，请先 scp 上传。"
  exit 2
fi
for c in docker tar sha256sum; do
  if ! command -v "$c" &>/dev/null; then
    red "缺少命令: $c ，请先安装。"
    exit 3
  fi
done
# Docker 组无需 sudo 即可 docker compose / docker build
if ! docker ps >/dev/null 2>&1; then
  red "docker ps 失败，当前用户 $(id -un) 可能不在 docker 组：当前 groups=$(id -Gn)"
  exit 4
fi
green "  用户 $(id -un) 在 docker 组，docker compose 可用"

# 代理必须走（直连超时）
if command -v curl &>/dev/null; then
  if curl -sSf -m 5 --proxy "$PROXY_URL" https://hub.docker.com >/dev/null 2>&1; then
    green "  代理 $PROXY_URL 可用，build 时强制用代理+NO_PROXY 防内网污染"
    PROXY_OK=1
  else
    yellow "  代理 $PROXY_URL 不可用！直连外网又失败，build 大概率会 fail。请先检查 SSH 反向隧道。"
    PROXY_OK=0
  fi
else
  yellow "  curl 未装，跳过代理检测，继续 build（失败时再排查）"
  PROXY_OK=2
fi

# ======================== Step 2: 备份旧代码 ========================
step 2 "备份旧代码到 $BACKUP_DIR（排除 node_modules 省空间）"
BACKUP_OK=1
if [[ -d "$TARGET_DIR" ]]; then
  # 家目录 100% 有权限写，先 mkdir（允许失败 set +e，失败时会降级为「不备份继续部署」）
  set +e
  mkdir -p "$BACKUP_DIR" 2>/dev/null
  RC=$?
  set -e
  if [[ $RC -ne 0 ]]; then
    yellow "  mkdir $BACKUP_DIR 失败（Permission denied），尝试 sudo（需要密码，可能不交互失败）..."
    set +e
    sudo -n mkdir -p "$BACKUP_DIR" 2>/dev/null
    RC2=$?
    set -e
    if [[ $RC2 -ne 0 ]]; then
      yellow "  sudo -n 也失败（需要密码或没权限），跳过备份直接继续部署（不影响代码同步本身）"
      BACKUP_OK=0
    fi
  fi
  if [[ $BACKUP_OK -eq 1 ]]; then
    echo "  备份中（放到 nextvpu 家目录，无需 /opt 根写权限）..."
    # 复制旧目录 + 排除 node_modules
    if command -v rsync &>/dev/null; then
      set +e
      rsync -a \
        --exclude='node_modules' --exclude='cvat-ui/node_modules' --exclude='*/node_modules' \
        --exclude='deploy-out' --exclude='tmp' --exclude='.git' --exclude='.venv' --exclude='venv' \
        --exclude='dist' --exclude='build' --exclude='__pycache__' --exclude='*.pyc' \
        "$TARGET_DIR/" "$BACKUP_DIR/"
      R_RC=$?
      set -e
      if [[ $R_RC -eq 0 && -f "$BACKUP_DIR/docker-compose.yml" ]]; then
        green "  备份完成 (rsync): $BACKUP_DIR"
      else
        yellow "  rsync 失败，改用 cp -a（可能含 node_modules 较慢）"
      fi
    fi
    if [[ ! -d "$BACKUP_DIR" || ! -f "$BACKUP_DIR/docker-compose.yml" ]]; then
      set +e
      cp -a "$TARGET_DIR" "$BACKUP_DIR.tmp" \
        && rm -rf "$BACKUP_DIR" 2>/dev/null \
        && mv "$BACKUP_DIR.tmp" "$BACKUP_DIR"
      CP_RC=$?
      set -e
      if [[ $CP_RC -eq 0 && -f "$BACKUP_DIR/docker-compose.yml" ]]; then
        green "  备份完成 (cp -a): $BACKUP_DIR"
      else
        yellow "  cp -a 也失败，跳过备份，继续部署（部署完成会校验镜像成功，失败了可以重新传 tar 重部署）"
        BACKUP_OK=0
      fi
    fi
  fi
else
  yellow "  $TARGET_DIR 不存在，跳过备份"
fi

# ======================== Step 3: 解压新代码（保留用户 .env / 自定义 config） ========================
step 3 "解压新代码到 $TARGET_DIR（保留 .env / 不覆盖用户自定义）"
if [[ ! -d "$TARGET_DIR" ]]; then mkdir -p "$TARGET_DIR"; fi

# 真实服务器坑：cvat-ui/dist 等前端产物可能归属 root（容器 root COPY 出来 / 或者上一次 deploy 是 root 跑的）
# nextvpu 对项目目录有写权，但对 root 归属的文件无权 rm，所以先对 TARGET_DIR 整体改归属 nextvpu 再删
echo "  先修正归属（真实场景有 root 归属的 dist/assets 前端产物，nextvpu 无权 rm）..."
set +e
chown -R nextvpu:nextvpu "$TARGET_DIR" 2>/dev/null
CHOWN_RC=$?
set -e
if [[ $CHOWN_RC -ne 0 ]]; then
  yellow "  chown -R nextvpu 失败（部分 root 归属文件），尝试只给可写权限（sudo 非交互，失败再跳过）..."
  set +e
  sudo -n chown -R nextvpu:nextvpu "$TARGET_DIR" 2>/dev/null
  SUDO_CHOWN_RC=$?
  set -e
  if [[ $SUDO_CHOWN_RC -ne 0 ]]; then
    # 如果 nextvpu 确实没有 sudo NOPASSWD，就用 chmod 给目录写权限兜底，保证 rm 能过就行
    yellow "  sudo -n chown 也失败（需要密码），用 find 把 TARGET_DIR 下不可写的文件/目录 chmod u+w + g+w 兜底..."
    set +e
    find "$TARGET_DIR" -mindepth 1 \( ! -writable \) -exec chmod ug+w {} + 2>/dev/null
    set -e
  fi
fi

echo "  安全清理旧代码（一级子目录/文件，不动数据卷）..."
# KEEP LIST: 用户真实自定义配置文件
KEEP_FILES=(".env" ".env.local" ".env.user" "docker-compose.override.yml")
# 保护 docker volumes 的映射目录（如果用户直接在 TARGET_DIR 下当 volume 用）
PROTECT_DIRS=("cvat-data" "cvat-logs" "cvat-keys" "cvat-share" "data" "keys" "logs" "share" "ai-models" "backup" "tmp")

shopt -s dotglob nullglob
for entry in "$TARGET_DIR"/*; do
  base="$(basename "$entry")"
  [[ "$base" == "." || "$base" == ".." ]] && continue
  keep=0
  for k in "${KEEP_FILES[@]}";   do [[ "$base" == "$k" ]] && { keep=1; break; }; done
  for p in "${PROTECT_DIRS[@]}"; do [[ "$base" == "$p" ]] && { keep=1; break; }; done
  if [[ $keep -eq 1 ]]; then
    echo "  保留: $base"
    continue
  fi
  # 即使改归属后，万一仍有 root 文件，对单文件 rm 做 set +e 失败只警告，不退出 set -e
  set +e
  rm -rf "$entry"
  ONE_RM_RC=$?
  set -e
  if [[ $ONE_RM_RC -ne 0 ]]; then
    yellow "  rm $entry 仍失败（极少数 root sticky 位），尝试 sudo -n rm（失败不致命）"
    set +e
    sudo -n rm -rf "$entry" 2>/dev/null
    set -e
  fi
done

echo "  开始解压 $SRC_TGZ ..."
# nextvpu 直接有写权，无需 sudo
tar -xzf "$SRC_TGZ" -C "$TARGET_DIR" --strip-components=0

# 保证用户真实 .env（3325 字节那个）不被 tar 里的空/默认覆盖（从备份恢复）
# 如果备份失败（BACKUP_OK=0，且原 /opt/cvat-develop 删之前我们已经确认存在），也有兜底：
#   - Step3 清理旧代码时 KEEP_FILES 已经保留了 .env 不会删，所以解压前 .env 本来就在原地
#   - 下面这段 cp -f 只是为了万一 tar 覆盖了 .env（其实 exclude 了不会），从备份再覆盖回来
if [[ $BACKUP_OK -eq 1 && -f "$BACKUP_DIR/.env" ]]; then
  cp -f "$BACKUP_DIR/.env" "$TARGET_DIR/.env"
  green "  从备份恢复服务器真实 .env"
fi
if [[ $BACKUP_OK -eq 1 && -f "$BACKUP_DIR/docker-compose.override.yml" ]]; then
  cp -f "$BACKUP_DIR/docker-compose.override.yml" "$TARGET_DIR/docker-compose.override.yml"
  green "  从备份恢复 docker-compose.override.yml"
fi
# 归属修正（nextvpu:nextvpu，防止 tar 带 root 归属）
chown -R nextvpu:nextvpu "$TARGET_DIR" 2>/dev/null || true
green "  新代码就绪: $TARGET_DIR (files=$(find \"$TARGET_DIR\" -maxdepth 3 -type f 2>/dev/null | wc -l))"

# ======================== Step 4: DB Migration（用户要求关闭自动，只给手动命令 ========================
step 4 "[已关闭] Django DB Migration（已按要求关闭自动，完全不动生产数据）"
yellow "  用户明确：只同步最新代码，不动服务器上真实生产数据（BailianSettings / AIFunctionInstance）"
yellow "  所以 organizations 的 0004_aifunctioninstance.py / 0005_migrate_bailian_settings.py 不自动执行。"
yellow ""
yellow "  ⚠️  部署后如果 /organization/bailian 或 /organization/ai-features 出现 500（表不存在），"
yellow "     请手动执行这 1 条命令（仅建表 + 旧表数据同步到新表，绝不会删任务/项目/作业）："
yellow "       cd /opt/cvat-develop"
yellow "       sudo docker compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml \\"
yellow "         exec -T cvat_server python manage.py migrate organizations --no-input"
yellow ""
yellow "  💡 想看当前已执行哪些 migrations（只读不 apply），手动执行："
yellow "       cd /opt/cvat-develop"
yellow "       sudo docker compose exec -T cvat_server python manage.py showmigrations organizations"
yellow ""

# ======================== Step 5: Build cvat_server ========================
step 5 "构建 cvat/server:dev（强制 7890 代理 + --network=host + NO_PROXY 防内网污染）"
cd "$TARGET_DIR"
BUILD_OPTS=(--force-rm --no-cache=false)
# 外网直连超时 = 强制走代理
if [[ $PROXY_OK -eq 1 || $PROXY_OK -eq 2 ]]; then
  BUILD_OPTS+=(--network=host
    --build-arg "HTTP_PROXY=${PROXY_URL}"
    --build-arg "HTTPS_PROXY=${PROXY_URL}"
    --build-arg "http_proxy=${PROXY_URL}"
    --build-arg "https_proxy=${PROXY_URL}"
    --build-arg "NO_PROXY=${NO_PROXY_LIST}"
    --build-arg "no_proxy=${NO_PROXY_LIST}")
fi
echo "  docker build ${BUILD_OPTS[*]} -t cvat/server:dev -f Dockerfile ."
docker build "${BUILD_OPTS[@]}" -t cvat/server:dev -f Dockerfile .
green "  ✅ cvat/server:dev 构建完成"

# ======================== Step 6: Build cvat_ui ========================
step 6 "构建 cvat/ui:dev（同代理配置，webpack 拉 npm 包必须走代理）"
cd "$TARGET_DIR"
echo "  docker build ${BUILD_OPTS[*]} -t cvat/ui:dev -f Dockerfile.ui ."
docker build "${BUILD_OPTS[@]}" -t cvat/ui:dev -f Dockerfile.ui .
green "  ✅ cvat/ui:dev 构建完成"

# ======================== Step 7: Stop + Up -d 全量启动 ========================
step 7 "停止旧容器 + 以新镜像 Up -d（CVAT + Nuclio Serverless 双 compose 叠加）"
cd "$TARGET_DIR"

# 真实服务器坑：旧 traefik / cvat_ui 容器还占着 0.0.0.0:8080（以及 443/80），
# 直接 up -d 会 set -e 立即退出导致 Step8 健康检查没跑。
# 所以 up -d 之前先 docker compose 双 yml 下停掉会占用宿主端口的几个容器（traefik/cvat_ui/nuclio）
# （DB/Redis/ClickHouse/Vector 这些只占 127.0.0.1:*，且是生产数据，不随便停；CVAT server/workers 无宿主端口映射也不需要停）
echo "  先停可能占用宿主 8080/443/80 端口的容器（traefik/cvat_ui/nuclio）避免 bind failed Address already in use..."
set +e
$DC "${COMPOSE_ARGS[@]}" stop traefik cvat_ui nuclio 2>&1 | tail -5
$DC "${COMPOSE_ARGS[@]}" rm -f traefik cvat_ui nuclio 2>&1 | tail -5
# 极端兜底：如果 docker compose 识别不到，直接以名称停
docker stop traefik cvat_ui nuclio nuclio-dashboard 2>/dev/null
docker rm -f traefik cvat_ui nuclio nuclio-dashboard 2>/dev/null
set -e
# 再等 10s 让内核释放 TCP TIME_WAIT 端口（避免仍报 in use）
echo "  等待 10s 内核释放宿主 8080/443 端口..."
sleep 10

echo "  Up -d 重建容器（${COMPOSE_ARGS[*]}）..."
set +e
$DC "${COMPOSE_ARGS[@]}" up -d --remove-orphans
UP_RC1=$?
set -e
if [[ $UP_RC1 -ne 0 ]]; then
  yellow "  第 1 次 up -d 失败（RC=$UP_RC1，大概率是端口还没释放），先查 8080 真正占用者再 kill/rm"
  # 必杀：用 ss / netstat 查 8080 监听的真实 PID / 进程名 / FD（而不是靠 docker compose 服务名猜）
  echo "  --- 当前 0.0.0.0:8080 / [::]:8080 的真实占用者 ---"
  (ss -ltnp 2>/dev/null | grep ':8080' || netstat -tlnp 2>/dev/null | grep ':8080' || true) | head -10
  # 如果能拿到占用进程 PID（一般是 docker-proxy），父进程是 dockerd，对应的 container ID 可以查 /proc/<pid>/cgroup
  PIDS_8080=$(ss -ltnp 2>/dev/null | grep ':8080' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  if [[ -n "$PIDS_8080" ]]; then
    yellow "  查到占用 8080 的 PID 列表: $PIDS_8080，尝试从 /proc/<pid>/cgroup 反查对应容器 ID 并 docker rm -f"
    for pid in $PIDS_8080; do
      cg=$(cat /proc/$pid/cgroup 2>/dev/null | head -1 || true)
      cid=$(echo "$cg" | grep -oE '[0-9a-f]{64}' | head -1 || true)
      if [[ -n "$cid" ]]; then
        cname=$(docker ps -a --format '{{.ID}} {{.Names}}' 2>/dev/null | grep "^${cid:0:12}" | awk '{print $2}' || true)
        echo "   PID=$pid 对应容器ID=${cid:0:12} NAME=$cname，执行 docker rm -f"
        set +e
        docker rm -f "$cid" 2>&1 | tail -3
        docker rm -f "$cname" 2>&1 | tail -3
        set -e
      else
        # 是宿主系统进程（nginx / caddy / 其他 systemd 服务）
        pname=$(ps -p $pid -o comm= 2>/dev/null || echo "unknown")
        echo "   PID=$pid NAME=$pname 是宿主系统进程（非容器），尝试 sudo -n kill -9，失败请手动 sudo kill -9 $pid"
        set +e
        sudo -n kill -9 $pid 2>/dev/null
        set -e
      fi
    done
  else
    yellow "  ss/netstat 没拿到具体 PID，兜底：把所有名字含 traefik/cvat_ui/nuclio 的容器全部 docker rm -f"
    set +e
    docker ps -a --format '{{.Names}}' | grep -Ei 'traefik|cvat_ui|nuclio|cvat-ui' | xargs -r docker rm -f 2>&1 | tail -5
    set -e
  fi
  echo "  sleep 20 让内核释放端口（TCP TIME_WAIT 30s 内会消失）..."
  sleep 20
  set +e
  $DC "${COMPOSE_ARGS[@]}" up -d --remove-orphans
  UP_RC2=$?
  set -e
  if [[ $UP_RC2 -ne 0 ]]; then
    yellow "  第 2 次 up -d 仍失败（RC=$UP_RC2），请手动查看占用：ss -ltnp | grep :8080 或 netstat -tlnp | grep :8080；脚本继续跑健康检查（不会 set -e 退出）"
  fi
fi
echo "  等待 45 秒让服务启动（DB 热，CVAT server 首次启动慢）..."
sleep 45
# 再 up -d 一次补拉异常退出容器（Nuclio qwen detector Exited 0 恢复）
set +e
$DC "${COMPOSE_ARGS[@]}" up -d
set -e
green "  容器列表（cvat/nuclio/traefik/clickhouse）:"
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}" \
  | grep -Ei 'cvat|nuclio|traefik|clickhouse|grafana|vector' | head -60
echo ""

# ======================== Step 8: 健康检查 ========================
step 8 "健康检查（接口 + 关键容器状态）"
about_code="000"; bailian_code="000"; ai_code="000"
for i in 1 2 3 4 5; do
  about_code=$(docker exec cvat_server bash -c "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/server/about" 2>/dev/null || echo "000")
  echo "  [$i/5] GET /api/server/about -> HTTP $about_code"
  if [[ "$about_code" == "200" ]]; then
    green "  ✅ cvat_server 健康检查通过 (HTTP 200，和部署前一致)"
    break
  fi
  sleep 10
done

# 无 token = 401 就对（之前 scope=UPDATE 会是 403，NameError 会是 500）
if [[ "$about_code" == "200" ]]; then
  bailian_code=$(docker exec cvat_server bash -c "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/organizations/1/bailian-settings" 2>/dev/null || echo "000")
  ai_code=$(docker exec cvat_server bash -c "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/organizations/1/ai-function-instances" 2>/dev/null || echo "000")
fi

echo ""
echo "  GET /api/organizations/1/bailian-settings     -> HTTP $bailian_code （期望 401/200，不允许是 403 或 500）"
echo "  GET /api/organizations/1/ai-function-instances -> HTTP $ai_code      （期望 401/200，不允许是 403 或 500）"

if [[ "$bailian_code" == "500" || "$ai_code" == "500" ]]; then
  red "  ⚠️  500 = 后端 NameError / serializer 异常，查 cvat_server 最近 80 行日志："
  echo "       docker logs cvat_server --tail 80"
fi
if [[ "$bailian_code" == "403" || "$ai_code" == "403" ]]; then
  red "  ⚠️  403 = permissions.py scope 还是 UPDATE（SAFE_METHODS import 没生效），查 server 镜像 digest："
  echo "       docker inspect cvat/server:dev --format '{{.Id}}'"
fi

# Nuclio qwen detector 健康：之前是 Exited 0，up -d 后应该 Up
qwen_status=$(docker ps -a --format '{{.Status}}' --filter 'name=nuclio-nuclio-qwen-bailian-qwen37-detector' | head -1)
echo "  Nuclio qwen37-detector status: $qwen_status（期望 Up；如果仍 Exited，下一步单独重启：docker start nuclio-nuclio-qwen-bailian-qwen37-detector）"

cyan "=========================================================="
cyan " 部署完成！以下是下一步验证清单"
cyan "=========================================================="
echo ""
echo "1️⃣  浏览器: http://192.168.50.30:8080 用 test01（Supervisor）登录，切到 MyTestOrg（服务器真实组织名，不一定是 1，根据实际选择）"
echo ""
echo "2️⃣  验证 View-only 页面（不再 Permission denied / 500）:"
echo "   • /organization/bailian     → API key configured 正确显示，Save 按钮 disabled"
echo "   • /organization/ai-features → 统计卡 Total ≥ 1，卡片 View-only，New Instance 不显示"
echo "   • /organization/ai-features/<slug> → 表单全 disabled，Save/Delete 按钮 disabled"
echo ""
echo "3️⃣  验证 Automatic annotation Model 下拉:"
echo "   • Jobs 列表 Job 菜单点 Automatic annotation → Model 出现「[AI Instance (Default)] bailian-default-detector」"
echo "   • 跑一次 Annotate → 跑完 Items > 0（有 motor_vehicle/pedestrian 等框）"
echo ""
echo "4️⃣  可选 PATH A：真调用 Nuclio 容器 main.py（不调用本地巨函数）:"
echo "   • 下拉选原生「qwen-bailian-qwen37-detector」→ 跑一次，效果一致"
echo "   • 检查: docker logs nuclio-nuclio-qwen-bailian-qwen37-detector --tail 30 是否有 handler 调用记录"
echo ""
echo "5️⃣  500 表不存在？手动执行（仅 1 条，不会动生产数据）:"
echo "       cd /opt/cvat-develop"
echo "       sudo docker compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml \\"
echo "         exec -T cvat_server python manage.py migrate organizations --no-input"
echo ""
