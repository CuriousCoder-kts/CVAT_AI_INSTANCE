#!/usr/bin/env bash
# ============================================================
# 服务器真实状态 READ-ONLY 检查脚本（不修改任何东西，只输出信息）
# 用法：scp check-server-state.sh nextvpu@192.168.50.30:/tmp/
#       ssh nextvpu@192.168.50.30 "bash /tmp/check-server-state.sh"
# 把输出完整贴回来，我再根据真实情况写 remote-deploy.sh
# ============================================================
set +e
SEP="============================================================"
echo $SEP
echo "[1] 登录用户 / sudo 权限 / 家目录 / 时间"
echo $SEP
echo "USER=$(id -un)  UID=$(id -u)  GROUPS=$(id -Gn)"
echo "HOME=$HOME"
echo "SUDO_NOPASSWD: $(if sudo -n true 2>/dev/null; then echo 'YES (无需密码 sudo)'; else echo 'NO (需要密码或无 sudo)'; fi)"
echo "DATE=$(date -Iseconds)"
hostname -I 2>/dev/null || true
echo ""
echo $SEP
echo "[2] /opt/cvat-develop 是否存在？归属？以及是否有 /home/\$USER/cvat-develop 候选目录"
echo $SEP
for d in /opt/cvat-develop "$HOME/cvat-develop" /home/nextvpu/cvat-develop; do
  if [[ -d "$d" ]]; then
    echo "FOUND: $d"
    ls -ld "$d"
    echo "  Files in $d (top 30):"
    ls -la "$d" 2>/dev/null | head -30
    echo "  Docker Compose files:"
    find "$d" -maxdepth 3 -type f \( -name 'docker-compose*.yml' -o -name 'Dockerfile*' \) 2>/dev/null | head -20
  else
    echo "NOT EXIST: $d"
  fi
  echo ""
done
echo ""
echo $SEP
echo "[3] Docker / Compose 实际版本；compose 是 v1 (docker-compose) 还是 v2 (docker compose)？"
echo $SEP
if command -v docker &>/dev/null; then
  docker --version
  echo "Docker ps 当前容器（grep -i cvat/nuclio）:"
  docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}" | grep -Ei 'cvat|nuclio|traefik|redis|postgres' | head -40
else
  echo "docker 命令不存在！PATH=$PATH"
fi
echo ""
if docker compose version &>/dev/null; then
  echo "Compose V2 (docker compose) 存在：$(docker compose version 2>&1 | head -1)"
else
  echo "Compose V2 不存在"
fi
if command -v docker-compose &>/dev/null; then
  echo "Compose V1 (docker-compose) 存在：$(docker-compose --version 2>&1)"
else
  echo "Compose V1 不存在"
fi
echo ""
echo $SEP
echo "[4] /opt/cvat-develop 里当前实际运行的 Compose 文件：检查是否有 override，以及目录里的实际内容"
echo $SEP
TARGET_DIR=""
for d in /opt/cvat-develop "$HOME/cvat-develop" /home/nextvpu/cvat-develop; do
  if [[ -d "$d" && -f "$d/docker-compose.yml" ]]; then
    TARGET_DIR="$d"
    echo "Candidate project directory with docker-compose.yml: $d"
    echo "env / override 存在性:"
    for f in .env .env.local .env.user docker-compose.override.yml components/serverless/docker-compose.serverless.yml; do
      if [[ -f "$d/$f" ]]; then echo "  FILE EXIST: $f (size=$(stat -c%s "$d/$f" 2>/dev/null || stat -f%z "$d/$f" 2>/dev/null))"
      else echo "  FILE MISSING: $f"; fi
    done
    break
  fi
done
if [[ -z "$TARGET_DIR" ]]; then
  echo "没有任何目录同时存在 docker-compose.yml，需要你告诉我实际目录。"
fi
echo ""
echo $SEP
echo "[5] 当前 cvat_server 里 organizations 应用已执行的 migrations（判断是否已经有 AIFunctionInstance 表）"
echo $SEP
if [[ -n "$TARGET_DIR" ]]; then
  cd "$TARGET_DIR"
  if docker compose version &>/dev/null; then DC="docker compose"; else DC="docker-compose"; fi
  if docker ps --format '{{.Names}}' | grep -q '^cvat_server$'; then
    echo "运行 showmigrations organizations（只读，只看已执行的 x 标记，不会 apply）:"
    if [[ "$(id -u)" -eq 0 ]]; then
      $DC exec -T cvat_server python manage.py showmigrations organizations 2>&1 | head -30
    else
      # 非 root，尝试两种方式（不带 sudo 可能需要你再输一次密码，所以先试 sudo -n）
      if sudo -n true 2>/dev/null; then
        sudo $DC exec -T cvat_server python manage.py showmigrations organizations 2>&1 | head -30
      else
        echo "需要 sudo，跳过（稍后你手动执行：sudo docker compose exec -T cvat_server python manage.py showmigrations organizations）"
      fi
    fi
  else
    echo "当前 cvat_server 容器没有在跑，无法判断 migrations。"
  fi
fi
echo ""
echo $SEP
echo "[6] 代理可用性探测（SSH 反向隧道 127.0.0.1:7890，是否真的可用）"
echo $SEP
for proxy_url in "http://127.0.0.1:7890" "http://localhost:7890"; do
  echo "--- proxy=$proxy_url ---"
  if command -v curl &>/dev/null; then
    if curl -sSf -m 5 --proxy "$proxy_url" https://hub.docker.com -o /dev/null 2>&1; then
      echo "  proxy OK: hub.docker.com HTTPS through $proxy_url"
    else
      echo "  proxy FAIL: $proxy_url"
    fi
  else
    echo "  curl 未装，无法探测"
  fi
done
# 也检查无代理外网是否直连
if command -v curl &>/dev/null; then
  echo "--- No proxy 外网直连 hub.docker.com ---"
  if curl -sSf -m 5 https://hub.docker.com -o /dev/null 2>&1; then
    echo "  Direct OK: 无需代理"
  else
    echo "  Direct FAIL: 可能必须走代理"
  fi
fi
echo ""
echo $SEP
echo "[7] cvat 数据卷目录（DB/上传数据）在哪，是否需要保护不覆盖？"
echo $SEP
docker volume ls --format '{{.Name}}' 2>/dev/null | grep -Ei 'cvat|postgres' | head -30 || true
echo "  Inspect each cvat volume mountpoint:"
docker volume ls --format '{{.Name}}' 2>/dev/null | grep -Ei 'cvat|postgres' | while read -r v; do
  docker volume inspect "$v" --format '  NAME={{.Name}}  MOUNTPOINT={{.Mountpoint}}' 2>/dev/null
done | head -20
echo ""
echo $SEP
echo "[8] 简单健康检查：cvat_server /about 接口状态（如果已在跑）"
echo $SEP
if docker ps --format '{{.Names}}' | grep -q '^cvat_server$'; then
  about_code=$(docker exec cvat_server bash -c "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/server/about" 2>/dev/null || echo "000")
  echo "  GET http://127.0.0.1:8080/api/server/about -> HTTP $about_code"
else
  echo "  cvat_server 未运行"
fi
echo ""
echo $SEP
echo "[9] 当前登录用户是否能把文件写进目标目录（判断是否需要 sudo）"
echo $SEP
if [[ -n "$TARGET_DIR" ]]; then
  TEST_FILE="$TARGET_DIR/.write-test-$$"
  if touch "$TEST_FILE" 2>/dev/null; then
    echo "  当前用户 $(id -un) 能直接写 $TARGET_DIR（不用 sudo 解压）"
    rm -f "$TEST_FILE"
  else
    echo "  当前用户 $(id -un) 不能写 $TARGET_DIR（部署时必须 sudo）"
  fi
fi
echo ""
echo "检查完成！请把上面所有输出（1-9）完整贴回给我。"
