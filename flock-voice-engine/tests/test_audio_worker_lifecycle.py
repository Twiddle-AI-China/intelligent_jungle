import json
import os
import socket
import tempfile
import threading
from pathlib import Path
import numpy as np

import pytest

from server.audio_worker.framing import FrameDecoder, FrameKind, encode_frame
from server.audio_worker.ipc_server import IpcServer, IpcServerError
from server.audio_worker.model_host import ModelHost
from server.audio_worker.worker import AudioWorker
import server.audio_worker.worker as worker_module
from server.voices import VoicePool
from server.config import EngineConfig


class FakeBackend:
    backend_id = "fake"

    def __init__(self):
        self.loads = 0
        self.on = []
        self.off = []
        self.resets = 0

    def load(self):
        self.loads += 1

    def close(self):
        pass

    def reset(self):
        self.resets += 1

    def note_on(self, voice):
        self.on.append(voice.row)

    def note_off(self, voice):
        self.off.append(voice.row)

    def info(self):
        return {"id": "fake", "sampleRate": 44100, "blockSamples": 4096, "poolSize": 5}


def test_reconnect_equivalent_loads_model_and_pool_once():
    backend = FakeBackend()
    host = ModelHost(EngineConfig(sample_rate=44100, block_samples=4096, pool_size=5),
                     {"sampleRate": 44100, "blockFrames": 4096, "poolSize": 5,
                      "rowVoices": ["bass", "pad", "lead", "pluck", "pad"]},
                     backend_factory=lambda _config: backend, allow_test_backend=True)
    for _ in range(20):
        assert host.load_once() is backend
    assert backend.loads == host.load_count == host.voice_pool_count == 1


def test_render_thread_command_applier_updates_pool_and_backend():
    backend = FakeBackend()
    host = ModelHost(EngineConfig(sample_rate=44100, block_samples=4096, pool_size=5),
                     {"sampleRate": 44100, "blockFrames": 4096, "poolSize": 5,
                      "rowVoices": ["bass", "pad", "lead", "pluck", "pad"]},
                     backend_factory=lambda _config: backend, allow_test_backend=True)
    host.load_once()
    host.apply_command({"type": "note.on", "row": 2, "midi": 67, "velocity": 0.7})
    assert host.voice_pool[2].gate and backend.on == [2]
    host.apply_command({"type": "continuous.set", "row": 2, "param": "gain", "value": 0.25})
    assert host.voice_pool[2].gain == 0.25
    host.apply_command({"type": "latent.set", "row": 2, "param": "timbre_xy", "value": [0.2, -0.3]})
    assert host.voice_pool[2].timbre_xy == (0.2, -0.3)
    host.apply_command({"type": "latent.set", "row": 2, "param": "timbre_xy", "value": None})
    assert host.voice_pool[2].timbre_xy is None
    host.apply_command({"type": "note.off", "row": 2})
    assert not host.voice_pool[2].gate and backend.off == [2]


def test_owner_barrier_voice_reset_turns_every_row_off():
    backend = FakeBackend()
    host = ModelHost(EngineConfig(sample_rate=44100, block_samples=4096, pool_size=5),
                     {"sampleRate": 44100, "blockFrames": 4096, "poolSize": 5,
                      "rowVoices": ["bass", "pad", "lead", "pluck", "pad"]},
                     backend_factory=lambda _config: backend, allow_test_backend=True)
    host.load_once()
    for row in range(5):
        host.apply_command({"type": "note.on", "row": row, "midi": 60, "velocity": 0.7})
    host.apply_command({"type": "voice.reset"})
    assert all(not voice.gate for voice in host.voice_pool.voices)


def test_production_never_falls_back_to_synth():
    backend = FakeBackend()
    host = ModelHost(EngineConfig(sample_rate=44100, block_samples=4096, pool_size=5),
                     {"sampleRate": 44100, "blockFrames": 4096, "poolSize": 5},
                     backend_factory=lambda _config: backend)
    try:
        host.load_once()
    except RuntimeError as error:
        assert str(error) == "CONTROLLED_ASSET_BUNDLE_REQUIRED"
    else:
        raise AssertionError("production accepted a non-brave backend")


def test_uds_identity_handshake_and_exact_single_connection():
    with tempfile.TemporaryDirectory(prefix="flock-uds-", dir="/tmp") as directory:
        root = Path(directory)
        os.chown(root, -1, os.getegid())
        os.chmod(root, 0o770)
        identity = {"releaseRevision": "1" * 40}
        server = IpcServer(root / "audio.sock", identity)
        server.listen_without_loading_model()
        accepted = []
        thread = threading.Thread(target=lambda: accepted.append(server.accept_identity()))
        thread.start()
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(str(root / "audio.sock"))
        decoder = FrameDecoder()
        hello = decoder.feed(client.recv(65536))[0]
        assert json.loads(hello.body) == {"type": "worker.hello", "identity": identity}
        client.sendall(encode_frame(FrameKind.JSON, {"type": "runtime.identity.accepted", "identity": identity}))
        thread.join(timeout=2)
        assert accepted
        with pytest.raises(IpcServerError, match="AUDIO_RUNTIME_CONNECTION_EXISTS"):
            server.accept_identity()
        client.close()
        server.close()
        assert not (root / "audio.sock").exists()


def test_bad_identity_connection_is_closed_and_next_runtime_can_connect():
    with tempfile.TemporaryDirectory(prefix="flock-uds-", dir="/tmp") as directory:
        root = Path(directory)
        os.chown(root, -1, os.getegid())
        os.chmod(root, 0o770)
        identity = {"releaseRevision": "1" * 40}
        server = IpcServer(root / "audio.sock", identity)
        server.listen_without_loading_model()

        # Use a normal helper so the exception remains contained in its thread.
        errors = []
        def reject_once():
            try:
                server.accept_identity()
            except Exception as error:
                errors.append(error)
        first_thread = threading.Thread(target=reject_once)
        first_thread.start()
        bad = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        bad.connect(str(root / "audio.sock"))
        FrameDecoder().feed(bad.recv(65536))
        bad.sendall(encode_frame(FrameKind.JSON, {"type": "runtime.identity.accepted", "identity": {}}))
        first_thread.join(timeout=2)
        assert isinstance(errors[0], IpcServerError)
        assert bad.recv(1) == b""

        accepted = []
        second_thread = threading.Thread(target=lambda: accepted.append(server.accept_identity()))
        second_thread.start()
        good = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        good.connect(str(root / "audio.sock"))
        FrameDecoder().feed(good.recv(65536))
        good.sendall(encode_frame(FrameKind.JSON, {"type": "runtime.identity.accepted", "identity": identity}))
        second_thread.join(timeout=2)
        assert accepted
        good.close()
        server.close()


def test_uds_preflight_refuses_any_existing_path():
    with tempfile.TemporaryDirectory(prefix="flock-uds-", dir="/tmp") as directory:
        root = Path(directory)
        os.chown(root, -1, os.getegid())
        os.chmod(root, 0o770)
        path = root / "audio.sock"
        path.write_text("not a socket", encoding="utf-8")
        with pytest.raises(IpcServerError, match="AUDIO_SOCKET_PREFLIGHT_FAILED"):
            IpcServer(path, {}).listen_without_loading_model()


class FakeConnection:
    def __init__(self, fail_after=None):
        self.closed = threading.Event()
        self.sends = 0
        self.fail_after = fail_after

    def sendall(self, _data):
        self.sends += 1
        if self.fail_after is not None and self.sends > self.fail_after:
            raise OSError("writer failed")

    def recv(self, _size):
        self.closed.wait(2)
        return b""

    def shutdown(self, _how):
        self.closed.set()


class FakeServer:
    def __init__(self, identity, connection):
        self.identity = identity
        self.connection = connection

    def listen_without_loading_model(self):
        pass

    def accept_identity(self):
        return self.connection

    def disconnect(self):
        self.connection.closed.set()

    def close(self):
        self.disconnect()


class ThreadHost:
    def __init__(self, fail_render=False):
        self.config = EngineConfig(sample_rate=44100, block_samples=64, pool_size=1)
        self.geometry = {"sampleRate": 44100, "blockFrames": 64, "poolSize": 1,
                         "rowVoices": ["bass"]}
        self.voice_pool = VoicePool(1, 44100)
        self.fail_render = fail_render

    def load_once(self):
        return self

    def apply_command(self, _command):
        pass

    def render_split(self, _voices, frames):
        if self.fail_render:
            raise RuntimeError("render failed")
        return np.zeros((1, frames), dtype=np.float32)


@pytest.mark.parametrize(("fail_render", "fail_after"), [(True, None), (False, 1)])
def test_thread_failure_closes_connection_and_terminates_worker(monkeypatch, fail_render, fail_after):
    identity = {"releaseRevision": "1" * 40}
    monkeypatch.setattr(worker_module, "load_worker_identity", lambda *_args: identity)
    connection = FakeConnection(fail_after=fail_after)
    worker = AudioWorker(FakeServer(identity, connection), ThreadHost(fail_render), Path("identity"), Path("manifest"))
    with pytest.raises(RuntimeError, match="AUDIO_WORKER_THREAD_FAILED"):
        worker.run(max_connections=1)
    assert connection.closed.is_set()
