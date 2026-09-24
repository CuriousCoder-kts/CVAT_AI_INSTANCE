"""In-process BoT-SORT multi-object tracker (numpy + OpenCV only).

Ported from Ultralytics YOLO's BoT-SORT implementation
(https://github.com/ultralytics/ultralytics, AGPL-3.0 License):

- Kalman-filter state estimation with constant-velocity model (XYWH for BoT-SORT)
- ByteTrack-style two-stage association (high / low detection scores)
- Global motion compensation (GMC) via sparse Lucas-Kanade optical flow
- Score-fused IoU cost; ReID/appearance branch removed (``with_reid=False``)

The port only depends on numpy, opencv-python and scipy (linear assignment);
torch / lap / the ultralytics package are not required. Detector-agnostic: feed
per-frame axis-aligned boxes ``[x1, y1, x2, y2]`` with scores, receive the
stable track id back together with the caller-supplied detection index.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any, Sequence

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

LOGGER = logging.getLogger(__name__)

# Mirrors ultralytics/cfg/trackers/botsort.yaml (with_reid disabled).
DEFAULT_BOTSORT_CONFIG: dict[str, Any] = {
    "track_high_thresh": 0.25,
    "track_low_thresh": 0.1,
    "new_track_thresh": 0.25,
    "track_buffer": 30,
    "match_thresh": 0.8,
    "fuse_score": True,
    "gmc_method": "sparseOptFlow",  # sparseOptFlow | none
}


# --------------------------------------------------------------------------- #
# Assignment / cost matrices
# --------------------------------------------------------------------------- #
def linear_assignment(
    cost_matrix: np.ndarray, thresh: float
) -> tuple[list[list[int]], np.ndarray, np.ndarray]:
    """Hungarian assignment with a cost limit (``lap.lapjv`` semantics).

    Matches whose cost exceeds ``thresh`` are reported as unmatched.
    """
    if cost_matrix.size == 0:
        return [], np.arange(cost_matrix.shape[0]), np.arange(cost_matrix.shape[1])

    row_ind, col_ind = linear_sum_assignment(cost_matrix)
    matches: list[list[int]] = []
    matched_r: set[int] = set()
    matched_c: set[int] = set()
    for r, c in zip(row_ind, col_ind):
        if cost_matrix[r, c] <= thresh:
            matches.append([int(r), int(c)])
            matched_r.add(int(r))
            matched_c.add(int(c))
    unmatched_r = np.asarray([i for i in range(cost_matrix.shape[0]) if i not in matched_r], dtype=int)
    unmatched_c = np.asarray([j for j in range(cost_matrix.shape[1]) if j not in matched_c], dtype=int)
    return matches, unmatched_r, unmatched_c


def bbox_iou_matrix(box1: np.ndarray, box2: np.ndarray, eps: float = 1e-7) -> np.ndarray:
    """Pairwise IoU of two ``(N, 4)`` / ``(M, 4)`` xyxy box arrays."""
    box1 = np.ascontiguousarray(box1, dtype=np.float32)
    box2 = np.ascontiguousarray(box2, dtype=np.float32)
    if len(box1) == 0 or len(box2) == 0:
        return np.zeros((len(box1), len(box2)), dtype=np.float32)

    b1_x1, b1_y1, b1_x2, b1_y2 = box1.T
    b2_x1, b2_y1, b2_x2, b2_y2 = box2.T
    inter_area = (np.minimum(b1_x2[:, None], b2_x2) - np.maximum(b1_x1[:, None], b2_x1)).clip(0) * (
        np.minimum(b1_y2[:, None], b2_y2) - np.maximum(b1_y1[:, None], b2_y1)
    ).clip(0)
    box1_area = (b1_x2 - b1_x1) * (b1_y2 - b1_y1)
    box2_area = (b2_x2 - b2_x1) * (b2_y2 - b2_y1)
    union = box1_area[:, None] + box2_area - inter_area
    return inter_area / (union + eps)


def iou_distance(atracks: Sequence[Any], btracks: Sequence[Any]) -> np.ndarray:
    """IoU cost (1 - IoU) between two STrack lists."""
    atlbrs = [track.xyxy for track in atracks]
    btlbrs = [track.xyxy for track in btracks]
    ious = np.zeros((len(atlbrs), len(btlbrs)), dtype=np.float32)
    if atlbrs and btlbrs:
        ious = bbox_iou_matrix(np.asarray(atlbrs), np.asarray(btlbrs))
    return 1.0 - ious


def fuse_score(cost_matrix: np.ndarray, detections: Sequence[Any]) -> np.ndarray:
    """Fuse detection confidence into the IoU cost matrix."""
    if cost_matrix.size == 0:
        return cost_matrix
    iou_sim = 1.0 - cost_matrix
    det_scores = np.asarray([det.score for det in detections], dtype=np.float32)
    fuse_sim = iou_sim * det_scores[None, :].repeat(cost_matrix.shape[0], axis=0)
    return 1.0 - fuse_sim


# --------------------------------------------------------------------------- #
# Global motion compensation (sparse optical flow only, botsort.yaml default)
# --------------------------------------------------------------------------- #
class GMC:
    """Global motion compensation with sparse Lucas-Kanade optical flow."""

    def __init__(self, method: str = "sparseOptFlow", downscale: int = 2) -> None:
        self.method = method if method in {"sparseOptFlow"} else None
        self.downscale = max(1, int(downscale))
        self.feature_params = {
            "maxCorners": 400,
            "qualityLevel": 0.01,
            "minDistance": 0,
            "blockSize": 3,
            "useHarrisDetector": False,
            "k": 0.04,
        }
        self.prev_frame: np.ndarray | None = None
        self.prev_keypoints: np.ndarray | None = None
        self.initialized = False

    def apply(self, raw_frame: np.ndarray) -> np.ndarray:
        """Return the 2x3 affine warp of the previous frame onto ``raw_frame``."""
        if self.method is None or raw_frame is None:
            return np.eye(2, 3, dtype=np.float32)

        h, w, c = raw_frame.shape
        frame = cv2.cvtColor(raw_frame, cv2.COLOR_BGR2GRAY) if c == 3 else raw_frame
        if self.downscale > 1:
            frame = cv2.resize(frame, (w // self.downscale, h // self.downscale))

        keypoints = cv2.goodFeaturesToTrack(frame, mask=None, **self.feature_params)
        if not self.initialized or self.prev_keypoints is None or self.prev_frame is None:
            self.prev_frame = frame.copy()
            self.prev_keypoints = keypoints
            self.initialized = True
            return np.eye(2, 3, dtype=np.float32)

        matched, status, _ = cv2.calcOpticalFlowPyrLK(self.prev_frame, frame, self.prev_keypoints, None)
        good = status.ravel().astype(bool)
        prev_pts = self.prev_keypoints[good]
        curr_pts = matched[good]
        warp = np.eye(2, 3, dtype=np.float32)
        if prev_pts.shape[0] > 4:
            warp, _ = cv2.estimateAffinePartial2D(prev_pts, curr_pts, cv2.RANSAC)
            if warp is None:
                warp = np.eye(2, 3, dtype=np.float32)
            elif self.downscale > 1:
                warp[0, 2] *= self.downscale
                warp[1, 2] *= self.downscale

        self.prev_frame = frame.copy()
        self.prev_keypoints = keypoints
        return warp.astype(np.float32, copy=False)

    def reset_params(self) -> None:
        self.prev_frame = None
        self.prev_keypoints = None
        self.initialized = False


# --------------------------------------------------------------------------- #
# Kalman filters
# --------------------------------------------------------------------------- #
class KalmanFilterXYAH:
    """8D state (cx, cy, aspect, h, vx, vy, va, vh), constant velocity."""

    def __init__(self) -> None:
        ndim, dt = 4, 1.0
        self._motion_mat = np.eye(2 * ndim, 2 * ndim)
        for i in range(ndim):
            self._motion_mat[i, ndim + i] = dt
        self._update_mat = np.eye(ndim, 2 * ndim)
        self._std_weight_position = 1.0 / 20
        self._std_weight_velocity = 1.0 / 160

    def initiate(self, measurement: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        measurement = np.asarray(measurement, dtype=np.float64)
        mean = np.r_[measurement, np.zeros_like(measurement)]
        std = [
            2 * self._std_weight_position * measurement[3],
            2 * self._std_weight_position * measurement[3],
            1e-2,
            2 * self._std_weight_position * measurement[3],
            10 * self._std_weight_velocity * measurement[3],
            10 * self._std_weight_velocity * measurement[3],
            1e-5,
            10 * self._std_weight_velocity * measurement[3],
        ]
        return mean, np.diag(np.square(std))

    def predict(self, mean: np.ndarray, covariance: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        std_pos = [
            self._std_weight_position * mean[3],
            self._std_weight_position * mean[3],
            1e-2,
            self._std_weight_position * mean[3],
        ]
        std_vel = [
            self._std_weight_velocity * mean[3],
            self._std_weight_velocity * mean[3],
            1e-5,
            self._std_weight_velocity * mean[3],
        ]
        motion_cov = np.diag(np.square(np.r_[std_pos, std_vel]))
        mean = np.dot(mean, self._motion_mat.T)
        covariance = np.linalg.multi_dot((self._motion_mat, covariance, self._motion_mat.T)) + motion_cov
        return mean, covariance

    def project(self, mean: np.ndarray, covariance: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        std = [
            self._std_weight_position * mean[3],
            self._std_weight_position * mean[3],
            1e-1,
            self._std_weight_position * mean[3],
        ]
        innovation_cov = np.diag(np.square(std))
        return mean[:4].copy(), covariance[:4, :4] + innovation_cov

    def multi_predict(self, mean: np.ndarray, covariance: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        std_pos = [
            self._std_weight_position * mean[:, 3],
            self._std_weight_position * mean[:, 3],
            1e-2 * np.ones_like(mean[:, 3]),
            self._std_weight_position * mean[:, 3],
        ]
        std_vel = [
            self._std_weight_velocity * mean[:, 3],
            self._std_weight_velocity * mean[:, 3],
            1e-5 * np.ones_like(mean[:, 3]),
            self._std_weight_velocity * mean[:, 3],
        ]
        sqr = np.square(np.r_[std_pos, std_vel]).T
        motion_cov = np.zeros((sqr.shape[0], 8, 8))
        motion_cov[:, range(8), range(8)] = sqr
        mean = np.dot(mean, self._motion_mat.T)
        left = np.dot(self._motion_mat, covariance).transpose((1, 0, 2))
        covariance = np.dot(left, self._motion_mat.T) + motion_cov
        return mean, covariance

    def update(self, mean, covariance, measurement):
        projected_mean, projected_cov = self.project(mean, covariance)
        kalman_gain = np.linalg.solve(projected_cov, covariance[:, :4].T).T
        innovation = measurement - projected_mean
        new_mean = mean + np.dot(innovation, kalman_gain.T)
        new_covariance = covariance - np.linalg.multi_dot((kalman_gain, projected_cov, kalman_gain.T))
        return new_mean, new_covariance

    @staticmethod
    def tlwh_to_xyah(tlwh: np.ndarray) -> np.ndarray:
        ret = np.asarray(tlwh).copy()
        ret[:2] += ret[2:] / 2
        ret[2] /= ret[3]
        return ret


class KalmanFilterXYWH(KalmanFilterXYAH):
    """8D state (cx, cy, w, h, vx, vy, vw, vh), used by BoT-SORT."""

    def initiate(self, measurement: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        measurement = np.asarray(measurement, dtype=np.float64)
        mean = np.r_[measurement, np.zeros_like(measurement)]
        std = [
            2 * self._std_weight_position * measurement[2],
            2 * self._std_weight_position * measurement[3],
            2 * self._std_weight_position * measurement[2],
            2 * self._std_weight_position * measurement[3],
            10 * self._std_weight_velocity * measurement[2],
            10 * self._std_weight_velocity * measurement[3],
            10 * self._std_weight_velocity * measurement[2],
            10 * self._std_weight_velocity * measurement[3],
        ]
        return mean, np.diag(np.square(std))

    def predict(self, mean, covariance):
        std_pos = [
            self._std_weight_position * mean[2],
            self._std_weight_position * mean[3],
            self._std_weight_position * mean[2],
            self._std_weight_position * mean[3],
        ]
        std_vel = [
            self._std_weight_velocity * mean[2],
            self._std_weight_velocity * mean[3],
            self._std_weight_velocity * mean[2],
            self._std_weight_velocity * mean[3],
        ]
        motion_cov = np.diag(np.square(np.r_[std_pos, std_vel]))
        mean = np.dot(mean, self._motion_mat.T)
        covariance = np.linalg.multi_dot((self._motion_mat, covariance, self._motion_mat.T)) + motion_cov
        return mean, covariance

    def project(self, mean, covariance):
        std = [
            self._std_weight_position * mean[2],
            self._std_weight_position * mean[3],
            self._std_weight_position * mean[2],
            self._std_weight_position * mean[3],
        ]
        innovation_cov = np.diag(np.square(std))
        return mean[:4].copy(), covariance[:4, :4] + innovation_cov

    def multi_predict(self, mean, covariance):
        std_pos = [
            self._std_weight_position * mean[:, 2],
            self._std_weight_position * mean[:, 3],
            self._std_weight_position * mean[:, 2],
            self._std_weight_position * mean[:, 3],
        ]
        std_vel = [
            self._std_weight_velocity * mean[:, 2],
            self._std_weight_velocity * mean[:, 3],
            self._std_weight_velocity * mean[:, 2],
            self._std_weight_velocity * mean[:, 3],
        ]
        sqr = np.square(np.r_[std_pos, std_vel]).T
        motion_cov = np.zeros((sqr.shape[0], 8, 8))
        motion_cov[:, range(8), range(8)] = sqr
        mean = np.dot(mean, self._motion_mat.T)
        left = np.dot(self._motion_mat, covariance).transpose((1, 0, 2))
        covariance = np.dot(left, self._motion_mat.T) + motion_cov
        return mean, covariance

    @staticmethod
    def tlwh_to_xywh(tlwh: np.ndarray) -> np.ndarray:
        ret = np.asarray(tlwh).copy()
        ret[:2] += ret[2:] / 2
        return ret


# --------------------------------------------------------------------------- #
# Track objects
# --------------------------------------------------------------------------- #
class TrackState:
    New = 0
    Tracked = 1
    Lost = 2
    Removed = 3


class BaseTrack:
    _count = 0

    def __init__(self) -> None:
        self.track_id = 0
        self.is_activated = False
        self.state = TrackState.New
        self.score = 0.0
        self.start_frame = 0
        self.frame_id = 0

    @property
    def end_frame(self) -> int:
        return self.frame_id

    @staticmethod
    def next_id() -> int:
        BaseTrack._count += 1
        return BaseTrack._count

    def mark_lost(self) -> None:
        self.state = TrackState.Lost

    def mark_removed(self) -> None:
        self.state = TrackState.Removed

    @staticmethod
    def reset_id() -> None:
        BaseTrack._count = 0


class STrack(BaseTrack):
    """Single track with an XYAH Kalman state (ByteTrack)."""

    shared_kalman = KalmanFilterXYAH()

    def __init__(self, xywh: np.ndarray, score: float, cls: Any) -> None:
        super().__init__()
        # xywh layout: [cx, cy, w, h, root_index]
        self._tlwh = np.asarray(self._to_ltwh(xywh[:4]), dtype=np.float32)
        self.kalman_filter: KalmanFilterXYAH | None = None
        self.mean: np.ndarray | None = None
        self.covariance: np.ndarray | None = None
        self.score = float(score)
        self.tracklet_len = 0
        self.cls = cls
        self.idx = int(xywh[-1])

    @staticmethod
    def _to_ltwh(xywh: np.ndarray) -> np.ndarray:
        ret = np.asarray(xywh, dtype=np.float32).copy()
        ret[0] -= ret[2] / 2
        ret[1] -= ret[3] / 2
        return ret

    def predict(self) -> None:
        mean_state = self.mean.copy()
        if self.state != TrackState.Tracked:
            mean_state[7] = 0
        self.mean, self.covariance = self.kalman_filter.predict(mean_state, self.covariance)

    @staticmethod
    def multi_predict(stracks: list["STrack"]) -> None:
        if not stracks:
            return
        multi_mean = np.asarray([st.mean for st in stracks])
        multi_covariance = np.asarray([st.covariance for st in stracks])
        for i, st in enumerate(stracks):
            if st.state != TrackState.Tracked:
                multi_mean[i][7] = 0
        multi_mean, multi_covariance = STrack.shared_kalman.multi_predict(multi_mean, multi_covariance)
        for st, mean, cov in zip(stracks, multi_mean, multi_covariance):
            st.mean, st.covariance = mean, cov

    def activate(self, kalman_filter: KalmanFilterXYAH, frame_id: int) -> None:
        self.kalman_filter = kalman_filter
        self.track_id = self.next_id()
        self.mean, self.covariance = kalman_filter.initiate(self.convert_coords(self._tlwh))
        self.tracklet_len = 0
        self.state = TrackState.Tracked
        if frame_id == 1:
            self.is_activated = True
        self.frame_id = frame_id
        self.start_frame = frame_id

    def re_activate(self, new_track: "STrack", frame_id: int, new_id: bool = False) -> None:
        self.mean, self.covariance = self.kalman_filter.update(
            self.mean, self.covariance, self.convert_coords(new_track.tlwh)
        )
        self.tracklet_len = 0
        self.state = TrackState.Tracked
        self.is_activated = True
        self.frame_id = frame_id
        if new_id:
            self.track_id = self.next_id()
        self.score = new_track.score
        self.cls = new_track.cls
        self.idx = new_track.idx

    def update(self, new_track: "STrack", frame_id: int) -> None:
        self.frame_id = frame_id
        self.tracklet_len += 1
        self.mean, self.covariance = self.kalman_filter.update(
            self.mean, self.covariance, self.convert_coords(new_track.tlwh)
        )
        self.state = TrackState.Tracked
        self.is_activated = True
        self.score = new_track.score
        self.cls = new_track.cls
        self.idx = new_track.idx

    def convert_coords(self, tlwh: np.ndarray) -> np.ndarray:
        return self.tlwh_to_xyah(tlwh)

    @property
    def tlwh(self) -> np.ndarray:
        if self.mean is None:
            return self._tlwh.copy()
        ret = self.mean[:4].copy()
        ret[2] *= ret[3]
        ret[:2] -= ret[2:] / 2
        return ret

    @property
    def xyxy(self) -> np.ndarray:
        ret = self.tlwh
        ret[2:] += ret[:2]
        return ret


class BOTrack(STrack):
    """STrack with an XYWH Kalman state (BoT-SORT)."""

    shared_kalman = KalmanFilterXYWH()

    def predict(self) -> None:
        mean_state = self.mean.copy()
        if self.state != TrackState.Tracked:
            mean_state[6] = 0
            mean_state[7] = 0
        self.mean, self.covariance = self.kalman_filter.predict(mean_state, self.covariance)

    @staticmethod
    def multi_predict(stracks: list["BOTrack"]) -> None:
        if not stracks:
            return
        multi_mean = np.asarray([st.mean for st in stracks])
        multi_covariance = np.asarray([st.covariance for st in stracks])
        for i, st in enumerate(stracks):
            if st.state != TrackState.Tracked:
                multi_mean[i][6] = 0
                multi_mean[i][7] = 0
        multi_mean, multi_covariance = BOTrack.shared_kalman.multi_predict(multi_mean, multi_covariance)
        for st, mean, cov in zip(stracks, multi_mean, multi_covariance):
            st.mean, st.covariance = mean, cov

    def convert_coords(self, tlwh: np.ndarray) -> np.ndarray:
        return self.tlwh_to_xywh(tlwh)

    @staticmethod
    def tlwh_to_xywh(tlwh: np.ndarray) -> np.ndarray:
        ret = np.asarray(tlwh).copy()
        ret[:2] += ret[2:] / 2
        return ret

    @property
    def tlwh(self) -> np.ndarray:
        if self.mean is None:
            return self._tlwh.copy()
        ret = self.mean[:4].copy()
        ret[:2] -= ret[2:] / 2
        return ret


# --------------------------------------------------------------------------- #
# Track-pool helpers
# --------------------------------------------------------------------------- #
def joint_stracks(atracks: list[STrack], btracks: list[STrack]) -> list[STrack]:
    a_ids = {t.track_id for t in atracks}
    return atracks + [t for t in btracks if t.track_id not in a_ids]


def sub_stracks(atracks: list[STrack], btracks: list[STrack]) -> list[STrack]:
    b_ids = {t.track_id for t in btracks}
    return [t for t in atracks if t.track_id not in b_ids]


def remove_duplicate_stracks(
    atracks: list[STrack], btracks: list[STrack], dup_thresh: float = 0.15
) -> tuple[list[STrack], list[STrack]]:
    pdist = iou_distance(atracks, btracks)
    pairs = np.where(pdist < dup_thresh)
    dupa: list[int] = []
    dupb: list[int] = []
    for p, q in zip(*pairs):
        time_p = atracks[p].frame_id - atracks[p].start_frame
        time_q = btracks[q].frame_id - btracks[q].start_frame
        if time_p > time_q:
            dupb.append(int(q))
        else:
            dupa.append(int(p))
    dupa_set, dupb_set = set(dupa), set(dupb)
    resa = [t for i, t in enumerate(atracks) if i not in dupa_set]
    resb = [t for i, t in enumerate(btracks) if i not in dupb_set]
    return resa, resb


def multi_gmc(stracks: list[STrack], warp: np.ndarray) -> None:
    """Apply a 2x3 affine warp to the XYWH Kalman states in place."""
    if not stracks:
        return
    multi_mean = np.asarray([st.mean for st in stracks])
    multi_covariance = np.asarray([st.covariance for st in stracks])
    r = warp[:2, :2]
    r8 = np.kron(np.eye(4, dtype=np.float32), r)
    t = warp[:2, 2]
    multi_mean = np.matmul(r8, multi_mean[..., None])[..., 0]
    multi_mean[:, :2] += t
    multi_covariance = np.matmul(np.matmul(r8, multi_covariance), np.ascontiguousarray(r8.T))
    for st, mean, cov in zip(stracks, multi_mean, multi_covariance):
        st.mean, st.covariance = mean, cov


# --------------------------------------------------------------------------- #
# Detections container (stands in for ultralytics' Boxes numpy facade)
# --------------------------------------------------------------------------- #
class _Detections:
    """Boolean-indexable box set; last column of each track seed is ``root_pos``."""

    def __init__(
        self,
        xyxy: np.ndarray,
        conf: np.ndarray,
        cls: np.ndarray,
        root_pos: np.ndarray | None = None,
    ) -> None:
        self.xyxy = np.asarray(xyxy, dtype=np.float32).reshape(-1, 4)
        self.conf = np.asarray(conf, dtype=np.float32).reshape(-1)
        self.cls = np.asarray(cls, dtype=object).reshape(-1)
        n = len(self.xyxy)
        self.root_pos = np.arange(n, dtype=np.int64) if root_pos is None else np.asarray(root_pos, dtype=np.int64)

    def __len__(self) -> int:
        return len(self.xyxy)

    def __getitem__(self, mask) -> "_Detections":
        return _Detections(self.xyxy[mask], self.conf[mask], self.cls[mask], self.root_pos[mask])

    @property
    def xywh(self) -> np.ndarray:
        xyxy = self.xyxy
        wh = xyxy[:, 2:4] - xyxy[:, 0:2]
        return np.concatenate([xyxy[:, 0:2] + wh / 2, wh], axis=1)

    def seeds(self) -> np.ndarray:
        return np.concatenate([self.xywh, self.root_pos.reshape(-1, 1).astype(np.float32)], axis=1)


# --------------------------------------------------------------------------- #
# BoT-SORT implementation
# --------------------------------------------------------------------------- #
class _BotSortImpl:
    track_class = BOTrack

    def __init__(self, args: SimpleNamespace) -> None:
        self.tracked_stracks: list[STrack] = []
        self.lost_stracks: list[STrack] = []
        self.removed_stracks: list[STrack] = []
        self.frame_id = 0
        self.args = args
        self.max_frames_lost = args.track_buffer
        self.kalman_filter = self.get_kalmanfilter()
        self.gmc = GMC(method=args.gmc_method)
        BaseTrack.reset_id()

    def get_kalmanfilter(self) -> KalmanFilterXYWH:
        return KalmanFilterXYWH()

    def init_track(self, results: _Detections) -> list[STrack]:
        if len(results) == 0:
            return []
        seeds = results.seeds()
        return [self.track_class(xywh, score, cls) for xywh, score, cls in zip(seeds, results.conf, results.cls)]

    def get_dists(self, tracks: list[STrack], detections: list[STrack]) -> np.ndarray:
        dists = iou_distance(tracks, detections)
        if self.args.fuse_score:
            dists = fuse_score(dists, detections)
        return dists

    @staticmethod
    def multi_predict(tracks: list[STrack]) -> None:
        BOTrack.multi_predict(tracks)

    def reset(self) -> None:
        self.tracked_stracks = []
        self.lost_stracks = []
        self.removed_stracks = []
        self.frame_id = 0
        self.kalman_filter = self.get_kalmanfilter()
        self.gmc.reset_params()
        BaseTrack.reset_id()

    def update(self, results: _Detections, img: np.ndarray | None = None) -> list[STrack]:
        self.frame_id += 1
        activated: list[STrack] = []
        refind: list[STrack] = []
        lost: list[STrack] = []
        removed: list[STrack] = []

        results_high, results_low, mask_high, mask_low = self._split_detections(results)
        detections = self.init_track(results_high)
        detections_second = self.init_track(results_low)

        unconfirmed = [t for t in self.tracked_stracks if not t.is_activated]
        tracked_stracks = [t for t in self.tracked_stracks if t.is_activated]
        strack_pool = joint_stracks(tracked_stracks, self.lost_stracks)
        self.multi_predict(strack_pool)

        if self.gmc.method is not None and img is not None:
            try:
                warp = self.gmc.apply(img)
            except Exception as exc:  # never let GMC kill a frame
                LOGGER.warning("GMC failed, falling back to identity warp: %s", exc)
                warp = np.eye(2, 3, dtype=np.float32)
            multi_gmc(strack_pool, warp)
            multi_gmc(unconfirmed, warp)

        # First association (high-score detections vs tracked + lost pool).
        dists = self.get_dists(strack_pool, detections)
        matches, u_track, u_detection = linear_assignment(dists, thresh=self.args.match_thresh)
        for itracked, idet in matches:
            track = strack_pool[itracked]
            det = detections[idet]
            if track.state == TrackState.Tracked:
                track.update(det, self.frame_id)
                activated.append(track)
            else:
                track.re_activate(det, self.frame_id, new_id=False)
                refind.append(track)

        # Second association (low-score detections vs remaining tracked tracks).
        r_tracked = [strack_pool[i] for i in u_track if strack_pool[i].state == TrackState.Tracked]
        if r_tracked and detections_second:
            dists = iou_distance(r_tracked, detections_second)
            matches, u_track, _ = linear_assignment(dists, thresh=0.5)
            for itracked, idet in matches:
                track = r_tracked[itracked]
                det = detections_second[idet]
                if track.state == TrackState.Tracked:
                    track.update(det, self.frame_id)
                    activated.append(track)
                else:
                    track.re_activate(det, self.frame_id, new_id=False)
                    refind.append(track)
        else:
            u_track = np.arange(len(r_tracked))

        for it in u_track:
            track = r_tracked[int(it)]
            if track.state != TrackState.Lost:
                track.mark_lost()
                lost.append(track)

        # Unconfirmed tracks get a second chance with leftover high-score detections.
        detections = [detections[i] for i in u_detection]
        if unconfirmed and detections:
            dists = self.get_dists(unconfirmed, detections)
            matches, u_unconfirmed, u_detection = linear_assignment(dists, thresh=0.7)
            for itracked, idet in matches:
                unconfirmed[itracked].update(detections[idet], self.frame_id)
                activated.append(unconfirmed[itracked])
            for it in u_unconfirmed:
                track = unconfirmed[int(it)]
                track.mark_removed()
                removed.append(track)
        else:
            u_detection = np.arange(len(detections))

        # Initialise new tracks from unmatched high-score detections.
        for inew in u_detection:
            track = detections[int(inew)]
            if track.score < self.args.new_track_thresh:
                continue
            track.activate(self.kalman_filter, self.frame_id)
            activated.append(track)

        # Remove lost tracks older than the buffer.
        for track in self.lost_stracks:
            if self.frame_id - track.end_frame > self.max_frames_lost:
                track.mark_removed()
                removed.append(track)

        self.tracked_stracks = [t for t in self.tracked_stracks if t.state == TrackState.Tracked]
        self.tracked_stracks = joint_stracks(self.tracked_stracks, activated)
        self.tracked_stracks = joint_stracks(self.tracked_stracks, refind)
        self.lost_stracks = sub_stracks(self.lost_stracks, self.tracked_stracks)
        self.lost_stracks.extend(lost)
        self.lost_stracks = sub_stracks(self.lost_stracks, self.removed_stracks)
        self.tracked_stracks, self.lost_stracks = remove_duplicate_stracks(
            self.tracked_stracks, self.lost_stracks
        )
        self.removed_stracks.extend(removed)
        if len(self.removed_stracks) > 1000:
            self.removed_stracks = self.removed_stracks[-1000:]

        return [t for t in self.tracked_stracks if t.is_activated]

    def _split_detections(self, results: _Detections) -> tuple[_Detections, _Detections, np.ndarray, np.ndarray]:
        wh = results.xywh[:, 2:4]
        valid = (wh[:, 0] > 0) & (wh[:, 1] > 0)
        mask_high = valid & (results.conf >= self.args.track_high_thresh)
        mask_low = valid & (results.conf > self.args.track_low_thresh) & (results.conf < self.args.track_high_thresh)
        return results[mask_high], results[mask_low], mask_high, mask_low


class TrackedBox:
    """Public result record for one tracked root box on the current frame."""

    __slots__ = ("track_id", "root_index", "xyxy", "score", "cls")

    def __init__(self, track_id: int, root_index: int, xyxy: np.ndarray, score: float, cls: Any) -> None:
        self.track_id = track_id
        self.root_index = root_index
        self.xyxy = xyxy
        self.score = score
        self.cls = cls

    def __repr__(self) -> str:
        return f"TrackedBox(id={self.track_id}, root={self.root_index}, xyxy={np.round(self.xyxy, 1).tolist()})"


class BotSortTracker:
    """Per-video tracker. One instance must be reused across the video's frames.

    Args:
        config: Optional overrides for ``DEFAULT_BOTSORT_CONFIG`` (thresholds,
            ``track_buffer``, ``gmc_method``).
    """

    def __init__(self, config: dict | None = None) -> None:
        merged = dict(DEFAULT_BOTSORT_CONFIG)
        if isinstance(config, dict):
            for key in DEFAULT_BOTSORT_CONFIG:
                if key in config and config[key] is not None:
                    merged[key] = config[key]
        merged["track_high_thresh"] = float(merged["track_high_thresh"])
        merged["track_low_thresh"] = float(merged["track_low_thresh"])
        merged["new_track_thresh"] = float(merged["new_track_thresh"])
        merged["track_buffer"] = max(1, int(merged["track_buffer"]))
        merged["match_thresh"] = float(merged["match_thresh"])
        merged["fuse_score"] = bool(merged["fuse_score"])
        merged["gmc_method"] = str(merged["gmc_method"] or "none")
        self._impl = _BotSortImpl(SimpleNamespace(**merged))

    def update_frame(
        self,
        xyxy: Sequence[Sequence[float]] | np.ndarray,
        scores: Sequence[float] | np.ndarray,
        labels: Sequence[Any],
        frame_bgr: np.ndarray | None = None,
    ) -> list[TrackedBox]:
        """Associate one frame's root boxes; returns confirmed tracked boxes.

        ``labels[i]`` is stored on the track but does not split association
        (ByteTrack matches across all classes). ``root_index`` is the position
        in this call's input arrays, so callers can map the result back to their
        detection row.
        """
        xyxy = np.asarray(xyxy, dtype=np.float32).reshape(-1, 4)
        scores = np.asarray(scores, dtype=np.float32).reshape(-1)
        labels = np.asarray(list(labels), dtype=object).reshape(-1)
        if not len(xyxy):
            dets = _Detections(np.empty((0, 4), np.float32), np.empty(0, np.float32), np.empty(0, object))
        else:
            dets = _Detections(xyxy, scores, labels)
        tracks = self._impl.update(dets, frame_bgr)
        return [
            TrackedBox(int(t.track_id), int(t.idx), t.xyxy, float(t.score), t.cls)
            for t in tracks
        ]

    def reset(self) -> None:
        """Start a new video (clears tracks, GMC history and the id counter)."""
        self._impl.reset()
