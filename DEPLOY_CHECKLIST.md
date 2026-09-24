# CVAT (定制版) 部署检查清单 (DEPLOY_CHECKLIST.md)

> 本项目在 CVAT 官方原版基础上**新增了百炼（Bailian）配置管理全栈功能**和**Qwen 百炼 3.7 检测器 Nuclio 函数**。
> 部署相对原版多了 3 个关键步骤：**构建自定义镜像**、**执行 0003 迁移**、**配置百炼 API Key**。

---

## 一、打包（本地 Windows 端）

### 1.1 执行打包脚本

```powershell
# 以 PowerShell 进入项目目录
cd D:\cvat-develop

# 首次运行可能需要解除执行策略限制（当前会话有效）
Set-ExecutionPolicy Bypass -Scope Process

# 执行打包（推荐模式：使用 git ls-files 白名单，避免传 node_modules/.git 等大文件）
.\pack-deploy.ps1

# 如果 git 状态异常导致文件过少，改用排除模式：
.\pack-deploy.ps1 -SkipGitExclude

# 自定义输出目录：
.\pack-deploy.ps1 -OutputDir D:\deploy-tmp
```

脚本会自动产出 2 个文件：
```
D:\deploy-tmp\cvat-deploy-YYYYMMDD-HHMMSS.tar.gz     # 源码包 (~100-200MB)
D:\deploy-tmp\cvat-deploy-YYYYMMDD-HHMMSS.tar.gz.sha256  # 校验和
```

### 1.2 传输到服务器

```powershell
# 示例用 scp（换成你实际的 user / ip / 目标路径）
$Pkg   = "D:\deploy-tmp\cvat-deploy-20260811-170000.tar.gz"
$Sha   = "$Pkg.sha256"
scp $Pkg   ubuntu@10.0.0.100:/tmp/
scp $Sha   ubuntu@10.0.0.100:/tmp/
```

---

## 二、解压（服务器 Linux 端）

```bash
ssh ubuntu@10.0.0.100
sudo -i
cd /tmp

# 1) 校验完整性（和本地脚本输出比对）
sha256sum -c cvat-deploy-*.tar.gz.sha256
# 期望输出: OK

# 2) 解压到固定部署目录（选一个磁盘够大的位置，因为会存标注数据和 Docker 镜像）
TARGET=/home/cvat/cvat-develop
mkdir -p $TARGET
# 注意 -C 后必须加 $TARGET（而不是 ~），sudo 下 ~ 指向 /root
tar -xzf cvat-deploy-*.tar.gz -C $TARGET

# 3) 确认解压完整
cd $TARGET
ls docker-compose.yml \
   .env.example \
   Dockerfile Dockerfile.ui \
   deploy-cvat.sh \
   cvat/apps/organizations/migrations/0003_bailiansettings.py \
   serverless/qwen/bailian/qwen37-detector/nuclio/function.yaml
# 以上文件都必须能列出来，否则打包/传输出问题
```

---

## 三、部署（自动脚本方式，推荐）

### 3.1 全新部署（第一次装）

```bash
cd $TARGET
# 首次部署，脚本会：
#   - 拷 .env.example -> .env  并提示你编辑
#   - docker compose build cvat_server / cvat_ui
#   - 起全部服务 + Nuclio
#   - 执行 migrate（0003_bailiansettings 必须成功）
#   - 尝试 nuctl deploy qwen37-detector
sudo bash deploy-cvat.sh
```

**如果你想一次性把百炼 Key 注入到 Nuclio 函数（不推荐多组织场景；但单组织可用）：**

```bash
sudo bash deploy-cvat.sh \
  --bailian-key  "sk-your-actual-key-from-dashscope" \
  --bailian-url  "https://ws-bpy1cch81n3j8dxs.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions" \
  --bailian-model "qwen3-vl-plus"
```

### 3.2 重新部署（覆盖安装，保留数据）

```bash
# 会 down 旧容器，但保留 cvat_db/cvat_data 等命名卷（标注数据还在）
sudo bash deploy-cvat.sh
```

### 3.3 彻底重装（⚠️ 丢数据！）

```bash
# 加 --clean 会连命名卷一起删，标注/任务/用户全清空，慎用
sudo bash deploy-cvat.sh --clean
```

### 3.4 只做源码更新（镜像已构建好时）

```bash
# 比如只改了 main.py，不需要重新 build 基础镜像
sudo bash deploy-cvat.sh --skip-build
```

### 3.5 不需要自动标注功能

```bash
# 不启动 Nuclio，省几百 MB 内存
sudo bash deploy-cvat.sh --no-serverless
```

---

## 四、部署后必须手动检查的 5 件事

### ✅ 检查 1：容器全部 Healthy

```bash
cd $TARGET
docker compose -f docker-compose.yml \
               -f docker-compose.override.yml \
               -f components/serverless/docker-compose.serverless.yml ps
# 全部 State 列应是 Up (healthy)，不要 Restarting / Exited
```

快速看异常：
```bash
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -E "cvat_|nuclio|traefik|clickhouse|grafana|opa"
```

### ✅ 检查 2：Traefik 路由无冲突 + 能访问 UI

```bash
docker logs traefik --tail 60 2>&1 | grep -iE "error|Router defined|undefined network|502"
# 正常: 没有 ERROR, 没有 "Router defined multiple times"
```

浏览器打开 `http://<CVAT_HOST>:8080`：
- ✅ 看到登录页 → Traefik + cvat_ui OK
- ❌ 404 → 检查 `CVAT_HOST` 是否匹配你浏览器里输的 host
- ❌ 502 → `cvat_ui` 或 `cvat_server` 不在 `cvat_cvat` 网络，或代理设置错误

### ✅ 检查 3：0003 迁移已经 applied

```bash
docker compose exec -T cvat_server python manage.py showmigrations organizations 2>&1 | tail -15
# 期望: 0003_bailiansettings  前面有 [X] 标记
```

如果没 applied，手动补：
```bash
docker compose run --rm cvat_server python manage.py migrate organizations
```

### ✅ 检查 4：Bailian settings 页面可访问

1. 浏览器打开 CVAT → 注册/登录管理员账号
2. 确认进入了一个 Organization（通常第一次登录会有个人默认 org）
3. **Header → Organization 菜单 → 确认有 "Bailian settings" 子菜单**
4. 点进去，填 3 项 → Save，提示成功：
   - API URL: 百炼兼容模式完整 URL
   - Model: 如 `qwen3-vl-plus`
   - API Key: 你的 sk-xxx

**重要：这是给 lambda_manager 用的。** 启动自动标注时，CVAT 后端会在 DB 里查出你在这里填的 Key/URL/Model，注入到 Nuclio 请求 payload 的 `bailian` 字段。函数端 `main.py` 优先用 payload 里的配置（你在 UI 配的），fallback 才用 Nuclio 环境变量。

### ✅ 检查 5：Models 页面有 Qwen 函数 + 可运行自动标注

1. CVAT → **Models** 页面
2. 确认有 **"Qwen Bailian 3.7 Detector"**，标签列表应为 9 类：
   pedestrian / cyclist / motor_vehicle / non_motor_vehicle /
   traffic_cone / traffic_bucket / traffic_column / plastic_barrier / guard_rail
3. 新建 Task → Labels 选 "From model" → 选中 Qwen → 标签应正确导入
4. 上传几张图 → 打开 Task → Actions → Automatic annotation → 选 Qwen → Annotate
5. Requests 页面看状态：Completed 且 Job 里出现矩形框 → 全部打通 ✅

---

## 五、常见问题快速定位（根据之前踩坑经验）

### 5.1 502 Bad Gateway（访问 UI）

```bash
# 1. 确认 cvat_ui / cvat_server 在 cvat_cvat 网络
docker network inspect cvat_cvat --format '{{json .Containers}}' | jq keys

# 2. 没加入就手动连（重启失效是因为 docker-compose.yml 里没写 networks: - cvat）
docker network connect cvat_cvat cvat_ui
docker network connect cvat_cvat cvat_server
# （根本解决：确保 docker-compose.yml 的两个服务都声明了 networks: - cvat，我们项目里已经写了）

# 3. 查 Traefik 日志是否因环境变量 HTTP_PROXY 被注入了本地代理
docker inspect traefik -f '{{json .Config.Env}}' | jq | grep -iE "PROXY|NO_PROXY"
# 如有 127.0.0.1:7890 等宿主机代理，必须在 .env 的 no_proxy 里加 172.18.0.0/16
```

### 5.2 Models 页面为空

```bash
# 1) Nuclio dashboard 在跑吗?
docker ps -a | grep nuclio
# 2) 函数存在吗?
sudo nuctl get function --platform local
# 3) 函数容器在 cvat_cvat 网络?
docker inspect nuclio-nuclio-qwen-bailian-qwen37-detector \
  -f '{{json .NetworkSettings.Networks}}' | jq keys
# 4) 函数自己能跑通 API?（取容器 IP）
FUNC_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' nuclio-nuclio-qwen-bailian-qwen37-detector)
curl -m 5 -sS http://$FUNC_IP:8080 -X POST -H "Content-Type: application/json" \
  -d '{"threshold":0.5,"image":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="}'
# 期望返回: []
```

### 5.3 自动标注 Request 失败

```bash
# 1) 看 annotation worker 日志
docker logs cvat_worker_annotation --tail 80

# 2) 常见报错 & 对应原因：
#    - "Connection refused to nuclio-nuclio-xxx:8080" → 函数容器不在 cvat_cvat 网络
#      解决: docker network connect cvat_cvat nuclio-nuclio-qwen-...
#
#    - "bailian config missing" → 没在 UI 配百炼 Key，也没给函数传 env
#      解决: Organization → Bailian settings 填 Key/URL/Model，Save，再试
#
#    - HTTP 401 from Bailian API → API Key 不对
#      解决: 在 DashScope 控制台重新生成 Key
#
#    - 长时间没结果 → 网络不通 DashScope 或超时（函数默认 60s，API 本身重试 3 次）
#      解决: 检查服务器能否直连 bailian 域名 (ping / curl)，配代理时确保 .aliyuncs.com 不走代理或正确走代理
```

### 5.4 OPAHealthCheck 500（登录后界面右上角红点）

```bash
docker restart cvat_opa cvat_server
sleep 20
# 再刷新页面，通常就好
# 根本原因：cvat_server 启动比 OPA 快，首次拉 rules bundle 失败被缓存了
```

---

## 六、数据备份 / 迁移

服务器部署后，所有用户/任务/标注/媒体数据都在 5 个 Docker 命名卷里：

| 卷名 | 内容 |
|-----|------|
| cvat_db | PostgreSQL 用户/任务/组织数据（含 BailianSettings Key） |
| cvat_data | 上传的图片/视频媒体文件 |
| cvat_keys | 加密密钥 |
| cvat_logs | Django / 应用日志 |
| cvat_inmem_db / cvat_cache_db / cvat_events_db | Redis / Kvrocks / ClickHouse（可丢，重建即可） |

**简单备份（推荐停机做）：**
```bash
# 停服务
docker compose down

# 每个关键卷打包成 tar
for VOL in cvat_db cvat_data cvat_keys cvat_logs; do
  docker run --rm \
    -v $VOL:/from \
    -v $(pwd):/to \
    alpine tar czf /to/cvat-backup-$(date +%F)-$VOL.tar.gz -C /from .
done
```

**恢复到新服务器：**
```bash
for VOL in cvat_db cvat_data cvat_keys cvat_logs; do
  docker volume create $VOL
  docker run --rm \
    -v $VOL:/to \
    -v $(pwd):/from \
    alpine tar xzf /from/cvat-backup-YYYY-MM-DD-$VOL.tar.gz -C /to
done
```

---

## 七、脚本速查表

| 目标 | 命令 |
|-----|------|
| 打包（Windows） | `.\pack-deploy.ps1` |
| 全新部署（Linux） | `sudo bash deploy-cvat.sh` |
| 部署+覆盖数据 | `sudo bash deploy-cvat.sh --clean` |
| 只重启不重建镜像 | `sudo bash deploy-cvat.sh --skip-build` |
| 不装自动标注 | `sudo bash deploy-cvat.sh --no-serverless` |
| 手动启动服务 | `docker compose -f docker-compose.yml -f docker-compose.override.yml -f components/serverless/docker-compose.serverless.yml up -d` |
| 手动跑迁移 | `docker compose run --rm cvat_server python manage.py migrate` |
| 查看所有服务状态 | `docker compose -f docker-compose.yml -f components/serverless/docker-compose.serverless.yml ps` |
| 查看 Traefik 日志 | `docker logs traefik --tail 60` |
| 查看后端日志 | `docker logs cvat_server --tail 60` |
| 查看函数日志 | `docker logs nuclio-nuclio-qwen-bailian-qwen37-detector --tail 60` |
| 单独重启服务 | `docker compose restart cvat_server` |

---

**祝你部署顺利！遇到本清单没覆盖的报错，优先看对应容器的 `docker logs --tail 100`。**
