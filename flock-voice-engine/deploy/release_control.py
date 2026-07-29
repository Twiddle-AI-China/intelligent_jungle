#!/usr/bin/env python3
"""Fail-closed Phase 5 release controller (local scope through Task 9)."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import types
import unicodedata
import uuid
from pathlib import Path

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
RAW_SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
GIT_OBJECT_ID_BYTES = re.compile(br"^[0-9a-f]{40}$")
BATCH_OBJECT_SIZE_BYTES = re.compile(br"^(?:0|[1-9][0-9]*)$")
WINDOWS_RESERVED_DEVICE_STEMS = frozenset({
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
    "com¹",
    "com²",
    "com³",
    "lpt¹",
    "lpt²",
    "lpt³",
    "conin$",
    "conout$",
})
PROTOCOL_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
LOCAL_CONTAINERS = ("flock-runtime-candidate", "flock-audio-candidate")
LOCAL_DOCKER_HOST = "unix:///var/run/docker.sock"
LEGACY_LEASE_TOOL_NAME = "legacy-lease.mjs"
LEGACY_LEASE_CONTAINER_PATH = (
    "/app/flock-voice-engine/runtime/legacy-lease.mjs"
)
LEGACY_LEASE_WORKDIR = "/app/flock-voice-engine/runtime"
LEGACY_LEASE_STDIN_SHIM = (
    "\n;try {\n"
    "  const __flockLeaseResult = await runLegacyLease({"
    " argv: process.argv.slice(2) });\n"
    "  process.exitCode = __flockLeaseResult.exitCode;\n"
    "} catch {\n"
    "  process.stderr.write('LEGACY_LEASE_HOLD_FAILED\\n');\n"
    "  process.exitCode = 1;\n"
    "}\n"
)
FAULT_VERIFIER_DEPLOY_SOURCES = (
    (
        "flock-voice-engine/runtime/tools/verify-phase5-fault-evidence.mjs",
        "phase5-fault-verifier/verify-phase5-fault-evidence.mjs",
    ),
    (
        "flock-voice-engine/runtime/tools/verify-phase5-capture-proof.mjs",
        "phase5-fault-verifier/verify-phase5-capture-proof.mjs",
    ),
    (
        "flock-voice-engine/runtime/tools/lib/phase5-fault-evidence.mjs",
        "phase5-fault-verifier/lib/phase5-fault-evidence.mjs",
    ),
    (
        "flock-voice-engine/runtime/tools/lib/phase5-fault-validation.mjs",
        "phase5-fault-verifier/lib/phase5-fault-validation.mjs",
    ),
    (
        "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-transport-projection.mjs",
        "phase5-fault-verifier/lib/"
        "phase5-fault-transport-projection.mjs",
    ),
    (
        "flock-voice-engine/runtime/tools/lib/phase5-fault-semantics.mjs",
        "phase5-fault-verifier/lib/phase5-fault-semantics.mjs",
    ),
    (
        "flock-voice-engine/runtime/src/capture/phase5-capture-proof.js",
        "src/capture/phase5-capture-proof.js",
    ),
    (
        "flock-voice-engine/runtime/src/capture/capture-wire.js",
        "src/capture/capture-wire.js",
    ),
)
FAULT_VERIFIER_DEPLOY_NAMES = tuple(
    destination for _source, destination in FAULT_VERIFIER_DEPLOY_SOURCES
)
PHASE5_SUMMARY_DEPLOY_SOURCES = (
    (
        "flock-voice-engine/release/phase5-summary.schema.json",
        "phase5-summary/phase5-summary.schema.json",
    ),
    (
        "flock-voice-engine/runtime/tools/soak-phase5.mjs",
        "phase5-summary/soak-phase5.mjs",
    ),
    (
        "flock-voice-engine/tools/capture_machine_attestation.py",
        "phase5-summary/capture_machine_attestation.py",
    ),
)
PHASE5_SUMMARY_DEPLOY_NAMES = tuple(
    destination for _source, destination in PHASE5_SUMMARY_DEPLOY_SOURCES
)
PHASE5_CANDIDATE_CONTROLLER_NAMES = (
    "phase5_candidate_attempt.py",
    "phase5_candidate_bootstrap.py",
)
PHASE5_CONTROLLER_ANCHOR_NAME = ".p5c"
PHASE5_ATTEMPT_REGISTRY_NAME = "a"
PHASE5_ATTEMPT_ID_PROBE = "f" * 32
PHASE5_BOOTSTRAP_BIND_SOURCE_NAME = "run-flock-phase5-bootstrap"
PHASE5_BOOTSTRAP_SOCKET_NAME = "bootstrap.sock"
PHASE5_BOOTSTRAP_SOCKET_PATH_MAX_BYTES = 107
DEPLOY_EXECUTION_PARENT_NAMES = (
    "phase5-fault-verifier",
    "phase5-fault-verifier/lib",
    "src",
    "src/capture",
    "phase5-summary",
)
DEPLOY_EXECUTION_NAMES = (
    "release.sh",
    "release_control.py",
    *PHASE5_CANDIDATE_CONTROLLER_NAMES,
    "verify-smoke.mjs",
    "verify-candidate.sh",
    LEGACY_LEASE_TOOL_NAME,
    "prepare-cutover-request.mjs",
    "validate_phase5_acceptance.py",
    "acceptance.schema.json",
    "machine-attestation.schema.json",
    *FAULT_VERIFIER_DEPLOY_NAMES,
    *PHASE5_SUMMARY_DEPLOY_NAMES,
)
GRAPH_SOURCE_PREFIXES = (
    "mvp/",
    "flock-voice-engine/client/",
    "flock-voice-engine/assets/",
    "flock-voice-engine/runtime/src/",
    "flock-voice-engine/server/",
)
RUNTIME_GRAPH_SOURCE_PREFIXES = GRAPH_SOURCE_PREFIXES[:-1]
ASCII_LOWER = str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
)
STATIC_MIME_BY_EXTENSION = {
    ".avif": "image/avif",
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wav": "audio/wav",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}
REQUIRED_STATIC_ROUTES = {
    "/": "mvp/index.html",
    "/index.html": "mvp/index.html",
    "/demo.html": "flock-voice-engine/client/demo.html",
    "/tracks.html": "flock-voice-engine/client/tracks.html",
    "/voice-client.js": "flock-voice-engine/client/voice-client.js",
    "/voice-client-production.js":
        "flock-voice-engine/client/voice-client-production.js",
    "/pcm-player-worklet.js":
        "flock-voice-engine/client/pcm-player-worklet.js",
    "/assets/timbre/latent_map.json":
        "flock-voice-engine/assets/timbre/latent_map.json",
    "/assets/timbre/voice_maps/bass.json":
        "flock-voice-engine/assets/timbre/voice_maps/bass.json",
    "/assets/timbre/voice_maps/lead.json":
        "flock-voice-engine/assets/timbre/voice_maps/lead.json",
    "/assets/timbre/voice_maps/pad.json":
        "flock-voice-engine/assets/timbre/voice_maps/pad.json",
    "/assets/timbre/voice_maps/pluck.json":
        "flock-voice-engine/assets/timbre/voice_maps/pluck.json",
}
APPROVED_STATIC_ROOT_EDGE = {
    "source": "flock-voice-engine/runtime/src/simulation-runtime.js",
    "kind": "js.url",
    "specifier": "../../assets/timbre/voice_maps/",
    "resolved": "flock-voice-engine/assets/timbre/voice_maps",
}
APPROVED_STATIC_ROOT_FILES = {
    f"flock-voice-engine/assets/timbre/voice_maps/{name}.json"
    for name in ("bass", "lead", "pad", "pluck")
}
PRODUCTION_EXTERNAL_EDGES = {
    "external:configurable-audio-worklet": {
        "kind": "js.audio-worklet",
        "specifier": "external:configurable-audio-worklet",
        "sources": {"flock-voice-engine/client/voice-client.js"},
    },
    "external:configurable-fetch": {
        "kind": "js.fetch",
        "specifier": "external:configurable-fetch",
        "sources": {"flock-voice-engine/client/voice-client.js"},
    },
    "external:ws": {
        "kind": "js.external",
        "specifier": "ws",
        "sources": {
            "flock-voice-engine/runtime/src/api/audio-ws.js",
            "flock-voice-engine/runtime/src/api/legacy-routes.js",
            "flock-voice-engine/runtime/src/api/runtime-ws.js",
            "flock-voice-engine/runtime/src/runtime-app.js",
        },
    },
}
PRODUCTION_RUNTIME_API_SOURCES = {
    "/api/decoder-status": {
        "flock-voice-engine/client/voice-client-production.js",
    },
    "/api/v1/bootstrap": {"mvp/src/server-main.js"},
    "/api/v1/latent-maps/bass": {"mvp/src/server-main.js"},
    "/api/v1/latent-maps/melody": {"mvp/src/server-main.js"},
    "/api/v1/latent-maps/pad": {"mvp/src/server-main.js"},
}
INTERNAL_EDGE_KINDS = {
    "html.src",
    "js.audio-worklet",
    "js.fetch",
    "js.import",
    "js.static-asset",
    "js.url",
    "python.from",
    "python.from-name",
}
PRODUCTION_GRAPH_INNER_SHA256 = (
    "f761950093e9aa83f633c8aa83a5c4494fe67c90295d7358c0f2ff1df854631b"
)
PRODUCTION_GRAPH_ROOTS = {
    "mvp/index.html",
    "flock-voice-engine/runtime/src/index.js",
    "flock-voice-engine/server/audio_worker/__main__.py",
    "flock-voice-engine/client/demo.html",
    "flock-voice-engine/client/tracks.html",
    "flock-voice-engine/client/voice-client.js",
    "flock-voice-engine/client/voice-client-production.js",
    "flock-voice-engine/client/pcm-player-worklet.js",
    "flock-voice-engine/assets/timbre/latent_map.json",
    "flock-voice-engine/assets/timbre/voice_maps/bass.json",
    "flock-voice-engine/assets/timbre/voice_maps/lead.json",
    "flock-voice-engine/assets/timbre/voice_maps/pad.json",
    "flock-voice-engine/assets/timbre/voice_maps/pluck.json",
}
PRODUCTION_GRAPH_FILE_COUNT = 165
PRODUCTION_GRAPH_EDGE_COUNT = 256
PRODUCTION_GRAPH_ROUTE_COUNT = 68


class ReleaseError(RuntimeError):
    pass


def fail(code: str) -> None:
    raise ReleaseError(code)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_symlink_or_reparse(path_stat: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return (
        stat.S_ISLNK(path_stat.st_mode)
        or bool(getattr(path_stat, "st_file_attributes", 0) & reparse_flag)
    )


def _verified_nested_deploy_parent_state(
        release_dir: Path, code: str) -> tuple[tuple[object, ...], ...]:
    states = []
    for name in DEPLOY_EXECUTION_PARENT_NAMES:
        path = release_dir / "deploy" / name
        try:
            current = path.lstat()
        except OSError as exc:
            raise ReleaseError(code) from exc
        if _is_symlink_or_reparse(current) or not stat.S_ISDIR(current.st_mode):
            fail(code)
        states.append((
            current.st_dev,
            current.st_ino,
            current.st_mode,
            current.st_size,
            current.st_mtime_ns,
            getattr(current, "st_file_attributes", 0),
        ))
    return tuple(states)


def verified_deploy_execution(
        release_dir: Path, manifest: dict, name: str) -> tuple[Path, bytes]:
    expected = manifest.get("deployExecutionIdentity", {}).get(name)
    path = release_dir / "deploy" / name
    if RAW_SHA256.fullmatch(expected or "") is None:
        fail("DEPLOY_EXECUTION_DIGEST_MISMATCH")
    descriptor = None
    try:
        link_stat = path.lstat()
        if (_is_symlink_or_reparse(link_stat)
                or not stat.S_ISREG(link_stat.st_mode)):
            fail("DEPLOY_EXECUTION_DIGEST_MISMATCH")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            descriptor = None
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                fail("DEPLOY_EXECUTION_DIGEST_MISMATCH")
            digest = hashlib.sha256()
            body = bytearray()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                body.extend(chunk)
            after = os.fstat(stream.fileno())
        current = path.lstat()
    except (OSError, ValueError) as exc:
        raise ReleaseError("DEPLOY_EXECUTION_DIGEST_MISMATCH") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    stable = (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_size,
        before.st_mtime_ns,
    ) == (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_size,
        after.st_mtime_ns,
    ) == (
        current.st_dev,
        current.st_ino,
        current.st_mode,
        current.st_size,
        current.st_mtime_ns,
    )
    if (not stable or _is_symlink_or_reparse(current)
            or not stat.S_ISREG(current.st_mode)
            or digest.hexdigest() != expected):
        fail("DEPLOY_EXECUTION_DIGEST_MISMATCH")
    return path, bytes(body)


def verified_deploy_execution_path(
        release_dir: Path, manifest: dict, name: str) -> Path:
    path, _ = verified_deploy_execution(release_dir, manifest, name)
    return path


def create_private_secret(path: Path, value: str) -> None:
    descriptor = None
    try:
        descriptor = os.open(
            path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
        os.fchmod(descriptor, 0o400)
        body = value.encode("utf-8")
        written = 0
        while written < len(body):
            count = os.write(descriptor, body[written:])
            if count <= 0:
                raise OSError("short maintenance secret write")
            written += count
        os.fsync(descriptor)
    except OSError as exc:
        raise ReleaseError("MAINTENANCE_SECRET_CREATE_FAILED") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)


def load_json(path: Path, code: str = "RELEASE_MANIFEST_INVALID") -> dict:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReleaseError(code) from exc
    if not isinstance(value, dict):
        fail(code)
    return value


def require_local_scope(*explicit_targets: object) -> None:
    if os.environ.get("FLOCK_DEPLOY_SCOPE") != "local":
        fail("LOCAL_DEPLOY_SCOPE_REQUIRED")
    docker_host = os.environ.get("DOCKER_HOST", "")
    docker_context = os.environ.get("DOCKER_CONTEXT", "")
    if docker_host not in ("", LOCAL_DOCKER_HOST):
        fail("PRODUCTION_TARGET_REJECTED")
    if docker_context not in ("", "default"):
        fail("PRODUCTION_TARGET_REJECTED")
    if any(
            os.environ.get(name, "")
            for name in ("DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")):
        fail("PRODUCTION_TARGET_REJECTED")
    target_text = " ".join((
        *sys.argv,
        *(str(value) for value in explicit_targets),
    )).replace("\\", "/").lower()
    if any(
            token in target_text
            for token in (
                "192.168.9.140",
                "/srv/deploy",
                "0.0.0.0:8090:8090",
            )):
        fail("PRODUCTION_TARGET_REJECTED")
    os.environ["DOCKER_HOST"] = LOCAL_DOCKER_HOST
    os.environ.pop("DOCKER_CONTEXT", None)
    os.environ.pop("DOCKER_TLS_VERIFY", None)
    os.environ.pop("DOCKER_CERT_PATH", None)


def require_release_gate_platform() -> None:
    if sys.platform != "linux":
        fail("RELEASE_GATE_REQUIRES_LINUX")


def container_user() -> str:
    return f"{os.getuid()}:{os.getgid()}"


def run(*args: str, capture: bool = False,
        timeout: float | None = None,
        strict_stderr: bool = False,
        input_text: str | None = None) -> str:
    try:
        result = subprocess.run(args, check=True, encoding="utf-8",
                                input=input_text,
                                stdout=subprocess.PIPE if capture else None,
                                stderr=subprocess.PIPE if strict_stderr else None,
                                timeout=timeout)
    except (OSError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired) as exc:
        raise ReleaseError("COMMAND_FAILED") from exc
    if strict_stderr and result.stderr != "":
        fail("COMMAND_FAILED")
    return result.stdout.strip() if capture else ""


def validate_base_images(inputs: Path) -> dict:
    value = load_json(inputs, "AUDIO_INPUTS_INVALID")
    images = value.get("baseImages")
    if not isinstance(images, dict) or set(images) != {"runtime", "audio"}:
        fail("BASE_IMAGE_DIGEST_INVALID")
    for name in images:
        item = images[name]
        if not isinstance(item, dict) or not isinstance(item.get("repository"), str):
            fail("BASE_IMAGE_DIGEST_INVALID")
        repository = item["repository"]
        tail = repository.rsplit("/", 1)[-1]
        if "@" in repository or ":" in tail or DIGEST.fullmatch(item.get("digest", "")) is None:
            fail("BASE_IMAGE_DIGEST_INVALID")
    return value


def oci_manifest_digest(archive: Path) -> tuple[str, str]:
    """Return selected linux/arm64 manifest digest and its config digest."""
    try:
        with tarfile.open(archive, "r:*") as tf:
            members = {member.name: member for member in tf.getmembers() if member.isfile()}
            def body(name: str) -> bytes:
                member = members.get(name)
                if member is None or member.size > 64 * 1024 * 1024:
                    fail("OCI_LAYOUT_INVALID")
                stream = tf.extractfile(member)
                if stream is None:
                    fail("OCI_LAYOUT_INVALID")
                return stream.read()
            index = json.loads(body("index.json"))
            descriptors = index.get("manifests", [])
            selected = [d for d in descriptors if d.get("platform", {}).get("architecture") == "arm64"
                        and d.get("platform", {}).get("os") == "linux"]
            if len(selected) != 1 or DIGEST.fullmatch(selected[0].get("digest", "")) is None:
                fail("OCI_ARM64_MANIFEST_MISSING")
            descriptor = selected[0]
            blob_name = "blobs/sha256/" + descriptor["digest"].split(":", 1)[1]
            manifest_bytes = body(blob_name)
            if len(manifest_bytes) != descriptor.get("size") or "sha256:" + hashlib.sha256(manifest_bytes).hexdigest() != descriptor["digest"]:
                fail("OCI_MANIFEST_DIGEST_MISMATCH")
            manifest = json.loads(manifest_bytes)
            children = [manifest.get("config"), *manifest.get("layers", [])]
            for child in children:
                if not isinstance(child, dict) or DIGEST.fullmatch(child.get("digest", "")) is None:
                    fail("OCI_DESCRIPTOR_INVALID")
                blob = body("blobs/sha256/" + child["digest"].split(":", 1)[1])
                if len(blob) != child.get("size") or "sha256:" + hashlib.sha256(blob).hexdigest() != child["digest"]:
                    fail("OCI_BLOB_DIGEST_MISMATCH")
            return descriptor["digest"], manifest["config"]["digest"]
    except (OSError, tarfile.TarError, KeyError, TypeError, json.JSONDecodeError) as exc:
        if isinstance(exc, ReleaseError):
            raise
        raise ReleaseError("OCI_LAYOUT_INVALID") from exc


def manifest_pair(release_dir: Path) -> dict:
    path = release_dir / "release-manifest.json"
    sidecar = release_dir / "release-manifest.json.sha256"
    manifest = load_json(path)
    try:
        line = sidecar.read_text("ascii")
    except OSError as exc:
        raise ReleaseError("RELEASE_MANIFEST_SIDECAR_MISSING") from exc
    expected = f"{sha(path)}  release-manifest.json\n"
    if line != expected or canonical(manifest) != path.read_bytes():
        fail("RELEASE_MANIFEST_SIDECAR_INVALID")
    return manifest


def write_manifest_pair(release_dir: Path, manifest: dict) -> None:
    path = release_dir / "release-manifest.json"
    path.write_bytes(canonical(manifest))
    (release_dir / "release-manifest.json.sha256").write_text(
        f"{sha(path)}  release-manifest.json\n", encoding="ascii")


def safe_static_route_url(value: object) -> bool:
    if (not isinstance(value, str) or not value.startswith("/") or value.startswith("//")
            or any(character in value for character in ("%", "\\", "?", "#"))
            or any(ord(character) < 0x20 or ord(character) == 0x7f for character in value)):
        return False
    if value == "/":
        return True
    segments = value[1:].split("/")
    return not value.endswith("/") and all(segment not in {"", ".", ".."} for segment in segments)


def canonical_repo_path(value: object) -> bool:
    if (not isinstance(value, str) or not value or value.startswith(("/", "./"))
            or value.endswith("/") or "\\" in value or "//" in value
            or any(ord(character) < 0x20 or ord(character) == 0x7f
                   for character in value)):
        return False
    return all(segment not in {"", ".", ".."} for segment in value.split("/"))


def static_mime(repo_path: str) -> str | None:
    return STATIC_MIME_BY_EXTENSION.get(Path(repo_path).suffix.lower())


def expected_static_routes(files: list[str]) -> dict[str, str] | None:
    file_set = set(files)
    expected = dict(REQUIRED_STATIC_ROUTES)
    if any(repo_path not in file_set for repo_path in expected.values()):
        return None
    for repo_path in files:
        if not repo_path.startswith("mvp/") or repo_path == "mvp/index.html":
            continue
        if not repo_path.startswith(("mvp/src/", "mvp/assets/")):
            return None
        url = f"/{repo_path.removeprefix('mvp/')}"
        if url in expected:
            return None
        expected[url] = repo_path
    return expected


def source_matches_edge_kind(source: str, kind: str) -> bool:
    lower_source = source.lower()
    if kind == "html.src":
        return lower_source.endswith((".htm", ".html"))
    if kind.startswith("python."):
        return source.endswith(".py")
    if kind == "js.fetch":
        return lower_source.endswith((".htm", ".html", ".js", ".mjs"))
    return lower_source.endswith((".js", ".mjs"))


def target_matches_edge_kind(resolved: str, kind: str) -> bool:
    lower_resolved = resolved.lower()
    if kind in {"html.src", "js.audio-worklet"}:
        return lower_resolved.endswith((".js", ".mjs"))
    if kind == "js.import":
        return lower_resolved.endswith((".js", ".mjs", ".json"))
    if kind.startswith("python."):
        return resolved.endswith(".py")
    return True


def resolved_internal_specifier(edge: dict) -> str:
    source = edge["source"]
    specifier = edge["specifier"]
    if specifier.startswith("/assets/"):
        candidate = f"flock-voice-engine{specifier}"
    elif specifier.startswith("/"):
        candidate = specifier[1:]
    elif specifier.startswith("assets/") and source.startswith("mvp/src/"):
        candidate = f"mvp/{specifier}"
    else:
        candidate = posixpath.join(posixpath.dirname(source), specifier)
    return posixpath.normpath(candidate).removesuffix("/")


def valid_production_graph_edge(edge: dict, files: set[str]) -> bool:
    source = edge["source"]
    kind = edge["kind"]
    specifier = edge["specifier"]
    resolved = edge["resolved"]
    if (source not in files or not source_matches_edge_kind(source, kind)
            or any(ord(character) < 0x20 or ord(character) == 0x7f
                   for character in specifier)):
        return False
    if resolved.startswith("external:"):
        expected = PRODUCTION_EXTERNAL_EDGES.get(resolved)
        return (expected is not None
                and kind == expected["kind"]
                and specifier == expected["specifier"]
                and source in expected["sources"])
    if resolved.startswith("runtime-api:"):
        target = resolved.removeprefix("runtime-api:")
        return (kind == "js.runtime-api"
                and specifier == target
                and source in PRODUCTION_RUNTIME_API_SOURCES.get(target, set()))
    if kind not in INTERNAL_EDGE_KINDS or not canonical_repo_path(resolved):
        return False
    if (not kind.startswith("python.")
            and resolved_internal_specifier(edge) != resolved):
        return False
    if resolved in files:
        return target_matches_edge_kind(resolved, kind)
    descendants = {
        repo_path for repo_path in files
        if repo_path.startswith(f"{resolved}/")
    }
    return (all(edge.get(key) == value
                for key, value in APPROVED_STATIC_ROOT_EDGE.items())
            and descendants == APPROVED_STATIC_ROOT_FILES)


def production_edge_sort_key(edge: dict) -> bytes:
    value = json.dumps({
        "source": edge["source"],
        "line": edge["line"],
        "kind": edge["kind"],
        "specifier": edge["specifier"],
        "resolved": edge["resolved"],
    }, separators=(",", ":"), ensure_ascii=False)
    return value.encode("utf-16-be", errors="surrogatepass")


def validate_production_graph(graph: dict) -> tuple[list[str], dict[str, str]]:
    required = {"files", "edges", "fileSha256", "staticRoutes", "sha256"}
    if not isinstance(graph, dict) or set(graph) != required:
        fail("PRODUCTION_GRAPH_INVALID")
    files = graph["files"]
    hashes = graph["fileSha256"]
    routes = graph["staticRoutes"]
    if (not isinstance(files, list) or not files
            or any(not isinstance(relative, str) for relative in files)
            or files != sorted(set(files))
            or not isinstance(graph["edges"], list)
            or not isinstance(hashes, dict)
            or any(not isinstance(relative, str) or not isinstance(value, str)
                   for relative, value in hashes.items())
            or set(hashes) != set(files)
            or any(RAW_SHA256.fullmatch(value) is None for value in hashes.values())
            or not isinstance(routes, list) or not routes):
        fail("PRODUCTION_GRAPH_INVALID")
    for relative in files:
        if (not canonical_repo_path(relative)
                or not relative.startswith(GRAPH_SOURCE_PREFIXES)):
            fail("PRODUCTION_GRAPH_INVALID")
    file_set = set(files)
    if (len(files) != PRODUCTION_GRAPH_FILE_COUNT
            or len(graph["edges"]) != PRODUCTION_GRAPH_EDGE_COUNT
            or len(routes) != PRODUCTION_GRAPH_ROUTE_COUNT
            or not PRODUCTION_GRAPH_ROOTS.issubset(file_set)):
        fail("PRODUCTION_GRAPH_INVALID")
    edge_keys = {"source", "line", "kind", "specifier", "resolved"}
    previous_edge_key = None
    for edge in graph["edges"]:
        if (not isinstance(edge, dict) or set(edge) != edge_keys
                or edge.get("source") not in file_set
                or not isinstance(edge.get("line"), int)
                or isinstance(edge.get("line"), bool)
                or not 1 <= edge["line"] <= (2 ** 53 - 1)
                or not isinstance(edge.get("kind"), str) or not edge["kind"]
                or not isinstance(edge.get("specifier"), str) or not edge["specifier"]
                or not isinstance(edge.get("resolved"), str) or not edge["resolved"]
                or not valid_production_graph_edge(edge, file_set)):
            fail("PRODUCTION_GRAPH_INVALID")
        edge_key = production_edge_sort_key(edge)
        if previous_edge_key is not None and previous_edge_key >= edge_key:
            fail("PRODUCTION_GRAPH_INVALID")
        previous_edge_key = edge_key
    expected_route_keys = {"url", "repoPath", "mime", "sha256"}
    if (any(not isinstance(route, dict) or set(route) != expected_route_keys
            or not safe_static_route_url(route["url"])
            or not isinstance(route["repoPath"], str) or route["repoPath"] not in hashes
            or static_mime(route["repoPath"]) is None
            or route["mime"] != static_mime(route["repoPath"])
            or route["sha256"] != hashes[route["repoPath"]]
            for route in routes)
            or routes != sorted(routes, key=lambda route: (route["url"], route["repoPath"]))
            or len({route["url"].translate(ASCII_LOWER) for route in routes}) != len(routes)):
        fail("PRODUCTION_GRAPH_INVALID")
    route_map = {route["url"]: route["repoPath"] for route in routes}
    if route_map != expected_static_routes(files):
        fail("PRODUCTION_GRAPH_INVALID")
    inner = {name: graph[name] for name in ("files", "edges", "fileSha256", "staticRoutes")}
    inner_sha = hashlib.sha256(canonical(inner)).hexdigest()
    if (graph["sha256"] != inner_sha
            or inner_sha != PRODUCTION_GRAPH_INNER_SHA256):
        fail("PRODUCTION_GRAPH_INVALID")
    return files, hashes


def write_bound_production_graph(release_dir: Path, graph: dict) -> str:
    validate_production_graph(graph)
    graph_path = release_dir / "production-graph.json"
    graph_path.write_bytes(canonical(graph))
    graph_sha = sha(graph_path)
    manifest = manifest_pair(release_dir)
    manifest["productionGraphSha256"] = graph_sha
    write_manifest_pair(release_dir, manifest)
    return graph_sha


def verify_production_graph_binding(release_dir: Path, expected_sha: str) -> None:
    manifest = manifest_pair(release_dir)
    try:
        actual_sha = sha(release_dir / "production-graph.json")
    except OSError as exc:
        raise ReleaseError("PRODUCTION_GRAPH_BINDING_MISMATCH") from exc
    if manifest.get("productionGraphSha256") != expected_sha or actual_sha != expected_sha:
        fail("PRODUCTION_GRAPH_BINDING_MISMATCH")


def require_revision(revision: object) -> str:
    if not isinstance(revision, str) or REVISION.fullmatch(revision) is None:
        fail("CANDIDATE_REVISION_INVALID")
    return revision


def _controlled_executable(environment_key: str, fallback: str) -> str:
    configured = os.environ.get(environment_key)
    if configured is None:
        return fallback
    path = Path(configured)
    if not path.is_absolute() or not path.is_file():
        fail("CONTROLLED_EXECUTABLE_INVALID")
    return str(path)


def _portable_path_key(component: str) -> str:
    return unicodedata.normalize("NFC", component).casefold()


def _windows_device_stem(component: str) -> str:
    return _portable_path_key(component).split(".", 1)[0].rstrip(" ")


def _parse_revision_inventory(raw: bytes) -> list[tuple[str, str, str]]:
    if not isinstance(raw, bytes) or (raw and not raw.endswith(b"\0")):
        fail("SOURCE_PATH_INVALID")
    records = [] if not raw else raw[:-1].split(b"\0")
    entries: list[tuple[str, str, str]] = []
    exact_paths: set[str] = set()
    portable_paths: set[tuple[str, ...]] = set()
    component_spellings: dict[tuple[tuple[str, ...], str], str] = {}
    forbidden = frozenset('<>:"\\|?*')
    for record in records:
        if record.count(b"\t") != 1:
            fail("SOURCE_PATH_INVALID")
        metadata, raw_path = record.split(b"\t")
        if metadata.count(b" ") != 2:
            fail("SOURCE_PATH_INVALID")
        mode, kind, oid = metadata.split(b" ")
        if (mode not in (b"100644", b"100755")
                or kind != b"blob"
                or GIT_OBJECT_ID_BYTES.fullmatch(oid) is None):
            fail("SOURCE_PATH_INVALID")
        try:
            relative = raw_path.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise ReleaseError("SOURCE_PATH_INVALID") from exc
        if not relative or relative.startswith("/"):
            fail("SOURCE_PATH_INVALID")
        components = relative.split("/")
        portable = []
        for component in components:
            key = _portable_path_key(component)
            if (not component
                    or component in (".", "..")
                    or component.endswith((".", " "))
                    or any(character in forbidden for character in component)
                    or any(unicodedata.category(character) == "Cc"
                           for character in component)
                    or key == ".git"
                    or _windows_device_stem(component)
                    in WINDOWS_RESERVED_DEVICE_STEMS):
                fail("SOURCE_PATH_INVALID")
            alias_key = (tuple(portable), key)
            existing_spelling = component_spellings.get(alias_key)
            if (existing_spelling is not None
                    and existing_spelling != component):
                fail("SOURCE_PATH_INVALID")
            component_spellings[alias_key] = component
            portable.append(key)
        portable_key = tuple(portable)
        if relative in exact_paths or portable_key in portable_paths:
            fail("SOURCE_PATH_INVALID")
        if any(
                (len(existing) < len(portable_key)
                 and portable_key[:len(existing)] == existing)
                or (len(portable_key) < len(existing)
                    and existing[:len(portable_key)] == portable_key)
                for existing in portable_paths):
            fail("SOURCE_PATH_INVALID")
        exact_paths.add(relative)
        portable_paths.add(portable_key)
        entries.append((mode.decode("ascii"), oid.decode("ascii"), relative))
    return entries


def _cleanup_revision_snapshot(
        destination: Path, primary_error: BaseException | None = None) -> None:
    try:
        shutil.rmtree(_snapshot_filesystem_path(destination))
    except OSError as exc:
        if primary_error is None:
            raise ReleaseError("REVISION_SNAPSHOT_CLEANUP_FAILED") from exc
        if hasattr(primary_error, "add_note"):
            primary_error.add_note("REVISION_SNAPSHOT_CLEANUP_FAILED")


def _snapshot_filesystem_path(path: Path) -> Path:
    absolute = os.path.abspath(os.fspath(path))
    if os.name != "nt" or absolute.startswith("\\\\?\\"):
        return Path(absolute)
    if absolute.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + absolute[2:])
    return Path("\\\\?\\" + absolute)


def _abort_batch_process(
        process: subprocess.Popen, primary_error: BaseException) -> None:
    try:
        if process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
    except (OSError, ValueError) as exc:
        if hasattr(primary_error, "add_note"):
            primary_error.add_note(
                f"PRODUCTION_GRAPH_SOURCE_READ_FAILED: {exc}")
    try:
        if process.poll() is None:
            process.terminate()
    except OSError as exc:
        if hasattr(primary_error, "add_note"):
            primary_error.add_note(
                f"PRODUCTION_GRAPH_SOURCE_READ_FAILED: {exc}")
    try:
        process.wait()
    except OSError as exc:
        if hasattr(primary_error, "add_note"):
            primary_error.add_note(
                f"PRODUCTION_GRAPH_SOURCE_READ_FAILED: {exc}")


def _snapshot_destination(
        root: Path, root_resolved: Path, relative: str) -> Path:
    destination = root.joinpath(*relative.split("/"))
    try:
        resolved = destination.resolve(strict=False)
    except OSError as exc:
        raise ReleaseError("REVISION_SNAPSHOT_WRITE_FAILED") from exc
    if resolved == root_resolved or not resolved.is_relative_to(root_resolved):
        fail("REVISION_SNAPSHOT_WRITE_FAILED")
    return destination


def _ensure_snapshot_parent(root: Path, destination: Path) -> None:
    current = root
    for component in destination.relative_to(root).parts[:-1]:
        current /= component
        filesystem_current = _snapshot_filesystem_path(current)
        try:
            filesystem_current.mkdir(mode=0o700)
        except FileExistsError:
            try:
                current_mode = filesystem_current.lstat().st_mode
            except OSError as exc:
                raise ReleaseError("REVISION_SNAPSHOT_WRITE_FAILED") from exc
            if stat.S_ISLNK(current_mode) or not stat.S_ISDIR(current_mode):
                fail("REVISION_SNAPSHOT_WRITE_FAILED")
        except OSError as exc:
            raise ReleaseError("REVISION_SNAPSHOT_WRITE_FAILED") from exc


def _batch_header(
        process: subprocess.Popen, expected_oid: str) -> int:
    try:
        header = process.stdout.readline(4097)
    except (OSError, ValueError) as exc:
        raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc
    if (not isinstance(header, bytes)
            or not header.endswith(b"\n")
            or len(header) > 4096):
        fail("PRODUCTION_GRAPH_SOURCE_READ_FAILED")
    fields = header[:-1].split(b" ")
    expected = expected_oid.encode("ascii")
    if (len(fields) != 3
            or fields[0] != expected
            or fields[1] != b"blob"
            or BATCH_OBJECT_SIZE_BYTES.fullmatch(fields[2]) is None):
        fail("PRODUCTION_GRAPH_SOURCE_READ_FAILED")
    try:
        return int(fields[2])
    except (ValueError, OverflowError) as exc:
        raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc


def _stream_batch_blob(
        process: subprocess.Popen,
        destination: Path,
        mode: str,
        oid: str,
        size: int,
) -> None:
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(
            _snapshot_filesystem_path(destination),
            flags,
            0o600,
        )
    except OSError as exc:
        raise ReleaseError("REVISION_SNAPSHOT_WRITE_FAILED") from exc
    primary_error = None
    try:
        digest = hashlib.sha1()
        digest.update(b"blob " + str(size).encode("ascii") + b"\0")
        remaining = size
        while remaining:
            try:
                chunk = process.stdout.read(min(1024 * 1024, remaining))
            except (OSError, ValueError) as exc:
                raise ReleaseError(
                    "PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc
            if not isinstance(chunk, bytes) or not chunk:
                fail("PRODUCTION_GRAPH_SOURCE_READ_FAILED")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                try:
                    written = os.write(descriptor, view)
                except OSError as exc:
                    raise ReleaseError(
                        "REVISION_SNAPSHOT_WRITE_FAILED") from exc
                if written <= 0 or written > len(view):
                    fail("REVISION_SNAPSHOT_WRITE_FAILED")
                view = view[written:]
            remaining -= len(chunk)
        try:
            delimiter = process.stdout.read(1)
        except (OSError, ValueError) as exc:
            raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc
        if delimiter != b"\n" or digest.hexdigest() != oid:
            fail("PRODUCTION_GRAPH_SOURCE_READ_FAILED")
        try:
            os.fchmod(descriptor, 0o755 if mode == "100755" else 0o644)
        except OSError as exc:
            raise ReleaseError("REVISION_SNAPSHOT_WRITE_FAILED") from exc
    except BaseException as exc:
        primary_error = exc
        raise
    finally:
        try:
            os.close(descriptor)
        except OSError as exc:
            if primary_error is None:
                raise ReleaseError("REVISION_SNAPSHOT_WRITE_FAILED") from exc
            if hasattr(primary_error, "add_note"):
                primary_error.add_note("REVISION_SNAPSHOT_WRITE_FAILED")


def capture_candidate_revision(command_runner, repo: Path) -> str:
    return require_revision(command_runner(
        "git", "--no-replace-objects", "-C", str(repo),
        "rev-parse", "HEAD", capture=True))


def verify_candidate_repository_state(
        command_runner, repo: Path, revision: str) -> None:
    if command_runner(
            "git", "--no-replace-objects", "-C", str(repo),
            "status", "--porcelain", "--untracked-files=no", capture=True):
        fail("TRACKED_TREE_DIRTY")
    if capture_candidate_revision(command_runner, repo) != revision:
        fail("CANDIDATE_REVISION_CHANGED")


def git_blob(repo: Path, revision: str, relative: str) -> bytes:
    require_revision(revision)
    try:
        return subprocess.check_output(
            [
                "git", "--no-replace-objects", "-C", str(repo),
                "show", f"{revision}:{relative}",
            ])
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc


def git_tree_names(repo: Path, revision: str, scope: str | None = None) -> list[str]:
    require_revision(revision)
    command = [
        "git", "--no-replace-objects", "-C", str(repo),
        "ls-tree", "-r", "--name-only", revision,
    ]
    if scope is not None:
        command.extend(("--", scope))
    try:
        return subprocess.check_output(command, text=True).splitlines()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc


def read_graph_source(repo: Path, revision: str, relative: str,
                      expected_sha: str) -> bytes:
    body = git_blob(repo, revision, relative)
    if hashlib.sha256(body).hexdigest() != expected_sha:
        fail("PRODUCTION_GRAPH_SOURCE_DIGEST_MISMATCH")
    return body


def production_graph_from_revision(repo: Path, output: Path, revision: str, *,
                                   npm_runner=None, node_runner=None) -> dict:
    require_revision(revision)
    npm_runner = npm_runner or subprocess.run
    node_runner = node_runner or run
    snapshot = output / ".graph-head"
    snapshot_created = False
    primary_error = None
    try:
        materialize_revision_snapshot(repo, revision, snapshot)
        snapshot_created = True
        install_env = {**os.environ, "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1"}
        try:
            npm_runner(
                ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                cwd=snapshot / "flock-voice-engine/runtime",
                env=install_env,
                check=True,
                stdout=subprocess.DEVNULL,
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            raise ReleaseError("PRODUCTION_GRAPH_DEPENDENCIES_INVALID") from exc
        try:
            value = json.loads(node_runner(
                _controlled_executable(
                    "PHASE6_APPROVED_NODE_EXE",
                    "node",
                ),
                str(
                    snapshot
                    / "flock-voice-engine/runtime/tools/build-production-graph.mjs"
                ),
                capture=True,
            ))
        except json.JSONDecodeError as exc:
            raise ReleaseError("PRODUCTION_GRAPH_INVALID") from exc
        validate_production_graph(value)
        return value
    except BaseException as exc:
        primary_error = exc
        raise
    finally:
        if snapshot_created:
            try:
                shutil.rmtree(_snapshot_filesystem_path(snapshot))
            except OSError as exc:
                if primary_error is None:
                    raise ReleaseError(
                        "PRODUCTION_GRAPH_SNAPSHOT_CLEANUP_FAILED"
                    ) from exc
                if hasattr(primary_error, "add_note"):
                    primary_error.add_note(
                        "PRODUCTION_GRAPH_SNAPSHOT_CLEANUP_FAILED"
                    )


def materialize_revision_snapshot(repo: Path, revision: str,
                                  destination: Path) -> Path:
    require_revision(revision)
    destination = Path(destination)
    if os.path.lexists(destination):
        fail("REVISION_SNAPSHOT_WRITE_FAILED")
    try:
        inventory_raw = subprocess.check_output(
            [
                "git", "--no-replace-objects", "-C", str(repo),
                "ls-tree", "-r", "-z", "--full-tree", revision,
            ],
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc
    inventory = _parse_revision_inventory(inventory_raw)
    destination_created = False
    process = None
    primary_error = None
    try:
        try:
            destination.mkdir(mode=0o700)
            destination_created = True
            root_resolved = destination.resolve(strict=True)
        except OSError as exc:
            raise ReleaseError("REVISION_SNAPSHOT_WRITE_FAILED") from exc
        destinations = [
            (
                mode,
                oid,
                _snapshot_destination(
                    destination, root_resolved, relative),
            )
            for mode, oid, relative in inventory
        ]
        try:
            process = subprocess.Popen(
                [
                    "git", "--no-replace-objects", "-C", str(repo),
                    "cat-file", "--batch",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc
        if process.stdin is None or process.stdout is None:
            fail("PRODUCTION_GRAPH_SOURCE_READ_FAILED")
        for mode, oid, target in destinations:
            _ensure_snapshot_parent(destination, target)
            try:
                process.stdin.write(oid.encode("ascii") + b"\n")
                process.stdin.flush()
            except (OSError, ValueError) as exc:
                raise ReleaseError(
                    "PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc
            size = _batch_header(process, oid)
            _stream_batch_blob(process, target, mode, oid, size)
        try:
            process.stdin.close()
            if process.stdout.read(1) != b"":
                fail("PRODUCTION_GRAPH_SOURCE_READ_FAILED")
            returncode = process.wait()
        except (OSError, ValueError) as exc:
            raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc
        if returncode != 0:
            fail("PRODUCTION_GRAPH_SOURCE_READ_FAILED")
        return destination
    except BaseException as exc:
        primary_error = exc
        if process is not None:
            _abort_batch_process(process, primary_error)
        if destination_created:
            _cleanup_revision_snapshot(destination, primary_error)
        raise


def materialize_runtime_context(repo: Path, output: Path, graph: dict,
                                revision: str) -> Path:
    require_revision(revision)
    context = output / ".build-runtime-context"
    context.mkdir(mode=0o700)
    files, hashes = validate_production_graph(graph)
    bundle = context / "production-bundle"
    tracked = set(git_tree_names(repo, revision))
    for relative in files:
        if not relative.startswith(RUNTIME_GRAPH_SOURCE_PREFIXES):
            continue
        if relative not in tracked:
            fail("PRODUCTION_GRAPH_UNTRACKED_SOURCE")
        destination = bundle / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(read_graph_source(
            repo, revision, relative, hashes[relative]))
    package = context / "runtime-package"
    package.mkdir()
    for name in ("package.json", "package-lock.json"):
        relative = f"flock-voice-engine/runtime/{name}"
        (package / name).write_bytes(git_blob(repo, revision, relative))
    (context / "Dockerfile.runtime").write_bytes(git_blob(
        repo, revision, "flock-voice-engine/deploy/Dockerfile.runtime"))
    return context


def copy_tracked_scope(repo: Path, revision: str, scope: str,
                       destination_root: Path) -> None:
    names = git_tree_names(repo, revision, scope)
    if not names:
        fail("TRACKED_RELEASE_SCOPE_EMPTY")
    for relative in names:
        destination = destination_root / Path(relative).relative_to(scope)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(git_blob(repo, revision, relative))


def materialize_fault_verifier_closure(
        repo: Path, revision: str, deploy_root: Path) -> None:
    require_revision(revision)
    for source, destination_name in FAULT_VERIFIER_DEPLOY_SOURCES:
        destination = deploy_root / destination_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(git_blob(repo, revision, source))


def materialize_phase5_summary_closure(
        repo: Path, revision: str, deploy_root: Path) -> None:
    require_revision(revision)
    for source, destination_name in PHASE5_SUMMARY_DEPLOY_SOURCES:
        destination = deploy_root / destination_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(git_blob(repo, revision, source))


def materialize_audio_context(repo: Path, output: Path, graph: dict,
                              revision: str) -> Path:
    require_revision(revision)
    context = output / ".build-audio-context"
    context.mkdir(mode=0o700)
    files, hashes = validate_production_graph(graph)
    names = [name for name in files if name.startswith("flock-voice-engine/server/")]
    if not names:
        fail("AUDIO_SOURCE_MANIFEST_EMPTY")
    for relative in names:
        destination = context / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(read_graph_source(
            repo, revision, relative, hashes[relative]))
    lock = "flock-voice-engine/deploy/requirements-audio.lock"
    destination = context / lock; destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(git_blob(repo, revision, lock))
    (context / "Dockerfile.audio").write_bytes(git_blob(
        repo, revision, "flock-voice-engine/deploy/Dockerfile.audio"))
    return context


def build_local(args, *, repo_root: Path | None = None, command_runner=None,
                graph_builder=None, image_inspector=None) -> None:
    require_local_scope()
    command_runner = command_runner or run
    graph_builder = graph_builder or production_graph_from_revision
    image_inspector = image_inspector or oci_manifest_digest
    inputs = Path(args.inputs).resolve()
    if not inputs.is_file():
        fail("AUDIO_INPUTS_MISSING")
    values = validate_base_images(inputs)
    output = Path(args.output).resolve()
    if output.exists():
        fail("OUTPUT_PATH_EXISTS")
    repo = (Path(repo_root).resolve() if repo_root is not None
            else Path(__file__).resolve().parents[2])
    revision = capture_candidate_revision(command_runner, repo)
    builder_snapshot = (
        output.parent
        / f".{output.name}-builder-{secrets.token_hex(12)}"
    )
    builder_snapshot_created = False
    builder_primary_error = None
    try:
        materialize_revision_snapshot(repo, revision, builder_snapshot)
        builder_snapshot_created = True
        builder = (
            builder_snapshot
            / "flock-voice-engine/tools/build_release_artifact.py"
        )
        command_runner(sys.executable, str(builder), "--repo-root", str(repo),
                       "--inputs", str(inputs), "--output", str(output))
    except BaseException as exc:
        builder_primary_error = exc
        raise
    finally:
        if builder_snapshot_created:
            _cleanup_revision_snapshot(
                builder_snapshot, builder_primary_error)
    built_manifest = manifest_pair(output)
    if built_manifest.get("workerIdentity", {}).get("releaseRevision") != revision:
        fail("CANDIDATE_REVISION_CHANGED")
    (output / "deploy").mkdir()
    copy_tracked_scope(
        repo, revision, "flock-voice-engine/deploy", output / "deploy")
    (output / f"deploy/{LEGACY_LEASE_TOOL_NAME}").write_bytes(git_blob(
        repo, revision,
        "flock-voice-engine/runtime/tools/legacy-lease.mjs"))
    (output / "deploy/prepare-cutover-request.mjs").write_bytes(git_blob(
        repo, revision,
        "flock-voice-engine/runtime/tools/prepare-cutover-request.mjs"))
    materialize_fault_verifier_closure(
        repo, revision, output / "deploy")
    materialize_phase5_summary_closure(
        repo, revision, output / "deploy")
    for source, destination in (
        ("flock-voice-engine/tools/validate_phase5_acceptance.py", "validate_phase5_acceptance.py"),
        ("flock-voice-engine/release/acceptance.schema.json", "acceptance.schema.json"),
        ("flock-voice-engine/release/machine-attestation.schema.json", "machine-attestation.schema.json"),
    ):
        (output / "deploy" / destination).write_bytes(
            git_blob(repo, revision, source))
    images_dir = output / "images"
    images_dir.mkdir(mode=0o700)
    graph = graph_builder(repo, output, revision)
    graph_sha = write_bound_production_graph(output, graph)
    runtime_context = materialize_runtime_context(
        repo, output, graph, revision)
    audio_context = materialize_audio_context(
        repo, output, graph, revision)
    source_root = output / "source"
    (source_root / "flock-voice-engine").mkdir(parents=True)
    bundle = runtime_context / "production-bundle"
    shutil.copytree(bundle / "mvp", source_root / "mvp")
    for name in ("runtime", "client", "assets"):
        shutil.copytree(bundle / "flock-voice-engine" / name,
                        source_root / "flock-voice-engine" / name)
    built_manifest = manifest_pair(output)
    declared_bases = {name: {key: values["baseImages"][name][key]
                             for key in ("repository", "digest")}
                      for name in ("runtime", "audio")}
    if built_manifest.get("baseImages") != declared_bases:
        fail("BASE_IMAGE_MANIFEST_MISMATCH")
    source_sha = built_manifest["workerIdentity"]["sourceManifestSha256"]
    tags = {name: f"flock-{name}:{revision}-{source_sha[:12]}" for name in ("runtime", "audio")}
    for name in ("runtime", "audio"):
        item = values["baseImages"][name]
        context = runtime_context if name == "runtime" else audio_context
        dockerfile = context / f"Dockerfile.{name}"
        archive = images_dir / f"{name}.oci.tar"
        prefix = name.upper()
        common = ("docker", "buildx", "build", "--platform", "linux/arm64", "--provenance=false",
                  "--file", str(dockerfile), "--build-arg", f"{prefix}_BASE_REPOSITORY={item['repository']}",
                  "--build-arg", f"{prefix}_BASE_DIGEST={item['digest']}")
        command_runner(*common, "--tag", tags[name], "--output",
                       f"type=oci,dest={archive}", str(context))
        command_runner(*common, "--load", "--tag", tags[name], str(context))
    manifest = manifest_pair(output)
    manifest["deployReleaseScriptSha256"] = sha(output / "deploy/release.sh")
    manifest["bootstrapSha256"] = sha(output / "deploy/import-release.sh")
    manifest["deployExecutionIdentity"] = {
        name: sha(output / "deploy" / name)
        for name in DEPLOY_EXECUTION_NAMES
    }
    identities = {}
    diagnostics = {}
    for name in ("runtime", "audio"):
        identities[name], config_digest = image_inspector(
            images_dir / f"{name}.oci.tar")
        engine_id = command_runner(
            "docker", "image", "inspect", "--format", "{{.Id}}",
            tags[name], capture=True)
        if engine_id != config_digest:
            fail("LOADED_IMAGE_CONFIG_MISMATCH")
        diagnostics[name] = {"localEngineImageId": engine_id, "tag": tags[name]}
    manifest["imageIdentity"] = identities
    manifest["localImageDiagnostics"] = diagnostics
    if manifest.get("productionGraphSha256") != graph_sha:
        fail("PRODUCTION_GRAPH_BINDING_MISMATCH")
    verify_candidate_repository_state(command_runner, repo, revision)
    verify_production_graph_binding(output, graph_sha)
    write_manifest_pair(output, manifest)
    shutil.rmtree(runtime_context)
    shutil.rmtree(audio_context)


def _verified_phase5_candidate_controller_sources(
        release_dir: Path, manifest: dict) -> dict[str, tuple[Path, bytes]]:
    return {
        name: verified_deploy_execution(release_dir, manifest, name)
        for name in PHASE5_CANDIDATE_CONTROLLER_NAMES
    }


def _load_phase5_candidate_controller_sources(
        sources: dict[str, tuple[Path, bytes]]) -> types.SimpleNamespace:
    if (
        type(sources) is not dict
        or set(sources) != set(PHASE5_CANDIDATE_CONTROLLER_NAMES)
    ):
        fail("PHASE5_CANDIDATE_CONTROLLER_LOAD_FAILED")
    modules = {}
    try:
        for name in PHASE5_CANDIDATE_CONTROLLER_NAMES:
            source = sources[name]
            if (
                type(source) is not tuple
                or len(source) != 2
                or type(source[0]) is not type(Path.cwd())
                or type(source[1]) is not bytes
            ):
                fail("PHASE5_CANDIDATE_CONTROLLER_LOAD_FAILED")
            path, body = source
            module_name = (
                "_flock_verified_" + name.removesuffix(".py")
            )
            module = types.ModuleType(module_name)
            module.__file__ = str(path)
            module.__package__ = ""
            module.__spec__ = None
            compiled = compile(
                body,
                str(path),
                "exec",
                dont_inherit=True,
            )
            previous = sys.modules.get(module_name)
            sys.modules[module_name] = module
            try:
                exec(compiled, module.__dict__)
            finally:
                if previous is None:
                    sys.modules.pop(module_name, None)
                else:
                    sys.modules[module_name] = previous
            modules[name] = module
        controller = types.SimpleNamespace(
            create_phase5_candidate_attempt=getattr(
                modules["phase5_candidate_attempt.py"],
                "create_phase5_candidate_attempt",
            ),
            commit_phase5_candidate_admission=getattr(
                modules["phase5_candidate_attempt.py"],
                "commit_phase5_candidate_admission",
            ),
            prepare_phase5_candidate_bootstrap_linux=getattr(
                modules["phase5_candidate_bootstrap.py"],
                "prepare_phase5_candidate_bootstrap_linux",
            ),
        )
        if any(
                not callable(getattr(controller, name))
                for name in (
                    "create_phase5_candidate_attempt",
                    "commit_phase5_candidate_admission",
                    "prepare_phase5_candidate_bootstrap_linux",
                )):
            fail("PHASE5_CANDIDATE_CONTROLLER_LOAD_FAILED")
        return controller
    except ReleaseError:
        raise
    except Exception as exc:
        raise ReleaseError(
            "PHASE5_CANDIDATE_CONTROLLER_LOAD_FAILED"
        ) from exc


def _effective_controller_ids() -> tuple[int, int]:
    try:
        uid = os.geteuid()
        gid = os.getegid()
    except (AttributeError, OSError) as exc:
        raise ReleaseError(
            "PHASE5_CANDIDATE_CONTROLLER_LINUX_REQUIRED"
        ) from exc
    if (
        type(uid) is not int
        or type(gid) is not int
        or not 0 <= uid <= 0xffffffff
        or not 0 <= gid <= 0xffffffff
    ):
        fail("PHASE5_CANDIDATE_CONTROLLER_ID_INVALID")
    return uid, gid


def _phase5_candidate_identity(
        manifest: dict, release_manifest_sha256: str) -> dict:
    try:
        worker = manifest["workerIdentity"]
        geometry = manifest["geometry"]
        release_identity = {
            "releaseManifestSha256": release_manifest_sha256,
            "releaseRevision": worker["releaseRevision"],
            "sourceManifestSha256": worker["sourceManifestSha256"],
            "audioArtifactSha256": worker["audioArtifactSha256"],
        }
        owned_geometry = {
            "sampleRate": geometry["sampleRate"],
            "blockFrames": geometry["blockFrames"],
            "poolSize": geometry["poolSize"],
            "rowVoices": list(geometry["rowVoices"]),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise ReleaseError(
            "PHASE5_CANDIDATE_IDENTITY_INVALID"
        ) from exc
    identity = {
        "runId": str(uuid.uuid4()),
        "challenge": secrets.token_hex(32),
        "release": release_identity,
        "geometry": owned_geometry,
        "profile": {
            "clients": 4,
            "slowClient": 4,
            "durationMinutes": 30,
            "speciesEndpoint": "http://127.0.0.1:8081/v1",
            "speciesModel": "bird_agent",
        },
    }
    if (
        RAW_SHA256.fullmatch(release_manifest_sha256) is None
        or REVISION.fullmatch(release_identity["releaseRevision"]) is None
        or RAW_SHA256.fullmatch(
            release_identity["sourceManifestSha256"]
        ) is None
        or RAW_SHA256.fullmatch(
            release_identity["audioArtifactSha256"]
        ) is None
        or owned_geometry != {
            "sampleRate": 44_100,
            "blockFrames": 4_096,
            "poolSize": 5,
            "rowVoices": ["bass", "pad", "lead", "pluck", "pad"],
        }
    ):
        fail("PHASE5_CANDIDATE_IDENTITY_INVALID")
    return identity


def _phase5_candidate_registry_root(release_dir: Path) -> Path:
    controller_anchor = (
        release_dir.parent / PHASE5_CONTROLLER_ANCHOR_NAME
    )
    registry_root = (
        controller_anchor / PHASE5_ATTEMPT_REGISTRY_NAME
    )
    bootstrap_socket_probe = (
        registry_root
        / PHASE5_ATTEMPT_ID_PROBE
        / PHASE5_BOOTSTRAP_BIND_SOURCE_NAME
        / PHASE5_BOOTSTRAP_SOCKET_NAME
    )
    try:
        encoded_probe = os.fsencode(bootstrap_socket_probe)
    except (OSError, TypeError, UnicodeError, ValueError) as exc:
        raise ReleaseError(
            "PHASE5_BOOTSTRAP_SOCKET_PATH_TOO_LONG"
        ) from exc
    if (
        b"\0" in encoded_probe
        or len(encoded_probe)
        > PHASE5_BOOTSTRAP_SOCKET_PATH_MAX_BYTES
    ):
        fail("PHASE5_BOOTSTRAP_SOCKET_PATH_TOO_LONG")
    try:
        os.mkdir(controller_anchor, 0o700)
    except FileExistsError:
        pass
    except OSError as exc:
        raise ReleaseError(
            "PHASE5_CANDIDATE_CONTROLLER_ANCHOR_REQUIRED"
        ) from exc
    return registry_root


def _validated_candidate_container_id(value: str) -> str:
    if type(value) is not str or RAW_SHA256.fullmatch(value) is None:
        fail("CANDIDATE_CONTAINER_ID_INVALID")
    return value


def _validated_candidate_pid(value: str) -> int:
    if (
        type(value) is not str
        or re.fullmatch(r"[1-9][0-9]{0,9}", value) is None
    ):
        fail("CANDIDATE_CONTAINER_PID_INVALID")
    result = int(value)
    if result > 0x7fffffff:
        fail("CANDIDATE_CONTAINER_PID_INVALID")
    return result


def _validated_candidate_uid(value: str, expected_uid: int) -> int:
    if (
        type(value) is not str
        or re.fullmatch(
            r"(?:0|[1-9][0-9]{0,9})(?::(?:0|[1-9][0-9]{0,9}))?",
            value,
        ) is None
    ):
        fail("CANDIDATE_CONTAINER_USER_INVALID")
    uid = int(value.split(":", 1)[0])
    if uid > 0xffffffff or uid != expected_uid:
        fail("CANDIDATE_CONTAINER_UID_MISMATCH")
    return uid


class _CandidateContainerLaunchError(ReleaseError):
    def __init__(
            self, message: str,
            container_id: str | None = None) -> None:
        super().__init__(message)
        self.container_id = container_id


class _CandidateCidfileLayout:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.audio_cidfile = directory / "audio.cid"
        self.runtime_cidfile = directory / "runtime.cid"
        self._closed = False

    def close(self) -> None:
        if self._closed:
            return
        errors = []
        for path in (self.audio_cidfile, self.runtime_cidfile):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                errors.append(exc)
        try:
            self.directory.rmdir()
        except FileNotFoundError:
            pass
        except OSError as exc:
            errors.append(exc)
        self._closed = True
        if errors:
            raise ReleaseError(
                "PHASE5_CANDIDATE_CIDFILE_CLEANUP_FAILED"
            ) from errors[0]


def _owned_private_directory(
        path: Path, expected_uid: int, expected_gid: int,
        code: str) -> os.stat_result:
    try:
        current = path.lstat()
    except OSError as exc:
        raise ReleaseError(code) from exc
    if (
        _is_symlink_or_reparse(current)
        or not stat.S_ISDIR(current.st_mode)
        or stat.S_IMODE(current.st_mode) != 0o700
        or current.st_uid != expected_uid
        or current.st_gid != expected_gid
    ):
        fail(code)
    return current


def _create_phase5_candidate_cidfile_layout(
        registry_root: Path, attempt_id: str,
        controller_uid: int,
        controller_gid: int) -> _CandidateCidfileLayout:
    if re.fullmatch(r"[0-9a-f]{32}", attempt_id) is None:
        fail("PHASE5_CANDIDATE_ATTEMPT_ID_INVALID")
    anchor = registry_root.parent
    _owned_private_directory(
        anchor,
        controller_uid,
        controller_gid,
        "PHASE5_CANDIDATE_CONTROLLER_ANCHOR_REQUIRED",
    )
    for _attempt in range(16):
        directory = anchor / (
            f"c-{attempt_id}-{secrets.token_hex(16)}"
        )
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            continue
        except OSError as exc:
            raise ReleaseError(
                "PHASE5_CANDIDATE_CIDFILE_LAYOUT_FAILED"
            ) from exc
        try:
            _owned_private_directory(
                directory,
                controller_uid,
                controller_gid,
                "PHASE5_CANDIDATE_CIDFILE_LAYOUT_FAILED",
            )
            return _CandidateCidfileLayout(directory)
        except BaseException as exc:
            try:
                directory.rmdir()
            except OSError:
                if hasattr(exc, "add_note"):
                    exc.add_note(
                        "PHASE5_CANDIDATE_CIDFILE_CLEANUP_FAILED")
            raise
    fail("PHASE5_CANDIDATE_CIDFILE_LAYOUT_FAILED")


def _read_candidate_cidfile(path: Path) -> str:
    descriptor = None
    try:
        link_state = path.lstat()
        if (
            _is_symlink_or_reparse(link_state)
            or not stat.S_ISREG(link_state.st_mode)
            or link_state.st_nlink != 1
            or link_state.st_size not in (64, 65)
        ):
            fail("CANDIDATE_CIDFILE_INVALID")
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
        )
        before = os.fstat(descriptor)
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = None
            body = stream.read(66)
            after = os.fstat(stream.fileno())
        current = path.lstat()
    except ReleaseError:
        raise
    except (OSError, ValueError) as exc:
        raise ReleaseError(
            "CANDIDATE_CIDFILE_INVALID"
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    stable = (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_nlink,
        before.st_size,
        before.st_mtime_ns,
    ) == (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_nlink,
        after.st_size,
        after.st_mtime_ns,
    ) == (
        current.st_dev,
        current.st_ino,
        current.st_mode,
        current.st_nlink,
        current.st_size,
        current.st_mtime_ns,
    )
    if (
        not stable
        or _is_symlink_or_reparse(current)
        or not stat.S_ISREG(current.st_mode)
        or current.st_nlink != 1
        or re.fullmatch(br"[0-9a-f]{64}\n?", body) is None
    ):
        fail("CANDIDATE_CIDFILE_INVALID")
    return body.rstrip(b"\n").decode("ascii")


def _launch_candidate_container(
        cidfile: Path, *command: str) -> str:
    try:
        cidfile.lstat()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise ReleaseError(
            "CANDIDATE_CIDFILE_PREEXISTING"
        ) from exc
    else:
        fail("CANDIDATE_CIDFILE_PREEXISTING")

    try:
        output = run(*command, capture=True)
    except BaseException as primary_error:
        try:
            container_id = _read_candidate_cidfile(cidfile)
        except ReleaseError as cidfile_error:
            message = ";".join((
                str(primary_error)
                or type(primary_error).__name__,
                str(cidfile_error),
            ))
            raise _CandidateContainerLaunchError(
                message
            ) from primary_error
        raise _CandidateContainerLaunchError(
            str(primary_error)
            or type(primary_error).__name__,
            container_id,
        ) from primary_error

    try:
        container_id = _read_candidate_cidfile(cidfile)
    except ReleaseError as cidfile_error:
        raise _CandidateContainerLaunchError(
            str(cidfile_error)
        ) from cidfile_error
    if output != container_id:
        raise _CandidateContainerLaunchError(
            "CANDIDATE_CONTAINER_ID_INVALID",
            container_id,
        )
    return container_id


def _close_phase5_candidate_handles(
        *handles) -> list[BaseException]:
    errors = []
    for handle in handles:
        if handle is None:
            continue
        try:
            handle.close()
        except BaseException as exc:
            errors.append(exc)
    return errors


def _cleanup_exact_candidate_containers(
        runtime_container_id: str | None,
        audio_container_id: str | None) -> list[BaseException]:
    errors = []
    for container_id in (
            runtime_container_id, audio_container_id):
        if container_id is None:
            continue
        try:
            cleanup = subprocess.run(
                ["docker", "rm", "-f", container_id]
            )
            if cleanup.returncode != 0:
                errors.append(ReleaseError(
                    "PARTIAL_STAGE_CLEANUP_FAILED"
                ))
        except BaseException as exc:
            errors.append(exc)
    return errors


def stage_local(args) -> None:
    release_dir = Path(args.release_dir).resolve()
    require_local_scope(args.release_dir, release_dir)
    manifest = manifest_pair(release_dir)
    verified_deploy_execution_path(
        release_dir, manifest, LEGACY_LEASE_TOOL_NAME)
    controller_sources = _verified_phase5_candidate_controller_sources(
        release_dir, manifest)
    controller = _load_phase5_candidate_controller_sources(
        controller_sources)
    release_manifest_sha256 = sha(
        release_dir / "release-manifest.json")
    identity = _phase5_candidate_identity(
        manifest, release_manifest_sha256)
    controller_uid, controller_gid = _effective_controller_ids()
    tags = manifest.get("localImageDiagnostics", {})
    runtime_tag = tags.get("runtime", {}).get("tag", "")
    audio_tag = tags.get("audio", {}).get("tag", "")
    if "latest" in runtime_tag or "latest" in audio_tag or not runtime_tag or not audio_tag:
        fail("IMMUTABLE_IMAGE_TAG_REQUIRED")
    for name, tag in (("runtime", runtime_tag), ("audio", audio_tag)):
        loaded = run("docker", "image", "inspect", "--format", "{{.Id}}", tag, capture=True)
        if loaded != tags[name].get("localEngineImageId"):
            fail("LOADED_IMAGE_CONFIG_MISMATCH")
    rollback_state = {
        "schemaVersion": 1,
        "releaseManifestSha256": release_manifest_sha256,
        "kind": "reset",
        "previousState": "absent",
        "stateRecord": {"policy": "reset-new-world"},
        "previousImageIdentity": manifest["imageIdentity"],
        "previousImages": {name: dict(tags[name]) for name in ("runtime", "audio")},
    }
    (release_dir / "rollback-state.json").write_bytes(canonical(rollback_state))
    socket_dir = release_dir / "run-flock-audio"
    socket_dir.mkdir(mode=0o770, exist_ok=True)
    os.chmod(socket_dir, 0o770)
    maintenance_secret = socket_dir / "maintenance-token"
    create_private_secret(maintenance_secret, secrets.token_urlsafe(48))
    user = f"{controller_uid}:{controller_gid}"
    for container in ("flock-runtime", "flock-audio"):
        probe = subprocess.run(["docker", "container", "inspect", container],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            fail("PRODUCTION_CONTAINER_PRESENT")
    for container in LOCAL_CONTAINERS:
        probe = subprocess.run(["docker", "container", "inspect", container],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            fail("CANDIDATE_CONTAINER_ALREADY_EXISTS")

    attempt_handle = None
    bootstrap_handle = None
    cidfile_layout = None
    audio_container_id = None
    runtime_container_id = None
    primary_error = None
    try:
        registry_root = _phase5_candidate_registry_root(release_dir)
        attempt_id = secrets.token_hex(16)
        if re.fullmatch(r"[0-9a-f]{32}", attempt_id) is None:
            fail("PHASE5_CANDIDATE_ATTEMPT_ID_INVALID")
        attempt_handle = controller.create_phase5_candidate_attempt(
            registry_root,
            attempt_id,
            release_manifest_sha256,
            controller_uid,
            controller_gid,
        )
        bootstrap_handle = (
            controller.prepare_phase5_candidate_bootstrap_linux(
                str(attempt_handle.bootstrap_bind_source),
                identity,
            )
        )
        cidfile_layout = _create_phase5_candidate_cidfile_layout(
            registry_root,
            attempt_id,
            controller_uid,
            controller_gid,
        )
        try:
            audio_container_id = _launch_candidate_container(
                cidfile_layout.audio_cidfile,
                "docker", "run", "-d", "--cidfile",
                str(cidfile_layout.audio_cidfile), "--name",
                "flock-audio-candidate", "--gpus", "all",
                "--user", user,
                "--mount",
                f"type=bind,src={release_dir},dst=/release,readonly",
                "--mount",
                f"type=bind,src={socket_dir},dst=/run/flock-audio",
                tags["audio"]["localEngineImageId"],
            )
        except _CandidateContainerLaunchError as exc:
            audio_container_id = exc.container_id
            raise
        try:
            runtime_container_id = _launch_candidate_container(
                cidfile_layout.runtime_cidfile,
                "docker", "run", "-d", "--cidfile",
                str(cidfile_layout.runtime_cidfile), "--name",
                "flock-runtime-candidate",
                "--user", user,
                "--publish", "127.0.0.1:18090:8090", "--env", "FLOCK_RUNTIME_PROFILE=container-local",
                "--env", f"FLOCK_RELEASE_REVISION={manifest['workerIdentity']['releaseRevision']}",
                "--env", f"FLOCK_SOURCE_MANIFEST_SHA256={manifest['workerIdentity']['sourceManifestSha256']}",
                "--mount", f"type=bind,src={release_dir},dst=/release,readonly",
                "--mount", f"type=bind,src={socket_dir},dst=/run/flock-audio",
                "--mount", f"type=bind,src={maintenance_secret},dst=/run/secrets/flock-maintenance-token,readonly",
            "--mount", (
                "type=bind,"
                f"src={attempt_handle.bootstrap_bind_source},"
                    "dst=/run/flock-phase5-bootstrap,readonly"
                ),
                "--mount", (
                    "type=bind,"
                    f"src={attempt_handle.candidate_bind_source},"
                    "dst=/run/flock-phase5-candidate"
                ),
                tags["runtime"]["localEngineImageId"],
            )
        except _CandidateContainerLaunchError as exc:
            runtime_container_id = exc.container_id
            raise
        candidate_pid = _validated_candidate_pid(run(
            "docker", "container", "inspect", "--format",
            "{{.State.Pid}}", runtime_container_id, capture=True,
        ))
        candidate_uid = _validated_candidate_uid(run(
            "docker", "container", "inspect", "--format",
            "{{.Config.User}}", runtime_container_id, capture=True,
        ), controller_uid)

        def commit_admission(
                *, admission_raw, candidate_pid, candidate_uid,
                expected_identity):
            committed = controller.commit_phase5_candidate_admission(
                attempt=attempt_handle,
                expected_intent_sha256=attempt_handle.intent_sha256,
                candidate_container_id=runtime_container_id,
                candidate_pid=candidate_pid,
                candidate_uid=candidate_uid,
                expected_identity=expected_identity,
                admission_raw=admission_raw,
            )
            return {
                "admissionSha256": committed.admission_sha256,
            }

        bootstrap_handle.complete(
            candidate_pid,
            candidate_uid,
            commit_admission,
        )
    except BaseException as exc:
        primary_error = exc

    close_errors = _close_phase5_candidate_handles(
        bootstrap_handle, attempt_handle, cidfile_layout)
    if primary_error is None and close_errors:
        primary_error = ReleaseError(
            "PHASE5_STAGE_HANDLE_CLOSE_FAILED")
    if primary_error is not None:
        cleanup_errors = _cleanup_exact_candidate_containers(
            runtime_container_id, audio_container_id)
        suffixes = []
        if close_errors:
            suffixes.append("PHASE5_STAGE_HANDLE_CLOSE_FAILED")
        if cleanup_errors:
            suffixes.append("PARTIAL_STAGE_CLEANUP_FAILED")
        if suffixes:
            primary_code = (
                str(primary_error)
                or type(primary_error).__name__
            )
            raise ReleaseError(
                ";".join((primary_code, *suffixes))
            ) from primary_error
        if isinstance(primary_error, ReleaseError):
            raise primary_error
        if isinstance(primary_error, Exception):
            raise ReleaseError(
                str(primary_error)
                or "PHASE5_CANDIDATE_STAGE_FAILED"
            ) from primary_error
        raise primary_error


def get_candidate_ops_json(path: str) -> tuple[int, dict]:
    if path not in {"/healthz", "/readyz"}:
        fail("CANDIDATE_OPS_PROBE_PATH_INVALID")
    probe = (
        "const http=require('node:http');"
        "const path=process.argv[1];"
        "if(!['/healthz','/readyz'].includes(path))process.exit(2);"
        "let request;"
        "const deadline=setTimeout(()=>{request?.destroy();process.exit(2);},5000);"
        "request=http.get('http://127.0.0.1:8090'+path,{agent:false,"
        "localAddress:'127.0.0.1',headers:{Host:'127.0.0.1:8090'}},response=>{"
        "const chunks=[];let size=0;"
        "response.on('data',chunk=>{size+=chunk.length;"
        "if(size>65536){request.destroy();return;}chunks.push(chunk);});"
        "response.on('aborted',()=>{clearTimeout(deadline);process.exit(2);});"
        "response.on('error',()=>{clearTimeout(deadline);process.exit(2);});"
        "response.on('end',()=>{clearTimeout(deadline);"
        "try{const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));"
        "process.stdout.write(JSON.stringify({statusCode:response.statusCode,body}),"
        "error=>process.exit(error?2:0));}catch{process.exit(2);}});});"
        "request.on('error',()=>{clearTimeout(deadline);process.exit(2);});"
    )
    try:
        payload = json.loads(run(
            "docker", "exec", "flock-runtime-candidate",
            "node", "-e", probe, path, capture=True, timeout=7,
            strict_stderr=True,
        ))
    except ReleaseError as exc:
        raise ReleaseError("CANDIDATE_OPS_PROBE_FAILED") from exc
    except (TypeError, json.JSONDecodeError) as exc:
        raise ReleaseError("CANDIDATE_OPS_PROBE_INVALID") from exc
    if (not isinstance(payload, dict)
            or set(payload) != {"statusCode", "body"}
            or type(payload["statusCode"]) is not int
            or not isinstance(payload["body"], dict)):
        fail("CANDIDATE_OPS_PROBE_INVALID")
    return payload["statusCode"], payload["body"]


def verify_candidate(args) -> None:
    release_dir = Path(args.release_dir).resolve()
    manifest = manifest_pair(release_dir)
    if args.base_url != "http://127.0.0.1:18090":
        fail("LOOPBACK_CANDIDATE_URL_REQUIRED")
    _, smoke_bytes = verified_deploy_execution(
        release_dir, manifest, "verify-smoke.mjs")
    try:
        smoke_source = smoke_bytes.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ReleaseError("DEPLOY_EXECUTION_UTF8_INVALID") from exc
    diagnostics = manifest.get("localImageDiagnostics", {})
    runtime = diagnostics.get("runtime", {}) if isinstance(diagnostics, dict) else {}
    runtime_tag = runtime.get("tag") if isinstance(runtime, dict) else None
    runtime_image_id = (
        runtime.get("localEngineImageId") if isinstance(runtime, dict) else None)
    if (not isinstance(runtime_tag, str) or not runtime_tag
            or "latest" in runtime_tag):
        fail("IMMUTABLE_IMAGE_TAG_REQUIRED")
    if (not isinstance(runtime_image_id, str)
            or DIGEST.fullmatch(runtime_image_id) is None):
        fail("LOADED_IMAGE_CONFIG_MISMATCH")
    loaded_image_id = run(
        "docker", "image", "inspect", "--format", "{{.Id}}", runtime_tag,
        capture=True)
    if loaded_image_id != runtime_image_id:
        fail("LOADED_IMAGE_CONFIG_MISMATCH")
    health_status, _ = get_candidate_ops_json("/healthz")
    ready_status, ready = get_candidate_ops_json("/readyz")
    identity = ready.get("workerIdentity", {})
    valid = (health_status == 200 and ready_status == 200 and ready.get("runtimeOwner") == "server"
             and ready.get("audioOwner") == "world" and ready.get("workerReady") is True
             and identity.get("expected") == identity.get("reported") == manifest.get("workerIdentity")
             and ready.get("phaseGate") in {"phase5-local", "phase5-production"})
    if not valid:
        fail("CANDIDATE_NOT_IDENTITY_READY")
    run(
        "docker", "run", "-i", "--rm", "--pull", "never", "--network",
        "host", "--read-only", "--cap-drop", "ALL", "--security-opt",
        "no-new-privileges", "--user", container_user(), "--workdir",
        "/app/flock-voice-engine/runtime", "--entrypoint", "node",
        runtime_image_id, "--input-type=module", "-", args.base_url,
        input_text=smoke_source, timeout=45,
    )


def verify_local(args) -> None:
    require_local_scope()
    verify_candidate(args)
    record = Path(args.release_dir) / "local-verification.json"
    record.write_bytes(canonical({"schemaVersion": 1, "status": "verified-local-only",
                                  "cutoverEligible": False,
                                  "releaseManifestSha256": sha(Path(args.release_dir) / "release-manifest.json")}))


def checksum(path: Path) -> None:
    path.with_name(path.name + ".sha256").write_text(f"{sha(path)}  {path.name}\n", encoding="ascii")


def bound_record(path: Path, release_sha: str, status: str, code: str) -> dict:
    value = load_json(path, code)
    bound_sha = value.get("releaseManifestSha256")
    if status == "accepted":
        bound_sha = value.get("release", {}).get("releaseManifestSha256")
    if (canonical(value) != path.read_bytes() or value.get("schemaVersion") != 1
            or value.get("status") != status
            or bound_sha != release_sha):
        fail(code)
    return value


def exact_checksum(path: Path) -> None:
    sidecar = path.with_name(path.name + ".sha256")
    try:
        value = sidecar.read_text("ascii")
    except OSError as exc:
        raise ReleaseError("CHECKSUM_SIDECAR_MISSING") from exc
    if value != f"{sha(path)}  {path.name}\n":
        fail("CHECKSUM_SIDECAR_INVALID")


def archive_member_sha(archive: Path, member: str) -> str:
    try:
        body = subprocess.check_output([
            _controlled_executable("PHASE6_APPROVED_TAR_EXE", "tar"),
            "--zstd",
            "-xOf",
            str(archive),
            member,
        ])
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("PACKAGE_ARCHIVE_INVALID") from exc
    return hashlib.sha256(body).hexdigest()


def validate_acceptance_bundle(release_dir: Path, equivalence: Path) -> None:
    manifest = manifest_pair(release_dir)
    code = "ACCEPTANCE_VALIDATOR_IDENTITY_MISMATCH"
    verified = {}
    try:
        parent_state = _verified_nested_deploy_parent_state(
            release_dir, code)
        for name in (
                "validate_phase5_acceptance.py",
                "acceptance.schema.json",
                "machine-attestation.schema.json",
                *FAULT_VERIFIER_DEPLOY_NAMES,
                *PHASE5_SUMMARY_DEPLOY_NAMES):
            _, body = verified_deploy_execution(
                release_dir, manifest, name)
            verified[name] = body
        if parent_state != _verified_nested_deploy_parent_state(
                release_dir, code):
            fail(code)
    except ReleaseError as exc:
        if str(exc) == code:
            raise
        raise ReleaseError(code) from exc

    try:
        with tempfile.TemporaryDirectory(
                prefix="flock-phase5-acceptance-") as temporary:
            snapshot_root = Path(temporary)
            for name, body in verified.items():
                destination = snapshot_root / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(body)

            module_name = "phase5_acceptance_release"
            validator_path = (
                snapshot_root / "validate_phase5_acceptance.py")
            validator = types.ModuleType(module_name)
            validator.__file__ = str(validator_path)
            validator.__package__ = ""
            validator.__spec__ = None
            compiled = compile(
                verified["validate_phase5_acceptance.py"],
                str(validator_path),
                "exec",
                dont_inherit=True,
            )
            previous = sys.modules.get(module_name)
            sys.modules[module_name] = validator
            try:
                exec(compiled, validator.__dict__)
                validator.validate_bundle(
                    release_dir / "acceptance.json",
                    release_dir / "release-manifest.json",
                    equivalence,
                )
            finally:
                if previous is None:
                    sys.modules.pop(module_name, None)
                else:
                    sys.modules[module_name] = previous
    except Exception as exc:
        if isinstance(exc, ReleaseError):
            raise
        raise ReleaseError(str(exc) or "ACCEPTANCE_REQUIRED") from exc


def materialize_acceptance_inputs(release_dir: Path, equivalence: Path) -> Path:
    destination = release_dir / "acceptance-inputs"
    temporary = release_dir / ".acceptance-inputs.tmp"
    if destination.exists() or temporary.exists():
        fail("ACCEPTANCE_INPUTS_ALREADY_MATERIALIZED")
    production = equivalence.parent / "production-machine-attestation.json"
    evidence = production.with_suffix(".evidence")
    expected_evidence = ("machine-id", "ssh-host-ed25519.pub", "interfaces.json", "gpus.txt",
                         "cuda-driver.txt", "torch.json", "available-memory.txt",
                         "architecture.txt",
                         "vllm-normal-profile.json", "vllm-burst-profile.json")
    sources = [equivalence, production, *(evidence / name for name in expected_evidence)]
    if any(path.is_symlink() or not path.is_file() for path in sources):
        fail("EQUIVALENT_STAGING_REQUIRED")
    temporary.mkdir(mode=0o700)
    (temporary / "production-machine-attestation.evidence").mkdir(mode=0o700)
    try:
        shutil.copy2(equivalence, temporary / "staging-equivalence.json")
        shutil.copy2(production, temporary / production.name)
        for name in expected_evidence:
            shutil.copy2(evidence / name, temporary / "production-machine-attestation.evidence" / name)
        validate_acceptance_bundle(release_dir, temporary / "staging-equivalence.json")
        os.replace(temporary, destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return destination / "staging-equivalence.json"


def package(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    manifest_pair(release_dir)
    release_sha = sha(release_dir / "release-manifest.json")
    equivalence = (Path(args.equivalence).resolve() if getattr(args, "equivalence", None)
                   else release_dir.parent / "phase5-inputs/staging-equivalence.json")
    validate_acceptance_bundle(release_dir, equivalence)
    embedded_equivalence = materialize_acceptance_inputs(release_dir, equivalence)
    output = release_dir
    for name in ("release.tar.zst", "release.tar.zst.sha256", "import-release.sh",
                 "import-release.sh.sha256"):
        if (output / name).exists():
            fail("PACKAGE_OUTPUT_EXISTS")
    archive = output / "release.tar.zst"
    package_record = {"schemaVersion": 1, "status": "packaged",
                      "releaseManifestSha256": sha(release_dir / "release-manifest.json"),
                      "acceptanceSha256": sha(release_dir / "acceptance.json"),
                      "equivalenceSha256": sha(embedded_equivalence),
                      "acceptanceValidatorSha256": sha(release_dir / "deploy/validate_phase5_acceptance.py")}
    (release_dir / "package.json").write_bytes(canonical(package_record))
    temporary_archive = release_dir.parent / f".{release_dir.name}-release.tar.zst.tmp"
    if temporary_archive.exists():
        fail("PACKAGE_OUTPUT_EXISTS")
    try:
        run(
            _controlled_executable("PHASE6_APPROVED_TAR_EXE", "tar"),
            "--zstd",
            "-cf",
            str(temporary_archive),
            f"--exclude={release_dir.name}/run-flock-audio",
            "-C",
            str(release_dir.parent),
            release_dir.name,
        )
        os.replace(temporary_archive, archive)
    finally:
        temporary_archive.unlink(missing_ok=True)
    checksum(archive)
    bootstrap = Path(__file__).with_name("import-release.sh")
    shutil.copy2(bootstrap, output / bootstrap.name)
    checksum(output / bootstrap.name)


def import_release(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    manifest = manifest_pair(release_dir)
    for name in ("runtime", "audio"):
        archive = release_dir / "images" / f"{name}.oci.tar"
        digest, config = oci_manifest_digest(archive)
        if digest != manifest.get("imageIdentity", {}).get(name):
            fail("OCI_IMAGE_IDENTITY_MISMATCH")
        output = run("docker", "load", "--input", str(archive), capture=True)
        if not output:
            fail("IMAGE_IMPORT_FAILED")
        expected_config = manifest.get("localImageDiagnostics", {}).get(name, {}).get("localEngineImageId")
        tag = manifest.get("localImageDiagnostics", {}).get(name, {}).get("tag")
        loaded_config = run("docker", "image", "inspect", "--format", "{{.Id}}", tag, capture=True)
        if not expected_config or expected_config != config or loaded_config != config:
            fail("LOADED_IMAGE_CONFIG_MISMATCH")


def prepare_request(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    release_sha = sha(release_dir / "release-manifest.json")
    if args.state_policy != "reset-new-world":
        fail("CUTOVER_REQUEST_PREREQUISITE_MISSING")
    bound_record(release_dir / "acceptance.json", release_sha, "accepted",
                 "CUTOVER_REQUEST_PREREQUISITE_MISSING")
    package_record = bound_record(release_dir / "package.json", release_sha, "packaged",
                                  "CUTOVER_REQUEST_PREREQUISITE_MISSING")
    embedded_equivalence = release_dir / "acceptance-inputs/staging-equivalence.json"
    if (not embedded_equivalence.is_file()
            or not (release_dir / "deploy/validate_phase5_acceptance.py").is_file()
            or package_record.get("acceptanceSha256") != sha(release_dir / "acceptance.json")
            or package_record.get("equivalenceSha256") != sha(embedded_equivalence)
            or package_record.get("acceptanceValidatorSha256")
            != sha(release_dir / "deploy/validate_phase5_acceptance.py")):
        fail("CUTOVER_REQUEST_PREREQUISITE_MISSING")
    validate_acceptance_bundle(release_dir, embedded_equivalence)
    exact_checksum(release_dir / "release.tar.zst")
    exact_checksum(release_dir / "import-release.sh")
    archive_prefix = release_dir.name
    if (archive_member_sha(release_dir / "release.tar.zst", f"{archive_prefix}/acceptance.json")
            != package_record["acceptanceSha256"]
            or archive_member_sha(release_dir / "release.tar.zst", f"{archive_prefix}/package.json")
            != sha(release_dir / "package.json")):
        fail("PACKAGE_ARCHIVE_INVALID")
    output = Path(args.output).resolve()
    evidence = [release_dir / name for name in ("initial-world.json", "bootstrap.json",
                                                 "state-replace.json")]
    if (output != release_dir / "cutover-request.json" or output.exists()
            or any(path.exists() for path in evidence)):
        fail("CUTOVER_REQUEST_OUTPUT_EXISTS")
    manifest = manifest_pair(release_dir)
    tool = release_dir / "deploy/prepare-cutover-request.mjs"
    expected_tool = manifest.get("deployExecutionIdentity", {}).get(tool.name)
    if not expected_tool or sha(tool) != expected_tool:
        fail("DEPLOY_EXECUTION_DIGEST_MISMATCH")
    source_manifest = load_json(release_dir / "source-manifest.json", "SOURCE_MANIFEST_INVALID")
    if (canonical(source_manifest) != (release_dir / "source-manifest.json").read_bytes()
            or sha(release_dir / "source-manifest.json")
            != manifest["workerIdentity"]["sourceManifestSha256"]):
        fail("SOURCE_MANIFEST_MISMATCH")
    source_entries = {item.get("path"): item for item in source_manifest.get("entries", [])
                      if isinstance(item, dict)}
    source_root = release_dir / "source"
    for source in source_root.rglob("*"):
        if source.is_symlink():
            fail("SOURCE_MANIFEST_INVALID")
        if not source.is_file():
            if source.is_dir():
                continue
            fail("SOURCE_MANIFEST_INVALID")
        relative = source.relative_to(source_root).as_posix()
        logical = relative if relative.startswith("mvp/") else relative
        item = source_entries.get(logical)
        if not item or item.get("byteCount") != source.stat().st_size or item.get("sha256") != sha(source):
            fail("SOURCE_MANIFEST_MISMATCH")
    diagnostics = manifest["localImageDiagnostics"]["runtime"]
    if run("docker", "image", "inspect", "--format", "{{.Id}}", diagnostics["tag"],
           capture=True) != diagnostics["localEngineImageId"]:
        fail("LOADED_IMAGE_CONFIG_MISMATCH")
    run("docker", "run", "--rm", "--network", "none", "--user",
        container_user(), "--entrypoint", "node",
        "--mount", f"type=bind,src={release_dir},dst=/release",
        diagnostics["localEngineImageId"],
        "/release/deploy/prepare-cutover-request.mjs", "--release-dir", "/release",
        "--runtime-root", "/release/source/flock-voice-engine/runtime",
        "--state-policy", args.state_policy, "--output", "/release/cutover-request.json")


def rollback(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    manifest_pair(release_dir)
    state = load_json(release_dir / "rollback-state.json", "ROLLBACK_STATE_MISSING")
    release_sha = sha(release_dir / "release-manifest.json")
    if (canonical(state) != (release_dir / "rollback-state.json").read_bytes()
            or state.get("schemaVersion") != 1 or state.get("releaseManifestSha256") != release_sha
            or state.get("kind") not in {"reset", "snapshot"}
            or state.get("previousState") not in {"absent", "running"}
            or set(state.get("previousImageIdentity", {})) != {"runtime", "audio"}
            or set(state.get("previousImages", {})) != {"runtime", "audio"}):
        fail("ROLLBACK_STATE_INVALID")
    record = state.get("stateRecord")
    if (state["kind"] == "reset" and (not isinstance(record, dict)
            or record.get("policy") != "reset-new-world")):
        fail("ROLLBACK_STATE_INVALID")
    if state["kind"] == "snapshot" and (not isinstance(record, dict)
            or not isinstance(record.get("worldGeneration"), str)):
        fail("ROLLBACK_STATE_INVALID")
    for name in ("runtime", "audio"):
        image = state["previousImages"][name]
        if (DIGEST.fullmatch(state["previousImageIdentity"][name]) is None
                or DIGEST.fullmatch(image.get("localEngineImageId", "")) is None
                or not isinstance(image.get("tag"), str)
                or run("docker", "image", "inspect", "--format", "{{.Id}}",
                       image["tag"], capture=True) != image["localEngineImageId"]):
            fail("ROLLBACK_IMAGE_MISSING")
    for container in LOCAL_CONTAINERS:
        removed = subprocess.run(["docker", "rm", "-f", container], check=False)
        if removed.returncode != 0:
            fail("ROLLBACK_CANDIDATE_REMOVE_FAILED")


def status(args) -> None:
    require_local_scope()
    run("docker", "ps", "--filter", "name=flock-runtime-candidate", "--filter", "name=flock-audio-candidate")


def legacy_lease(args) -> int:
    release_dir = Path(args.release_dir).resolve()
    require_local_scope(args.release_dir, release_dir)
    if (args.action != "hold"
            or PROTOCOL_TOKEN.fullmatch(args.decoder_session_id) is None):
        fail("LEGACY_LEASE_ARGUMENT_INVALID")
    manifest = manifest_pair(release_dir)
    _, lease_body = verified_deploy_execution(
        release_dir, manifest, LEGACY_LEASE_TOOL_NAME)
    try:
        lease_body.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ReleaseError("LEGACY_LEASE_SOURCE_INVALID") from exc
    runtime_container_id = _validated_candidate_container_id(run(
        "docker", "container", "inspect", "--format", "{{.Id}}",
        "flock-runtime-candidate", capture=True))
    try:
        mounts = json.loads(run(
            "docker", "container", "inspect", "--format", "{{json .Mounts}}",
            runtime_container_id, capture=True))
    except (TypeError, json.JSONDecodeError) as exc:
        raise ReleaseError("LEGACY_LEASE_MOUNT_MISMATCH") from exc
    matching = [
        item for item in mounts
        if isinstance(item, dict)
        and item.get("Destination") == LEGACY_LEASE_CONTAINER_PATH
    ] if isinstance(mounts, list) else []
    if (
        not isinstance(mounts, list)
        or any(not isinstance(item, dict) for item in mounts)
        or matching
    ):
        fail("LEGACY_LEASE_MOUNT_MISMATCH")
    command = [
        "docker", "exec", "-i", "--workdir", LEGACY_LEASE_WORKDIR,
        runtime_container_id,
        "node", "--input-type=module", "-",
        args.action, args.decoder_session_id,
    ]
    try:
        result = subprocess.run(
            command,
            check=False,
            input=(
                lease_body
                + LEGACY_LEASE_STDIN_SHIM.encode("utf-8")
            ),
        )
    except (OSError, ValueError, UnicodeError) as exc:
        raise ReleaseError("COMMAND_FAILED") from exc
    return result.returncode


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-local"); build.add_argument("--inputs", required=True); build.add_argument("--output", required=True); build.set_defaults(fn=build_local)
    stage = commands.add_parser("stage-local"); stage.add_argument("--release-dir", required=True); stage.set_defaults(fn=stage_local)
    for name, fn in (("verify-local", verify_local), ("verify-candidate", verify_candidate)):
        item = commands.add_parser(name); item.add_argument("--release-dir", required=True); item.add_argument("--base-url", required=True); item.set_defaults(fn=fn)
    pack = commands.add_parser("package"); pack.add_argument("--release-dir", required=True); pack.add_argument("--equivalence"); pack.set_defaults(fn=package)
    imp = commands.add_parser("import"); imp.add_argument("--release-dir", required=True); imp.set_defaults(fn=import_release)
    prep = commands.add_parser("prepare-cutover-request"); prep.add_argument("--release-dir", required=True); prep.add_argument("--state-policy", required=True); prep.add_argument("--output", required=True); prep.set_defaults(fn=prepare_request)
    rollback_p = commands.add_parser("rollback"); rollback_p.add_argument("--release-dir", required=True); rollback_p.set_defaults(fn=rollback)
    status_p = commands.add_parser("status"); status_p.set_defaults(fn=status)
    lease = commands.add_parser("legacy-lease")
    lease.add_argument("--release-dir", required=True)
    lease.add_argument("action", choices=("hold",))
    lease.add_argument("decoder_session_id")
    lease.set_defaults(fn=legacy_lease)
    cutover = commands.add_parser("cutover"); cutover.set_defaults(fn=lambda _: fail("PRODUCTION_RELEASE_AUTHORIZATION_REQUIRED"))
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        require_release_gate_platform()
        result = args.fn(args)
    except ReleaseError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return result if isinstance(result, int) else 0


if __name__ == "__main__":
    raise SystemExit(main())
