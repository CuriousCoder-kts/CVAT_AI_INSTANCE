"""
Unified annotation data types shared across:
  * lambda_manager VLM execution plane
  * ai_orchestrator workers (future)
  * output parsers

Inspired by:
  * CVAT native annotation format (label + attributes + geometry)
  * Label Studio ML Backend task response schema
  * Grounded-SAM 2 unified output

Extensibility:
  * New annotation shapes only need to add their geometry keys here
    and register a new parser entry in output_parsers.ANNOTATION_PARSERS.
  * Worker I/O contract guarantees every downstream consumer gets a
    UnifiedAnnotation list — zero changes needed when adding a new parser.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


ANNOTATION_TYPES = Literal[
    "rectangle",
    "polygon",
    "polyline",
    "points",
    "ellipse",
    "circle",
    "mask",
    "cuboid",
    "skeleton",
    "tag",
    "caption",
]


@dataclass
class UnifiedAnnotation:
    """Canonical output format produced by every output parser.

    Geometry fields are populated based on `type`:
      * rectangle  -> points  = [xtl, ytl, xbr, ybr]   (REAL pixel integers)
      * polygon    -> points  = [x1,y1, x2,y2, ...]     (REAL pixel integers)
      * polyline   -> points  = [x1,y1, x2,y2, ...]
      * points     -> points  = [x1,y1, x2,y2, ...]
      * mask       -> mask_rle (COCO-style RLE string)  or  points (polygon mask)
      * skeleton   -> keypoints = [{name, x, y, v}]
      * tag        -> (no geometry, label only)
      * caption    -> (no geometry, label holds the caption text)

    Quality metadata:
      confidence  -> 0.0~1.0 (post-processor thresholds on this)
      needs_review -> True marks the shape for HITL (yellow dashed highlight)
      worker_source -> which worker/VLM produced it (for multi-model voting)
    """

    type: ANNOTATION_TYPES
    label: str

    points: list[int] | None = None
    mask_rle: str | None = None
    keypoints: list[dict[str, Any]] | None = None

    attributes: dict[str, str] = field(default_factory=dict)

    confidence: float = 1.0
    worker_source: str = ""
    needs_review: bool = False
    text: str | None = None

    def to_cvat_shapes_payload(self) -> dict[str, Any]:
        """Serialize to the exact dict format CVAT lambda result handler expects.

        Matches the list-of-dict contract documented in CVAT's serverless reference
        main.py handler return value: `[{label, points, type, confidence, attributes}]`.
        """
        base: dict[str, Any] = {
            "label": self.label,
            "type": self.type,
            "confidence": str(round(float(self.confidence), 4)),
        }
        if self.points is not None:
            base["points"] = list(self.points)
        if self.mask_rle is not None:
            base["mask_rle"] = self.mask_rle
        if self.keypoints is not None:
            base["keypoints"] = list(self.keypoints)
        if self.attributes:
            base["attributes"] = [
                {"name": str(k), "value": str(v)}
                for k, v in self.attributes.items()
            ]
        if self.needs_review:
            base["needs_review"] = True
        if self.text is not None:
            base["text"] = str(self.text)
        return base

    @classmethod
    def build_lambda_result_list(
        cls,
        annotations: list,
        *,
        caption_attribute_name: str = "描述",
        labels_registry: dict[str, dict] | None = None,
    ) -> list[dict[str, Any]]:
        """Convert a list of UnifiedAnnotation to the exact list-of-dicts contract
        that CVAT's serverless lambda result handler consumes.

        Responsibilities:
          * type="caption"  →  route to type="tag" + label=attr_key + attributes[attr_key]=caption_text
          * label → label_id mapping when a `labels_registry` is supplied
          * dedupe by shape signature (caption/geometry based) so one-shot VLM + recall
            combined outputs never double-emit the same box/tag.

        Returns: list[dict] ready for the lambda handler to return as-is.
        """
        out: list[dict[str, Any]] = []
        seen_shape_keys: set[tuple[Any, ...]] = set()
        _reg = labels_registry or {}
        for ann in annotations:
            item = ann.to_cvat_shapes_payload()
            if ann.type == "caption":
                attr_key = str(caption_attribute_name or "描述")
                caption_txt = str(ann.text if ann.text is not None else ann.label)
                item["type"] = "tag"
                item["label"] = attr_key
                attrs_list = item["attributes"] if isinstance(item.get("attributes"), list) else []
                # Ensure no duplicate attr with same name, then append ours
                attrs_list = [a for a in attrs_list if isinstance(a, dict) and a.get("name") != attr_key]
                attrs_list.append({"name": attr_key, "value": caption_txt})
                item["attributes"] = attrs_list
                dedupe_key: tuple = ("caption", attr_key, caption_txt[:200])
                if dedupe_key in seen_shape_keys:
                    continue
                seen_shape_keys.add(dedupe_key)
            else:
                pts = item.get("points") or []
                try:
                    pts_key = tuple(int(x) for x in pts)
                except (TypeError, ValueError):
                    pts_key = tuple(pts)
                dedupe_key = (item.get("label"), item.get("type"), pts_key)
                if dedupe_key in seen_shape_keys:
                    continue
                seen_shape_keys.add(dedupe_key)
            if isinstance(_reg, dict) and _reg:
                lbl_name = str(item.get("label", ""))
                reg_entry = _reg.get(lbl_name)
                if isinstance(reg_entry, dict) and "id" in reg_entry:
                    item["label_id"] = int(reg_entry["id"])
            out.append(item)
        return out
