#!/usr/bin/env python3
"""Append-only controller registry for one Phase 5 candidate attempt.

Linux authority is capability based.  Creation opens a trusted private
anchor, then creates and retains registry/attempt directory descriptors.
All mutable names below that anchor are accessed with ``*at`` operations.
The live handle must survive until admission is durably committed.

Windows executes the same canonical-record and state-transition contracts,
but its pathname fallback is deliberately non-authoritative.  Callers must
still pass :func:`require_linux_attempt_authority` before treating an
attempt as production evidence.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import socket
import stat
import struct
import sys
from pathlib import Path
from typing import NamedTuple


ATTEMPT_ID = re.compile(r"^[0-9a-f]{32}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")
BOOTSTRAP_BIND_SOURCE_NAME = "run-flock-phase5-bootstrap"
CANDIDATE_BIND_SOURCE_NAME = "run-flock-phase5-candidate"
FAULT_CONTROL_BIND_SOURCE_NAME = "run-flock-phase5-fault-control"
BOOTSTRAP_CONTAINER_PATH = "/run/flock-phase5-bootstrap"
CANDIDATE_CONTAINER_PATH = "/run/flock-phase5-candidate"
FAULT_CONTROL_CONTAINER_PATH = "/run/flock-phase5-fault-control"
CAPTURE_SOCKET_NAME = "capture.sock"
RUNTIME_CONTROL_SOCKET_NAME = "runtime-control.sock"
AUDIO_CONTROL_SOCKET_NAME = "audio-control.sock"
INTENT_RECORD_NAME = "intent.json"
ADMISSION_RECORD_NAME = "admission.json"
FAULT_CONTROL_ACTIVE_RECORD_NAME = "fault-control-active.json"
FAULT_CONTROL_CLOSED_RECORD_NAME = "fault-control-closed.json"
CAPTURE_INTENT_RECORD_NAME = "capture-intent.json"
CAPTURE_FAILURE_RECORD_NAME = "capture-failure.json"
CAPTURE_SESSION_RECORD_NAME = "fault-session-attestation.json"
ATTESTATION_COMMIT_RECORD_NAME = "attestation-commit.json"
MAX_RECORD_BYTES = 64 * 1024
MAX_ADMISSION_BYTES = 4096
MAX_SESSION_BYTES = 1024 * 1024
MAX_FAULT_CONTROL_RESPONSE_BYTES = 128 * 1024 * 1024
_RELAY_ACTIONS = {
    1: (2, "signal-worker", "candidate-audio-worker"),
    4: (9, "reconnect-runtime", "runtime-client-4"),
    5: (12, "pause-audio", "audio-client-4"),
    6: (14, "resume-audio", "audio-client-4"),
    8: (19, "reconnect-egress", "egress-client-4"),
    13: (32, "rotate-audio-epoch", "candidate-audio-worker"),
}
_CLIENT_RELAY_ACTIONS = {4, 5, 6, 8}
RECORD_OPEN_FLAGS = (
    os.O_WRONLY
    | os.O_CREAT
    | os.O_EXCL
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_BINARY", 0)
)
READ_OPEN_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_BINARY", 0)
)
DIRECTORY_OPEN_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_BINARY", 0)
)
LINUX_AUTHORITY_AVAILABLE = (
    sys.platform.startswith("linux")
    and hasattr(os, "O_NOFOLLOW")
    and hasattr(os, "O_DIRECTORY")
    and os.mkdir in os.supports_dir_fd
    and os.open in os.supports_dir_fd
    and os.stat in os.supports_dir_fd
    and os.scandir in os.supports_fd
)
_NATIVE_PATH_TYPE = type(Path.cwd())
_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_INTENT_FIELDS = {
    "schemaVersion",
    "kind",
    "attemptId",
    "releaseManifestSha256",
    "controller",
    "bindMounts",
}
_CONTROLLER_FIELDS = {"uid", "gid"}
_BIND_MOUNTS_FIELDS = {"bootstrap", "candidate", "faultControl"}
_BIND_MOUNT_FIELDS = {
    "source",
    "destination",
    "readOnly",
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
_ADMISSION_FIELDS = {
    "schemaVersion",
    "kind",
    "runId",
    "challenge",
    "captureNonce",
    "signerSpkiSha256",
    "trustedSignerSpkiDerBase64",
}
_ADMISSION_RECORD_FIELDS = {
    "schemaVersion",
    "kind",
    "attemptId",
    "intentSha256",
    "candidate",
    "identity",
    "admission",
    "admissionSha256",
    "captureSocketState",
    "faultControlMountIdentity",
    "faultControlPhase",
    "faultControlInventory",
}
_CANDIDATE_FIELDS = {"containerId", "pid", "uid"}
_CAPTURE_SOCKET_STATE_FIELDS = {
    "device",
    "inode",
    "type",
    "mode",
    "uid",
    "gid",
    "nlink",
}
_CAPTURE_INTENT_FIELDS = {
    "schemaVersion",
    "kind",
    "attemptId",
    "intentSha256",
    "admissionRecordSha256",
    "admissionSha256",
    "releaseManifestSha256",
    "candidate",
    "identity",
    "captureNonce",
    "signerSpkiSha256",
    "rawManifestSha256",
}
_CAPTURE_FAILURE_FIELDS = {
    "schemaVersion",
    "kind",
    "attemptId",
    "captureIntentSha256",
    "errorCode",
    "channelDisposition",
}
_ATTESTATION_COMMIT_FIELDS = {
    "schemaVersion",
    "kind",
    "attemptId",
    "captureIntentSha256",
    "sessionSha256",
    "rawManifestSha256",
    "profileDigests",
    "stagingMachineAttestationSha256",
    "evidenceInventorySha256",
}
_PROFILE_DIGEST_FIELDS = {"normal", "burst"}
_EVIDENCE_INVENTORY_FIELDS = {"name", "sha256"}
_CAPTURE_FAILURE_ERROR_CODES = frozenset({
    "connect-failed",
    "peer-mismatch",
    "timeout",
    "malformed-response",
    "validation-failed",
})
_CHANNEL_DISPOSITIONS = frozenset({"not-connected", "consumed"})
_CAPTURE_RECORD_NAMES = frozenset({
    CAPTURE_INTENT_RECORD_NAME,
    CAPTURE_FAILURE_RECORD_NAME,
    CAPTURE_SESSION_RECORD_NAME,
    ATTESTATION_COMMIT_RECORD_NAME,
})
_FAULT_CONTROL_RECORD_NAMES = frozenset({
    FAULT_CONTROL_ACTIVE_RECORD_NAME,
    FAULT_CONTROL_CLOSED_RECORD_NAME,
})


class Phase5CandidateAttemptError(RuntimeError):
    """The attempt registry did not prove the required append-only state."""


class _NodeState(NamedTuple):
    dev: int
    ino: int
    mode: int
    uid: int
    gid: int
    nlink: int
    size: int
    mtime_ns: int
    ctime_ns: int
    file_attributes: int


class CandidateAttemptLayout:
    """Live PREPARED attempt and its retained Linux directory authority."""

    __slots__ = (
        "_registry_root",
        "_attempt_directory",
        "_bootstrap_bind_source",
        "_candidate_bind_source",
        "_fault_control_bind_source",
        "_intent_path",
        "_intent_sha256",
        "_anchor_path",
        "_attempt_id",
        "_anchor_fd",
        "_registry_fd",
        "_attempt_fd",
        "_bootstrap_fd",
        "_candidate_fd",
        "_fault_control_fd",
        "_anchor_state",
        "_registry_state",
        "_attempt_state",
        "_bootstrap_state",
        "_candidate_state",
        "_fault_control_state",
        "_intent_state",
        "_authoritative",
        "_closed",
    )

    def __init__(
            self,
            *,
            registry_root: Path,
            attempt_directory: Path,
            bootstrap_bind_source: Path,
            candidate_bind_source: Path,
            fault_control_bind_source: Path,
            intent_path: Path,
            intent_sha256: str,
            anchor_path: Path,
            attempt_id: str,
            anchor_fd: int | None,
            registry_fd: int | None,
            attempt_fd: int | None,
            bootstrap_fd: int | None,
            candidate_fd: int | None,
            fault_control_fd: int | None,
            anchor_state: _NodeState,
            registry_state: _NodeState,
            attempt_state: _NodeState,
            bootstrap_state: _NodeState,
            candidate_state: _NodeState,
            fault_control_state: _NodeState,
            intent_state: _NodeState,
            authoritative: bool) -> None:
        values = {
            "_registry_root": registry_root,
            "_attempt_directory": attempt_directory,
            "_bootstrap_bind_source": bootstrap_bind_source,
            "_candidate_bind_source": candidate_bind_source,
            "_fault_control_bind_source": fault_control_bind_source,
            "_intent_path": intent_path,
            "_intent_sha256": intent_sha256,
            "_anchor_path": anchor_path,
            "_attempt_id": attempt_id,
            "_anchor_fd": anchor_fd,
            "_registry_fd": registry_fd,
            "_attempt_fd": attempt_fd,
            "_bootstrap_fd": bootstrap_fd,
            "_candidate_fd": candidate_fd,
            "_fault_control_fd": fault_control_fd,
            "_anchor_state": anchor_state,
            "_registry_state": registry_state,
            "_attempt_state": attempt_state,
            "_bootstrap_state": bootstrap_state,
            "_candidate_state": candidate_state,
            "_fault_control_state": fault_control_state,
            "_intent_state": intent_state,
            "_authoritative": authoritative,
            "_closed": False,
        }
        for name, value in dict.items(values):
            object.__setattr__(self, name, value)

    def __setattr__(self, _name, _value) -> None:
        raise AttributeError("CandidateAttemptLayout is immutable")

    @property
    def registry_root(self) -> Path:
        return self._registry_root

    @property
    def attempt_directory(self) -> Path:
        return self._attempt_directory

    @property
    def bootstrap_bind_source(self) -> Path:
        return self._bootstrap_bind_source

    @property
    def candidate_bind_source(self) -> Path:
        return self._candidate_bind_source

    @property
    def fault_control_bind_source(self) -> Path:
        return self._fault_control_bind_source

    @property
    def intent_path(self) -> Path:
        return self._intent_path

    @property
    def intent_sha256(self) -> str:
        return self._intent_sha256

    @property
    def authoritative(self) -> bool:
        return self._authoritative

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        if self._closed:
            return
        object.__setattr__(self, "_closed", True)
        for name in (
            "_fault_control_fd",
            "_candidate_fd",
            "_bootstrap_fd",
            "_attempt_fd",
            "_registry_fd",
            "_anchor_fd",
        ):
            descriptor = object.__getattribute__(self, name)
            object.__setattr__(self, name, None)
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def __enter__(self) -> CandidateAttemptLayout:
        if self._closed:
            _fail()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()


class Phase5FaultControlHandle:
    """Live controller-owned listeners for one retained attempt dirfd."""

    __slots__ = (
        "_attempt",
        "_listeners",
        "_socket_states",
        "_connections",
        "_peers",
        "_admissions_sent",
        "_admission_responses",
        "_descriptor",
        "_audio_enabled",
        "_client_capabilities",
        "_capabilities_taken",
        "_request_sequence",
        "_relay_sequence",
        "_audio_command_sequence",
        "_phase",
        "_active_record_sha256",
        "_closed",
    )

    def __init__(
            self,
            attempt: CandidateAttemptLayout,
            listeners: dict[str, socket.socket],
            socket_states: dict[str, _NodeState]) -> None:
        object.__setattr__(self, "_attempt", attempt)
        object.__setattr__(self, "_listeners", listeners)
        object.__setattr__(self, "_socket_states", socket_states)
        object.__setattr__(self, "_connections", {})
        object.__setattr__(self, "_peers", {})
        object.__setattr__(self, "_admissions_sent", set())
        object.__setattr__(self, "_admission_responses", {})
        object.__setattr__(self, "_descriptor", None)
        object.__setattr__(self, "_audio_enabled", False)
        object.__setattr__(self, "_client_capabilities", None)
        object.__setattr__(self, "_capabilities_taken", False)
        object.__setattr__(self, "_request_sequence", 0)
        object.__setattr__(self, "_relay_sequence", 0)
        object.__setattr__(self, "_audio_command_sequence", 0)
        object.__setattr__(self, "_phase", "admitted")
        object.__setattr__(self, "_active_record_sha256", None)
        object.__setattr__(self, "_closed", False)

    def __setattr__(self, _name, _value) -> None:
        raise AttributeError("Phase5FaultControlHandle is immutable")

    @property
    def phase(self) -> str:
        return self._phase

    def _unlink_listener(self, name: str) -> None:
        expected = self._socket_states[name]
        observed = _socket_snapshot_at(
            self._attempt._fault_control_fd,
            name,
        )
        if observed != expected:
            _fail()
        os.unlink(name, dir_fd=self._attempt._fault_control_fd)

    def accept_candidate(
            self,
            *,
            role: str,
            expected_pid: int,
            expected_uid: int,
            timeout_seconds: float = 10.0) -> socket.socket:
        if (
            self._closed
            or self._phase not in {"admitted", "active"}
            or role not in {"runtime", "audio"}
            or role in self._connections
            or type(expected_pid) is not int
            or not 1 <= expected_pid <= 0x7fffffff
            or not _uint32(expected_uid)
            or type(timeout_seconds) not in {int, float}
            or not 0 < timeout_seconds <= 60
            or not hasattr(socket, "SO_PEERCRED")
        ):
            _fail()
        name = (
            RUNTIME_CONTROL_SOCKET_NAME
            if role == "runtime" else AUDIO_CONTROL_SOCKET_NAME
        )
        listener = self._listeners.get(role)
        if type(listener) is not socket.socket:
            _fail()
        connection = None
        try:
            listener.settimeout(float(timeout_seconds))
            connection, _address = listener.accept()
            raw_peer = connection.getsockopt(
                socket.SOL_SOCKET,
                socket.SO_PEERCRED,
                struct.calcsize("3i"),
            )
            peer_pid, peer_uid, _peer_gid = struct.unpack("3i", raw_peer)
            if peer_pid != expected_pid or peer_uid != expected_uid:
                _fail()
            self._unlink_listener(name)
            listener.close()
            self._listeners.pop(role, None)
            self._connections[role] = connection
            self._peers[role] = (peer_pid, peer_uid)
            connection = None
            if set(self._connections) == {"runtime", "audio"}:
                object.__setattr__(self, "_phase", "active")
            return self._connections[role]
        except Phase5CandidateAttemptError:
            raise
        except (OSError, TypeError, ValueError) as exc:
            _fail(exc)
        finally:
            if connection is not None:
                try:
                    connection.close()
                except OSError:
                    pass

    def mark_closed(self) -> None:
        if self._closed or self._phase != "active":
            _fail()
        object.__setattr__(self, "_phase", "closed")

    def send_admission(self, *, role: str, challenge: str) -> None:
        if (
            self._closed
            or role not in self._connections
            or role in self._admissions_sent
            or type(challenge) is not str
            or HEX64.fullmatch(challenge) is None
        ):
            _fail()
        name = (
            RUNTIME_CONTROL_SOCKET_NAME
            if role == "runtime" else AUDIO_CONTROL_SOCKET_NAME
        )
        payload = _canonical({
            "schemaVersion": 1,
            "kind": "phase5-fault-control-admission",
            "role": role,
            "challenge": challenge,
            "socketInode": self._socket_states[name].ino,
        }) + b"\n"
        try:
            self._connections[role].sendall(payload)
        except OSError as exc:
            _fail(exc)
        self._admissions_sent.add(role)

    def _receive_canonical_frame(
            self, role: str, timeout_seconds: float) -> tuple[dict, bytes]:
        if (
            self._closed
            or role not in self._connections
            or type(timeout_seconds) not in {int, float}
            or not 0 < timeout_seconds <= 60
        ):
            _fail()
        connection = self._connections[role]
        value = bytearray()
        try:
            connection.settimeout(float(timeout_seconds))
            while True:
                remaining = MAX_FAULT_CONTROL_RESPONSE_BYTES - len(value)
                if remaining <= 0:
                    _fail()
                chunk = connection.recv(min(65536, remaining))
                if not chunk:
                    _fail()
                value.extend(chunk)
                newline = value.find(b"\n")
                if newline < 0:
                    continue
                if newline != len(value) - 1:
                    _fail()
                raw = bytes(value)
                decoded = _strict_json(raw[:-1])
                if type(decoded) is not dict:
                    _fail()
                return decoded, raw
        except Phase5CandidateAttemptError:
            raise
        except (OSError, TypeError, ValueError) as exc:
            _fail(exc)

    def receive_admission_response(
            self, *, role: str,
            timeout_seconds: float = 10.0) -> object:
        if (
            role not in {"runtime", "audio"}
            or role in self._admission_responses
            or role not in self._admissions_sent
        ):
            _fail()
        value, raw = self._receive_canonical_frame(
            role, timeout_seconds)
        if role == "audio":
            if value != {
                "schemaVersion": 1,
                "kind":
                    "phase5-fault-control-audio-admission-response",
            }:
                _fail()
            result = None
        else:
            if (
                set(value) != {
                    "schemaVersion", "kind", "admission",
                    "descriptor", "clientCapabilities",
                }
                or value["schemaVersion"] != 1
                or value["kind"]
                != "phase5-fault-control-admission-response"
            ):
                _fail()
            admission_state = _node_state(os.stat(
                ADMISSION_RECORD_NAME,
                dir_fd=self._attempt._attempt_fd,
                follow_symlinks=False,
            ))
            admission_record, _admission_raw = _read_record_at(
                self._attempt._attempt_fd,
                ADMISSION_RECORD_NAME,
                expected_state=admission_state,
            )
            capabilities = value["clientCapabilities"]
            descriptor = value["descriptor"]
            if (
                value["admission"] != admission_record["admission"]
                or type(descriptor) is not dict
                or set(descriptor) != {"binding", "window"}
                or descriptor["binding"] != admission_record["identity"]
                or type(descriptor["window"]) is not dict
                or set(descriptor["window"]) != {
                    "startedAtMonotonicMs", "endedAtMonotonicMs",
                    "startedAtUnixMs", "endedAtUnixMs",
                }
                or any(
                    type(descriptor["window"][name]) is not int
                    or descriptor["window"][name] < 0
                    for name in descriptor["window"]
                )
                or descriptor["window"]["endedAtMonotonicMs"]
                    - descriptor["window"]["startedAtMonotonicMs"]
                    != 1_800_000
                or descriptor["window"]["endedAtUnixMs"]
                    - descriptor["window"]["startedAtUnixMs"]
                    != 1_800_000
                or type(capabilities) is not list
                or len(capabilities) != 4
            ):
                _fail()
            identities = set()
            for client, capability in enumerate(capabilities, 1):
                if (
                    type(capability) is not dict
                    or set(capability) != {
                        "client", "clientIdentitySha256",
                        "runtimeCapability", "runtimeGeneration",
                        "audioCapability", "audioGeneration",
                    }
                    or capability["client"] != client
                    or type(capability["clientIdentitySha256"])
                    is not str
                    or HEX64.fullmatch(
                        capability["clientIdentitySha256"]) is None
                    or capability["clientIdentitySha256"] in identities
                    or capability["runtimeGeneration"] != 1
                    or capability["audioGeneration"] != 1
                ):
                    _fail()
                identities.add(capability["clientIdentitySha256"])
                for name in (
                    "runtimeCapability", "audioCapability",
                ):
                    token = capability[name]
                    if (
                        type(token) is not str
                        or re.fullmatch(
                            r"[A-Za-z0-9_-]{43}", token) is None
                    ):
                        _fail()
                    try:
                        decoded = base64.urlsafe_b64decode(token + "=")
                    except (ValueError, TypeError) as exc:
                        _fail(exc)
                    if (
                        len(decoded) != 32
                        or base64.urlsafe_b64encode(decoded)
                        .rstrip(b"=").decode("ascii") != token
                    ):
                        _fail()
            result = tuple(
                _owned_plain_json_tree(item)
                for item in capabilities
            )
            object.__setattr__(self, "_client_capabilities", result)
            object.__setattr__(self, "_descriptor", (
                _owned_plain_json_tree(descriptor)
            ))
        self._admission_responses[role] = hashlib.sha256(
            raw).hexdigest()
        return result

    def enable_audio(
            self, *, challenge: str, signer_spki_sha256: str,
            timeout_seconds: float = 10.0) -> None:
        if (
            self._audio_enabled
            or "audio" not in self._admission_responses
            or type(challenge) is not str
            or HEX64.fullmatch(challenge) is None
            or type(signer_spki_sha256) is not str
            or HEX64.fullmatch(signer_spki_sha256) is None
        ):
            _fail()
        request = _canonical({
            "schemaVersion": 1,
            "kind": "phase5-audio-control-enable",
            "challenge": challenge,
            "signerSpkiSha256": signer_spki_sha256,
        }) + b"\n"
        try:
            self._connections["audio"].sendall(request)
        except (KeyError, OSError) as exc:
            _fail(exc)
        value, raw = self._receive_canonical_frame(
            "audio", timeout_seconds)
        if value != {
            "schemaVersion": 1,
            "kind": "phase5-audio-control-enabled",
        }:
            _fail()
        self._admission_responses["audio-enable"] = hashlib.sha256(
            raw).hexdigest()
        object.__setattr__(self, "_audio_enabled", True)

    def take_client_capabilities(self) -> tuple[dict, ...]:
        if (
            self._closed
            or self._capabilities_taken
            or self._client_capabilities is None
        ):
            _fail()
        object.__setattr__(self, "_capabilities_taken", True)
        return tuple(
            _owned_plain_json_tree(value)
            for value in self._client_capabilities
        )

    def _validate_runtime_instruction(self, value: dict) -> tuple[int, bytes]:
        if (
            type(value) is not dict
            or set(value) != {
                "schemaVersion", "kind", "sequence",
                "actionEventBase64", "runtimeCapability",
            }
            or value["schemaVersion"] != 1
            or value["kind"] != "phase5-fixed-instruction"
            or type(value["sequence"]) is not int
            or value["sequence"] not in _RELAY_ACTIONS
        ):
            _fail()
        action_sequence = value["sequence"]
        expected_event_sequence, operation, target = _RELAY_ACTIONS[
            action_sequence
        ]
        capability = value["runtimeCapability"]
        if (
            (action_sequence in {4, 8})
            != (type(capability) is str)
            or (
                type(capability) is str
                and re.fullmatch(r"[A-Za-z0-9_-]{43}", capability)
                is None
            )
        ):
            _fail()
        encoded = value["actionEventBase64"]
        if type(encoded) is not str:
            _fail()
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            _fail(exc)
        if base64.b64encode(raw).decode("ascii") != encoded:
            _fail()
        event = _strict_json(raw)
        payload = event.get("payload") if type(event) is dict else None
        action = payload.get("action") if type(payload) is dict else None
        receipt = action.get("receipt") if type(action) is dict else None
        if (
            _canonical(event) != raw
            or event.get("sequence") != expected_event_sequence
            or event.get("phase") not in {
                "fault-action", "recovery-action",
            }
            or type(event.get("signature")) is not str
            or type(action) is not dict
            or action.get("operation") != operation
            or action.get("target") != target
            or type(receipt) is not dict
            or receipt.get("actuatorSequence") != action_sequence
        ):
            _fail()
        return action_sequence, raw

    def _execute_audio_instruction(self, action_sequence: int) -> None:
        if action_sequence not in {1, 13}:
            _fail()
        object.__setattr__(
            self,
            "_audio_command_sequence",
            self._audio_command_sequence + 1,
        )
        kind = (
            "phase5-audio-crash-child"
            if action_sequence == 1
            else "phase5-audio-rotate-epoch"
        )
        request = _canonical({
            "schemaVersion": 1,
            "kind": kind,
            "sequence": self._audio_command_sequence,
        }) + b"\n"
        try:
            self._connections["audio"].sendall(request)
        except (KeyError, OSError) as exc:
            _fail(exc)
        value, _raw = self._receive_canonical_frame("audio", 30.0)
        if action_sequence == 1:
            if (
                set(value) != {
                    "schemaVersion", "kind", "sequence",
                    "lastExitedPid", "lastExitSignal", "newPid",
                }
                or value["schemaVersion"] != 1
                or value["kind"]
                != "phase5-audio-crash-child-complete"
                or value["sequence"] != self._audio_command_sequence
                or type(value["lastExitedPid"]) is not int
                or type(value["newPid"]) is not int
                or value["lastExitedPid"] <= 0
                or value["newPid"] <= 0
                or value["lastExitedPid"] == value["newPid"]
                or value["lastExitSignal"] != "SIGKILL"
            ):
                _fail()
            return
        if (
            set(value) != {
                "schemaVersion", "kind", "sequence",
                "beforeAudioEpoch", "afterAudioEpoch",
            }
            or value["schemaVersion"] != 1
            or value["kind"]
            != "phase5-audio-rotate-epoch-complete"
            or value["sequence"] != self._audio_command_sequence
            or type(value["beforeAudioEpoch"]) is not str
            or type(value["afterAudioEpoch"]) is not str
            or value["beforeAudioEpoch"] == value["afterAudioEpoch"]
        ):
            _fail()
        admission_state = _node_state(os.stat(
            ADMISSION_RECORD_NAME,
            dir_fd=self._attempt._attempt_fd,
            follow_symlinks=False,
        ))
        admission, _admission_raw = _read_record_at(
            self._attempt._attempt_fd,
            ADMISSION_RECORD_NAME,
            expected_state=admission_state,
        )
        expected_epoch = "phase5-" + hashlib.sha256(
            b"audio-epoch\0"
            + admission["identity"]["challenge"].encode("ascii")
        ).hexdigest()[:32]
        if value["afterAudioEpoch"] != expected_epoch:
            _fail()

    def advance(
            self, client_instruction) -> bytes:
        if (
            self._closed
            or self._phase != "active"
            or self._active_record_sha256 is None
            or self._request_sequence >= 35
            or not callable(client_instruction)
        ):
            _fail()
        object.__setattr__(
            self, "_request_sequence", self._request_sequence + 1
        )
        request = _canonical({
            "schemaVersion": 1,
            "kind": "phase5-fault-control-advance",
            "sequence": self._request_sequence,
        }) + b"\n"
        try:
            self._connections["runtime"].sendall(request)
        except (KeyError, OSError) as exc:
            _fail(exc)
        while True:
            value, raw = self._receive_canonical_frame("runtime", 60.0)
            if value.get("kind") == "phase5-fixed-instruction":
                action_sequence, action_raw = (
                    self._validate_runtime_instruction(value)
                )
                expected_relay = tuple(_RELAY_ACTIONS)[
                    self._relay_sequence
                ]
                if action_sequence != expected_relay:
                    _fail()
                object.__setattr__(
                    self, "_relay_sequence", self._relay_sequence + 1
                )
                if action_sequence in _CLIENT_RELAY_ACTIONS:
                    if client_instruction(
                            _owned_plain_json_tree(value)) is not True:
                        _fail()
                else:
                    self._execute_audio_instruction(action_sequence)
                completion = _canonical({
                    "schemaVersion": 1,
                    "kind": "phase5-fixed-instruction-complete",
                    "sequence": action_sequence,
                    "actionEventSha256": hashlib.sha256(
                        action_raw
                    ).hexdigest(),
                    "accepted": True,
                }) + b"\n"
                try:
                    self._connections["runtime"].sendall(completion)
                except OSError as exc:
                    _fail(exc)
                continue
            if (
                set(value) != {
                    "schemaVersion", "kind", "sequence", "result",
                }
                or value["schemaVersion"] != 1
                or value["kind"]
                != "phase5-fault-control-advance-response"
                or value["sequence"] != self._request_sequence
                or type(value["result"]) is not dict
                or set(value["result"]) != {"eventBase64"}
            ):
                _fail()
            return raw

    def close_window(self) -> bytes:
        if (
            self._closed
            or self._phase != "active"
            or self._request_sequence != 35
            or self._relay_sequence != len(_RELAY_ACTIONS)
        ):
            _fail()
        object.__setattr__(
            self, "_request_sequence", self._request_sequence + 1
        )
        request = _canonical({
            "schemaVersion": 1,
            "kind": "phase5-fault-control-close-window",
            "sequence": self._request_sequence,
        }) + b"\n"
        try:
            self._connections["runtime"].sendall(request)
        except (KeyError, OSError) as exc:
            _fail(exc)
        value, raw = self._receive_canonical_frame("runtime", 60.0)
        if (
            set(value) != {
                "schemaVersion", "kind", "sequence", "result",
            }
            or value["schemaVersion"] != 1
            or value["kind"]
            != "phase5-fault-control-close-window-response"
            or value["sequence"] != self._request_sequence
            or type(value["result"]) is not dict
            or set(value["result"]) != {"faultEventsBase64"}
        ):
            _fail()
        return raw

    @staticmethod
    def _receive_controller_session_frame(
            connection: socket.socket,
            max_bytes: int) -> tuple[dict, bytes]:
        if (
            type(connection) is not socket.socket
            or type(max_bytes) is not int
            or not 1 <= max_bytes <= MAX_FAULT_CONTROL_RESPONSE_BYTES
        ):
            _fail()
        value = bytearray()
        try:
            connection.settimeout(60.0)
            while True:
                remaining = max_bytes - len(value)
                if remaining <= 0:
                    _fail()
                chunk = connection.recv(min(65536, remaining))
                if not chunk:
                    _fail()
                value.extend(chunk)
                newline = value.find(b"\n")
                if newline < 0:
                    continue
                if newline != len(value) - 1:
                    _fail()
                raw = bytes(value)
                decoded = _strict_json(raw[:-1])
                if type(decoded) is not dict:
                    _fail()
                return decoded, raw
        except Phase5CandidateAttemptError:
            raise
        except (OSError, TypeError, ValueError) as exc:
            _fail(exc)

    def serve_controller_session(
            self, connection: socket.socket) -> bytes:
        if (
            self._closed
            or self._phase != "active"
            or self._active_record_sha256 is None
            or type(connection) is not socket.socket
        ):
            _fail()
        capabilities = self.take_client_capabilities()
        admission_state = _node_state(os.stat(
            ADMISSION_RECORD_NAME,
            dir_fd=self._attempt._attempt_fd,
            follow_symlinks=False,
        ))
        admission, _raw = _read_record_at(
            self._attempt._attempt_fd,
            ADMISSION_RECORD_NAME,
            expected_state=admission_state,
        )
        descriptor = self._descriptor
        if type(descriptor) is not dict:
            _fail()
        hello = _canonical({
            "schemaVersion": 1,
            "kind": "phase5-controller-session-admission",
            "descriptor": descriptor,
            "clientCapabilities": list(capabilities),
        }) + b"\n"
        try:
            connection.sendall(hello)
        except OSError as exc:
            _fail(exc)

        def client_instruction(instruction: dict) -> bool:
            instruction_raw = _canonical(instruction) + b"\n"
            try:
                connection.sendall(instruction_raw)
            except OSError as exc:
                _fail(exc)
            completion, _completion_raw = (
                self._receive_controller_session_frame(
                    connection, MAX_ADMISSION_BYTES
                )
            )
            try:
                action_raw = base64.b64decode(
                    instruction["actionEventBase64"], validate=True
                )
            except (KeyError, TypeError, ValueError) as exc:
                _fail(exc)
            if completion != {
                "schemaVersion": 1,
                "kind": "phase5-fixed-instruction-complete",
                "sequence": instruction["sequence"],
                "actionEventSha256": hashlib.sha256(
                    action_raw
                ).hexdigest(),
                "accepted": True,
            }:
                _fail()
            return True

        for expected_sequence in range(1, 36):
            request, request_raw = self._receive_controller_session_frame(
                connection, MAX_ADMISSION_BYTES
            )
            if request != {
                "schemaVersion": 1,
                "kind": "phase5-fault-control-advance",
                "sequence": expected_sequence,
            } or request_raw != _canonical(request) + b"\n":
                _fail()
            response = self.advance(client_instruction)
            try:
                connection.sendall(response)
            except OSError as exc:
                _fail(exc)
        request, request_raw = self._receive_controller_session_frame(
            connection, MAX_ADMISSION_BYTES
        )
        if request != {
            "schemaVersion": 1,
            "kind": "phase5-fault-control-close-window",
            "sequence": 36,
        } or request_raw != _canonical(request) + b"\n":
            _fail()
        response = self.close_window()
        try:
            connection.sendall(response)
        except OSError as exc:
            _fail(exc)
        value = _strict_json(response[:-1])
        try:
            encoded = value["result"]["faultEventsBase64"]
            fault_events = base64.b64decode(encoded, validate=True)
        except (KeyError, TypeError, ValueError) as exc:
            _fail(exc)
        if base64.b64encode(fault_events).decode("ascii") != encoded:
            _fail()
        return fault_events

    def close(self) -> None:
        if self._closed:
            return
        object.__setattr__(self, "_closed", True)
        errors = []
        for connection in tuple(self._connections.values()):
            try:
                connection.close()
            except OSError as exc:
                errors.append(exc)
        self._connections.clear()
        for role, listener in tuple(self._listeners.items()):
            name = (
                RUNTIME_CONTROL_SOCKET_NAME
                if role == "runtime" else AUDIO_CONTROL_SOCKET_NAME
            )
            try:
                self._unlink_listener(name)
            except Phase5CandidateAttemptError as exc:
                errors.append(exc)
            try:
                listener.close()
            except OSError as exc:
                errors.append(exc)
        self._listeners.clear()
        if errors:
            _fail(errors[0])

    def __enter__(self) -> Phase5FaultControlHandle:
        if self._closed:
            _fail()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()


class _HeldRecord(NamedTuple):
    descriptor: int
    state: _NodeState
    raw: bytes
    value: dict
    sha256: str


class HeldAttempt:
    """Live fd-held authority for one uniquely admitted attempt."""

    __slots__ = (
        "_registry_root",
        "_attempt_directory",
        "_bootstrap_bind_source",
        "_candidate_bind_source",
        "_fault_control_bind_source",
        "_anchor_path",
        "_attempt_id",
        "_anchor_fd",
        "_registry_fd",
        "_attempt_fd",
        "_bootstrap_fd",
        "_candidate_fd",
        "_fault_control_fd",
        "_anchor_state",
        "_registry_state",
        "_attempt_state",
        "_bootstrap_state",
        "_candidate_state",
        "_fault_control_state",
        "_records",
        "_capture_armed_live",
        "_closed",
    )

    def __init__(
            self,
            *,
            registry_root: Path,
            attempt_id: str,
            anchor_fd: int,
            registry_fd: int,
            attempt_fd: int,
            bootstrap_fd: int,
            candidate_fd: int,
            fault_control_fd: int,
            anchor_state: _NodeState,
            registry_state: _NodeState,
            attempt_state: _NodeState,
            bootstrap_state: _NodeState,
            candidate_state: _NodeState,
            fault_control_state: _NodeState,
            records: dict[str, _HeldRecord]) -> None:
        attempt_directory = registry_root / attempt_id
        values = {
            "_registry_root": registry_root,
            "_attempt_directory": attempt_directory,
            "_bootstrap_bind_source": (
                attempt_directory / BOOTSTRAP_BIND_SOURCE_NAME
            ),
            "_candidate_bind_source": (
                attempt_directory / CANDIDATE_BIND_SOURCE_NAME
            ),
            "_fault_control_bind_source": (
                attempt_directory / FAULT_CONTROL_BIND_SOURCE_NAME
            ),
            "_anchor_path": registry_root.parent,
            "_attempt_id": attempt_id,
            "_anchor_fd": anchor_fd,
            "_registry_fd": registry_fd,
            "_attempt_fd": attempt_fd,
            "_bootstrap_fd": bootstrap_fd,
            "_candidate_fd": candidate_fd,
            "_fault_control_fd": fault_control_fd,
            "_anchor_state": anchor_state,
            "_registry_state": registry_state,
            "_attempt_state": attempt_state,
            "_bootstrap_state": bootstrap_state,
            "_candidate_state": candidate_state,
            "_fault_control_state": fault_control_state,
            "_records": records,
            "_capture_armed_live": False,
            "_closed": False,
        }
        for name, value in dict.items(values):
            object.__setattr__(self, name, value)

    def __setattr__(self, _name, _value) -> None:
        raise AttributeError("HeldAttempt is immutable")

    @property
    def attempt_id(self) -> str:
        return self._attempt_id

    @property
    def attempt_directory(self) -> Path:
        return self._attempt_directory

    @property
    def candidate_bind_source(self) -> Path:
        return self._candidate_bind_source

    @property
    def fault_control_bind_source(self) -> Path:
        return self._fault_control_bind_source

    @property
    def intent_sha256(self) -> str:
        return self._records[INTENT_RECORD_NAME].sha256

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        if self._closed:
            return
        object.__setattr__(self, "_closed", True)
        descriptors = [
            record.descriptor
            for record in dict.values(self._records)
        ]
        self._records.clear()
        for name in (
            "_fault_control_fd",
            "_candidate_fd",
            "_bootstrap_fd",
            "_attempt_fd",
            "_registry_fd",
            "_anchor_fd",
        ):
            descriptor = object.__getattribute__(self, name)
            object.__setattr__(self, name, None)
            if descriptor is not None:
                descriptors.append(descriptor)
        _close_descriptors_noexcept(descriptors)

    def __enter__(self) -> HeldAttempt:
        if self._closed:
            _fail()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()


class CommittedAdmission(NamedTuple):
    path: Path
    record_sha256: str
    admission_sha256: str


class AppendedAttemptRecord(NamedTuple):
    path: Path
    record_sha256: str


class Phase5CaptureState(NamedTuple):
    phase: str
    fault_control_phase: str
    capture_intent_sha256: str | None
    session_sha256: str | None
    commit_sha256: str | None
    error_code: str | None
    channel_disposition: str | None
    intent_raw: bytes
    admission_record_raw: bytes
    capture_intent_raw: bytes | None
    capture_failure_raw: bytes | None
    session_raw: bytes | None
    attestation_commit_raw: bytes | None


def _fail(exc: BaseException | None = None) -> None:
    error = Phase5CandidateAttemptError(
        "PHASE5_CANDIDATE_ATTEMPT_REQUIRED"
    )
    if exc is None:
        raise error
    raise error from exc


def require_linux_attempt_authority() -> None:
    """Reject any attempt to treat a pure non-Linux run as authority."""
    if not LINUX_AUTHORITY_AVAILABLE:
        raise Phase5CandidateAttemptError(
            "PHASE5_CANDIDATE_ATTEMPT_LINUX_AUTHORITY_REQUIRED"
        )


def _owned_plain_json_tree(value: object) -> object:
    """Copy exact JSON containers without invoking subclass hooks."""
    value_type = type(value)
    if value_type is dict:
        owned = {}
        for key, member in dict.items(value):
            if type(key) is not str:
                _fail()
            owned[key] = _owned_plain_json_tree(member)
        return owned
    if value_type is list:
        return [
            _owned_plain_json_tree(member)
            for member in list.__iter__(value)
        ]
    if value_type in (str, int, bool, type(None)):
        return value
    _fail()


def _canonical(value: object) -> bytes:
    try:
        owned = _owned_plain_json_tree(value)
        return json.dumps(
            owned,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except Phase5CandidateAttemptError:
        raise
    except (
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _reject_duplicate_members(pairs):
    value = {}
    for key, member in pairs:
        if key in value:
            raise ValueError("duplicate JSON member")
        value[key] = member
    return value


def _strict_json(raw: bytes) -> object:
    try:
        if type(raw) is not bytes or raw.startswith(b"\xef\xbb\xbf"):
            _fail()
        text = raw.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_members,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ValueError("non-finite JSON")
            ),
        )
        if _canonical(value) != raw:
            _fail()
        return value
    except Phase5CandidateAttemptError:
        raise
    except (
        AttributeError,
        json.JSONDecodeError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _is_link_or_reparse(value: os.stat_result) -> bool:
    return (
        stat.S_ISLNK(value.st_mode)
        or bool(
            getattr(value, "st_file_attributes", 0)
            & _REPARSE_POINT
        )
    )


def _node_state(value: os.stat_result) -> _NodeState:
    return _NodeState(
        dev=value.st_dev,
        ino=value.st_ino,
        mode=value.st_mode,
        uid=value.st_uid,
        gid=value.st_gid,
        nlink=value.st_nlink,
        size=value.st_size,
        mtime_ns=value.st_mtime_ns,
        ctime_ns=value.st_ctime_ns,
        file_attributes=getattr(value, "st_file_attributes", 0),
    )


def _capture_socket_record(value: _NodeState) -> dict:
    return {
        "device": value.dev,
        "inode": value.ino,
        "type": "socket",
        "mode": stat.S_IMODE(value.mode),
        "uid": value.uid,
        "gid": value.gid,
        "nlink": value.nlink,
    }


def _fault_control_mount_identity(value: _NodeState) -> dict:
    return {
        "device": value.dev,
        "inode": value.ino,
        "type": "directory",
        "mode": stat.S_IMODE(value.mode),
        "uid": value.uid,
        "gid": value.gid,
        "nlink": value.nlink,
    }


def _fault_control_socket_snapshot(value: _NodeState) -> dict:
    return _capture_socket_record(value)


def _fault_control_inventory(
        states: tuple[_NodeState, _NodeState]) -> dict:
    runtime_state, audio_state = states
    return {
        RUNTIME_CONTROL_SOCKET_NAME:
            _fault_control_socket_snapshot(runtime_state),
        AUDIO_CONTROL_SOCKET_NAME:
            _fault_control_socket_snapshot(audio_state),
    }


def _same_object(
        left: os.stat_result,
        right: os.stat_result) -> bool:
    return _node_state(left) == _node_state(right)


def _same_identity(
        left: os.stat_result | _NodeState,
        right: os.stat_result | _NodeState) -> bool:
    left_identity = (
        (left.dev, left.ino)
        if type(left) is _NodeState
        else (left.st_dev, left.st_ino)
    )
    right_identity = (
        (right.dev, right.ino)
        if type(right) is _NodeState
        else (right.st_dev, right.st_ino)
    )
    return left_identity == right_identity


def _close_descriptors_noexcept(
        descriptors: list[int]) -> BaseException | None:
    first_error = None
    while descriptors:
        descriptor = descriptors.pop()
        try:
            os.close(descriptor)
        except OSError as exc:
            if first_error is None:
                first_error = exc
    return first_error


def _absolute_path(value: object) -> Path:
    try:
        if type(value) is not _NATIVE_PATH_TYPE:
            _fail()
        raw = str(value)
        path = Path(raw)
        if (
            type(raw) is not str
            or not raw
            or "\0" in raw
            or not path.is_absolute()
            or ".." in path.parts
            or path != Path(os.path.normpath(raw))
            or path.parent == path
        ):
            _fail()
        return path
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, UnicodeError, ValueError) as exc:
        _fail(exc)


def _uint32(value: object) -> bool:
    return type(value) is int and 0 <= value <= 0xffffffff


def _exact_object(value: object, fields: set[str]) -> bool:
    return (
        type(value) is dict
        and all(type(key) is str for key in dict.keys(value))
        and set(dict.keys(value)) == fields
    )


def _validate_directory_state(
        value: os.stat_result,
        *,
        private: bool) -> None:
    if (
        _is_link_or_reparse(value)
        or not stat.S_ISDIR(value.st_mode)
        or type(value.st_nlink) is not int
        or value.st_nlink < 1
        or type(value.st_ctime_ns) is not int
        or value.st_ctime_ns < 0
    ):
        _fail()
    if not LINUX_AUTHORITY_AVAILABLE:
        return
    if value.st_uid < 0 or value.st_gid < 0:
        _fail()
    mode = stat.S_IMODE(value.st_mode)
    effective_uid = os.geteuid()
    effective_gid = os.getegid()
    if private:
        if (
            value.st_uid != effective_uid
            or value.st_gid != effective_gid
            or mode != 0o700
        ):
            _fail()
        return
    if value.st_uid == effective_uid:
        if value.st_gid != effective_gid:
            _fail()
    elif value.st_uid == 0:
        if value.st_gid != 0:
            _fail()
    else:
        _fail()
    if mode & 0o022 and not (
        value.st_uid == 0 and mode & stat.S_ISVTX
    ):
        _fail()


def _same_secure_directory(
        left: os.stat_result,
        right: os.stat_result,
        *,
        private: bool) -> bool:
    """Compare directory identity after validating both live observations."""
    _validate_directory_state(left, private=private)
    _validate_directory_state(right, private=private)
    return _same_identity(left, right)


def _validate_file_state(value: os.stat_result) -> None:
    if (
        _is_link_or_reparse(value)
        or not stat.S_ISREG(value.st_mode)
        or value.st_nlink != 1
        or type(value.st_ctime_ns) is not int
        or value.st_ctime_ns < 0
    ):
        _fail()
    if LINUX_AUTHORITY_AVAILABLE and (
        value.st_uid != os.geteuid()
        or value.st_gid != os.getegid()
        or stat.S_IMODE(value.st_mode) != 0o400
    ):
        _fail()


def _validate_capture_socket_state(value: os.stat_result) -> None:
    if (
        _is_link_or_reparse(value)
        or not stat.S_ISSOCK(value.st_mode)
        or stat.S_IMODE(value.st_mode) != 0o600
        or value.st_uid != os.geteuid()
        or value.st_gid != os.getegid()
        or value.st_nlink != 1
        or type(value.st_ctime_ns) is not int
        or value.st_ctime_ns < 0
    ):
        _fail()


def _socket_snapshot_at(directory_fd: int, name: str) -> _NodeState:
    descriptor = None
    try:
        if (
            not hasattr(os, "O_PATH")
            or name not in {
                CAPTURE_SOCKET_NAME,
                RUNTIME_CONTROL_SOCKET_NAME,
                AUDIO_CONTROL_SOCKET_NAME,
            }
        ):
            _fail()
        before = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        _validate_capture_socket_state(before)
        descriptor = os.open(
            name,
            (
                os.O_PATH
                | getattr(os, "O_NOFOLLOW", 0)
                | getattr(os, "O_CLOEXEC", 0)
            ),
            dir_fd=directory_fd,
        )
        opened = os.fstat(descriptor)
        after = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        _validate_capture_socket_state(opened)
        _validate_capture_socket_state(after)
        if (
            not _same_object(before, opened)
            or not _same_object(opened, after)
        ):
            _fail()
        return _node_state(opened)
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)
    finally:
        if descriptor is not None:
            _close_descriptors_noexcept([descriptor])


def _capture_socket_snapshot_at(candidate_fd: int) -> _NodeState:
    return _socket_snapshot_at(candidate_fd, CAPTURE_SOCKET_NAME)


def _assert_existing_ancestors_not_links(path: Path) -> None:
    """Non-authoritative pathname guard used only by the Windows branch."""
    try:
        for candidate in reversed((path, *path.parents)):
            try:
                value = candidate.lstat()
            except FileNotFoundError:
                continue
            if _is_link_or_reparse(value):
                _fail()
            if candidate != path and not stat.S_ISDIR(value.st_mode):
                _fail()
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _verified_path_directory(
        path: Path,
        *,
        private: bool) -> os.stat_result:
    try:
        value = path.lstat()
        _validate_directory_state(value, private=private)
        return value
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _create_private_directory_path(path: Path) -> os.stat_result:
    try:
        _assert_existing_ancestors_not_links(path.parent)
        os.mkdir(path, 0o700)
        os.chmod(path, 0o700)
        return _verified_path_directory(path, private=True)
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _ensure_private_registry_root_path(path: Path) -> os.stat_result:
    _assert_existing_ancestors_not_links(path)
    try:
        path.lstat()
    except FileNotFoundError:
        return _create_private_directory_path(path)
    except OSError as exc:
        _fail(exc)
    return _verified_path_directory(path, private=True)


def _write_record_path(path: Path, value: object) -> tuple[bytes, _NodeState]:
    descriptor = None
    try:
        raw = _canonical(value)
        if len(raw) > MAX_RECORD_BYTES:
            _fail()
        _verified_path_directory(path.parent, private=True)
        descriptor = os.open(path, RECORD_OPEN_FLAGS, 0o400)
        os.fchmod(descriptor, 0o400)
        written = 0
        while written < len(raw):
            count = os.write(descriptor, raw[written:])
            if count <= 0:
                raise OSError("short attempt record write")
            written += count
        os.fsync(descriptor)
        state = os.fstat(descriptor)
        _validate_file_state(state)
        if state.st_size != len(raw):
            _fail()
        current = path.lstat()
        if not _same_object(state, current):
            _fail()
        return raw, _node_state(state)
    except Phase5CandidateAttemptError:
        raise
    except (
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_record_path(
        path: Path,
        *,
        expected_state: _NodeState) -> tuple[dict, bytes]:
    descriptor = None
    try:
        link_state = path.lstat()
        _validate_file_state(link_state)
        if (
            _node_state(link_state) != expected_state
            or link_state.st_size > MAX_RECORD_BYTES
        ):
            _fail()
        descriptor = os.open(path, READ_OPEN_FLAGS)
        before = os.fstat(descriptor)
        if not _same_object(link_state, before):
            _fail()
        raw = _read_bounded_record(descriptor)
        after = os.fstat(descriptor)
        current = path.lstat()
        if (
            not _same_object(before, after)
            or not _same_object(after, current)
        ):
            _fail()
        value = _strict_json(raw)
        if type(value) is not dict:
            _fail()
        return value, raw
    except Phase5CandidateAttemptError:
        raise
    except (
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_bounded_record(descriptor: int) -> bytes:
    return _read_bounded_bytes(descriptor, MAX_RECORD_BYTES)


def _read_bounded_bytes(descriptor: int, maximum: int) -> bytes:
    buffer = bytearray()
    while True:
        chunk = os.read(
            descriptor,
            min(64 * 1024, maximum - len(buffer) + 1),
        )
        if not chunk:
            break
        buffer.extend(chunk)
        if len(buffer) > maximum:
            _fail()
    return bytes(buffer)


def _open_record_snapshot_at(
        directory_fd: int,
        name: str,
        *,
        maximum: int = MAX_RECORD_BYTES) -> _HeldRecord:
    descriptor = None
    try:
        before = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        _validate_file_state(before)
        if before.st_size > maximum:
            _fail()
        descriptor = os.open(
            name,
            READ_OPEN_FLAGS,
            dir_fd=directory_fd,
        )
        opened_before = os.fstat(descriptor)
        if not _same_object(before, opened_before):
            _fail()
        raw = _read_bounded_bytes(descriptor, maximum)
        opened_after = os.fstat(descriptor)
        after = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if (
            not _same_object(opened_before, opened_after)
            or not _same_object(opened_after, after)
            or opened_after.st_size != len(raw)
        ):
            _fail()
        value = _strict_json(raw)
        if type(value) is not dict:
            _fail()
        result = _HeldRecord(
            descriptor=descriptor,
            state=_node_state(opened_after),
            raw=raw,
            value=value,
            sha256=hashlib.sha256(raw).hexdigest(),
        )
        descriptor = None
        return result
    except Phase5CandidateAttemptError:
        raise
    except (
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
    finally:
        if descriptor is not None:
            _close_descriptors_noexcept([descriptor])


def _verify_record_snapshot_at(
        directory_fd: int,
        name: str,
        record: _HeldRecord,
        *,
        maximum: int = MAX_RECORD_BYTES) -> None:
    try:
        opened_before = os.fstat(record.descriptor)
        current_before = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        _validate_file_state(opened_before)
        _validate_file_state(current_before)
        if (
            _node_state(opened_before) != record.state
            or not _same_object(opened_before, current_before)
        ):
            _fail()
        os.lseek(record.descriptor, 0, os.SEEK_SET)
        raw = _read_bounded_bytes(record.descriptor, maximum)
        opened_after = os.fstat(record.descriptor)
        current_after = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if (
            raw != record.raw
            or _canonical(record.value) != record.raw
            or hashlib.sha256(raw).hexdigest() != record.sha256
            or not _same_object(opened_before, opened_after)
            or not _same_object(opened_after, current_after)
        ):
            _fail()
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _open_trusted_anchor(path: Path) -> tuple[int, _NodeState]:
    """Open an absolute path one safe component at a time."""
    opened_descriptors = []
    try:
        parts = path.parts
        if not parts or parts[0] != path.anchor:
            _fail()
        current_fd = os.open(path.anchor, DIRECTORY_OPEN_FLAGS)
        opened_descriptors.append(current_fd)
        root_before = os.stat(path.anchor, follow_symlinks=False)
        root_opened = os.fstat(current_fd)
        root_after = os.stat(path.anchor, follow_symlinks=False)
        if (
            not _same_secure_directory(
                root_before,
                root_opened,
                private=False,
            )
            or not _same_secure_directory(
                root_opened,
                root_after,
                private=False,
            )
        ):
            _fail()
        for index, component in enumerate(parts[1:], start=1):
            if (
                type(component) is not str
                or not component
                or component in (".", "..")
                or "/" in component
                or "\0" in component
            ):
                _fail()
            before = os.stat(
                component,
                dir_fd=current_fd,
                follow_symlinks=False,
            )
            child_fd = os.open(
                component,
                DIRECTORY_OPEN_FLAGS,
                dir_fd=current_fd,
            )
            opened_descriptors.append(child_fd)
            opened = os.fstat(child_fd)
            after = os.stat(
                component,
                dir_fd=current_fd,
                follow_symlinks=False,
            )
            private = index == len(parts) - 1
            if (
                not _same_secure_directory(
                    before,
                    opened,
                    private=private,
                )
                or not _same_secure_directory(
                    opened,
                    after,
                    private=private,
                )
            ):
                _fail()
            current_fd = child_fd
        final = os.fstat(current_fd)
        _validate_directory_state(final, private=True)
        result_fd = opened_descriptors.pop()
        close_error = _close_descriptors_noexcept(
            opened_descriptors
        )
        if close_error is not None:
            _close_descriptors_noexcept([result_fd])
            _fail(close_error)
        return result_fd, _node_state(final)
    except Phase5CandidateAttemptError:
        _close_descriptors_noexcept(opened_descriptors)
        raise
    except (OSError, TypeError, ValueError) as exc:
        _close_descriptors_noexcept(opened_descriptors)
        _fail(exc)


def _open_owned_directory_at(
        parent_fd: int,
        name: str) -> tuple[int, _NodeState]:
    child_fd = None
    try:
        before = os.stat(
            name,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        child_fd = os.open(
            name,
            DIRECTORY_OPEN_FLAGS,
            dir_fd=parent_fd,
        )
        opened = os.fstat(child_fd)
        after = os.stat(
            name,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if (
            not _same_secure_directory(
                before,
                opened,
                private=True,
            )
            or not _same_secure_directory(
                opened,
                after,
                private=True,
            )
        ):
            _fail()
        result_fd = child_fd
        child_fd = None
        return result_fd, _node_state(opened)
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)
    finally:
        if child_fd is not None:
            os.close(child_fd)


def _mkdir_owned_directory_at(
        parent_fd: int,
        name: str) -> tuple[int, _NodeState]:
    child_fd = None
    try:
        if (
            type(name) is not str
            or not name
            or name in (".", "..")
            or "/" in name
            or "\0" in name
        ):
            _fail()
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        child_fd = os.open(
            name,
            DIRECTORY_OPEN_FLAGS,
            dir_fd=parent_fd,
        )
        os.fchmod(child_fd, 0o700)
        opened = os.fstat(child_fd)
        current = os.stat(
            name,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if not _same_secure_directory(
            opened,
            current,
            private=True,
        ):
            _fail()
        os.fsync(child_fd)
        os.fsync(parent_fd)
        opened = os.fstat(child_fd)
        current = os.stat(
            name,
            dir_fd=parent_fd,
            follow_symlinks=False,
        )
        if not _same_secure_directory(
            opened,
            current,
            private=True,
        ):
            _fail()
        result_fd = child_fd
        child_fd = None
        return result_fd, _node_state(opened)
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)
    finally:
        if child_fd is not None:
            os.close(child_fd)


def _open_or_create_registry_at(
        anchor_fd: int,
        name: str) -> tuple[int, _NodeState]:
    try:
        os.stat(name, dir_fd=anchor_fd, follow_symlinks=False)
    except FileNotFoundError:
        return _mkdir_owned_directory_at(anchor_fd, name)
    except OSError as exc:
        _fail(exc)
    return _open_owned_directory_at(anchor_fd, name)


def _write_record_at(
        directory_fd: int,
        name: str,
        value: object) -> tuple[bytes, _NodeState, int]:
    descriptor = None
    try:
        raw = _canonical(value)
        if len(raw) > MAX_RECORD_BYTES:
            _fail()
        descriptor = os.open(
            name,
            RECORD_OPEN_FLAGS,
            0o400,
            dir_fd=directory_fd,
        )
        os.fchmod(descriptor, 0o400)
        written = 0
        while written < len(raw):
            count = os.write(descriptor, raw[written:])
            if count <= 0:
                raise OSError("short attempt record write")
            written += count
        os.fsync(descriptor)
        opened = os.fstat(descriptor)
        current = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        _validate_file_state(opened)
        if (
            opened.st_size != len(raw)
            or not _same_object(opened, current)
        ):
            _fail()
        os.fsync(directory_fd)
        opened = os.fstat(descriptor)
        current = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if not _same_object(opened, current):
            _fail()
        result_fd = descriptor
        descriptor = None
        return raw, _node_state(opened), result_fd
    except Phase5CandidateAttemptError:
        raise
    except (
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _write_raw_record_at(
        directory_fd: int,
        name: str,
        raw: bytes,
        *,
        maximum: int) -> tuple[bytes, _NodeState, int]:
    descriptor = None
    try:
        if (
            type(raw) is not bytes
            or not raw
            or len(raw) > maximum
        ):
            _fail()
        descriptor = os.open(
            name,
            RECORD_OPEN_FLAGS,
            0o400,
            dir_fd=directory_fd,
        )
        os.fchmod(descriptor, 0o400)
        written = 0
        while written < len(raw):
            count = os.write(descriptor, raw[written:])
            if count <= 0:
                raise OSError("short attempt raw record write")
            written += count
        os.fsync(descriptor)
        opened = os.fstat(descriptor)
        current = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        _validate_file_state(opened)
        if (
            opened.st_size != len(raw)
            or not _same_object(opened, current)
        ):
            _fail()
        os.fsync(directory_fd)
        opened = os.fstat(descriptor)
        current = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if not _same_object(opened, current):
            _fail()
        result_fd = descriptor
        descriptor = None
        return bytes(raw), _node_state(opened), result_fd
    except Phase5CandidateAttemptError:
        raise
    except (
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
    finally:
        if descriptor is not None:
            _close_descriptors_noexcept([descriptor])


def _read_record_at(
        directory_fd: int,
        name: str,
        *,
        expected_state: _NodeState) -> tuple[dict, bytes]:
    descriptor = None
    try:
        link_state = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        _validate_file_state(link_state)
        if (
            _node_state(link_state) != expected_state
            or link_state.st_size > MAX_RECORD_BYTES
        ):
            _fail()
        descriptor = os.open(
            name,
            READ_OPEN_FLAGS,
            dir_fd=directory_fd,
        )
        before = os.fstat(descriptor)
        if not _same_object(link_state, before):
            _fail()
        raw = _read_bounded_record(descriptor)
        after = os.fstat(descriptor)
        current = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        if (
            not _same_object(before, after)
            or not _same_object(after, current)
        ):
            _fail()
        value = _strict_json(raw)
        if type(value) is not dict:
            _fail()
        return value, raw
    except Phase5CandidateAttemptError:
        raise
    except (
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _verify_held_record_at(
        directory_fd: int,
        name: str,
        descriptor: int,
        expected_state: _NodeState) -> None:
    try:
        opened = os.fstat(descriptor)
        current = os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        )
        _validate_file_state(opened)
        if (
            _node_state(opened) != expected_state
            or not _same_object(opened, current)
        ):
            _fail()
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _inventory_at(
        attempt_fd: int,
        *,
        bootstrap_state: _NodeState,
        candidate_state: _NodeState,
        fault_control_state: _NodeState,
        intent_state: _NodeState,
        admission_state: _NodeState | None,
        fault_control_active_state: _NodeState | None = None,
        fault_control_closed_state: _NodeState | None = None) -> None:
    expected = {
        INTENT_RECORD_NAME: ("file", intent_state),
        BOOTSTRAP_BIND_SOURCE_NAME: (
            "directory",
            bootstrap_state,
        ),
        CANDIDATE_BIND_SOURCE_NAME: (
            "directory",
            candidate_state,
        ),
        FAULT_CONTROL_BIND_SOURCE_NAME: (
            "directory",
            fault_control_state,
        ),
    }
    if admission_state is not None:
        expected[ADMISSION_RECORD_NAME] = ("file", admission_state)
    if fault_control_active_state is not None:
        expected[FAULT_CONTROL_ACTIVE_RECORD_NAME] = (
            "file", fault_control_active_state)
    if fault_control_closed_state is not None:
        expected[FAULT_CONTROL_CLOSED_RECORD_NAME] = (
            "file", fault_control_closed_state)
    try:
        with os.scandir(attempt_fd) as iterator:
            entries = {entry.name: entry for entry in iterator}
        if set(entries) != set(expected):
            _fail()
        for name, (kind, frozen) in dict.items(expected):
            current = entries[name].stat(follow_symlinks=False)
            if kind == "directory":
                _validate_directory_state(current, private=True)
                if not _same_identity(current, frozen):
                    _fail()
            else:
                _validate_file_state(current)
                if _node_state(current) != frozen:
                    _fail()
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _inventory_path(
        attempt_directory: Path,
        *,
        bootstrap_state: _NodeState,
        candidate_state: _NodeState,
        fault_control_state: _NodeState,
        intent_state: _NodeState,
        admission_state: _NodeState | None) -> None:
    expected = {
        INTENT_RECORD_NAME: ("file", intent_state),
        BOOTSTRAP_BIND_SOURCE_NAME: (
            "directory",
            bootstrap_state,
        ),
        CANDIDATE_BIND_SOURCE_NAME: (
            "directory",
            candidate_state,
        ),
        FAULT_CONTROL_BIND_SOURCE_NAME: (
            "directory",
            fault_control_state,
        ),
    }
    if admission_state is not None:
        expected[ADMISSION_RECORD_NAME] = ("file", admission_state)
    try:
        entries = {
            entry.name: entry
            for entry in os.scandir(attempt_directory)
        }
        if set(entries) != set(expected):
            _fail()
        for name, (kind, frozen) in dict.items(expected):
            current = (attempt_directory / name).lstat()
            if kind == "directory":
                _validate_directory_state(current, private=True)
                if not _same_identity(current, frozen):
                    _fail()
            else:
                _validate_file_state(current)
                if _node_state(current) != frozen:
                    _fail()
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _validate_runtime_bind_inventory(
        value: CandidateAttemptLayout,
        *,
        expected_capture_state: _NodeState | None = None) -> _NodeState:
    """Validate the post-bootstrap socket state through held bind dirfds."""
    try:
        if (
            type(value._bootstrap_fd) is not int
            or type(value._candidate_fd) is not int
        ):
            _fail()
        with os.scandir(value._bootstrap_fd) as iterator:
            if any(True for _entry in iterator):
                _fail()
        with os.scandir(value._candidate_fd) as iterator:
            entries = {entry.name for entry in iterator}
        if set(entries) != {CAPTURE_SOCKET_NAME}:
            _fail()
        observed = _capture_socket_snapshot_at(value._candidate_fd)
        if (
            expected_capture_state is not None
            and observed != expected_capture_state
        ):
            _fail()
        return observed
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _validate_fault_control_bind_inventory(
        value: CandidateAttemptLayout,
        *,
        expected: tuple[_NodeState, _NodeState] | None = None,
        allow_empty: bool = False) -> tuple[_NodeState, _NodeState] | None:
    """Validate the independent controller-owned control namespace."""
    try:
        if type(value._fault_control_fd) is not int:
            _fail()
        with os.scandir(value._fault_control_fd) as iterator:
            entries = {entry.name for entry in iterator}
        if allow_empty and not entries:
            if expected is not None:
                _fail()
            return None
        if entries != {
            RUNTIME_CONTROL_SOCKET_NAME,
            AUDIO_CONTROL_SOCKET_NAME,
        }:
            _fail()
        observed = (
            _socket_snapshot_at(
                value._fault_control_fd,
                RUNTIME_CONTROL_SOCKET_NAME,
            ),
            _socket_snapshot_at(
                value._fault_control_fd,
                AUDIO_CONTROL_SOCKET_NAME,
            ),
        )
        if expected is not None and observed != expected:
            _fail()
        return observed
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _verify_linux_handle(value: CandidateAttemptLayout) -> None:
    if (
        value._closed
        or not value._authoritative
        or type(value._anchor_fd) is not int
        or type(value._registry_fd) is not int
        or type(value._attempt_fd) is not int
        or type(value._bootstrap_fd) is not int
        or type(value._candidate_fd) is not int
        or type(value._fault_control_fd) is not int
    ):
        _fail()
    fresh_anchor_fd = None
    try:
        anchor = os.fstat(value._anchor_fd)
        registry = os.fstat(value._registry_fd)
        attempt_state = os.fstat(value._attempt_fd)
        bootstrap = os.fstat(value._bootstrap_fd)
        candidate = os.fstat(value._candidate_fd)
        fault_control = os.fstat(value._fault_control_fd)
        _validate_directory_state(anchor, private=True)
        _validate_directory_state(registry, private=True)
        _validate_directory_state(attempt_state, private=True)
        _validate_directory_state(bootstrap, private=True)
        _validate_directory_state(candidate, private=True)
        _validate_directory_state(fault_control, private=True)
        if any((
            not _same_identity(anchor, value._anchor_state),
            not _same_identity(registry, value._registry_state),
            not _same_identity(attempt_state, value._attempt_state),
            not _same_identity(bootstrap, value._bootstrap_state),
            not _same_identity(candidate, value._candidate_state),
            not _same_identity(
                fault_control,
                value._fault_control_state,
            ),
        )):
            _fail()

        fresh_anchor_fd, fresh_anchor_state = _open_trusted_anchor(
            value._anchor_path
        )
        if (
            not _same_identity(
                fresh_anchor_state,
                value._anchor_state,
            )
            or not _same_identity(anchor, os.fstat(fresh_anchor_fd))
        ):
            _fail()
        registry_entry = os.stat(
            value._registry_root.name,
            dir_fd=value._anchor_fd,
            follow_symlinks=False,
        )
        attempt_entry = os.stat(
            value._attempt_id,
            dir_fd=value._registry_fd,
            follow_symlinks=False,
        )
        bootstrap_entry = os.stat(
            BOOTSTRAP_BIND_SOURCE_NAME,
            dir_fd=value._attempt_fd,
            follow_symlinks=False,
        )
        candidate_entry = os.stat(
            CANDIDATE_BIND_SOURCE_NAME,
            dir_fd=value._attempt_fd,
            follow_symlinks=False,
        )
        fault_control_entry = os.stat(
            FAULT_CONTROL_BIND_SOURCE_NAME,
            dir_fd=value._attempt_fd,
            follow_symlinks=False,
        )
        if (
            not _same_secure_directory(
                registry,
                registry_entry,
                private=True,
            )
            or not _same_secure_directory(
                attempt_state,
                attempt_entry,
                private=True,
            )
            or not _same_secure_directory(
                bootstrap,
                bootstrap_entry,
                private=True,
            )
            or not _same_secure_directory(
                candidate,
                candidate_entry,
                private=True,
            )
            or not _same_secure_directory(
                fault_control,
                fault_control_entry,
                private=True,
            )
        ):
            _fail()
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)
    finally:
        if fresh_anchor_fd is not None:
            _close_descriptors_noexcept([fresh_anchor_fd])


def _verify_path_handle(value: CandidateAttemptLayout) -> None:
    if value._closed or value._authoritative:
        _fail()
    _assert_existing_ancestors_not_links(value._anchor_path)
    anchor = _verified_path_directory(
        value._anchor_path,
        private=False,
    )
    registry = _verified_path_directory(
        value._registry_root,
        private=True,
    )
    attempt_state = _verified_path_directory(
        value._attempt_directory,
        private=True,
    )
    if (
        not _same_identity(anchor, value._anchor_state)
        or not _same_identity(registry, value._registry_state)
        or not _same_identity(attempt_state, value._attempt_state)
    ):
        _fail()


def _validated_intent(
        value: CandidateAttemptLayout,
        expected_intent_sha256: object) -> tuple[dict, str]:
    if (
        type(expected_intent_sha256) is not str
        or HEX64.fullmatch(expected_intent_sha256) is None
    ):
        _fail()
    if value._authoritative:
        intent, raw = _read_record_at(
            value._attempt_fd,
            INTENT_RECORD_NAME,
            expected_state=value._intent_state,
        )
    else:
        intent, raw = _read_record_path(
            value._intent_path,
            expected_state=value._intent_state,
        )
    digest = hashlib.sha256(raw).hexdigest()
    controller = intent.get("controller")
    bind_mounts = intent.get("bindMounts")
    bootstrap = (
        bind_mounts.get("bootstrap")
        if type(bind_mounts) is dict else None
    )
    candidate = (
        bind_mounts.get("candidate")
        if type(bind_mounts) is dict else None
    )
    fault_control = (
        bind_mounts.get("faultControl")
        if type(bind_mounts) is dict else None
    )
    if (
        digest != expected_intent_sha256
        or digest != value._intent_sha256
        or not _exact_object(intent, _INTENT_FIELDS)
        or type(intent["schemaVersion"]) is not int
        or intent["schemaVersion"] != 1
        or type(intent["kind"]) is not str
        or intent["kind"] != "phase5-candidate-attempt-intent"
        or type(intent["attemptId"]) is not str
        or intent["attemptId"] != value._attempt_id
        or ATTEMPT_ID.fullmatch(intent["attemptId"]) is None
        or type(intent["releaseManifestSha256"]) is not str
        or HEX64.fullmatch(
            intent["releaseManifestSha256"]
        ) is None
        or not _exact_object(controller, _CONTROLLER_FIELDS)
        or not _uint32(controller["uid"])
        or not _uint32(controller["gid"])
        or not _exact_object(bind_mounts, _BIND_MOUNTS_FIELDS)
        or not _exact_object(bootstrap, _BIND_MOUNT_FIELDS)
        or not _exact_object(candidate, _BIND_MOUNT_FIELDS)
        or not _exact_object(fault_control, _BIND_MOUNT_FIELDS)
        or bootstrap != {
            "source": str(value._bootstrap_bind_source),
            "destination": BOOTSTRAP_CONTAINER_PATH,
            "readOnly": True,
        }
        or candidate != {
            "source": str(value._candidate_bind_source),
            "destination": CANDIDATE_CONTAINER_PATH,
            "readOnly": False,
        }
        or fault_control != {
            "source": str(value._fault_control_bind_source),
            "destination": FAULT_CONTROL_CONTAINER_PATH,
            "readOnly": False,
        }
    ):
        _fail()
    if LINUX_AUTHORITY_AVAILABLE and (
        controller["uid"] != os.geteuid()
        or controller["gid"] != os.getegid()
    ):
        _fail()
    return intent, digest


def _owned_valid_identity(value: object) -> dict:
    if type(value) is not dict:
        _fail()
    owned = _strict_json(_canonical(value))
    release = owned.get("release") if type(owned) is dict else None
    geometry = (
        owned.get("geometry") if type(owned) is dict else None
    )
    profile = owned.get("profile") if type(owned) is dict else None
    if (
        not _exact_object(owned, _IDENTITY_FIELDS)
        or type(owned["runId"]) is not str
        or UUID_V4.fullmatch(owned["runId"]) is None
        or type(owned["challenge"]) is not str
        or HEX64.fullmatch(owned["challenge"]) is None
        or not _exact_object(release, _RELEASE_FIELDS)
        or type(release["releaseManifestSha256"]) is not str
        or HEX64.fullmatch(
            release["releaseManifestSha256"]
        ) is None
        or type(release["releaseRevision"]) is not str
        or REVISION.fullmatch(release["releaseRevision"]) is None
        or type(release["sourceManifestSha256"]) is not str
        or HEX64.fullmatch(
            release["sourceManifestSha256"]
        ) is None
        or type(release["audioArtifactSha256"]) is not str
        or HEX64.fullmatch(
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
        or geometry["rowVoices"]
        != ["bass", "pad", "lead", "pluck", "pad"]
        or any(
            type(voice) is not str
            for voice in geometry["rowVoices"]
        )
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
        or profile["speciesModel"] != "bird_agent"
    ):
        _fail()
    return owned


def _owned_valid_admission(raw: object) -> tuple[dict, bytes]:
    try:
        if (
            type(raw) is not bytes
            or len(raw) == 0
            or len(raw) > MAX_ADMISSION_BYTES
            or not raw.endswith(b"\n")
            or raw.endswith(b"\n\n")
        ):
            _fail()
        body = raw[:-1]
        value = _strict_json(body)
        if (
            type(value) is not dict
            or raw != _canonical(value) + b"\n"
            or not _exact_object(value, _ADMISSION_FIELDS)
            or type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
            or type(value["kind"]) is not str
            or value["kind"]
            != "phase5-candidate-capture-admission"
            or type(value["runId"]) is not str
            or UUID_V4.fullmatch(value["runId"]) is None
            or type(value["challenge"]) is not str
            or HEX64.fullmatch(value["challenge"]) is None
            or type(value["captureNonce"]) is not str
            or HEX64.fullmatch(value["captureNonce"]) is None
            or type(value["signerSpkiSha256"]) is not str
            or HEX64.fullmatch(
                value["signerSpkiSha256"]
            ) is None
            or type(value["trustedSignerSpkiDerBase64"]) is not str
        ):
            _fail()
        spki = base64.b64decode(
            value["trustedSignerSpkiDerBase64"],
            validate=True,
        )
        if (
            len(spki) != 44
            or not spki.startswith(ED25519_SPKI_PREFIX)
            or base64.b64encode(spki).decode("ascii")
            != value["trustedSignerSpkiDerBase64"]
            or hashlib.sha256(spki).hexdigest()
            != value["signerSpkiSha256"]
        ):
            _fail()
        return value, bytes(raw)
    except Phase5CandidateAttemptError:
        raise
    except (
        base64.binascii.Error,
        KeyError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _intent_value(
        *,
        attempt_id: str,
        release_manifest_sha256: str,
        controller_uid: int,
        controller_gid: int,
        bootstrap_bind_source: Path,
        candidate_bind_source: Path,
        fault_control_bind_source: Path) -> dict:
    return {
        "schemaVersion": 1,
        "kind": "phase5-candidate-attempt-intent",
        "attemptId": attempt_id,
        "releaseManifestSha256": release_manifest_sha256,
        "controller": {
            "uid": controller_uid,
            "gid": controller_gid,
        },
        "bindMounts": {
            "bootstrap": {
                "source": str(bootstrap_bind_source),
                "destination": BOOTSTRAP_CONTAINER_PATH,
                "readOnly": True,
            },
            "candidate": {
                "source": str(candidate_bind_source),
                "destination": CANDIDATE_CONTAINER_PATH,
                "readOnly": False,
            },
            "faultControl": {
                "source": str(fault_control_bind_source),
                "destination": FAULT_CONTROL_CONTAINER_PATH,
                "readOnly": False,
            },
        },
    }


def _create_linux_attempt(
        *,
        registry_root: Path,
        attempt_id: str,
        release_manifest_sha256: str,
        controller_uid: int,
        controller_gid: int) -> CandidateAttemptLayout:
    anchor_fd = None
    registry_fd = None
    attempt_fd = None
    bootstrap_fd = None
    candidate_fd = None
    fault_control_fd = None
    intent_fd = None
    try:
        anchor_path = registry_root.parent
        anchor_fd, _ = _open_trusted_anchor(anchor_path)
        registry_fd, _ = _open_or_create_registry_at(
            anchor_fd,
            registry_root.name,
        )
        attempt_fd, _ = _mkdir_owned_directory_at(
            registry_fd,
            attempt_id,
        )
        bootstrap_fd, bootstrap_state = _mkdir_owned_directory_at(
            attempt_fd,
            BOOTSTRAP_BIND_SOURCE_NAME,
        )
        candidate_fd, candidate_state = _mkdir_owned_directory_at(
            attempt_fd,
            CANDIDATE_BIND_SOURCE_NAME,
        )
        fault_control_fd, fault_control_state = _mkdir_owned_directory_at(
            attempt_fd,
            FAULT_CONTROL_BIND_SOURCE_NAME,
        )

        attempt_directory = registry_root / attempt_id
        bootstrap_bind_source = (
            attempt_directory / BOOTSTRAP_BIND_SOURCE_NAME
        )
        candidate_bind_source = (
            attempt_directory / CANDIDATE_BIND_SOURCE_NAME
        )
        fault_control_bind_source = (
            attempt_directory / FAULT_CONTROL_BIND_SOURCE_NAME
        )
        intent_path = attempt_directory / INTENT_RECORD_NAME
        intent_raw, intent_state, intent_fd = _write_record_at(
            attempt_fd,
            INTENT_RECORD_NAME,
            _intent_value(
                attempt_id=attempt_id,
                release_manifest_sha256=release_manifest_sha256,
                controller_uid=controller_uid,
                controller_gid=controller_gid,
                bootstrap_bind_source=bootstrap_bind_source,
                candidate_bind_source=candidate_bind_source,
                fault_control_bind_source=fault_control_bind_source,
            ),
        )
        _inventory_at(
            attempt_fd,
            bootstrap_state=bootstrap_state,
            candidate_state=candidate_state,
            fault_control_state=fault_control_state,
            intent_state=intent_state,
            admission_state=None,
        )
        os.fsync(attempt_fd)
        os.fsync(registry_fd)
        os.fsync(anchor_fd)
        anchor_state = _node_state(os.fstat(anchor_fd))
        registry_state = _node_state(os.fstat(registry_fd))
        attempt_state = _node_state(os.fstat(attempt_fd))
        handle = CandidateAttemptLayout(
            registry_root=registry_root,
            attempt_directory=attempt_directory,
            bootstrap_bind_source=bootstrap_bind_source,
            candidate_bind_source=candidate_bind_source,
            fault_control_bind_source=fault_control_bind_source,
            intent_path=intent_path,
            intent_sha256=hashlib.sha256(intent_raw).hexdigest(),
            anchor_path=anchor_path,
            attempt_id=attempt_id,
            anchor_fd=anchor_fd,
            registry_fd=registry_fd,
            attempt_fd=attempt_fd,
            bootstrap_fd=bootstrap_fd,
            candidate_fd=candidate_fd,
            fault_control_fd=fault_control_fd,
            anchor_state=anchor_state,
            registry_state=registry_state,
            attempt_state=attempt_state,
            bootstrap_state=bootstrap_state,
            candidate_state=candidate_state,
            fault_control_state=fault_control_state,
            intent_state=intent_state,
            authoritative=True,
        )
        _verify_linux_handle(handle)
        _verify_held_record_at(
            attempt_fd,
            INTENT_RECORD_NAME,
            intent_fd,
            intent_state,
        )
        _inventory_at(
            attempt_fd,
            bootstrap_state=bootstrap_state,
            candidate_state=candidate_state,
            fault_control_state=fault_control_state,
            intent_state=intent_state,
            admission_state=None,
        )
        closing_intent_fd = intent_fd
        intent_fd = None
        close_error = _close_descriptors_noexcept(
            [closing_intent_fd]
        )
        if close_error is not None:
            _fail(close_error)
        anchor_fd = None
        registry_fd = None
        attempt_fd = None
        bootstrap_fd = None
        candidate_fd = None
        fault_control_fd = None
        return handle
    finally:
        _close_descriptors_noexcept([
            descriptor
            for descriptor in (
                intent_fd,
                fault_control_fd,
                candidate_fd,
                bootstrap_fd,
                attempt_fd,
                registry_fd,
                anchor_fd,
            )
            if descriptor is not None
        ])


def _create_path_attempt(
        *,
        registry_root: Path,
        attempt_id: str,
        release_manifest_sha256: str,
        controller_uid: int,
        controller_gid: int) -> CandidateAttemptLayout:
    anchor_path = registry_root.parent
    _assert_existing_ancestors_not_links(anchor_path)
    _verified_path_directory(anchor_path, private=False)
    _ensure_private_registry_root_path(registry_root)
    attempt_directory = registry_root / attempt_id
    bootstrap_bind_source = (
        attempt_directory / BOOTSTRAP_BIND_SOURCE_NAME
    )
    candidate_bind_source = (
        attempt_directory / CANDIDATE_BIND_SOURCE_NAME
    )
    fault_control_bind_source = (
        attempt_directory / FAULT_CONTROL_BIND_SOURCE_NAME
    )
    intent_path = attempt_directory / INTENT_RECORD_NAME
    _create_private_directory_path(attempt_directory)
    bootstrap_state = _node_state(
        _create_private_directory_path(bootstrap_bind_source)
    )
    candidate_state = _node_state(
        _create_private_directory_path(candidate_bind_source)
    )
    fault_control_state = _node_state(
        _create_private_directory_path(fault_control_bind_source)
    )
    intent_raw, intent_state = _write_record_path(
        intent_path,
        _intent_value(
            attempt_id=attempt_id,
            release_manifest_sha256=release_manifest_sha256,
            controller_uid=controller_uid,
            controller_gid=controller_gid,
            bootstrap_bind_source=bootstrap_bind_source,
            candidate_bind_source=candidate_bind_source,
            fault_control_bind_source=fault_control_bind_source,
        ),
    )
    registry_state = _node_state(
        _verified_path_directory(registry_root, private=True)
    )
    attempt_state = _node_state(
        _verified_path_directory(attempt_directory, private=True)
    )
    anchor_state = _node_state(
        _verified_path_directory(anchor_path, private=False)
    )
    _inventory_path(
        attempt_directory,
        bootstrap_state=bootstrap_state,
        candidate_state=candidate_state,
        fault_control_state=fault_control_state,
        intent_state=intent_state,
        admission_state=None,
    )
    return CandidateAttemptLayout(
        registry_root=registry_root,
        attempt_directory=attempt_directory,
        bootstrap_bind_source=bootstrap_bind_source,
        candidate_bind_source=candidate_bind_source,
        fault_control_bind_source=fault_control_bind_source,
        intent_path=intent_path,
        intent_sha256=hashlib.sha256(intent_raw).hexdigest(),
        anchor_path=anchor_path,
        attempt_id=attempt_id,
        anchor_fd=None,
        registry_fd=None,
        attempt_fd=None,
        bootstrap_fd=None,
        candidate_fd=None,
        fault_control_fd=None,
        anchor_state=anchor_state,
        registry_state=registry_state,
        attempt_state=attempt_state,
        bootstrap_state=bootstrap_state,
        candidate_state=candidate_state,
        fault_control_state=fault_control_state,
        intent_state=intent_state,
        authoritative=False,
    )


def create_phase5_candidate_attempt(
        registry_root: Path,
        attempt_id: str,
        release_manifest_sha256: str,
        controller_uid: int,
        controller_gid: int) -> CandidateAttemptLayout:
    """Create the private, nonce-free PREPARED attempt inventory."""
    try:
        registry_root = _absolute_path(registry_root)
        if (
            type(attempt_id) is not str
            or ATTEMPT_ID.fullmatch(attempt_id) is None
            or type(release_manifest_sha256) is not str
            or HEX64.fullmatch(release_manifest_sha256) is None
            or not _uint32(controller_uid)
            or not _uint32(controller_gid)
            or not registry_root.name
        ):
            _fail()
        if LINUX_AUTHORITY_AVAILABLE:
            if (
                controller_uid != os.geteuid()
                or controller_gid != os.getegid()
            ):
                _fail()
            return _create_linux_attempt(
                registry_root=registry_root,
                attempt_id=attempt_id,
                release_manifest_sha256=release_manifest_sha256,
                controller_uid=controller_uid,
                controller_gid=controller_gid,
            )
        return _create_path_attempt(
            registry_root=registry_root,
            attempt_id=attempt_id,
            release_manifest_sha256=release_manifest_sha256,
            controller_uid=controller_uid,
            controller_gid=controller_gid,
        )
    except Phase5CandidateAttemptError:
        raise
    except (
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def prepare_phase5_fault_control_linux(
        attempt: CandidateAttemptLayout) -> Phase5FaultControlHandle:
    """Create the exact two private listeners through the held dirfd."""
    listeners: dict[str, socket.socket] = {}
    socket_states: dict[str, _NodeState] = {}
    created_names: list[str] = []
    try:
        require_linux_attempt_authority()
        if (
            type(attempt) is not CandidateAttemptLayout
            or not attempt._authoritative
            or attempt._closed
        ):
            _fail()
        _verify_linux_handle(attempt)
        if _validate_fault_control_bind_inventory(
                attempt, allow_empty=True) is not None:
            _fail()
        for role, name in (
            ("runtime", RUNTIME_CONTROL_SOCKET_NAME),
            ("audio", AUDIO_CONTROL_SOCKET_NAME),
        ):
            listener = socket.socket(
                socket.AF_UNIX,
                socket.SOCK_STREAM | getattr(socket, "SOCK_CLOEXEC", 0),
            )
            listeners[role] = listener
            listener.bind(f"/proc/self/fd/{attempt._fault_control_fd}/{name}")
            created_names.append(name)
            os.chmod(
                name,
                0o600,
                dir_fd=attempt._fault_control_fd,
                follow_symlinks=False,
            )
            listener.listen(1)
            socket_states[name] = _socket_snapshot_at(
                attempt._fault_control_fd,
                name,
            )
        expected = (
            socket_states[RUNTIME_CONTROL_SOCKET_NAME],
            socket_states[AUDIO_CONTROL_SOCKET_NAME],
        )
        _validate_fault_control_bind_inventory(
            attempt,
            expected=expected,
        )
        _verify_linux_handle(attempt)
        return Phase5FaultControlHandle(
            attempt,
            listeners,
            socket_states,
        )
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)
    finally:
        if len(socket_states) != 2:
            listener_states = {}
            for role, listener in listeners.items():
                try:
                    listener_states[role] = _node_state(
                        os.fstat(listener.fileno())
                    )
                except OSError:
                    pass
                try:
                    listener.close()
                except OSError:
                    pass
            for role, name in reversed(tuple((
                ("runtime", RUNTIME_CONTROL_SOCKET_NAME),
                ("audio", AUDIO_CONTROL_SOCKET_NAME),
            ))):
                if name not in created_names:
                    continue
                try:
                    observed = _socket_snapshot_at(
                        attempt._fault_control_fd,
                        name,
                    )
                    expected = (
                        socket_states.get(name)
                        or listener_states.get(role)
                    )
                    if expected is not None and observed == expected:
                        os.unlink(name, dir_fd=attempt._fault_control_fd)
                except (OSError, Phase5CandidateAttemptError):
                    pass


def commit_phase5_candidate_admission(
        *,
        attempt: CandidateAttemptLayout,
        expected_intent_sha256: str,
        candidate_container_id: str,
        candidate_pid: int,
        candidate_uid: int,
        expected_identity: dict,
        admission_raw: bytes) -> CommittedAdmission:
    """Durably append ADMISSION_COMMITTED through the live attempt handle."""
    admission_fd = None
    try:
        if (
            type(attempt) is not CandidateAttemptLayout
            or not attempt._authoritative
        ):
            _fail()
        _verify_linux_handle(attempt)
        _inventory_at(
            attempt._attempt_fd,
            bootstrap_state=attempt._bootstrap_state,
            candidate_state=attempt._candidate_state,
            fault_control_state=attempt._fault_control_state,
            intent_state=attempt._intent_state,
            admission_state=None,
        )
        capture_state = _validate_runtime_bind_inventory(attempt)
        fault_control_states = _validate_fault_control_bind_inventory(
            attempt
        )
        if fault_control_states is None:
            _fail()
        intent, intent_sha256 = _validated_intent(
            attempt,
            expected_intent_sha256,
        )
        if (
            type(candidate_container_id) is not str
            or HEX64.fullmatch(candidate_container_id) is None
            or type(candidate_pid) is not int
            or candidate_pid <= 0
            or candidate_pid > 0x7fffffff
            or not _uint32(candidate_uid)
            or candidate_uid != intent["controller"]["uid"]
            or (
                LINUX_AUTHORITY_AVAILABLE
                and candidate_uid != os.geteuid()
            )
        ):
            _fail()
        identity = _owned_valid_identity(expected_identity)
        admission, admission_wire = _owned_valid_admission(
            admission_raw
        )
        if (
            identity["runId"] != admission["runId"]
            or identity["challenge"] != admission["challenge"]
            or identity["release"]["releaseManifestSha256"]
            != intent["releaseManifestSha256"]
        ):
            _fail()
        admission_sha256 = hashlib.sha256(
            admission_wire
        ).hexdigest()
        record = {
            "schemaVersion": 2,
            "kind": "phase5-candidate-attempt-admission",
            "attemptId": intent["attemptId"],
            "intentSha256": intent_sha256,
            "candidate": {
                "containerId": candidate_container_id,
                "pid": candidate_pid,
                "uid": candidate_uid,
            },
            "identity": identity,
            "admission": admission,
            "admissionSha256": admission_sha256,
            "captureSocketState": _capture_socket_record(
                capture_state
            ),
            "faultControlMountIdentity":
                _fault_control_mount_identity(
                    attempt._fault_control_state
                ),
            "faultControlPhase": "admitted",
            "faultControlInventory": _fault_control_inventory(
                fault_control_states
            ),
        }
        path = attempt._attempt_directory / ADMISSION_RECORD_NAME
        raw, admission_state, admission_fd = _write_record_at(
            attempt._attempt_fd,
            ADMISSION_RECORD_NAME,
            record,
        )
        _inventory_at(
            attempt._attempt_fd,
            bootstrap_state=attempt._bootstrap_state,
            candidate_state=attempt._candidate_state,
            fault_control_state=attempt._fault_control_state,
            intent_state=attempt._intent_state,
            admission_state=admission_state,
        )
        _validate_runtime_bind_inventory(
            attempt,
            expected_capture_state=capture_state,
        )
        _validate_fault_control_bind_inventory(
            attempt,
            expected=fault_control_states,
        )
        _verify_linux_handle(attempt)
        os.fsync(attempt._attempt_fd)
        os.fsync(attempt._registry_fd)
        os.fsync(attempt._anchor_fd)
        _verify_held_record_at(
            attempt._attempt_fd,
            ADMISSION_RECORD_NAME,
            admission_fd,
            admission_state,
        )
        _inventory_at(
            attempt._attempt_fd,
            bootstrap_state=attempt._bootstrap_state,
            candidate_state=attempt._candidate_state,
            fault_control_state=attempt._fault_control_state,
            intent_state=attempt._intent_state,
            admission_state=admission_state,
        )
        _validate_runtime_bind_inventory(
            attempt,
            expected_capture_state=capture_state,
        )
        _validate_fault_control_bind_inventory(
            attempt,
            expected=fault_control_states,
        )
        _verify_linux_handle(attempt)
        closing_admission_fd = admission_fd
        admission_fd = None
        close_error = _close_descriptors_noexcept(
            [closing_admission_fd]
        )
        if close_error is not None:
            _fail(close_error)
        return CommittedAdmission(
            path=path,
            record_sha256=hashlib.sha256(raw).hexdigest(),
            admission_sha256=admission_sha256,
        )
    except Phase5CandidateAttemptError:
        raise
    except (
        KeyError,
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
    finally:
        if admission_fd is not None:
            _close_descriptors_noexcept([admission_fd])


def append_phase5_fault_control_active(
        *,
        fault_control: Phase5FaultControlHandle,
        expected_admission_record_sha256: str
) -> AppendedAttemptRecord:
    """Append the durable active phase after both exact peers are held."""
    record_fd = None
    try:
        if (
            type(fault_control) is not Phase5FaultControlHandle
            or fault_control._closed
            or fault_control._phase != "active"
            or set(fault_control._connections) != {"runtime", "audio"}
            or set(fault_control._peers) != {"runtime", "audio"}
            or fault_control._admissions_sent != {"runtime", "audio"}
            or set(fault_control._admission_responses) != {
                "runtime", "audio", "audio-enable",
            }
            or not fault_control._audio_enabled
            or type(expected_admission_record_sha256) is not str
            or HEX64.fullmatch(expected_admission_record_sha256) is None
        ):
            _fail()
        attempt = fault_control._attempt
        _verify_linux_handle(attempt)
        with os.scandir(attempt._fault_control_fd) as iterator:
            if any(True for _entry in iterator):
                _fail()
        admission_state = _node_state(os.stat(
            ADMISSION_RECORD_NAME,
            dir_fd=attempt._attempt_fd,
            follow_symlinks=False,
        ))
        admission, admission_raw = _read_record_at(
            attempt._attempt_fd,
            ADMISSION_RECORD_NAME,
            expected_state=admission_state,
        )
        if (
            hashlib.sha256(admission_raw).hexdigest()
            != expected_admission_record_sha256
            or admission.get("faultControlPhase") != "admitted"
        ):
            _fail()
        peers = {
            role: {
                "pid": fault_control._peers[role][0],
                "uid": fault_control._peers[role][1],
            }
            for role in ("runtime", "audio")
        }
        record = {
            "schemaVersion": 1,
            "kind": "phase5-fault-control-active",
            "attemptId": attempt._attempt_id,
            "admissionRecordSha256":
                expected_admission_record_sha256,
            "faultControlMountIdentity":
                admission["faultControlMountIdentity"],
            "faultControlPhase": "active",
            "signerSpkiSha256":
                admission["admission"]["signerSpkiSha256"],
            "runtimeAdmissionResponseSha256":
                fault_control._admission_responses["runtime"],
            "audioAdmissionResponseSha256":
                fault_control._admission_responses["audio"],
            "audioEnableResponseSha256":
                fault_control._admission_responses["audio-enable"],
            "peers": peers,
        }
        raw, active_state, record_fd = _write_record_at(
            attempt._attempt_fd,
            FAULT_CONTROL_ACTIVE_RECORD_NAME,
            record,
        )
        _inventory_at(
            attempt._attempt_fd,
            bootstrap_state=attempt._bootstrap_state,
            candidate_state=attempt._candidate_state,
            fault_control_state=attempt._fault_control_state,
            intent_state=attempt._intent_state,
            admission_state=admission_state,
            fault_control_active_state=active_state,
        )
        os.fsync(attempt._attempt_fd)
        _verify_linux_handle(attempt)
        digest = hashlib.sha256(raw).hexdigest()
        object.__setattr__(
            fault_control,
            "_active_record_sha256",
            digest,
        )
        return AppendedAttemptRecord(
            attempt._attempt_directory
            / FAULT_CONTROL_ACTIVE_RECORD_NAME,
            digest,
        )
    except Phase5CandidateAttemptError:
        raise
    except (KeyError, OSError, TypeError, ValueError) as exc:
        _fail(exc)
    finally:
        if record_fd is not None:
            _close_descriptors_noexcept([record_fd])


def append_phase5_fault_control_closed(
        *,
        fault_control: Phase5FaultControlHandle
) -> AppendedAttemptRecord:
    """Append the terminal closed phase without replacing prior state."""
    record_fd = None
    try:
        if (
            type(fault_control) is not Phase5FaultControlHandle
            or fault_control._closed
            or fault_control._phase != "active"
            or type(fault_control._active_record_sha256) is not str
            or HEX64.fullmatch(
                fault_control._active_record_sha256
            ) is None
        ):
            _fail()
        attempt = fault_control._attempt
        _verify_linux_handle(attempt)
        fault_control.mark_closed()
        record = {
            "schemaVersion": 1,
            "kind": "phase5-fault-control-closed",
            "attemptId": attempt._attempt_id,
            "activeRecordSha256":
                fault_control._active_record_sha256,
            "faultControlPhase": "closed",
        }
        raw, _state, record_fd = _write_record_at(
            attempt._attempt_fd,
            FAULT_CONTROL_CLOSED_RECORD_NAME,
            record,
        )
        os.fsync(attempt._attempt_fd)
        _verify_linux_handle(attempt)
        return AppendedAttemptRecord(
            attempt._attempt_directory
            / FAULT_CONTROL_CLOSED_RECORD_NAME,
            hashlib.sha256(raw).hexdigest(),
        )
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)
    finally:
        if record_fd is not None:
            _close_descriptors_noexcept([record_fd])


def _validate_reopened_intent(
        registry_root: Path,
        attempt_id: str,
        record: _HeldRecord) -> dict:
    value = record.value
    controller = value.get("controller")
    bind_mounts = value.get("bindMounts")
    bootstrap = (
        bind_mounts.get("bootstrap")
        if type(bind_mounts) is dict else None
    )
    candidate = (
        bind_mounts.get("candidate")
        if type(bind_mounts) is dict else None
    )
    fault_control = (
        bind_mounts.get("faultControl")
        if type(bind_mounts) is dict else None
    )
    attempt_directory = registry_root / attempt_id
    if (
        not _exact_object(value, _INTENT_FIELDS)
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 1
        or type(value["kind"]) is not str
        or value["kind"] != "phase5-candidate-attempt-intent"
        or type(value["attemptId"]) is not str
        or value["attemptId"] != attempt_id
        or ATTEMPT_ID.fullmatch(value["attemptId"]) is None
        or type(value["releaseManifestSha256"]) is not str
        or HEX64.fullmatch(
            value["releaseManifestSha256"]
        ) is None
        or not _exact_object(controller, _CONTROLLER_FIELDS)
        or not _uint32(controller["uid"])
        or not _uint32(controller["gid"])
        or controller["uid"] != os.geteuid()
        or controller["gid"] != os.getegid()
        or not _exact_object(bind_mounts, _BIND_MOUNTS_FIELDS)
        or not _exact_object(bootstrap, _BIND_MOUNT_FIELDS)
        or not _exact_object(candidate, _BIND_MOUNT_FIELDS)
        or not _exact_object(fault_control, _BIND_MOUNT_FIELDS)
        or bootstrap != {
            "source": str(
                attempt_directory / BOOTSTRAP_BIND_SOURCE_NAME
            ),
            "destination": BOOTSTRAP_CONTAINER_PATH,
            "readOnly": True,
        }
        or candidate != {
            "source": str(
                attempt_directory / CANDIDATE_BIND_SOURCE_NAME
            ),
            "destination": CANDIDATE_CONTAINER_PATH,
            "readOnly": False,
        }
        or fault_control != {
            "source": str(
                attempt_directory / FAULT_CONTROL_BIND_SOURCE_NAME
            ),
            "destination": FAULT_CONTROL_CONTAINER_PATH,
            "readOnly": False,
        }
    ):
        _fail()
    return value


def _valid_capture_socket_record(value: object) -> bool:
    return (
        _exact_object(value, _CAPTURE_SOCKET_STATE_FIELDS)
        and type(value["device"]) is int
        and value["device"] >= 0
        and type(value["inode"]) is int
        and value["inode"] > 0
        and type(value["type"]) is str
        and value["type"] == "socket"
        and type(value["mode"]) is int
        and value["mode"] == 0o600
        and _uint32(value["uid"])
        and value["uid"] == os.geteuid()
        and _uint32(value["gid"])
        and value["gid"] == os.getegid()
        and type(value["nlink"]) is int
        and value["nlink"] == 1
    )


def _valid_fault_control_mount_identity(value: object) -> bool:
    return (
        _exact_object(value, _CAPTURE_SOCKET_STATE_FIELDS)
        and type(value["device"]) is int
        and value["device"] >= 0
        and type(value["inode"]) is int
        and value["inode"] > 0
        and value["type"] == "directory"
        and type(value["mode"]) is int
        and value["mode"] == 0o700
        and _uint32(value["uid"])
        and value["uid"] == os.geteuid()
        and _uint32(value["gid"])
        and value["gid"] == os.getegid()
        and type(value["nlink"]) is int
        and value["nlink"] >= 1
    )


def _valid_fault_control_inventory(value: object) -> bool:
    return (
        type(value) is dict
        and set(value) == {
            RUNTIME_CONTROL_SOCKET_NAME,
            AUDIO_CONTROL_SOCKET_NAME,
        }
        and all(
            _valid_capture_socket_record(value[name])
            for name in (
                RUNTIME_CONTROL_SOCKET_NAME,
                AUDIO_CONTROL_SOCKET_NAME,
            )
        )
    )


def _validate_reopened_admission(
        intent: _HeldRecord,
        admission: _HeldRecord) -> dict:
    value = admission.value
    candidate = value.get("candidate")
    identity_value = value.get("identity")
    admission_value = value.get("admission")
    socket_state = value.get("captureSocketState")
    fault_control_mount = value.get("faultControlMountIdentity")
    fault_control_inventory = value.get("faultControlInventory")
    if (
        not _exact_object(value, _ADMISSION_RECORD_FIELDS)
        or type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 2
        or type(value["kind"]) is not str
        or value["kind"] != "phase5-candidate-attempt-admission"
        or type(value["attemptId"]) is not str
        or value["attemptId"] != intent.value["attemptId"]
        or type(value["intentSha256"]) is not str
        or value["intentSha256"] != intent.sha256
        or not _exact_object(candidate, _CANDIDATE_FIELDS)
        or type(candidate["containerId"]) is not str
        or HEX64.fullmatch(candidate["containerId"]) is None
        or type(candidate["pid"]) is not int
        or candidate["pid"] <= 0
        or candidate["pid"] > 0x7fffffff
        or not _uint32(candidate["uid"])
        or candidate["uid"] != intent.value["controller"]["uid"]
        or candidate["uid"] != os.geteuid()
        or type(value["admissionSha256"]) is not str
        or HEX64.fullmatch(value["admissionSha256"]) is None
        or not _valid_capture_socket_record(socket_state)
        or not _valid_fault_control_mount_identity(
            fault_control_mount
        )
        or value.get("faultControlPhase") != "admitted"
        or not _valid_fault_control_inventory(
            fault_control_inventory
        )
    ):
        _fail()
    identity = _owned_valid_identity(identity_value)
    admitted, admission_wire = _owned_valid_admission(
        _canonical(admission_value) + b"\n"
    )
    if (
        identity != identity_value
        or admitted != admission_value
        or hashlib.sha256(admission_wire).hexdigest()
        != value["admissionSha256"]
        or identity["runId"] != admitted["runId"]
        or identity["challenge"] != admitted["challenge"]
        or identity["release"]["releaseManifestSha256"]
        != intent.value["releaseManifestSha256"]
    ):
        _fail()
    return value


def _capture_record_phase(
        records: dict[str, _HeldRecord]) -> str:
    present = set(records) & set(_CAPTURE_RECORD_NAMES)
    if not present:
        return "pre-arm"
    if present == {CAPTURE_INTENT_RECORD_NAME}:
        return "intent-only"
    if present == {
        CAPTURE_INTENT_RECORD_NAME,
        CAPTURE_FAILURE_RECORD_NAME,
    }:
        return "failure"
    if present == {
        CAPTURE_INTENT_RECORD_NAME,
        CAPTURE_SESSION_RECORD_NAME,
    }:
        return "session"
    if present == {
        CAPTURE_INTENT_RECORD_NAME,
        CAPTURE_SESSION_RECORD_NAME,
        ATTESTATION_COMMIT_RECORD_NAME,
    }:
        return "committed"
    _fail()


def _validate_capture_record_values(
        records: dict[str, _HeldRecord],
        intent: dict,
        admission: dict) -> Phase5CaptureState:
    phase = _capture_record_phase(records)
    if phase == "pre-arm":
        return Phase5CaptureState(
            phase="pre-arm",
            capture_intent_sha256=None,
            session_sha256=None,
            commit_sha256=None,
            error_code=None,
            channel_disposition=None,
            intent_raw=bytes(records[INTENT_RECORD_NAME].raw),
            admission_record_raw=bytes(
                records[ADMISSION_RECORD_NAME].raw
            ),
            capture_intent_raw=None,
            capture_failure_raw=None,
            session_raw=None,
            attestation_commit_raw=None,
        )

    capture_record = records[CAPTURE_INTENT_RECORD_NAME]
    capture_value = capture_record.value
    raw_manifest_sha256 = capture_value.get(
        "rawManifestSha256"
    )
    expected_capture = {
        "schemaVersion": 1,
        "kind": "phase5-candidate-capture-intent",
        "attemptId": intent["attemptId"],
        "intentSha256": records[INTENT_RECORD_NAME].sha256,
        "admissionRecordSha256": records[
            ADMISSION_RECORD_NAME
        ].sha256,
        "admissionSha256": admission["admissionSha256"],
        "releaseManifestSha256": intent[
            "releaseManifestSha256"
        ],
        "candidate": admission["candidate"],
        "identity": admission["identity"],
        "captureNonce": admission["admission"]["captureNonce"],
        "signerSpkiSha256": admission[
            "admission"
        ]["signerSpkiSha256"],
        "rawManifestSha256": raw_manifest_sha256,
    }
    if (
        not _exact_object(capture_value, _CAPTURE_INTENT_FIELDS)
        or type(raw_manifest_sha256) is not str
        or HEX64.fullmatch(raw_manifest_sha256) is None
        or capture_value != expected_capture
    ):
        _fail()

    error_code = None
    channel_disposition = None
    if CAPTURE_FAILURE_RECORD_NAME in records:
        failure = records[CAPTURE_FAILURE_RECORD_NAME].value
        error_code = failure.get("errorCode")
        channel_disposition = failure.get("channelDisposition")
        if (
            not _exact_object(failure, _CAPTURE_FAILURE_FIELDS)
            or failure != {
                "schemaVersion": 1,
                "kind": "phase5-candidate-capture-failure",
                "attemptId": intent["attemptId"],
                "captureIntentSha256": capture_record.sha256,
                "errorCode": error_code,
                "channelDisposition": channel_disposition,
            }
            or type(error_code) is not str
            or error_code not in _CAPTURE_FAILURE_ERROR_CODES
            or type(channel_disposition) is not str
            or channel_disposition not in _CHANNEL_DISPOSITIONS
        ):
            _fail()

    session_sha256 = None
    if CAPTURE_SESSION_RECORD_NAME in records:
        session = records[CAPTURE_SESSION_RECORD_NAME]
        if (
            type(session.value.get("schemaVersion")) is not int
            or session.value["schemaVersion"] != 2
            or type(session.value.get("kind")) is not str
            or session.value["kind"]
            != "phase5-fault-session-attestation"
        ):
            _fail()
        session_sha256 = session.sha256

    commit_sha256 = None
    if ATTESTATION_COMMIT_RECORD_NAME in records:
        commit = records[ATTESTATION_COMMIT_RECORD_NAME]
        value = commit.value
        profile_digests = value.get("profileDigests")
        if (
            not _exact_object(value, _ATTESTATION_COMMIT_FIELDS)
            or type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
            or type(value["kind"]) is not str
            or value["kind"]
            != "phase5-candidate-attestation-commit"
            or value["attemptId"] != intent["attemptId"]
            or value["captureIntentSha256"]
            != capture_record.sha256
            or value["sessionSha256"] != session_sha256
            or value["rawManifestSha256"]
            != raw_manifest_sha256
            or not _exact_object(
                profile_digests,
                _PROFILE_DIGEST_FIELDS,
            )
            or any(
                type(profile_digests[name]) is not str
                or HEX64.fullmatch(profile_digests[name]) is None
                for name in _PROFILE_DIGEST_FIELDS
            )
            or type(
                value["stagingMachineAttestationSha256"]
            ) is not str
            or HEX64.fullmatch(
                value["stagingMachineAttestationSha256"]
            ) is None
            or type(value["evidenceInventorySha256"]) is not str
            or HEX64.fullmatch(
                value["evidenceInventorySha256"]
            ) is None
        ):
            _fail()
        commit_sha256 = commit.sha256

    return Phase5CaptureState(
        phase=phase,
        fault_control_phase=fault_control_phase,
        capture_intent_sha256=capture_record.sha256,
        session_sha256=session_sha256,
        commit_sha256=commit_sha256,
        error_code=error_code,
        channel_disposition=channel_disposition,
        intent_raw=bytes(records[INTENT_RECORD_NAME].raw),
        admission_record_raw=bytes(
            records[ADMISSION_RECORD_NAME].raw
        ),
        capture_intent_raw=bytes(capture_record.raw),
        capture_failure_raw=(
            bytes(records[CAPTURE_FAILURE_RECORD_NAME].raw)
            if CAPTURE_FAILURE_RECORD_NAME in records else None
        ),
        session_raw=(
            bytes(records[CAPTURE_SESSION_RECORD_NAME].raw)
            if CAPTURE_SESSION_RECORD_NAME in records else None
        ),
        attestation_commit_raw=(
            bytes(records[ATTESTATION_COMMIT_RECORD_NAME].raw)
            if ATTESTATION_COMMIT_RECORD_NAME in records else None
        ),
    )


def _verify_held_directories(value: HeldAttempt) -> None:
    fresh_anchor_fd = None
    try:
        if (
            type(value) is not HeldAttempt
            or value._closed
            or type(value._anchor_fd) is not int
            or type(value._registry_fd) is not int
            or type(value._attempt_fd) is not int
            or type(value._bootstrap_fd) is not int
            or type(value._candidate_fd) is not int
            or type(value._fault_control_fd) is not int
        ):
            _fail()
        anchor = os.fstat(value._anchor_fd)
        registry = os.fstat(value._registry_fd)
        attempt_state = os.fstat(value._attempt_fd)
        bootstrap = os.fstat(value._bootstrap_fd)
        candidate = os.fstat(value._candidate_fd)
        fault_control = os.fstat(value._fault_control_fd)
        for current in (
            anchor,
            registry,
            attempt_state,
            bootstrap,
            candidate,
            fault_control,
        ):
            _validate_directory_state(current, private=True)
        if any((
            _node_state(anchor) != value._anchor_state,
            _node_state(registry) != value._registry_state,
            not _same_identity(attempt_state, value._attempt_state),
            _node_state(bootstrap) != value._bootstrap_state,
            not _same_identity(candidate, value._candidate_state),
            not _same_identity(
                fault_control,
                value._fault_control_state,
            ),
        )):
            _fail()
        fresh_anchor_fd, fresh_anchor_state = _open_trusted_anchor(
            value._anchor_path
        )
        if (
            not _same_identity(fresh_anchor_state, value._anchor_state)
            or not _same_identity(anchor, os.fstat(fresh_anchor_fd))
        ):
            _fail()
        registry_entry = os.stat(
            value._registry_root.name,
            dir_fd=value._anchor_fd,
            follow_symlinks=False,
        )
        attempt_entry = os.stat(
            value._attempt_id,
            dir_fd=value._registry_fd,
            follow_symlinks=False,
        )
        bootstrap_entry = os.stat(
            BOOTSTRAP_BIND_SOURCE_NAME,
            dir_fd=value._attempt_fd,
            follow_symlinks=False,
        )
        candidate_entry = os.stat(
            CANDIDATE_BIND_SOURCE_NAME,
            dir_fd=value._attempt_fd,
            follow_symlinks=False,
        )
        fault_control_entry = os.stat(
            FAULT_CONTROL_BIND_SOURCE_NAME,
            dir_fd=value._attempt_fd,
            follow_symlinks=False,
        )
        if (
            not _same_secure_directory(
                registry,
                registry_entry,
                private=True,
            )
            or not _same_secure_directory(
                attempt_state,
                attempt_entry,
                private=True,
            )
            or not _same_secure_directory(
                bootstrap,
                bootstrap_entry,
                private=True,
            )
            or not _same_secure_directory(
                candidate,
                candidate_entry,
                private=True,
            )
            or not _same_secure_directory(
                fault_control,
                fault_control_entry,
                private=True,
            )
        ):
            _fail()
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)
    finally:
        if fresh_anchor_fd is not None:
            _close_descriptors_noexcept([fresh_anchor_fd])


def _verify_attempt_inventory(
        value: HeldAttempt,
        records: dict[str, _HeldRecord]) -> None:
    expected = {
        BOOTSTRAP_BIND_SOURCE_NAME: (
            "directory",
            value._bootstrap_state,
        ),
        CANDIDATE_BIND_SOURCE_NAME: (
            "directory",
            value._candidate_state,
        ),
        FAULT_CONTROL_BIND_SOURCE_NAME: (
            "directory",
            value._fault_control_state,
        ),
    }
    expected.update({
        name: ("file", record.state)
        for name, record in dict.items(records)
    })
    try:
        with os.scandir(value._attempt_fd) as iterator:
            entries = {entry.name: entry for entry in iterator}
        if set(entries) != set(expected):
            _fail()
        for name, (kind, frozen) in dict.items(expected):
            current = entries[name].stat(follow_symlinks=False)
            if kind == "directory":
                _validate_directory_state(current, private=True)
                if not _same_identity(current, frozen):
                    _fail()
            else:
                _validate_file_state(current)
                if _node_state(current) != frozen:
                    _fail()
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _verify_empty_bootstrap(value: HeldAttempt) -> None:
    try:
        with os.scandir(value._bootstrap_fd) as iterator:
            if any(True for _entry in iterator):
                _fail()
    except Phase5CandidateAttemptError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _validate_fault_control_record_values(
        records: dict[str, _HeldRecord],
        admission: dict) -> str:
    active = records.get(FAULT_CONTROL_ACTIVE_RECORD_NAME)
    closed = records.get(FAULT_CONTROL_CLOSED_RECORD_NAME)
    if active is None:
        if closed is not None:
            _fail()
        return "admitted"
    active_value = active.value
    peers = active_value.get("peers")
    if (
        type(active_value) is not dict
        or set(active_value) != {
            "schemaVersion", "kind", "attemptId",
            "admissionRecordSha256", "faultControlMountIdentity",
            "faultControlPhase", "signerSpkiSha256",
            "runtimeAdmissionResponseSha256",
            "audioAdmissionResponseSha256",
            "audioEnableResponseSha256", "peers",
        }
        or active_value["schemaVersion"] != 1
        or active_value["kind"] != "phase5-fault-control-active"
        or active_value["attemptId"] != admission["attemptId"]
        or active_value["admissionRecordSha256"]
        != records[ADMISSION_RECORD_NAME].sha256
        or active_value["faultControlMountIdentity"]
        != admission["faultControlMountIdentity"]
        or active_value["faultControlPhase"] != "active"
        or active_value["signerSpkiSha256"]
        != admission["admission"]["signerSpkiSha256"]
        or any(
            type(active_value[name]) is not str
            or HEX64.fullmatch(active_value[name]) is None
            for name in (
                "runtimeAdmissionResponseSha256",
                "audioAdmissionResponseSha256",
                "audioEnableResponseSha256",
            )
        )
        or type(peers) is not dict
        or set(peers) != {"runtime", "audio"}
        or any(
            type(peers[role]) is not dict
            or set(peers[role]) != {"pid", "uid"}
            or type(peers[role]["pid"]) is not int
            or not 1 <= peers[role]["pid"] <= 0x7fffffff
            or not _uint32(peers[role]["uid"])
            or peers[role]["uid"] != admission["candidate"]["uid"]
            for role in ("runtime", "audio")
        )
        or peers["runtime"]["pid"] != admission["candidate"]["pid"]
    ):
        _fail()
    if closed is None:
        return "active"
    closed_value = closed.value
    if (
        type(closed_value) is not dict
        or set(closed_value) != {
            "schemaVersion", "kind", "attemptId",
            "activeRecordSha256", "faultControlPhase",
        }
        or closed_value["schemaVersion"] != 1
        or closed_value["kind"] != "phase5-fault-control-closed"
        or closed_value["attemptId"] != admission["attemptId"]
        or closed_value["activeRecordSha256"] != active.sha256
        or closed_value["faultControlPhase"] != "closed"
    ):
        _fail()
    return "closed"


def _validate_held_fault_control_inventory(
        value: HeldAttempt,
        admission: dict,
        phase: str) -> None:
    try:
        fault_control_dirfd = value._fault_control_fd
        if type(fault_control_dirfd) is not int:
            _fail()
        mount = _fault_control_mount_identity(
            _node_state(os.fstat(fault_control_dirfd))
        )
        if mount != admission["faultControlMountIdentity"]:
            _fail()
        with os.scandir(fault_control_dirfd) as iterator:
            names = {entry.name for entry in iterator}
        expected_names = (
            {
                RUNTIME_CONTROL_SOCKET_NAME,
                AUDIO_CONTROL_SOCKET_NAME,
            }
            if phase == "admitted" else set()
        )
        if names != expected_names:
            _fail()
        if phase != "admitted":
            return
        observed = _fault_control_inventory((
            _socket_snapshot_at(
                fault_control_dirfd,
                RUNTIME_CONTROL_SOCKET_NAME,
            ),
            _socket_snapshot_at(
                fault_control_dirfd,
                AUDIO_CONTROL_SOCKET_NAME,
            ),
        ))
        if observed != admission["faultControlInventory"]:
            _fail()
    except Phase5CandidateAttemptError:
        raise
    except (KeyError, OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _candidate_inventory_kind(
        value: HeldAttempt,
        admission: dict) -> str:
    try:
        with os.scandir(value._candidate_fd) as iterator:
            names = {entry.name for entry in iterator}
        if not names:
            return "empty"
        if names != {CAPTURE_SOCKET_NAME}:
            _fail()
        observed = _capture_socket_snapshot_at(value._candidate_fd)
        if (
            _capture_socket_record(observed)
            != admission["captureSocketState"]
        ):
            _fail()
        return "socket"
    except Phase5CandidateAttemptError:
        raise
    except (KeyError, OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _validate_candidate_phase_inventory(
        value: HeldAttempt,
        admission: dict,
        state: Phase5CaptureState) -> None:
    inventory = _candidate_inventory_kind(value, admission)
    if (
        (state.phase == "pre-arm" and inventory != "socket")
        or (
            state.phase == "intent-only"
            and inventory not in {"socket", "empty"}
        )
        or (
            state.phase == "failure"
            and state.channel_disposition == "not-connected"
            and inventory != "socket"
        )
        or (
            state.phase == "failure"
            and state.channel_disposition == "consumed"
            and inventory != "empty"
        )
        or (
            state.phase in {"session", "committed"}
            and inventory != "empty"
        )
    ):
        _fail()


def _validate_held_state(
        value: HeldAttempt,
        *,
        records: dict[str, _HeldRecord] | None = None,
        verify_directories: bool = True) -> Phase5CaptureState:
    if type(value) is not HeldAttempt or value._closed:
        _fail()
    current_records = value._records if records is None else records
    record_names = set(current_records)
    required_records = {
        INTENT_RECORD_NAME,
        ADMISSION_RECORD_NAME,
    }
    allowed_records = (
        required_records
        | set(_CAPTURE_RECORD_NAMES)
        | set(_FAULT_CONTROL_RECORD_NAMES)
    )
    if (
        type(current_records) is not dict
        or not required_records <= record_names
        or not record_names <= allowed_records
    ):
        _fail()
    if verify_directories:
        _verify_held_directories(value)
    for name, record in dict.items(current_records):
        _verify_record_snapshot_at(
            value._attempt_fd,
            name,
            record,
            maximum=(
                MAX_SESSION_BYTES
                if name == CAPTURE_SESSION_RECORD_NAME
                else MAX_RECORD_BYTES
            ),
        )
    _verify_attempt_inventory(value, current_records)
    _verify_empty_bootstrap(value)
    intent = _validate_reopened_intent(
        value._registry_root,
        value._attempt_id,
        current_records[INTENT_RECORD_NAME],
    )
    admission = _validate_reopened_admission(
        current_records[INTENT_RECORD_NAME],
        current_records[ADMISSION_RECORD_NAME],
    )
    fault_control_phase = _validate_fault_control_record_values(
        current_records,
        admission,
    )
    _validate_held_fault_control_inventory(
        value,
        admission,
        fault_control_phase,
    )
    capture_records = {
        name: record
        for name, record in current_records.items()
        if name in required_records or name in _CAPTURE_RECORD_NAMES
    }
    state = _validate_capture_record_values(
        capture_records,
        intent,
        admission,
    )
    _validate_candidate_phase_inventory(value, admission, state)
    return state


def _close_record_snapshots(
        records: dict[str, _HeldRecord]) -> None:
    _close_descriptors_noexcept([
        record.descriptor
        for record in dict.values(records)
    ])
    records.clear()


def open_unique_admitted_phase5_candidate_attempt(
        *,
        registry_root: Path,
        candidate_container_id: str,
        candidate_pid: int,
        candidate_uid: int,
        release_manifest_sha256: str) -> HeldAttempt:
    """Open exactly one admitted attempt from the fixed trusted registry."""
    anchor_fd = None
    registry_fd = None
    matches = []
    try:
        require_linux_attempt_authority()
        registry_root = _absolute_path(registry_root)
        if (
            registry_root.name != "a"
            or registry_root.parent.name != ".p5c"
            or type(candidate_container_id) is not str
            or HEX64.fullmatch(candidate_container_id) is None
            or type(candidate_pid) is not int
            or candidate_pid <= 0
            or candidate_pid > 0x7fffffff
            or not _uint32(candidate_uid)
            or candidate_uid != os.geteuid()
            or type(release_manifest_sha256) is not str
            or HEX64.fullmatch(release_manifest_sha256) is None
        ):
            _fail()
        anchor_fd, anchor_state = _open_trusted_anchor(
            registry_root.parent
        )
        registry_fd, registry_state = _open_owned_directory_at(
            anchor_fd,
            registry_root.name,
        )
        with os.scandir(registry_fd) as iterator:
            entries = sorted(
                ((entry.name, entry.stat(follow_symlinks=False))
                 for entry in iterator),
                key=lambda item: item[0],
            )
        for attempt_id, observed_attempt in entries:
            if (
                type(attempt_id) is not str
                or ATTEMPT_ID.fullmatch(attempt_id) is None
            ):
                _fail()
            _validate_directory_state(
                observed_attempt,
                private=True,
            )
            attempt_fd = None
            bootstrap_fd = None
            candidate_fd = None
            fault_control_fd = None
            handle_anchor_fd = None
            handle_registry_fd = None
            records = {}
            handle = None
            try:
                attempt_fd, attempt_state = _open_owned_directory_at(
                    registry_fd,
                    attempt_id,
                )
                with os.scandir(attempt_fd) as iterator:
                    names = {entry.name for entry in iterator}
                required_prepared = {
                    INTENT_RECORD_NAME,
                    BOOTSTRAP_BIND_SOURCE_NAME,
                    CANDIDATE_BIND_SOURCE_NAME,
                    FAULT_CONTROL_BIND_SOURCE_NAME,
                }
                allowed = (
                    required_prepared
                    | {ADMISSION_RECORD_NAME}
                    | set(_CAPTURE_RECORD_NAMES)
                    | set(_FAULT_CONTROL_RECORD_NAMES)
                )
                if (
                    not required_prepared <= names
                    or not names <= allowed
                ):
                    _fail()
                if (
                    ADMISSION_RECORD_NAME not in names
                    and names != required_prepared
                ):
                    _fail()
                bootstrap_fd, bootstrap_state = (
                    _open_owned_directory_at(
                        attempt_fd,
                        BOOTSTRAP_BIND_SOURCE_NAME,
                    )
                )
                candidate_fd, candidate_state = (
                    _open_owned_directory_at(
                        attempt_fd,
                        CANDIDATE_BIND_SOURCE_NAME,
                    )
                )
                fault_control_fd, fault_control_state = (
                    _open_owned_directory_at(
                        attempt_fd,
                        FAULT_CONTROL_BIND_SOURCE_NAME,
                    )
                )
                records[INTENT_RECORD_NAME] = (
                    _open_record_snapshot_at(
                        attempt_fd,
                        INTENT_RECORD_NAME,
                    )
                )
                _validate_reopened_intent(
                    registry_root,
                    attempt_id,
                    records[INTENT_RECORD_NAME],
                )
                if ADMISSION_RECORD_NAME not in names:
                    continue
                records[ADMISSION_RECORD_NAME] = (
                    _open_record_snapshot_at(
                        attempt_fd,
                        ADMISSION_RECORD_NAME,
                    )
                )
                for name in sorted(
                    names & (
                        set(_CAPTURE_RECORD_NAMES)
                        | set(_FAULT_CONTROL_RECORD_NAMES)
                    )
                ):
                    records[name] = _open_record_snapshot_at(
                        attempt_fd,
                        name,
                        maximum=(
                            MAX_SESSION_BYTES
                            if name == CAPTURE_SESSION_RECORD_NAME
                            else MAX_RECORD_BYTES
                        ),
                    )
                handle_anchor_fd = os.dup(anchor_fd)
                handle_registry_fd = os.dup(registry_fd)
                handle = HeldAttempt(
                    registry_root=registry_root,
                    attempt_id=attempt_id,
                    anchor_fd=handle_anchor_fd,
                    registry_fd=handle_registry_fd,
                    attempt_fd=attempt_fd,
                    bootstrap_fd=bootstrap_fd,
                    candidate_fd=candidate_fd,
                    fault_control_fd=fault_control_fd,
                    anchor_state=anchor_state,
                    registry_state=registry_state,
                    attempt_state=attempt_state,
                    bootstrap_state=bootstrap_state,
                    candidate_state=candidate_state,
                    fault_control_state=fault_control_state,
                    records=records,
                )
                handle_anchor_fd = None
                handle_registry_fd = None
                attempt_fd = None
                bootstrap_fd = None
                candidate_fd = None
                fault_control_fd = None
                records = {}
                _validate_held_state(handle)
                admission = handle._records[
                    ADMISSION_RECORD_NAME
                ].value
                intent = handle._records[INTENT_RECORD_NAME].value
                if (
                    admission["candidate"] == {
                        "containerId": candidate_container_id,
                        "pid": candidate_pid,
                        "uid": candidate_uid,
                    }
                    and intent["releaseManifestSha256"]
                    == release_manifest_sha256
                ):
                    matches.append(handle)
                    handle = None
            finally:
                if handle is not None:
                    handle.close()
                _close_record_snapshots(records)
                _close_descriptors_noexcept([
                    descriptor
                    for descriptor in (
                        fault_control_fd,
                        candidate_fd,
                        bootstrap_fd,
                        attempt_fd,
                        handle_registry_fd,
                        handle_anchor_fd,
                    )
                    if descriptor is not None
                ])
        if len(matches) != 1:
            _fail()
        result = matches.pop()
        try:
            _validate_held_state(result)
        except BaseException:
            result.close()
            raise
        return result
    except Phase5CandidateAttemptError:
        for match in matches:
            match.close()
        raise
    except (
        KeyError,
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        for match in matches:
            match.close()
        _fail(exc)
    finally:
        _close_descriptors_noexcept([
            descriptor
            for descriptor in (registry_fd, anchor_fd)
            if descriptor is not None
        ])


def _finish_appended_record(
        value: HeldAttempt,
        name: str,
        raw: bytes,
        state: _NodeState,
        writer_fd: int,
        *,
        maximum: int) -> AppendedAttemptRecord:
    snapshot = None
    descriptor = writer_fd
    try:
        _verify_held_record_at(
            value._attempt_fd,
            name,
            descriptor,
            state,
        )
        os.fsync(value._registry_fd)
        os.fsync(value._anchor_fd)
        _verify_held_directories(value)
        _verify_held_record_at(
            value._attempt_fd,
            name,
            descriptor,
            state,
        )
        snapshot = _open_record_snapshot_at(
            value._attempt_fd,
            name,
            maximum=maximum,
        )
        if (
            snapshot.raw != raw
            or snapshot.state != state
            or snapshot.sha256
            != hashlib.sha256(raw).hexdigest()
        ):
            _fail()
        close_error = _close_descriptors_noexcept([descriptor])
        descriptor = None
        if close_error is not None:
            _fail(close_error)
        merged = dict(value._records)
        merged[name] = snapshot
        _validate_held_state(value, records=merged)
        value._records[name] = snapshot
        result = AppendedAttemptRecord(
            path=value._attempt_directory / name,
            record_sha256=snapshot.sha256,
        )
        snapshot = None
        return result
    except Phase5CandidateAttemptError:
        raise
    except (
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
    finally:
        if snapshot is not None:
            _close_descriptors_noexcept([snapshot.descriptor])
        if descriptor is not None:
            _close_descriptors_noexcept([descriptor])


def _append_json_attempt_record(
        value: HeldAttempt,
        name: str,
        record: dict) -> AppendedAttemptRecord:
    raw, state, descriptor = _write_record_at(
        value._attempt_fd,
        name,
        record,
    )
    return _finish_appended_record(
        value,
        name,
        raw,
        state,
        descriptor,
        maximum=MAX_RECORD_BYTES,
    )


def _append_raw_attempt_record(
        value: HeldAttempt,
        name: str,
        raw: bytes) -> AppendedAttemptRecord:
    written, state, descriptor = _write_raw_record_at(
        value._attempt_fd,
        name,
        raw,
        maximum=MAX_SESSION_BYTES,
    )
    return _finish_appended_record(
        value,
        name,
        written,
        state,
        descriptor,
        maximum=MAX_SESSION_BYTES,
    )


def inspect_phase5_capture_state(
        *,
        attempt: HeldAttempt) -> Phase5CaptureState:
    """Revalidate and return the finite append-only capture state."""
    try:
        return _validate_held_state(attempt)
    except Phase5CandidateAttemptError:
        raise
    except (
        KeyError,
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def append_phase5_capture_intent(
        *,
        attempt: HeldAttempt,
        raw_manifest_sha256: str) -> AppendedAttemptRecord:
    """Durably arm one live admitted attempt for a single capture."""
    try:
        state = _validate_held_state(attempt)
        if (
            state.phase != "pre-arm"
            or type(raw_manifest_sha256) is not str
            or HEX64.fullmatch(raw_manifest_sha256) is None
        ):
            _fail()
        intent = attempt._records[INTENT_RECORD_NAME].value
        admission_record = attempt._records[
            ADMISSION_RECORD_NAME
        ]
        admission = admission_record.value
        record = {
            "schemaVersion": 1,
            "kind": "phase5-candidate-capture-intent",
            "attemptId": attempt._attempt_id,
            "intentSha256": attempt._records[
                INTENT_RECORD_NAME
            ].sha256,
            "admissionRecordSha256": admission_record.sha256,
            "admissionSha256": admission["admissionSha256"],
            "releaseManifestSha256": intent[
                "releaseManifestSha256"
            ],
            "candidate": admission["candidate"],
            "identity": admission["identity"],
            "captureNonce": admission[
                "admission"
            ]["captureNonce"],
            "signerSpkiSha256": admission[
                "admission"
            ]["signerSpkiSha256"],
            "rawManifestSha256": raw_manifest_sha256,
        }
        result = _append_json_attempt_record(
            attempt,
            CAPTURE_INTENT_RECORD_NAME,
            record,
        )
        object.__setattr__(
            attempt,
            "_capture_armed_live",
            True,
        )
        return result
    except Phase5CandidateAttemptError:
        raise
    except (
        KeyError,
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def append_phase5_capture_failure(
        *,
        attempt: HeldAttempt,
        error_code: str,
        channel_disposition: str) -> AppendedAttemptRecord:
    """Durably terminate a live armed channel attempt with a fixed error."""
    try:
        state = _validate_held_state(attempt)
        if (
            state.phase != "intent-only"
            or not attempt._capture_armed_live
            or type(error_code) is not str
            or error_code not in _CAPTURE_FAILURE_ERROR_CODES
            or type(channel_disposition) is not str
            or channel_disposition not in _CHANNEL_DISPOSITIONS
        ):
            _fail()
        admission = attempt._records[
            ADMISSION_RECORD_NAME
        ].value
        inventory = _candidate_inventory_kind(attempt, admission)
        if (
            (
                channel_disposition == "not-connected"
                and inventory != "socket"
            )
            or (
                channel_disposition == "consumed"
                and inventory != "empty"
            )
        ):
            _fail()
        return _append_json_attempt_record(
            attempt,
            CAPTURE_FAILURE_RECORD_NAME,
            {
                "schemaVersion": 1,
                "kind": "phase5-candidate-capture-failure",
                "attemptId": attempt._attempt_id,
                "captureIntentSha256": attempt._records[
                    CAPTURE_INTENT_RECORD_NAME
                ].sha256,
                "errorCode": error_code,
                "channelDisposition": channel_disposition,
            },
        )
    except Phase5CandidateAttemptError:
        raise
    except (
        KeyError,
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def append_phase5_capture_session_raw(
        *,
        attempt: HeldAttempt,
        session_raw: bytes) -> AppendedAttemptRecord:
    """Persist verifier-fixed canonical v2 session bytes without wrapping."""
    try:
        state = _validate_held_state(attempt)
        if (
            state.phase != "intent-only"
            or not attempt._capture_armed_live
            or type(session_raw) is not bytes
            or not session_raw
            or len(session_raw) > MAX_SESSION_BYTES
        ):
            _fail()
        session_value = _strict_json(session_raw)
        if (
            type(session_value) is not dict
            or type(session_value.get("schemaVersion")) is not int
            or session_value["schemaVersion"] != 2
            or type(session_value.get("kind")) is not str
            or session_value["kind"]
            != "phase5-fault-session-attestation"
        ):
            _fail()
        admission = attempt._records[
            ADMISSION_RECORD_NAME
        ].value
        if _candidate_inventory_kind(attempt, admission) != "empty":
            _fail()
        return _append_raw_attempt_record(
            attempt,
            CAPTURE_SESSION_RECORD_NAME,
            bytes(session_raw),
        )
    except Phase5CandidateAttemptError:
        raise
    except (
        KeyError,
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _owned_profile_digests(value: object) -> dict:
    if (
        not _exact_object(value, _PROFILE_DIGEST_FIELDS)
        or any(
            type(value[name]) is not str
            or HEX64.fullmatch(value[name]) is None
            for name in _PROFILE_DIGEST_FIELDS
        )
    ):
        _fail()
    return {
        "normal": value["normal"],
        "burst": value["burst"],
    }


def _stable_evidence_inventory(value: object) -> list[dict]:
    if type(value) is not list:
        _fail()
    result = []
    names = set()
    for member in list.__iter__(value):
        if (
            not _exact_object(member, _EVIDENCE_INVENTORY_FIELDS)
            or type(member["name"]) is not str
            or not member["name"]
            or member["name"] in {".", ".."}
            or "/" in member["name"]
            or "\\" in member["name"]
            or "\0" in member["name"]
            or member["name"] in names
            or type(member["sha256"]) is not str
            or HEX64.fullmatch(member["sha256"]) is None
        ):
            _fail()
        names.add(member["name"])
        result.append({
            "name": member["name"],
            "sha256": member["sha256"],
        })
    if not result:
        _fail()
    return sorted(result, key=lambda member: member["name"])


def append_phase5_attestation_commit(
        *,
        attempt: HeldAttempt,
        profile_digests: dict,
        staging_machine_attestation_sha256: str,
        evidence_inventory: list[dict]) -> AppendedAttemptRecord:
    """Durably bind the complete post-session attestation evidence."""
    try:
        state = _validate_held_state(attempt)
        if (
            state.phase != "session"
            or type(staging_machine_attestation_sha256) is not str
            or HEX64.fullmatch(
                staging_machine_attestation_sha256
            ) is None
        ):
            _fail()
        owned_profiles = _owned_profile_digests(profile_digests)
        stable_inventory = _stable_evidence_inventory(
            evidence_inventory
        )
        capture_intent = attempt._records[
            CAPTURE_INTENT_RECORD_NAME
        ]
        return _append_json_attempt_record(
            attempt,
            ATTESTATION_COMMIT_RECORD_NAME,
            {
                "schemaVersion": 1,
                "kind": "phase5-candidate-attestation-commit",
                "attemptId": attempt._attempt_id,
                "captureIntentSha256": capture_intent.sha256,
                "sessionSha256": attempt._records[
                    CAPTURE_SESSION_RECORD_NAME
                ].sha256,
                "rawManifestSha256": capture_intent.value[
                    "rawManifestSha256"
                ],
                "profileDigests": owned_profiles,
                "stagingMachineAttestationSha256": (
                    staging_machine_attestation_sha256
                ),
                "evidenceInventorySha256": hashlib.sha256(
                    _canonical(stable_inventory)
                ).hexdigest(),
            },
        )
    except Phase5CandidateAttemptError:
        raise
    except (
        KeyError,
        OSError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
