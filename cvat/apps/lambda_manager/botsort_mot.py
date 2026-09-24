"""Replace adjacent-frame IoU with colleague YOLOv8 + BoT-SORT for video MOT.

Automatic annotation still invokes one frame at a time. A Job-scoped session
runs ``YOLO.predict`` plus ``BOTSORT.update`` (Ultralytics 8.4 persist is
unreliable). Each tracked vehicle is expanded to the Semi3D family:
VanCar + VanCar_kpts (5 points) + Rear, sharing ``track_id``. Lost ids stay
in the frame with ``lost=true``.

Not an HTTP ``/predict`` service. Not Magic Wand TRACKER. Not Optical Flow DIS.
"""

from __future__ import annotations

import base64
import hashlib
import io
import os
import tempfile
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable

BOTSORT_BACKENDS = frozenset({
    "botsort",
    "botsort_mot",
    "ultralytics_botsort",
    "yolo_track",
    "yolov8_track",
})
BOTSORT_MODELS = frozenset({
    "botsort",
    "botsort_mot",
    "ultralytics_botsort",
    "yolo_track",
    "yolov8_track",
})

DEFAULT_CONF = 0.15
DEFAULT_IOU = 0.3
DEFAULT_IMGSZ = 960
DEFAULT_TRACK_BUFFER = 30
# sparseOptFlow on original 4K PNGs is ~0.5s/frame; GMC+YOLO run on this view.
MOT_MAX_SIDE = 1280
SESSION_TTL_SEC = 30 * 60
MARKER = "botsort-local-mot"

_PKG_DIR = Path(__file__).resolve().parent
DEFAULT_YAML = _PKG_DIR / "botsort.yaml"
DEFAULT_WEIGHT_PATHS = (
    os.environ.get("CVAT_BOTSORT_WEIGHTS", "").strip(),
    str(_PKG_DIR / "models" / "yolov8n.pt"),
    "/opt/cvat/models/yolov8n.pt",
    "/home/django/models/yolov8n.pt",
)

# VanCar is a car body. Two-wheelers must not become VanCar (scooter/bike).
VANCAR_DET_COCO = frozenset({
    "car", "truck", "bus", "van", "pickup", "suv", "lorry",
})
VEHICLE_COCO = VANCAR_DET_COCO
VANCAR_ALIASES = frozenset({"vancar", "van_car", "vehicle", "motor_vehicle"})
NMS_IOU = 0.5
MIN_BOX_SIDE = 8
MIN_BOX_AREA_FRAC = 0.00012
# Re-attach a new BoT-SORT id to a still-visible car (spec: never mint a new id).
RECOVER_IOU = 0.35
LOST_OVERLAP_IOU = 0.35

_LOST_ATTR = {
    "name": "lost",
    "input_type": "select",
    "values": ["false", "true"],
    "mutable": True,
}
DEFAULT_BOTSORT_INJECT_LABELS: list[dict[str, Any]] = [
    {"name": "VanCar", "type": "rectangle", "attributes": [_LOST_ATTR]},
    {"name": "VanCar_kpts", "type": "points", "attributes": [_LOST_ATTR]},
    {"name": "Rear", "type": "rectangle", "attributes": [_LOST_ATTR]},
]
FAMILY_PARENT = "VanCar"
FAMILY_KPTS = "VanCar_kpts"
FAMILY_REAR = "Rear"

_LOCK = threading.Lock()
_SESSIONS: dict[str, "_BotsortSession"] = {}


def cfg_is_botsort_mot(cfg: dict | None) -> bool:
    """Retired. Local YOLOv8+BoT-SORT is not used on Automatic annotation.

    Video jobs go through the colleague HTTP /predict detector, then
    track_id (or IoU fallback) in track_assemble. Keep this False so leftover
    AI instances cannot re-enter the in-process MOT path.
    """
    return False


def allowed_label_names(cfg: dict | None) -> list[str]:
    names: list[str] = []
    if not isinstance(cfg, dict):
        return names
    raw = cfg.get("labels")
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                name = str(item.get("name") or "").strip()
            else:
                name = str(item or "").strip()
            if name:
                names.append(name)
    return names


def map_coco_label(coco_name: str, cfg: dict | None) -> str | None:
    """Map a YOLO class name to a CVAT label, or None to drop the box."""
    src = str(coco_name or "").strip()
    if not src:
        return None
    cfg = cfg if isinstance(cfg, dict) else {}
    raw_map = cfg.get("label_map") or cfg.get("class_map") or {}
    if isinstance(raw_map, dict):
        for key, val in raw_map.items():
            if str(key).strip().lower() == src.lower() and val is not None:
                mapped = str(val).strip()
                if mapped:
                    return mapped

    allowed = allowed_label_names(cfg)
    if not allowed:
        return src
    by_lower = {n.lower(): n for n in allowed}
    if src.lower() in by_lower:
        return by_lower[src.lower()]

    vancar = next((n for n in allowed if n.lower() in VANCAR_ALIASES), None)
    if vancar and src.lower() in VEHICLE_COCO:
        return vancar
    return None


def _points_xyxy(points) -> list[float] | None:
    if not isinstance(points, (list, tuple)) or len(points) < 4:
        return None
    try:
        x1, y1, x2, y2 = float(points[0]), float(points[1]), float(points[2]), float(points[3])
    except (TypeError, ValueError):
        return None
    return [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]


def _iou_boxes(a: list[float], b: list[float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1]) + max(0.0, b[2] - b[0]) * max(
        0.0, b[3] - b[1]
    ) - inter
    if union <= 0:
        return 0.0
    return inter / union


def _box_inside_frac(box: list[float], img_wh: tuple[int, int]) -> float:
    iw, ih = img_wh
    if iw <= 0 or ih <= 0:
        return 1.0
    x1, y1, x2, y2 = box
    area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if area <= 0:
        return 0.0
    ix1, iy1 = max(0.0, x1), max(0.0, y1)
    ix2, iy2 = min(float(iw), x2), min(float(ih), y2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    return inter / area


def recover_track_ids(
    current: list[dict[str, Any]],
    last_seen: dict[str, dict[str, Any]],
    *,
    iou_threshold: float = RECOVER_IOU,
) -> list[dict[str, Any]]:
    """Keep the previous id when BoT-SORT minted a new one on the same car.

    Spec: after a miss, the object must come back with the same ``track_id``.
    """
    if not current or not last_seen:
        return current
    live = {str(item.get("track_id") or "").strip() for item in current}
    live.discard("")
    missing = {
        tid: prev
        for tid, prev in last_seen.items()
        if tid and tid not in live and _points_xyxy(prev.get("points"))
    }
    if not missing:
        return current

    pairs: list[tuple[float, int, str]] = []
    for i, item in enumerate(current):
        tid = str(item.get("track_id") or "").strip()
        if tid and tid in last_seen:
            continue
        box = _points_xyxy(item.get("points"))
        if box is None:
            continue
        for old_id, prev in missing.items():
            pbox = _points_xyxy(prev.get("points"))
            if pbox is None:
                continue
            score = _iou_boxes(box, pbox)
            if score >= iou_threshold:
                pairs.append((score, i, old_id))
    pairs.sort(key=lambda row: row[0], reverse=True)

    used_cur: set[int] = set()
    used_old: set[str] = set()
    remap: dict[int, str] = {}
    for _score, i, old_id in pairs:
        if i in used_cur or old_id in used_old:
            continue
        used_cur.add(i)
        used_old.add(old_id)
        remap[i] = old_id

    if not remap:
        return current
    out: list[dict[str, Any]] = []
    for i, item in enumerate(current):
        row = dict(item)
        if i in remap:
            row["track_id"] = remap[i]
        out.append(row)
    return out


def merge_lost_tracks(
    current: list[dict[str, Any]],
    last_seen: dict[str, dict[str, Any]],
    lost_age: dict[str, int],
    track_buffer: int,
    *,
    img_wh: tuple[int, int] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], dict[str, int]]:
    """Keep unmatched ids in memory until ``track_buffer`` expires.

    In-frame detector misses are not drawn (no frozen ghost on a visible car).
    The id stays in ``last_seen`` so a later hit can recover it. ``lost=true``
    is only emitted when the last box is mostly outside the image.
    """
    buffer = max(1, int(track_buffer or DEFAULT_TRACK_BUFFER))
    live_ids: set[str] = set()
    live_boxes: list[list[float]] = []
    out: list[dict[str, Any]] = []
    next_seen: dict[str, dict[str, Any]] = {}
    next_age: dict[str, int] = {}

    for item in current:
        if not isinstance(item, dict):
            continue
        tid = str(item.get("track_id") or "").strip()
        row = dict(item)
        row["lost"] = False
        attrs = list(row.get("attributes") or [])
        attrs = [a for a in attrs if not (
            isinstance(a, dict) and str(a.get("name") or "").strip().lower() == "lost"
        )]
        attrs.append({"name": "lost", "value": "false"})
        row["attributes"] = attrs
        row["occluded"] = False
        out.append(row)
        box = _points_xyxy(row.get("points"))
        if box:
            live_boxes.append(box)
        if tid:
            live_ids.add(tid)
            next_seen[tid] = {
                "track_id": tid,
                "label": row.get("label"),
                "type": row.get("type") or "rectangle",
                "points": list(row.get("points") or []),
                "confidence": row.get("confidence", 0),
            }
            next_age[tid] = 0

    for tid, prev in last_seen.items():
        if tid in live_ids:
            continue
        age = int(lost_age.get(tid, 0)) + 1
        if age > buffer:
            continue
        pts = list(prev.get("points") or [])
        if len(pts) < 4:
            continue
        lost_box = _points_xyxy(pts)
        if lost_box and any(_iou_boxes(lost_box, lb) >= LOST_OVERLAP_IOU for lb in live_boxes):
            continue
        in_frame = True
        if img_wh and lost_box:
            in_frame = _box_inside_frac(lost_box, img_wh) >= 0.5
        if in_frame and img_wh:
            next_seen[tid] = dict(prev)
            next_age[tid] = age
            continue
        lost_row = {
            "label": prev.get("label") or "object",
            "type": prev.get("type") or "rectangle",
            "points": pts,
            "confidence": prev.get("confidence", 0),
            "track_id": tid,
            "lost": True,
            "occluded": True,
            "attributes": _lost_attr(True),
        }
        out.append(lost_row)
        next_seen[tid] = dict(prev)
        next_age[tid] = age

    return out, next_seen, next_age


def wants_vancar_family(cfg: dict | None) -> bool:
    names = {n.lower() for n in allowed_label_names(cfg)}
    if not names:
        return True
    return bool(names & {"vancar", "vancar_kpts", "rear"})


def vancar_kpts_from_box(x1: float, y1: float, x2: float, y2: float) -> list[float]:
    """Five points: body corners (inset) + roof. Matches MOT_OFFLINE example order."""
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    ix, iy = 0.05 * w, 0.05 * h
    return [
        round(x1 + ix, 2), round(y1 + iy, 2),
        round(x2 - ix, 2), round(y1 + iy, 2),
        round(x2 - ix, 2), round(y2 - iy, 2),
        round(x1 + ix, 2), round(y2 - iy, 2),
        round((x1 + x2) / 2.0, 2), round(y1 + 0.12 * h, 2),
    ]


def rear_box_from_box(x1: float, y1: float, x2: float, y2: float) -> list[float]:
    """Rear patch inside the VanCar box.

    Wide boxes (rear/side of a van) keep the Semi3D bottom band. Tall/square
    boxes are usually the front of the car in this camera, so the rear sits
    on the far (top) band instead of the headlights.
    """
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    if h >= 0.85 * w:
        return [
            round(x1 + 0.27 * w, 2),
            round(y1 + 0.02 * h, 2),
            round(x2 - 0.26 * w, 2),
            round(y1 + 0.42 * h, 2),
        ]
    return [
        round(x1 + 0.27 * w, 2),
        round(y1 + 0.55 * h, 2),
        round(x2 - 0.26 * w, 2),
        round(y2 - 0.015 * h, 2),
    ]


def _family_group_id(track_id: str) -> int:
    digest = hashlib.md5(f"tid:{track_id}".encode("utf-8")).hexdigest()
    n = int(digest[:8], 16) & 0x7FFFFFFF
    return n if n else 1


def _lost_attr(lost: bool) -> list[dict[str, str]]:
    return [{"name": "lost", "value": "true" if lost else "false"}]


def expand_item_to_vancar_family(item: dict[str, Any], parent_index: int) -> list[dict[str, Any]]:
    pts = list(item.get("points") or [])
    if len(pts) < 4:
        return [item]
    x1, y1, x2, y2 = [float(pts[0]), float(pts[1]), float(pts[2]), float(pts[3])]
    tid = str(item.get("track_id") or "").strip()
    lost = bool(item.get("lost"))
    score = item.get("confidence", item.get("score", 0))
    gid = _family_group_id(tid) if tid else _family_group_id(f"anon:{parent_index}")
    occluded = bool(item.get("occluded") or lost)
    parent = {
        "label": FAMILY_PARENT,
        "type": "rectangle",
        "points": [round(x1, 2), round(y1, 2), round(x2, 2), round(y2, 2)],
        "confidence": score,
        "track_id": tid,
        "lost": lost,
        "occluded": occluded,
        "group_id": gid,
        "attributes": _lost_attr(lost),
    }
    kpts = {
        "label": FAMILY_KPTS,
        "type": "points",
        "points": vancar_kpts_from_box(x1, y1, x2, y2),
        "confidence": score,
        "track_id": tid,
        "parent_index": parent_index,
        "lost": lost,
        "occluded": occluded,
        "group_id": gid,
        "attributes": _lost_attr(lost),
    }
    rear = {
        "label": FAMILY_REAR,
        "type": "rectangle",
        "points": rear_box_from_box(x1, y1, x2, y2),
        "confidence": score,
        "track_id": tid,
        "parent_index": parent_index,
        "lost": lost,
        "occluded": occluded,
        "group_id": gid,
        "attributes": _lost_attr(lost),
    }
    return [parent, kpts, rear]


def expand_tracked_boxes_to_families(
    items: list[dict[str, Any]],
    cfg: dict | None = None,
) -> list[dict[str, Any]]:
    """Turn each tracked vehicle box into VanCar + VanCar_kpts + Rear."""
    if not wants_vancar_family(cfg):
        return list(items or [])
    out: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").lower()
        typ = str(item.get("type") or "rectangle").lower()
        if typ != "rectangle" or label in {"vancar_kpts", "rear"}:
            out.append(item)
            continue
        if label not in VANCAR_ALIASES and label not in VEHICLE_COCO and label != "vancar":
            out.append(item)
            continue
        parent_index = len(out)
        out.extend(expand_item_to_vancar_family(item, parent_index))
    return out


class _DetBatch:
    """Minimal Ultralytics-Results stand-in for BOTSORT.update()."""

    def __init__(self, xyxy, conf, cls):
        import numpy as np
        self.xyxy = np.asarray(xyxy, dtype=np.float32)
        if self.xyxy.size == 0:
            self.xyxy = np.zeros((0, 4), dtype=np.float32)
            self.xywh = np.zeros((0, 4), dtype=np.float32)
            self.conf = np.zeros((0,), dtype=np.float32)
            self.cls = np.zeros((0,), dtype=np.float32)
            return
        if self.xyxy.ndim == 1:
            self.xyxy = self.xyxy.reshape(1, -1)
        w = self.xyxy[:, 2] - self.xyxy[:, 0]
        h = self.xyxy[:, 3] - self.xyxy[:, 1]
        cx = self.xyxy[:, 0] + w / 2.0
        cy = self.xyxy[:, 1] + h / 2.0
        self.xywh = np.stack([cx, cy, w, h], axis=1).astype(np.float32)
        self.conf = np.asarray(conf, dtype=np.float32).reshape(-1)
        self.cls = np.asarray(cls, dtype=np.float32).reshape(-1)

    def __len__(self):
        return int(self.xyxy.shape[0])

    def __getitem__(self, idx):
        return _DetBatch(self.xyxy[idx], self.conf[idx], self.cls[idx])


def _new_botsort_tracker(cfg: dict | None = None):
    cfg = cfg if isinstance(cfg, dict) else {}
    try:
        from ultralytics.trackers.bot_sort import BOTSORT
    except ImportError as exc:
        raise RuntimeError(
            "BoT-SORT association needs ultralytics "
            "(pip install ultralytics on cvat_server / cvat_worker_annotation)."
        ) from exc
    gmc_method = str(cfg.get("gmc_method") or "sparseOptFlow").strip() or "sparseOptFlow"
    if gmc_method.lower() in {"off", "false", "0", "disabled"}:
        gmc_method = "none"
    track_buffer = _cfg_int(cfg, "track_buffer", default=DEFAULT_TRACK_BUFFER)
    yaml_path = _make_tracker_yaml(
        gmc_method=gmc_method,
        tracker_type="botsort",
        track_buffer=track_buffer,
    )
    args: dict[str, Any] = {}
    try:
        import yaml
        with open(yaml_path, encoding="utf-8") as fh:
            loaded = yaml.safe_load(fh) or {}
        if isinstance(loaded, dict):
            args.update(loaded)
    except Exception:
        args = {
            "tracker_type": "botsort",
            "track_high_thresh": 0.15,
            "track_low_thresh": 0.05,
            "new_track_thresh": 0.15,
            "track_buffer": track_buffer,
            "match_thresh": 0.7,
            "fuse_score": False,
            "gmc_method": gmc_method,
            "proximity_thresh": 0.5,
            "appearance_thresh": 0.8,
            "with_reid": False,
        }
    try:
        os.unlink(yaml_path)
    except OSError:
        pass

    class _Args:
        pass
    ns = _Args()
    for key, val in args.items():
        setattr(ns, key, val)
    for key, default in (
        ("track_high_thresh", 0.15),
        ("track_low_thresh", 0.05),
        ("new_track_thresh", 0.15),
        ("track_buffer", track_buffer),
        ("match_thresh", 0.7),
        ("fuse_score", False),
        ("gmc_method", gmc_method),
        ("proximity_thresh", 0.5),
        ("appearance_thresh", 0.8),
        ("with_reid", False),
        ("model", "auto"),
        ("device", None),
    ):
        if not hasattr(ns, key):
            setattr(ns, key, default)
    # Ultralytics 8.4 BOTSORT only takes args; older 8.1 used frame_rate=.
    try:
        return BOTSORT(ns)
    except TypeError:
        return BOTSORT(ns, frame_rate=30)


def associate_shapes_with_botsort(
    shapes: list[dict[str, Any]],
    *,
    get_image_b64: Callable[[int], str],
    cfg: dict | None = None,
) -> int:
    """Replace adjacent-frame IoU with colleague BoT-SORT on family anchors.

    Same-frame children already share ``group``; they inherit the parent track id.
    Returns how many shapes received a new ``_track_key``.
    """
    from cvat.apps.lambda_manager.track_assemble import (
        TRACK_KEY_FIELD,
        _anchor_box,
        _family_groups,
        _iou,
        _stable_group_id,
    )

    if not shapes:
        return 0
    by_frame: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for shape in shapes:
        if not isinstance(shape, dict):
            continue
        try:
            frame = int(shape.get("frame") or 0)
        except (TypeError, ValueError):
            continue
        by_frame[frame].append(shape)

    tracker = _new_botsort_tracker(cfg)
    assigned = 0

    def _stamp(members: list[dict[str, Any]], tid: str) -> None:
        nonlocal assigned
        gid = _stable_group_id(f"tid:{tid}")
        for shape in members:
            if shape.get(TRACK_KEY_FIELD):
                continue
            shape[TRACK_KEY_FIELD] = str(tid)
            shape["group"] = gid
            assigned += 1

    for frame in sorted(by_frame):
        families = _family_groups(by_frame[frame])
        pending: list[dict[str, Any]] = []
        xyxy: list[list[float]] = []
        confs: list[float] = []
        clss: list[float] = []
        for members in families:
            if any(m.get(TRACK_KEY_FIELD) for m in members):
                continue
            box = _anchor_box(members)
            if box is None:
                continue
            pending.append({"box": box, "members": members})
            xyxy.append(box)
            confs.append(0.9)
            clss.append(0.0)
        # Boxes are already in image coords. Do not re-decode original frames
        # (sparseOptFlow GMC on 4K PNGs is why auto-ann stuck at 99% for hours).
        outputs = tracker.update(_DetBatch(xyxy, confs, clss), None)
        tracks: list[tuple[list[float], str]] = []
        if outputs is None:
            rows = []
        elif hasattr(outputs, "tolist"):
            rows = outputs.tolist()
        else:
            rows = list(outputs)
        for row in rows:
            if not row or len(row) < 5:
                continue
            tracks.append(([float(row[0]), float(row[1]), float(row[2]), float(row[3])], str(int(row[4]))))

        used_fam: set[int] = set()
        used_trk: set[int] = set()
        pairs: list[tuple[float, int, int]] = []
        for i, fam in enumerate(pending):
            for j, (tbox, _tid) in enumerate(tracks):
                score = _iou(fam["box"], tbox)
                if score >= 0.3:
                    pairs.append((score, i, j))
        pairs.sort(key=lambda item: item[0], reverse=True)
        for _score, i, j in pairs:
            if i in used_fam or j in used_trk:
                continue
            used_fam.add(i)
            used_trk.add(j)
            _stamp(pending[i]["members"], tracks[j][1])

    return assigned


def session_key_from_payload(payload: dict | None) -> str:
    if not isinstance(payload, dict):
        return "anon"
    job = payload.get("job")
    task = payload.get("task")
    if job is not None and str(job).strip() != "":
        return f"job:{job}"
    if task is not None and str(task).strip() != "":
        return f"task:{task}"
    return "anon"


def resolve_weights_path(cfg: dict | None) -> str:
    candidates: list[str] = []
    if isinstance(cfg, dict):
        for key in ("weights", "model_path", "onnx_path"):
            raw = cfg.get(key)
            if raw and str(raw).strip():
                candidates.append(str(raw).strip())
    candidates.extend([p for p in DEFAULT_WEIGHT_PATHS if p])
    for path in candidates:
        if Path(path).is_file():
            return path
    # Ultralytics can download yolov8n.pt by name if the network is open.
    named = next((p for p in candidates if p.endswith(".pt")), "yolov8n.pt")
    return named


def _decode_bgr(image_b64: str):
    import numpy as np

    text = str(image_b64 or "").strip()
    if not text:
        raise ValueError("BoT-SORT MOT needs the current frame image")
    if "," in text and text.lower().startswith("data:"):
        text = text.split(",", 1)[1]
    raw = base64.b64decode(text)
    try:
        import cv2
        arr = np.frombuffer(raw, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is not None:
            return bgr
    except Exception:
        pass
    from PIL import Image as PILImage
    with PILImage.open(io.BytesIO(raw)) as pimg:
        rgb = pimg.convert("RGB")
        import numpy as np
        rgb_np = np.array(rgb)
    try:
        import cv2
        return cv2.cvtColor(rgb_np, cv2.COLOR_RGB2BGR)
    except Exception:
        return rgb_np[:, :, ::-1]


def _downscale_for_mot(bgr, max_side: int = MOT_MAX_SIDE):
    """Shrink a copy for YOLO + GMC. Caller must scale boxes back to original."""
    h, w = int(bgr.shape[0]), int(bgr.shape[1])
    m = max(h, w)
    if m <= max_side:
        return bgr, 1.0
    import cv2
    scale = max_side / float(m)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    return cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR), scale


def _box_area_ok(x1: float, y1: float, x2: float, y2: float, img_wh: tuple[int, int]) -> bool:
    w = abs(float(x2) - float(x1))
    h = abs(float(y2) - float(y1))
    if w < MIN_BOX_SIDE or h < MIN_BOX_SIDE:
        return False
    iw, ih = img_wh
    area = w * h
    if iw > 0 and ih > 0 and area < MIN_BOX_AREA_FRAC * iw * ih:
        return False
    return True


def _nms_keep(xyxy: list[list[float]], confs: list[float], iou_thr: float = NMS_IOU) -> list[int]:
    if not xyxy:
        return []
    import numpy as np
    boxes = np.asarray(xyxy, dtype=np.float32)
    scores = np.asarray(confs, dtype=np.float32)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(boxes[i, 0], boxes[rest, 0])
        yy1 = np.maximum(boxes[i, 1], boxes[rest, 1])
        xx2 = np.minimum(boxes[i, 2], boxes[rest, 2])
        yy2 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        area_i = np.maximum(0.0, boxes[i, 2] - boxes[i, 0]) * np.maximum(0.0, boxes[i, 3] - boxes[i, 1])
        area_r = np.maximum(0.0, boxes[rest, 2] - boxes[rest, 0]) * np.maximum(0.0, boxes[rest, 3] - boxes[rest, 1])
        union = area_i + area_r - inter
        iou = np.divide(inter, union, out=np.zeros_like(inter), where=union > 0)
        order = rest[iou <= iou_thr]
    return keep


def _append_unmatched_dets(
    current: list[dict[str, Any]],
    xyxy: list[list[float]],
    confs: list[float],
    labels: list[str],
    used: set[int],
    inv: float,
    iou_thr: float = 0.45,
) -> None:
    """Keep YOLO boxes that BoT-SORT did not confirm (frame-0 unconfirmed, GMC miss)."""
    covered: list[list[float]] = []
    next_id = 1
    for item in current:
        box = _points_xyxy(item.get("points"))
        if box:
            covered.append(box)
        try:
            next_id = max(next_id, int(str(item.get("track_id") or 0)) + 1)
        except (TypeError, ValueError):
            pass
    for i, box in enumerate(xyxy):
        if i in used:
            continue
        pts = [round(float(v) * inv, 2) for v in box[:4]]
        det_box = _points_xyxy(pts)
        if det_box is None:
            continue
        if any(_iou_boxes(det_box, c) >= iou_thr for c in covered):
            continue
        label = labels[i] if i < len(labels) else None
        if not label:
            continue
        score = float(confs[i]) if i < len(confs) else 0.0
        current.append({
            "label": label,
            "type": "rectangle",
            "points": pts,
            "confidence": round(score, 4),
            "track_id": str(next_id),
        })
        covered.append(det_box)
        used.add(i)
        next_id += 1


def _cfg_float(cfg: dict, *keys: str, default: float) -> float:
    for key in keys:
        raw = cfg.get(key)
        if raw is None or raw == "":
            continue
        try:
            return float(raw)
        except (TypeError, ValueError):
            continue
    return float(default)


def _cfg_int(cfg: dict, *keys: str, default: int) -> int:
    for key in keys:
        raw = cfg.get(key)
        if raw is None or raw == "":
            continue
        try:
            return int(raw)
        except (TypeError, ValueError):
            continue
    return int(default)


def _make_tracker_yaml(*, gmc_method: str, tracker_type: str, track_buffer: int) -> str:
    src = DEFAULT_YAML.read_text(encoding="utf-8") if DEFAULT_YAML.is_file() else (
        "tracker_type: botsort\ntrack_buffer: 30\ngmc_method: none\nwith_reid: False\n"
    )
    lines = []
    seen_type = seen_gmc = seen_buf = False
    for ln in src.splitlines():
        if ln.startswith("tracker_type:"):
            lines.append(f"tracker_type: {tracker_type}")
            seen_type = True
        elif ln.startswith("gmc_method:"):
            lines.append(f"gmc_method: {gmc_method}")
            seen_gmc = True
        elif ln.startswith("track_buffer:"):
            lines.append(f"track_buffer: {track_buffer}")
            seen_buf = True
        else:
            lines.append(ln)
    if not seen_type:
        lines.append(f"tracker_type: {tracker_type}")
    if not seen_gmc:
        lines.append(f"gmc_method: {gmc_method}")
    if not seen_buf:
        lines.append(f"track_buffer: {track_buffer}")
    handle = tempfile.NamedTemporaryFile(
        prefix="cvat-botsort-", suffix=".yaml", delete=False, mode="w", encoding="utf-8",
    )
    handle.write("\n".join(lines) + "\n")
    handle.close()
    return handle.name


class _BotsortSession:
    def __init__(self, cfg: dict):
        self.cfg = dict(cfg)
        self.model = None
        self.tracker = None
        self.yaml_path = ""
        self.last_seen: dict[str, dict[str, Any]] = {}
        self.lost_age: dict[str, int] = {}
        self.last_frame: int | None = None
        self.touched = time.time()
        self.names: dict[int, str] = {}

    def close(self) -> None:
        self.model = None
        self.tracker = None
        self.last_seen.clear()
        self.lost_age.clear()
        if self.yaml_path:
            try:
                os.unlink(self.yaml_path)
            except OSError:
                pass
            self.yaml_path = ""


def _purge_expired_locked(now: float) -> None:
    dead = [k for k, s in _SESSIONS.items() if now - s.touched > SESSION_TTL_SEC]
    for key in dead:
        _SESSIONS.pop(key).close()


def _get_session(key: str, cfg: dict, frame: int | None) -> _BotsortSession:
    now = time.time()
    _purge_expired_locked(now)
    sess = _SESSIONS.get(key)
    rewind = (
        sess is not None
        and frame is not None
        and sess.last_frame is not None
        and int(frame) < int(sess.last_frame)
    )
    if sess is None or rewind:
        if sess is not None:
            sess.close()
        sess = _BotsortSession(cfg)
        _SESSIONS[key] = sess
    sess.touched = now
    return sess


def close_session(key: str) -> None:
    with _LOCK:
        sess = _SESSIONS.pop(key, None)
    if sess is not None:
        sess.close()


def _ensure_model(sess: _BotsortSession, cfg: dict) -> None:
    if sess.model is not None:
        return
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise RuntimeError(
            "BoT-SORT MOT needs ultralytics on cvat_server / cvat_worker_annotation "
            "(pip install ultralytics). Place weights at /opt/cvat/models/yolov8n.pt "
            "or set config.weights / CVAT_BOTSORT_WEIGHTS."
        ) from exc

    gmc_method = str(cfg.get("gmc_method") or "sparseOptFlow").strip() or "sparseOptFlow"
    if gmc_method.lower() in {"off", "false", "0", "disabled"}:
        gmc_method = "none"
    tracker_type = "botsort"
    npz = str(cfg.get("gmc_matrices") or cfg.get("gmc_npz") or "").strip()
    if gmc_method.lower() in {"ext", "external", "cv610"} or npz:
        tracker_type = "botsort_ext"
        gmc_method = "none"
        os.environ["GMC_MATRICES"] = npz
        from cvat.apps.lambda_manager.gmc_ext import register_botsort_ext
        register_botsort_ext(npz, first_index=0)

    track_buffer = _cfg_int(cfg, "track_buffer", default=DEFAULT_TRACK_BUFFER)
    sess.yaml_path = _make_tracker_yaml(
        gmc_method=gmc_method if tracker_type == "botsort" else "none",
        tracker_type=tracker_type,
        track_buffer=track_buffer,
    )
    weights = resolve_weights_path(cfg)
    sess.model = YOLO(weights)
    sess.tracker = _new_botsort_tracker(cfg)
    names = getattr(sess.model, "names", None) or {}
    if isinstance(names, dict):
        sess.names = {int(k): str(v) for k, v in names.items()}
    elif isinstance(names, (list, tuple)):
        sess.names = {i: str(n) for i, n in enumerate(names)}


def _class_filter(cfg: dict) -> set[str] | None:
    raw = cfg.get("class_filter") or cfg.get("classes")
    names: list[str] = []
    if isinstance(raw, str) and raw.strip():
        names = [p.strip() for p in raw.split(",") if p.strip()]
    elif isinstance(raw, (list, tuple)):
        for item in raw:
            if isinstance(item, dict):
                n = str(item.get("name") or "").strip()
            else:
                n = str(item or "").strip()
            if n:
                names.append(n)
    if names:
        return {n.lower() for n in names}
    allowed = allowed_label_names(cfg)
    if not allowed:
        return None
    # VanCar family: only 4-wheel YOLO classes. Scooter/bike/person stay out.
    if any(n.lower() in VANCAR_ALIASES for n in allowed) and not any(
        n.lower() in VEHICLE_COCO or n.lower() == "person" for n in allowed
    ):
        return set(VANCAR_DET_COCO)
    return {n.lower() for n in allowed}


def infer_botsort_from_image_b64(
    image_b64: str,
    *,
    cfg: dict | None,
    threshold: float | None = None,
    payload: dict | None = None,
) -> list[dict[str, Any]]:
    cfg = dict(cfg) if isinstance(cfg, dict) else {}
    payload = payload if isinstance(payload, dict) else {}
    bgr = _decode_bgr(image_b64)
    key = session_key_from_payload(payload)
    try:
        frame = int(payload.get("frame"))
    except (TypeError, ValueError):
        frame = None
    frame_is_last = str(payload.get("frame_is_last") or "").strip() in {"1", "true", "True", "yes"}

    conf = threshold if threshold is not None else _cfg_float(cfg, "conf", "confidence", default=DEFAULT_CONF)
    try:
        conf = float(conf)
    except (TypeError, ValueError):
        conf = DEFAULT_CONF
    # Instance forms often store VLM default 0.5; yolov8n on this camera is ~0.16.
    if conf >= 0.45:
        conf = DEFAULT_CONF
    iou = _cfg_float(cfg, "iou", default=DEFAULT_IOU)
    imgsz = _cfg_int(cfg, "imgsz", "img_size", default=DEFAULT_IMGSZ)
    # Instance preset stored 640; distant HDR cars vanish at that size.
    if imgsz < 800:
        imgsz = DEFAULT_IMGSZ
    device = str(cfg.get("device") or os.environ.get("CVAT_BOTSORT_DEVICE") or "cpu").strip() or "cpu"
    track_buffer = _cfg_int(cfg, "track_buffer", default=DEFAULT_TRACK_BUFFER)
    keep = _class_filter(cfg)

    with _LOCK:
        sess = _get_session(key, cfg, frame)
        _ensure_model(sess, cfg)
        model = sess.model
        tracker = sess.tracker
        names = dict(sess.names)

    view, scale = _downscale_for_mot(bgr)
    inv = (1.0 / scale) if scale else 1.0
    orig_wh = (int(bgr.shape[1]), int(bgr.shape[0]))
    class_ids = None
    if keep:
        class_ids = [i for i, n in names.items() if str(n).lower() in keep]
    predict_kw: dict[str, Any] = {
        "conf": conf,
        "iou": iou,
        "imgsz": imgsz,
        "device": device,
        "verbose": False,
    }
    if class_ids:
        predict_kw["classes"] = class_ids
    preds = model.predict(view, **predict_kw)
    r0 = preds[0] if preds else None
    current: list[dict[str, Any]] = []
    boxes_obj = getattr(r0, "boxes", None) if r0 is not None else None
    xyxy: list[list[float]] = []
    confs: list[float] = []
    clss: list[float] = []
    labels: list[str] = []
    if boxes_obj is not None and getattr(boxes_obj, "xyxy", None) is not None and len(boxes_obj) > 0:
        boxes = boxes_obj.xyxy.cpu().numpy()
        box_confs = boxes_obj.conf.cpu().numpy() if boxes_obj.conf is not None else [0.0] * len(boxes)
        box_clss = boxes_obj.cls.cpu().numpy() if boxes_obj.cls is not None else [0.0] * len(boxes)
        for box, score, cls_id in zip(boxes, box_confs, box_clss):
            coco = names.get(int(cls_id), "object")
            if keep is not None and coco.lower() not in keep:
                mapped = map_coco_label(coco, cfg)
                if not mapped:
                    continue
                label = mapped
            else:
                label = map_coco_label(coco, cfg)
                if not label:
                    continue
            x1, y1, x2, y2 = [float(v) for v in box[:4]]
            if not _box_area_ok(x1 * inv, y1 * inv, x2 * inv, y2 * inv, orig_wh):
                continue
            xyxy.append([x1, y1, x2, y2])
            confs.append(float(score))
            clss.append(float(cls_id))
            labels.append(label)

    if len(xyxy) > 1:
        keep_idx = _nms_keep(xyxy, confs)
        xyxy = [xyxy[i] for i in keep_idx]
        confs = [confs[i] for i in keep_idx]
        clss = [clss[i] for i in keep_idx]
        labels = [labels[i] for i in keep_idx]

    tracks = []
    if tracker is not None:
        raw = tracker.update(_DetBatch(xyxy, confs, clss), view)
        if raw is None:
            tracks = []
        elif hasattr(raw, "tolist"):
            tracks = raw.tolist()
        else:
            tracks = list(raw)
        # BYTETrack hides new tracks (is_activated=False) until frame 2; still emit their ids.
        seen_ids: set[int] = set()
        for row in tracks:
            if row and len(row) > 4:
                try:
                    seen_ids.add(int(row[4]))
                except (TypeError, ValueError):
                    pass
        # Only first-frame unconfirmed tracks. Dumping all tracked_stracks
        # duplicated the same car under new ids (23 VanCars on one frame).
        extra = getattr(tracker, "tracked_stracks", None) or []
        for trk in extra:
            if getattr(trk, "is_activated", False):
                continue
            if int(getattr(trk, "time_since_update", 1) or 1) > 0:
                continue
            tid = getattr(trk, "track_id", None)
            if tid is None:
                continue
            try:
                tid_i = int(tid)
            except (TypeError, ValueError):
                continue
            if tid_i in seen_ids:
                continue
            result = getattr(trk, "result", None)
            if result is None:
                continue
            tracks.append(result)
            seen_ids.add(tid_i)
    used: set[int] = set()
    if tracks:
        for row in tracks:
            if not row or len(row) < 5:
                continue
            vx1, vy1, vx2, vy2 = [float(row[0]), float(row[1]), float(row[2]), float(row[3])]
            tid = str(int(row[4]))
            score = float(row[5]) if len(row) > 5 else 0.0
            det_idx = int(row[7]) if len(row) > 7 else -1
            label = labels[det_idx] if 0 <= det_idx < len(labels) else None
            if label is None:
                best_i, best = -1, 0.0
                for i, box in enumerate(xyxy):
                    if i in used:
                        continue
                    ix1, iy1 = max(vx1, box[0]), max(vy1, box[1])
                    ix2, iy2 = min(vx2, box[2]), min(vy2, box[3])
                    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
                    union = (
                        max(0.0, vx2 - vx1) * max(0.0, vy2 - vy1)
                        + max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])
                        - inter
                    )
                    iou_s = inter / union if union > 0 else 0.0
                    if iou_s > best:
                        best, best_i = iou_s, i
                if best_i >= 0 and best >= 0.3:
                    label = labels[best_i]
                    used.add(best_i)
                    det_idx = best_i
            if not label:
                continue
            if 0 <= det_idx < len(labels):
                used.add(det_idx)
            current.append({
                "label": label,
                "type": "rectangle",
                "points": [
                    round(vx1 * inv, 2), round(vy1 * inv, 2),
                    round(vx2 * inv, 2), round(vy2 * inv, 2),
                ],
                "confidence": round(score, 4),
                "track_id": tid,
            })
    _append_unmatched_dets(current, xyxy, confs, labels, used, inv)

    # threading.Lock is not reentrant. close_session() also takes _LOCK, so
    # calling it here deadlocked the last auto-ann frame at ~99% forever.
    drop = None
    with _LOCK:
        sess = _SESSIONS.get(key)
        if sess is None:
            items = current
        else:
            current = recover_track_ids(current, sess.last_seen)
            items, sess.last_seen, sess.lost_age = merge_lost_tracks(
                current, sess.last_seen, sess.lost_age, track_buffer,
                img_wh=orig_wh,
            )
            if frame is not None:
                sess.last_frame = int(frame)
            sess.touched = time.time()
        if frame_is_last:
            drop = _SESSIONS.pop(key, None)
    if drop is not None:
        drop.close()

    return expand_tracked_boxes_to_families(items, cfg)
