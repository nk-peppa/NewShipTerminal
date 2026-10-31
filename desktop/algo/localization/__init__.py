"""Prior-map localization (vendor folder untouched).

Public surface:

* ``PriorMap`` — loads a ``map.yaml`` + P5 PGM pair and exposes a distance field.
* ``MapLocalizer`` — scan-to-map matching, global search and tracking state.
* ``LocalizerConfig`` — all tunables, recorded in experiment configs.
"""
from .config import DEFAULT_CONFIG, LocalizerConfig
from .map import MapError, MapInfo, PriorMap
from .matcher import (
    PHASE_AMBIGUOUS,
    PHASE_LOST,
    PHASE_SEARCHING,
    PHASE_TRACKING,
    PHASE_WAITING,
    Candidate,
    MapLocalizer,
    Metrics,
    Result,
    scan_points,
)

__all__ = [
    "DEFAULT_CONFIG",
    "LocalizerConfig",
    "MapError",
    "MapInfo",
    "PriorMap",
    "Candidate",
    "MapLocalizer",
    "Metrics",
    "Result",
    "scan_points",
    "PHASE_AMBIGUOUS",
    "PHASE_LOST",
    "PHASE_SEARCHING",
    "PHASE_TRACKING",
    "PHASE_WAITING",
]
