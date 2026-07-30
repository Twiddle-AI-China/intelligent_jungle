from __future__ import annotations

import json
import os
import threading

import pytest

from server.audio_worker import launcher
from server.audio_worker import __main__ as worker_main
from server.audio_worker.worker import AudioWorker


def canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"


def test_private_control_line_is_canonical_bounded_and_duplicate_safe():
    value = {
        "schemaVersion": 1,
        "kind": "phase5-audio-crash-child",
        "sequence": 1,
    }
    assert launcher._decode_canonical_line(canonical(value)) == value
    for raw in (
        b'{"kind":"x","kind":"y"}\n',
        b'{"kind":"x"} \n',
        b'{"kind":"x"}\ntrailing',
        b'{"kind":"x"}',
        b"x" * (launcher.MAX_CONTROL_LINE_BYTES + 1),
    ):
        with pytest.raises(
                launcher.AudioWorkerLauncherError,
                match="AUDIO_FAULT_CONTROL_FRAME_INVALID"):
            launcher._decode_canonical_line(raw)


def test_launcher_exposes_only_fixed_parameter_free_audio_commands():
    source = launcher.Path(launcher.__file__).read_text("utf-8")
    assert '"phase5-audio-crash-child"' in source
    assert '"phase5-audio-rotate-epoch"' in source
    assert 'set(command) != {"schemaVersion", "kind", "sequence"}' in source
    for forbidden in ("shell", "argv", "targetPid", "containerId", "signalName"):
        assert forbidden not in source


def test_worker_epoch_rotation_request_is_one_shot_until_consumed():
    shutdowns = []
    worker = object.__new__(AudioWorker)
    worker._rotation_requested = threading.Event()
    worker._rotation_target = None
    worker._current_connection = type("Connection", (), {
        "shutdown": lambda self, how: shutdowns.append(how),
    })()
    target = "phase5-" + "a" * 32
    assert worker.request_epoch_rotation(target) is True
    assert worker.request_epoch_rotation(target) is False
    assert worker._rotation_target == target
    assert shutdowns == [2]


def test_launcher_rotation_command_pipe_binds_exact_target(monkeypatch):
    read_fd, write_fd = os.pipe()
    target = "phase5-" + "b" * 32
    try:
        os.write(write_fd, canonical({
            "kind": "audio-worker-rotate-epoch",
            "targetAudioEpoch": target,
        }))
        assert worker_main._read_rotation_target(read_fd) == target
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_planned_epoch_matches_runtime_signed_receipt_derivation():
    assert launcher._planned_audio_epoch("a" * 64) == (
        "phase5-0e214f102a85b79938569c016d2d178c"
    )


def test_audio_fault_channel_eof_is_clean_only_after_both_fixed_commands():
    error = launcher.AudioWorkerLauncherError(
        "AUDIO_FAULT_CONTROL_EOF"
    )
    assert launcher._is_clean_control_eof(2, error) is True
    assert launcher._is_clean_control_eof(1, error) is False
    assert launcher._is_clean_control_eof(
        2, RuntimeError("AUDIO_FAULT_CONTROL_EOF")
    ) is False


def test_epoch_ack_pipe_reader_reassembles_one_bounded_line(monkeypatch):
    read_fd, write_fd = os.pipe()
    try:
        chunks = [b'{"kind":"audio-', b'worker-epoch-rotated"}\n']

        def read(_descriptor, _size):
            return chunks.pop(0)

        monkeypatch.setattr(launcher.os, "read", read)
        monkeypatch.setattr(
            launcher.select,
            "select",
            lambda reads, _writes, _errors, _timeout: (reads, [], []),
        )
        assert launcher._read_fd_line(read_fd, 1) == (
            b'{"kind":"audio-worker-epoch-rotated"}\n'
        )
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_launcher_witness_is_bound_to_validated_pid1_pipe(monkeypatch):
    values = {
        "FLOCK_AUDIO_LAUNCHER_RESTART_COUNT": "1",
        "FLOCK_AUDIO_LAUNCHER_SUPERVISOR_GENERATION": "2",
        "FLOCK_AUDIO_LAUNCHER_LAST_EXITED_PID": "41",
        "FLOCK_AUDIO_LAUNCHER_LAST_EXIT_SIGNAL": "SIGKILL",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(worker_main.os, "getpid", lambda: 42)
    assert worker_main._launcher_witness(9) == {
        "pid": 42,
        "restartCount": 1,
        "supervisorGeneration": 2,
        "lastExitedPid": 41,
        "lastExitSignal": "SIGKILL",
    }
    assert all(name not in os.environ for name in values)


@pytest.mark.parametrize(
    ("name", "value"),
    (
        ("FLOCK_AUDIO_LAUNCHER_RESTART_COUNT", "-1"),
        ("FLOCK_AUDIO_LAUNCHER_SUPERVISOR_GENERATION", "0"),
        ("FLOCK_AUDIO_LAUNCHER_LAST_EXITED_PID", "41"),
        ("FLOCK_AUDIO_LAUNCHER_LAST_EXIT_SIGNAL", "SIGTERM"),
    ),
)
def test_launcher_witness_rejects_forged_or_partial_metadata(
        monkeypatch, name, value):
    values = {
        "FLOCK_AUDIO_LAUNCHER_RESTART_COUNT": "0",
        "FLOCK_AUDIO_LAUNCHER_SUPERVISOR_GENERATION": "1",
        "FLOCK_AUDIO_LAUNCHER_LAST_EXITED_PID": "",
        "FLOCK_AUDIO_LAUNCHER_LAST_EXIT_SIGNAL": "",
    }
    values[name] = value
    for key, member in values.items():
        monkeypatch.setenv(key, member)
    with pytest.raises(
            RuntimeError, match="AUDIO_LAUNCHER_AUTHORITY_INVALID"):
        worker_main._launcher_witness(9)
