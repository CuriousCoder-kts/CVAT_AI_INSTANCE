#!/bin/bash
# ---------------------------------------------------------
# CVAT-UI Deploy Step 2：容器内 备份旧 NGINX_ROOT → 覆盖新 dist → Reload
# 在宿主机（root@nextvpu5030）执行时，通过 docker exec cvat_ui bash 传入内容执行
# ---------------------------------------------------------
set -euo pipefail

echo "== [S1] 探测 NGINX_ROOT =="
if [ -d "/usr/share/nginx/html" ]; then
  NGINX_ROOT="/usr/share/nginx/html"
elif [ -d "/app" ] && [ -f "/app/index.html" ]; then
  NGINX_ROOT="/app"
elif [ -d "/usr/local/openresty/nginx/html" ]; then
  NGINX_ROOT="/usr/local/openresty/nginx/html"
else
  # Fallback: find index.html
  FOUND=$(find / -maxdepth 5 -name "index.html" -path "*/html/*" 2>/dev/null | head -1 | sed 's|/index.html||')
  if [ -z "$FOUND" ] || [ ! -d "$FOUND" ]; then
    echo "❌ FAIL: 无法定位 NGINX html root！请手动 find / -name index.html 后修改本脚本 NGINX_ROOT"
    exit 2
  fi
  NGINX_ROOT="$FOUND"
fi
echo "✅ NGINX_ROOT = $NGINX_ROOT"

echo "== [S2] 备份旧 dist 到 /tmp/ai-mgr-backups/ =="
TIMESTAMP=$(date +%s)
BACKUP_DIR="/tmp/ai-mgr-backups/${TIMESTAMP}-cvat_ui"
mkdir -p "$BACKUP_DIR"
cp -a "$NGINX_ROOT" "$BACKUP_DIR"/html || true
echo "✅ 备份完成：$BACKUP_DIR/html"

echo "== [S3] 解压 /tmp/cvat-ui-dist.tar.gz 覆盖 NGINX_ROOT =="
if [ ! -f "/tmp/cvat-ui-dist.tar.gz" ]; then
  echo "❌ /tmp/cvat-ui-dist.tar.gz 不存在！请先执行 Step 1-3 的 build + tar 步骤"
  exit 2
fi
cd "$NGINX_ROOT"
# 先清旧，避免旧的 .map / 旧 contenthash 留在那里（但保留 robots.txt 等静态）
find "$NGINX_ROOT" -mindepth 1 -maxdepth 2 -type f \( -name "*.js" -o -name "*.css" -o -name "*.map" -o -name "*.wasm" -o -name "*.mjs" -o -name "index.html" \) -delete 2>/dev/null || true
tar -xzf /tmp/cvat-ui-dist.tar.gz -C "$NGINX_ROOT"
# 权限修复（nginx 大多数是 root/nginx 或 nginx:nginx 都行，644 即可
find "$NGINX_ROOT" -type d -exec chmod 755 {} \; 2>/dev/null || true
find "$NGINX_ROOT" -type f -exec chmod 644 {} \; 2>/dev/null || true
echo "✅ 覆盖完成，NGINX_ROOT 内容："
ls -la "$NGINX_ROOT" | head -n 12
ls "$NGINX_ROOT/assets" 2>/dev/null | head -n 10 || true

echo "== [S4] nginx reload（让新的 index.html 生效，避免缓存）=="
# 尝试多种 nginx 可执行路径
set +e
if command -v nginx >/dev/null 2>&1; then
  nginx -s reload 2>&1
fi
if command -v openresty >/dev/null 2>&1; then
  openresty -s reload 2>&1
fi
if command -v /usr/local/openresty/bin/openresty >/dev/null 2>&1; then
  /usr/local/openresty/bin/openresty -s reload 2>&1
fi
set -e
echo "✅ 部署脚本内部步骤完成"
