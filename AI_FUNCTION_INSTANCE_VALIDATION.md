# AI Function Instance 框架验证步骤（手动分步版）

> 适配路径约定：
> - 宿主机 CVAT 源码根：`/root/cvat-develop`（即本仓库 d:\cvat-develop）
> - SCP 临时目录（服务器）：`/tmp/cvat-ai-mgr-deploy`
> - 容器内 CVAT 源码：`/opt/cvat/` （通过 `/opt/venv/lib/python3.12/site-packages/cvat.pth`）
> - manage.py 软链：`/home/django/manage.py`
> - 目标容器：`cvat_server` + 所有 `cvat_worker_*`

---

## A. 宿主机（Windows 开发机）→ SCP 上传到服务器

在 PowerShell 中（当前目录 = `D:\cvat-develop`）：

```powershell
# A1. 创建打包清单（7 个源码 + 2 个迁移 + 1 个验证脚本）
$files = @(
  "cvat/apps/organizations/models.py",
  "cvat/apps/organizations/serializers.py",
  "cvat/apps/organizations/views.py",
  "cvat/apps/organizations/permissions.py",
  "cvat/apps/organizations/migrations/0004_aifunctioninstance.py",
  "cvat/apps/organizations/migrations/0005_migrate_bailian_settings.py",
  "cvat/apps/lambda_manager/views.py",
  "deploy-ai-mgr-validate.sh"
)
$tar = "ai-mgr-deploy.tar.gz"
tar -czf $tar @files
Write-Host "打包完成: $(Get-Item $tar | Select-Object -ExpandProperty Length) bytes"

# A2. SCP 上传到服务器（改成你的服务器 SSH）
# scp -P 22 $tar root@YOUR-SERVER-IP:/tmp/
# scp -P 22 deploy-ai-mgr-validate.sh root@YOUR-SERVER-IP:/tmp/
```

---

## B. 服务器 SSH 执行（一键脚本版）

```bash
cd /tmp
tar -xzf ai-mgr-deploy.tar.gz -C /tmp/cvat-ai-mgr-deploy --strip-components=0 2>/dev/null || \
  (mkdir -p /tmp/cvat-ai-mgr-deploy && tar -xzf ai-mgr-deploy.tar.gz -C /tmp/cvat-ai-mgr-deploy)

cd /tmp/cvat-ai-mgr-deploy
chmod +x deploy-ai-mgr-validate.sh

# 可选：配置登录信息（不设置默认用 admin/cvat@2026）
export CVAT_HOST=http://127.0.0.1:8080
export CVAT_USER=admin
export CVAT_PASS=cvat@2026
export ORG_ID=1

bash ./deploy-ai-mgr-validate.sh 2>&1 | tee ./deploy-ai-mgr.full.log
```

脚本自动跑 10 级校验，任何一步失败立即中断并打印 `[FAIL]`。

---

## C. 服务器 SSH 执行（手动分步版，推荐第一次跑用这个便于定位问题）

### C0. 准备 + 文件存在性

```bash
DEPLOY_ROOT=/tmp/cvat-ai-mgr-deploy
mkdir -p $DEPLOY_ROOT
cd /tmp && tar -xzf ai-mgr-deploy.tar.gz -C $DEPLOY_ROOT --strip-components=0 2>/dev/null || \
  tar -xzf ai-mgr-deploy.tar.gz -C $DEPLOY_ROOT

cd $DEPLOY_ROOT
ls -la cvat/apps/organizations/ cvat/apps/organizations/migrations/ cvat/apps/lambda_manager/
# 确认共 7 个 py + 2 个 migration py
```

### C1. 宿主机（服务器）Python 语法

```bash
for f in \
  cvat/apps/organizations/models.py \
  cvat/apps/organizations/serializers.py \
  cvat/apps/organizations/views.py \
  cvat/apps/organizations/permissions.py \
  cvat/apps/organizations/migrations/0004_aifunctioninstance.py \
  cvat/apps/organizations/migrations/0005_migrate_bailian_settings.py \
  cvat/apps/lambda_manager/views.py; do
  python3 -m py_compile $f && echo "OK $f" || { echo FAIL $f; exit 1; }
done
```

### C2. 关键词 grep （防传错）

```bash
grep -q 'class AIFunctionInstance(TimestampedModel)' cvat/apps/organizations/models.py        && echo OK AIFunctionInstance || exit 1
grep -q 'class EncryptedJSONField'                 cvat/apps/organizations/models.py        && echo OK EncryptedJSONField || exit 1
grep -q 'def ai_function_instances\|ai_function_instance_detail' cvat/apps/organizations/views.py && echo OK views actions || exit 1
grep -q 'ai_function_instance'                      cvat/apps/organizations/permissions.py    && echo OK permission mapping || exit 1
grep -q '_resolve_ai_bailian_config'                cvat/apps/lambda_manager/views.py         && echo OK lambda resolver || exit 1
```

### C3. 容器 alive + 路径对齐检查

```bash
CVAT_CONTAINERS=(cvat_server cvat_worker_annotation cvat_worker_import cvat_worker_export \
  cvat_worker_utils cvat_worker_webhooks cvat_worker_quality_reports cvat_worker_chunks cvat_worker_consensus)
for c in ${CVAT_CONTAINERS[@]}; do
  running=$(docker inspect -f '{{.State.Running}}' $c 2>/dev/null || echo false)
  if [ "$running" = true ]; then
    docker exec $c test -f /opt/cvat/cvat/apps/organizations/models.py \
      && docker exec $c test -f /home/django/manage.py \
      && echo "ALIVE+PATH_OK $c" || echo "PATH_WRONG $c"
  else
    echo "DEAD $c (skip)"
  fi
done
# 记录所有「ALIVE+PATH_OK」的容器到数组下面要部署
ALIVE=($(for c in ${CVAT_CONTAINERS[@]}; do
  running=$(docker inspect -f '{{.State.Running}}' $c 2>/dev/null || echo false)
  [ "$running" = true ] \
    && docker exec $c test -f /opt/cvat/cvat/apps/organizations/models.py 2>/dev/null \
    && echo $c
done))
echo "目标容器: ${ALIVE[@]}"
```

### C4. 只读预校验（docker cp 到 /tmp 容器内路径 + hash + py_compile）

```bash
DEPLOY_FILES=(
  cvat/apps/organizations/models.py
  cvat/apps/organizations/serializers.py
  cvat/apps/organizations/views.py
  cvat/apps/organizations/permissions.py
  cvat/apps/organizations/migrations/0004_aifunctioninstance.py
  cvat/apps/organizations/migrations/0005_migrate_bailian_settings.py
  cvat/apps/lambda_manager/views.py
)
for c in ${ALIVE[@]}; do
  echo "===== PRE-CHECK $c ====="
  for f in ${DEPLOY_FILES[@]}; do
    HOST=$DEPLOY_ROOT/$f
    CTR=/tmp/ai-mgr-precheck/$f
    docker exec $c mkdir -p $(dirname $CTR)
    docker cp $HOST $c:$CTR
    SRC_SHA=$(sha256sum $HOST | awk '{print $1}')
    DST_SHA=$(docker exec $c sha256sum $CTR | awk '{print $1}')
    [ "$SRC_SHA" = "$DST_SHA" ] && echo "HASH_OK $f" || { echo FAIL_HASH $c:$f; exit 1; }
    docker exec $c python -m py_compile $CTR && echo "SYNTAX_OK $f" || { echo FAIL_SYNTAX $c:$f; exit 1; }
  done
done
```

### C5. 真实部署（备份 + 覆盖 + hash 二次核对）

```bash
for c in ${ALIVE[@]}; do
  echo "===== DEPLOY TO $c ====="
  for f in ${DEPLOY_FILES[@]}; do
    DST=/opt/cvat/$f
    # 备份
    docker exec $c sh -lc "[ -f $DST ] && cp -a $DST ${DST}.bak.\$(date +%s) || true"
    # 覆盖
    docker cp $DEPLOY_ROOT/$f $c:$DST
    # hash 核对
    SRC_SHA=$(sha256sum $DEPLOY_ROOT/$f | awk '{print $1}')
    DST_SHA=$(docker exec $c sha256sum $DST | awk '{print $1}')
    [ "$SRC_SHA" = "$DST_SHA" ] && echo "DEPLOY_OK $f" || { echo FAIL_DEPLOY $c:$f; exit 1; }
  done
done
```

### C6. showmigrations → migrate --check → 真实 migrate

```bash
docker exec cvat_server python /home/django/manage.py showmigrations organizations

# --check=1 表示有未应用迁移=正常；check=0 表示已应用（可能你重跑过，也正常）
set +e
docker exec cvat_server python /home/django/manage.py migrate organizations --check --no-input
echo "migrate --check RC=$?"
set -e

# 真实 migrate
docker exec cvat_server python /home/django/manage.py migrate organizations --no-input 2>&1 \
  | tee $DEPLOY_ROOT/migrate.real.log
# 期待看到类似: Applying organizations.0004_aifunctioninstance... OK
#            Applying organizations.0005_migrate_bailian_settings... OK
#            migrate_bailian_settings: created=1 skipped=0   (若有旧 BailianSettings)
```

### C7. 重启全部目标容器 + cvat_server 探活

```bash
for c in ${ALIVE[@]}; do docker restart $c; done

echo "等待 cvat_server HTTP 200..."
for i in $(seq 1 60); do
  HTTP=$(docker exec cvat_server sh -lc 'curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:8080/api/server/about/ 2>/dev/null || echo 000')
  echo "  [$i/60] HTTP=$HTTP"
  [ "$HTTP" = "200" ] && break
  sleep 2
done
[ "$HTTP" != "200" ] && echo "WARNING: cvat_server 未 200，请执行 docker logs cvat_server | tail -100"
```

### C8. Django manage.py check + DB 行计数核验

```bash
docker exec cvat_server python /home/django/manage.py check && echo "[OK] Django check"

DB_OUT=$(docker exec cvat_db sh -lc 'PGPASSWORD=$POSTGRES_PASSWORD psql -U $POSTGRES_USER -d $POSTGRES_DB -At -F "|" -c "
SELECT
  (SELECT COUNT(*) FROM organizations_bailiansettings) AS old_cnt,
  (SELECT COUNT(*) FROM organizations_aifunctioninstance) AS new_cnt,
  (SELECT COUNT(*) FROM django_migrations WHERE app=''\''organizations'\'' AND name='\''0004_aifunctioninstance'\'') AS m4,
  (SELECT COUNT(*) FROM django_migrations WHERE app='\''organizations'\'' AND name='\''0005_migrate_bailian_settings'\'') AS m5;
"')
echo "old_bailian|new_instance|mig_0004|mig_0005"
echo "$DB_OUT"
# 期望: m4=1, m5=1；如果 old_cnt>0 则 new_cnt >= old_cnt
```

### C9. REST API 冒烟（无 token 的情况下只验证路由存在）

```bash
CVAT_HOST=http://127.0.0.1:8080
ORG_ID=1
# 即使 401/403 也说明路由没挂
for p in \
  "/api/organizations/$ORG_ID/ai-function-instances" \
  "/api/organizations/$ORG_ID/ai-function-instances/bailian-default-detector" \
  "/api/organizations/$ORG_ID/ai-function-instances/bailian-default-detector/enable" \
  "/api/organizations/$ORG_ID/ai-function-instances/bailian-default-detector/disable" \
  "/api/organizations/$ORG_ID/ai-function-instances/bailian-default-detector/set-default"; do
  set +e
  code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$CVAT_HOST$p" -H "Referer: $CVAT_HOST/" 2>/dev/null)
  [ -z "$code" ] && code=$(curl -sS -o /dev/null -w "%{http_code}" -X GET "$CVAT_HOST$p" 2>/dev/null)
  set -e
  # 401/403/405 均为正常（路由存在但缺鉴权/方法不对）
  echo "HTTP=$code  $p"
done
```

### C10. 终极：浏览器端 禁用 → 标注阻断 → 启用 → 标注正常

```
1. 打开浏览器 DevTools → Network
2. 进入组织 → 复制 org id
3. 先调 POST enable 让实例默认开启
4. 发起 1 次自动标注 → 应成功（与之前行为一致）
5. 调 POST /organizations/{id}/ai-function-instances/bailian-default-detector/disable
6. 再发起 1 次自动标注 → 前端会出现 400：
   "AI function instance 'bailian-default-detector' is disabled. Please enable it..."
7. 调 POST enable 恢复 → 自动标注再成功
```

---

## D. 出问题时回滚（一键）

```bash
# D1. 恢复每个容器的 .bak 文件（取最新一个）
for c in ${ALIVE[@]}; do
  for f in ${DEPLOY_FILES[@]}; do
    DST=/opt/cvat/$f
    LAST_BAK=$(docker exec $c sh -lc "ls -1t ${DST}.bak.* 2>/dev/null | head -1")
    if [ -n "$LAST_BAK" ]; then
      docker exec $c cp -a "$LAST_BAK" "$DST" && echo "ROLLBACK_OK $c:$f"
    fi
  done
done

# D2. 回滚 DB 迁移（0005 -> 0004 -> 0003）
docker exec cvat_server python /home/django/manage.py migrate organizations 0003_bailiansettings --no-input
# 确认回滚完成再重启所有容器
for c in ${ALIVE[@]}; do docker restart $c; done
```
