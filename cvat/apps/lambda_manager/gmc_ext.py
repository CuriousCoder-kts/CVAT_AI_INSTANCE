"""Optional BoT-SORT GMC that reads precomputed affine matrices.

Adapted from the colleague comparison-video project. Used only when
``gmc_method=ext`` / ``tracker_type=botsort_ext`` and ``GMC_MATRICES``
(or config ``gmc_matrices``) points at an ``.npz`` with key ``matrices``.

Default CVAT Automatic annotation uses builtin ``sparseOptFlow`` and
does not load this class.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

_EYE = np.eye(2, 3, dtype=np.float32)


class ExternalGMC:
    def __init__(self, matrices, first_index: int = 0):
        self.matrices = matrices
        self.first_index = int(first_index or 0)
        self.frame = 0
        self._eye = _EYE

    def apply(self, raw_frame=None, detections=None):
        self.frame += 1
        idx = self.first_index + self.frame - 1
        if 0 <= idx < len(self.matrices):
            return self.matrices[idx]
        return self._eye

    def reset_params(self):
        self.frame = 0


def register_botsort_ext(npz_path: str | None, first_index: int = 0) -> None:
    """Register ``botsort_ext`` on Ultralytics TRACKER_MAP. No-op if already set."""
    from ultralytics.trackers import track
    from ultralytics.trackers.bot_sort import BOTSORT

    class BOTSORTExt(BOTSORT):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            path = (
                os.environ.get("GMC_MATRICES")
                or getattr(args, "gmc_matrices", None)
                or npz_path
                or ""
            )
            path = str(path or "").strip()
            start = int(os.environ.get("GMC_START", str(first_index or 0)))
            if path and Path(path).is_file():
                data = np.load(path)
                matrices = data["matrices"]
                self.gmc = ExternalGMC(matrices, first_index=start)
                self.gmc_matrices_path = path
            else:
                self.gmc = ExternalGMC(np.zeros((0, 2, 3), dtype=np.float32), first_index=start)
                self.gmc_matrices_path = path

    track.TRACKER_MAP["botsort_ext"] = BOTSORTExt
