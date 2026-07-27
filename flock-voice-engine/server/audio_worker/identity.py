"""Worker 从只读 release 目录自验身份。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import shutil
from pathlib import Path, PurePosixPath
from typing import Any
from dataclasses import dataclass

HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class WorkerIdentityError(RuntimeError):
    pass


@dataclass
class VerifiedAssetBundle:
    manifest_sha256: str
    paths: dict[str, Path]
    digests: dict[str, str]
    file_descriptors: dict[str, int]
    mounts_fd: int
    mount_paths: dict[str, str]
    directory_fds: dict[str, int]
    materialized_root: Path | None = None
    _closed: bool = False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.materialized_root is not None:
            shutil.rmtree(self.materialized_root, ignore_errors=False)

    def __enter__(self) -> "VerifiedAssetBundle":
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.close()

    def path(self, logical_path: str) -> Path:
        try:
            path = self.paths[logical_path]
            descriptor = self.file_descriptors.get(logical_path)
            return Path(f"/proc/self/fd/{descriptor}") if descriptor is not None and sys.platform.startswith("linux") else path
        except KeyError as exc:
            raise WorkerIdentityError(f"CONTROLLED_ASSET_MISSING:{logical_path}") from exc

    def sha256(self, logical_path: str) -> str:
        self.path(logical_path)
        return self.digests[logical_path]

    def directory(self, logical_prefix: str) -> Path:
        prefix = logical_prefix.rstrip("/") + "/"
        matches = [(logical, path) for logical, path in self.paths.items() if logical.startswith(prefix)]
        if not matches:
            raise WorkerIdentityError(f"CONTROLLED_ASSET_MISSING:{logical_prefix}")
        if self.materialized_root is not None:
            directory = self.materialized_root / logical_prefix
            if not directory.is_dir():
                raise WorkerIdentityError(f"CONTROLLED_ASSET_MISSING:{logical_prefix}")
            return directory
        if logical_prefix not in self.directory_fds:
            logical, _ = matches[0]
            logical_suffix = PurePosixPath(logical[len(prefix):]).parts
            mount_parts = PurePosixPath(self.mount_paths[logical]).parts
            directory_parts = mount_parts[:len(mount_parts) - len(logical_suffix)]
            current_fd = os.dup(self.mounts_fd)
            try:
                for part in directory_parts:
                    next_fd = os.open(part, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                                      | getattr(os, "O_NOFOLLOW", 0), dir_fd=current_fd)
                    os.close(current_fd)
                    current_fd = next_fd
                self.directory_fds[logical_prefix] = current_fd
            except Exception:
                os.close(current_fd)
                raise
        descriptor = self.directory_fds[logical_prefix]
        if sys.platform.startswith("linux"):
            return Path(f"/proc/self/fd/{descriptor}")
        logical, path = matches[0]
        directory = path
        for _ in PurePosixPath(logical[len(prefix):]).parts:
            directory = directory.parent
        return directory


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _read_regular(path: Path) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise WorkerIdentityError("AUDIO_IDENTITY_UNTRUSTED") from exc
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        body = stream.read()
        after = os.fstat(stream.fileno())
    if (not stat.S_ISREG(before.st_mode)
            or before.st_uid not in (0, os.geteuid()) or before.st_mode & 0o022
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
        raise WorkerIdentityError("AUDIO_IDENTITY_UNTRUSTED")
    return body


def _read_regular_at(root_fd: int, relative: str) -> bytes:
    parts = PurePosixPath(relative).parts
    if not parts or relative.startswith("/") or ".." in parts:
        raise WorkerIdentityError("AUDIO_IDENTITY_UNTRUSTED")
    current_fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                              | getattr(os, "O_NOFOLLOW", 0), dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        descriptor = os.open(parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=current_fd)
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            body = stream.read()
            after = os.fstat(stream.fileno())
    except OSError as exc:
        raise WorkerIdentityError("AUDIO_IDENTITY_UNTRUSTED") from exc
    finally:
        os.close(current_fd)
    if (not stat.S_ISREG(before.st_mode)
            or before.st_uid not in (0, os.geteuid()) or before.st_mode & 0o022
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
        raise WorkerIdentityError("AUDIO_IDENTITY_UNTRUSTED")
    return body


def _open_verified_regular_at(root_fd: int, relative: str, byte_count: int, sha256: str) -> int:
    parts = PurePosixPath(relative).parts
    current_fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                              | getattr(os, "O_NOFOLLOW", 0), dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        descriptor = os.open(parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=current_fd)
    except OSError as exc:
        raise WorkerIdentityError("AUDIO_IDENTITY_UNTRUSTED") from exc
    finally:
        os.close(current_fd)
    before = os.fstat(descriptor)
    digest = hashlib.sha256()
    with os.fdopen(os.dup(descriptor), "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    after = os.fstat(descriptor)
    if (not stat.S_ISREG(before.st_mode) or before.st_size != byte_count
            or before.st_uid not in (0, os.geteuid()) or before.st_mode & 0o022
            or digest.hexdigest() != sha256
            or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
        os.close(descriptor)
        raise WorkerIdentityError("AUDIO_ARTIFACT_DIGEST_MISMATCH")
    os.lseek(descriptor, 0, os.SEEK_SET)
    return descriptor


def _validate(identity: object) -> dict[str, Any]:
    if not isinstance(identity, dict) or set(identity) != {
        "releaseRevision", "sourceManifestSha256", "protocolFamily", "protocolVersion",
        "audioArtifactKind", "audioArtifactSha256",
    }:
        raise WorkerIdentityError("AUDIO_IDENTITY_INVALID")
    if (HEX40.fullmatch(identity.get("releaseRevision", "")) is None
            or HEX64.fullmatch(identity.get("sourceManifestSha256", "")) is None
            or identity.get("protocolFamily") != "flock-audio-ipc"
            or identity.get("protocolVersion") != 1
            or identity.get("audioArtifactKind") != "release-artifact"
            or HEX64.fullmatch(identity.get("audioArtifactSha256", "")) is None):
        raise WorkerIdentityError("AUDIO_IDENTITY_INVALID")
    return dict(identity)


def _load_worker_release(identity_path: Path, artifact_manifest_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    identity_path = identity_path.absolute()
    artifact_manifest_path = artifact_manifest_path.absolute()
    if (identity_path.name != "audio-identity.json"
            or artifact_manifest_path.name != "audio-artifact-manifest.json"
            or identity_path.parent != artifact_manifest_path.parent):
        raise WorkerIdentityError("AUDIO_IDENTITY_UNTRUSTED")
    try:
        release_fd = os.open(identity_path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                             | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise WorkerIdentityError("AUDIO_IDENTITY_UNTRUSTED") from exc
    try:
        identity_body = _read_regular_at(release_fd, identity_path.name)
        manifest_body = _read_regular_at(release_fd, artifact_manifest_path.name)
        identity = _validate(json.loads(identity_body))
        manifest = json.loads(manifest_body)
    except (json.JSONDecodeError, UnicodeError) as exc:
        os.close(release_fd)
        raise WorkerIdentityError("AUDIO_IDENTITY_INVALID") from exc
    except WorkerIdentityError:
        os.close(release_fd)
        raise
    if _canonical(identity) != identity_body or _canonical(manifest) != manifest_body:
        os.close(release_fd)
        raise WorkerIdentityError("AUDIO_IDENTITY_NOT_CANONICAL")
    if hashlib.sha256(manifest_body).hexdigest() != identity["audioArtifactSha256"]:
        os.close(release_fd)
        raise WorkerIdentityError("AUDIO_ARTIFACT_DIGEST_MISMATCH")
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        os.close(release_fd)
        raise WorkerIdentityError("AUDIO_ARTIFACT_MANIFEST_INVALID")
    try:
        mounts_fd = os.open("mounts", os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                            | getattr(os, "O_NOFOLLOW", 0), dir_fd=release_fd)
    except OSError as exc:
        os.close(release_fd)
        raise WorkerIdentityError("AUDIO_IDENTITY_UNTRUSTED") from exc
    inventory = list(manifest.get("entries", [])) + [manifest.get("vendorProvenance")]
    try:
        for entry in inventory:
            if not isinstance(entry, dict):
                raise WorkerIdentityError("AUDIO_ARTIFACT_MANIFEST_INVALID")
            relative = entry.get("mountPath")
            logical = entry.get("logicalPath") if "logicalPath" in entry else "vendor/upstream.artifact"
            if (not isinstance(relative, str) or relative.startswith("/") or ".." in PurePosixPath(relative).parts
                    or not isinstance(logical, str) or logical.startswith("/") or ".." in PurePosixPath(logical).parts):
                raise WorkerIdentityError("AUDIO_ARTIFACT_MANIFEST_INVALID")
            body = _read_regular_at(mounts_fd, relative)
            if len(body) != entry.get("byteCount") or hashlib.sha256(body).hexdigest() != entry.get("sha256"):
                raise WorkerIdentityError("AUDIO_ARTIFACT_DIGEST_MISMATCH")
        return identity, manifest
    finally:
        os.close(mounts_fd)
        os.close(release_fd)


def load_worker_identity(identity_path: Path, artifact_manifest_path: Path) -> dict[str, Any]:
    identity, _ = _load_worker_release(identity_path, artifact_manifest_path)
    return identity


def load_verified_asset_bundle(identity_path: Path, artifact_manifest_path: Path,
                               expected_identity: dict[str, Any] | None = None) -> VerifiedAssetBundle:
    identity, manifest = _load_worker_release(identity_path, artifact_manifest_path)
    if expected_identity is not None and identity != expected_identity:
        raise WorkerIdentityError("AUDIO_IDENTITY_CHANGED")
    root = artifact_manifest_path.parent / "mounts"
    paths = {entry["logicalPath"]: root / entry["mountPath"] for entry in manifest["entries"]}
    digests = {entry["logicalPath"]: entry["sha256"] for entry in manifest["entries"]}
    mounts_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    file_descriptors: dict[str, int] = {}
    try:
        for entry in manifest["entries"]:
            file_descriptors[entry["logicalPath"]] = _open_verified_regular_at(
                mounts_fd, entry["mountPath"], entry["byteCount"], entry["sha256"])
    except Exception:
        for descriptor in file_descriptors.values():
            os.close(descriptor)
        os.close(mounts_fd)
        raise
    private_root = Path(tempfile.mkdtemp(prefix="flock-audio-assets-"))
    os.chmod(private_root, 0o700)
    private_paths: dict[str, Path] = {}
    try:
        for logical, descriptor in file_descriptors.items():
            destination = private_root / logical
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with os.fdopen(os.dup(descriptor), "rb") as source, destination.open("xb") as target:
                body = source.read()
                target.write(body)
                target.flush()
                os.fsync(target.fileno())
            if hashlib.sha256(body).hexdigest() != digests[logical]:
                raise WorkerIdentityError("AUDIO_ARTIFACT_DIGEST_MISMATCH")
            os.chmod(destination, 0o400)
            private_paths[logical] = destination
        # 0700 keeps the tree private while retaining owner cleanup capability.
        for directory in (path for path in private_root.rglob("*") if path.is_dir()):
            os.chmod(directory, 0o700)
    except Exception:
        shutil.rmtree(private_root, ignore_errors=True)
        raise
    finally:
        for descriptor in file_descriptors.values():
            os.close(descriptor)
        os.close(mounts_fd)
    # The returned bundle owns the successful tree and main() closes it.
    return VerifiedAssetBundle(identity["audioArtifactSha256"], private_paths, digests, {}, -1, {}, {}, private_root)


def load_trusted_release_manifest(path: Path, digest_path: Path,
                                  expected_identity: dict[str, Any]) -> dict[str, Any]:
    path = path.absolute()
    digest_path = digest_path.absolute()
    if path.name != "release-manifest.json" or digest_path != Path(f"{path}.sha256"):
        raise WorkerIdentityError("RELEASE_MANIFEST_UNTRUSTED_PATH")
    current = Path(path.anchor)
    for part in path.parent.parts[1:]:
        current /= part
        value = os.lstat(current)
        if (stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode)
                or value.st_uid not in (0, os.geteuid()) or value.st_mode & 0o022):
            raise WorkerIdentityError("RELEASE_MANIFEST_UNTRUSTED_PATH")
    try:
        parent_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                            | getattr(os, "O_NOFOLLOW", 0))
        body = _read_regular_at(parent_fd, path.name)
        sidecar = _read_regular_at(parent_fd, digest_path.name)
    except OSError as exc:
        raise WorkerIdentityError("RELEASE_MANIFEST_UNTRUSTED_PATH") from exc
    finally:
        if "parent_fd" in locals():
            os.close(parent_fd)
    expected_sidecar = f"{hashlib.sha256(body).hexdigest()}  release-manifest.json\n".encode("ascii")
    if sidecar != expected_sidecar:
        raise WorkerIdentityError("RELEASE_MANIFEST_DIGEST_MISMATCH")
    try:
        manifest = json.loads(body)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise WorkerIdentityError("RELEASE_MANIFEST_SCHEMA_INVALID") from exc
    if _canonical(manifest) != body or manifest.get("workerIdentity") != expected_identity:
        raise WorkerIdentityError("RELEASE_MANIFEST_IDENTITY_MISMATCH")
    geometry = manifest.get("geometry")
    if (not isinstance(geometry, dict) or set(geometry) != {"sampleRate", "blockFrames", "poolSize", "rowVoices"}
            or any(type(geometry.get(key)) is not int or geometry[key] <= 0
                   for key in ("sampleRate", "blockFrames", "poolSize"))
            or not isinstance(geometry.get("rowVoices"), list)
            or len(geometry["rowVoices"]) != geometry["poolSize"]
            or not all(isinstance(voice, str) and voice for voice in geometry["rowVoices"])):
        raise WorkerIdentityError("RELEASE_MANIFEST_GEOMETRY_INVALID")
    if hashlib.sha256(_canonical(geometry)).hexdigest() != manifest.get("manifestGeometrySha256"):
        raise WorkerIdentityError("RELEASE_MANIFEST_GEOMETRY_DIGEST_MISMATCH")
    return manifest
