"""固定 drain→apply→render→publish→telemetry 的非阻塞 render loop。"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass

import numpy as np

from .pcm_ring import WorkerPcmRings
from .render_state import RenderState
from .telemetry_queue import TelemetryQueue
from .framing import encode_u64_decimal


@dataclass
class RenderStatus:
    degraded: bool = False
    degraded_reason: str | None = None


class RenderLoop:
    def __init__(self, model_host, render_state: RenderState, pcm_rings: WorkerPcmRings,
                 telemetry: TelemetryQueue, audio_epoch: str, render_frame: int = 0,
                 memory_reader=lambda: 0):
        self.model_host = model_host
        self.render_state = render_state
        self.pcm_rings = pcm_rings
        self.telemetry = telemetry
        self.audio_epoch = audio_epoch
        self.render_frame = render_frame
        self.memory_reader = memory_reader
        self.rendered_blocks = 0
        self.status = RenderStatus()
        self._durations: list[float] = []

    def render_one_block(self) -> bool:
        backend = self.model_host.load_once()
        block_frames = self.model_host.config.block_samples
        start = time.monotonic()
        self.render_state.apply_due(self.render_frame)
        split = np.asarray(backend.render_split(self.model_host.voice_pool.voices, block_frames), dtype="<f4")
        if split.shape != (self.model_host.config.pool_size, block_frames):
            raise RuntimeError("BACKEND_SPLIT_SHAPE_INVALID")
        if hasattr(self.model_host, "render_texture_block"):
            texture_row, texture = self.model_host.render_texture_block(block_frames)
            if texture_row is not None and texture is not None:
                split[texture_row] = texture
        if getattr(self.model_host, "mixer", None) is not None:
            master, split_tap = self.model_host.mixer.process(
                split, {"mix": self.model_host.mix_state, "assignments": self.model_host.assignments})
        else:
            master_mono = split.sum(axis=0, dtype=np.float32)
            master = np.repeat(master_mono[:, None], 2, axis=1).astype("<f4", copy=False)
            split_tap = split.T
        result = self.pcm_rings.try_publish(master.astype("<f4", copy=False).tobytes(),
                                            split_tap.astype("<f4", copy=False).tobytes(), self.render_frame)
        duration_ms = (time.monotonic() - start) * 1000
        self._durations = (self._durations + [duration_ms])[-128:]
        self.rendered_blocks += 1
        self.render_frame += block_frames
        if not result.accepted:
            self.status.degraded = True
            self.status.degraded_reason = "WORKER_PCM_RING_OVERFLOW"
        ordered = sorted(self._durations)
        percentile = lambda ratio: ordered[min(len(ordered) - 1, math.ceil(len(ordered) * ratio) - 1)]
        self.telemetry.offer({
            "workerReady": True, "recovering": False,
            "pcmHeadroomBlocks": self.pcm_rings.headroom_blocks,
            "queueDepth": self.render_state.queues.depth,
            "renderP50Ms": percentile(0.50), "renderP95Ms": percentile(0.95),
            "renderP99Ms": percentile(0.99),
            "blockDurationMs": block_frames / self.model_host.config.sample_rate * 1000,
            "recentUnderruns": 0, "lateFrames": self.render_state.queues.late_frames,
            "unifiedMemoryFreeBytes": encode_u64_decimal(int(self.memory_reader())),
            "appliedCommandSeq": self.render_state.applied_command_seq,
            "lastReplaceAppliedCommandSeq": self.render_state.last_replace_applied_command_seq,
            "degraded": self.status.degraded,
            "degradedReason": self.status.degraded_reason,
        })
        return result.accepted
