# CVAT x Qwen Bailian 自动标注 - 一周会话聚合（2026-08-03 ~ 2026-08-07）

> 本文件聚合 2026-08-03 至 2026-08-07 期间所有 Trae 会话内容，包含：
> - 项目背景与最终验收结论
> - 每日会话摘要（系统自动归档的 topics.md 原文）
> - 全链路架构图（文字版）
> - 终极根因拆解（Items:0 不出框的完整因果链）
> - 所有踩过的坑 + 对应修复方案（可交付）
> - 7 条必须遵守的永久规则
> - 关键词快速检索索引
>
> **新会话接续方法**：把本文件路径甩给 AI，并在第一句话里带上你需要的关键词（见底部索引）。

---

## 一、项目背景 & 最终结论 ✅
### 项目目标
在 **CVAT（Intel 开源标注平台）现有架构** 上，为用户本地已接入的 **Qwen 百炼自动标注小链路（Nuclio 函数：serverless/qwen/bailian/qwen37-detector）** 新增：
1. 一套 **组织级（Organization Level）、管理员可在前端动态传入参数**（尤其是 `API_KEY` / `API_URL` / `MODEL`）的配置机制（名为 **BailianSettings**，DB 模型 + API + 权限 + 前端页 `/organization/bailian`）
2. 把 Windows 笔记本 `d:\cvat-develop` 代码部署到 **Ubuntu 虚拟机服务器**，完成端到端验证
3. 最终形成可交付的 **AI 自动标注任务流水线**

### 最终验收结果（2026-08-07 下午）
✅ **全链路 100% 跑通闭环：**
```
Organization: nextvpu (org_id=1)
  └─ BailianSettings（前端 /organization/bailian 填写 API_URL/API_KEY/MODEL）
        └─ Project（含 object 标签）
              └─ demo-task-02 Task #3
                    └─ Job #3
                          └─ Automatic annotation
                                └─ cvat_worker_annotation → lambda_manager/views.py
                                      └─ 注入 payload["bailian"]（锚点：bailian annotations == true）
                                            └─ Nuclio 函数容器（容器名:8080 内部直连）
                                                  └─ 百炼 Qwen3 VL Plus API（/chat/completions）
                                                        └─ 解析 JSON → dog 框 conf=0.98 [132,57,640,480]
                                                              └─ 写回 CVAT Job #3
                                                                    └─ UI：左侧 Objects: Items: 1 dog (AUTO)
                                                                           └─ 画布上：绿色 AUTO 矩形框 ✅
```

✅ 右上角 toast：`Automatic annotation accomplished`
✅ 真实手动验证（隔离测试）：
   - DIRECT（绕过 Nuclio，同图同 key 调百炼）：shapes len=1 dog
   - VIA NUCLIO（同 payload POST 容器名:8080）：`NUCLIO HTTP 200 in 1.42s len=92 shapes len=1` ✅

### 核心结论
> **本地 Windows 的 `cvat-develop-clean.zip` 业务代码本身完全没问题；Ubuntu 虚拟机上 Items:0 不出框 100% 是环境层代理污染（SSH 反向隧道 + 多处代理叠加导致 Nuclio 容器继承了无效 HTTP(S)_PROXY=127.0.0.1:7890，调百炼被强制走本地代理、Connection refused）。**
>
> 因此：**公司干净环境（无 7890 代理）部署 clean.zip 代码 → 直接出框；如果公司有统一出口代理 → 必须 NO_PROXY/no_proxy 双写并包含 `.aliyuncs.com` 及所有内网容器名。**

---

## 二、每日会话摘要（系统自动归档 topics.md 原文）

### 📅 2026-08-04
1. 用户在 Ubuntu 虚拟机上通过 nuctl 部署 Qwen 探测器函数时遇到严重的网络连接问题（无法访问 gcr.io 和 docker.io），采取了离线导入镜像 + 本地 Docker Registry 伪装 gcr.io 的策略，解决了 nuctl 强制拉取基础镜像导致的构建中断。
2. 解决了由于环境变量 URL 格式错误（包含反引号和换行）导致的百炼调用失败问题，重新部署函数并使用 base64 图片 `237-640x480.jpg` 验证了链路。手动给 Task 加了 `object` 标签以匹配模型输出兜底。
3. 定位并指导用户在 **CVAT Task 详情页的 Actions 菜单**找到 Automatic annotation 入口（而非 Job 画布）。配置模型映射（object -> object）并成功运行，Job 出现 AUTO 绿色矩形框。针对“全图大框”误检，讨论了 threshold、ROI、面积占比后处理方案，用户决定先跑通链路再优化。

### 📅 2026-08-05
深入调研 CVAT 标注流水线底层代码：
- Django 后端模型：`Organization / Membership / auth_user / Project / Task / Job / Label / ...`
- 权限控制机制：OPA（Open Policy Agent）/ Rego 规则，`scope`（view/update）校验
- 前端三层调用架构：Redux 页面动作 → cvat-core SDK 封装 → server-proxy /api/v1 接口映射

理清了从 UI 触发到数据库落库及权限校验的完整数据流向。

### 📅 2026-08-06
按文件夹层级详细解析 CVAT 项目结构：
```
cvat-develop/
├── cvat-ui/                 # 前端 React 页面
├── cvat-core/               # 核心 JS SDK
├── cvat/                    # 后端 Django
│   └── apps/
│       ├── lambda_manager/  # Lambda 函数调用（views.py = 调 Nuclio 核心入口）
│       ├── organizations/   # Organization / BailianSettings（我们新增的）
│       └── engine/          # Task/Job/Label/Project 等 engine
├── serverless/              # Serverless 函数
│   └── qwen/bailian/qwen37-detector/nuclio/main.py   # 百炼 detector handler
├── docker-compose.yml       # 核心 compose
└── supervisord/             # 后端 RQ worker 启动脚本
```
制定了「组织级 Bailian settings」方案 + 本地到服务器部署 SOP。

### 📅 2026-08-07（核心攻坚日 🔥）
1. 部署阶段：通过 SSH 反向隧道将本机 Clash HTTP 代理映射到服务器 127.0.0.1:7890，配置 Docker Daemon `http-proxy.conf` 及 `~/.docker/config.json`，成功 pull 镜像。`docker build` 阶段 apt-get 因容器网络隔离报错，用 `--network=host` 打通。
2. 数据迁移：成功跑 Django DB migration（0003_bailiansettings 表生效）；Nuclio 部署因 Project does not exist 失败 → 修复 `nuctl create project cvat -n nuclio --platform local` 后再 deploy，验证函数注解 `bailian: "true"` 存在。
3. UI 页面排查：用户找不到 Bailian settings 页面 → 指导在 UI 顶部切换到 **Organization 上下文**（Personal workspace → nextvpu），再访问 `/organization/bailian` 成功打开，保存 API_URL/KEY/MODEL 后后端 GET 接口返回 `has_api_key: true`（不回显 key，安全）。
4. 组织数据准备：创建 Project，添加 `object` 标签（保证兜底 label 合法），创建 Task 上传多张图。
5. 第一次 Automatic annotation → 红条 `Automatic annotation failed` → 抓 cvat_worker_annotation 日志实锤 `ProxyError 127.0.0.1:7890`（内部调 Nuclio 被代理劫持）。
6. 代理修复 1：`~/.docker/config.json` 修改被 `docker-compose.yml` 里小写 `no_proxy` 覆盖 → 改用 .env 注入，并修 daemon 层大小写双写 NO_PROXY/no_proxy 加 `host.docker.internal, .aliyuncs.com` → 重启 9 个服务。
7. 调 Nuclio 链路排查：lambda_manager `_invoke_directly` 硬编码 `host.docker.internal:32768`（Linux 宿主 bridge 端口不稳定）→ LINE-SLICE 重写，强制替换成 **容器名 `nuclio-nuclio-qwen-bailian-qwen37-detector:8080`**（cvat_cvat 内部网络）。
8. 多次踩坑：
   - patch 字符串缩进错误（替换放到 with 块外不执行）
   - regex repl `\d` 导致 `re.error: bad escape`
   - **RQ worker 长驻进程缓存 bytecode：改磁盘 .py 不 restart 服务 = 旧代码执行（Traceback 行号错位幻觉）**
9. 最终 Items:0 攻坚：
   - DIRECT vs VIA-NUCLIO 隔离测试（同图 `237-640x480.jpg` 同 payload）→ DIRECT 有框、VIA NUCLIO 0 → 锁定异常在 Nuclio 容器内部
   - 抓 Nuclio 日志实锤：`requests.exceptions.ProxyError(... 127.0.0.1:7890 Connection refused)` → **根因 100% 是 Nuclio 容器代理污染（daemon NO_PROXY 列表没含 .aliyuncs.com）**
   - Nuclio main.py 里 except Exception 静默吞异常 → 修 main.py：
     - `[QWL-DIAG]` 全链路 print 诊断（flush=True）
     - 调百炼前强制清 `os.environ` 所有 *_proxy 键 + `requests.Session(trust_env=False, proxies={http:None,https:None})`
     - URL/key/model 暴力清洗（encode ascii + 白名单字符 + regex https?:// 抽子串 + strip `'`"` 空格反引号）
   - 手动验证：`NUCLIO HTTP 200 in 1.42s shapes len=1 dog [132,57,640,480]` ✅
10. 用户最终决策：保持 `cvat-develop-clean.zip` 源码纯净（不把运行时代理补丁提交到业务代码），生产环境通过**正确配置 NO_PROXY**（而非改代码）来避免代理劫持；加固代码（清代理 + 清洗）作为可选兜底。

---

## 三、终极根因拆解（Items:0 完整因果链）
### 根因链条（按执行顺序自顶向下）
```
① 构建期设置代理过度（为了出外网 pull 镜像 / apt-get）
   └─ Docker Daemon /etc/systemd/system/docker.service.d/http-proxy.conf
         ├─ HTTP_PROXY=http://127.0.0.1:7890    （SSH 反向隧道 + 本地 Clash）
         ├─ HTTPS_PROXY=http://127.0.0.1:7890
         ├─ NO_PROXY=localhost,127.0.0.1,.local,10.0.0.0/8,...  ← ❌ 缺 .aliyuncs.com
         └─ no_proxy=...（小写，甚至可能没写）
② Nuclio 函数由 nuctl deploy（本质 docker run）创建 → 继承 Daemon 环境变量
   └─ Nuclio 容器内 env 里有 HTTP(S)_PROXY=127.0.0.1:7890，但容器本身没有本地代理
③ main.py 调百炼 requests.post(https://...aliyuncs.com/...)
   └─ requests/urllib3 读取 os.environ → 强制走 127.0.0.1:7890 代理
         └─ 容器内没本地代理 → Connection refused 127.0.0.1:7890 → ProxyError
④ main.py 末尾 except Exception as e: try context.logger.error(str(e)) except: pass ; return []
   └─ ❌ 静默吞掉 ProxyError → 直接 return [] len=2（HTTP 200，无任何异常日志！）
⑤ CVAT lambda_manager 收到 shapes len=0 → 写回 Job 0 条标注
   └─ UI：Job #3 Objects: Items: 0（没有 AUTO 框）
```

### 关键陷阱复盘
| # | 陷阱 | 现象 | 正确做法 |
|---|------|------|----------|
| T1 | `except Exception: return []` 静默吞异常 | Nuclio 返回 HTTP 200 len=2 看起来「成功」，实际全错 | 任何生产函数必须打诊断日志（flush=True 或写文件），不要裸 return [] |
| T2 | RQ worker 长驻进程 bytecode 缓存 | 改磁盘 .py 不 restart → Traceback 行号错位（新文件 L156 看起来抛错，实际跑旧 bytecode） | 所有代码 patch 后必须 `docker compose restart 9 个服务` |
| T3 | `repr()` + 视觉误导 | `repr(url)` 前后的「反引号+空格」看起来像脏字符，实际 ord 全是合法 ASCII；我们绕了 3 轮 DB 清洗，实际根因是代理 | 任何网络错误第一看 Traceback 是不是 ProxyError，不要先怀疑字符串 |
| T4 | NO_PROXY 大小写单写 | curl 读小写 no_proxy，requests/urllib3 读大写 NO_PROXY，少一个就出现「一部分请求走代理一部分不走」 | 必须同时写 NO_PROXY 和 no_proxy 大小写两份 |
| T5 | 127.0.0.1 指向容器自身 | 写了 HTTP_PROXY=127.0.0.1:7890，容器里没有监听 7890 → 必然 Connection refused | 容器内代理不要写 127.0.0.1，要么不用代理要么配 .aliyuncs.com 进 NO_PROXY |
| T6 | heredoc 复制粘贴带入视觉脏字符 | `$$` 代替 `[]`、URL 字面量自身被复制带入反引号/引号 | 所有源码 patch 优先 LINE-SLICE（按行切片）或写文件再 docker cp，不要嵌套 heredoc |
| T7 | _invoke_directly 硬编码 host.docker.internal:32768 | Linux /etc/hosts 默认不注入 host.docker.internal；32768 是宿主映射端口（易变） | CVAT 调 Nuclio 永远强制「容器名:8080」内部网络直连 |

---

## 四、所有修复方案汇总（可交付）
### 方案 A：基础设施层（推荐，代码零改动，纯运维配置）—— clean.zip 直接部署
#### A1 Docker Daemon（Ubuntu 服务器永久配置）
文件：`/etc/systemd/system/docker.service.d/http-proxy.conf`
```ini
[Service]
Environment="HTTP_PROXY=http://127.0.0.1:7890" "HTTPS_PROXY=http://127.0.0.1:7890"
Environment="NO_PROXY=localhost,127.0.0.1,.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.corp.com,.internal,host.docker.internal,.docker.internal,cvat_cvat,cvat,.cvat,nuclio,clickhouse,grafana,vector,opa,.aliyuncs.com,.dashscope.aliyuncs.com,nuclio-nuclio-qwen-bailian-qwen37-detector,0.0.0.0"
Environment="no_proxy=localhost,127.0.0.1,.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.corp.com,.internal,host.docker.internal,.docker.internal,cvat_cvat,cvat,.cvat,nuclio,clickhouse,grafana,vector,opa,.aliyuncs.com,.dashscope.aliyuncs.com,nuclio-nuclio-qwen-bailian-qwen37-detector,0.0.0.0"
```
执行：
```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
cd /home/kts/cvat-develop ; docker compose up -d
```

#### A2 Nuclio deploy（保证函数接入 cvat_cvat 网络）
```bash
nuctl create project cvat -n nuclio --platform local
nuctl deploy qwen-bailian-qwen37-detector \
  -n nuclio --project-name cvat --platform local \
  --path serverless/qwen/bailian/qwen37-detector/nuclio \
  --platform-config '{"attributes":{"network":"cvat_cvat"}}'
# 保险：容器起来后手动连一下网络（如果 platform-config 没生效）
docker network connect cvat_cvat nuclio-nuclio-qwen-bailian-qwen37-detector
```
验证函数 annotations.bailian == true：
```bash
docker inspect nuclio-nuclio-qwen-bailian-qwen37-detector | grep -i bailian
nuctl -n nuclio get function qwen-bailian-qwen37-detector -o yaml | grep bailian
```

#### A3 CVAT ↔ Nuclio 内部调用（重要，LINE-SLICE 方式打 patch）
文件：[`cvat/apps/lambda_manager/views.py`](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py) 的 `_invoke_directly` 函数
**核心改动**：在 `url = ...host.docker.internal:{port}...` 赋值后，立刻检测函数名包含 qwen/bailian → 强制替换 host=容器名 + port=8080：
```
原始（硬编码外部）：  host.docker.internal:32768
目标（内部稳定）：    nuclio-nuclio-qwen-bailian-qwen37-detector:8080
```
这个修复必须有（否则公司服务器上 host.docker.internal:32768 同样可能不通）。建议作为「业务补丁」提交到 clean.zip 永久固化。

### 方案 B：代码加固层（可选，部署兜底，避免未来再踩）
#### B1 Nuclio main.py（handler 函数内）
- 调百炼前：遍历 `os.environ` pop 所有 `*_proxy` 键 + `sess.trust_env=False` + `sess.proxies={http:None,https:None}`
- URL/key/model：`encode("ascii", errors="ignore")` + 白名单字符集合 + regex 抽 `https?://` + strip 前后引号/反引号/空格
- 诊断：所有关键节点 `print("[QWL-DIAG] ...", flush=True)`（clean_url / bailian_post status/body / RESULTS_OK len / HANDLER EXCEPTION traceback）

#### B2 CVAT lambda_manager/views.py（payload["bailian"] 注入前）
锚点：`payload.update({"bailian": bailian})`（实际在 anchor 上方插入）
同样的 regex 清洗逻辑，打印 `[CVAT-LAMBDA-SANITIZED] url=... model=... key_len=...`，保证即使运维同学 DB 粘贴脏 URL 也会在 CVAT 注入层被提前清干净。

---

## 五、必须遵守的 7 条永久规则（🚨 新会话必读到）
1. **BailianSettings 注入开关**：Nuclio function `metadata.annotations.bailian == "true"` 时，lambda_manager 才会读 DB 并注入 `payload["bailian"]={api_key,api_url,model}`，否则不管你在 UI 怎么填，都不会注入。
2. **Nuclio 函数调用方式**：**永远强制容器名 `nuclio-nuclio-qwen-bailian-qwen37-detector:8080`**（cvat_cvat 内部网络），绝对不要用 `host.docker.internal:32768` 这种宿主映射端口。
3. **代理配置铁律**：如果环境有任何 `HTTP_PROXY/HTTPS_PROXY`（不管是 daemon / config.json / compose x-environment），必须**大小写双写** `NO_PROXY` 和 `no_proxy`，并且必须包含：`.aliyuncs.com`、函数容器名、`host.docker.internal`、`.docker.internal`、所有内网容器名（clickhouse/grafana/vector/opa/cvat/nuclio/cvat_cvat）、私有网段、`.corp.com`。
4. **容器内代理不要写 127.0.0.1**：容器内 `127.0.0.1` 指向容器自身，没有 Clash，必然 Connection refused。实在要写就用 `host.docker.internal`（但建议全走 NO_PROXY 白名单不要走代理）。
5. **自动标注 Items:0 诊断顺序（优先级最高）**：
   ```
   Step 1：docker logs --tail 200 cvat_worker_annotation → 看有没有 ProxyError？
   Step 2：docker logs --tail 200 nuclio-nuclio-qwen-bailian-qwen37-detector → grep [QWL-DIAG] → HANDLER EXCEPTION / RESULTS_OK len=?
   Step 3：DIRECT vs VIA NUCLIO 隔离测试（同图同 key）→ DIRECT 有框 = Nuclio 环境问题，否则 DB/配置问题
   Step 4：除非 1~3 都排除，否则不要怀疑「URL 脏字符 / repr 视觉问题」。
   ```
6. **RQ worker 代码生效铁律**：任何对 `cvat/apps/**/*.py` / Nuclio `/opt/nuclio/main.py` 的改动，必须**重启容器 / 服务**（后端 9 个服务全 restart；Nuclio 函数容器直接 docker restart），否则长驻进程执行的是旧 bytecode，Traceback 行号会错位让你怀疑人生。
7. **源码 patch 不要嵌套 heredoc**：所有容器内改 Python 文件，优先写 /tmp 文件 → docker cp → LINE-SLICE（按行切片）或 `replace(anchor, inject+anchor, 1)` 单锚点替换，不要用 regex（容易 bad escape）、不要嵌套多层 heredoc（容易被复制带脏字符、$$、引号未闭合）。

---

## 六、关键词快速检索索引
> （新会话直接甩关键词 + 本文件路径，1 秒接续）

| 你想找什么 | 在本文件里搜关键词 | 对应章节 |
|------------|--------------------|----------|
| Items:0 不出框根因 | `ProxyError` `127.0.0.1:7890` `终极根因拆解` `根因链条` | 第三节 |
| 代理怎么永久配置（公司服务器） | `NO_PROXY` `daemon` `http-proxy.conf` `.aliyuncs.com` | 第四节 方案 A1 + 第五节 规则 3 |
| BailianSettings 注入开关（什么时候 payload.bailian 才会被注入） | `bailian=true` `annotations` `注入开关` | 第五节 规则 1 |
| lambda_manager 调 Nuclio 要怎么改（不要 host.docker.internal:32768） | `_invoke_directly` `容器名:8080` `cvat_cvat` `LINE-SLICE` | 第四节 A3 + 第五节 规则 2 |
| Nuclio 函数 deploy 步骤（Project 不存在、接入 cvat_cvat 网络） | `nuctl create project` `platform-config` `network=cvat_cvat` | 第四节 A2 |
| main.py 怎么加固（清代理 + 清洗 URL + 诊断） | `QWL-DIAG` `flush=True` `sess.trust_env=False` `encode ascii` | 第四节 B1 + 第五节 规则 5 |
| RQ worker 代码 patch 为什么不生效 | `bytecode 缓存` `重启服务` `Traceback 行号错位` | 第三节 陷阱 T2 + 第五节 规则 6 |
| heredoc / sed / regex 为什么 patch 老是失败（$$、bad escape） | `LINE-SLICE` `docker cp` `锚点匹配失败` `WARN no anchor` | 第三节 陷阱 T6 + 第五节 规则 7 |
| Automatic annotation 入口在哪（UI） | `Actions 菜单` `Task 详情页` `不是 Job 画布` | 2026-08-04 摘要 第 3 条 |
| Project/Task 必须属于哪个组织 + 标签要求 | `nextvpu` `org_id=1` `object 标签` `兜底 label` | 第一节 验收链路 + 2026-08-04 摘要 |
| DB 脏字符 / 粘贴 URL 前后带反引号怎么彻底清 | `CVAT-LAMBDA-SANITIZED` `regex https?://` `encode("ascii", errors="ignore")` | 第四节 B2 |

---

## 七、关键真实参数值（快速复用）
| 参数 | 值 |
|------|----|
| Organization slug | `nextvpu`，org_id=1 |
| BailianSettings 前端路径 | `/organization/bailian`（必须在 Organization 上下文下进入） |
| Nuclio 函数名（容器名） | `nuclio-nuclio-qwen-bailian-qwen37-detector` |
| Nuclio 内部端口 | `8080`（compose 网络内） |
| Nuclio 外部宿主端口 | `32768`（易变，不推荐使用） |
| 模型名（Bailian） | `qwen3-vl-plus` |
| API_URL 必须包含的后缀 | `/chat/completions`（main.py 直接用 api_url，不拼接） |
| 真实验证图片路径（容器内） | `/home/django/data/data/1/raw/237-640x480.jpg`（640x480，50098 字节） |
| 真实验证 dog 框 | label=dog, conf=0.98, points=[132,57,640,480] |
| 后端 9 个需要重启的服务（RQ worker + server） | cvat_server / cvat_worker_annotation / cvat_worker_import / cvat_worker_utils / cvat_worker_chunks / cvat_worker_quality_reports / cvat_worker_consensus / cvat_worker_export / cvat_worker_webhooks |
| 真实 DB api_url 原值（虽然看起来带 ` `` `，实际 ord 全合法，修代理后可直接用） | ` ` `https://ws-bpy1cch81n3j8dxs.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions` ` `（len=92） |

---

## 八、2026-08-07 晚间追加：前端导航菜单缺失修复（Bailian settings /organization 路由）

### 8.1 问题现象
用户在 UI 中**无法通过导航菜单找到 Bailian settings 页面**，只能手动在地址栏直接输入 `http://192.168.30.221:8080/organization/bailian` 才能打开。

点击「头像 → Organization → Settings」后，URL **仍然停留在 `/tasks`，没有发生跳转**，更找不到任何 Actions 按钮。

### 8.2 根因拆解（两个 Bug 叠加）
#### Bug 1（核心，99% 原因）：路由表缺少 `/organization` 父路由
文件：[`cvat-ui/src/components/cvat-app.tsx`](file:///d:/cvat-develop/cvat-ui/src/components/cvat-app.tsx#L551-L558)

虽然文件顶部已经 `import OrganizationPage from 'components/organization-page/organization-page'`，但 Switch 路由表里**只注册了**：
```
/organizations/create   （创建组织）
/organization/webhooks
/organization/bailian
```

**漏了**：
```
/organization           （Organization 详情页 / Settings 页）
```

→ 所以 header.tsx 中 `history.push('/organization')` 是一个**无效路径**，React Router 匹配不到 → **静默忽略不跳转** → URL 继续停留在 `/tasks`。

#### Bug 2（叠加）：Actions 按钮藏在 OrganizationPage 详情页顶部
Actions 下拉菜单（含 Setup webhooks / Bailian settings）定义在 [`top-bar.tsx`](file:///d:/cvat-develop/cvat-ui/src/components/organization-page/top-bar.tsx#L178-L205)，**只有在 `/organization` 页面渲染出来才能看到**。因为 Bug 1 导致这个页面永远打不开，所以用户永远也看不到 Actions 下拉入口，进一步加深了「Bailian 页面不存在」的幻觉。

### 8.3 修复代码（3 处文件改动，均为前端 UI 层，业务代码零影响）

#### 修复 1（关键）：补 `/organization` 路由映射
文件：[`cvat-app.tsx`](file:///d:/cvat-develop/cvat-ui/src/components/cvat-app.tsx#L556)
```diff
  <Route exact path='/organizations/create' component={CreateOrganizationComponent} />
+ <Route exact path='/organization' component={OrganizationPage} />
  <Route exact path='/organization/webhooks' component={WebhooksPage} />
  <Route exact path='/organization/bailian' component={OrganizationBailianPage} />
```

#### 修复 2：顶部 Organization 子菜单直接加快捷入口（不再需要深入 Actions）
文件：[`header.tsx`](file:///d:/cvat-develop/cvat-ui/src/components/header/header.tsx#L322-L338)

当 `currentOrganization` 存在（即用户已切换到组织上下文）时，头像 → Organization 子菜单直接显示**3 个一级菜单项**：
```diff
  ...(currentOrganization ? [{
      key: 'open_organization',
      icon: <SettingOutlined />,
      label: 'Settings',
      className: 'cvat-header-menu-open-organization',
      onClick: () => history.push('/organization'),
+ }, {
+     key: 'organization_webhooks',
+     icon: <SettingOutlined />,
+     label: 'Setup webhooks',
+     onClick: () => history.push('/organization/webhooks'),
+ }, {
+     key: 'organization_bailian',
+     icon: <SettingOutlined />,
+     label: 'Bailian settings',
+     onClick: () => history.push('/organization/bailian'),
  }] : []), {
```

现在用户有两条路径到达 Bailian settings：
- ✅ **快捷路径（推荐）**：头像 → Organization → **Bailian settings**（直达）
- ✅ 原设计路径：头像 → Organization → Settings → 右上角 **Actions** 下拉 → Bailian settings

#### 修复 3：切回 Personal workspace 时 Bailian 页面不 404
文件：[`header.tsx`](file:///d:/cvat-develop/cvat-ui/src/components/header/header.tsx#L268-L275)
```diff
  const resetOrganization = (): void => {
      localStorage.removeItem('currentOrganization');
-     if (/(webhooks)|(\d+)/.test(window.location.pathname)) {
+     if (/(webhooks)|(bailian)|(\d+)/.test(window.location.pathname)) {
          window.location.pathname = '/';
      } else {
          window.location.reload();
      }
  };
```

与 `/organization/webhooks` 同等待遇，正则多匹配一个 `(bailian)`。

### 8.4 前端构建部署踩坑（SSH 反向隧道 + docker build）
**问题**：`docker build -f Dockerfile.ui -t cvat/ui:dev .` 阶段报错：
```
ERROR: failed to build: failed to solve: node:lts-slim: ... Head ".../v2/library/node/manifests/lts-slim":
proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused
```

**根因**：Docker BuildKit 继承了 shell 环境的 `HTTP(S)_PROXY=127.0.0.1:7890`，但 SSH 反向隧道断了（7890 refused）→ 无法拉 `node:lts-slim` 和 `nginxinc/nginx-unprivileged:1.31.2-alpine3.23-slim`。

**解决**：在本地 Windows 重新建立 SSH 反向隧道（保持窗口不关）：
```powershell
ssh -R 7890:127.0.0.1:7890 kts@192.168.30.221
```

服务器端先验证隧道通（curl -x http://127.0.0.1:7890 https://registry-1.docker.io/v2/ 返回 200/401），再补全 NO_PROXY（必须含 `.aliyuncs.com` 等所有内网名）→ 重新 `docker build` → 成功。

**部署步骤**（正确的服务名，不要写不存在的 `frontend`）：
```bash
cd ~/cvat-develop
docker build -f Dockerfile.ui -t cvat/ui:dev .           # 构建前端 UI 镜像（约 10-20 分钟）
docker compose up -d cvat_ui                              # 用新镜像重建 cvat_ui 容器
docker logs --tail 30 cvat_ui                             # 确认 nginx 启动成功：nginx/1.31.2 + 8 worker process
# 浏览器：Ctrl+Shift+R 强制刷新清缓存
```

### 8.5 验证结果（全部通过 ✅）
1. ✅ **快捷入口有效**：头像 → Organization → **Bailian settings** 直接跳 `/organization/bailian`，显示配置卡片
2. ✅ **Organization Settings 跳转有效**：头像 → Organization → Settings 正确跳 `/organization`，URL 变化
3. ✅ **详情页完整渲染**（截图实锤）：
   - 左上角：`Organization: nextvpu` 标题，联系方式、时间戳正确
   - 右上角：**Actions** 按钮（三个点图标）可见，展开含 Setup webhooks / Bailian settings
   - 中间：搜索框、成员列表（admin / Owner）、Invite members 按钮正常
   - 下方：Sort by / Quick filters / Filter 过滤区正常
4. ✅ **切 Personal workspace 不 404**：从 `/organization/bailian` 切回后，跳回首页而非空白页

### 8.6 源码纯净度 & 改动定位
**以上 3 处改动全部属于「前端 UI 导航层」**，不涉及任何：
- Django 后端 API、模型、迁移、权限
- BailianSettings DB 读写、序列化
- lambda_manager 的 Nuclio 调用与 payload 注入
- Nuclio 函数 main.py 业务逻辑
- 代理 / 网络环境硬编码

`cvat-develop-clean.zip` 业务核心代码保持纯净。

---

## 九、文件参考
- 后端入口（Nuclio 调用）：[views.py](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py)
- Nuclio 函数主文件：[main.py](file:///d:/cvat-develop/serverless/qwen/bailian/qwen37-detector/nuclio/main.py)
- 核心 compose：[docker-compose.yml](file:///d:/cvat-develop/docker-compose.yml)
- **路由缺失修复**：[cvat-app.tsx](file:///d:/cvat-develop/cvat-ui/src/components/cvat-app.tsx#L551-L558)（补 `/organization` Route）
- **导航菜单修复**：[header.tsx](file:///d:/cvat-develop/cvat-ui/src/components/header/header.tsx#L268-L338)（快捷入口 + resetOrganization 正则）
- Organization 详情页（含 Actions 下拉）：[top-bar.tsx](file:///d:/cvat-develop/cvat-ui/src/components/organization-page/top-bar.tsx#L178-L205)
- Git 忽略规则：[.gitignore](file:///d:/cvat-develop/.gitignore)（300+ 行，全栈覆盖）
- 环境变量模板：[.env.example](file:///d:/cvat-develop/.env.example)（含 NO_PROXY 大小写双写推荐值）
- Compose 覆盖模板：[docker-compose.override.yml.example](file:///d:/cvat-develop/docker-compose.override.yml.example)（资源/卷/端口示例）
- 系统项目级永久记忆：`project_memory.md`（`c:\Users\kangtieshuan\.trae\memory\projects\-d-cvat-develop\project_memory.md`）
- 每日会话索引（系统自动归档）：`20260807/topics.md`、`20260806/topics.md`、`20260805/topics.md`、`20260804/topics.md`

---

## 十、2026-08-07 晚间追加：GitHub 仓库初始化与上传（源码归档交付）

### 10.1 需求背景
用户要求把 `D:\cvat-develop`（Windows 本地源码，包含前面所有 BailianSettings 前后端改动）**上传到私有 GitHub 仓库**，作为团队可复用的代码基线：
- GitHub 账号：`CuriousCoder-kts`
- 注册邮箱：`3489524030@qq.com`
- 仓库名：`cvat`（`https://github.com/CuriousCoder-kts/cvat`）
- 可见性：**Private**（代码属内部定制，不对外开源）
- 核心原则：源码上传时**剔除缓存、构建产物、敏感配置、内部会话文档**（不是一股脑打包 zip）

### 10.2 项目初始状态（扫描结果）
| 扫描项 | 状态 |
|--------|------|
| `.gitignore` 文件 | ❌ 不存在，之前的 commit 是裸 init |
| Git 仓库本体 | ✅ 已存在 1 笔 commit：`d749d71 init cvat source` |
| `node_modules/` / `__pycache__/` | 目录中没有（本地没 build / pip install），但仍需 .gitignore 防止未来误提交 |
| 真实 `.env` 文件 | 2 个：`cvat-ui/.env`（仅版权声明，无密钥）、`tests/python/webhook_receiver/.env`（测试通用配置） |
| 敏感密码 | `docker-compose.yml` 中 `CLICKHOUSE_PASSWORD: user` / `MINIO_ROOT_PASSWORD: minio_secret_key` 均为上游 CVAT 默认开发值，非用户真实生产密钥 |
| 内部会话文档 | `SESSION_HISTORY_AGG_20260803_20260807.md`（本文档，含运维细节/陷阱/根因，不能上传 GitHub）→ .gitignore 排除 |
| 本地 IDE 配置 | `.vscode/settings.json`（含用户个人 Python 解释器路径 `.env/bin/pytest`）→ .gitignore 排除 |
| 前端已改源码 | `cvat-app.tsx`（补路由）、`header.tsx`（Bailian 快捷菜单）→ **已 git tracked，正常提交** |

### 10.3 交付文件 1：[.gitignore](file:///d:/cvat-develop/.gitignore)（300+ 行专业全栈覆盖）
**分段结构**：
```
# Python / Django        → __pycache__, .pytest_cache, *.pyc, .venv, db.sqlite3, cvat/data/*, media/
# Node.js / React / TS   → node_modules, dist, build, .eslintcache, yarn-error, *.tsbuildinfo
# Docker                 → volumes/, docker-compose.override.yml, .docker-data/
# IDE / Editor           → .vscode/* (留 extensions.json), .idea/, *.swp
# Environment / Secrets  → .env*, *.pem, *.key, credentials.json, secrets/
# OS 垃圾                → .DS_Store, Thumbs.db, desktop.ini
# CVAT 专属              → 各子包 dist/ (cvat-core / cvat-canvas* / cvat-ui / cvat-sdk* / cvat-cli)
# 会话内部文档           → SESSION_HISTORY_AGG_*.md（本文档）、session_memory_*.jsonl
# Misc                   → *.bak, *.zip, *.tar.gz
```

**关键踩坑：** SESSION_HISTORY_AGG 和 .vscode/settings.json 是「用户本地特有」文件，上传 GitHub 既污染仓库又有信息泄漏风险，必须显式写进 .gitignore。

### 10.4 交付文件 2：[.env.example](file:///d:/cvat-develop/.env.example)（部署模板，安全无密钥）
**核心作用**：新同学 clone 代码后，复制为 `.env` 再填写，不会出现「缺变量不知道要填什么」的情况。

**覆盖变量分组**：
| 分组 | 关键变量 |
|------|----------|
| CVAT Core | `CVAT_VERSION=dev`、`CVAT_HOST=localhost`、`CVAT_NUM_PROXIES=1`、`CVAT_ALLOW_STATIC_CACHE=no` |
| Superuser | `DJANGO_SUPERUSER_USERNAME/EMAIL/PASSWORD`（注释掉，用户自己开） |
| ClickHouse / Redis / Postgres | 默认值与 `docker-compose.yml` 对齐，用户改密码时只改 .env |
| Email 通知 | SMTP HOST/PORT/USER/PASSWORD/TLS |
| **代理（最易踩坑）** | 提供 NO_PROXY/no_proxy **大小写双写**完整推荐值，已内置 `.aliyuncs.com`、容器名清单、私有网段三段、`host.docker.internal` 等——直接抄可避开 80% 代理污染问题 |
| Smokescreen | `SMOKESCREEN_OPTS=`（默认空） |

### 10.5 交付文件 3：[docker-compose.override.yml.example](file:///d:/cvat-develop/docker-compose.override.yml.example)（compose 覆盖模板）
**核心作用**：`docker compose` 启动时自动加载 `docker-compose.override.yml`（比 `docker-compose.override.yml` 少一个 s，和 docker-compose.yml 同目录）覆盖基础配置，不再需要手写多 `-f`。

**覆盖示例**：
```
cvat_server   → volumes 挂载 custom_settings.py、资源限制 cpus=2.0 / memory=4G
cvat_ui       → 端口暴露 8080:80（不经过 Traefik，临时调试用）
traefik       → 80/443 + TLS certs 挂载
redis/postgres/clickhouse  → 持久化卷挂载
vector        → 不用日志链路时 replicas=0
```

### 10.6 GitHub 仓库创建（用户在 Web UI 操作）
**用户截图关键决策（全部正确 ✅）**：
| 字段 | 用户选择 | 评价 |
|------|----------|------|
| Owner | `CuriousCoder-kts` | ✅ |
| Repository name | `cvat`（available ✔️） | ✅ |
| Description | `CVAT 标注平台 + Qwen 百炼自动标注集成`（可选，推荐） | |
| Visibility | **Private** | ✅ 强烈推荐，代码含内部定制 |
| Add README | **Off** | ✅ 本地已有 README.md，GitHub 再生成会冲突 |
| Add .gitignore | **No .gitignore** | ✅ 我们刚创建了完整的，不要让 GitHub 再生成一份 |
| Add license | **No license** | ✅ 内部私有仓库，不需要开源协议 |

→ 点 **Create repository** 成功创建空私有仓库。

### 10.7 本地命令执行 & 两个踩坑实录
用户在 PowerShell（旧版 Windows PowerShell 5，不是最新 PowerShell 7）中执行命令，**踩了两个坑，按顺序修**：

#### 🚫 坑 1：第一次 push 直接超时 21s（未配置 Git 代理）
**用户错误输出**：
```powershell
PS D:\cvat-develop> git push -u origin master
fatal: unable to access 'https://github.com/CuriousCoder-kts/cvat.git/':
Failed to connect to github.com:443 after 21079 ms: Could not connect to server
```
**根因**：和之前服务器遇到的一样——本机访问 GitHub **必须经过 127.0.0.1:7890 本地代理（Clash / V2Ray）**，Git 默认不走代理，直接裸连 21s 超时。

**修复**：给 Git 全局写代理配置：
```powershell
git config --global http.proxy  "http://127.0.0.1:7890"
git config --global https.proxy "http://127.0.0.1:7890"
# 验证写入成功：
git config --global --list | Select-String "proxy"
# http.proxy=http://127.0.0.1:7890
# https.proxy=http://127.0.0.1:7890
```

**连通性先验**（PowerShell 侧先走一遍代理 curl 等价）：
```powershell
$proxy = 'http://127.0.0.1:7890'
Invoke-WebRequest -Uri 'https://github.com' -Proxy $proxy -UseBasicParsing -TimeoutSec 15
# ✅ StatusCode 200 = 代理通，可以放心 push
```

> **反向操作备忘录**：未来在公司网络（能直连 GitHub，不需要代理）时，取消代理：
> ```powershell
> git config --global --unset http.proxy
> git config --global --unset https.proxy
> ```

#### 🚫 坑 2：PowerShell 反引号 `` ` `` 带来的语法幻觉（差点出错）
用户原始命令写了：
```powershell
git remote add origin `https://github.com/CuriousCoder-kts/cvat.git`
#                        ↑反引号                    ↑反引号
```
**PowerShell 语义**：反引号 `` ` `` 是**转义字符 / 行继续符**，不是字符串边界。这里 URL 两边的反引号被当作「转义 URL 开头的 h」和「行继续」处理，实际存入 remote 的 URL 反而看起来正常（靠运气没出事）。

**正确写法**（推荐统一用双引号）：
```powershell
git remote add origin "https://github.com/CuriousCoder-kts/cvat.git"
```
验证：`git remote -v` → 必须显示：
```
origin  https://github.com/CuriousCoder-kts/cvat.git (fetch)
origin  https://github.com/CuriousCoder-kts/cvat.git (push)
```

### 10.8 修正作者信息 + 分支统一命名（主流习惯）
第一次 commit 作者信息是自动取的 Windows 登录名：`unknown <kangtieshuan@nextvpu.local>`，对 GitHub 协作不友好。**修正**：
```powershell
# 1. 设置全局身份（一次设置，永久生效）
git config --global user.name  "CuriousCoder-kts"
git config --global user.email "3489524030@qq.com"

# 2. 修正最后一笔 commit 的作者
git commit --amend --reset-author --no-edit
# 结果：[master 3be277f] （commit hash 会变，正常现象）
```

**分支改名 master → main**：GitHub 新仓库默认分支名现在都是 `main`，和主流保持一致少踩坑：
```powershell
git branch -M main
```

### 10.9 最终 push 成功（verbose 日志摘要）
```powershell
git push -u origin main --progress
```
**GIT_CURL_VERBOSE 关键段落**（已核实）：
```
17:06:38  Trying 127.0.0.1:7890...             → 走代理（正确 ✅）
17:06:38  CONNECT tunnel established, response 200   → 代理隧道建成功 ✅
17:06:39  HTTP/1.1 401 Unauthorized           → 第一次未鉴权（正常，GitHub 要 Basic）
17:06:39  Server auth using Basic with user 'CuriousCoder-kts'  → 第二次带鉴权 ✅
17:06:40  HTTP/1.1 200 OK                     → refs 广告获取成功 ✅
...
最后两行：
Everything up-to-date
branch 'main' set up to track 'origin/main'.   → 追踪关系建立 ✅
EXITCODE=0                                     → 命令成功 ✅
```
`git branch -vv` 验证（必须显示 `[origin/main]`）：
```
* main 3be277f [origin/main] feat: add .gitignore + env templates + BailianSettings UI entries
```

### 10.10 最终交付清单（GitHub 仓库实际内容）
clone 下来后实际包含的文件：

**✅ 正常被 track 的源码与配置**：
```
.gitignore                   新增 （300+ 行，我们加的）
.env.example                 新增 （部署模板，我们加的）
docker-compose.override.yml.example  新增 （覆盖模板，我们加的）
cvat-ui/src/components/cvat-app.tsx  改 （补 /organization 路由）
cvat-ui/src/components/header/header.tsx  改 （Bailian 快捷入口 + resetOrganization 正则）
所有上游 CVAT 原始源码      （后端 Django、前端 React、serverless 函数、测试、Helm、文档站等）
```

**🚫 本地有但 GitHub 上看不到（正确排除）**：
```
SESSION_HISTORY_AGG_20260803_20260807.md   → .gitignore 规则命中（含运维细节，不外传）
cvat-ui/.env                     → .env* 命中（即使本地只是版权声明，也一律不提交）
tests/python/webhook_receiver/.env  → 同上
.vscode/settings.json  launch.json  tasks.json  → .vscode/* 命中（用户个人 IDE 偏好）
```

### 10.11 后续日常开发提交流程（备忘速查）
```powershell
cd D:\cvat-develop
# 0. 先确保代理通（GitHub 需要代理时才跑）
#    （git config --global http.proxy  http://127.0.0.1:7890）
#    （git config --global https.proxy http://127.0.0.1:7890）

# 1. 看改了什么（永远先确认，防止误提交密钥）
git status --short
git diff   # 逐行确认改动

# 2. 暂存 + 提交（commit message 用英文，清晰描述：改了什么+为什么）
git add .
git commit -m "feat: xxxxx"

# 3. 拉最新（防冲突）+ 推送
git pull --rebase origin main
git push
# 不再需要写 -u origin main，追踪关系已永久建立
```

### 10.12 安全红线（未来必须遵守）
| # | 红线 | 说明 |
|---|------|------|
| S1 | **永远不要把真实 API Key / 密码写进 repo** | 即便是 Private 仓库也不行，未来可能开源、协作者离职、仓库泄露等。真实密钥一律走服务器上的 `.env`（.gitignore 已排除）或 Docker Secrets。 |
| S2 | **新增 .env* 文件先确认不在 track 里** | 任何以 `.env` 开头的文件默认都会被 ignore；如果真的要提交模板，必须显式 `git add -f .env.example`（目前我们的 example 后缀已经豁免）。 |
| S3 | **Private 仓库不要挂 Public** | 除非老板明确说要开源，否则别改 Visibility。 |
| S4 | **不要用 GitHub 的一键生成 .gitignore / README** | 我们已有完整的 CVAT 定制版 `.gitignore`，GitHub 那个通用 Python/Node 版会漏很多 CVAT 专有目录（如 cvat-core/dist、site/public）。 |
| S5 | **SESSION_HISTORY_AGG 和会话聚合文件不要 commit** | 里面有服务器 IP、内部踩坑路径、运维命令，属团队内部知识资产，不上传 GitHub。本地保留即可。 |

### 10.13 后续可选优化（优先级低，按需）
1. **GitHub PAT（Personal Access Token）固化认证**：当前 push 时可能需要每次弹窗输密码 → 生成 PAT（classic）勾选 `repo` 权限后，Win11 用「凭据管理器」缓存或用 Git Credential Manager。
2. **Pre-commit hooks**：以后多人协作时加 `black / ruff / eslint / prettier --write` pre-commit 自动格式化，防止风格 PR。
3. **签出验证**：在另一台干净机器（或服务器）`git clone https://github.com/CuriousCoder-kts/cvat.git`，按 .env.example 配好变量 → `docker compose up -d` → 验证 Bailian settings 入口、自动标注链路全通。
4. **仓库 LICENSE**：如果以后确定要开源，再补 MIT / Apache-2.0 LICENSE 文件（现在是 Private 不用）。

---

*Generated: 2026-08-03 ~ 2026-08-07（最终会话：前端导航菜单补齐 + GitHub 私有仓库归档 + 部署模板交付，完整代码基线落地 ✅）*
