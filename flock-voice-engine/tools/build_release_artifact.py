#!/usr/bin/env python3
"""构建可重算、fail-closed 的 Phase 5 音频发布物。"""

from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any


HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
OCI_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
REQUIRED_KINDS = frozenset({"vendor", "weight", "voice-map", "calibration", "audio"})


class ReleaseBuildError(RuntimeError):
    pass


class IdentityError(RuntimeError):
    pass


@dataclass(frozen=True)
class ArtifactEntry:
    logical_path: str
    mount_path: str
    byte_count: int
    sha256: str
    kind: str


@dataclass(frozen=True)
class PreparedReleaseMetadata:
    revision: str
    source_manifest_sha256: str
    entries: list[tuple[ArtifactEntry, Path]]
    vendor_provenance: dict[str, Any]
    vendor_artifact_path: Path
    source_manifest: dict[str, Any]
    artifact_manifest: dict[str, Any]
    identity: dict[str, Any]
    release_manifest: dict[str, Any]


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def manifest_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git(repo_root: Path, *args: str) -> str:
    try:
        return subprocess.check_output(
            ["git", "--no-replace-objects", *args],
            cwd=repo_root,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseBuildError("GIT_STATE_INVALID") from exc


def candidate_revision(repo_root: Path) -> str:
    revision = _git(repo_root, "rev-parse", "HEAD")
    if HEX40.fullmatch(revision) is None:
        raise ReleaseBuildError("CANDIDATE_REVISION_INVALID")
    return revision


def _validate_clean_tree(repo_root: Path) -> None:
    if _git(repo_root, "status", "--porcelain", "--untracked-files=no"):
        raise ReleaseBuildError("TRACKED_TREE_DIRTY")


def _source_manifest(repo_root: Path, revision: str) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    raw = subprocess.check_output(
        ["git", "--no-replace-objects", "ls-tree", "-r", "-z", revision],
        cwd=repo_root,
        stderr=subprocess.DEVNULL,
    )
    records: list[tuple[str, str, str]] = []
    for encoded in (item for item in raw.split(b"\0") if item):
        metadata, path_bytes = encoded.split(b"\t", 1)
        mode, object_type, object_id = metadata.decode("ascii").split(" ")
        logical = path_bytes.decode("utf-8")
        records.append((logical, mode, object_id))
    for logical, mode, object_id in sorted(records):
        if mode == "120000":
            raise ReleaseBuildError("SOURCE_PATH_INVALID")
        try:
            body = subprocess.check_output(
                [
                    "git", "--no-replace-objects",
                    "cat-file", "blob", object_id,
                ],
                cwd=repo_root,
                stderr=subprocess.DEVNULL,
            )
        except subprocess.CalledProcessError as exc:
            raise ReleaseBuildError("SOURCE_BLOB_INVALID") from exc
        entries.append(
            {"path": logical, "byteCount": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        )
    return {"schemaVersion": 1, "entries": entries}


def _open_verified(path: Path, expected_size: int, expected_sha: str):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ReleaseBuildError("AUDIO_INPUT_FILE_INVALID") from exc
    stream = os.fdopen(descriptor, "rb")
    before = os.fstat(stream.fileno())
    if not stat.S_ISREG(before.st_mode) or before.st_size != expected_size:
        stream.close()
        raise ReleaseBuildError("AUDIO_ARTIFACT_BYTE_COUNT_MISMATCH")
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    after = os.fstat(stream.fileno())
    if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            or digest.hexdigest() != expected_sha):
        stream.close()
        raise ReleaseBuildError("AUDIO_ARTIFACT_DIGEST_MISMATCH")
    stream.seek(0)
    return stream


def _load_inputs(inputs_path: Path) -> dict[str, Any]:
    if not inputs_path.exists():
        raise ReleaseBuildError("AUDIO_INPUTS_MISSING")
    if inputs_path.is_symlink() or not inputs_path.is_file():
        raise ReleaseBuildError("AUDIO_INPUTS_UNTRUSTED")
    try:
        value = json.loads(inputs_path.read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReleaseBuildError("AUDIO_INPUTS_INVALID") from exc
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ReleaseBuildError("AUDIO_INPUTS_INVALID")
    if value.get("provenanceKind") != "controlled-artifact":
        raise ReleaseBuildError("UNCONTROLLED_VENDOR")
    return value


def _validate_images(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"runtime", "audio"}:
        raise ReleaseBuildError("BASE_IMAGE_DIGEST_INVALID")
    result: dict[str, Any] = {}
    for name in ("runtime", "audio"):
        image = value.get(name)
        if not isinstance(image, dict) or set(image) != {"repository", "digest"}:
            raise ReleaseBuildError("BASE_IMAGE_DIGEST_INVALID")
        if not isinstance(image["repository"], str) or not image["repository"]:
            raise ReleaseBuildError("BASE_IMAGE_DIGEST_INVALID")
        if OCI_DIGEST.fullmatch(image.get("digest", "")) is None:
            raise ReleaseBuildError("BASE_IMAGE_DIGEST_INVALID")
        result[name] = dict(image)
    return result


def _validated_entries(value: object) -> list[tuple[ArtifactEntry, Path]]:
    if not isinstance(value, list) or not value:
        raise ReleaseBuildError("AUDIO_ARTIFACT_INPUT_INVALID")
    seen_logical: set[str] = set()
    seen_mount: set[str] = set()
    kinds: set[str] = set()
    result: list[tuple[ArtifactEntry, Path]] = []
    for raw in value:
        if not isinstance(raw, dict) or set(raw) != {
            "logicalPath", "mountPath", "sourcePath", "byteCount", "sha256", "kind"
        }:
            raise ReleaseBuildError("AUDIO_ARTIFACT_INPUT_INVALID")
        source = Path(raw["sourcePath"])
        logical = raw["logicalPath"]
        mount = raw["mountPath"]
        kind = raw["kind"]
        if not source.is_absolute():
            raise ReleaseBuildError("AUDIO_INPUT_PATH_NOT_ABSOLUTE")
        if not isinstance(logical, str) or not isinstance(mount, str):
            raise ReleaseBuildError("AUDIO_ARTIFACT_INPUT_INVALID")
        logical_parts = PurePosixPath(logical).parts
        mount_parts = PurePosixPath(mount).parts
        if (not logical_parts or not mount_parts or logical.startswith("/") or mount.startswith("/")
                or ".." in logical_parts or ".." in mount_parts):
            raise ReleaseBuildError("AUDIO_ARTIFACT_PATH_INVALID")
        if logical in seen_logical or mount in seen_mount:
            raise ReleaseBuildError("AUDIO_ARTIFACT_PATH_DUPLICATE")
        if kind not in REQUIRED_KINDS:
            raise ReleaseBuildError("AUDIO_ARTIFACT_KIND_INVALID")
        if not isinstance(raw["byteCount"], int) or raw["byteCount"] < 0:
            raise ReleaseBuildError("AUDIO_ARTIFACT_BYTE_COUNT_INVALID")
        if HEX64.fullmatch(raw["sha256"]) is None:
            raise ReleaseBuildError("AUDIO_ARTIFACT_DIGEST_INVALID")
        with _open_verified(source, raw["byteCount"], raw["sha256"]):
            pass
        seen_logical.add(logical)
        seen_mount.add(mount)
        kinds.add(kind)
        result.append((ArtifactEntry(logical, mount, raw["byteCount"], raw["sha256"], kind), source))
    audio_count = sum(1 for entry, _ in result if entry.kind == "audio")
    audio_names = {PurePosixPath(entry.logical_path).name.lower() for entry, _ in result if entry.kind == "audio"}
    if (not REQUIRED_KINDS.issubset(kinds) or audio_count < 2
            or not any("amen" in name for name in audio_names)
            or not any("forest" in name for name in audio_names)):
        raise ReleaseBuildError("AUDIO_ARTIFACT_INVENTORY_INCOMPLETE")
    return sorted(result, key=lambda item: (item[0].logical_path, item[0].mount_path))


def _validate_vendor(inputs: dict[str, Any], entries: list[tuple[ArtifactEntry, Path]]) -> tuple[dict[str, Any], Path]:
    vendor = inputs.get("vendor")
    if not isinstance(vendor, dict) or vendor.get("provenanceKind") != "controlled-artifact":
        raise ReleaseBuildError("UNCONTROLLED_VENDOR")
    if set(vendor) != {"provenanceKind", "artifactPath", "artifactByteCount", "artifactSha256", "treeSha256"}:
        raise ReleaseBuildError("VENDOR_DIGEST_INVALID")
    if HEX64.fullmatch(vendor.get("artifactSha256", "")) is None or HEX64.fullmatch(vendor.get("treeSha256", "")) is None:
        raise ReleaseBuildError("VENDOR_DIGEST_INVALID")
    artifact_path = Path(vendor["artifactPath"])
    if not artifact_path.is_absolute() or not isinstance(vendor["artifactByteCount"], int):
        raise ReleaseBuildError("VENDOR_ARTIFACT_INVALID")
    with _open_verified(artifact_path, vendor["artifactByteCount"], vendor["artifactSha256"]):
        pass
    vendor_entries = [entry for entry, _ in entries if entry.kind == "vendor"]
    inventory = [{"logicalPath": e.logical_path, "byteCount": e.byte_count, "sha256": e.sha256} for e in vendor_entries]
    if manifest_sha256(inventory) != vendor["treeSha256"]:
        raise ReleaseBuildError("VENDOR_TREE_DIGEST_MISMATCH")
    return ({"mountPath": "vendor/upstream.artifact", "byteCount": vendor["artifactByteCount"],
             "sha256": vendor["artifactSha256"], "treeSha256": vendor["treeSha256"]}, artifact_path)


def _validate_geometry(value: object) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"sampleRate", "blockFrames", "poolSize", "rowVoices"}:
        raise ReleaseBuildError("AUDIO_GEOMETRY_INVALID")
    if value.get("sampleRate") != 44100 or value.get("blockFrames") != 4096 or value.get("poolSize") != 5:
        raise ReleaseBuildError("AUDIO_GEOMETRY_INVALID")
    if value.get("rowVoices") != ["bass", "pad", "lead", "pluck", "pad"]:
        raise ReleaseBuildError("AUDIO_GEOMETRY_INVALID")
    return dict(value)


def _prepare_release_metadata(
    repo_root: Path,
    inputs: dict[str, Any],
) -> PreparedReleaseMetadata:
    revision = candidate_revision(repo_root)
    images = _validate_images(inputs.get("baseImages"))
    entries = _validated_entries(inputs.get("artifacts"))
    vendor_provenance, vendor_artifact_path = _validate_vendor(inputs, entries)
    geometry = _validate_geometry(inputs.get("geometry"))
    source_manifest = _source_manifest(repo_root, revision)
    source_sha = manifest_sha256(source_manifest)
    artifact_manifest = {
        "schemaVersion": 1,
        "vendorProvenance": vendor_provenance,
        "entries": [
            {"logicalPath": entry.logical_path, "mountPath": entry.mount_path,
             "byteCount": entry.byte_count, "sha256": entry.sha256, "kind": entry.kind}
            for entry, _ in entries
        ],
    }
    identity = {
        "releaseRevision": revision,
        "sourceManifestSha256": source_sha,
        "protocolFamily": "flock-audio-ipc",
        "protocolVersion": 1,
        "audioArtifactKind": "release-artifact",
        "audioArtifactSha256": manifest_sha256(artifact_manifest),
    }
    release_manifest = {
        "schemaVersion": 1,
        "workerIdentity": identity,
        "geometry": geometry,
        "manifestGeometrySha256": manifest_sha256(geometry),
        "baseImages": {
            key: {"repository": image["repository"], "digest": image["digest"]}
            for key, image in images.items()
        },
        # build-local replaces this with the verified linux/arm64 OCI manifest
        # digests after both images have been built and independently inspected.
        "imageIdentity": {},
    }
    return PreparedReleaseMetadata(
        revision=revision,
        source_manifest_sha256=source_sha,
        entries=entries,
        vendor_provenance=vendor_provenance,
        vendor_artifact_path=vendor_artifact_path,
        source_manifest=source_manifest,
        artifact_manifest=artifact_manifest,
        identity=identity,
        release_manifest=release_manifest,
    )


def _trusted_output_ancestor(value: os.stat_result, effective_uid: int) -> bool:
    if value.st_uid == effective_uid:
        return value.st_mode & 0o022 == 0
    if value.st_uid != 0:
        return False
    if value.st_mode & 0o022 == 0:
        return True
    return bool(
        value.st_mode & stat.S_ISVTX
        and value.st_mode & stat.S_IWOTH
    )


def _open_trusted_directory(path: Path) -> int:
    absolute = path.absolute()
    current = Path(absolute.anchor)
    effective_uid = os.geteuid() if hasattr(os, "geteuid") else os.stat(current).st_uid
    for part in absolute.parts[1:]:
        current /= part
        value = os.lstat(current)
        if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
            raise ReleaseBuildError("OUTPUT_PATH_UNTRUSTED")
        if not _trusted_output_ancestor(value, effective_uid):
            raise ReleaseBuildError("OUTPUT_PATH_UNTRUSTED")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(absolute, flags)
    opened = os.fstat(descriptor)
    checked = os.lstat(absolute)
    if (opened.st_dev, opened.st_ino) != (checked.st_dev, checked.st_ino):
        os.close(descriptor)
        raise ReleaseBuildError("OUTPUT_PATH_CHANGED")
    return descriptor


def _mkdirs_at(root_fd: int, parts: tuple[str, ...]) -> int:
    current_fd = os.dup(root_fd)
    try:
        for part in parts:
            if part in ("", ".", ".."):
                raise ReleaseBuildError("AUDIO_ARTIFACT_PATH_INVALID")
            try:
                os.mkdir(part, 0o700, dir_fd=current_fd)
            except FileExistsError:
                pass
            next_fd = os.open(part, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                              | getattr(os, "O_NOFOLLOW", 0), dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise


def _write_bytes_at(root_fd: int, relative: str, body: bytes) -> None:
    parts = PurePosixPath(relative).parts
    parent_fd = _mkdirs_at(root_fd, parts[:-1])
    try:
        descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL
                             | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(parent_fd)


def _copy_verified_at(source: Path, root_fd: int, relative: str, expected_size: int, expected_sha: str) -> None:
    parts = PurePosixPath(relative).parts
    parent_fd = _mkdirs_at(root_fd, parts[:-1])
    digest = hashlib.sha256()
    written = 0
    try:
        with _open_verified(source, expected_size, expected_sha) as input_stream:
            descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                 | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=parent_fd)
            with os.fdopen(descriptor, "wb") as output_stream:
                for chunk in iter(lambda: input_stream.read(1024 * 1024), b""):
                    output_stream.write(chunk)
                    digest.update(chunk)
                    written += len(chunk)
                output_stream.flush()
                os.fsync(output_stream.fileno())
    finally:
        os.close(parent_fd)
    if written != expected_size or digest.hexdigest() != expected_sha:
        raise ReleaseBuildError("AUDIO_ARTIFACT_COPY_MISMATCH")


def _verify_file_at(root_fd: int, relative: str, expected: bytes | tuple[int, str]) -> None:
    parts = PurePosixPath(relative).parts
    parent_fd = _mkdirs_at(root_fd, parts[:-1])
    try:
        descriptor = os.open(parts[-1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            body = stream.read()
            after = os.fstat(stream.fileno())
    finally:
        os.close(parent_fd)
    if not stat.S_ISREG(before.st_mode) or ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
        raise ReleaseBuildError("AUDIO_ARTIFACT_COPY_MISMATCH")
    if isinstance(expected, bytes):
        if body != expected:
            raise ReleaseBuildError("RELEASE_OUTPUT_SELF_VERIFY_FAILED")
    elif len(body) != expected[0] or hashlib.sha256(body).hexdigest() != expected[1]:
        raise ReleaseBuildError("AUDIO_ARTIFACT_COPY_MISMATCH")


def _rename_noreplace(parent_fd: int, source_name: str, destination_name: str) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    source = os.fsencode(source_name)
    destination = os.fsencode(destination_name)
    if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        result = libc.renameat2(parent_fd, source, parent_fd, destination, 1)
    elif sys.platform == "darwin" and hasattr(libc, "renameatx_np"):
        result = libc.renameatx_np(parent_fd, source, parent_fd, destination, 0x00000004)
    else:
        raise ReleaseBuildError("ATOMIC_RENAME_NOREPLACE_UNAVAILABLE")
    if result != 0:
        error_number = ctypes.get_errno()
        if error_number in (errno.EEXIST, errno.ENOTEMPTY):
            raise ReleaseBuildError("OUTPUT_PATH_EXISTS")
        raise ReleaseBuildError("OUTPUT_PUBLISH_FAILED") from OSError(error_number, os.strerror(error_number))


def build_release(repo_root: Path | str, inputs_path: Path | str, output_dir: Path | str) -> dict[str, Any]:
    root = Path(repo_root).resolve()
    inputs_file = Path(inputs_path)
    output = Path(output_dir)
    inputs = _load_inputs(inputs_file)
    _validate_clean_tree(root)
    prepared = _prepare_release_metadata(root, inputs)
    revision = prepared.revision
    source_sha = prepared.source_manifest_sha256
    entries = prepared.entries
    vendor_provenance = prepared.vendor_provenance
    vendor_artifact_path = prepared.vendor_artifact_path
    source_manifest = prepared.source_manifest
    artifact_manifest = prepared.artifact_manifest
    identity = prepared.identity
    release_manifest = prepared.release_manifest

    output = output.absolute()
    parent = output.parent
    parent_fd = _open_trusted_directory(parent)
    staging_name = f".{output.name}-{secrets.token_hex(12)}"
    staging_fd = -1
    try:
        try:
            os.stat(output.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ReleaseBuildError("OUTPUT_PATH_EXISTS")
        os.mkdir(staging_name, 0o700, dir_fd=parent_fd)
        staging_fd = os.open(staging_name, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                             | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
        os.mkdir("mounts", 0o700, dir_fd=staging_fd)
        for entry, source in entries:
            _copy_verified_at(source, staging_fd, f"mounts/{entry.mount_path}",
                              entry.byte_count, entry.sha256)
        _copy_verified_at(vendor_artifact_path, staging_fd,
                          f"mounts/{vendor_provenance['mountPath']}",
                          vendor_provenance["byteCount"], vendor_provenance["sha256"])
        encoded_files = {
            "source-manifest.json": canonical_json(source_manifest),
            "audio-artifact-manifest.json": canonical_json(artifact_manifest),
            "audio-identity.json": canonical_json(identity),
            "release-manifest.json": canonical_json(release_manifest),
        }
        for relative, body in encoded_files.items():
            _write_bytes_at(staging_fd, relative, body)
        release_sha = hashlib.sha256(encoded_files["release-manifest.json"]).hexdigest()
        _write_bytes_at(staging_fd, "release-manifest.json.sha256",
                        f"{release_sha}  release-manifest.json\n".encode("ascii"))
        for entry, _ in entries:
            _verify_file_at(staging_fd, f"mounts/{entry.mount_path}",
                            (entry.byte_count, entry.sha256))
        _verify_file_at(staging_fd, f"mounts/{vendor_provenance['mountPath']}",
                        (vendor_provenance["byteCount"], vendor_provenance["sha256"]))
        for relative, body in encoded_files.items():
            _verify_file_at(staging_fd, relative, body)
        _verify_file_at(staging_fd, "release-manifest.json.sha256",
                        f"{release_sha}  release-manifest.json\n".encode("ascii"))
        if candidate_revision(root) != revision:
            raise ReleaseBuildError("CANDIDATE_REVISION_CHANGED")
        _validate_clean_tree(root)
        os.fsync(staging_fd)
        named_staging = os.stat(staging_name, dir_fd=parent_fd, follow_symlinks=False)
        pinned_staging = os.fstat(staging_fd)
        if ((named_staging.st_dev, named_staging.st_ino)
                != (pinned_staging.st_dev, pinned_staging.st_ino)):
            raise ReleaseBuildError("OUTPUT_PATH_CHANGED")
        _rename_noreplace(parent_fd, staging_name, output.name)
        os.fsync(parent_fd)
    finally:
        if staging_fd >= 0:
            os.close(staging_fd)
        os.close(parent_fd)
    return {**release_manifest, "releaseRevision": revision, "sourceManifestSha256": source_sha}


def verify_audio_artifact(identity_path: Path | str, manifest_path: Path | str) -> dict[str, Any]:
    identity_file = Path(identity_path)
    manifest_file = Path(manifest_path)
    try:
        identity = json.loads(identity_file.read_text("utf-8"))
        manifest = json.loads(manifest_file.read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise IdentityError("AUDIO_ARTIFACT_MANIFEST_INVALID") from exc
    if identity.get("audioArtifactSha256") != manifest_sha256(manifest):
        raise IdentityError("AUDIO_ARTIFACT_DIGEST_MISMATCH")
    root = manifest_file.parent / "mounts"
    vendor = manifest.get("vendorProvenance")
    if not isinstance(vendor, dict):
        raise IdentityError("AUDIO_ARTIFACT_MANIFEST_INVALID")
    vendor_path = root / vendor.get("mountPath", "")
    if (vendor_path.is_symlink() or not vendor_path.is_file()
            or vendor_path.stat().st_size != vendor.get("byteCount")
            or _sha256_file(vendor_path) != vendor.get("sha256")):
        raise IdentityError("AUDIO_ARTIFACT_DIGEST_MISMATCH")
    for raw in manifest.get("entries", []):
        path = root / raw["mountPath"]
        if path.is_symlink() or not path.is_file() or path.stat().st_size != raw["byteCount"]:
            raise IdentityError("AUDIO_ARTIFACT_DIGEST_MISMATCH")
        if _sha256_file(path) != raw["sha256"]:
            raise IdentityError("AUDIO_ARTIFACT_DIGEST_MISMATCH")
    return identity


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=Path(__file__).resolve().parents[2])
    parser.add_argument("--inputs", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        build_release(args.repo_root, args.inputs, args.output)
    except ReleaseBuildError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
