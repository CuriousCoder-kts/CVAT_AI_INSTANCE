# lambda_manager

CVAT Automatic Annotation（lambda）扩展：把逐帧检测框通过**外部 HTTP 微服务**接入 CVAT，并在视频任务中把多帧检测结果拼装成 CVAT **Track（轨迹）**。

配置驱动，不绑定具体模型，替代旧的模型内置本地 ONNX（CLRerNet）接线方式。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `http_microservice.py` | 通用 HTTP 检测器适配层：调用外部 `/predict`，把返回 JSON 解析为 CVAT 标注项；视频管线用进程内 BoT-SORT 分配跨帧 `track_id`；含管线分流、坐标/标签归一化、连接探测 |
| `bot_sort_tracker.py` | 纯 numpy 移植的 ultralytics **BoT-SORT** 多目标跟踪器（Kalman 运动模型 + GMC 稀疏光流相机补偿 + ByteTrack 两级关联），仅依赖 numpy / opencv / scipy |
| `track_assemble.py` | 轨迹拼装：按稳定身份（BoT-SORT `track_id` 或离线 IoU 兜底）把逐帧框收成 CVAT Track，处理缺口插值与 `outside` |

## 整体数据流

```
CVAT 帧 (base64)
  -> infer_http_microservice_from_image_b64()
       -> POST {api_url}/predict            (multipart: image + 表单字段)
       -> (视频管线) BoT-SORT.update_frame(root boxes, frame BGR)
            仅对无 parent_index 的主框做跨帧关联，写回整数 track_id
       -> parse_microservice_json()         JSON -> CVAT shapes（子件继承主框 id）
  -> assign_iou_track_keys()                (离线兜底) 无稳定 id 时帧间 IoU
  -> stitch_shapes_into_tracks()            -> CVAT tracks（插值 / outside）
```

## 视频跟踪（BoT-SORT）

视频 MOT 管线（`api_url` 端口 `:8082`）在进程内完成跨帧关联，**不再调用外部
`/track` 服务**：

- 跟踪器在每个 CVAT 自动标注 RQ job 内唯一持有一份（无 RQ 时按
  `cfg["_video_key"]` 缓存），逐帧喂入主框像素坐标 `[x1,y1,x2,y2]`、置信度、
  标签和原始 BGR 帧；每个视频自动重置。
- 算法为 ultralytics YOLO 所用 **BoT-SORT** 的纯 numpy 移植
  （`bot_sort_tracker.py`，源自 AGPL-3.0 的 ultralytics）：
  XYWH 恒速 Kalman 滤波、ByteTrack 高/低置信度两级关联、分数融合 IoU 代价、
  GMC 稀疏 Lucas-Kanade 光流全局相机运动补偿；未启用 ReID 外观分支。
- 只跟踪主框（无 `parent_index` 的 rectangle）；关键点 / Rear / Side 等子件
  经 `parent_index` 继承主框 `track_id` 与 CVAT `group`。
- 检测器若在 `/predict` 响应中自带稳定 `track_id`，以其为准（跳过 BoT-SORT）。

## 关键设计

- **跨帧身份**：只认 `track_id` / `object_id` / `instance_id`；
  通用的每帧 `id` 字段被故意忽略，避免逐帧重编号被误拼成轨迹。
- **本地 IoU 仅离线兜底**：整段结果都没有稳定 id 时，`assign_iou_track_keys()`
  用相邻帧家族锚框 IoU（默认阈值 0.45，最大跨帧间隔 5）贪心匹配，生成 `iou:N` 身份。
- **同帧家族**：子件（关键点 point1..point5、Rear、Side 等）通过 `parent_index`
  指向本帧主框，继承主框的 `track_id` 与 CVAT `group`。
- **轨迹缺口策略**：
  - 主框：短缺口（默认 ≤ 30 帧）留空由 CVAT 插值，过长缺口插 `outside`；
  - 子件：缺 1 帧即插 `outside`（不允许关键点脱离父框存在）。
- **端口即管线**：`api_url` 端口用于区分服务类型 ——
  `:8082` 视频 MOT、`:8081` 车道线、`:8080` 文档版面，其余为 generic。

## 实例配置项（AIFunctionInstance.config）

| 键 | 说明 |
| --- | --- |
| `api_url` | 检测服务完整 URL，如 `http://host:8082/predict?conf_thres=0.43`（必填） |
| `http_file_field` | multipart 文件字段名，默认 `image` |
| `http_form_fields` | 额外表单字段，支持 dict / `[{key,value}]` / `"a=1&b=2"` |
| `http_query_fields` | 额外 query 参数，合并进 `api_url`（不覆盖、不剥离原有 query） |
| `http_timeout_seconds` | 请求超时，默认 120 |
| `http_auth_header` | api_key 的请求头名，默认 `Authorization: Bearer <key>` |
| `api_key` | 鉴权密钥 |
| `botsort_config` | （仅视频管线）BoT-SORT 参数覆盖，如 `{"track_buffer":30,"match_thresh":0.8,"gmc_method":"sparseOptFlow"}`；默认值见 `bot_sort_tracker.DEFAULT_BOTSORT_CONFIG`，设 `gmc_method` 为 `"none"` 关闭相机补偿 |
| `_frame_index` | 每帧序号（CVAT 视频任务注入）；用于检测新视频起点并重置跟踪器 |
| `_video_key` | 非 RQ 环境（独立调试）区分多个视频的缓存键 |
| `output_parser_config.bbox_format` | `auto` / `xyxy` / `xywh` |
| `output_parser_config.coordinate_system` | `real_pixel` / `normalized_0_1` / `canonical_1000` / `auto` |
| `output_parser_config.confidence_threshold_default` | 默认置信度阈值 |

> 已废弃：`track_api_url`（外部 `/track` 服务）被进程内 BoT-SORT 取代，
> 配置中出现会被 `sanitize_instance_config()` 移除。

## 外部服务契约

### POST `/predict`

- 请求：`multipart/form-data`，图片字段（默认 `image=@frame.jpg`）+ 任意额外表单字段。
- 响应 JSON：检测数组可放在 `shapes` / `objects` / `detections` / `results` /
  `data` 等包装键下；每个对象支持 `label|class|category|name`、`type`、
  `points|polygon|polyline|box|bbox|rotated_box`、`confidence|score`、
  可选 `track_id|object_id|instance_id`（检测器自带稳定身份）、`parent_index`、`attributes`。
- 支持 rectangle / polygon / polyline / points / tag 几何；旋转框
  （`[cx, cy, w, h, angle]`）自动转为四边形 polygon。
- `/predict` **无需**也**不应**做跨帧关联；视频跟踪由本进程 BoT-SORT 完成。

### GET `/health`、GET `/labels`（可选）

用于 CVAT 实例的 Test connection；返回 404 视为未实现，不报错。

## 依赖

- Python 3.10+
- numpy、[opencv-python](https://pypi.org/project/opencv-python/)、
  [scipy](https://pypi.org/project/scipy/)（BoT-SORT：GMC 光流 + 匈牙利分配）
- [`requests`](https://pypi.org/project/requests/)（HTTP 调用）
- [Pillow](https://pypi.org/project/Pillow/)（读取图片真实宽高，可选）
- 运行环境为 CVAT 服务端（轨迹属性写入依赖 Django ORM；BoT-SORT 跟踪器按
  RQ job 持有，逐帧保持状态）

## 许可证说明

`bot_sort_tracker.py` 移植自 [ultralytics](https://github.com/ultralytics/ultralytics)
的 BoT-SORT（AGPL-3.0），分发时须遵守该许可证；仓库内 `ultralytics/` 目录为
移植与调试参考的上游源码，不参与运行时导入。
