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
import stat
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
BOOTSTRAP_CONTAINER_PATH = "/run/flock-phase5-bootstrap"
CANDIDATE_CONTAINER_PATH = "/run/flock-phase5-candidate"
CAPTURE_SOCKET_NAME = "capture.sock"
INTENT_RECORD_NAME = "intent.json"
ADMISSION_RECORD_NAME = "admission.json"
MAX_RECORD_BYTES = 64 * 1024
MAX_ADMISSION_BYTES = 4096
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
_BIND_MOUNTS_FIELDS = {"bootstrap", "candidate"}
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
        "_intent_path",
        "_intent_sha256",
        "_anchor_path",
        "_attempt_id",
        "_anchor_fd",
        "_registry_fd",
        "_attempt_fd",
        "_bootstrap_fd",
        "_candidate_fd",
        "_anchor_state",
        "_registry_state",
        "_attempt_state",
        "_bootstrap_state",
        "_candidate_state",
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
            intent_path: Path,
            intent_sha256: str,
            anchor_path: Path,
            attempt_id: str,
            anchor_fd: int | None,
            registry_fd: int | None,
            attempt_fd: int | None,
            bootstrap_fd: int | None,
            candidate_fd: int | None,
            anchor_state: _NodeState,
            registry_state: _NodeState,
            attempt_state: _NodeState,
            bootstrap_state: _NodeState,
            candidate_state: _NodeState,
            intent_state: _NodeState,
            authoritative: bool) -> None:
        values = {
            "_registry_root": registry_root,
            "_attempt_directory": attempt_directory,
            "_bootstrap_bind_source": bootstrap_bind_source,
            "_candidate_bind_source": candidate_bind_source,
            "_intent_path": intent_path,
            "_intent_sha256": intent_sha256,
            "_anchor_path": anchor_path,
            "_attempt_id": attempt_id,
            "_anchor_fd": anchor_fd,
            "_registry_fd": registry_fd,
            "_attempt_fd": attempt_fd,
            "_bootstrap_fd": bootstrap_fd,
            "_candidate_fd": candidate_fd,
            "_anchor_state": anchor_state,
            "_registry_state": registry_state,
            "_attempt_state": attempt_state,
            "_bootstrap_state": bootstrap_state,
            "_candidate_state": candidate_state,
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


class CommittedAdmission(NamedTuple):
    path: Path
    record_sha256: str
    admission_sha256: str


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
    buffer = bytearray()
    while True:
        chunk = os.read(
            descriptor,
            min(64 * 1024, MAX_RECORD_BYTES - len(buffer) + 1),
        )
        if not chunk:
            break
        buffer.extend(chunk)
        if len(buffer) > MAX_RECORD_BYTES:
            _fail()
    return bytes(buffer)


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
    }
    if admission_state is not None:
        expected[ADMISSION_RECORD_NAME] = ("file", admission_state)
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
            entries = {entry.name: entry for entry in iterator}
        if set(entries) != {CAPTURE_SOCKET_NAME}:
            _fail()
        observed = entries[CAPTURE_SOCKET_NAME].stat(
            follow_symlinks=False
        )
        current = os.stat(
            CAPTURE_SOCKET_NAME,
            dir_fd=value._candidate_fd,
            follow_symlinks=False,
        )
        _validate_capture_socket_state(observed)
        if (
            not _same_object(observed, current)
            or (
                expected_capture_state is not None
                and not _same_identity(
                    observed,
                    expected_capture_state,
                )
            )
        ):
            _fail()
        return _node_state(observed)
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
    ):
        _fail()
    fresh_anchor_fd = None
    try:
        anchor = os.fstat(value._anchor_fd)
        registry = os.fstat(value._registry_fd)
        attempt_state = os.fstat(value._attempt_fd)
        bootstrap = os.fstat(value._bootstrap_fd)
        candidate = os.fstat(value._candidate_fd)
        _validate_directory_state(anchor, private=True)
        _validate_directory_state(registry, private=True)
        _validate_directory_state(attempt_state, private=True)
        _validate_directory_state(bootstrap, private=True)
        _validate_directory_state(candidate, private=True)
        if any((
            not _same_identity(anchor, value._anchor_state),
            not _same_identity(registry, value._registry_state),
            not _same_identity(attempt_state, value._attempt_state),
            not _same_identity(bootstrap, value._bootstrap_state),
            not _same_identity(candidate, value._candidate_state),
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
        candidate_bind_source: Path) -> dict:
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

        attempt_directory = registry_root / attempt_id
        bootstrap_bind_source = (
            attempt_directory / BOOTSTRAP_BIND_SOURCE_NAME
        )
        candidate_bind_source = (
            attempt_directory / CANDIDATE_BIND_SOURCE_NAME
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
            ),
        )
        _inventory_at(
            attempt_fd,
            bootstrap_state=bootstrap_state,
            candidate_state=candidate_state,
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
            intent_path=intent_path,
            intent_sha256=hashlib.sha256(intent_raw).hexdigest(),
            anchor_path=anchor_path,
            attempt_id=attempt_id,
            anchor_fd=anchor_fd,
            registry_fd=registry_fd,
            attempt_fd=attempt_fd,
            bootstrap_fd=bootstrap_fd,
            candidate_fd=candidate_fd,
            anchor_state=anchor_state,
            registry_state=registry_state,
            attempt_state=attempt_state,
            bootstrap_state=bootstrap_state,
            candidate_state=candidate_state,
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
        return handle
    finally:
        _close_descriptors_noexcept([
            descriptor
            for descriptor in (
                intent_fd,
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
    intent_path = attempt_directory / INTENT_RECORD_NAME
    _create_private_directory_path(attempt_directory)
    bootstrap_state = _node_state(
        _create_private_directory_path(bootstrap_bind_source)
    )
    candidate_state = _node_state(
        _create_private_directory_path(candidate_bind_source)
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
        intent_state=intent_state,
        admission_state=None,
    )
    return CandidateAttemptLayout(
        registry_root=registry_root,
        attempt_directory=attempt_directory,
        bootstrap_bind_source=bootstrap_bind_source,
        candidate_bind_source=candidate_bind_source,
        intent_path=intent_path,
        intent_sha256=hashlib.sha256(intent_raw).hexdigest(),
        anchor_path=anchor_path,
        attempt_id=attempt_id,
        anchor_fd=None,
        registry_fd=None,
        attempt_fd=None,
        bootstrap_fd=None,
        candidate_fd=None,
        anchor_state=anchor_state,
        registry_state=registry_state,
        attempt_state=attempt_state,
        bootstrap_state=bootstrap_state,
        candidate_state=candidate_state,
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
            intent_state=attempt._intent_state,
            admission_state=None,
        )
        capture_state = _validate_runtime_bind_inventory(attempt)
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
            "schemaVersion": 1,
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
            intent_state=attempt._intent_state,
            admission_state=admission_state,
        )
        _validate_runtime_bind_inventory(
            attempt,
            expected_capture_state=capture_state,
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
            intent_state=attempt._intent_state,
            admission_state=admission_state,
        )
        _validate_runtime_bind_inventory(
            attempt,
            expected_capture_state=capture_state,
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
