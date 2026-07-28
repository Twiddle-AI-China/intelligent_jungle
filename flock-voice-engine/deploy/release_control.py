#!/usr/bin/env python3
"""Fail-closed Phase 5 release controller (local scope through Task 9)."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import os
import posixpath
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request
from pathlib import Path

DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
RAW_SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
LOCAL_CONTAINERS = ("flock-runtime-candidate", "flock-audio-candidate")
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
    "c5bd074e119c4a15faea193258daa687f2bd8f980b032871c4b411d63163be28"
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


def load_json(path: Path, code: str = "RELEASE_MANIFEST_INVALID") -> dict:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReleaseError(code) from exc
    if not isinstance(value, dict):
        fail(code)
    return value


def require_local_scope() -> None:
    if os.environ.get("FLOCK_DEPLOY_SCOPE") != "local":
        fail("LOCAL_DEPLOY_SCOPE_REQUIRED")
    forbidden = " ".join(sys.argv + list(os.environ.values()))
    if any(token in forbidden for token in ("192.168.9.140", "/srv/deploy", "0.0.0.0:8090:8090")):
        fail("PRODUCTION_TARGET_REJECTED")


def require_release_gate_platform() -> None:
    if sys.platform != "linux":
        fail("RELEASE_GATE_REQUIRES_LINUX")


def container_user() -> str:
    return f"{os.getuid()}:{os.getgid()}"


def run(*args: str, capture: bool = False) -> str:
    try:
        result = subprocess.run(args, check=True, text=True,
                                stdout=subprocess.PIPE if capture else None)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("COMMAND_FAILED") from exc
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


def git_blob(repo: Path, revision: str, relative: str) -> bytes:
    require_revision(revision)
    try:
        return subprocess.check_output(
            ["git", "-C", str(repo), "show", f"{revision}:{relative}"])
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc


def git_tree_names(repo: Path, revision: str, scope: str | None = None) -> list[str]:
    require_revision(revision)
    command = ["git", "-C", str(repo), "ls-tree", "-r", "--name-only", revision]
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
        snapshot.mkdir(mode=0o700)
        snapshot_created = True
        try:
            archive = subprocess.check_output(
                ["git", "-C", str(repo), "archive", "--format=tar", revision])
        except (OSError, subprocess.CalledProcessError) as exc:
            raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tf:
            members = tf.getmembers()
            if any(not (member.isdir() or member.isfile()) for member in members):
                fail("SOURCE_PATH_INVALID")
            if hasattr(tarfile, "data_filter"):
                tf.extractall(snapshot, members=members, filter="data")
            else:
                tf.extractall(snapshot, members=members)
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
                "node",
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
                shutil.rmtree(snapshot)
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
    destination.mkdir(mode=0o700)
    try:
        archive = subprocess.check_output(
            ["git", "-C", str(repo), "archive", "--format=tar", revision])
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("PRODUCTION_GRAPH_SOURCE_READ_FAILED") from exc
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tf:
        members = tf.getmembers()
        if any(not (member.isdir() or member.isfile()) for member in members):
            fail("SOURCE_PATH_INVALID")
        if hasattr(tarfile, "data_filter"):
            tf.extractall(destination, members=members, filter="data")
        else:
            tf.extractall(destination, members=members)
    return destination


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
    revision = require_revision(command_runner(
        "git", "-C", str(repo), "rev-parse", "HEAD", capture=True))
    builder_snapshot = (
        output.parent
        / f".{output.name}-builder-{secrets.token_hex(12)}"
    )
    try:
        materialize_revision_snapshot(repo, revision, builder_snapshot)
        builder = (
            builder_snapshot
            / "flock-voice-engine/tools/build_release_artifact.py"
        )
        command_runner(sys.executable, str(builder), "--repo-root", str(repo),
                       "--inputs", str(inputs), "--output", str(output))
    finally:
        if builder_snapshot.is_dir():
            shutil.rmtree(builder_snapshot)
    built_manifest = manifest_pair(output)
    if built_manifest.get("workerIdentity", {}).get("releaseRevision") != revision:
        fail("CANDIDATE_REVISION_CHANGED")
    (output / "deploy").mkdir()
    copy_tracked_scope(
        repo, revision, "flock-voice-engine/deploy", output / "deploy")
    (output / "deploy/prepare-cutover-request.mjs").write_bytes(git_blob(
        repo, revision,
        "flock-voice-engine/runtime/tools/prepare-cutover-request.mjs"))
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
        for name in ("release.sh", "release_control.py", "verify-smoke.mjs",
                     "verify-candidate.sh", "prepare-cutover-request.mjs",
                     "validate_phase5_acceptance.py", "acceptance.schema.json",
                     "machine-attestation.schema.json")
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
    if command_runner("git", "-C", str(repo), "status", "--porcelain",
                      "--untracked-files=no", capture=True):
        fail("TRACKED_TREE_DIRTY")
    if command_runner("git", "-C", str(repo), "rev-parse", "HEAD",
                      capture=True) != revision:
        fail("CANDIDATE_REVISION_CHANGED")
    verify_production_graph_binding(output, graph_sha)
    write_manifest_pair(output, manifest)
    shutil.rmtree(runtime_context)
    shutil.rmtree(audio_context)


def stage_local(args) -> None:
    require_local_scope()
    release_dir = Path(args.release_dir).resolve()
    manifest = manifest_pair(release_dir)
    revision = manifest["workerIdentity"]["releaseRevision"]
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
        "releaseManifestSha256": sha(release_dir / "release-manifest.json"),
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
    maintenance_secret.write_text(secrets.token_urlsafe(48), encoding="utf-8")
    os.chmod(maintenance_secret, 0o400)
    user = container_user()
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
    run("docker", "run", "-d", "--name", "flock-audio-candidate", "--gpus", "all",
        "--user", user,
        "--mount", f"type=bind,src={release_dir},dst=/release,readonly",
        "--mount", f"type=bind,src={socket_dir},dst=/run/flock-audio",
        tags["audio"]["localEngineImageId"])
    try:
        run("docker", "run", "-d", "--name", "flock-runtime-candidate",
            "--user", user,
            "--publish", "127.0.0.1:18090:8090", "--env", "FLOCK_RUNTIME_PROFILE=container-local",
            "--env", f"FLOCK_RELEASE_REVISION={manifest['workerIdentity']['releaseRevision']}",
            "--env", f"FLOCK_SOURCE_MANIFEST_SHA256={manifest['workerIdentity']['sourceManifestSha256']}",
            "--mount", f"type=bind,src={release_dir},dst=/release,readonly",
            "--mount", f"type=bind,src={socket_dir},dst=/run/flock-audio",
            "--mount", f"type=bind,src={maintenance_secret},dst=/run/secrets/flock-maintenance-token,readonly",
            tags["runtime"]["localEngineImageId"])
    except ReleaseError:
        cleanup = subprocess.run(["docker", "rm", "-f", "flock-audio-candidate"])
        if cleanup.returncode != 0:
            fail("PARTIAL_STAGE_CLEANUP_FAILED")
        raise


def get_json(base: str, path: str) -> tuple[int, dict]:
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(base + path, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try: return exc.code, json.loads(exc.read())
        except Exception: return exc.code, {}
    except Exception as exc:
        raise ReleaseError("CANDIDATE_HTTP_FAILED") from exc


def verify_candidate(args) -> None:
    release_dir = Path(args.release_dir).resolve()
    manifest = manifest_pair(release_dir)
    if args.base_url != "http://127.0.0.1:18090":
        fail("LOOPBACK_CANDIDATE_URL_REQUIRED")
    health_status, _ = get_json(args.base_url, "/healthz")
    ready_status, ready = get_json(args.base_url, "/readyz")
    identity = ready.get("workerIdentity", {})
    valid = (health_status == 200 and ready_status == 200 and ready.get("runtimeOwner") == "server"
             and ready.get("audioOwner") == "world" and ready.get("workerReady") is True
             and identity.get("expected") == identity.get("reported") == manifest.get("workerIdentity")
             and ready.get("phaseGate") in {"phase5-local", "phase5-production"})
    if not valid:
        fail("CANDIDATE_NOT_IDENTITY_READY")
    status, _ = get_json(args.base_url, "/api/decoder-status")
    if status != 200:
        fail("CANDIDATE_SMOKE_FAILED")
    run("node", str(Path(__file__).with_name("verify-smoke.mjs")), args.base_url)


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
        body = subprocess.check_output(["tar", "--zstd", "-xOf", str(archive), member])
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError("PACKAGE_ARCHIVE_INVALID") from exc
    return hashlib.sha256(body).hexdigest()


def validate_acceptance_bundle(release_dir: Path, equivalence: Path) -> None:
    manifest = manifest_pair(release_dir)
    validator_path = release_dir / "deploy/validate_phase5_acceptance.py"
    identity = manifest.get("deployExecutionIdentity", {})
    for name in ("validate_phase5_acceptance.py", "acceptance.schema.json",
                 "machine-attestation.schema.json"):
        path = release_dir / "deploy" / name
        if not path.is_file() or sha(path) != identity.get(name):
            fail("ACCEPTANCE_VALIDATOR_IDENTITY_MISMATCH")
    if not validator_path.is_file():
        fail("ACCEPTANCE_VALIDATOR_MISSING")
    spec = importlib.util.spec_from_file_location("phase5_acceptance_release", validator_path)
    validator = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(validator)
        validator.validate_bundle(release_dir / "acceptance.json",
                                  release_dir / "release-manifest.json", equivalence)
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
        run("tar", "--zstd", "-cf", str(temporary_archive),
            f"--exclude={release_dir.name}/run-flock-audio",
            "-C", str(release_dir.parent), release_dir.name)
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
    cutover = commands.add_parser("cutover"); cutover.set_defaults(fn=lambda _: fail("PRODUCTION_RELEASE_AUTHORIZATION_REQUIRED"))
    return root


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        require_release_gate_platform()
        args.fn(args)
    except ReleaseError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
