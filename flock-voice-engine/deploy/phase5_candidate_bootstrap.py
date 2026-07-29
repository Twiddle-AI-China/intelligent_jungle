#!/usr/bin/env python3
"""One-shot Linux controller transport for Phase 5 candidate bootstrap.

The public entry point creates the listener before the candidate is
started.  The returned handle is completed only after the caller has
obtained the candidate host PID and UID from Docker inspect.

``commit_admission`` is the explicit composition boundary to the
append-only attempt registry.  This transport refuses to ACK unless the
callback returns the exact wire digest, but the release controller must
bind that seam to the concrete O_EXCL/0400/fsync registry commit; an
arbitrary callback is not durability evidence.  The monotonic deadline is
checked before and after that trusted synchronous commit.  Python cannot
safely preempt an indefinitely blocked fsync in the same process, so the
composition must not describe this narrow helper alone as a hard
wall-clock bound around an untrusted callback.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import posixpath
import re
import secrets
import select
import socket
import stat
import struct
import sys
import time
from types import MappingProxyType
from typing import NamedTuple


PHASE5_BOOTSTRAP_DIRECTORY_BASENAME = "run-flock-phase5-bootstrap"
PHASE5_BOOTSTRAP_SOCKET_BASENAME = "bootstrap.sock"
PHASE5_BOOTSTRAP_TIMEOUT_SECONDS = 5.0
MAX_PHASE5_BOOTSTRAP_ADMISSION_BYTES = 4096
MAX_PHASE5_BOOTSTRAP_RECEIPT_BYTES = 256
MAX_PHASE5_BOOTSTRAP_REQUEST_BYTES = 4096
MAX_PHASE5_BOOTSTRAP_ACK_BYTES = 256
MAX_LINUX_UNIX_SOCKET_PATH_BYTES = 107

_SO_PEERCRED = getattr(socket, "SO_PEERCRED", 17)
_UCRED = struct.Struct("@iII")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_REVISION = re.compile(r"^[0-9a-f]{40}$")
_UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
_ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")
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
_COMMIT_RESULT_FIELDS = {"admissionSha256"}
_RECEIPT_FIELDS = {
    "schemaVersion",
    "kind",
    "admissionSha256",
    "receiptChallenge",
}

LINUX_AUTHORITY_AVAILABLE = (
    sys.platform.startswith("linux")
    and hasattr(socket, "AF_UNIX")
    and hasattr(socket, "SO_PEERCRED")
    and hasattr(select, "poll")
)


class Phase5CandidateBootstrapError(RuntimeError):
    """The candidate bootstrap authority was not proven and was consumed."""


class Phase5CandidateBootstrapResult(NamedTuple):
    """Owned admission returned after durable commit and clean peer close."""

    admission: MappingProxyType
    admission_sha256: str


def _fail(exc: BaseException | None = None) -> None:
    error = Phase5CandidateBootstrapError(
        "PHASE5_CANDIDATE_BOOTSTRAP_REQUIRED"
    )
    if exc is None:
        raise error
    raise error from exc


def _exact_object(value: object, fields: set[str]) -> bool:
    return (
        type(value) is dict
        and all(type(key) is str for key in dict.keys(value))
        and set(dict.keys(value)) == fields
    )


def _owned_plain_json_tree(value: object) -> object:
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
        return json.dumps(
            _owned_plain_json_tree(value),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except Phase5CandidateBootstrapError:
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
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_members,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ValueError("non-finite JSON")
            ),
        )
        if _canonical(value) != raw:
            _fail()
        return value
    except Phase5CandidateBootstrapError:
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


def _owned_valid_identity(value: object) -> tuple[dict, bytes]:
    try:
        owned = _strict_json(_canonical(value))
        release = (
            owned.get("release") if type(owned) is dict else None
        )
        geometry = (
            owned.get("geometry") if type(owned) is dict else None
        )
        profile = (
            owned.get("profile") if type(owned) is dict else None
        )
        if (
            not _exact_object(owned, _IDENTITY_FIELDS)
            or type(owned["runId"]) is not str
            or _UUID_V4.fullmatch(owned["runId"]) is None
            or type(owned["challenge"]) is not str
            or _HEX64.fullmatch(owned["challenge"]) is None
            or not _exact_object(release, _RELEASE_FIELDS)
            or type(release["releaseManifestSha256"]) is not str
            or _HEX64.fullmatch(
                release["releaseManifestSha256"]
            ) is None
            or type(release["releaseRevision"]) is not str
            or _REVISION.fullmatch(release["releaseRevision"]) is None
            or type(release["sourceManifestSha256"]) is not str
            or _HEX64.fullmatch(
                release["sourceManifestSha256"]
            ) is None
            or type(release["audioArtifactSha256"]) is not str
            or _HEX64.fullmatch(
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
        raw = _canonical(owned)
        return owned, raw
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        KeyError,
        OverflowError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _owned_valid_admission(
        raw: object,
        *,
        expected_identity: dict,
        capture_nonce: str) -> dict:
    try:
        if (
            type(raw) is not bytes
            or not raw
            or len(raw) > MAX_PHASE5_BOOTSTRAP_ADMISSION_BYTES
            or not raw.endswith(b"\n")
            or raw.endswith(b"\n\n")
        ):
            _fail()
        value = _strict_json(raw[:-1])
        if (
            raw != _canonical(value) + b"\n"
            or not _exact_object(value, _ADMISSION_FIELDS)
            or type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
            or type(value["kind"]) is not str
            or value["kind"]
            != "phase5-candidate-capture-admission"
            or type(value["runId"]) is not str
            or value["runId"] != expected_identity["runId"]
            or type(value["challenge"]) is not str
            or value["challenge"] != expected_identity["challenge"]
            or type(value["captureNonce"]) is not str
            or value["captureNonce"] != capture_nonce
            or type(value["signerSpkiSha256"]) is not str
            or _HEX64.fullmatch(value["signerSpkiSha256"]) is None
            or type(value["trustedSignerSpkiDerBase64"]) is not str
        ):
            _fail()
        spki = base64.b64decode(
            value["trustedSignerSpkiDerBase64"],
            validate=True,
        )
        if (
            len(spki) != 44
            or not spki.startswith(_ED25519_SPKI_PREFIX)
            or base64.b64encode(spki).decode("ascii")
            != value["trustedSignerSpkiDerBase64"]
            or hashlib.sha256(spki).hexdigest()
            != value["signerSpkiSha256"]
        ):
            _fail()
        return value
    except Phase5CandidateBootstrapError:
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


def _validate_receipt(
        raw: object,
        *,
        admission_sha256: str,
        receipt_challenge: str) -> None:
    try:
        if (
            type(raw) is not bytes
            or not raw
            or len(raw) > MAX_PHASE5_BOOTSTRAP_RECEIPT_BYTES
            or not raw.endswith(b"\n")
            or raw.endswith(b"\n\n")
        ):
            _fail()
        value = _strict_json(raw[:-1])
        if (
            raw != _canonical(value) + b"\n"
            or not _exact_object(value, _RECEIPT_FIELDS)
            or type(value["schemaVersion"]) is not int
            or value["schemaVersion"] != 1
            or type(value["kind"]) is not str
            or value["kind"]
            != "phase5-candidate-capture-admission-receipt"
            or type(value["admissionSha256"]) is not str
            or value["admissionSha256"] != admission_sha256
            or type(value["receiptChallenge"]) is not str
            or value["receiptChallenge"] != receipt_challenge
        ):
            _fail()
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        KeyError,
        RecursionError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _validate_expected_peer(
        expected_pid: object,
        expected_uid: object) -> None:
    if (
        type(expected_pid) is not int
        or expected_pid <= 0
        or expected_pid > 0x7fffffff
        or type(expected_uid) is not int
        or expected_uid < 0
        or expected_uid > 0xffffffff
    ):
        _fail()


def _derive_bootstrap_socket_path(
        bootstrap_directory: object) -> str:
    try:
        if (
            type(bootstrap_directory) is not str
            or not bootstrap_directory
            or "\0" in bootstrap_directory
            or bootstrap_directory.startswith("//")
            or not posixpath.isabs(bootstrap_directory)
            or posixpath.normpath(bootstrap_directory)
            != bootstrap_directory
            or posixpath.basename(bootstrap_directory)
            != PHASE5_BOOTSTRAP_DIRECTORY_BASENAME
        ):
            _fail()
        socket_path = posixpath.join(
            bootstrap_directory,
            PHASE5_BOOTSTRAP_SOCKET_BASENAME,
        )
        if (
            len(os.fsencode(socket_path))
            > MAX_LINUX_UNIX_SOCKET_PATH_BYTES
        ):
            _fail()
        return socket_path
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        OSError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _path_ancestors(path: str) -> tuple[str, ...]:
    parts = path.split("/")[1:]
    current = ""
    ancestors = ["/"]
    for part in parts:
        current += f"/{part}"
        ancestors.append(current)
    return tuple(ancestors)


def _directory_fingerprint(value: object) -> tuple:
    try:
        return (
            value.st_dev,
            value.st_ino,
            value.st_mode,
            value.st_uid,
        )
    except (AttributeError, TypeError, ValueError) as exc:
        _fail(exc)


def _verified_bootstrap_directory(
        *,
        bootstrap_directory: object,
        lstat,
        geteuid) -> tuple[str, int, tuple]:
    try:
        socket_path = _derive_bootstrap_socket_path(
            bootstrap_directory
        )
        controller_uid = geteuid()
        if (
            type(controller_uid) is not int
            or controller_uid < 0
            or controller_uid > 0xffffffff
        ):
            _fail()
        ancestors = _path_ancestors(
            bootstrap_directory  # type: ignore[arg-type]
        )
        states = {
            path: lstat(path)
            for path in ancestors
        }
        for path in ancestors:
            state = states[path]
            if not stat.S_ISDIR(state.st_mode):
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
        parent = states[
            bootstrap_directory  # type: ignore[index]
        ]
        attempt_parent = states[ancestors[-2]]
        if (
            parent.st_uid != controller_uid
            or stat.S_IMODE(parent.st_mode) != 0o700
            or attempt_parent.st_uid != controller_uid
            or stat.S_IMODE(attempt_parent.st_mode) != 0o700
        ):
            _fail()
        try:
            lstat(socket_path)
        except FileNotFoundError:
            pass
        else:
            _fail()
        return (
            socket_path,
            controller_uid,
            _directory_fingerprint(parent),
        )
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _verify_bootstrap_directory_unchanged(
        *,
        bootstrap_directory: str,
        expected_uid: int,
        expected_fingerprint: tuple,
        lstat) -> None:
    try:
        ancestors = _path_ancestors(bootstrap_directory)
        states = {
            path: lstat(path)
            for path in ancestors
        }
        for path in ancestors:
            state = states[path]
            if not stat.S_ISDIR(state.st_mode):
                _fail()
        for path in ancestors[:-1]:
            state = states[path]
            mode = stat.S_IMODE(state.st_mode)
            if state.st_uid not in (0, expected_uid):
                _fail()
            if state.st_uid == expected_uid:
                if mode & 0o022:
                    _fail()
            elif mode & 0o022 and not mode & stat.S_ISVTX:
                _fail()
        parent = states[bootstrap_directory]
        attempt_parent = states[ancestors[-2]]
        if (
            parent.st_uid != expected_uid
            or stat.S_IMODE(parent.st_mode) != 0o700
            or attempt_parent.st_uid != expected_uid
            or stat.S_IMODE(attempt_parent.st_mode) != 0o700
            or _directory_fingerprint(parent)
            != expected_fingerprint
        ):
            _fail()
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _same_inode(left: object, right: object) -> bool:
    return (
        getattr(left, "st_dev", None),
        getattr(left, "st_ino", None),
    ) == (
        getattr(right, "st_dev", None),
        getattr(right, "st_ino", None),
    )


def _verify_bound_socket(
        *,
        socket_path: str,
        expected_uid: int,
        lstat) -> object:
    try:
        state = lstat(socket_path)
        if (
            not stat.S_ISSOCK(state.st_mode)
            or stat.S_IMODE(state.st_mode) != 0o600
            or state.st_uid != expected_uid
        ):
            _fail()
        return state
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        OSError,
        TypeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _owned_socket_inode(
        *,
        socket_path: str,
        expected_uid: int,
        lstat) -> object:
    try:
        state = lstat(socket_path)
        if (
            not stat.S_ISSOCK(state.st_mode)
            or state.st_uid != expected_uid
        ):
            _fail()
        return state
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        OSError,
        TypeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _unlink_bound_socket(
        *,
        socket_path: str,
        socket_state: object,
        lstat,
        unlink) -> None:
    try:
        current = lstat(socket_path)
        if (
            not _same_inode(current, socket_state)
            or current.st_mode != socket_state.st_mode
            or current.st_uid != socket_state.st_uid
        ):
            _fail()
        unlink(socket_path)
        try:
            lstat(socket_path)
        except FileNotFoundError:
            return
        _fail()
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        OSError,
        TypeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _remaining(deadline: float, monotonic) -> float:
    try:
        now = monotonic()
        if (
            type(now) not in (int, float)
            or not math.isfinite(now)
        ):
            _fail()
        value = deadline - float(now)
        if not math.isfinite(value) or value <= 0:
            _fail()
        return min(value, PHASE5_BOOTSTRAP_TIMEOUT_SECONDS)
    except Phase5CandidateBootstrapError:
        raise
    except (
        OverflowError,
        TypeError,
        ValueError,
    ) as exc:
        _fail(exc)


def _set_timeout(channel, deadline: float, monotonic) -> None:
    try:
        channel.settimeout(_remaining(deadline, monotonic))
    except Phase5CandidateBootstrapError:
        raise
    except (AttributeError, OSError, TypeError, ValueError) as exc:
        _fail(exc)


def _read_unique_line(
        peer,
        *,
        deadline: float,
        monotonic,
        maximum: int) -> bytes:
    buffer = bytearray()
    while True:
        _set_timeout(peer, deadline, monotonic)
        try:
            chunk = peer.recv(
                min(
                    maximum,
                    maximum - len(buffer) + 1,
                )
            )
        except (OSError, TimeoutError, TypeError, ValueError) as exc:
            _fail(exc)
        if type(chunk) is not bytes:
            _fail()
        if not chunk:
            _fail()
        buffer.extend(chunk)
        if len(buffer) > maximum:
            _fail()
        newline = buffer.find(b"\n")
        if newline >= 0:
            if newline != len(buffer) - 1:
                _fail()
            return bytes(buffer)


def _read_to_eof(
        peer,
        *,
        deadline: float,
        monotonic,
        maximum: int) -> bytes:
    buffer = bytearray()
    while True:
        _set_timeout(peer, deadline, monotonic)
        try:
            chunk = peer.recv(
                min(
                    maximum,
                    maximum - len(buffer) + 1,
                )
            )
        except (OSError, TimeoutError, TypeError, ValueError) as exc:
            _fail(exc)
        if type(chunk) is not bytes:
            _fail()
        if not chunk:
            return bytes(buffer)
        buffer.extend(chunk)
        if len(buffer) > maximum:
            _fail()


def _wait_for_peer_close_linux(
        peer,
        deadline: float,
        monotonic) -> bool:
    try:
        poller = select.poll()
        poller.register(
            peer.fileno(),
            select.POLLHUP | select.POLLERR | select.POLLNVAL,
        )
        while True:
            timeout_ms = max(
                1,
                math.ceil(_remaining(deadline, monotonic) * 1000),
            )
            events = poller.poll(timeout_ms)
            if not events:
                return False
            for _descriptor, mask in events:
                if mask & select.POLLNVAL:
                    return False
                if mask & select.POLLHUP:
                    return (
                        peer.getsockopt(
                            socket.SOL_SOCKET,
                            socket.SO_ERROR,
                        )
                        == 0
                    )
                if mask & select.POLLERR:
                    return False
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        OSError,
        OverflowError,
        TypeError,
        ValueError,
    ) as exc:
        _fail(exc)


class _Phase5CandidateBootstrapHandle:
    __slots__ = (
        "_bootstrap_directory",
        "_capture_nonce",
        "_chmod",
        "_completed_pid",
        "_completed_uid",
        "_controller_uid",
        "_directory_fingerprint",
        "_identity_raw",
        "_listener",
        "_lstat",
        "_monotonic",
        "_nonce_factory",
        "_peer",
        "_result",
        "_socket_path",
        "_socket_state",
        "_state",
        "_unlink",
        "_wait_for_peer_close",
    )

    def __init__(
            self,
            *,
            listener,
            bootstrap_directory: str,
            controller_uid: int,
            directory_fingerprint: tuple,
            socket_path: str,
            socket_state: object,
            identity_raw: bytes,
            capture_nonce: str,
            monotonic,
            nonce_factory,
            lstat,
            chmod,
            unlink,
            wait_for_peer_close):
        self._listener = listener
        self._bootstrap_directory = bootstrap_directory
        self._controller_uid = controller_uid
        self._directory_fingerprint = directory_fingerprint
        self._socket_path = socket_path
        self._socket_state = socket_state
        self._identity_raw = identity_raw
        self._capture_nonce = capture_nonce
        self._monotonic = monotonic
        self._nonce_factory = nonce_factory
        self._lstat = lstat
        self._chmod = chmod
        self._unlink = unlink
        self._wait_for_peer_close = wait_for_peer_close
        self._peer = None
        self._result = None
        self._completed_pid = None
        self._completed_uid = None
        self._state = "prepared"

    def __repr__(self) -> str:
        return "<Phase5CandidateBootstrapHandle one-shot>"

    def _cleanup_listener(self, *, strict: bool) -> None:
        first_error = None
        listener = self._listener
        self._listener = None
        if listener is not None:
            try:
                listener.close()
            except Exception as exc:  # pragma: no cover - OS defensive
                first_error = exc
        socket_state = self._socket_state
        if socket_state is not None:
            try:
                _unlink_bound_socket(
                    socket_path=self._socket_path,
                    socket_state=socket_state,
                    lstat=self._lstat,
                    unlink=self._unlink,
                )
            except Exception as exc:
                if first_error is None:
                    first_error = exc
            else:
                self._socket_state = None
        if strict and first_error is not None:
            _fail(first_error)

    def _cleanup_peer(self) -> None:
        peer = self._peer
        self._peer = None
        if peer is not None:
            try:
                peer.close()
            except Exception:
                pass

    def _seal_failed(self) -> None:
        self._state = "sealed"
        self._capture_nonce = None
        self._cleanup_peer()
        self._cleanup_listener(strict=False)

    def close(self) -> None:
        if self._state == "completed":
            return None
        if (
            self._state == "sealed"
            and self._listener is None
            and self._peer is None
            and self._socket_state is None
        ):
            return None
        self._state = "sealed"
        self._capture_nonce = None
        self._cleanup_peer()
        self._cleanup_listener(strict=True)
        return None

    def complete(
            self,
            expected_pid,
            expected_uid,
            commit_admission):
        try:
            _validate_expected_peer(expected_pid, expected_uid)
            if not callable(commit_admission):
                _fail()
            if self._state == "completed":
                if (
                    expected_pid != self._completed_pid
                    or expected_uid != self._completed_uid
                ):
                    _fail()
                return self._result
            if self._state != "prepared":
                _fail()
            self._state = "completing"
            started = self._monotonic()
            if (
                type(started) not in (int, float)
                or not math.isfinite(started)
            ):
                _fail()
            deadline = (
                float(started)
                + PHASE5_BOOTSTRAP_TIMEOUT_SECONDS
            )

            _verify_bootstrap_directory_unchanged(
                bootstrap_directory=self._bootstrap_directory,
                expected_uid=self._controller_uid,
                expected_fingerprint=self._directory_fingerprint,
                lstat=self._lstat,
            )
            listener = self._listener
            _set_timeout(listener, deadline, self._monotonic)
            try:
                accepted = listener.accept()
            except (OSError, TimeoutError, TypeError, ValueError) as exc:
                _fail(exc)
            if (
                type(accepted) is not tuple
                or len(accepted) != 2
            ):
                _fail()
            peer = accepted[0]
            self._peer = peer

            _verify_bootstrap_directory_unchanged(
                bootstrap_directory=self._bootstrap_directory,
                expected_uid=self._controller_uid,
                expected_fingerprint=self._directory_fingerprint,
                lstat=self._lstat,
            )
            self._cleanup_listener(strict=True)

            try:
                credentials = peer.getsockopt(
                    socket.SOL_SOCKET,
                    _SO_PEERCRED,
                    _UCRED.size,
                )
                if type(credentials) is not bytes:
                    _fail()
                peer_pid, peer_uid, _peer_gid = _UCRED.unpack(
                    credentials
                )
            except Phase5CandidateBootstrapError:
                raise
            except (
                AttributeError,
                OSError,
                struct.error,
                TypeError,
                ValueError,
            ) as exc:
                _fail(exc)
            if (
                peer_pid != expected_pid
                or peer_uid != expected_uid
            ):
                _fail()

            identity = _strict_json(self._identity_raw)
            request_raw = _canonical({
                "schemaVersion": 1,
                "kind":
                    "phase5-candidate-capture-bootstrap-request",
                "identity": identity,
                "captureNonce": self._capture_nonce,
            }) + b"\n"
            if len(request_raw) > MAX_PHASE5_BOOTSTRAP_REQUEST_BYTES:
                _fail()
            _set_timeout(peer, deadline, self._monotonic)
            peer.sendall(request_raw)

            admission_raw = _read_unique_line(
                peer,
                deadline=deadline,
                monotonic=self._monotonic,
                maximum=MAX_PHASE5_BOOTSTRAP_ADMISSION_BYTES,
            )
            admission = _owned_valid_admission(
                admission_raw,
                expected_identity=identity,
                capture_nonce=self._capture_nonce,
            )
            admission_sha256 = hashlib.sha256(
                admission_raw
            ).hexdigest()

            commit_result = commit_admission(
                admission_raw=admission_raw,
                candidate_pid=peer_pid,
                candidate_uid=peer_uid,
                expected_identity=_strict_json(self._identity_raw),
            )
            if (
                not _exact_object(
                    commit_result,
                    _COMMIT_RESULT_FIELDS,
                )
                or type(commit_result["admissionSha256"])
                is not str
                or commit_result["admissionSha256"]
                != admission_sha256
            ):
                _fail()
            if self._state != "completing":
                _fail()
            _remaining(deadline, self._monotonic)
            receipt_challenge_raw = self._nonce_factory(32)
            if (
                type(receipt_challenge_raw) is not bytes
                or len(receipt_challenge_raw) != 32
            ):
                _fail()
            receipt_challenge = bytes(
                receipt_challenge_raw
            ).hex()

            ack_raw = _canonical({
                "schemaVersion": 1,
                "kind":
                    "phase5-candidate-capture-admission-ack",
                "admissionSha256": admission_sha256,
                "receiptChallenge": receipt_challenge,
            }) + b"\n"
            if len(ack_raw) > MAX_PHASE5_BOOTSTRAP_ACK_BYTES:
                _fail()
            _set_timeout(peer, deadline, self._monotonic)
            peer.sendall(ack_raw)
            receipt_raw = _read_to_eof(
                peer,
                deadline=deadline,
                monotonic=self._monotonic,
                maximum=MAX_PHASE5_BOOTSTRAP_RECEIPT_BYTES,
            )
            _validate_receipt(
                receipt_raw,
                admission_sha256=admission_sha256,
                receipt_challenge=receipt_challenge,
            )
            if self._wait_for_peer_close(
                peer,
                deadline,
                self._monotonic,
            ) is not True:
                _fail()
            _remaining(deadline, self._monotonic)

            result = Phase5CandidateBootstrapResult(
                admission=MappingProxyType(dict(admission)),
                admission_sha256=admission_sha256,
            )
            self._cleanup_peer()
            self._capture_nonce = None
            self._completed_pid = peer_pid
            self._completed_uid = peer_uid
            self._result = result
            self._state = "completed"
            return result
        except Phase5CandidateBootstrapError:
            if self._state != "completed":
                self._seal_failed()
            raise
        except Exception as exc:
            self._seal_failed()
            _fail(exc)
        except BaseException:
            self._seal_failed()
            raise


def _prepare_phase5_candidate_bootstrap(
        *,
        bootstrap_directory,
        expected_identity,
        socket_factory,
        monotonic,
        nonce_factory,
        lstat,
        chmod,
        unlink,
        geteuid,
        wait_for_peer_close):
    listener = None
    socket_state = None
    socket_path = None
    prepared = False
    try:
        identity, identity_raw = _owned_valid_identity(
            expected_identity
        )
        del identity
        socket_path, controller_uid, directory_fingerprint = (
            _verified_bootstrap_directory(
                bootstrap_directory=bootstrap_directory,
                lstat=lstat,
                geteuid=geteuid,
            )
        )
        nonce = nonce_factory(32)
        if type(nonce) is not bytes or len(nonce) != 32:
            _fail()
        capture_nonce = bytes(nonce).hex()

        listener = socket_factory()
        listener.bind(socket_path)
        socket_state = _owned_socket_inode(
            socket_path=socket_path,
            expected_uid=controller_uid,
            lstat=lstat,
        )
        chmod(socket_path, 0o600)
        secured_socket_state = _verify_bound_socket(
            socket_path=socket_path,
            expected_uid=controller_uid,
            lstat=lstat,
        )
        if not _same_inode(socket_state, secured_socket_state):
            _fail()
        socket_state = secured_socket_state
        listener.listen(1)
        handle = _Phase5CandidateBootstrapHandle(
            listener=listener,
            bootstrap_directory=bootstrap_directory,
            controller_uid=controller_uid,
            directory_fingerprint=directory_fingerprint,
            socket_path=socket_path,
            socket_state=socket_state,
            identity_raw=identity_raw,
            capture_nonce=capture_nonce,
            monotonic=monotonic,
            nonce_factory=nonce_factory,
            lstat=lstat,
            chmod=chmod,
            unlink=unlink,
            wait_for_peer_close=wait_for_peer_close,
        )
        prepared = True
        return handle
    except Phase5CandidateBootstrapError:
        raise
    except (
        AttributeError,
        OSError,
        OverflowError,
        RecursionError,
        RuntimeError,
        TypeError,
        UnicodeError,
        ValueError,
    ) as exc:
        _fail(exc)
    finally:
        if listener is not None and not prepared:
            try:
                listener.close()
            except Exception:
                pass
            if socket_path is not None and socket_state is not None:
                try:
                    _unlink_bound_socket(
                        socket_path=socket_path,
                        socket_state=socket_state,
                        lstat=lstat,
                        unlink=unlink,
                    )
                except Exception:
                    pass


def prepare_phase5_candidate_bootstrap_linux(
        bootstrap_directory,
        expected_identity):
    """Create the fixed one-shot listener using only production dependencies."""
    if not LINUX_AUTHORITY_AVAILABLE:
        _fail()
    return _prepare_phase5_candidate_bootstrap(
        bootstrap_directory=bootstrap_directory,
        expected_identity=expected_identity,
        socket_factory=lambda: socket.socket(
            socket.AF_UNIX,
            socket.SOCK_STREAM,
        ),
        monotonic=time.monotonic,
        nonce_factory=secrets.token_bytes,
        lstat=os.lstat,
        chmod=os.chmod,
        unlink=os.unlink,
        geteuid=os.geteuid,
        wait_for_peer_close=_wait_for_peer_close_linux,
    )
