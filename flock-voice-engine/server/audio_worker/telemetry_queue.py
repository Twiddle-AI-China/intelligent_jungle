"""有界 telemetry：普通样本合并，degraded 锁存到 ACK。"""
from __future__ import annotations

import math
import threading
from collections import deque
from typing import Any
from .framing import decode_u64_decimal

REQUIRED = frozenset({
    "workerReady", "recovering", "pcmHeadroomBlocks", "queueDepth", "renderP50Ms",
    "renderP95Ms", "renderP99Ms", "blockDurationMs", "recentUnderruns",
    "unifiedMemoryFreeBytes", "degraded",
    "lateFrames",
    "appliedCommandSeq", "lastReplaceAppliedCommandSeq",
})


class TelemetryQueue:
    def __init__(self, capacity: int = 128):
        self.capacity = capacity
        self._samples: deque[dict[str, Any]] = deque()
        self._latched: dict[str, Any] | None = None
        self._lock = threading.Lock()

    @staticmethod
    def _valid(sample: object) -> bool:
        if not isinstance(sample, dict) or not REQUIRED.issubset(sample):
            return False
        for key in ("pcmHeadroomBlocks", "queueDepth", "renderP50Ms", "renderP95Ms",
                    "renderP99Ms", "blockDurationMs", "recentUnderruns", "lateFrames",
                    "appliedCommandSeq", "lastReplaceAppliedCommandSeq"):
            value = sample[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                return False
        try:
            decode_u64_decimal(sample["unifiedMemoryFreeBytes"])
        except Exception:
            return False
        return True

    def offer(self, sample: dict[str, Any]) -> bool:
        with self._lock:
            if not self._valid(sample):
                return False
            frozen = dict(sample)
            if frozen["degraded"]:
                self._latched = frozen
                return True
            if len(self._samples) >= self.capacity:
                self._samples[-1] = frozen
            else:
                self._samples.append(frozen)
            return True

    def peek(self) -> dict[str, Any] | None:
        with self._lock:
            return dict(self._latched or self._samples[0]) if (self._latched or self._samples) else None

    def acknowledge(self, sample: dict[str, Any]) -> None:
        with self._lock:
            if self._latched is not None and sample == self._latched:
                self._latched = None
            if self._samples and sample == self._samples[0]:
                self._samples.popleft()
