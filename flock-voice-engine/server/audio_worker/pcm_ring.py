"""Render thread 专用的双环形有界内存通道。"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import threading


@dataclass(frozen=True)
class PcmBlock:
    render_frame: int
    payload: bytes


@dataclass(frozen=True)
class PublishResult:
    accepted: bool
    code: str


class WorkerPcmRings:
    def __init__(self, capacity_blocks: int = 8):
        self.capacity = capacity_blocks
        self.master: deque[PcmBlock] = deque()
        self.split: deque[PcmBlock] = deque()
        self.degraded = False
        self.degraded_reason: str | None = None
        self._lock = threading.Lock()

    def try_publish(self, master: bytes, split: bytes, render_frame: int) -> PublishResult:
        with self._lock:
            if self.degraded:
                return PublishResult(False, "WORKER_PCM_RING_STOPPED")
            if len(self.master) >= self.capacity or len(self.split) >= self.capacity:
                self.degraded = True
                self.degraded_reason = "WORKER_PCM_RING_OVERFLOW"
                return PublishResult(False, self.degraded_reason)
            self.master.append(PcmBlock(render_frame, bytes(master)))
            self.split.append(PcmBlock(render_frame, bytes(split)))
            return PublishResult(True, "PUBLISHED")

    def pop_pair(self) -> tuple[PcmBlock, PcmBlock] | None:
        with self._lock:
            if not self.master or not self.split:
                return None
            return self.master.popleft(), self.split.popleft()

    @property
    def headroom_blocks(self) -> int:
        with self._lock:
            return min(self.capacity - len(self.master), self.capacity - len(self.split))
