#!/usr/bin/env python3
"""One-shot Linux controller client for the Phase 5 capture channel."""
from __future__ import annotations

import hashlib
import math
import os
import posixpath
import socket
import stat
import struct
import sys
import time
from pathlib import Path

try:
    from tools.validate_phase5_acceptance import (
        AcceptanceError,
        ED25519_SPKI_PREFIX,
        HEX,
        MAX_PHASE5_CAPTURE_CHANNEL_RESPONSE_BYTES,
        MAX_PHASE5_CAPTURE_RUN_IDENTITY_BYTES,
        REVISION,
        UUID_V4,
        _compose_phase5_captured_summary_result,
        decode_canonical_base64,
        phase5_canonical,
        strict_json_bytes,
        validate_phase5_capture_channel_response_boundary,
        validate_phase5_summary_composite_raw_boundary,
    )
except ModuleNotFoundError:
    from validate_phase5_acceptance import (  # type: ignore[no-redef]
        AcceptanceError,
        ED25519_SPKI_PREFIX,
        HEX,
        MAX_PHASE5_CAPTURE_CHANNEL_RESPONSE_BYTES,
        MAX_PHASE5_CAPTURE_RUN_IDENTITY_BYTES,
        REVISION,
        UUID_V4,
        _compose_phase5_captured_summary_result,
        decode_canonical_base64,
        phase5_canonical,
        strict_json_bytes,
        validate_phase5_capture_channel_response_boundary,
        validate_phase5_summary_composite_raw_boundary,
    )


PHASE5_CAPTURE_CONTROLLER_DIRECTORY_BASENAME = (
    "run-flock-phase5-candidate"
)
PHASE5_CAPTURE_SOCKET_BASENAME = "capture.sock"
MAX_LINUX_UNIX_SOCKET_PATH_BYTES = 107
PHASE5_CAPTURE_CHANNEL_TIMEOUT_SECONDS = 5.0
PHASE5_CAPTURE_SOCKET_UNLINK_TIMEOUT_SECONDS = 1.0
MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES = 4096
MAX_PHASE5_CAPTURE_ADMISSION_BYTES = 1024
_SO_PEERCRED = getattr(socket, "SO_PEERCRED", 17)
_UCRED = struct.Struct("@iII")
_ADMISSION_FIELDS = {
    "schemaVersion",
    "kind",
    "runId",
    "challenge",
    "captureNonce",
    "signerSpkiSha256",
    "trustedSignerSpkiDerBase64",
}
_IDENTITY_FIELDS = {
    "runId",
    "challenge",
    "release",
    "geometry",
    "profile",
}
_RELEASE_FIELDS = {
    "releaseManifestSha256",
    "releaseRevision",
    "sourceManifestSha256",
    "audioArtifactSha256",
}
_GEOMETRY_FIELDS = {
    "sampleRate",
    "blockFrames",
    "poolSize",
    "rowVoices",
}
_PROFILE_FIELDS = {
    "clients",
    "slowClient",
    "durationMinutes",
    "speciesEndpoint",
    "speciesModel",
}


class Phase5CaptureChannelTransportError(RuntimeError):
    """The fixed candidate channel was not proven and consumed once."""


def _fail(exc: BaseException | None = None) -> None:
    error = Phase5CaptureChannelTransportError(
        "PHASE5_CAPTURE_CHANNEL_TRANSPORT_REQUIRED"
    )
    if exc is None:
        raise error
    raise error from exc


def _exact_object(value: object, fields: set[str]) -> bool:
    return type(value) is dict and set(value) == fields


def _validate_expected_peer(
        expected_pid: object,
        expected_uid: object) -> None:
    if (type(expected_pid) is not int
            or expected_pid <= 0
            or expected_pid > 0x7fffffff
            or type(expected_uid) is not int
            or expected_uid < 0
            or expected_uid > 0xffffffff):
        _fail()


def _derive_controller_socket_path(
        controller_directory: object) -> str:
    try:
        if (type(controller_directory) is not str
                or len(controller_directory) == 0
                or "\0" in controller_directory
                or not posixpath.isabs(controller_directory)
                or posixpath.normpath(controller_directory)
                   != controller_directory
                or posixpath.basename(controller_directory)
                   != PHASE5_CAPTURE_CONTROLLER_DIRECTORY_BASENAME):
            _fail()
        socket_path = posixpath.join(
            controller_directory,
            PHASE5_CAPTURE_SOCKET_BASENAME,
        )
        if (len(os.fsencode(socket_path))
                > MAX_LINUX_UNIX_SOCKET_PATH_BYTES):
            _fail()
        return socket_path
    except Phase5CaptureChannelTransportError:
        raise
    except (AttributeError, OSError, TypeError, UnicodeError,
            ValueError) as exc:
        _fail(exc)


def _controller_path_ancestors(
        controller_directory: str) -> tuple[str, ...]:
    parts = controller_directory.split("/")[1:]
    current = ""
    ancestors = ["/"]
    for part in parts:
        current += f"/{part}"
        ancestors.append(current)
    return tuple(ancestors)


def _owned_admission(value: object) -> dict:
    if type(value) is not dict:
        _fail()
    keys = tuple(value)
    if (len(keys) != len(_ADMISSION_FIELDS)
            or any(type(key) is not str for key in keys)
            or set(keys) != _ADMISSION_FIELDS):
        _fail()
    try:
        if (type(value["schemaVersion"]) is not int
                or type(value["kind"]) is not str
                or len(value["kind"]) > 64
                or type(value["runId"]) is not str
                or len(value["runId"]) > 64
                or type(value["challenge"]) is not str
                or len(value["challenge"]) > 64
                or type(value["captureNonce"]) is not str
                or len(value["captureNonce"]) > 64
                or type(value["signerSpkiSha256"]) is not str
                or len(value["signerSpkiSha256"]) > 64
                or type(value["trustedSignerSpkiDerBase64"])
                   is not str
                or len(value["trustedSignerSpkiDerBase64"]) > 128):
            _fail()
        raw = phase5_canonical(value)
        if len(raw) > MAX_PHASE5_CAPTURE_ADMISSION_BYTES:
            _fail()
        owned = strict_json_bytes(
            raw,
            "PHASE5_CAPTURE_CHANNEL_TRANSPORT_REQUIRED",
        )
        if (raw != phase5_canonical(owned)
                or not _exact_object(owned, _ADMISSION_FIELDS)
                or type(owned["schemaVersion"]) is not int
                or owned["schemaVersion"] != 1
                or type(owned["kind"]) is not str
                or owned["kind"]
                   != "phase5-candidate-capture-admission"
                or type(owned["runId"]) is not str
                or len(owned["runId"]) != 36
                or UUID_V4.fullmatch(owned["runId"]) is None
                or type(owned["challenge"]) is not str
                or len(owned["challenge"]) != 64
                or HEX.fullmatch(owned["challenge"]) is None
                or type(owned["captureNonce"]) is not str
                or len(owned["captureNonce"]) != 64
                or HEX.fullmatch(owned["captureNonce"]) is None
                or type(owned["signerSpkiSha256"]) is not str
                or len(owned["signerSpkiSha256"]) != 64
                or HEX.fullmatch(
                    owned["signerSpkiSha256"]
                ) is None
                or type(owned["trustedSignerSpkiDerBase64"])
                   is not str
                or len(owned["trustedSignerSpkiDerBase64"]) != 60):
            _fail()
        return owned
    except Phase5CaptureChannelTransportError:
        raise
    except (AcceptanceError, AttributeError, KeyError, OverflowError,
            RecursionError, RuntimeError, TypeError, UnicodeError,
            ValueError) as exc:
        _fail(exc)


def _validated_controller_inputs(
        *,
        expected_pid: object,
        expected_uid: object,
        expected_admission: object,
        expected_raw_manifest_sha256: object,
        expected_run_identity_raw: object,
) -> tuple[dict, str, bytes, bytes]:
    try:
        _validate_expected_peer(expected_pid, expected_uid)
        if (type(expected_raw_manifest_sha256) is not str
                or len(expected_raw_manifest_sha256) != 64
                or HEX.fullmatch(
                    expected_raw_manifest_sha256
                ) is None
                or type(expected_run_identity_raw) is not bytes
                or len(expected_run_identity_raw)
                   > MAX_PHASE5_CAPTURE_RUN_IDENTITY_BYTES):
            _fail()

        admission_owned = _owned_admission(expected_admission)
        spki = decode_canonical_base64(
            admission_owned["trustedSignerSpkiDerBase64"],
            "PHASE5_CAPTURE_CHANNEL_TRANSPORT_REQUIRED",
        )
        if (len(spki) != 44
                or not spki.startswith(ED25519_SPKI_PREFIX)
                or hashlib.sha256(spki).hexdigest()
                   != admission_owned["signerSpkiSha256"]):
            _fail()

        identity_owned_raw = bytes(expected_run_identity_raw)
        identity = strict_json_bytes(
            identity_owned_raw,
            "PHASE5_CAPTURE_CHANNEL_TRANSPORT_REQUIRED",
        )
        release = (
            identity.get("release")
            if type(identity) is dict else None
        )
        geometry = (
            identity.get("geometry")
            if type(identity) is dict else None
        )
        profile = (
            identity.get("profile")
            if type(identity) is dict else None
        )
        if (not _exact_object(identity, _IDENTITY_FIELDS)
                or identity_owned_raw != phase5_canonical(identity)
                or type(identity["runId"]) is not str
                or identity["runId"] != admission_owned["runId"]
                or type(identity["challenge"]) is not str
                or identity["challenge"]
                   != admission_owned["challenge"]
                or type(identity["release"]) is not dict
                or type(identity["geometry"]) is not dict
                or type(identity["profile"]) is not dict
                or not _exact_object(release, _RELEASE_FIELDS)
                or type(release["releaseManifestSha256"]) is not str
                or HEX.fullmatch(
                    release["releaseManifestSha256"]
                ) is None
                or type(release["releaseRevision"]) is not str
                or REVISION.fullmatch(
                    release["releaseRevision"]
                ) is None
                or type(release["sourceManifestSha256"]) is not str
                or HEX.fullmatch(
                    release["sourceManifestSha256"]
                ) is None
                or type(release["audioArtifactSha256"]) is not str
                or HEX.fullmatch(
                    release["audioArtifactSha256"]
                ) is None
                or not _exact_object(geometry, _GEOMETRY_FIELDS)
                or type(geometry["sampleRate"]) is not int
                or geometry["sampleRate"] != 44_100
                or type(geometry["blockFrames"]) is not int
                or geometry["blockFrames"] != 4_096
                or type(geometry["poolSize"]) is not int
                or geometry["poolSize"] != 5
                or type(geometry["rowVoices"]) is not list
                or len(geometry["rowVoices"]) != 5
                or any(
                    type(voice) is not str
                    for voice in geometry["rowVoices"]
                )
                or geometry["rowVoices"]
                   != ["bass", "pad", "lead", "pluck", "pad"]
                or not _exact_object(profile, _PROFILE_FIELDS)
                or type(profile["clients"]) is not int
                or profile["clients"] != 4
                or type(profile["slowClient"]) is not int
                or profile["slowClient"] != 4
                or type(profile["durationMinutes"]) is not int
                or profile["durationMinutes"] != 30
                or type(profile["speciesEndpoint"]) is not str
                or profile["speciesEndpoint"]
                   != "http://127.0.0.1:8081/v1"
                or type(profile["speciesModel"]) is not str
                or profile["speciesModel"] != "bird_agent"):
            _fail()

        request_raw = phase5_canonical({
            "schemaVersion": 1,
            "kind":
                "phase5-candidate-capture-finalize-request",
            "runId": admission_owned["runId"],
            "challenge": admission_owned["challenge"],
            "captureNonce": admission_owned["captureNonce"],
            "rawManifestSha256": expected_raw_manifest_sha256,
        }) + b"\n"
        if len(request_raw) > MAX_PHASE5_CAPTURE_FINALIZE_REQUEST_BYTES:
            _fail()
        return (
            admission_owned,
            expected_raw_manifest_sha256,
            identity_owned_raw,
            request_raw,
        )
    except Phase5CaptureChannelTransportError:
        raise
    except (AcceptanceError, AttributeError, KeyError, OverflowError,
            RecursionError, RuntimeError, TypeError, UnicodeError,
            ValueError) as exc:
        _fail(exc)


def _validate_phase5_capture_socket_path(
        *,
        controller_directory: object,
        expected_uid: int,
        lstat,
        geteuid,
) -> str:
    try:
        _validate_expected_peer(1, expected_uid)
        socket_path = _derive_controller_socket_path(
            controller_directory
        )
        ancestors = _controller_path_ancestors(
            controller_directory  # type: ignore[arg-type]
        )
        controller_uid = geteuid()
        if (type(controller_uid) is not int
                or controller_uid < 0
                or controller_uid != expected_uid):
            _fail()
        states = {
            path: lstat(path)
            for path in (
                *ancestors,
                socket_path,
            )
        }
        if any(
            not stat.S_ISDIR(states[path].st_mode)
            for path in ancestors
        ):
            _fail()
        for path in ancestors[:-1]:
            state = states[path]
            mode = stat.S_IMODE(state.st_mode)
            if state.st_uid not in (0, controller_uid):
                _fail()
            if state.st_uid == controller_uid:
                if mode & 0o022:
                    _fail()
            elif mode & 0o022 and not mode & stat.S_ISVTX:
                _fail()
        parent = states[controller_directory]
        channel = states[socket_path]
        if (stat.S_IMODE(parent.st_mode) != 0o700
                or parent.st_uid != controller_uid
                or not stat.S_ISSOCK(channel.st_mode)
                or stat.S_IMODE(channel.st_mode) != 0o600
                or channel.st_uid != expected_uid):
            _fail()
        return socket_path
    except Phase5CaptureChannelTransportError:
        raise
    except (AttributeError, KeyError, OSError, TypeError,
            ValueError) as exc:
        _fail(exc)


def _wait_for_socket_unlinked(socket_path: str) -> bool:
    deadline = (
        time.monotonic()
        + PHASE5_CAPTURE_SOCKET_UNLINK_TIMEOUT_SECONDS
    )
    while True:
        try:
            os.lstat(socket_path)
        except FileNotFoundError:
            return True
        except OSError:
            return False
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.01)


def _exchange_phase5_capture_channel(
        *,
        expected_pid: int,
        expected_uid: int,
        expected_admission: object,
        expected_raw_manifest_sha256: str,
        expected_run_identity_raw: bytes,
        controller_socket_path: str,
        socket_factory,
        wait_for_unlinked,
        response_validator,
        monotonic=time.monotonic,
) -> dict:
    controller_directory = posixpath.dirname(
        controller_socket_path
        if type(controller_socket_path) is str else ""
    )
    if (_derive_controller_socket_path(controller_directory)
            != controller_socket_path):
        _fail()
    (
        admission_owned,
        manifest_sha256,
        identity_owned_raw,
        request_raw,
    ) = _validated_controller_inputs(
        expected_pid=expected_pid,
        expected_uid=expected_uid,
        expected_admission=expected_admission,
        expected_raw_manifest_sha256=
            expected_raw_manifest_sha256,
        expected_run_identity_raw=expected_run_identity_raw,
    )

    transport = None
    result = None
    primary: Exception | None = None
    try:
        deadline_start = monotonic()
        if (type(deadline_start) not in (int, float)
                or not math.isfinite(deadline_start)):
            _fail()
        deadline = (
            deadline_start
            + PHASE5_CAPTURE_CHANNEL_TIMEOUT_SECONDS
        )

        def arm_remaining_timeout() -> None:
            now = monotonic()
            if (type(now) not in (int, float)
                    or not math.isfinite(now)):
                _fail()
            remaining = deadline - now
            if remaining <= 0:
                _fail()
            transport.settimeout(remaining)

        transport = socket_factory()
        arm_remaining_timeout()
        transport.connect(controller_socket_path)
        credentials_raw = transport.getsockopt(
            socket.SOL_SOCKET,
            _SO_PEERCRED,
            _UCRED.size,
        )
        if (type(credentials_raw) is not bytes
                or len(credentials_raw) != _UCRED.size):
            _fail()
        peer_pid, peer_uid, _peer_gid = _UCRED.unpack(
            credentials_raw
        )
        if (peer_pid != expected_pid
                or peer_uid != expected_uid
                or wait_for_unlinked() is not True):
            _fail()

        arm_remaining_timeout()
        transport.sendall(request_raw)
        transport.shutdown(socket.SHUT_WR)
        response_buffer = bytearray(
            MAX_PHASE5_CAPTURE_CHANNEL_RESPONSE_BYTES
        )
        response_size = 0
        while True:
            arm_remaining_timeout()
            maximum = min(
                64 * 1024,
                MAX_PHASE5_CAPTURE_CHANNEL_RESPONSE_BYTES
                - response_size + 1,
            )
            chunk = transport.recv(maximum)
            if type(chunk) is not bytes:
                _fail()
            if chunk == b"":
                break
            if (len(chunk)
                    > MAX_PHASE5_CAPTURE_CHANNEL_RESPONSE_BYTES
                    - response_size):
                _fail()
            response_buffer[
                response_size:response_size + len(chunk)
            ] = chunk
            response_size += len(chunk)
        response_raw = bytes(
            memoryview(response_buffer)[:response_size]
        )
        result = response_validator(
            response_raw,
            admission_owned,
            manifest_sha256,
            identity_owned_raw,
        )
    except Exception as exc:  # cleanup preserves the primary failure
        primary = exc

    if transport is not None:
        try:
            transport.close()
        except Exception as exc:
            if primary is None:
                primary = exc

    if primary is not None:
        if isinstance(primary, AcceptanceError):
            raise primary
        if isinstance(primary, Phase5CaptureChannelTransportError):
            raise primary
        _fail(primary)
    if type(result) is not dict:
        _fail()
    return result


def _validate_phase5_capture_response_with_session(
        response_raw: bytes,
        expected_admission: object,
        expected_raw_manifest_sha256: str,
        expected_run_identity_raw: bytes) -> dict:
    """Retain canonical v2 session bytes after the fixed response verifier."""
    code = "PHASE5_CAPTURE_PROOF_VALIDATION_REQUIRED"
    verified = validate_phase5_capture_channel_response_boundary(
        response_raw,
        expected_admission,
        expected_raw_manifest_sha256,
        expected_run_identity_raw,
    )
    try:
        if (type(response_raw) is not bytes
                or not response_raw.endswith(b"\n")
                or response_raw.endswith(b"\n\n")
                or type(verified) is not dict):
            raise AcceptanceError(code)
        response = strict_json_bytes(response_raw[:-1], code)
        session_raw = phase5_canonical(response["session"])
        session = strict_json_bytes(session_raw, code)
        capture_validation = verified["captureValidation"]
        if (type(session) is not dict
                or session_raw != phase5_canonical(session)
                or type(session["schemaVersion"]) is not int
                or session["schemaVersion"] != 2
                or session["kind"]
                   != "phase5-fault-session-attestation"
                or type(capture_validation) is not dict
                or hashlib.sha256(session_raw).hexdigest()
                   != capture_validation[
                       "faultSessionEvidenceSha256"
                   ]):
            raise AcceptanceError(code)
        return {
            "captureBoundary": verified,
            "sessionRaw": session_raw,
        }
    except AcceptanceError:
        raise
    except (AttributeError, KeyError, OverflowError, RecursionError,
            RuntimeError, TypeError, UnicodeError, ValueError) as exc:
        raise AcceptanceError(code) from exc


def _capture_phase5_candidate_response_linux(
        controller_directory: str,
        expected_pid: int,
        expected_uid: int,
        expected_admission: object,
        expected_raw_manifest_sha256: str,
        expected_run_identity_raw: bytes,
        *,
        response_validator) -> dict:
    if (sys.platform != "linux"
            or not hasattr(socket, "SO_PEERCRED")):
        _fail()
    _validate_expected_peer(expected_pid, expected_uid)
    controller_socket_path = _validate_phase5_capture_socket_path(
        controller_directory=controller_directory,
        expected_uid=expected_uid,
        lstat=os.lstat,
        geteuid=os.geteuid,
    )
    return _exchange_phase5_capture_channel(
        expected_pid=expected_pid,
        expected_uid=expected_uid,
        expected_admission=expected_admission,
        expected_raw_manifest_sha256=
            expected_raw_manifest_sha256,
        expected_run_identity_raw=expected_run_identity_raw,
        controller_socket_path=controller_socket_path,
        socket_factory=lambda: socket.socket(
            socket.AF_UNIX,
            socket.SOCK_STREAM,
        ),
        wait_for_unlinked=lambda: _wait_for_socket_unlinked(
            controller_socket_path
        ),
        response_validator=response_validator,
    )


def capture_phase5_candidate_response_linux(
        controller_directory: str,
        expected_pid: int,
        expected_uid: int,
        expected_admission: object,
        expected_raw_manifest_sha256: str,
        expected_run_identity_raw: bytes) -> dict:
    """Consume the fixed Linux UDS once and verify the signed response."""
    return _capture_phase5_candidate_response_linux(
        controller_directory,
        expected_pid,
        expected_uid,
        expected_admission,
        expected_raw_manifest_sha256,
        expected_run_identity_raw,
        response_validator=
            validate_phase5_capture_channel_response_boundary,
    )


def capture_phase5_candidate_summary_linux(
        value: object,
        root: Path,
        controller_directory: str,
        expected_pid: int,
        expected_uid: int,
        expected_admission: object,
        expected_raw_manifest_sha256: str,
        expected_run_identity_raw: bytes) -> dict:
    """Capture from the admitted Linux process and bind its v2 raw summary."""
    captured = _capture_phase5_candidate_response_linux(
        controller_directory,
        expected_pid,
        expected_uid,
        expected_admission,
        expected_raw_manifest_sha256,
        expected_run_identity_raw,
        response_validator=_validate_phase5_capture_response_with_session,
    )
    capture_boundary = captured["captureBoundary"]
    summary_composite = validate_phase5_summary_composite_raw_boundary(
        value,
        Path(root),
        capture_boundary["faultRunBindingProjection"],
    )
    return _compose_phase5_captured_summary_result(
        capture_boundary,
        captured["sessionRaw"],
        summary_composite,
        expected_raw_manifest_sha256,
    )
