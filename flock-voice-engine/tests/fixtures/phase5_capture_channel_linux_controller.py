#!/usr/bin/env python3
"""Isolated Linux authority probe for the Phase 5 capture channel."""
from __future__ import annotations

import json
import os
import select
import stat
import subprocess
import sys
import time
from pathlib import Path


ENGINE = Path(__file__).resolve().parents[2]
sys.path.insert(0, os.fspath(ENGINE))

from tools.phase5_capture_channel_client import (  # noqa: E402
    Phase5CaptureChannelTransportError,
    capture_phase5_candidate_response_linux,
    phase5_canonical,
    strict_json_bytes,
)


RAW_MANIFEST_SHA256 = "9" * 64
MAX_ADMISSION_LINE_BYTES = 2048
MAX_RESULT_LINE_BYTES = 1024
IDENTITY = {
    "runId": "123e4567-e89b-42d3-a456-426614174000",
    "challenge": "1" * 64,
    "release": {
        "releaseManifestSha256": "2" * 64,
        "releaseRevision": "3" * 40,
        "sourceManifestSha256": "4" * 64,
        "audioArtifactSha256": "5" * 64,
    },
    "geometry": {
        "sampleRate": 44_100,
        "blockFrames": 4_096,
        "poolSize": 5,
        "rowVoices": ["bass", "pad", "lead", "pluck", "pad"],
    },
    "profile": {
        "clients": 4,
        "slowClient": 4,
        "durationMinutes": 30,
        "speciesEndpoint": "http://127.0.0.1:8081/v1",
        "speciesModel": "bird_agent",
    },
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def read_line(stream, maximum: int, code: str) -> bytes:
    deadline = time.monotonic() + 5.0
    buffer = bytearray()
    descriptor = stream.fileno()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            fail(code)
        readable, _, _ = select.select(
            [descriptor],
            [],
            [],
            remaining,
        )
        if readable == []:
            fail(code)
        chunk = os.read(
            descriptor,
            min(4096, maximum + 1 - len(buffer)),
        )
        if chunk == b"":
            fail(code)
        buffer.extend(chunk)
        if len(buffer) > maximum:
            fail(code)
        newline = buffer.find(b"\n")
        if newline >= 0:
            if newline != len(buffer) - 1:
                fail(code)
            return bytes(buffer)


def close_peer(process: subprocess.Popen[bytes]) -> dict:
    if process.stdin is None or process.stdout is None:
        fail("LINUX_PROBE_PIPE_REQUIRED")
    process.stdin.write(b"close\n")
    process.stdin.flush()
    process.stdin.close()
    result_raw = read_line(
        process.stdout,
        MAX_RESULT_LINE_BYTES,
        "LINUX_PROBE_RESULT_INVALID",
    )
    result = strict_json_bytes(
        result_raw[:-1],
        "LINUX_PROBE_RESULT_INVALID",
    )
    return_code = process.wait(timeout=10)
    stderr_raw = (
        process.stderr.read()
        if process.stderr is not None else b""
    )
    if (return_code != 0
            or stderr_raw != b""
            or type(result) is not dict
            or set(result) != {
                "closed", "receivedSocketBytes", "sealed",
            }
            or result["closed"] is not True
            or result["sealed"] is not True
            or type(result["receivedSocketBytes"]) is not int
            or result["receivedSocketBytes"] < 0):
        fail("LINUX_PROBE_PEER_NOT_SEALED")
    return result


def wait_for_socket_unlinked(socket_path: Path) -> None:
    deadline = time.monotonic() + 2.0
    while True:
        try:
            socket_path.lstat()
        except FileNotFoundError:
            return
        if time.monotonic() >= deadline:
            fail("LINUX_PROBE_SOCKET_NOT_UNLINKED")
        time.sleep(0.01)


def run_exchange(
        node_executable: Path,
        controller_directory: Path,
        *,
        expected_pid_delta: int) -> dict:
    peer_script = (
        ENGINE
        / "runtime/test/fixtures"
        / "phase5-capture-channel-linux-peer.mjs"
    )
    socket_path = controller_directory / "capture.sock"
    process = subprocess.Popen(
        [
            os.fspath(node_executable),
            os.fspath(peer_script),
            os.fspath(socket_path),
        ],
        cwd=ENGINE,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={},
        bufsize=0,
    )
    try:
        if process.stdout is None:
            fail("LINUX_PROBE_PIPE_REQUIRED")
        admission_raw = read_line(
            process.stdout,
            MAX_ADMISSION_LINE_BYTES,
            "LINUX_PROBE_ADMISSION_INVALID",
        )
        admission = strict_json_bytes(
            admission_raw[:-1],
            "LINUX_PROBE_ADMISSION_INVALID",
        )
        channel_state = socket_path.lstat()
        if (not stat.S_ISSOCK(channel_state.st_mode)
                or stat.S_IMODE(channel_state.st_mode) != 0o600
                or channel_state.st_uid != os.geteuid()):
            fail("LINUX_PROBE_SOCKET_AUTHORITY_INVALID")

        expected_pid = process.pid + expected_pid_delta
        if expected_pid_delta == 0:
            verified = capture_phase5_candidate_response_linux(
                os.fspath(controller_directory),
                expected_pid,
                os.geteuid(),
                admission,
                RAW_MANIFEST_SHA256,
                phase5_canonical(IDENTITY),
            )
            if verified.get("captureValidation", {}).get("passed") is not True:
                fail("LINUX_PROBE_CAPTURE_VALIDATION_FAILED")
            outcome = {
                "capturePassed": True,
                "expectedPid": expected_pid,
                "peerPid": process.pid,
                "socketMode": "0600",
            }
        else:
            try:
                capture_phase5_candidate_response_linux(
                    os.fspath(controller_directory),
                    expected_pid,
                    os.geteuid(),
                    admission,
                    RAW_MANIFEST_SHA256,
                    phase5_canonical(IDENTITY),
                )
            except Phase5CaptureChannelTransportError as error:
                if str(error) != (
                        "PHASE5_CAPTURE_CHANNEL_TRANSPORT_REQUIRED"):
                    raise
            else:
                fail("LINUX_PROBE_PID_MISMATCH_ACCEPTED")
            outcome = {
                "capturePassed": False,
                "expectedPid": expected_pid,
                "peerPid": process.pid,
            }

        wait_for_socket_unlinked(socket_path)
        peer_result = close_peer(process)
        if (expected_pid_delta == 0
                and peer_result["receivedSocketBytes"] < 1):
            fail("LINUX_PROBE_POSITIVE_REQUEST_NOT_OBSERVED")
        if (expected_pid_delta != 0
                and peer_result["receivedSocketBytes"] != 0):
            fail("LINUX_PROBE_PID_MISMATCH_SENT_BYTES")
        outcome.update(peer_result)
        return outcome
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)


def main() -> None:
    if len(sys.argv) != 3:
        fail("usage: controller.py NODE ABSOLUTE_ATTEMPT_DIRECTORY")
    node_executable = Path(sys.argv[1])
    attempt_directory = Path(sys.argv[2])
    controller_directory = (
        attempt_directory / "run-flock-phase5-candidate"
    )
    if (not node_executable.is_absolute()
            or not attempt_directory.is_absolute()
            or attempt_directory.is_symlink()
            or stat.S_IMODE(attempt_directory.stat().st_mode) != 0o700
            or attempt_directory.stat().st_uid != os.geteuid()):
        fail("LINUX_PROBE_ATTEMPT_AUTHORITY_INVALID")
    controller_directory.mkdir(mode=0o700)
    if (controller_directory.is_symlink()
            or stat.S_IMODE(controller_directory.stat().st_mode) != 0o700
            or controller_directory.stat().st_uid != os.geteuid()):
        fail("LINUX_PROBE_CONTROLLER_AUTHORITY_INVALID")

    os.environ["PHASE5_APPROVED_NODE_EXE"] = os.fspath(
        node_executable
    )
    results = {
        "schemaVersion": 1,
        "kind": "phase5-capture-channel-linux-authority-probe",
        "uid": os.geteuid(),
        "positive": run_exchange(
            node_executable,
            controller_directory,
            expected_pid_delta=0,
        ),
        "pidMismatch": run_exchange(
            node_executable,
            controller_directory,
            expected_pid_delta=1,
        ),
    }
    print(json.dumps(
        results,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ))


if __name__ == "__main__":
    main()
