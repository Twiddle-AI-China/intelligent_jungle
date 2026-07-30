#!/usr/bin/env python3
"""Capture host-owned machine identity and controller-owned staging evidence."""
from __future__ import annotations

import argparse
import base64
import ctypes
import errno
import hashlib
import importlib.util
import json
import os
import platform
import re
import socket
import stat
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

try:
    from validate_phase5_acceptance import (
        AcceptanceError,
        PHASE5_RAW_ARTIFACTS,
        canonical,
        canonical_machine_addresses,
        fault_session_binding_from_bytes,
        memory_class_bytes,
        parse_meminfo_bytes,
        phase5_raw_manifest_from_blobs,
        validate_attestation,
        validate_phase5_fault_run_binding_v2,
        validate_phase5_raw_manifest_bytes,
        validate_phase5_raw_manifest_structure,
        validate_phase5_species_load_samples_bytes,
    )
except ModuleNotFoundError:
    _spec = importlib.util.spec_from_file_location(
        "validate_phase5_acceptance",
        Path(__file__).with_name("validate_phase5_acceptance.py"),
    )
    _validator = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_validator)
    AcceptanceError = _validator.AcceptanceError
    PHASE5_RAW_ARTIFACTS = _validator.PHASE5_RAW_ARTIFACTS
    canonical = _validator.canonical
    canonical_machine_addresses = _validator.canonical_machine_addresses
    fault_session_binding_from_bytes = (
        _validator.fault_session_binding_from_bytes
    )
    memory_class_bytes = _validator.memory_class_bytes
    parse_meminfo_bytes = _validator.parse_meminfo_bytes
    phase5_raw_manifest_from_blobs = (
        _validator.phase5_raw_manifest_from_blobs
    )
    validate_attestation = _validator.validate_attestation
    validate_phase5_fault_run_binding_v2 = (
        _validator.validate_phase5_fault_run_binding_v2
    )
    validate_phase5_raw_manifest_bytes = (
        _validator.validate_phase5_raw_manifest_bytes
    )
    validate_phase5_raw_manifest_structure = (
        _validator.validate_phase5_raw_manifest_structure
    )
    validate_phase5_species_load_samples_bytes = (
        _validator.validate_phase5_species_load_samples_bytes
    )


STAGING_OUTPUT_NAME = "staging-machine-attestation.json"
STAGING_EVIDENCE_NAME = "staging-machine-attestation.evidence"
STAGING_MARKER_NAME = (
    ".staging-machine-attestation.capture-transaction.json"
)
STAGING_TEMP_NAME = ".staging-machine-attestation.evidence.partial"
STAGING_QUARANTINE_NAME = (
    ".staging-machine-attestation.evidence.quarantine"
)
FAULT_SESSION_EVIDENCE_NAME = "fault-session-attestation.json"

COMMON_EVIDENCE_FILES = (
    "machine-id",
    "ssh-host-ed25519.pub",
    "interfaces.json",
    "gpus.txt",
    "cuda-driver.txt",
    "torch.json",
    "available-memory.txt",
    "architecture.txt",
    "vllm-normal-profile.json",
    "vllm-burst-profile.json",
)
HOST_EVIDENCE_FILES = COMMON_EVIDENCE_FILES[:-2]
STAGING_EVIDENCE_FILES = tuple(sorted(
    (*COMMON_EVIDENCE_FILES, FAULT_SESSION_EVIDENCE_NAME)
))
_RESERVED_NAMES = frozenset({
    STAGING_OUTPUT_NAME,
    STAGING_EVIDENCE_NAME,
    STAGING_MARKER_NAME,
    STAGING_TEMP_NAME,
    STAGING_QUARANTINE_NAME,
})
_HEX64 = re.compile(r"[0-9a-f]{64}")
_MAX_EVIDENCE_BYTES = 128 * 1024 * 1024
_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
_RENAME_NOREPLACE = 1


class CaptureError(RuntimeError):
    pass


class StagingAttestationSnapshot(NamedTuple):
    output_raw: bytes
    output_sha256: str
    evidence_blobs: tuple[tuple[str, bytes], ...]
    evidence_inventory: tuple[tuple[str, str], ...]
    evidence_inventory_sha256: str


class _StableDirectoryState(NamedTuple):
    device: int
    inode: int
    file_type: int
    mode: int
    uid: int
    gid: int


class _NodeState(NamedTuple):
    device: int
    inode: int
    file_type: int
    mode: int
    uid: int
    gid: int
    nlink: int
    size: int
    mtime_ns: int
    ctime_ns: int


class _FinalEvidenceRead(NamedTuple):
    blobs: tuple[tuple[str, bytes], ...]
    directory_state: _NodeState
    leaf_states: tuple[tuple[str, _NodeState], ...]


class _OwnedStagingInputs(NamedTuple):
    capture_intent_sha256: str
    session_raw: bytes
    expected_full_run_binding: dict
    normal_profile_raw: bytes
    burst_profile_raw: bytes
    manifest_raw: bytes
    manifest_sha256: str
    raw_blobs: tuple[tuple[str, bytes], ...]


class _HeldReleaseRoot:
    __slots__ = (
        "__chain_fds",
        "__chain_names",
        "__chain_states",
        "__closed",
    )

    def __init__(
            self,
            chain_fds: tuple[int, ...],
            chain_names: tuple[str, ...],
            chain_states: tuple[_StableDirectoryState, ...]):
        self.__chain_fds = chain_fds
        self.__chain_names = chain_names
        self.__chain_states = chain_states
        self.__closed = False

    def close(self) -> None:
        if self.__closed:
            return
        self.__closed = True
        for fd in reversed(self.__chain_fds):
            try:
                os.close(fd)
            except OSError:
                pass

    def __enter__(self):
        if self.__closed:
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def command_bytes(args: list[str]) -> bytes:
    try:
        return subprocess.run(
            args,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def ssh_fingerprint(public_key: bytes) -> str:
    try:
        parts = public_key.strip().split()
        if parts[0] != b"ssh-ed25519":
            raise ValueError
        decoded = base64.b64decode(parts[1], validate=True)
    except (IndexError, ValueError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    return (
        "SHA256:"
        + base64.b64encode(hashlib.sha256(decoded).digest())
        .decode()
        .rstrip("=")
    )


def interface_addresses(raw: bytes) -> list[str]:
    try:
        records = json.loads(raw)
        addresses = [
            item["local"]
            for interface in records
            for item in interface.get("addr_info", [])
            if "local" in item
        ]
    except (UnicodeError, json.JSONDecodeError, TypeError, KeyError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    return canonical_machine_addresses(addresses)


def _require_linux() -> None:
    if os.name != "posix" or not sys.platform.startswith("linux"):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")


def _capture_fixed_production_host_evidence() -> dict[str, bytes]:
    _require_linux()
    try:
        machine = Path("/etc/machine-id").read_bytes()
        ssh_key = Path("/etc/ssh/ssh_host_ed25519_key.pub").read_bytes()
        memory = Path("/proc/meminfo").read_bytes()
    except (OSError, PermissionError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    architecture = platform.machine().lower()
    return {
        "machine-id": machine,
        "ssh-host-ed25519.pub": ssh_key,
        "interfaces.json":
            command_bytes(["ip", "-j", "address", "show"]),
        "gpus.txt": command_bytes([
            "nvidia-smi",
            "--query-gpu=uuid",
            "--format=csv,noheader",
        ]),
        "cuda-driver.txt": command_bytes([
            "nvidia-smi",
            "--query-gpu=driver_version,name,memory.total",
            "--format=csv,noheader",
        ]),
        "torch.json": command_bytes([
            "python3",
            "-c",
            "import json,torch; print(json.dumps({"
            "'version':torch.__version__,'cuda':torch.version.cuda,"
            "'available':torch.cuda.is_available()}))",
        ]),
        "available-memory.txt": memory,
        "architecture.txt": (architecture + "\n").encode(),
    }


def _capture_fixed_staging_host_evidence() -> dict[str, bytes]:
    return _capture_fixed_production_host_evidence()


def _own_host_evidence(value: object) -> dict[str, bytes]:
    if type(value) is not dict or set(value) != set(HOST_EVIDENCE_FILES):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    owned = {}
    for name in HOST_EVIDENCE_FILES:
        body = value[name]
        if type(body) is not bytes or not 1 <= len(body) <= _MAX_EVIDENCE_BYTES:
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        owned[name] = bytes(body)
    return owned


def _attestation_value(
        blobs: dict[str, bytes],
        role: str,
        run_binding: dict | None,
        *,
        include_hostname: bool) -> dict:
    expected = (
        set(COMMON_EVIDENCE_FILES)
        if role == "production-baseline"
        else set(STAGING_EVIDENCE_FILES)
    )
    if type(blobs) is not dict or set(blobs) != expected:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    try:
        addresses = interface_addresses(blobs["interfaces.json"])
        gpu_uuids = sorted(set(
            line.strip()
            for line in blobs["gpus.txt"].decode().splitlines()
            if line.strip()
        ))
        driver_version, gpu_model, _gpu_memory = [
            item.strip()
            for item in blobs["cuda-driver.txt"]
            .decode()
            .splitlines()[0]
            .split(",", 2)
        ]
        torch_value = json.loads(blobs["torch.json"])
        total_memory_bytes, available_memory_bytes = parse_meminfo_bytes(
            blobs["available-memory.txt"]
        )
        architecture = blobs["architecture.txt"].decode().strip().lower()
        if architecture == "arm64":
            architecture = "aarch64"
        if (
                not addresses
                or not gpu_uuids
                or not driver_version
                or not gpu_model
                or torch_value.get("available") is not True
                or type(torch_value.get("version")) is not str
                or type(torch_value.get("cuda")) is not str
                or architecture != "aarch64"
                or available_memory_bytes <= 0):
            raise ValueError
    except (
            AcceptanceError,
            IndexError,
            json.JSONDecodeError,
            KeyError,
            TypeError,
            UnicodeError,
            ValueError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    value = {
        "schemaVersion": 2,
        "attestationRole": role,
        "runBinding": run_binding,
        "machineIdSha256": digest(blobs["machine-id"]),
        "sshHostKeySha256": ssh_fingerprint(
            blobs["ssh-host-ed25519.pub"]
        ),
        "canonicalInterfaceAddresses": addresses,
        "gpuUuids": gpu_uuids,
        "platform": {
            "architecture": architecture,
            "gpuModel": gpu_model,
            "driverVersion": driver_version,
            "torchVersion": torch_value["version"],
            "cudaVersion": torch_value["cuda"],
            "cudaAvailable": True,
            "availableMemoryBytes": available_memory_bytes,
            "totalMemoryBytes": total_memory_bytes,
            "memoryClassBytes": memory_class_bytes(total_memory_bytes),
        },
        "rawEvidence": {
            "machineId": digest(blobs["machine-id"]),
            "sshHostKey": digest(blobs["ssh-host-ed25519.pub"]),
            "interfaces": digest(blobs["interfaces.json"]),
            "gpus": digest(blobs["gpus.txt"]),
        },
        "environmentEvidence": {
            "cudaDriver": digest(blobs["cuda-driver.txt"]),
            "torch": digest(blobs["torch.json"]),
            "availableMemory": digest(blobs["available-memory.txt"]),
            "architecture": digest(blobs["architecture.txt"]),
            "vllmNormalProfile":
                digest(blobs["vllm-normal-profile.json"]),
            "vllmBurstProfile":
                digest(blobs["vllm-burst-profile.json"]),
        },
    }
    if include_hostname:
        value["hostname"] = socket.gethostname()
    try:
        validate_attestation(value)
    except AcceptanceError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    return value


def _stable_directory_state(value: os.stat_result) -> _StableDirectoryState:
    return _StableDirectoryState(
        value.st_dev,
        value.st_ino,
        stat.S_IFMT(value.st_mode),
        stat.S_IMODE(value.st_mode),
        value.st_uid,
        value.st_gid,
    )


def _node_state(value: os.stat_result) -> _NodeState:
    return _NodeState(
        value.st_dev,
        value.st_ino,
        stat.S_IFMT(value.st_mode),
        stat.S_IMODE(value.st_mode),
        value.st_uid,
        value.st_gid,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _open_directory_at(directory_fd: int, name: str) -> int:
    flags = (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_CLOEXEC
        | os.O_NOFOLLOW
    )
    return os.open(name, flags, dir_fd=directory_fd)


def _open_staging_release_root(release_root: Path) -> _HeldReleaseRoot:
    _require_linux()
    path = Path(release_root)
    if (
            not path.is_absolute()
            or len(path.parts) < 3
            or any(
                component in {"", ".", ".."}
                for component in path.parts[1:]
            )):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    components = path.parts[1:]
    chain_fds = []
    try:
        chain_fds.append(os.open(
            "/",
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
        ))
        for component in components:
            chain_fds.append(_open_directory_at(chain_fds[-1], component))
        chain_states = tuple(
            _stable_directory_state(os.fstat(fd))
            for fd in chain_fds
        )
        effective_uid = os.geteuid()
        effective_gid = os.getegid()
        if (
                any(item.file_type != stat.S_IFDIR
                    for item in chain_states)
                or any(
                    item.uid != effective_uid
                    or item.gid != effective_gid
                    for item in chain_states[-2:]
                )
                or any(
                    _stable_directory_state(os.stat(
                        name,
                        dir_fd=chain_fds[index],
                        follow_symlinks=False,
                    )) != chain_states[index + 1]
                    for index, name in enumerate(components)
                )):
            raise OSError(errno.EPERM, "untrusted release root")
        return _HeldReleaseRoot(
            tuple(chain_fds),
            tuple(components),
            chain_states,
        )
    except (OSError, TypeError, ValueError) as exc:
        for fd in reversed(chain_fds):
            try:
                os.close(fd)
            except OSError:
                pass
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def _held_values(
        held_release_root: _HeldReleaseRoot,
) -> tuple[int, _StableDirectoryState]:
    if (
            type(held_release_root) is not _HeldReleaseRoot
            or held_release_root._HeldReleaseRoot__closed):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    try:
        chain_fds = held_release_root._HeldReleaseRoot__chain_fds
        chain_names = held_release_root._HeldReleaseRoot__chain_names
        chain_states = held_release_root._HeldReleaseRoot__chain_states
        if (
                len(chain_fds) != len(chain_states)
                or len(chain_names) + 1 != len(chain_fds)
                or any(
                    _stable_directory_state(os.fstat(fd)) != state
                    for fd, state in zip(
                        chain_fds,
                        chain_states,
                        strict=True,
                    )
                )
                or any(
                    _stable_directory_state(os.stat(
                        name,
                        dir_fd=chain_fds[index],
                        follow_symlinks=False,
                    )) != chain_states[index + 1]
                    for index, name in enumerate(chain_names)
                )):
            raise OSError(errno.ESTALE, "held release root drift")
        return chain_fds[-1], chain_states[-1]
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def _own_staging_inputs(
        capture_intent_sha256: object,
        session_raw: object,
        expected_full_run_binding: object,
        normal_profile_raw: object,
        burst_profile_raw: object,
        raw_manifest_bundle: object) -> _OwnedStagingInputs:
    try:
        if (
                type(capture_intent_sha256) is not str
                or _HEX64.fullmatch(capture_intent_sha256) is None
                or type(session_raw) is not bytes
                or not 1 <= len(session_raw) <= _MAX_EVIDENCE_BYTES
                or type(normal_profile_raw) is not bytes
                or not 1 <= len(normal_profile_raw) <= _MAX_EVIDENCE_BYTES
                or type(burst_profile_raw) is not bytes
                or not 1 <= len(burst_profile_raw) <= _MAX_EVIDENCE_BYTES):
            raise ValueError
        owned_session = bytes(session_raw)
        owned_normal = bytes(normal_profile_raw)
        owned_burst = bytes(burst_profile_raw)
        full_binding = validate_phase5_fault_run_binding_v2(
            expected_full_run_binding
        )
        recomputed_binding = fault_session_binding_from_bytes(owned_session)
        if (
                recomputed_binding != full_binding
                or digest(owned_session)
                   != full_binding["faultSessionEvidenceSha256"]):
            raise ValueError
        if (
                type(raw_manifest_bundle) is not dict
                or set(raw_manifest_bundle)
                   != {"manifest", "manifestRaw",
                       "manifestSha256", "blobs"}
                or type(raw_manifest_bundle["manifest"]) is not dict
                or type(raw_manifest_bundle["manifestRaw"]) is not bytes
                or type(raw_manifest_bundle["manifestSha256"]) is not str
                or _HEX64.fullmatch(
                    raw_manifest_bundle["manifestSha256"]
                ) is None
                or type(raw_manifest_bundle["blobs"]) is not dict):
            raise ValueError
        manifest_raw = bytes(raw_manifest_bundle["manifestRaw"])
        manifest_sha256 = raw_manifest_bundle["manifestSha256"]
        binding = {
            name: full_binding[name]
            for name in (
                "runId", "challenge", "release", "geometry", "profile"
            )
        }
        parsed_manifest = validate_phase5_raw_manifest_bytes(
            manifest_raw,
            binding,
        )
        claimed_manifest = validate_phase5_raw_manifest_structure(
            raw_manifest_bundle["manifest"],
            binding,
        )
        if canonical(claimed_manifest) != manifest_raw:
            raise ValueError
        expected_blob_names = {
            name for name, _path in PHASE5_RAW_ARTIFACTS
        }
        claimed_blobs = raw_manifest_bundle["blobs"]
        if set(claimed_blobs) != expected_blob_names:
            raise ValueError
        owned_blobs = {}
        for name, _path in PHASE5_RAW_ARTIFACTS:
            body = claimed_blobs[name]
            if (
                    type(body) is not bytes
                    or not 1 <= len(body) <= _MAX_EVIDENCE_BYTES):
                raise ValueError
            owned_blobs[name] = bytes(body)
        if (
                digest(manifest_raw) != manifest_sha256
                or manifest_sha256 != full_binding["rawManifestSha256"]):
            raise ValueError
        for item, (name, path) in zip(
                parsed_manifest["artifacts"],
                PHASE5_RAW_ARTIFACTS,
                strict=True):
            body = owned_blobs[name]
            if (
                    item["artifact"] != name
                    or item["path"] != path
                    or item["byteLength"] != len(body)
                    or item["sha256"] != digest(body)):
                raise ValueError
        rebuilt_manifest = phase5_raw_manifest_from_blobs(
            binding,
            parsed_manifest["window"],
            owned_blobs,
        )
        if canonical(rebuilt_manifest) != manifest_raw:
            raise ValueError
        if (
                owned_normal
                   != owned_blobs["speciesNormalSamplesSha256"]
                or owned_burst
                   != owned_blobs["speciesBurstSamplesSha256"]):
            raise ValueError
        validate_phase5_species_load_samples_bytes(
            owned_normal,
            binding,
            "normal",
        )
        validate_phase5_species_load_samples_bytes(
            owned_burst,
            binding,
            "burst",
        )
        return _OwnedStagingInputs(
            capture_intent_sha256,
            owned_session,
            full_binding,
            owned_normal,
            owned_burst,
            manifest_raw,
            manifest_sha256,
            tuple(sorted(owned_blobs.items())),
        )
    except (
            AcceptanceError,
            AttributeError,
            KeyError,
            OverflowError,
            RecursionError,
            RuntimeError,
            TypeError,
            UnicodeError,
            ValueError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def _write_all(fd: int, body: bytes) -> None:
    offset = 0
    while offset < len(body):
        written = os.write(fd, body[offset:])
        if written <= 0:
            raise OSError(errno.EIO, "short write")
        offset += written


def _write_exclusive_file_at(
        directory_fd: int,
        name: str,
        body: bytes,
        mode: int = 0o400) -> _NodeState:
    if (
            type(name) is not str
            or name in {"", ".", ".."}
            or "/" in name
            or type(body) is not bytes
            or mode != 0o400):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    fd = -1
    try:
        fd = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL
            | os.O_CLOEXEC | os.O_NOFOLLOW,
            mode,
            dir_fd=directory_fd,
        )
        os.fchmod(fd, mode)
        _write_all(fd, body)
        os.fsync(fd)
        state = _node_state(os.fstat(fd))
        linked = _node_state(os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        ))
        if (
                state != linked
                or state.file_type != stat.S_IFREG
                or state.mode != mode
                or state.uid != os.geteuid()
                or state.gid != os.getegid()
                or state.nlink != 1
                or state.size != len(body)):
            raise OSError(errno.ESTALE, "exclusive file drift")
        return state
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def _mkdir_exclusive_at(
        directory_fd: int,
        name: str) -> tuple[int, _NodeState]:
    fd = -1
    try:
        os.mkdir(name, 0o700, dir_fd=directory_fd)
        fd = _open_directory_at(directory_fd, name)
        os.fchmod(fd, 0o700)
        state = _node_state(os.fstat(fd))
        linked = _node_state(os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        ))
        if (
                state != linked
                or state.file_type != stat.S_IFDIR
                or state.mode != 0o700
                or state.uid != os.geteuid()
                or state.gid != os.getegid()
                or state.nlink != 2):
            raise OSError(errno.ESTALE, "exclusive directory drift")
        return fd, state
    except OSError as exc:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def _production_publish(
        output: Path,
        blobs: dict[str, bytes],
        output_raw: bytes) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    parent_fd = -1
    evidence_fd = -1
    try:
        parent_fd = os.open(
            output.parent,
            os.O_RDONLY | os.O_DIRECTORY
            | os.O_CLOEXEC | os.O_NOFOLLOW,
        )
        evidence_name = output.with_suffix(".evidence").name
        evidence_fd, _state = _mkdir_exclusive_at(
            parent_fd,
            evidence_name,
        )
        for name in sorted(blobs):
            _write_exclusive_file_at(evidence_fd, name, blobs[name])
        os.fsync(evidence_fd)
        _write_exclusive_file_at(parent_fd, output.name, output_raw)
        os.fsync(parent_fd)
    except CaptureError:
        raise
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_OUTPUT_EXISTS") from exc
    finally:
        for fd in (evidence_fd, parent_fd):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass


def _rename_noreplace(
        source_dir_fd: int,
        source_name: str,
        destination_dir_fd: int,
        destination_name: str) -> None:
    _require_linux()
    if any(
            type(name) is not str
            or name in {"", ".", ".."}
            or "/" in name
            for name in (source_name, destination_name)):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    source_raw = os.fsencode(source_name)
    destination_raw = os.fsencode(destination_name)
    libc = ctypes.CDLL(None, use_errno=True)
    result = -1
    try:
        renameat2 = libc.renameat2
    except AttributeError:
        machine = os.uname().machine.lower()
        syscall_number = {
            "x86_64": 316,
            "amd64": 316,
            "aarch64": 276,
            "arm64": 276,
        }.get(machine)
        if syscall_number is None:
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        libc.syscall.restype = ctypes.c_long
        result = libc.syscall(
            ctypes.c_long(syscall_number),
            ctypes.c_int(source_dir_fd),
            ctypes.c_char_p(source_raw),
            ctypes.c_int(destination_dir_fd),
            ctypes.c_char_p(destination_raw),
            ctypes.c_uint(_RENAME_NOREPLACE),
        )
    else:
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        result = renameat2(
            source_dir_fd,
            source_raw,
            destination_dir_fd,
            destination_raw,
            _RENAME_NOREPLACE,
        )
    if result != 0:
        error = ctypes.get_errno()
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from OSError(
            error,
            os.strerror(error),
        )


def _validate_regular_state(
        state: _NodeState,
        *,
        mode: int = 0o400) -> None:
    if (
            state.file_type != stat.S_IFREG
            or state.mode != mode
            or state.uid != os.geteuid()
            or state.gid != os.getegid()
            or state.nlink != 1
            or state.size < 0):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")


def _read_regular_at(
        directory_fd: int,
        name: str,
        *,
        max_bytes: int = _MAX_EVIDENCE_BYTES) -> tuple[bytes, _NodeState]:
    fd = -1
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
            | os.O_NONBLOCK,
            dir_fd=directory_fd,
        )
        before = _node_state(os.fstat(fd))
        _validate_regular_state(before)
        if before.size > max_bytes:
            raise OSError(errno.EFBIG, "evidence too large")
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, min(1024 * 1024, max_bytes + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > max_bytes:
                raise OSError(errno.EFBIG, "evidence too large")
        body = b"".join(chunks)
        after = _node_state(os.fstat(fd))
        linked = _node_state(os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        ))
        if (
                before != after
                or after != linked
                or len(body) != after.size):
            raise OSError(errno.ESTALE, "evidence drift")
        return body, after
    except CaptureError:
        raise
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def _open_verified_directory_at(
        directory_fd: int,
        name: str) -> tuple[int, _NodeState]:
    fd = -1
    try:
        fd = _open_directory_at(directory_fd, name)
        state = _node_state(os.fstat(fd))
        linked = _node_state(os.stat(
            name,
            dir_fd=directory_fd,
            follow_symlinks=False,
        ))
        if (
                state != linked
                or state.file_type != stat.S_IFDIR
                or state.mode != 0o700
                or state.uid != os.geteuid()
                or state.gid != os.getegid()
                or state.nlink != 2):
            raise OSError(errno.ESTALE, "directory drift")
        return fd, state
    except OSError as exc:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def _stable_from_node(state: _NodeState) -> _StableDirectoryState:
    return _StableDirectoryState(
        state.device,
        state.inode,
        state.file_type,
        state.mode,
        state.uid,
        state.gid,
    )


def _reserved_namespace(root_fd: int) -> set[str]:
    try:
        entries = os.listdir(root_fd)
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    if len(entries) != len(set(entries)):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    for name in entries:
        lowered = name.casefold()
        is_reserved_prefix = (
            lowered.startswith("staging-machine-attestation")
            or lowered.startswith(".staging-machine-attestation")
        )
        if is_reserved_prefix and name not in _RESERVED_NAMES:
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    return set(entries).intersection(_RESERVED_NAMES)


def _transaction_marker_raw(
        root_state: _StableDirectoryState,
        owned: _OwnedStagingInputs) -> bytes:
    return canonical({
        "schemaVersion": 1,
        "kind": "staging-machine-attestation-capture-transaction",
        "captureIntentSha256": owned.capture_intent_sha256,
        "sessionSha256": digest(owned.session_raw),
        "releaseRoot": {
            "device": root_state.device,
            "inode": root_state.inode,
        },
    })


def _verify_marker(
        root_fd: int,
        expected_raw: bytes,
        expected_state: _NodeState | None = None,
) -> _NodeState:
    actual, state = _read_regular_at(
        root_fd,
        STAGING_MARKER_NAME,
        max_bytes=64 * 1024,
    )
    if (
            actual != expected_raw
            or (
                expected_state is not None
                and state != expected_state
            )):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    return state


def _unlink_verified_file_at(
        directory_fd: int,
        name: str,
        expected_raw: bytes,
        expected_state: _NodeState | None = None,
) -> None:
    fd = -1
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
            | os.O_NONBLOCK,
            dir_fd=directory_fd,
        )
        before = _node_state(os.fstat(fd))
        _validate_regular_state(before)
        if expected_state is not None and before != expected_state:
            raise OSError(errno.ESTALE, "marker identity drift")
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 64 * 1024 + 1 - total)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > 64 * 1024:
                raise OSError(errno.EFBIG, "marker too large")
        if (
                b"".join(chunks) != expected_raw
                or _node_state(os.fstat(fd)) != before
                or _node_state(os.stat(
                    name,
                    dir_fd=directory_fd,
                    follow_symlinks=False,
                )) != before):
            raise OSError(errno.ESTALE, "marker drift")
        os.unlink(name, dir_fd=directory_fd)
        after_unlink = _node_state(os.fstat(fd))
        if (
                after_unlink.device != before.device
                or after_unlink.inode != before.inode
                or after_unlink.file_type != before.file_type
                or after_unlink.nlink != 0):
            raise OSError(errno.ESTALE, "marker unlink drift")
        os.fsync(directory_fd)
    except CaptureError:
        raise
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def _open_verified_partial(
        root_fd: int,
        name: str) -> tuple[int, _NodeState]:
    directory_fd, directory_state = _open_verified_directory_at(
        root_fd,
        name,
    )
    try:
        entries = os.listdir(directory_fd)
        if (
                len(entries) != len(set(entries))
                or not set(entries).issubset(STAGING_EVIDENCE_FILES)):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        for entry in sorted(entries):
            _read_regular_at(directory_fd, entry)
        after_entries = os.listdir(directory_fd)
        if (
                len(after_entries) != len(entries)
                or set(after_entries) != set(entries)
                or _stable_from_node(_node_state(os.fstat(directory_fd)))
                   != _stable_from_node(directory_state)
                or _stable_from_node(_node_state(os.stat(
                    name,
                    dir_fd=root_fd,
                    follow_symlinks=False,
                ))) != _stable_from_node(directory_state)):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        return directory_fd, directory_state
    except BaseException:
        try:
            os.close(directory_fd)
        except OSError:
            pass
        raise


def _unlink_partial_leaf_at(
        directory_fd: int,
        name: str) -> None:
    fd = -1
    try:
        fd = os.open(
            name,
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
            | os.O_NONBLOCK,
            dir_fd=directory_fd,
        )
        before = _node_state(os.fstat(fd))
        _validate_regular_state(before)
        if _node_state(os.stat(
                name,
                dir_fd=directory_fd,
                follow_symlinks=False)) != before:
            raise OSError(errno.ESTALE, "partial leaf drift")
        os.unlink(name, dir_fd=directory_fd)
        after = _node_state(os.fstat(fd))
        if (
                after.device != before.device
                or after.inode != before.inode
                or after.file_type != before.file_type
                or after.nlink != 0):
            raise OSError(errno.ESTALE, "partial leaf unlink drift")
        os.fsync(directory_fd)
    except CaptureError:
        raise
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def _remove_verified_quarantine(
        root_fd: int,
        quarantine_fd: int,
        quarantine_state: _NodeState) -> None:
    try:
        entries = os.listdir(quarantine_fd)
        if (
                len(entries) != len(set(entries))
                or not set(entries).issubset(STAGING_EVIDENCE_FILES)):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        for name in sorted(entries):
            if (
                    _stable_from_node(_node_state(
                        os.fstat(quarantine_fd)))
                    != _stable_from_node(quarantine_state)
                    or _stable_from_node(_node_state(os.stat(
                        STAGING_QUARANTINE_NAME,
                        dir_fd=root_fd,
                        follow_symlinks=False,
                    ))) != _stable_from_node(quarantine_state)):
                raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
            _unlink_partial_leaf_at(quarantine_fd, name)
        if os.listdir(quarantine_fd):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        if (
                _stable_from_node(_node_state(os.fstat(quarantine_fd)))
                != _stable_from_node(quarantine_state)
                or _stable_from_node(_node_state(os.stat(
                    STAGING_QUARANTINE_NAME,
                    dir_fd=root_fd,
                    follow_symlinks=False,
                ))) != _stable_from_node(quarantine_state)):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        os.rmdir(STAGING_QUARANTINE_NAME, dir_fd=root_fd)
        after = _node_state(os.fstat(quarantine_fd))
        if (
                after.device != quarantine_state.device
                or after.inode != quarantine_state.inode
                or after.file_type != stat.S_IFDIR
                or after.nlink != 0):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        os.fsync(root_fd)
    except CaptureError:
        raise
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def _recover_private_state(
        root_fd: int,
        root_state: _StableDirectoryState,
        owned: _OwnedStagingInputs,
        namespace: set[str]) -> None:
    expected_marker = _transaction_marker_raw(root_state, owned)
    if STAGING_MARKER_NAME not in namespace:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    marker_state = _verify_marker(root_fd, expected_marker)
    has_temp = STAGING_TEMP_NAME in namespace
    has_quarantine = STAGING_QUARANTINE_NAME in namespace
    if has_temp and has_quarantine:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    partial_fd = -1
    try:
        if has_temp:
            partial_fd, partial_state = _open_verified_partial(
                root_fd,
                STAGING_TEMP_NAME,
            )
            _rename_noreplace(
                root_fd,
                STAGING_TEMP_NAME,
                root_fd,
                STAGING_QUARANTINE_NAME,
            )
            os.fsync(root_fd)
            if (
                    _stable_from_node(_node_state(os.fstat(partial_fd)))
                    != _stable_from_node(partial_state)
                    or _stable_from_node(_node_state(os.stat(
                        STAGING_QUARANTINE_NAME,
                        dir_fd=root_fd,
                        follow_symlinks=False,
                    ))) != _stable_from_node(partial_state)):
                raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
            _remove_verified_quarantine(
                root_fd,
                partial_fd,
                partial_state,
            )
        elif has_quarantine:
            partial_fd, partial_state = _open_verified_partial(
                root_fd,
                STAGING_QUARANTINE_NAME,
            )
            _remove_verified_quarantine(
                root_fd,
                partial_fd,
                partial_state,
            )
    finally:
        if partial_fd >= 0:
            try:
                os.close(partial_fd)
            except OSError:
                pass
    _unlink_verified_file_at(
        root_fd,
        STAGING_MARKER_NAME,
        expected_marker,
        marker_state,
    )


def _read_final_evidence(
        root_fd: int) -> _FinalEvidenceRead:
    evidence_fd = -1
    try:
        evidence_fd, before = _open_verified_directory_at(
            root_fd,
            STAGING_EVIDENCE_NAME,
        )
        entries = os.listdir(evidence_fd)
        if (
                len(entries) != len(set(entries))
                or set(entries) != set(STAGING_EVIDENCE_FILES)):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        leaf_reads = tuple(
            (name, *_read_regular_at(evidence_fd, name))
            for name in STAGING_EVIDENCE_FILES
        )
        blobs = tuple(
            (name, body)
            for name, body, _state in leaf_reads
        )
        leaf_states = tuple(
            (name, state)
            for name, _body, state in leaf_reads
        )
        after_entries = os.listdir(evidence_fd)
        after = _node_state(os.fstat(evidence_fd))
        linked = _node_state(os.stat(
            STAGING_EVIDENCE_NAME,
            dir_fd=root_fd,
            follow_symlinks=False,
        ))
        if (
                len(after_entries) != len(entries)
                or set(after_entries) != set(entries)
                or before != after
                or after != linked):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        return _FinalEvidenceRead(
            blobs,
            after,
            leaf_states,
        )
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    finally:
        if evidence_fd >= 0:
            try:
                os.close(evidence_fd)
            except OSError:
                pass


def _verify_created_leaf_states(
        directory_fd: int,
        expected: tuple[tuple[str, _NodeState], ...]) -> None:
    try:
        entries = os.listdir(directory_fd)
        observed = tuple(
            (
                name,
                _node_state(os.stat(
                    name,
                    dir_fd=directory_fd,
                    follow_symlinks=False,
                )),
            )
            for name, _state in expected
        )
        if (
                len(entries) != len(set(entries))
                or tuple(name for name, _state in expected)
                   != STAGING_EVIDENCE_FILES
                or set(entries) != set(STAGING_EVIDENCE_FILES)
                or observed != expected):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def _staging_output_from_evidence(
        evidence_blobs: tuple[tuple[str, bytes], ...],
        owned: _OwnedStagingInputs) -> bytes:
    if (
            tuple(name for name, _body in evidence_blobs)
            != STAGING_EVIDENCE_FILES):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    blobs = dict(evidence_blobs)
    binding = owned.expected_full_run_binding
    raw_binding = {
        name: binding[name]
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    try:
        recomputed = fault_session_binding_from_bytes(
            blobs[FAULT_SESSION_EVIDENCE_NAME]
        )
        if (
                blobs[FAULT_SESSION_EVIDENCE_NAME] != owned.session_raw
                or recomputed != binding
                or digest(blobs[FAULT_SESSION_EVIDENCE_NAME])
                   != binding["faultSessionEvidenceSha256"]
                or blobs["vllm-normal-profile.json"]
                   != owned.normal_profile_raw
                or blobs["vllm-burst-profile.json"]
                   != owned.burst_profile_raw):
            raise ValueError
        validate_phase5_fault_run_binding_v2(binding)
        validate_phase5_species_load_samples_bytes(
            blobs["vllm-normal-profile.json"],
            raw_binding,
            "normal",
        )
        validate_phase5_species_load_samples_bytes(
            blobs["vllm-burst-profile.json"],
            raw_binding,
            "burst",
        )
        value = _attestation_value(
            blobs,
            "staging-phase5",
            binding,
            include_hostname=False,
        )
        return canonical(value)
    except (
            AcceptanceError,
            KeyError,
            TypeError,
            ValueError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc


def _snapshot(
        output_raw: bytes,
        evidence_blobs: tuple[tuple[str, bytes], ...],
) -> StagingAttestationSnapshot:
    inventory = tuple(
        (name, digest(body))
        for name, body in evidence_blobs
    )
    inventory_raw = canonical([
        {"name": name, "sha256": sha256}
        for name, sha256 in inventory
    ])
    return StagingAttestationSnapshot(
        bytes(output_raw),
        digest(output_raw),
        tuple((name, bytes(body)) for name, body in evidence_blobs),
        inventory,
        digest(inventory_raw),
    )


def _validate_owned_staging_composite(
        held_release_root: _HeldReleaseRoot,
        owned: _OwnedStagingInputs,
        *,
        expected_evidence: _FinalEvidenceRead | None = None,
        expected_output_state: _NodeState | None = None,
) -> StagingAttestationSnapshot:
    root_fd, _root_state = _held_values(held_release_root)
    namespace = _reserved_namespace(root_fd)
    if (
            STAGING_EVIDENCE_NAME not in namespace
            or STAGING_OUTPUT_NAME not in namespace
            or STAGING_TEMP_NAME in namespace
            or STAGING_QUARANTINE_NAME in namespace):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    evidence = _read_final_evidence(root_fd)
    output_raw, output_state = _read_regular_at(
        root_fd,
        STAGING_OUTPUT_NAME,
        max_bytes=_MAX_OUTPUT_BYTES,
    )
    if (
            expected_evidence is not None
            and evidence != expected_evidence):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    if (
            expected_output_state is not None
            and output_state != expected_output_state):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    expected_output = _staging_output_from_evidence(
        evidence.blobs,
        owned,
    )
    if output_raw != expected_output:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    evidence_again = _read_final_evidence(root_fd)
    output_again, state_again = _read_regular_at(
        root_fd,
        STAGING_OUTPUT_NAME,
        max_bytes=_MAX_OUTPUT_BYTES,
    )
    if (
            evidence_again != evidence
            or output_again != output_raw
            or state_again != output_state):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    _held_values(held_release_root)
    if _reserved_namespace(root_fd) != namespace:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    final_evidence = _read_final_evidence(root_fd)
    final_output, final_output_state = _read_regular_at(
        root_fd,
        STAGING_OUTPUT_NAME,
        max_bytes=_MAX_OUTPUT_BYTES,
    )
    if (
            final_evidence != evidence
            or final_output != output_raw
            or final_output_state != output_state):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    _held_values(held_release_root)
    if _reserved_namespace(root_fd) != namespace:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    return _snapshot(output_raw, evidence.blobs)


def _build_fresh_staging_evidence(
        owned: _OwnedStagingInputs) -> tuple[tuple[str, bytes], ...]:
    host = _own_host_evidence(
        _capture_fixed_staging_host_evidence()
    )
    blobs = {
        **host,
        "vllm-normal-profile.json": owned.normal_profile_raw,
        "vllm-burst-profile.json": owned.burst_profile_raw,
        FAULT_SESSION_EVIDENCE_NAME: owned.session_raw,
    }
    evidence = tuple(
        (name, blobs[name])
        for name in STAGING_EVIDENCE_FILES
    )
    _staging_output_from_evidence(evidence, owned)
    return evidence


def _publish_fresh_staging(
        held_release_root: _HeldReleaseRoot,
        owned: _OwnedStagingInputs) -> StagingAttestationSnapshot:
    root_fd, root_state = _held_values(held_release_root)
    evidence = _build_fresh_staging_evidence(owned)
    expected_output = _staging_output_from_evidence(evidence, owned)
    marker_raw = _transaction_marker_raw(root_state, owned)
    verified_root_fd, verified_root_state = _held_values(
        held_release_root
    )
    if (
            verified_root_fd != root_fd
            or verified_root_state != root_state
            or _reserved_namespace(root_fd)):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    marker_state = _write_exclusive_file_at(
        root_fd,
        STAGING_MARKER_NAME,
        marker_raw,
    )
    os.fsync(root_fd)
    _held_values(held_release_root)
    _verify_marker(
        root_fd,
        marker_raw,
        marker_state,
    )
    temporary_fd = -1
    try:
        temporary_fd, temporary_state = _mkdir_exclusive_at(
            root_fd,
            STAGING_TEMP_NAME,
        )
        created_leaf_states = []
        for name, body in evidence:
            created_leaf_states.append((
                name,
                _write_exclusive_file_at(
                    temporary_fd,
                    name,
                    body,
                ),
            ))
        created_leaf_states = tuple(created_leaf_states)
        os.fsync(temporary_fd)
        _verify_created_leaf_states(
            temporary_fd,
            created_leaf_states,
        )
        _rename_noreplace(
            root_fd,
            STAGING_TEMP_NAME,
            root_fd,
            STAGING_EVIDENCE_NAME,
        )
        os.fsync(root_fd)
        published_evidence_state = _node_state(
            os.fstat(temporary_fd)
        )
        linked_evidence_state = _node_state(os.stat(
            STAGING_EVIDENCE_NAME,
            dir_fd=root_fd,
            follow_symlinks=False,
        ))
        if (
                _stable_from_node(published_evidence_state)
                != _stable_from_node(temporary_state)
                or published_evidence_state != linked_evidence_state):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    except OSError as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    finally:
        if temporary_fd >= 0:
            try:
                os.close(temporary_fd)
            except OSError:
                pass
    _held_values(held_release_root)
    observed_evidence = _read_final_evidence(root_fd)
    if (
            observed_evidence.blobs != evidence
            or observed_evidence.leaf_states != created_leaf_states
            or observed_evidence.directory_state
               != published_evidence_state):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    if (
            _staging_output_from_evidence(
                observed_evidence.blobs,
                owned,
            )
            != expected_output):
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    output_state = _write_exclusive_file_at(
        root_fd,
        STAGING_OUTPUT_NAME,
        expected_output,
    )
    os.fsync(root_fd)
    snapshot = _validate_owned_staging_composite(
        held_release_root,
        owned,
        expected_evidence=observed_evidence,
        expected_output_state=output_state,
    )
    _unlink_verified_file_at(
        root_fd,
        STAGING_MARKER_NAME,
        marker_raw,
        marker_state,
    )
    return snapshot


def _publish_output_from_evidence(
        held_release_root: _HeldReleaseRoot,
        owned: _OwnedStagingInputs,
        marker_raw: bytes,
        marker_state: _NodeState) -> StagingAttestationSnapshot:
    root_fd, _root_state = _held_values(held_release_root)
    evidence = _read_final_evidence(root_fd)
    output_raw = _staging_output_from_evidence(
        evidence.blobs,
        owned,
    )
    output_state = _write_exclusive_file_at(
        root_fd,
        STAGING_OUTPUT_NAME,
        output_raw,
    )
    os.fsync(root_fd)
    snapshot = _validate_owned_staging_composite(
        held_release_root,
        owned,
        expected_evidence=evidence,
        expected_output_state=output_state,
    )
    _unlink_verified_file_at(
        root_fd,
        STAGING_MARKER_NAME,
        marker_raw,
        marker_state,
    )
    return snapshot


def capture(
        output: Path,
        normal_profile: Path,
        burst_profile: Path) -> dict:
    _require_linux()
    try:
        normal = Path(normal_profile).read_bytes()
        burst = Path(burst_profile).read_bytes()
    except (OSError, PermissionError) as exc:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED") from exc
    host = _own_host_evidence(
        _capture_fixed_production_host_evidence()
    )
    blobs = {
        **host,
        "vllm-normal-profile.json": normal,
        "vllm-burst-profile.json": burst,
    }
    value = _attestation_value(
        blobs,
        "production-baseline",
        None,
        include_hostname=True,
    )
    output_raw = canonical(value)
    _production_publish(Path(output), blobs, output_raw)
    return value


def capture_staging_machine_attestation(
        held_release_root,
        *,
        capture_intent_sha256,
        session_raw,
        expected_full_run_binding,
        normal_profile_raw,
        burst_profile_raw,
        raw_manifest_bundle) -> StagingAttestationSnapshot:
    _require_linux()
    root_fd, root_state = _held_values(held_release_root)
    owned = _own_staging_inputs(
        capture_intent_sha256,
        session_raw,
        expected_full_run_binding,
        normal_profile_raw,
        burst_profile_raw,
        raw_manifest_bundle,
    )
    namespace = _reserved_namespace(root_fd)
    has_marker = STAGING_MARKER_NAME in namespace
    has_temp = STAGING_TEMP_NAME in namespace
    has_quarantine = STAGING_QUARANTINE_NAME in namespace
    has_evidence = STAGING_EVIDENCE_NAME in namespace
    has_output = STAGING_OUTPUT_NAME in namespace
    marker_raw = _transaction_marker_raw(root_state, owned)
    marker_state = None

    if has_output and not has_evidence:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    if has_evidence:
        if has_temp or has_quarantine:
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        if has_marker:
            marker_state = _verify_marker(root_fd, marker_raw)
        if has_output:
            snapshot = _validate_owned_staging_composite(
                held_release_root,
                owned,
            )
            if has_marker:
                _unlink_verified_file_at(
                    root_fd,
                    STAGING_MARKER_NAME,
                    marker_raw,
                    marker_state,
                )
            return snapshot
        if not has_marker:
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
        return _publish_output_from_evidence(
            held_release_root,
            owned,
            marker_raw,
            marker_state,
        )

    if has_output:
        raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    if has_temp or has_quarantine or has_marker:
        _recover_private_state(
            root_fd,
            root_state,
            owned,
            namespace,
        )
        _held_values(held_release_root)
        if _reserved_namespace(root_fd):
            raise CaptureError("MACHINE_ATTESTATION_CAPTURE_FAILED")
    return _publish_fresh_staging(
        held_release_root,
        owned,
    )


def main() -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--vllm-normal-profile",
        required=True,
        type=Path,
    )
    parser.add_argument(
        "--vllm-burst-profile",
        required=True,
        type=Path,
    )
    args = parser.parse_args()
    try:
        capture(
            args.output.resolve(),
            args.vllm_normal_profile.resolve(),
            args.vllm_burst_profile.resolve(),
        )
    except CaptureError as exc:
        print(str(exc))
        return 2
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
