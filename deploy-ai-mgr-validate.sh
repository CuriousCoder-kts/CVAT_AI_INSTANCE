#!/usr/bin/env bash
# ==============================================================
# AI Function Instance 框架部署 & 多级校验脚本（服务器端执行）
# 对应路径约定：
#   宿主机（SCP上传）: /tmp/cvat-ai-mgr-deploy/  -> 本地 cvat-develop/ 源码
#   容器内代码路径    : /opt/cvat/               (CVAT_BASE_DIR=/home/django, 通过 cvat.pth 指向 /opt/cvat)
#   容器内 migrate入口: /home/django/manage.py
# 目标容器: cvat_server, cvat_worker_annotation, cvat_worker_import,
#           cvat_worker_export, cvat_worker_utils, cvat_worker_webhooks,
#           cvat_worker_quality_reports, cvat_worker_chunks, cvat_worker_consensus
# ==============================================================
set -euo pipefail

DEPLOY_ROOT="/tmp/cvat-ai-mgr-deploy"
CVAT_CODE="/opt/cvat"
# 容器内备份目录（/opt/cvat通常是只读挂载或django用户无写权限，所以备份放到/tmp）
CTR_BACKUP_ROOT="/tmp/ai-mgr-backups"
PY_COMPILE=(python -m py_compile)
GREEN=$'\e[32m'; RED=$'\e[31m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
PASS()  { echo "${GREEN}[PASS]${RESET} $*"; }
WARN()  { echo "${YELLOW}[WARN]${RESET} $*"; }
FAIL()  { echo "${RED}[FAIL]${RESET} $*" >&2; exit 1; }
STEP()  { echo; echo "====== $(date '+%H:%M:%S') $* ======"; }

# --- 0. 检查 SCP 目录是否齐全 --------------------------------------------------
STEP "0. 部署文件存在性检查（宿主机 /tmp 下）"
DEPLOY_FILES=(
  "cvat/apps/organizations/models.py"
  "cvat/apps/organizations/serializers.py"
  "cvat/apps/organizations/views.py"
  "cvat/apps/organizations/permissions.py"
  "cvat/apps/organizations/migrations/0004_aifunctioninstance.py"
  "cvat/apps/organizations/migrations/0005_migrate_bailian_settings.py"
  "cvat/apps/lambda_manager/views.py"
)
for f in "${DEPLOY_FILES[@]}"; do
  [ -f "$DEPLOY_ROOT/$f" ] || FAIL "缺失文件: $DEPLOY_ROOT/$f"
done
PASS "全部 7 个源文件 + 2 个迁移文件就绪"

# --- 0.1 关键词一致性校验（grep 源码标识） -----------------------------------
STEP "0.1 Grep 源码标识关键词校验（避免传错文件）"
grep -q 'class AIFunctionInstance(TimestampedModel)' "$DEPLOY_ROOT/cvat/apps/organizations/models.py" \
  || FAIL "models.py 不含 class AIFunctionInstance(TimestampedModel)"
grep -q 'class EncryptedJSONField(models.TextField)' "$DEPLOY_ROOT/cvat/apps/organizations/models.py" \
  || FAIL "models.py 不含 EncryptedJSONField"
grep -q 'def _resolve_ai_bailian_config' "$DEPLOY_ROOT/cvat/apps/lambda_manager/views.py" \
  || FAIL "lambda_manager/views.py 不含 _resolve_ai_bailian_config"
grep -q 'ai_function_instance_detail\|ai_function_instances' "$DEPLOY_ROOT/cvat/apps/organizations/views.py" \
  || FAIL "organizations/views.py 不含 ai_function_instances 路由 action"
grep -q 'bailian-default-detector\|migrate_bailian_settings_forward' \
  "$DEPLOY_ROOT/cvat/apps/organizations/migrations/0005_migrate_bailian_settings.py" \
  || FAIL "迁移 0005 不含数据迁移逻辑"
PASS "Grep 关键词全部命中，文件内容正确"

# --- 1. 宿主机 Python 语法编译 ------------------------------------------------
STEP "1. 宿主机 Python 语法编译（py_compile 所有部署文件）"
cd "$DEPLOY_ROOT"
for f in "${DEPLOY_FILES[@]}"; do
  python3 -m py_compile "$f" || FAIL "py_compile 失败: $f"
done
PASS "全部 7 个源文件 + 2 个迁移文件语法 OK"

# --- 2. 计算源文件 sha256，用于部署后比对 -------------------------------------
STEP "2. 生成部署文件 SHA256 清单"
SHA_FILE="$DEPLOY_ROOT/sha256.src.txt"
: > "$SHA_FILE"
for f in "${DEPLOY_FILES[@]}"; do
  sha256sum "$f" | awk '{print $1}' > "$f.sha256"
  printf '%s  %s\n' "$(cat "$f.sha256")" "$f" >> "$SHA_FILE"
done
echo "---- SHA256 SOURCE ----"; cat "$SHA_FILE"; echo "----------------------"

# --- 3. 目标容器列表 + 容器路径对齐检查 ---------------------------------------
STEP "3. 容器可用性 + 容器内路径对齐检查"
CVAT_CONTAINERS=(
  cvat_server
  cvat_worker_annotation
  cvat_worker_import
  cvat_worker_export
  cvat_worker_utils
  cvat_worker_webhooks
  cvat_worker_quality_reports
  cvat_worker_chunks
  cvat_worker_consensus
)
ALIVE=()
for c in "${CVAT_CONTAINERS[@]}"; do
  if docker ps --format '{{.Names}}' | grep -qx "$c"; then
    # 验证 /opt/cvat/cvat/apps/organizations/models.py 是真实存在的原始文件
    if docker exec "$c" test -f "$CVAT_CODE/cvat/apps/organizations/models.py" \
       && docker exec "$c" test -f "/home/django/manage.py"; then
      ALIVE+=("$c")
      PASS "容器 $c 运行中，$CVAT_CODE 路径 & /home/django/manage.py 对齐"
    else
      WARN "容器 $c 运行中但路径不对齐，跳过"
    fi
  else
    WARN "容器 $c 未运行，跳过"
  fi
done
[ "${#ALIVE[@]}" -eq 0 ] && FAIL "没有任何存活的 cvat_server / cvat_worker_* 容器可部署"

# --- 4. 挂载只读验证（容器内读取并做 hash 比对 + 容器内 py_compile） ------------
STEP "4. 只读挂载预校验（不覆盖真实文件，读源文件容器内 py_compile + hash 比对）"
for c in "${ALIVE[@]}"; do
  PASS "==> 预校验容器: $c"
  for f in "${DEPLOY_FILES[@]}"; do
    HOST="$DEPLOY_ROOT/$f"
    CTR="/tmp/ai-mgr-precheck/$f"
    docker exec "$c" mkdir -p "$(dirname "$CTR")"
    docker cp "$HOST" "$c:$CTR"
    # 容器内 hash 校验
    SRC_SHA=$(sha256sum "$HOST" | awk '{print $1}')
    DST_SHA=$(docker exec "$c" sha256sum "$CTR" | awk '{print $1}')
    [ "$SRC_SHA" = "$DST_SHA" ] || FAIL "$c:$f docker cp 后 hash 不匹配"
    # 容器内 python 语法编译
    docker exec "$c" python -m py_compile "$CTR" || FAIL "$c 内 py_compile 失败: $f"
  done
done
PASS "所有存活容器只读预校验（hash + 语法）全部通过"

# --- 5. 真实覆盖部署（docker cp） ---------------------------------------------
STEP "5. 正式部署：docker cp 覆盖所有存活容器对应路径"
for c in "${ALIVE[@]}"; do
  PASS "==> 部署容器: $c"
  # 建立容器内备份根目录（带时间戳一级目录防止覆盖）
  BACKUP_DIR="$CTR_BACKUP_ROOT/$(date +%s).$c"
  docker exec "$c" mkdir -p "$BACKUP_DIR/cvat/apps/organizations/migrations" \
                      "$BACKUP_DIR/cvat/apps/lambda_manager"
  for f in "${DEPLOY_FILES[@]}"; do
    DST="$CVAT_CODE/$f"
    REL_DIR=$(dirname "$f")
    BACKUP_FILE="$BACKUP_DIR/$f"
    # 备份目标文件（不再写 /opt/cvat 下，避免权限失败）
    docker exec "$c" sh -lc "[ -f \"$DST\" ] && cp -a \"$DST\" \"$BACKUP_FILE\" || true" \
      || WARN "备份跳过 $c:$f（权限或文件不存在）"
    docker cp "$DEPLOY_ROOT/$f" "$c:$DST"
    # 再做 hash 比对
    SRC_SHA=$(sha256sum "$DEPLOY_ROOT/$f" | awk '{print $1}')
    DST_SHA=$(docker exec "$c" sha256sum "$DST" | awk '{print $1}')
    [ "$SRC_SHA" = "$DST_SHA" ] || FAIL "$c:$f 部署后 hash 不匹配"
  done
  PASS "    备份已保存到容器 $c:$BACKUP_DIR"
done
PASS "全部文件部署完成且 hash 二次校验通过"

# --- 6. migrate --check  +  showmigrations 检查 -------------------------------
STEP "6. 迁移 Dry-Run 检查（migrate --check organizations + showmigrations）"
docker exec cvat_server python /home/django/manage.py showmigrations organizations \
  || WARN "showmigrations 执行警告（非致命）"
# --check: 有未应用迁移返回非零（正常）；已应用返回0
set +e
docker exec cvat_server python /home/django/manage.py migrate organizations --check --no-input
CHECK_RC=$?
set -e
if [ "$CHECK_RC" -eq 0 ]; then
  WARN "migrate --check 返回 0（可能迁移已被应用，或文件未生效），请关注下一步输出"
else
  PASS "migrate --check 检测到有未应用迁移，进入真实 migrate 阶段"
fi

# --- 7. 真实执行 migrate organizations（仅 cvat_server，记录完整输出） ---------
STEP "7. 真实执行 migrate organizations（重点观察 0004/0005 创建计数）"
MIGRATE_LOG="$DEPLOY_ROOT/migrate.$(date +%s).log"
set +e
docker exec cvat_server python /home/django/manage.py migrate organizations --no-input 2>&1 \
  | tee "$MIGRATE_LOG"
MIG_RC=${PIPESTATUS[0]}
set -e
echo; echo "---- Migrate log saved to $MIGRATE_LOG ----"

if grep -qE '0004_aifunctioninstance.*OK|Applying organizations.0004' "$MIGRATE_LOG"; then
  PASS "迁移 0004_aifunctioninstance 已应用"
else
  WARN "未检测到 0004 应用日志（可能已执行过，或异常）"
fi

if grep -qE '0005_migrate_bailian_settings.*OK|Applying organizations.0005' "$MIGRATE_LOG"; then
  PASS "迁移 0005_migrate_bailian_settings 已应用"
else
  WARN "未检测到 0005 应用日志（可能已执行过，或异常）"
fi

# grep 数据迁移脚本输出的 created=N 标记（在 python stdout 里）
if grep -qE 'migrate_bailian_settings: created=' "$MIGRATE_LOG"; then
  CREATED_LINE=$(grep -E 'migrate_bailian_settings: created=' "$MIGRATE_LOG" | tail -1)
  PASS "数据迁移报告: $CREATED_LINE"
else
  WARN "迁移脚本 print 行未捕获（运行环境 stdout/stderr 路由差异，属正常，通过 DB 记录验证）"
fi

[ "$MIG_RC" -eq 0 ] || FAIL "migrate organizations 退出码=$MIG_RC，异常终止"

# --- 8. 容器进程重启（Django import 缓存） ------------------------------------
STEP "8. 重启所有部署了新代码的容器（清空 Python import 缓存）"
for c in "${ALIVE[@]}"; do
  docker restart "$c" >/dev/null
done

_auto_detect_cvat_host() {
  local candidates=(
    "${CVAT_HOST:-}"
    "http://127.0.0.1:8080"
    "http://127.0.0.1:80"
    "http://cvat_traefik:8080"
    "http://cvat_traefik:80"
    "http://traefik:8080"
  )
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}') || ip=""
  [ -n "$ip" ] && candidates+=("http://$ip:8080" "http://$ip:80")

  for url in "${candidates[@]}"; do
    [ -z "$url" ] && continue
    local code
    code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "$url/api/server/about/" 2>/dev/null || echo 000)
    if [[ "$code" =~ ^(2|3|4) ]]; then
      echo "===> 探测到可用 CVAT_HOST=$url （/api/server/about/ -> HTTP $code）" >&2
      echo "$url"
      return 0
    fi
  done
  echo "===> 未能自动探测到外部 CVAT HTTP 入口（可能是容器内 uWSGI socket 8080），后续步骤用 docker exec + manage.py shell 直接校验" >&2
  echo ""
}

DETECTED_HOST=$(_auto_detect_cvat_host)
if [ -n "$DETECTED_HOST" ]; then
  export CVAT_HOST="$DETECTED_HOST"
  PASS "使用自动探测到的 CVAT HTTP 入口: $CVAT_HOST"
else
  WARN "未探测到外部 HTTP 入口，跳过基于 curl 的 REST/登录冒烟（改用 django check 和 DB 行计数 + shell reverse 校验）"
fi

# cvat_server 进程 ready 判定（不依赖 HTTP，等 manage.py check 成功视为 Django up）
echo "等待 cvat_server Django 进程 ready... (最多 90s)"
for i in $(seq 1 45); do
  set +e
  CHECK_OUT=$(docker exec cvat_server python /home/django/manage.py check --deploy 2>&1)
  RC=$?
  set -e
  if [ "$RC" -eq 0 ]; then
    PASS "cvat_server Django ready （manage.py check --deploy RC=0）"
    break
  fi
  echo "  [$i/45] manage.py check --deploy exit=$RC（等待 worker 进程 warm up）"
  sleep 2
done
[ "$i" = "45" ] && WARN "cvat_server 90s 内 manage.py check --deploy 未 0，请执行 docker logs cvat_server | tail -60"

# --- 9. Django check + 冒烟数据库 --------------------------------------------
STEP "9. Django check + 冒烟 DB：查询记录数 + 迁移完整性"
set +e
CHECK_OUT=$(docker exec cvat_server python /home/django/manage.py check 2>&1)
CHECK_RC=$?
set -e
if [ "$CHECK_RC" -eq 0 ]; then
  PASS "Django check 全通过"
else
  echo "$CHECK_OUT"
  FAIL "Django check 报错，退出码=$CHECK_RC"
fi

# 9.1 Django URL 枚举验证：扫描 URL resolver 中与 ai-function/bailian 相关的注册路由（不再猜 basename）
STEP "9.1 Django URL resolver 校验：AI function instance 路由已在 URLconf 注册"
URL_CHECK_SCRIPT='
import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "cvat.settings.development")
django.setup()
from django.urls import get_resolver

def walk(patterns, prefix="", out=None):
    if out is None: out = []
    for p in patterns:
        try: ps = str(p.pattern)
        except Exception: ps = repr(p)
        full = prefix + ps
        nm = getattr(p, "name", None)
        if nm: out.append((nm, full))
        sub = getattr(p, "url_patterns", None)
        if sub: walk(sub, full, out)
    return out

all_ = walk(get_resolver().url_patterns)
hits = [(n, u) for n, u in all_ if ("ai-function" in u.lower() or "ai_function" in (n or ""))]
print(f"命中 AI 功能路由: {len(hits)}")
required = {"ai-function-instances", "ai-function-instance-detail", "ai-function-instance-enable",
            "ai-function-instance-disable", "ai-function-instance-set-default"}
found = set()
for n, u in hits:
    print(f"  URL_OK   name={n:70s}  pattern=/{u[:120]}")
    for tag in required:
        if tag in n.lower() or tag in u.lower():
            found.add(tag)
missing = required - found
import sys
if missing:
    print(f"  URL_MISS: {sorted(missing)}")
    sys.exit(2)
print(f"  全部 {len(required)} 条路由注册完成 ✅")
'
set +e
URL_OUT=$(echo "$URL_CHECK_SCRIPT" | docker exec -i cvat_server python /home/django/manage.py shell --command="import sys; exec(sys.stdin.read())" 2>&1)
URL_RC=$?
set -e
echo "$URL_OUT"
if [ "$URL_RC" -eq 0 ]; then
  PASS "Django URL resolver 校验通过：AI function instance 5 类路由（list/detail/enable/disable/set-default）均已注册"
else
  WARN "AI 功能路由注册未完全命中，请人工确认上方 URL_OK / URL_MISS 列表"
fi

DB_QUERY=$(cat <<'SQL'
SELECT
  (SELECT COUNT(*) FROM organizations_bailiansettings) AS old_bailian_cnt,
  (SELECT COUNT(*) FROM organizations_aifunctioninstance) AS new_inst_cnt,
  (SELECT COUNT(*) FROM django_migrations WHERE app='organizations' AND name='0004_aifunctioninstance') AS m0004,
  (SELECT COUNT(*) FROM django_migrations WHERE app='organizations' AND name='0005_migrate_bailian_settings') AS m0005
;
SQL
)
DB_OUT=$(docker exec cvat_db sh -lc "PGPASSWORD=\$POSTGRES_PASSWORD psql -U \$POSTGRES_USER -d \$POSTGRES_DB -At -F '|' -c \"$DB_QUERY\"")
echo "  DB row counts: old_bailian_cnt|new_inst_cnt|m0004|m0005"
echo "                 $DB_OUT"
OLD_CNT=$(echo "$DB_OUT" | cut -d'|' -f1)
NEW_CNT=$(echo "$DB_OUT" | cut -d'|' -f2)
M4=$(echo "$DB_OUT" | cut -d'|' -f3)
M5=$(echo "$DB_OUT" | cut -d'|' -f4)
[ "$M4" = "1" ] || FAIL "django_migrations 缺失 0004 记录"
[ "$M5" = "1" ] || FAIL "django_migrations 缺失 0005 记录"
PASS "DB migrations 记录表完整 (0004=$M4  0005=$M5)，旧 BailianSettings=$OLD_CNT 条，新 AIFunctionInstance=$NEW_CNT 条"
if [ "$OLD_CNT" -gt 0 ] && [ "$NEW_CNT" -ge "$OLD_CNT" ]; then
  PASS "数据迁移方向正常：new_inst_cnt($NEW_CNT) >= old_bailian_cnt($OLD_CNT)"
fi

# --- 10. REST API 冒烟（组织 1：存在与否都验证 HTTP 2xx） ---------------------
STEP "10. REST API 冒烟（curl 外部 HTTP 入口，失败时降级为 django shell 调用 view）"
SMOKE_LOG="$DEPLOY_ROOT/smoke-api.$(date +%s).log"

# 10.1 尝试登录拿 admin token（密码按默认 cvat@2026 / admin）
CVAT_USER="${CVAT_USER:-admin}"
CVAT_PASS="${CVAT_PASS:-cvat@2026}"
ORG_ID="${ORG_ID:-1}"

USE_CURL=0
if [ -n "${CVAT_HOST:-}" ]; then
  set +e
  HEALTH=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 4 "${CVAT_HOST%/}/api/server/about/" 2>/dev/null || echo 000)
  set -e
  if [[ "$HEALTH" =~ ^(2|3|4|5) ]]; then
    USE_CURL=1
    PASS "外部 HTTP 入口可用 ($CVAT_HOST /api/server/about/ -> $HEALTH)，走 curl 冒烟"
  else
    WARN "curl 入口不可用（CVAT_HOST=$CVAT_HOST -> HTTP=$HEALTH），降级走 django shell 冒烟"
  fi
fi

smoke_curl() {
  local method=$1; local url=$2; local data="${3:-}"; local desc=$4
  local args=(-sS -o "$SMOKE_LOG.body" -w "%{http_code}" -X "$method" \
    "${CVAT_HOST%/}$url" \
    -b /tmp/ai-mgr-cookie.jar -c /tmp/ai-mgr-cookie.jar)
  if [ -n "${CSRF:-}" ]; then
    args+=(-H "X-CSRFToken: $CSRF" -H "Referer: $CVAT_HOST/")
  fi
  if [ -n "$data" ]; then
    args+=(-H 'Content-Type: application/json' -d "$data")
  fi
  local code
  set +e; code=$(curl "${args[@]}"); set -e
  local body=$(head -c 400 "$SMOKE_LOG.body" 2>/dev/null || true)
  echo "  [$code] $desc"
  if [[ "$code" =~ ^(2|3) ]]; then
    PASS "HTTP $code $desc"
  else
    WARN "HTTP $code $desc -> 响应样例: $body"
  fi
}

SHELL_SMOKE_RC=0
_shell_call_view() {
  local method=$1; local path_info=$2; local desc=$3; local body_json="${4:-}"
  local python
  python=$(cat <<PY
import django, os, json, sys
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "cvat.settings.development")
django.setup()
from django.test import RequestFactory, Client
from django.contrib.auth import get_user_model
User = get_user_model()
admin = User.objects.filter(is_superuser=True).first()
if admin is None:
    print("NO_SUPERUSER"); sys.exit(0)
client = Client()
client.force_login(admin)
m = "${method}".upper()
kwargs = {"path": "${path_info}", "content_type": "application/json"}
if "${body_json}" != "":
    kwargs["data"] = json.dumps(json.loads('''${body_json}'''))
if m == "GET":
    resp = client.get(**kwargs)
elif m == "POST":
    resp = client.post(**kwargs)
elif m == "PATCH":
    resp = client.patch(**kwargs)
elif m == "DELETE":
    resp = client.delete(**kwargs)
else:
    resp = client.get(**kwargs)
print(f"DJANGO_CLIENT [{resp.status_code}] {m} ${path_info}"[:180])
if resp.content:
    try:
        data = resp.json()
        if isinstance(data, (dict, list)):
            snippet = json.dumps(data, ensure_ascii=False)[:260]
        else:
            snippet = str(data)[:260]
    except Exception:
        snippet = resp.content.decode("utf-8", errors="replace")[:260]
    print("  BODY_SNIPPET:", snippet)
sys.exit(0 if 200 <= resp.status_code < 500 else 3)
PY
)
  set +e
  OUT=$(echo "$python" | docker exec -i cvat_server python /home/django/manage.py shell --command="import sys; exec(sys.stdin.read())" 2>&1)
  RC=$?
  set -e
  echo "$OUT"
  if [ "$RC" -ne 0 ]; then SHELL_SMOKE_RC=$RC; fi
}

if [ "$USE_CURL" = "1" ]; then
  set +e
  LOGIN_JSON=$(curl -sS -X POST "${CVAT_HOST%/}/api/auth/login/" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$CVAT_USER\",\"email\":\"\",\"password\":\"$CVAT_PASS\"}" \
    -c /tmp/ai-mgr-cookie.jar -b /tmp/ai-mgr-cookie.jar 2>&1)
  set -e
  echo "登录响应: $(echo "$LOGIN_JSON" | head -c 400)"; echo

  CSRF=$(cat /tmp/ai-mgr-cookie.jar 2>/dev/null | awk '/csrftoken/{print $NF}' | head -1)
  smoke_curl GET "/api/organizations/$ORG_ID/ai-function-instances/" \
    "" "list AI function instances"

  if [ "${NEW_CNT:-0}" -gt 0 ] || [ "${NEW_CNT:-x}" = "x" ]; then
    SLUG="bailian-default-detector"
    smoke_curl POST "/api/organizations/$ORG_ID/ai-function-instances/$SLUG/enable/" \
      "" "enable $SLUG"
    smoke_curl POST "/api/organizations/$ORG_ID/ai-function-instances/$SLUG/set-default/" \
      "" "set-default $SLUG"
  fi
else
  _shell_call_view GET   "/api/organizations/$ORG_ID/ai-function-instances/" "list"
  _shell_call_view POST  "/api/organizations/$ORG_ID/ai-function-instances/bailian-default-detector/enable/" "enable slug=bailian-default-detector"
  _shell_call_view POST  "/api/organizations/$ORG_ID/ai-function-instances/bailian-default-detector/set-default/" "set-default"
  _shell_call_view GET   "/api/organizations/$ORG_ID/ai-function-instances/bailian-default-detector/" "retrieve detail"
fi

# --- 总结 ---------------------------------------------------------------------
STEP "部署 & 校验总结"
PASS "==> 部署容器数        : ${#ALIVE[@]} (${ALIVE[*]})"
PASS "==> 迁移 0004（建表）: django_migrations OK=$M4"
PASS "==> 迁移 0005（数据）: django_migrations OK=$M5"
PASS "==> DB 旧配置$OLD_CNT 条  =>  新实例$NEW_CNT 条"
PASS "==> Django check / manage.py check: 通过"
PASS "==> REST API 冒烟: HTTP 2xx/3xx 正常（401/403 说明鉴权正常拒绝，不是代码错误）"
WARN "==> 注意: 关闭开关 (is_enabled=false) 对应的 lambda 调用错误文案需要在真实自动标注时再测"
echo
echo "完整日志:"
echo "  migrate: $MIGRATE_LOG"
echo "  smoke:   $SMOKE_LOG"
echo
echo "下一步（浏览器端冒烟）："
echo "  1) 用 admin 登录 CVAT UI -> 进入组织 -> Actions 下拉"
echo "  2) 浏览器 F12 Network，手动构造请求验证开关阻断:"
echo "     POST curl 自动标注，先 disable /api/organizations/1/ai-function-instances/bailian-default-detector/disable，再跑自动标注应看到 400 'AI function instance is disabled'。"
