"""Worker 生命周期编排；模型跨 runtime 重连保持单例。"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path

from .command_queue import CommandQueues
from .framing import FrameDecoder, FrameKind, encode_frame, encode_pcm_body, encode_u64_decimal
from .identity import load_worker_identity
from .ipc_server import IpcServerError
from .pcm_ring import WorkerPcmRings
from .render_loop import RenderLoop
from .render_state import RenderState
from .telemetry_queue import TelemetryQueue


class RuntimeReadySendError(RuntimeError):
    pass


class AudioWorker:
    def __init__(self, server, model_host, identity_path: Path, artifact_manifest_path: Path,
                 identity: dict | None = None):
        self.server = server
        self.model_host = model_host
        self.identity_path = identity_path
        self.artifact_manifest_path = artifact_manifest_path
        self.identity = dict(identity) if identity is not None else None
        self.audio_epoch = None
        self.render_frame = 0
        self.queues = None
        self.pcm_rings = None
        self.telemetry = None
        self.render_state = None

    def start(self) -> None:
        if self.identity is None:
            self.identity = load_worker_identity(self.identity_path, self.artifact_manifest_path)
        if self.server.identity != self.identity:
            raise RuntimeError("WORKER_SERVER_IDENTITY_MISMATCH")
        self.audio_epoch = str(uuid.uuid4())
        self.queues = CommandQueues(
            self.audio_epoch, expected_sample_rate=self.model_host.geometry["sampleRate"],
            row_voices=self.model_host.geometry["rowVoices"],
        )
        self.pcm_rings = WorkerPcmRings()
        self.telemetry = TelemetryQueue()
        self.render_state = RenderState(self.queues, self.model_host.apply_command)
        self.server.listen_without_loading_model()

    def accept_once(self):
        connection = self.server.accept_identity()
        try:
            self.model_host.load_once()
        except Exception as exc:
            self.server.disconnect()
            raise RuntimeError("AUDIO_MODEL_LOAD_FAILED") from exc
        geometry = self.model_host.geometry
        try:
            connection.sendall(encode_frame(FrameKind.JSON, {
                "type": "worker.ready", "identity": self.identity,
                "audioEpoch": self.audio_epoch, "renderFrame": encode_u64_decimal(self.render_frame),
                "geometry": geometry,
            }))
        except OSError as exc:
            self.server.disconnect()
            raise RuntimeReadySendError("RUNTIME_READY_SEND_FAILED") from exc
        return connection

    def run(self, max_connections: int | None = None) -> None:
        self.start()
        try:
            self._run_connections(max_connections)
        finally:
            self.server.close()

    def _run_connections(self, max_connections: int | None) -> None:
        served = 0
        while max_connections is None or served < max_connections:
            try:
                connection = self.accept_once()
            except (IpcServerError, RuntimeReadySendError, OSError, ValueError, TypeError, UnicodeError):
                # Identity/protocol failures belong to the untrusted runtime
                # connection; keep the singleton listener/model owner alive.
                continue
            served += 1
            stopped = threading.Event()
            send_lock = threading.Lock()
            fatal: list[BaseException] = []
            fatal_lock = threading.Lock()
            render_loop = RenderLoop(self.model_host, self.render_state, self.pcm_rings,
                                     self.telemetry, self.audio_epoch, self.render_frame)

            def render() -> None:
                try:
                    block_seconds = self.model_host.config.block_seconds
                    while not stopped.is_set():
                        started = time.monotonic()
                        render_loop.render_one_block()
                        stopped.wait(max(0.0, block_seconds - (time.monotonic() - started)))
                except BaseException as error:
                    with fatal_lock:
                        fatal.append(error)
                    stopped.set()
                    try:
                        connection.shutdown(2)
                    except OSError:
                        pass

            def write() -> None:
                try:
                    sample_seq = 0
                    emitted_replace_seq = 0
                    while not stopped.is_set():
                        pair = self.pcm_rings.pop_pair()
                        applied_events = self.render_state.take_applied_through(
                            pair[0].render_frame if pair is not None else None)
                        for applied in applied_events:
                            with send_lock:
                                connection.sendall(encode_frame(FrameKind.JSON, applied))
                            emitted_replace_seq = max(emitted_replace_seq, applied["appliedCommandSeq"])
                        if pair is not None:
                            master, split = pair
                            block_frames = self.model_host.config.block_samples
                            frames = (
                                encode_frame(FrameKind.PCM_MASTER, encode_pcm_body(master.render_frame, block_frames, 2, master.payload)),
                                encode_frame(FrameKind.PCM_SPLIT, encode_pcm_body(split.render_frame, block_frames,
                                                                                 self.model_host.config.pool_size, split.payload)),
                            )
                            with send_lock:
                                for frame in frames:
                                    connection.sendall(frame)
                        telemetry = self.telemetry.peek()
                        if telemetry is not None:
                            if telemetry["lastReplaceAppliedCommandSeq"] > emitted_replace_seq:
                                telemetry = None
                            else:
                                sample_seq += 1
                                wire_telemetry = dict(telemetry)
                                wire_telemetry.pop("lastReplaceAppliedCommandSeq")
                                message = {"type": "audio.telemetry", "audioEpoch": self.audio_epoch,
                                           "renderFrame": encode_u64_decimal(render_loop.render_frame),
                                           "sampleSeq": sample_seq, **wire_telemetry}
                                with send_lock:
                                    connection.sendall(encode_frame(FrameKind.JSON, message))
                                self.telemetry.acknowledge(telemetry)
                        if not applied_events and pair is None and telemetry is None:
                            stopped.wait(0.002)
                except BaseException as error:
                    with fatal_lock:
                        fatal.append(error)
                    stopped.set()
                    try:
                        connection.shutdown(2)
                    except OSError:
                        pass

            render_thread = threading.Thread(target=render, name="flock-audio-render", daemon=True)
            writer_thread = threading.Thread(target=write, name="flock-audio-writer", daemon=True)
            render_thread.start()
            writer_thread.start()
            try:
                decoder = FrameDecoder()
                while not stopped.is_set():
                    data = connection.recv(65536)
                    if not data:
                        decoder.eof()
                        break
                    for frame in decoder.feed(data):
                        if frame.kind is not FrameKind.JSON:
                            raise RuntimeError("RUNTIME_COMMAND_FRAME_INVALID")
                        message = json.loads(frame.body)
                        if not isinstance(message, dict) or message.get("type") != "audio.command.batch":
                            raise RuntimeError("RUNTIME_COMMAND_TYPE_INVALID")
                        def send_accepted(result):
                            with send_lock:
                                connection.sendall(encode_frame(FrameKind.JSON, {
                                    "type": "command.accepted", "audioEpoch": self.audio_epoch,
                                    "commandSeq": result.command_seq,
                                }))

                        accepted = self.queues.enqueue(message, on_accept=send_accepted)
                        if not accepted.accepted:
                            with send_lock:
                                connection.sendall(encode_frame(FrameKind.JSON, {
                                    "type": "command.rejected", "audioEpoch": self.audio_epoch,
                                    "commandSeq": message.get("commandSeq"), "reason": accepted.code,
                                    "rebuildRequired": self.queues.rebuild_required,
                                }))
            except (OSError, ValueError, TypeError, UnicodeError, RuntimeError):
                # A malformed or failed runtime connection cannot destroy the
                # singleton model owner. Thread failures are re-raised below.
                pass
            finally:
                stopped.set()
                render_thread.join(timeout=2)
                writer_thread.join(timeout=2)
                self.render_frame = render_loop.render_frame
                self.server.disconnect()
            if fatal:
                raise RuntimeError("AUDIO_WORKER_THREAD_FAILED") from fatal[0]
