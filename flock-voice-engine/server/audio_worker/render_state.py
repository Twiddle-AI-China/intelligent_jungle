"""只由 render thread 修改的音频状态。"""
from __future__ import annotations

from typing import Any, Callable
from collections import deque
import threading

from .command_queue import CommandQueues, QueuedCommand


class RenderState:
    def __init__(self, queues: CommandQueues, apply_command: Callable[[dict[str, Any]], None] | None = None):
        self.queues = queues
        self._apply_command = apply_command or (lambda _command: None)
        self.state_revision = 0
        self.applied_command_seq = 0
        self.current: dict[str, Any] = {}
        self._applied: deque[dict[str, Any]] = deque()
        self._applied_lock = threading.Lock()
        self.last_replace_applied_command_seq = 0

    def apply_due(self, render_frame: int) -> list[QueuedCommand]:
        due = self.queues.drain_due(render_frame)
        for item in due:
            command = item.command
            if command["type"] == "state.replace":
                self.current = dict(command["value"])
                self.state_revision = int(self.current.get("stateRevision", self.state_revision + 1))
                self._apply_command(command)
                with self._applied_lock:
                    self.last_replace_applied_command_seq = item.command_seq
                    self._applied.append({
                        "type": "audio.state.applied", "audioEpoch": self.queues.audio_epoch,
                        "stateRevision": self.state_revision, "appliedCommandSeq": item.command_seq,
                        "renderFrame": str(render_frame),
                    })
            else:
                self._apply_command(command)
            self.applied_command_seq = max(self.applied_command_seq, item.command_seq)
        return due

    def take_applied(self) -> dict[str, Any] | None:
        with self._applied_lock:
            return self._applied.popleft() if self._applied else None

    def take_applied_through(self, render_frame: int | None = None) -> list[dict[str, Any]]:
        """Atomically drain applied barriers through a PCM frame (or all when idle)."""
        with self._applied_lock:
            output: list[dict[str, Any]] = []
            while self._applied and (render_frame is None
                                     or int(self._applied[0]["renderFrame"]) <= render_frame):
                output.append(self._applied.popleft())
            return output
