# CVAT 自动标注（Automatic annotation）使用说明（Qwen Bailian 3.7 Detector）

本文面向已部署 `Qwen Bailian 3.7 Detector` 到 CVAT（Nuclio serverless）后的日常使用：如何在 CVAT 里创建任务、导入标签、运行自动标注、查看结果与排查问题。

## 前置条件

- CVAT 启用了 serverless 组件（Nuclio）并且模型在 Models 页面可见
  - 模型目录：[(qwen37-detector)](file:///d:/cvat-develop/serverless/qwen/bailian/qwen37-detector)
  - Nuclio 配置：[(function.yaml)](file:///d:/cvat-develop/serverless/qwen/bailian/qwen37-detector/nuclio/function.yaml)
  - 推理入口：[(main.py)](file:///d:/cvat-develop/serverless/qwen/bailian/qwen37-detector/nuclio/main.py)

## 1. 检查模型是否可用（CVAT UI）

1) 打开 CVAT → Models
2) 确认存在 `Qwen Bailian 3.7 Detector`

如果 Models 页面为空，通常是 Nuclio 未启动或函数未部署成功。

## 2. 创建 Task（建议从模型导入标签）

1) CVAT → Tasks → Create a new task
2) Labels 区域点击 `From model`
3) 选择 `Qwen Bailian 3.7 Detector`，导入模型 spec 中定义的标签
4) 上传图片 / 视频等数据
5) `Submit & Open`

说明：
- 推荐用 `From model` 导入标签，这样后续“标签映射（mapping）”通常无需手动配置或只需极少配置。
- 如果模型 spec 中包含 `object`（兜底标签），任务也会自动获得 `object`，用于处理“未知类回退”场景。

## 3. 运行自动标注（Automatic annotation）

入口在 Task 详情页：

1) 打开 Task 详情页
2) 右上角 `Actions` → `Automatic annotation`
3) 在弹窗中设置：
   - Model：选择 `Qwen Bailian 3.7 Detector`
   - Mapping：将模型标签映射到任务标签（若任务标签来自 `From model`，通常是同名映射）
   - Threshold：置信度阈值（0~1），低于阈值的框不会写回
   - Region of interest（可选）：仅在 ROI 内推理，减少无关区域的结果
   - Clean previous annotations（可选）：开启后会先清理旧标注，再写入新结果
4) 点击 `Annotate`

完成后：
- 在 Job（标注界面）里会看到新增的矩形框（对象列表会增加，且通常带 `AUTO` 标识）。

## 4. 查看进度与结果

- CVAT 顶部导航 → Requests：查看自动标注任务进度/失败原因
- Job（标注界面）右侧 Objects：查看写回的框数量与标签

## 5. 常见问题排查

### 5.1 Models 页面能看到模型，但 Automatic annotation 运行没有结果

优先检查：
- 是否映射正确：模型 label 必须能映射到 Task 的 label
- Threshold 是否过高导致全部被过滤

### 5.2 Automatic annotation 失败（Requests 中显示错误）

优先检查：
- 服务器侧日志（annotation worker）
  - Docker 部署时通常在 `cvat_worker_annotation` 容器日志中看到报错
- Nuclio 函数是否能被直连调用（见下一节）

## 6.（可选）直连 Nuclio 函数自测

当你需要确认“函数本身能返回 CVAT detector 格式”时，可在部署机器上做一次 HTTP 直连测试：

1) 准备一张图片的 base64（单行）：

```bash
IMG_B64="$(base64 -w 0 /path/to/test.jpg)"
```

2) 调用函数（端口以 `nuctl deploy` 输出为准）：

```bash
curl -sS http://127.0.0.1:<httpPort> \
  -H "Content-Type: application/json" \
  -d "{\"threshold\":0.5,\"image\":\"$IMG_B64\"}"
```

期望返回：
- `[]`（无检测结果）或
- 一个 JSON 数组，元素包含 `label/confidence/points/type`，例如：

```json
[{"confidence":"0.98","label":"dog","points":[132,58,640,480],"type":"rectangle"}]
```

## 7. 重新部署模型（nuctl deploy）

当你修改了 [(function.yaml)](file:///d:/cvat-develop/serverless/qwen/bailian/qwen37-detector/nuclio/function.yaml) 或 [(main.py)](file:///d:/cvat-develop/serverless/qwen/bailian/qwen37-detector/nuclio/main.py) 后，需要重新部署 Nuclio 函数，CVAT 才会加载到最新版本（包括 spec 标签列表变化）。

### 7.1 前置检查（建议每次 deploy 前做一次）

1) 确认 Nuclio 容器运行：

```bash
sudo docker ps | grep -E "nuclio|local_gcr_registry" || true
```

2) 如果你的环境无法访问 gcr.io，需要确认本地 registry 伪装仍有效：

```bash
grep -n "gcr.io" /etc/hosts || true
sudo docker ps | grep local_gcr_registry || true
```

### 7.2 推荐 deploy 命令（单行，避免换行/反引号问题）

在部署机执行：

```bash
cd ~/cvat-develop/serverless/qwen/bailian/qwen37-detector/nuclio
sudo DOCKER_BUILDKIT=0 ~/nuctl deploy --project-name cvat --path . --file function.yaml --platform local --platform-config '{"attributes":{"network":"cvat_cvat"}}' --env BAILIAN_API_KEY="sk-xxx" --env BAILIAN_API_URL="https://ws-bpy1cch81n3j8dxs.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions" --env BAILIAN_MODEL="qwen3-vl-plus"
```

说明：
- `BAILIAN_API_URL` 必须是完整 URL 且不要包含反引号、换行、前后空格，否则函数会请求失败。
- `DOCKER_BUILDKIT=0` 用于减少构建阶段对外部 registry “拉 metadata” 的依赖，适合弱网/离线环境。
- deploy 成功会输出 `httpPort`，用于第 6 节的直连自测。

### 7.3 检查部署结果

```bash
sudo ~/nuctl get function --platform local | grep qwen-bailian-qwen37-detector
```

如果状态正常，CVAT Models 页面刷新后应能看到模型更新。

### 7.4 常见坑

- CVAT UI 已经打开但 Models/labels 没变化：刷新页面；若你改了 spec，建议新建 Task 并用 `From model` 重新导入标签。
- deploy 构建阶段卡在拉镜像：缺镜像时需要离线导入（尤其是 gcr.io/quay.io 相关镜像）或使用本地 registry 伪装。
