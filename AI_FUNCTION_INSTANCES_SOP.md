# CVAT AI Function Instances (Prompt-Driven) — 端到端操作 SOP v1.0

> **适用版本**：Build #20（修复 BUG1~BUG15 后的生产版本）  
> **更新时间**：2026-08-20  
> **模块路径**：`cvat-ui/src/components/ai-feature-page/` (前端) · `cvat/apps/lambda_manager/` (后端)  
> **Provider 支持**：Alibaba Bailian (百炼) · OpenAI-compatible (Chat Completions / Vision)

---

## 目录

- [1. 模块总览](#1-模块总览)
- [2. 端到端工作流全景图](#2-端到端工作流全景图)
- [3. Scenario A + B：从零创建 AI 实例](#3-scenario-a--b从零创建-ai-实例)
  - 3.1 Scenario A：创建 Object Detector（物体检测，Boxes / Polygons）
  - 3.2 Scenario B：创建 Image Caption（图片描述，TAG 属性）
- [4. Scenario C + E：执行 Annotate 标注闭环](#4-scenario-c--e执行-annotate-标注闭环)
  - 4.1 Scenario C：物体检测 · 9 Labels 固定模式
  - 4.2 Scenario E：图片描述 · Image Caption
- [5. Scenario D：R8 Prompt 自由模式](#5-scenario-dr8-prompt-自由模式)
- [6. 常见问题 & 历史修复坑（15 个 Bug 速查）](#6-常见问题--历史修复坑15-个-bug-速查)

---

## 1. 模块总览

AI Function Instances 模块是完全驱动的 AI 标注实例管理中心。与传统部署 `nuclio` / `serverless` 的固定模型不同，本模块允许用户在 Web UI 中：

1. 声明自己要调用的 **Provider / Model / API Key**（当前支持阿里百炼，也兼容任意 OpenAI-compatible VLM）
2. 在 7-Tab 结构化表单中配置 **System Prompt / User Prompt / Labels / Parser / Custom Variables**
3. 一键保存为「实例」，在 Task / Job 标注页 `Actions → Automatic annotation` 直接调用
4. 标注结果完全按 **CVAT 原生 Label engine_label / engine_attribute** 入库，与人工标注完全一致

### 三个 Feature Kind（Output type）

| Feature Kind | CVAT 入库类型 | 典型用途 | 是否需要在 AI 侧定义 Labels |
|---|---|---|---|
| **Boxes / Polygons** (`object_detector`) | `LabelType.RECTANGLE` / `POLYGON` | 物体检测（2D Box）、实例分割（多边形轮廓） | **是**（或用 R8 自由模式） |
| **Image Caption** (`image_caption`) | `LabelType.TAG` + `TEXT` 属性 `caption` | 每张图生成一句自然语言描述（语义搜索 / 内容理解） | **否**（只有一个 TAG 属性 `caption`） |
| Intention / Trajectory、Keypoints / Skeleton 等 | 对应 LabelType | 预留扩展 | 按实际需要 |

### 7-Tab 表单结构（Edit AI Function Instance）

| # | Tab 名 | 关键配置 |
|---|---|---|
| 1 | **Basic** | Slug（唯一 ID，创建后不可改）· Display Name · Output Type · Output Format · Default Switch · **Preset 选择**（一键加载模板） |
| 2 | **API & execution** | Provider / Model Name / API URL · **Access Key（API Key）** · 重试次数 · 并发 · Timeout · ROI · 自定义 headers |
| 3 | **Prompt templates** | System Prompt Template（长指令）· User Prompt Template（每张图追加）· Variables 按钮注入占位符（双大括号 `{{xxx}}`） |
| 4 | **Labels & attributes** / Captions & attributes | object_detector：Label 列表（name / type / color / description / attributes 定义）；image_caption：Caption Attribute Name 默认 `caption` |
| 5 | **Parser configuration** | Output Format（rectangles / polygons / captions）· 置信度阈值 · NMS · parser_params 微调 · caption 解析正则 |
| 6 | **Custom prompt variables** | 用户自定义变量（Key / Default Value / Description），配合 Variables 按钮在 Prompt 里注入 |
| 7 | **Troubleshooting / raw JSON** | 查看最终 `config` JSON（和 DB 加密字段完全一致）· API 响应示例 · 调试 Raw JSON |

---

## 2. 端到端工作流全景图

### 2.1 9 步全链路（AUDIT 级别）

> 这 9 步就是 Build #16 时 9-step audit 的顺序，任何环节出问题都会导致 `Items: 0` 或按钮灰。

```
A1. Frontend Save Instance
    ↓ form-page onFinish
    ↓   → BUG1 (typeof prompt 存 "string") — Build #16 已修
    ↓   → BUG2 (output_format feature-aware 默认) — Build #16 已修
    ↓   → BUG6/9 (毒药值 undefined + preset 找不到) — Build #18 已修
    ↓   → BUG11 (applicablePresets 过滤字段错) — Build #18 已修
    ↓   → BUG13 (labels preset 兜底) — Build #19 已修
    ↓ 写入 DB → lambda_manager_aifunctioninstance.config (encrypt JSON)
    ↓
A2. Frontend Model Runner
    ↓ detector-runner.tsx · Annotate dialog
    ↓   → BUG14 (Annotate 死灰 mappingFullyPaired) — Build #20 已修
    ↓   → BUG15 (convertMappingToServer 空指针 TypeError) — Build #20 已修
    ↓ POST /api/lambda/requests (body: function_id=__ai_instance__<id>__slug__<slug>)
    ↓
A3. LambdaGateway.get() + Slug 解析
    ↓ 正则：^__ai_instance__(\d+)__slug__(.+)$
    ↓ 404 → 自动合成 LambdaFunction(uses_bailian=True, kind=DETECTOR/CAPTION)
    ↓
A4. views.invoke() — M19 ULTRA Pre-invoke Prep
    ↓ pre-inject labels → M10 9-labels fallback → R6/R7/R8 auto-create DB Label
    ↓   （make_default_mapping 之前建 DB label，顺序实锤正确）
    ↓   任何异常 → 100% fallback 到 _invoke_ai_instance_bailian_locally 本地跑，不抛错
    ↓
A5. _invoke_ai_instance_bailian_locally() — 百炼实际调用
    ↓ label_spec 组装 + _bc_flatten_label_spec + var_pool reserved vars
    ↓ STAGE 2: POST https://dashscope.aliyuncs.com/.../chat/completions (百炼 API)
    ↓ STAGE 3: run_parser (output_parsers.py)
    ↓   → BUG3 (FREE LABEL 被白名单丢弃) — Build #16 R8 已修
    ↓   → BUG4 (fuzzy 分类统计日志) — Build #16 已修
    ↓
A6. response_filtered + R8 loose fallback
    ↓ FREE LABEL DB 查不到 → 当场 Label.objects.create (T3)
    ↓   LabelType 严格对齐：rectangle/polygon/tag/any，防 IntegrityError
    ↓
A7. DetectionResultConverter._parse_anno (T4 全类型兜底)
    ↓ tag/rectangle/polygon/ellipse/mask/cuboid 全类型自动查/建 Label
    ↓ _ensure_attribute_spec → 缺 attributes 当场在 engine_labelattribute 建
    ↓
A8. LabeledDataSerializer + collector.submit / update_task_data
    ↓ 按 CVAT 原生 DM 链路写入 cvat-engine schema
    ↓
A9. LambdaRQMeta + LambdaJob.__call__ + RQ 异步
    ↓ Task 级自动调度到 worker container (cvat_worker_*)
    ↓ FINAL 日志 → 含 fuzzy: W=X F=Y FREE=Z total_parser=N 后缀
```

### 2.2 Labels 8 处来源（快递分拣比喻）

> 任何两处名字对不上 → 静默丢 → **Items: 0**（已通过 BUG3/R7/R8 修复，全部兜底覆盖）

1. **AI Instance DB config["labels"]**：定义源头（encrypt JSON，Labels Tab 里编辑的）
2. **Prompt 模板硬编码里的类别文字**：User/System Prompt 里手动写的「外卖员 / 黄色头盔」
3. **label_spec 内存变量**：真正交给 VLM 的工作清单（_bc_flatten_label_spec 组装）
4. **百炼 VLM 返回 JSON 里的 label 字段**：VLM 实际吐出来的（prompt 自由模式可能任意文字）
5. **M10 FORCE FALLBACK 9 labels**：内存兜底 9 个 street labels（traffic_cone/motor_vehicle/...）
6. **CVAT DB engine_label 表**：物理格口（Project 或 Task 里建的）
7. **mapping 字典**：快递单 → 格口查表（前端 Setup mapping + 后端 make_default_mapping 合成）
8. **self.labels**：抄给 DetectionResultConverter 的分拣中心主任清单

### 2.3 R8 Prompt 自由模式 4 层兜底（关键！）

> R8 解决痛点：「用户只在 Prompt 里写想检测什么（外卖员/遮阳棚/交通桶），不用在 Labels Tab 先声明，不用在 Setup mapping 手动选，VLM 吐出来后端 100% 不丢」

```
T1. output_parsers._fuzzy_resolve_label(norm_lbl, allowed_set, label_spec, min_similarity=0.68)
      ① exact 白名单命中 → return (name, True) + fuzzy_hit_counters.whitelist++
      ② fuzzy 别名模糊匹配：SequenceMatcher + token overlap + description 匹配，score≥0.68
         → return (canonical, True) + fuzzy_hit_counters.fuzzy_map++
      ③ FREE LABEL：没匹配到也不丢！return (norm_lbl, False) + fuzzy_hit_counters.free_label++
         （以前这里是 continue，现在通过 → 核心修复点）

T2. parse_rectangles / parse_polygons 都走 fuzzy+free，最后挂函数属性：
      parse_rectangles._last_stats = {whitelist, fuzzy_map, free_label, total}
      给外层 views 读统计

T3. views.py response_filtered 前 loose fallback：
      for _name in _candidate_names:
          _lobj = _found_db.get(_name)
          if _lobj is None:  # 真正的 FREE LABEL（VLM 新冒出来的）
              _db_type = {rectangle:RECTANGLE, polygon:POLYGON, tag:TAG}.get(_anno_type, "any")
              _lobj = Label.objects.create(
                  name=_name, type=_db_type, color=<md5(name) 前 6 位 HSV 自动配色>,
                  project_id=... (project 级优先，task 级次之)
              )
              slogger.glob.info("[R8 FIX loose] FREE DETECT: created new Label(name=%s, type=%s, id=%d)")
          mapping[_name] = {"name": _name, "db_label": _lobj, "attributes": {}}

T4. DetectionResultConverter._parse_anno() 兜底从 tag-only 扩展为**全类型**：
      if label is None:  # 不管 type 是 rectangle/polygon/ellipse/mask/cuboid/tag 全兜底
          # project_id → task_id 两级查，查不到就 Label.objects.create(...)
          # type 严格对齐 LabelType 枚举，防 IntegrityError
          label_entry = self._labels.setdefault(name, {"id": _db_lbl.id, "type": _db_lbl.type, "_orm": _db_lbl})
          label = label_entry
```

**FINAL 日志格式**（debug 一眼分清 label 来源分类）：

```
slogger.glob.info("[AI INSTANCE BAILIAN] FINAL ok: %s items %d fuzzy: W=%d F=%d FREE=%d total_parser=%d",
    slug, len(items), fuzzy_stats.whitelist, fuzzy_stats.fuzzy_map, fuzzy_stats.free_label, fuzzy_stats.total)
# 输出示例：
# [AI INSTANCE BAILIAN] FINAL ok: bailian-default-detector items 36 fuzzy: W=7 F=0 FREE=3 total_parser=10
#       ↑ W=7 (白名单 exact 命中7种), F=0 (fuzzy别名0), FREE=3 (prompt 里新增的3种全新 label)
```

---

## 3. Scenario A + B：从零创建 AI 实例

> **⚠️ 操作前必做：Service Worker 缓存 3 清**  
> 每次 build/deploy 后必须执行，否则跑的是旧 bundle，BUG1~15 修复没生效：
> 1. Chrome F12 → Application → Service Workers → **Unregister**
> 2. Application → Storage → **Clear site data**
> 3. **Ctrl+F5** 强制刷新 2 次

### 3.1 Scenario A：创建 Object Detector（物体检测，Boxes / Polygons）

#### 适用场景：街景交通 9 类 / 通用目标检测 / 自定义检测任务

#### Step 1：进入 List 页 → 新建实例

1. 登录 CVAT → 顶部导航栏 **AI Features**（本模块入口，URL：`/organization/ai-features`）
2. 右上角点 **➕ New instance**

#### Step 2：1. Basic Tab — 核心身份信息

| 字段 | 填值 | 说明 |
|---|---|---|
| **Slug**（必填，创建后不可改） | `bailian-street-9class-v1` | 全局唯一；英文 + 数字 + `-` / `_`，禁止中文空格 |
| **Display Name**（必填） | `Street 9-Class Detector · Bailian qwen3-vl-plus` | 列表页、Annotate dialog 里展示的名字，可中文（推荐全英文） |
| **Output type**（必填） | 选 `Boxes / Polygons` | = `object_detector`，入库 Rectangle/Polygon |
| **Output format (optional)** | 选 `Rectangles / bounding boxes` | 物体检测固定选这个（如果是分割 mask，选 polygons） |
| **Enabled** | ✅ ON | 禁用后 Annotate dialog 里看不到这个实例 |
| **Default instance (optional)** | ✅ ON（如果你想让它是这个 feature kind 的默认选择） | 同 Feature Kind 下只能有 1 个 Default |
| **Preset (optional)** | 选 **Traffic 9-Class Detector (V9, Bailian qwen3-vl-plus) (object_detector)** | **推荐！** 一键把 9 labels / V9 prompt / parser params 全部预填；下拉会显示 2 个 object_detector preset，另一个是 Generic（1 个 label，适合 R8 自由模式） |

#### Step 3：2. API & execution Tab — 调用凭据

| 字段 | 填值 |
|---|---|
| **Provider** | `Alibaba Bailian` |
| **Model name** | `qwen3-vl-plus`（或你想用的百炼 VLM） |
| **API URL** | 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` |
| **Access key (Bailian API Key)** | 填 `sk-xxxxxx`（阿里百炼控制台「API Key 管理」创建） |
| 其他（Max retries / Timeout / Temperature / Top-p） | 默认即可，生产环境建议 Temperature=0.0（最确定） |

> ⚠️ **API Key 保存位置**：DB `lambda_manager_aifunctioninstance.config["api_key"]` 字段已用 Django ` FernetCrypto` 对称加密，不裸存明文。

#### Step 4：3. Prompt templates Tab — 指令区（Preset 已加载的话直接略过确认）

选了 Traffic 9-Class Preset 后，System Prompt 会自动填成 V9 专业街景 prompt（~1200 chars），User Prompt 是 per-image 补充规则（~900 chars）。

**自定义技巧**：Variables 按钮点一下就能把 `{{image_width}}`、`{{total_pixels}}`、`{{label_categories_markdown}}`、`{{output_schema_markdown}}` 等注入到光标位置。所有 `{{xxx}}` 在调用 VLM 前会被后端 `var_pool` 替换成真实值。

#### Step 5：4. Labels & attributes Tab — 定义 AI 侧标签（Preset 已加载的话跳过）

Traffic 9-Class Preset 会自动加载 9 个 labels，完整列表：

| # | Label name | 说明（V9 Definition） |
|---|---|---|
| 1 | `pedestrian` | 行人（站立/走路/跑步/过街，含手推自行车无骑手、打伞、排队人群） |
| 2 | `cyclist` | 骑手（2 轮非机动车 + 车上有人：自行车/共享单车/电动自行车/脚蹬三轮车） |
| 3 | `motor_vehicle` | 机动车（4 轮及以上：轿车/SUV/面包车/货车/公交车/出租车） |
| 4 | `non_motor_vehicle` | 非机动车（2/3 轮但无人骑：停着的共享单车/电动三轮车/手推车） |
| 5 | `traffic_cone` | 交通锥（雪糕筒） |
| 6 | `traffic_bucket` | 交通桶（圆柱形隔离墩） |
| 7 | `traffic_column` | 交通柱（矮粗隔离柱） |
| 8 | `plastic_barrier` | 塑料隔离栏（水马/拼接型护栏） |
| 9 | `traffic_light` | 交通信号灯（一整根杆算 1 个 box） |

每个 label 还可以加 Attributes（布尔 / 选择 / 数值 / 文本），属性名必须 ASCII，中文会被自动转 ASCII 拼音（`cvat/..._cn2en_labels.py` 脚本处理历史数据的方式）。

#### Step 6：5. Parser configuration — Output Format 解析器

- **Output format**：选 **Rectangles / bounding boxes**（对应 `parse_rectangles` parser）
- **Confidence threshold**：默认 0.50（过低会误检，过高漏检，街景推荐 0.4~0.6）
- NMS / max_boxes / parser_params（如 `ensure_square` / `clip_to_image`）：默认即可

#### Step 7：6. Custom prompt variables（可选）

如果 Prompt 里写了 `{{my_custom_var}}`，在这里声明 Key + Default Value + Description，调用时自动填充。

#### Step 8：点 Save 保存

保存后跳回 List 页。在 List 页点 **Details** 打开 Drawer 验证以下 4 项（**有任一异常说明老 Bug 还在，按第 6 章清缓存再 Save 一次**）：

✅ `Labels: 9 defined`（不是 `(none defined)`）  
✅ `Prompts: System 1,xxx chars · User 8xx chars`（不是 9 chars，9 chars = 毒药值 `"undefined"`）  
✅ Labels 下方没有黄色 `No labels resolved` 警告条  
✅ `Credentials: ✔ has_api_key: yes`（不是红圈 `api_key: missing`）

---

### 3.2 Scenario B：创建 Image Caption（图片描述，TAG 属性）

#### 适用场景：给每张图加一句自然语言描述（用于语义搜索 / 内容召回 / 数据集打 tag）

#### Step 1：New instance → 1. Basic Tab

| 字段 | 填值 |
|---|---|
| Slug | `bailian-image-caption-v1`（英文，唯一） |
| Display Name | `Describe Images · Bailian qwen3-vl-plus` |
| **Output type**（关键！） | 选 **Image Caption** |
| Output format (optional) | 选 `Captions — 1-sentence TAG attribute per image` |
| Preset (optional) | 选 **Generic Image Caption (image_caption)** ← 一键加载 caption prompt + parser params |

#### Step 2：2. API & execution Tab

同 Scenario A Step 3。Provider、Model（推荐 `qwen3-vl-plus`，理解能力更强）、API Key 填好。

#### Step 3：3. Prompt templates Tab（Preset 已加载跳过）

Generic Caption Preset 会自动填 System Prompt = 「你是一个专业的图像描述助手，用 1 句简明的英文描述这张图片。」+ User Prompt = 图像大小 + task/project 上下文。

#### Step 4：4. Captions & attributes Tab

- **Caption attribute name**：默认 `caption`（**不要改！** 后端 R6 三层兜底都硬编码以 `caption` 为主 name，改了要同时改后端 4 处）
- Label fallback names：`caption`（默认即可）
- Extra TAG labels：可选，比如 `quality` / `scene_type` 等 TAG 属性

#### Step 5：5. Parser configuration

Parser 是 `parse_captions`，会从 VLM 返回文本里匹配 TAG JSON，失败就 fallback 到「整段文本作为 caption 属性值」。默认即可。

#### Step 6：Save → Drawer 验证

✅ `Labels — image caption outputs image-level TAG attribute, no AI-side labels`（正常是「无 AI 侧 labels」，Caption 不在 AI 侧定义）  
✅ `Prompts: System 6xx chars · User 2xx chars`（不是 9 chars）  
✅ `Caption: caption`（绿色胶囊，表示 caption TAG 属性映射就绪）

---

## 4. Scenario C + E：执行 Annotate 标注闭环

### 4.1 Scenario C：物体检测 · 9 Labels 固定模式

#### 前置条件
- Scenario A 实例创建完成并通过 Drawer 4 项验证（9 labels / prompt 正常 / api_key: yes）
- Project / Task 已创建（示例：Project 3 = StreetScene · Task 6 = demo-task-04 · Job 6 = 14 张街景图）

#### Step 1：进入 Task 页

打开 Task 列表或 Project 详情页（URL：`/tasks/6` 或 `/projects/3/tasks`）。

#### Step 2：打开 Automatic annotation dialog

在 Task 卡片右上角点 **⋮ Actions → Automatic annotation**（也可以进入 Job 标注页后点工具栏的「AI Models」按钮）。

#### Step 3：Model 选择

**Model 下拉框** 里选刚才创建的实例（如果勾选了 Default，会自动选中 `[AI Instance (Default)] Street 9-Class Detector`）。

> Model 下拉里 AI Instance 类模型的 ID 格式：`__ai_instance__<id>__slug__<slug>`，这是 A3 步 Slug 解析正则识别的关键。

#### Step 4：Setup mapping（**放宽规则后不用全配对！**）

Build #20 BUG14 修复后，**只要左栏 AI label 有值，哪怕右栏 Task Label 空也能 Submit**，空的会被后端 R7/R8 自动创建。

- 同名的 label 会自动配对（如 `pedestrian ↔ pedestrian`）
- 不配对的（如 Project 3 DB 里没有 `traffic_light`）：**空着就行，不用手工选**
- 点 Annotate 提交后，后端会：
  1. 对空的 Task label：在 Project 3 labels 里当场 `Label.objects.create(name='traffic_light', type='rectangle')`
  2. 颜色按 md5 自动配色

#### Step 5：Threshold / ROI / Clean previous

| 字段 | 推荐值 |
|---|---|
| Threshold | 0.50（街景 9 类推荐 0.45~0.55） |
| Region of interest（ROI） | 留空 = 整图检测；填 `x,y,w,h`（**REAL_PIXEL_INTEGERS 强制要求**）只检测该区域 |
| Clean previous annotations | ON = 跑之前清空当前 Job 所有旧标注（推荐，方便验证） |

#### Step 6：点 Annotate 提交

提交后会跳转到 Job 详情页，右上 `Status` 会变成 `Queued → In progress → Completed`。

#### Step 7：验证结果

- 进度 100% 后：`Items: NNN`（N>0 = 成功，Items=0 = 有异常，见第 6 章）
- 打开 Job 标注页：Canvas 上会出现各种颜色的 bounding boxes，每个 box 左上有 label 名（pedestrian/cyclist/...）
- 抓 cvat_server 容器日志验证 fuzzy 分类：
  ```bash
  docker logs cvat_server 2>&1 | grep -E "FINAL ok|fuzzy:" | tail -n 10
  ```
  预期输出类似：
  ```
  [AI INSTANCE BAILIAN] FINAL ok: bailian-street-9class-v1 items 36 fuzzy: W=7 F=0 FREE=0 total_parser=9
  # ↑ 全部是 W=7 白名单命中（还有 2 类没出现在图里 = 正常）
  ```

---

### 4.2 Scenario E：图片描述 · Image Caption

#### 前置条件
- Scenario B 实例创建成功
- 同一个 Task 6（或任意有图片的 Task）

#### Step 1：Actions → Automatic annotation

Model 下拉选 `Describe Images · Bailian qwen3-vl-plus`（image_caption 类型）。

#### Step 2：Setup mapping（Caption 实例**没有 Setup mapping 区块**！）

Build #15 方案 B：image_caption 类型在 detector-runner 前端自动隐藏 Setup mapping，Annotate 按钮**默认 enabled**，不需要你选任何 label。

#### Step 3：点 Annotate

#### Step 4：验证结果

- 进度 100% 后：`Items: N`（N=Job 内图片数，Caption 是每张图 1 个 TAG，所以 N 通常等于图片数）
- 打开 Job 标注页：左侧 Object Panel → 切到 **Tags** 标签 → 每张图有一个 `caption` TAG，展开后 Attributes 里 `caption` 属性值 = 一句英文自然语言描述（比如「A busy urban intersection with multiple motor vehicles, cyclists, and plastic barriers during daytime.」）
- 抓 cvat_server 日志验证 captions parser：
  ```bash
  docker logs cvat_server 2>&1 | grep -E "CAPTION|caption.*attribute" | tail -n 10
  ```

---

## 5. Scenario D：R8 Prompt 自由模式

> **核心卖点**：不用在 Labels Tab 定义任何 label，不用在 Setup mapping 选，**只在 User Prompt 里写中文想检测什么**，VLM 吐什么就存什么，后端 4 层兜底 100% 不丢。

### 典型实验 Prompt 模板（直接替换 User Prompt）

```
{{image_width}} {{image_height}} {{total_pixels}} — {{task_name}} {{project_name}}

请在这张街景图中检测以下目标：
1. 外卖员：穿黄色/蓝色外卖工服或戴外卖头盔的骑手
2. 黄色头盔：任何明黄色的骑行头盔
3. 蓝色保温箱：外卖用的蓝色大号保温箱
4. 遮阳棚：路边摊的彩色遮阳伞或雨棚

请按 JSON 数组输出，每个对象的字段：
{ "label": string, "xtl": int, "ytl": int, "xbr": int, "ybr": int, "confidence": float }
只输出 JSON，不要其他文字。
```

### 操作步骤

1. **Edit AI Instance（Bailian Default Detector 或新建 Generic Detector）**
2. **Basic Tab**：Preset 选 **Generic Object Detector (object_detector)**（它只有 1 个 dummy label，不会干扰自由模式）
3. **Labels Tab**：**把所有 label 删掉**（Labels 列表清空 = labels.length=0 → 触发 R8 全 FREE LABEL 路径）
4. **Prompt templates Tab**：User Prompt 替换成上面的「外卖员/黄色头盔/蓝色保温箱/遮阳棚」中文实验 Prompt
5. **Save changes**
6. **Task 6 → Actions → Automatic annotation**：Model 选这个自由模式实例
7. **Setup mapping**：大概率左栏只有 1 个 dummy label（Generic Preset 带的），或者完全空（如果你把 Generic 那个也删了）→ **不用管右栏**，Annotate 亮了就点
8. **提交 Annotate**

### 验证自由模式生效（4 步铁证）

✅ **Step 1：Items > 0**（进度 100% 后不是 Items=0）

✅ **Step 2：Project Labels 页面出现 4 个新 Label（如果之前没有的话）**

打开 Project 3 → Labels Tab：应该能看到 `外卖员`、`黄色头盔`、`蓝色保温箱`、`遮阳棚` 这 4 个新创建的 Label（type=Rectangle，颜色 = md5 自动配色）

✅ **Step 3：FINAL 日志里 FREE > 0**
```bash
docker logs cvat_server 2>&1 | grep -E "FINAL ok|FREE DETECT:" | tail -n 20
# 预期（比如检测到 2 个外卖员 / 1 个黄头盔 / 0 保温箱 / 1 遮阳棚，共 4 个框，4 个新 label）：
# [R8 FIX loose] FREE DETECT: created new Label(name=外卖员, type=rectangle, id=127)
# [R8 FIX loose] FREE DETECT: created new Label(name=黄色头盔, type=rectangle, id=128)
# [R8 FIX loose] FREE DETECT: created new Label(name=遮阳棚, type=rectangle, id=129)
# [AI INSTANCE BAILIAN] FINAL ok: generic-detector items 4 fuzzy: W=0 F=0 FREE=3 total_parser=4
#                                                                      ↑ FREE=3 就是 3 个全新 label!
```

✅ **Step 4：Job 标注页 Canvas 上出现蓝/黄/红 4 色 boxes，左上 label=中文文字**

---

## 6. 常见问题 & 历史修复坑（15 个 Bug 速查）

> 下表按 Build 版本记录了修复的 Bug。如果你的现象正好对应某一行，先升级到对应 Build，再按「操作前必做：SW 缓存 3 清」执行。

| # | Build | Bug | 现象 | 根因 | 修复位置 |
|---|---|---|---|---|---|
| BUG1 | #16 | **Prompt 根本没存进 DB**（极严重！） | 每次 Save 后 Prompt Tab 看着正常，但 DB 里存的是字符串 `"string"`（6 字母）= 6 个字符；Draw 里 System=6 chars；VLM 收到的 prompt 是单词 "string" 完全不对 | form-page onFinish L205 手滑：`system_prompt_template: typeof values.systemPromptTemplate || ''`；typeof 返回类型名 `"string"`，不是实际值 | [form-page.tsx L200-L216](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/form-page.tsx#L200-L216)：改 `typeof === 'string' ? actual : fallback` |
| BUG2 | #16 | **output_format 默认错** | featureKind=object_detector + R8 自由模式（labels 空）→ output_format 默认成 captions → `parse_captions` 跑 → parsed_total=0 → Items=0 | 默认逻辑 `labels.length ? 'rectangles' : 'captions'` 只看 labels 不看 featureKind | 同上 form-page：改 `feature-aware` 4 级 fallback（image_caption 优先 captions；object_detector 优先 rectangles；seg 优先 polygons；最后才看 labels.length） |
| BUG3 | #16 | **FREE LABEL 被硬编码白名单丢弃** | Prompt 写 "外卖员/遮阳棚"，VLM 吐了但 Items=0 | `parse_rectangles L256`：`if norm_lbl NOT IN allowed_set → continue`；converter 侧 label=None return None 也丢 | [output_parsers.py L145-L231](file:///d:/cvat-develop/cvat/apps/lambda_manager/output_parsers.py#L145-L231) 新增 `_fuzzy_resolve_label`；[views.py L3016-L3117](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py#L3016-L3117) loose fallback create；[views.py L3365-L3496](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py#L3365-L3496) _parse_anno T4 全类型兜底 = **R8 4 层** |
| BUG4 | #16 | **无 fuzzy 分类统计日志** | debug FREE LABEL 时不知道是 W/F/FREE 哪类 | counters 有但没对外暴露 | [views.py L1460-L1485 + L1559-L1573](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py#L1460-L1485)：parse_rectangles 挂 `_last_stats`；FINAL 日志加 `fuzzy: W=X F=Y FREE=Z` |
| BUG5 | #18 | **Variables 按钮全 `{{undefined}}`** | Prompt templates Tab 上 8 个 Variables 按钮全显示 `{{undefined}} - undefined` | presets BUILTIN_PROMPT_VARIABLES 定义用的是 `{key, label, type}`；form-page 渲染访问的是 `.name`/`.desc`（不存在）= undefined | [form-page.tsx L367-L369](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/form-page.tsx#L367-L369)：改 `.key` / `.label` |
| BUG6 | #18 | **毒药值死循环** | Prompt TextArea 显示 "undefined"（9 chars）；每次 Save 存的是 `String(undefined)`；Drawer 里 System=9 chars；再 Save 毒药值又写回去 | 某次 BUG1 前 Save 存了坏值 `"undefined"` 字符串；sanitize 之前没覆盖住；loadExisting 又直接读出来显示 → 死循环 | [presets.ts L41-L51](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/presets.ts#L41-L51) 新增 `sanitizePromptValue(s, fallback)`（毒药值黑名单：`"undefined" / "string" / "null" / 空` → 转空串）；form-page loadExisting + onFinish 双端 sanitize |
| BUG7 | #18 | **Preset 加载全废（祖传）** | 不管点哪个 Preset，Prompt/Labels 都是空，也没绿通知 | `applyPreset()` 访问的是 `preset.systemPrompt / preset.outputFormat`（不存在的 camelCase 顶层字段）；PresetBundle 真实结构是嵌套 `preset.defaults.system_prompt_template`（snake_case） | [form-page.tsx L166-L187](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/form-page.tsx#L166-L187)：改从 `preset.defaults` 下读 snake_case 字段；+ 通知 "Loaded preset" |
| BUG8 | - | **cvat_server proxy 分页解包** | List 页白屏 / 所有实例显示 0 个；instance-card 里 map 报错空数组 | server-proxy L133 直接返回 `response.data`（DRF 返回 `{results: [], count: 0}`）没解构；list-page map 报 "undefined has no map" | server-proxy：`return response.data.results ?? response.data`；list-page：判空兼容两种格式 |
| BUG9 | #18 | **preset_id 找不到 preset 实例** | 你老 DB 里存的 preset id = `bailian-caption-simple-v1` / `qwen37-streetscene-v9`，但 PRESET_BUNDLES 里只有 `generic_caption` / `traffic_9class_v9` → findPreset 返回 undefined → 所有 preset 兜底逻辑全废 | Preset id 改了新命名规范但老 DB 数据没迁移 | [presets.ts](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/presets.ts) 新增 `PRESET_ID_ALIASES` 10 条映射（老 id → 新 id） + findPreset 5 层查找（exact/alias/normalize id/normalize name/alias normalize） |
| BUG10 | #18 | **List 页 Drawer 仍然输出毒药值** | Edit 页已经 sanitize 正常了，但 Drawer 还显示 9 chars / Copy 按钮拷到的是 `"undefined"` | instance-card 里 `summarizeConfig()` 和 Drawer `<pre>{cfg.system_prompt_template}</pre>` 直接读 DB 原始字符串，没走 sanitize / preset 兜底 | [instance-card.tsx L177-L185](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/instance-card.tsx#L177-L185) + [L231-L242](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/instance-card.tsx#L231-L242)：summarizeConfig 走 sanitize；新增 `resolvedPromptTemplates` useMemo（sanitize + preset 兜底）替换 4 处 cfg.xxx 引用 |
| BUG11 | #18 | **Preset 下拉框 No data** | Edit 页 Basic Tab Preset 下拉是空（显示 No data）；根本选不到 preset | applicablePresets 过滤条件写的是 `p.featureKind === featureKind`，但 PresetBundle 定义里根本没有 `.featureKind` 字段！它只有 `.appliesTo: Array<...>` → 全 false → 数组空 | [form-page.tsx L73-L79 / L321 / L385](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/form-page.tsx#L73-L79)：三处 `.featureKind` 全部改成 `p.appliesTo.includes(featureKind)` |
| BUG12 | #18 | **preset_id 存储不规范** | 直接把 alias（`bailian-caption-simple-v1`）存 DB；下次 findPreset 虽然还能走 alias，但多一层不如存标准 id（更稳） | 保存时没 canonicalize | 保存用 `resolvePresetIdCanonical()`（老 alias → 标准 generic_caption/traffic_9class_v9/generic_detector）；读取时同样 canonicalize |
| BUG13 | #19 | **选了 preset Save 后 DB labels 仍然空**（你截图看到的 Detector 显示 0 labels） | Basic Tab 选了 Traffic 9-Class Preset；Labels Tab 里也显示 9 个，但 Save 后回 List 页 Drawer 显示 `Labels: (none defined)` / `0 labels` / 黄条 `No labels resolved` | onFinish L240 `cfg.labels = labels`；但如果 `values.labels` 是空（anTd Form.Item name='labels' 没对应，或 setFieldsValue 没把 preset labels 写进 form state），Save 就存空数组；之前代码**对 labels 缺 preset.defaults.labels 兜底**，不像 system_prompt_template 有兜底！ | [form-page.tsx L240-L256](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/form-page.tsx#L240-L256)：`cfg.labels = (() => { if (labels && labels.length>0) return labels; if (preset 非空 && preset.defaults.labels) return preset.defaults.labels.filter(valid); return labels })()` = labels 也 preset 兜底 |
| BUG14 | #20 | **Annotate 按钮一直灰**（你这次问的问题！） | Model 已选中；Setup mapping 有 1 行没配对（traffic_light 右栏空）→ Annotate 直接灰，Submit 不出去，R7/R8 后端 auto-create 也白做 | detector-runner 条件写的是 `mappingFullyPaired = !any(row => !row[0] || !row[1])` = 每行必须左右全配对；和 R8 FREE LABEL 设计直接冲突！ | [detector-runner.tsx L100-L120](file:///d:/cvat-develop/cvat-ui/src/components/model-runner-modal/detector-runner.tsx#L100-L120)：`mappingFullyPaired || mappingHasAnyAILabel`（任意左栏 AI label 非空就亮）；空右栏交给后端 R7/R8 兜底 |
| BUG15 | #20 | **convertMappingToServer TypeError 崩** | 理论上 BUG14 修完 Annotate 亮了就能跑了，但如果真有空的 row[1] 提交，前端会直接 TypeError 崩溃（request 都不发） | 代码：`taskLabel.name`，taskLabel=null → TypeError！ | [detector-runner.tsx L56-L75](file:///d:/cvat-develop/cvat-ui/src/components/model-runner-modal/detector-runner.tsx#L56-L75)：`taskLabel && taskLabel.name ? taskLabel.name : ''`；attributesMapping/subMapping 加 Array.isArray 判空；modelLabel 空直接 skip 不写空 key |

---

### 现象 → 排查速查表（按 Items 和按钮状态分）

| 现象 | 第一怀疑 Bug | 排查步骤 |
|---|---|---|
| **Annotate 按钮灰**：Model 已选中但 Annotate disabled | BUG14 / BUG11 导致实例没读到 labels / api_key: missing | 1. Model 是否真的选中（不是 Select a model）<br>2. Build ≥ #20？是 BUG14 修了<br>3. List 页实例 Drawer：api_key: yes？否则去 Tab 2 填 API Key<br>4. SW 缓存 3 清再试 |
| **Annotate 进度 100%，Items: 0**（最常见） | BUG3 / BUG1 / BUG2 / R7 labels 不一致 | 1. 抓 FINAL 日志看 parsed_total vs items：<br>   a. parsed_total=0 → BUG2（output_format 错，captions parser 没 parse 到 box）或 BUG1（prompt=6 chars "string"，VLM 没检测）<br>   b. parsed_total=36，items=0 → BUG3（free label 丢）或 R7（AI Instance labels vs DB 名字对不上，Build ≥ #16 + #17 应该修了，重 Save 一下） |
| **Drawer 里 System=9 chars**（毒药值 "undefined"） | BUG6 / BUG1 | 1. Build ≥ #18？<br>2. 重新打开 Edit → 重新选 Preset（弹绿通知）→ Save（DB 里毒药值覆盖为真实 prompt）→ 再看 Drawer |
| **Drawer 里 Labels: (none defined)** 黄条 No labels resolved | BUG9 / BUG11 / BUG13 | 1. Build ≥ #19？<br>2. 打开 Edit → 1. Basic Tab Preset 下拉是不是有内容（不是 No data）？No data = BUG11，SW 缓存 3 清<br>3. Preset 下拉选一次对应 preset（Traffic 9-CLass / Generic）<br>4. 切 4. Labels Tab 确认能看到 9 labels / 1 label<br>5. 点 Save（BUG13 兜底会把 preset labels 写 DB） |
| **Preset 下拉 No data** | BUG11 | Build ≥ #18？SW 缓存清干净？ |
| **Variables 按钮全 {{undefined}}** | BUG5 | Build ≥ #18？ |
| **FREE LABEL（外卖员等）没有自动创建 Label** | BUG3 loose fallback 没跑 / Project 权限 / LabelType IntegrityError | 1. FINAL 日志 fuzzy: FREE=X > 0？X=0 说明 VLM 没吐（prompt 不够明确）<br>2. 日志里有 `[R8 FIX loose] FREE DETECT: created new Label` 吗？<br>3. 没有就抓 error 日志：`docker logs cvat_server 2>&1 | grep -E "IntegrityError|Label.objects.create" | tail`，通常是 LabelType 不在枚举（已在 T3 修）或颜色重复（已用 md5 自动配色避免） |
| **Caption 跑完 Items=0**（描述没存） | R6 前 Bug / BUG2 captions parser | 1. Caption Attribute Name 是否真的是 `caption`（不要改！）<br>2. Build ≥ #16（R6 三层兜底已修）<br>3. 抓日志是否有 `[CAPTION FALLBACK] use whole sentence as caption value` |
| **白屏 + Loading 闪烁（infinite loop）** | useMemo/useEffect 依赖 form 整个对象导致死循环 request | Build ≥ #14 + #17 已修 form-page：`organization.id` 替代 `organization` 依赖，`form` 替代 `formRef.current` 引用 |

---

## 附录：代码 Reference 索引（按链路 9 步）

1. **前端表单保存 onFinish**：[form-page.tsx L190-L280](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/form-page.tsx#L190-L280)
2. **前端 Annotate dialog**：[detector-runner.tsx](file:///d:/cvat-develop/cvat-ui/src/components/model-runner-modal/detector-runner.tsx)
   - Mapping convert：[L56-L75](file:///d:/cvat-develop/cvat-ui/src/components/model-runner-modal/detector-runner.tsx#L56-L75)（BUG15 修复）
   - Button enabled：[L100-L120](file:///d:/cvat-develop/cvat-ui/src/components/model-runner-modal/detector-runner.tsx#L100-L120)（BUG14 修复）
3. **Presets 定义 + Alias + sanitize**：[presets.ts](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/presets.ts)（BUG5/6/7/9/11/12/13 共享）
4. **List 页 + Drawer 渲染**：[list-page.tsx](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/list-page.tsx) · [instance-card.tsx](file:///d:/cvat-develop/cvat-ui/src/components/ai-feature-page/instance-card.tsx)（BUG10 修复）
5. **后端 Slug 解析 + LambdaGateway.get()**：[views.py L1400-L1500](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py#L1400-L1500) 附近
6. **后端 invoke() + M19 ULTRY try + fallback**：[views.py L1588-L2260](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py#L1588-L2260)
7. **_invoke_ai_instance_bailian_locally() 实际调用 + run_parser**：[views.py L1092-L1574](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py#L1092-L1574)
   - FINAL 日志 + fuzzy stats：[views.py L1559-L1573](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py#L1559-L1573)
8. **Output parsers + _fuzzy_resolve_label（R8 T1）**：[output_parsers.py L145-L231](file:///d:/cvat-develop/cvat/apps/lambda_manager/output_parsers.py#L145-L231)
   - parse_rectangles fuzzy+free：[output_parsers.py L333-L365](file:///d:/cvat-develop/cvat/apps/lambda_manager/output_parsers.py#L333-L365)
   - parse_polygons fuzzy+free：[output_parsers.py L666-L676](file:///d:/cvat-develop/cvat/apps/lambda_manager/output_parsers.py#L666-L676)
9. **R8 loose fallback（T3 FREE LABEL create Label）**：[views.py L3016-L3117](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py#L3016-L3117)
10. **_parse_anno 全类型兜底（R8 T4）**：[views.py L3365-L3496](file:///d:/cvat-develop/cvat/apps/lambda_manager/views.py#L3365-L3496)
11. **LabelType 枚举（建 Label 必须严格对齐）**：[engine/models.py L83-L94](file:///d:/cvat-develop/cvat/apps/engine/models.py#L83-L94)
