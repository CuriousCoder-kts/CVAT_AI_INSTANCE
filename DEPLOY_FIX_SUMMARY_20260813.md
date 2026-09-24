# CVAT 部署修复总结 (2026-08-13)

> 内网：http://192.168.50.30:8080/
> 公网：http://180.167.156.66:8080/
> 账号：`admin` / 密码：`cvat@2026`

---

## 一、问题清单 + 根因 + 永久修复方案

### 1. 502 Bad Gateway（最开始的故障）

**现象**：任何 API 请求都返回 502，OPA 日志报 `proxyconnect tcp: dial tcp 127.0.0.1:7890: connection refused`。

**根因（层层递进）**：
1. 远程服务器 `nextvpu` 用户的 `~/.docker/config.json` 配置了 daemon 级 `httpProxy=http://127.0.0.1:7890`（本地 7890 是桌面代理软件，容器里没有此进程）
2. Docker Compose 自动继承 daemon 级代理，通过容器 env 注入到 **所有服务**
3. OPA 内部通过 HTTP 拉取 `http://cvat-server:8080/api/auth/rules` 的 rules bundle，被 HTTP_PROXY 劫持走了 `127.0.0.1:7890` → connection refused
4. OPA 无 policy → Traefik 前向请求给 OPA 做 policy check 失败 → 502 Bad Gateway

**三层永久防御**（任何一层被破坏其余层兜底）：

| 层级 | 方案 | 生效位置 |
|---|---|---|
| 第 1 层 | 直接删除 daemon 级 `~/.docker/config.json` 中的 7890 代理（`httpProxy` / `httpsProxy` 清空，`noProxy` 留 `*`） | 服务器用户目录 |
| 第 2 层 | `docker-compose.yml` 4 处显式覆盖代理 env 为空字符串（`HTTP_PROXY` / `HTTPS_PROXY` / `http_proxy` / `https_proxy` / `ALL_PROXY` / `all_proxy = ''`，`NO_PROXY='*'` / `no_proxy='*'`）。注意显式 `environment:` 优先级高于 daemon 继承 | `x-backend-env` / `cvat_ui` / `traefik` / `cvat_opa` |
| 第 3 层 | 所有 compose 命令永远用 `env -i ... docker compose` 启动，完全丢弃宿主机 env | `/usr/local/bin/cvat` 脚本 |

---

### 2. 415 Unsupported Media Type `application/vnd.cvat+json`

**现象**：前端（或 curl）提交登录 `POST /api/auth/login`，`Content-Type: application/vnd.cvat+json` 返回 415；但 `Content-Type: application/json` 正常。

**根因**：CVAT 响应有自定义 `CVATAPIRenderer` 把响应 `media_type` 改为 `application/vnd.cvat+json`（已注册），但**请求**端 DRF 原生 `JSONParser` 只接受严格 `application/json`，不识别 `+json` 后缀 → 找不到 parser → 415。这是项目的**不对称设计缺陷**。

**修复**：
1. 在 `cvat/apps/engine/parsers.py` 新增 `CVATJsonParser(JSONParser)`，只改 `media_type = "application/vnd.cvat+json"`，`parse()` 完全复用 DRF 父类（因为 vnd.cvat+json 本质就是 JSON，内容格式无差异）
2. 在 `cvat/settings/base.py` 的 `REST_FRAMEWORK.DEFAULT_PARSER_CLASSES` 列表**首位**注册 `cvat.apps.engine.parsers.CVATJsonParser`，第二位置保留原生 `rest_framework.parsers.JSONParser`（确保纯 `application/json` 兼容不被破坏）
3. 通过 `docker compose build` 把两处代码**固化到 `cvat/server:dev` 镜像**，以后不管怎么 `--force-recreate` 重建容器都不会丢

---

### 3. permission denied `backend_entrypoint.sh`

**现象**：重新 build 镜像后 `--force-recreate` 重建容器报错 `exec: "/opt/cvat/backend_entrypoint.sh": permission denied`，所有 cvat/server 容器无法启动。

**根因**：
1. 远程服务器项目目录 `/opt/cvat-develop` 是 root:root，宿主上的 `backend_entrypoint.sh` 权限是 `666 rw-rw-rw-`（完全没有 `x` 位）
2. Dockerfile 的 `COPY --parents backend_entrypoint.sh ... /opt/cvat/` **保留宿主权限位**
3. COPY 后立即 `USER 1000:1000`（切换到 django 用户），`ENTRYPOINT` 以 1000 UID 执行 → 不是文件 owner，也没有 group/other x 位 → permission denied
4. 原 Dockerfile **没有** COPY 后的 `chmod +x` 兜底

**修复（双重保障）**：
1. **Dockerfile 永久兜底**：在 `COPY --parents ... /opt/cvat/` 之后、`USER 1000:1000` 之前加入 `RUN chmod +x` 覆盖 `backend_entrypoint.sh` / `wait_for_deps.sh` 以及 `backend_entrypoint.d/*.sh`
2. **宿主机源码同步补 x 位**：`chmod +x` 所有 sh（否则下一次 build 在没有 RUN chmod 的旧版仍会失败）

---

### 4. Traefik 本地 `127.0.0.1:8080` 返回 404

**现象**：`curl http://192.168.50.30:8080/api/server/about` 是 200，但本地 `curl http://127.0.0.1:8080/...` 返回 404。

**根因**：Traefik 的 `Host()` 路由规则只写了内网 IP `192.168.50.30` 和公网 `180.167.156.66`，用 127.0.0.1 访问时 HTTP `Host:` 头是 `127.0.0.1:8080`，Host 不匹配 → 404（比 502 好，说明链路通只是路由没命中）。

**修复**：在两处 `traefik.http.routers.*.rule` Host 规则中追加 `|| Host(\`127.0.0.1\`) || Host(\`localhost\`)`：
- `cvat_server` 路由（/api / /static / /admin / /django-rq）
- `cvat_ui` 路由（根路径 UI）

---

### 5. `Network is still in use` 容器重建失败

**现象**：`docker compose down` 后 `cvat_cvat` 网络报 `Resource is still in use`，下次 up 异常。

**根因**：Docker 网络有短暂延迟释放。

**修复**：`cvat recreate` 模式中做最多 3 次重试删除 + 每次 2 秒 sleep。

---

## 二、代码修改清单（本地 `D:\cvat-develop\` + 远程同步）

| 序号 | 文件 | 修改说明 | 行号 |
|---|---|---|---|
| 1 | `docker-compose.yml` | `x-backend-env` 锚点中显式清空 8 个代理变量 + `NO_PROXY='*'` | L20-L27 |
| 2 | `docker-compose.yml` | `cvat_ui` 服务显式清空 8 个代理变量 | L274-L282 |
| 3 | `docker-compose.yml` | `traefik` 服务显式清空 8 个代理变量 | L299-L306 |
| 4 | `docker-compose.yml` | `cvat_opa` 服务显式清空 8 个代理变量（**最关键！OPA 拉取 bundle**） | L359-L366 |
| 5 | `docker-compose.yml` | `cvat_server` Traefik Host 规则追加 `127.0.0.1` + `localhost` | L117-L118 |
| 6 | `docker-compose.yml` | `cvat_ui` Traefik Host 规则追加 `127.0.0.1` + `localhost` | L286 |
| 7 | `cvat/apps/engine/parsers.py` | 新增 `CVATJsonParser(JSONParser)`，`media_type = "application/vnd.cvat+json"` | L15-L16 |
| 8 | `cvat/settings/base.py` | `REST_FRAMEWORK.DEFAULT_PARSER_CLASSES` 首位注册 `CVATJsonParser`，次位置保留原生 `JSONParser` 保证兼容 | L173-L177 |
| 9 | `Dockerfile` | COPY entrypoint 后加入 `RUN chmod +x backend_entrypoint.sh / wait_for_deps.sh / backend_entrypoint.d/*.sh` 兜底 | L214-L219 |

---

## 三、远程服务器执行过的固化操作

| 项 | 说明 |
|---|---|
| `~/.docker/config.json` 代理清理 | 删除 `proxies.default.httpProxy` / `httpsProxy` 的 `127.0.0.1:7890` 配置；`docker info` 验证无 Proxy 输出 |
| `cvat/server:dev` 重新 build 6 分钟 | 源码对齐到项目目录后 `docker compose build cvat_server cvat_worker_*`，打包了 `CVATJsonParser` + 注册 settings |
| `cvat/server:dev` patch 镜像 | build 后补 1 层在 `USER 0` 下 `chmod +x` 所有 entrypoint sh，补全了 entrypoint 执行位 |
| 所有容器 `--force-recreate` 重建 | 验证 19/19 容器全部 Started，无 permission denied |
| `/usr/local/bin/cvat` 全局脚本 | sudo 写入，任何目录执行 `cvat start / recreate / status / down / logs` |

---

## 四、日常命令（超级简化）

远程服务器任何路径下，执行：

```bash
# 1. 快速启动（不重建容器，99% 日常场景）
cvat start

# 2. 彻底重建（更新镜像 / 修改 compose / 源码后，或者网络异常）
cvat recreate

# 3. 一键查看 6 项健康指标 + UI 访问地址
cvat status

# 4. 关闭所有容器
cvat down

# 5. 看某个服务的实时日志（最后 100 行，-f 跟随）
cvat logs cvat_server    # 默认 100 行跟随
cvat logs cvat_opa 30    # 最后 30 行跟随
cvat logs traefik
cvat logs cvat_worker_export
```

`cvat status` 预期输出（6 项全绿）：

```
┌─────────────────────────────────────────────────────────┐
│ cvat_server 容器内 8080              HTTP 200    │
│ 内网 192.168.50.30:8080              HTTP 200    │
│ 本地 127.0.0.1:8080 (Host 规则)      HTTP 200    │
│ vnd.cvat+json 登录                   HTTP 200    │
│ OPA proxyconnect 错误                0 次       │
└─────────────────────────────────────────────────────────┘

内网 UI: http://192.168.50.30:8080/
公网 UI: http://180.167.156.66:8080/
账 号: admin   密 码: cvat@2026
```

---

## 五、以后如果改代码后的更新步骤

### A. 修改 Python 后端源码（如 parsers.py、settings/*.py、views 等）
```bash
# 1. 本地 Windows：SCP 修改的文件到 /opt/cvat-develop/ 对应路径（sudo cp 进项目）
# 2. 因为我们的源码已 build 固化进镜像，为避免再次 build，两种方式：
#    方式 1：最快，直接 docker cp 进所有 server/worker 容器，然后 restart（生产热修）
#    方式 2：标准流程，重新 build 镜像，FORCE_RECREATE=1 重建（推荐正式更新）
cvat recreate   # 如果选择方式 2，build 完成后直接这个
```

### B. 修改 docker-compose.yml 或 compose 配置
```bash
# 本地 SCP docker-compose.yml 到服务器 /tmp，sudo cp 进 /opt/cvat-develop/
# 然后只重启需要重建 label/env 的服务
cvat recreate   # 或 docker compose up -d --force-recreate traefik cvat_server cvat_ui
```

### C. 修改前端 UI（React 代码、新组件等）
```bash
# 重新 build cvat/ui:dev（镜像独立）
env -i ... docker compose -f docker-compose.yml -f docker-compose.dev.yml build cvat_ui
docker compose up -d --force-recreate cvat_ui
```

### D. 修改 Dockerfile（比如加新的 `RUN chmod` 层）
```bash
# 重新 build cvat_server + 所有 workers（共用一个镜像 build 一次）
env -i ... docker compose -f docker-compose.yml -f docker-compose.dev.yml build cvat_server
# 然后所有容器重建
cvat recreate
```

---

## 六、8 项最终回归验证（2026-08-13 全部 PASS）

| # | 检查内容 | 结果 |
|---|---|---|
| 1 | cvat_server 无 7890 代理 env | ✅ |
| 2 | cvat_opa 无 7890 代理 env | ✅ |
| 3 | traefik 无 7890 代理 env | ✅ |
| 4 | OPA 30s 内 0 次 proxyconnect | ✅ |
| 5 | 容器内 / 内网 Host / 127.0.0.1 三条路径 200 | ✅ 200 200 200 |
| 6 | 纯 application/json 登录 200 + key | ✅ 200 + key=4171...7c683 |
| 7 | **application/vnd.cvat+json 登录 200 + key** | ✅ 200 + key=4171...7c683（415 修复核心）|
| 8 | 公网 180.167.156.66 Host 路由 200 | ✅ 200 |

**8/8 全绿。**
