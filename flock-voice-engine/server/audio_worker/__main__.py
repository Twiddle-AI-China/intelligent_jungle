"""生产 worker entry；禁止导入 legacy app。"""
from __future__ import annotations

import sys
import json
import os
import signal
import stat
from pathlib import Path

from server.audio_worker.identity import load_trusted_release_manifest, load_verified_asset_bundle, load_worker_identity
from server.audio_worker.ipc_server import IpcServer, IpcServerError
from server.audio_worker.model_host import ModelHost
from server.audio_worker.worker import AudioWorker
from server.config import EngineConfig


def _launcher_ack_fd() -> int | None:
    raw = os.environ.pop("FLOCK_AUDIO_LAUNCHER_ACK_FD", None)
    if raw is None:
        return None
    if (
        os.getppid() != 1
        or not raw.isascii()
        or not raw.isdecimal()
        or int(raw) <= 2
    ):
        raise RuntimeError("AUDIO_LAUNCHER_AUTHORITY_INVALID")
    descriptor = int(raw)
    value = os.fstat(descriptor)
    if not stat.S_ISFIFO(value.st_mode):
        raise RuntimeError("AUDIO_LAUNCHER_AUTHORITY_INVALID")
    return descriptor


def _launcher_command_fd() -> int:
    raw = os.environ.pop("FLOCK_AUDIO_LAUNCHER_COMMAND_FD", None)
    if (
        os.getppid() != 1
        or raw is None
        or not raw.isascii()
        or not raw.isdecimal()
        or int(raw) <= 2
    ):
        raise RuntimeError("AUDIO_LAUNCHER_AUTHORITY_INVALID")
    descriptor = int(raw)
    value = os.fstat(descriptor)
    if not stat.S_ISFIFO(value.st_mode):
        raise RuntimeError("AUDIO_LAUNCHER_AUTHORITY_INVALID")
    return descriptor


def _read_rotation_target(descriptor: int) -> str:
    value = bytearray()
    while True:
        chunk = os.read(descriptor, 4096 - len(value))
        if not chunk:
            raise RuntimeError("AUDIO_EPOCH_ROTATION_COMMAND_INVALID")
        value.extend(chunk)
        newline = value.find(b"\n")
        if newline >= 0:
            if newline != len(value) - 1:
                raise RuntimeError("AUDIO_EPOCH_ROTATION_COMMAND_INVALID")
            break
        if len(value) >= 4096:
            raise RuntimeError("AUDIO_EPOCH_ROTATION_COMMAND_INVALID")
    try:
        decoded = json.loads(value[:-1].decode("utf-8", errors="strict"))
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("AUDIO_EPOCH_ROTATION_COMMAND_INVALID") from exc
    if (
        type(decoded) is not dict
        or set(decoded) != {"kind", "targetAudioEpoch"}
        or decoded["kind"] != "audio-worker-rotate-epoch"
        or type(decoded["targetAudioEpoch"]) is not str
        or len(decoded["targetAudioEpoch"]) != 39
        or not decoded["targetAudioEpoch"].startswith("phase5-")
        or any(character not in "0123456789abcdef"
               for character in decoded["targetAudioEpoch"][7:])
        or _canonical_line(decoded) != bytes(value)
    ):
        raise RuntimeError("AUDIO_EPOCH_ROTATION_COMMAND_INVALID")
    return decoded["targetAudioEpoch"]


def _launcher_witness(descriptor: int | None) -> dict:
    names = (
        "FLOCK_AUDIO_LAUNCHER_RESTART_COUNT",
        "FLOCK_AUDIO_LAUNCHER_SUPERVISOR_GENERATION",
        "FLOCK_AUDIO_LAUNCHER_LAST_EXITED_PID",
        "FLOCK_AUDIO_LAUNCHER_LAST_EXIT_SIGNAL",
    )
    raw = {name: os.environ.pop(name, None) for name in names}
    if descriptor is None:
        if any(value is not None for value in raw.values()):
            raise RuntimeError("AUDIO_LAUNCHER_AUTHORITY_INVALID")
        raise RuntimeError("AUDIO_LAUNCHER_AUTHORITY_REQUIRED")
    restart = raw[names[0]]
    generation = raw[names[1]]
    last_pid = raw[names[2]]
    last_signal = raw[names[3]]
    if (
        restart is None
        or generation is None
        or last_pid is None
        or last_signal is None
        or not restart.isascii()
        or not restart.isdecimal()
        or not generation.isascii()
        or not generation.isdecimal()
        or int(restart) > 0x7fffffff
        or not 1 <= int(generation) <= 0x7fffffff
        or (
            (last_pid == "") != (last_signal == "")
        )
        or (
            last_pid != ""
            and (
                not last_pid.isascii()
                or not last_pid.isdecimal()
                or not 1 <= int(last_pid) <= 0x7fffffff
                or last_signal != "SIGKILL"
            )
        )
    ):
        raise RuntimeError("AUDIO_LAUNCHER_AUTHORITY_INVALID")
    return {
        "pid": os.getpid(),
        "restartCount": int(restart),
        "supervisorGeneration": int(generation),
        "lastExitedPid": None if last_pid == "" else int(last_pid),
        "lastExitSignal": None if last_signal == "" else last_signal,
    }


def _canonical_line(value: dict) -> bytes:
    return (json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n").encode("utf-8")


def main() -> int:
    identity_path = Path("/release/audio-identity.json")
    manifest_path = Path("/release/audio-artifact-manifest.json")
    asset_bundle = None
    launcher_ack_fd = None
    launcher_command_fd = None
    try:
        launcher_ack_fd = _launcher_ack_fd()
        launcher_command_fd = _launcher_command_fd()
        launcher_witness = _launcher_witness(launcher_ack_fd)
        identity = load_worker_identity(identity_path, manifest_path)
        release = load_trusted_release_manifest(
            Path("/release/release-manifest.json"), Path("/release/release-manifest.json.sha256"), identity,
        )
        asset_bundle = load_verified_asset_bundle(identity_path, manifest_path, expected_identity=identity)
        if asset_bundle.manifest_sha256 != identity["audioArtifactSha256"]:
            raise RuntimeError("AUDIO_IDENTITY_BUNDLE_MISMATCH")
        geometry = release["geometry"]
        config = EngineConfig(sample_rate=geometry["sampleRate"], block_samples=geometry["blockFrames"],
                              pool_size=geometry["poolSize"], backend="brave-voices", device="cuda")
        model_host = ModelHost(config, geometry, asset_bundle=asset_bundle)
        server = IpcServer("/run/flock-audio/audio.sock", identity)
        def on_epoch_rotated(before, after):
            if launcher_ack_fd is None:
                raise RuntimeError("AUDIO_EPOCH_ROTATION_UNAUTHORIZED")
            os.write(launcher_ack_fd, _canonical_line({
                "kind": "audio-worker-epoch-rotated",
                "beforeAudioEpoch": before,
                "afterAudioEpoch": after,
            }))

        worker = AudioWorker(
            server,
            model_host,
            identity_path,
            manifest_path,
            identity=identity,
            on_epoch_rotated=on_epoch_rotated,
            launcher_witness=launcher_witness,
        )
        if launcher_ack_fd is not None:
            def rotate_epoch(_signum, _frame):
                target_epoch = _read_rotation_target(
                    launcher_command_fd
                )
                if not worker.request_epoch_rotation(target_epoch):
                    raise RuntimeError("AUDIO_EPOCH_ROTATION_ALREADY_PENDING")
            signal.signal(signal.SIGUSR1, rotate_epoch)
        worker.run()
    except (RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    finally:
        if asset_bundle is not None:
            asset_bundle.close()
        if launcher_ack_fd is not None:
            try:
                os.close(launcher_ack_fd)
            except OSError:
                pass
        if launcher_command_fd is not None:
            try:
                os.close(launcher_command_fd)
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
