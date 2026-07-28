from __future__ import annotations

import copy
import functools
import hashlib
import importlib.util
import inspect
import json
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

import pytest

from linux_release_security import linux_release_security

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "flock-voice-engine/deploy"
spec = importlib.util.spec_from_file_location("release_control", DEPLOY / "release_control.py")
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)

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


def route_mime(repo_path: str) -> str:
    if repo_path.endswith(".html"):
        return "text/html; charset=utf-8"
    if repo_path.endswith(".js"):
        return "application/javascript; charset=utf-8"
    if repo_path.endswith(".json"):
        return "application/json; charset=utf-8"
    raise AssertionError(repo_path)


def trusted_bash() -> Path:
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    bash = windows_git_bash if windows_git_bash.is_file() else Path("/bin/bash")
    assert bash.is_file(), "需要 Git Bash 或 POSIX /bin/bash 执行发布契约测试"
    return bash


def python3_shim(path: Path) -> None:
    body = (
        "#!/bin/sh\nexec "
        + shlex.quote(Path(sys.executable).as_posix())
        + ' "$@"\n'
    ).encode("utf-8")
    path.write_bytes(body)
    path.chmod(0o755)


def run_bash_action(
    script: Path,
    action: str,
    stub_bin: Path,
    env: dict[str, str],
) -> subprocess.CompletedProcess[bytes]:
    bash = trusted_bash()
    if os.name == "nt":
        command = [
            str(bash),
            "-c",
            (
                'stub="$(cygpath -u "$1")"\n'
                'script="$(cygpath -u "$2")"\n'
                'PATH="$stub:$PATH"\n'
                "export PATH\n"
                'exec "$script" "$3"\n'
            ),
            "phase5-contract",
            str(stub_bin),
            str(script),
            action,
        ]
    else:
        command = [str(bash), str(script), action]
    return subprocess.run(command, env=env, capture_output=True, check=False)


def run_import_bootstrap(
    script: Path,
    archive: Path,
    stub_bin: Path,
    env: dict[str, str],
) -> subprocess.CompletedProcess[bytes]:
    bash = trusted_bash()
    archive_sidecar = archive.with_name(archive.name + ".sha256")
    bootstrap_sidecar = script.with_name(script.name + ".sha256")
    if os.name == "nt":
        command = [
            str(bash),
            "-c",
            (
                'stub="$(cygpath -u "$1")"\n'
                'script="$(cygpath -u "$2")"\n'
                'archive="$(cygpath -u "$3")"\n'
                'archive_sidecar="$(cygpath -u "$4")"\n'
                'bootstrap_sidecar="$(cygpath -u "$5")"\n'
                'PATH="$stub:$PATH"\n'
                "export PATH\n"
                'exec "$script" "$archive" "$archive_sidecar" "$bootstrap_sidecar"\n'
            ),
            "phase5-import-contract",
            str(stub_bin),
            str(script),
            str(archive),
            str(archive_sidecar),
            str(bootstrap_sidecar),
        ]
    else:
        command = [
            str(bash),
            str(script),
            str(archive),
            str(archive_sidecar),
            str(bootstrap_sidecar),
        ]
    return subprocess.run(command, env=env, capture_output=True, check=False)


def test_package_excludes_candidate_runtime_secrets_and_sockets():
    source = inspect.getsource(release.package)
    assert "--exclude={release_dir.name}/run-flock-audio" in source


def manifest_dir(tmp_path: Path) -> Path:
    value = {"schemaVersion": 1, "workerIdentity": {"releaseRevision": "a" * 40,
              "sourceManifestSha256": "b" * 64, "audioArtifactSha256": "c" * 64,
              "protocolFamily": "flock-audio-ipc", "protocolVersion": 1,
              "audioArtifactKind": "release-artifact"},
             "geometry": {"sampleRate": 44100, "blockFrames": 4096, "poolSize": 5,
                          "rowVoices": ["bass", "pad", "lead", "pluck", "pad"]},
             "imageIdentity": {"runtime": "sha256:" + "2" * 64,
                               "audio": "sha256:" + "3" * 64},
             "localImageDiagnostics": {"runtime": {"tag": "flock-runtime:r-a", "localEngineImageId": "sha256:" + "1" * 64},
                                        "audio": {"tag": "flock-audio:r-a", "localEngineImageId": "sha256:" + "1" * 64}}}
    path = tmp_path / "candidate"; path.mkdir()
    (path / "release-manifest.json").write_bytes(release.canonical(value))
    digest = release.sha(path / "release-manifest.json")
    (path / "release-manifest.json.sha256").write_text(f"{digest}  release-manifest.json\n")
    return path


@functools.lru_cache(maxsize=1)
def authoritative_production_graph() -> dict:
    graph = json.loads(subprocess.check_output(
        ["node", ROOT / "flock-voice-engine/runtime/tools/build-production-graph.mjs"],
        text=True,
    ))
    revision = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    graph["fileSha256"] = {
        relative: hashlib.sha256(
            git_blob(ROOT, revision, relative)
        ).hexdigest()
        for relative in graph["files"]
    }
    for route in graph["staticRoutes"]:
        route["sha256"] = graph["fileSha256"][route["repoPath"]]
    inner = {
        name: graph[name]
        for name in ("files", "edges", "fileSha256", "staticRoutes")
    }
    graph["sha256"] = hashlib.sha256(release.canonical(inner)).hexdigest()
    assert graph["sha256"] == release.PRODUCTION_GRAPH_INNER_SHA256
    return graph


def committed_graph_repo(tmp_path: Path) -> tuple[Path, dict, dict[str, bytes]]:
    repo = tmp_path / "repo"
    graph = copy.deepcopy(authoritative_production_graph())
    revision = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    sources = {
        relative: git_blob(ROOT, revision, relative)
        for relative in graph["files"]
    }
    for relative in (
        "flock-voice-engine/runtime/package.json",
        "flock-voice-engine/runtime/package-lock.json",
        "flock-voice-engine/deploy/requirements-audio.lock",
        "flock-voice-engine/deploy/Dockerfile.runtime",
        "flock-voice-engine/deploy/Dockerfile.audio",
    ):
        sources[relative] = git_blob(ROOT, revision, relative)
    for relative, body in sources.items():
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    subprocess.run(["git", "init", "--initial-branch=main", str(repo)],
                   check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "core.autocrlf", "false"],
                   check=True)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=Phase5 Test",
                    "-c", "user.email=phase5@example.invalid", "commit", "-m", "fixture"],
                   check=True, capture_output=True)
    return repo, graph, sources


def test_runtime_context_preserves_repo_topology_and_raw_graph_bytes(tmp_path):
    repo, graph, sources = committed_graph_repo(tmp_path)
    output = tmp_path / "output"; output.mkdir()
    revision = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    context = release.materialize_runtime_context(repo, output, graph, revision)

    bundle = context / "production-bundle"
    for relative in (
        "mvp/index.html",
        "flock-voice-engine/client/voice-client.js",
        "flock-voice-engine/assets/timbre/latent_map.json",
        "flock-voice-engine/runtime/src/index.js",
    ):
        assert (bundle / relative).read_bytes() == sources[relative]
    assert not (bundle / "runtime").exists()
    assert not (bundle / "client").exists()
    assert not (bundle / "assets").exists()

    audio_output = tmp_path / "audio-output"; audio_output.mkdir()
    audio_context = release.materialize_audio_context(repo, audio_output, graph, revision)
    audio_relative = "flock-voice-engine/server/audio_worker/__main__.py"
    assert (audio_context / audio_relative).read_bytes() == sources[audio_relative]


@pytest.mark.parametrize("mutation,code", [
    ("missing-hash", "PRODUCTION_GRAPH_INVALID"),
    ("raw-drift", "PRODUCTION_GRAPH_SOURCE_DIGEST_MISMATCH"),
    ("audio-raw-drift", "PRODUCTION_GRAPH_SOURCE_DIGEST_MISMATCH"),
    ("missing-file", "PRODUCTION_GRAPH_UNTRACKED_SOURCE"),
])
def test_runtime_context_fails_closed_for_missing_or_drifted_graph_sources(
        tmp_path, mutation, code):
    repo, graph, _sources = committed_graph_repo(tmp_path)
    graph = copy.deepcopy(graph)
    if mutation == "missing-hash":
        graph["fileSha256"].pop("mvp/index.html")
    elif mutation == "raw-drift":
        (repo / "mvp/index.html").write_bytes(b"drifted committed bytes\n")
    elif mutation == "audio-raw-drift":
        (
            repo / "flock-voice-engine/server/audio_worker/__main__.py"
        ).write_bytes(b"drifted committed bytes\n")
    else:
        (repo / "mvp/src/renderer.js").unlink()
    if mutation != "missing-hash":
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run([
            "git", "-C", str(repo),
            "-c", "user.name=Phase5 Test",
            "-c", "user.email=phase5@example.invalid",
            "commit", "-m", mutation,
        ], check=True, capture_output=True)
    output = tmp_path / f"output-{mutation}"; output.mkdir()
    revision = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    with pytest.raises(release.ReleaseError, match=code):
        if mutation == "audio-raw-drift":
            release.materialize_audio_context(repo, output, graph, revision)
        else:
            release.materialize_runtime_context(repo, output, graph, revision)


def test_production_graph_is_canonical_and_bound_into_release_manifest(tmp_path):
    candidate = manifest_dir(tmp_path)
    _repo, graph, _sources = committed_graph_repo(tmp_path)
    graph_sha = release.write_bound_production_graph(candidate, graph)

    graph_path = candidate / "production-graph.json"
    assert graph_path.read_bytes() == release.canonical(graph)
    assert graph_sha == release.sha(graph_path)
    assert release.manifest_pair(candidate)["productionGraphSha256"] == graph_sha
    release.verify_production_graph_binding(candidate, graph_sha)
    graph_path.write_bytes(graph_path.read_bytes() + b"\n")
    with pytest.raises(release.ReleaseError, match="PRODUCTION_GRAPH_BINDING_MISMATCH"):
        release.verify_production_graph_binding(candidate, graph_sha)


@pytest.mark.parametrize("mutation", ["mixed-file-types", "non-string-hash"])
def test_production_graph_type_errors_fail_closed_as_release_errors(tmp_path, mutation):
    _repo, graph, _sources = committed_graph_repo(tmp_path)
    graph = copy.deepcopy(graph)
    if mutation == "mixed-file-types":
        graph["files"].append(7)
        graph["fileSha256"][7] = "0" * 64
    else:
        graph["fileSha256"]["mvp/index.html"] = 7
        graph["staticRoutes"][0]["sha256"] = 7
    with pytest.raises(release.ReleaseError, match="PRODUCTION_GRAPH_INVALID"):
        release.validate_production_graph(graph)


@pytest.mark.parametrize("unsafe_url", [
    "//host/path",
    "/double//slash",
    "/trailing/",
    "/%2e%2e/path",
    "/back\\slash",
    "/query?x=1",
    "/fragment#x",
    "/dot/./path",
    "/dot/../path",
    "/control\u0001path",
])
def test_production_graph_rejects_unsafe_static_route_urls(tmp_path, unsafe_url):
    _repo, graph, _sources = committed_graph_repo(tmp_path)
    graph = copy.deepcopy(graph)
    graph["staticRoutes"][0]["url"] = unsafe_url
    graph_body = {name: graph[name] for name in
                  ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(release.canonical(graph_body)).hexdigest()
    with pytest.raises(release.ReleaseError, match="PRODUCTION_GRAPH_INVALID"):
        release.validate_production_graph(graph)


def test_production_graph_rejects_ascii_case_fold_route_duplicates(tmp_path):
    _repo, graph, _sources = committed_graph_repo(tmp_path)
    graph = copy.deepcopy(graph)
    graph["staticRoutes"] = [
        {**graph["staticRoutes"][0], "url": "/INDEX.html"},
        {**graph["staticRoutes"][0], "url": "/index.html"},
    ]
    graph_body = {name: graph[name] for name in
                  ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(release.canonical(graph_body)).hexdigest()
    with pytest.raises(release.ReleaseError, match="PRODUCTION_GRAPH_INVALID"):
        release.validate_production_graph(graph)


@pytest.mark.parametrize("mutation", [
    "non-object-edge",
    "wrong-mime",
    "missing-root",
    "extra-runtime-route",
    "replaced-mvp-route",
    "shadow-legacy-route",
    "rogue-mvp-route",
    "unknown-external",
    "external-wrong-source",
    "unknown-runtime-api",
    "wrong-runtime-api-specifier",
    "wrong-runtime-api-kind",
    "unknown-edge-kind",
    "wrong-source-extension",
    "wrong-target-extension",
    "mismatched-internal-specifier",
    "control-specifier",
    "duplicate-edge",
    "unsorted-edges",
])
def test_rebound_graph_still_rejects_invalid_edge_mime_and_required_topology(
        tmp_path, mutation):
    _repo, graph, _sources = committed_graph_repo(tmp_path)
    graph = copy.deepcopy(graph)
    if mutation == "non-object-edge":
        graph["edges"] = [7]
    elif mutation == "wrong-mime":
        graph["staticRoutes"][0]["mime"] = "application/octet-stream"
    elif mutation == "missing-root":
        graph["staticRoutes"] = [
            route for route in graph["staticRoutes"] if route["url"] != "/"
        ]
        graph["staticRoutes"].append({
            **next(route for route in graph["staticRoutes"]
                   if route["url"] == "/index.html"),
            "url": "/replacement",
        })
        graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    elif mutation == "extra-runtime-route":
        repo_path = "flock-voice-engine/runtime/src/index.js"
        graph["staticRoutes"].append({
            "url": "/runtime.js",
            "repoPath": repo_path,
            "mime": route_mime(repo_path),
            "sha256": graph["fileSha256"][repo_path],
        })
        graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    elif mutation == "replaced-mvp-route":
        route = next(route for route in graph["staticRoutes"]
                     if route["url"] == "/src/server-main.js")
        route["url"] = "/src/replaced.js"
        graph["staticRoutes"].sort(key=lambda item: (item["url"], item["repoPath"]))
    elif mutation == "shadow-legacy-route":
        repo_path = "mvp/assets/timbre/latent_map.json"
        graph["files"].append(repo_path)
        graph["files"].sort()
        graph["fileSha256"][repo_path] = hashlib.sha256(b"shadow").hexdigest()
        route = next(route for route in graph["staticRoutes"]
                     if route["url"] == "/assets/timbre/latent_map.json")
        route.update({
            "repoPath": repo_path,
            "sha256": graph["fileSha256"][repo_path],
        })
    elif mutation == "rogue-mvp-route":
        repo_path = "mvp/rogue.js"
        graph["files"].append(repo_path)
        graph["files"].sort()
        graph["fileSha256"][repo_path] = hashlib.sha256(b"rogue").hexdigest()
        graph["staticRoutes"].append({
            "url": "/rogue.js",
            "repoPath": repo_path,
            "mime": route_mime(repo_path),
            "sha256": graph["fileSha256"][repo_path],
        })
        graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    elif mutation == "unknown-external":
        graph["edges"][0].update({
            "specifier": "external:evil",
            "resolved": "external:evil",
        })
    elif mutation == "external-wrong-source":
        graph["edges"][0]["source"] = "mvp/src/server-main.js"
    elif mutation == "unknown-runtime-api":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.runtime-api",
            "specifier": "/api/evil",
            "resolved": "runtime-api:/api/evil",
        })
    elif mutation == "wrong-runtime-api-specifier":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.runtime-api",
            "specifier": "/api/v1/latent-maps/pad",
            "resolved": "runtime-api:/api/v1/bootstrap",
        })
    elif mutation == "wrong-runtime-api-kind":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.fetch",
            "specifier": "/api/v1/bootstrap",
            "resolved": "runtime-api:/api/v1/bootstrap",
        })
    elif mutation == "unknown-edge-kind":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.unknown",
            "specifier": "../index.html",
            "resolved": "mvp/index.html",
        })
    elif mutation == "wrong-source-extension":
        graph["edges"][0].update({
            "source": "mvp/index.html",
            "kind": "js.import",
            "specifier": "src/server-main.js",
            "resolved": "mvp/src/server-main.js",
        })
    elif mutation == "wrong-target-extension":
        graph["edges"][0].update({
            "kind": "js.audio-worklet",
            "specifier": "./demo.html",
            "resolved": "flock-voice-engine/client/demo.html",
        })
    elif mutation == "mismatched-internal-specifier":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.import",
            "specifier": "./server-main.js",
            "resolved": "flock-voice-engine/runtime/src/index.js",
        })
    elif mutation == "control-specifier":
        graph["edges"][0]["specifier"] = "external:configurable-fetch\n"
    elif mutation == "duplicate-edge":
        graph["edges"].insert(1, copy.deepcopy(graph["edges"][0]))
    else:
        graph["edges"].reverse()
    graph_body = {name: graph[name] for name in
                  ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(release.canonical(graph_body)).hexdigest()
    with pytest.raises(release.ReleaseError, match="PRODUCTION_GRAPH_INVALID"):
        release.validate_production_graph(graph)


def test_python_release_validator_accepts_real_graph_and_rejects_rebound_bad_static_root():
    graph = copy.deepcopy(authoritative_production_graph())
    assert len(graph["files"]) == 165
    assert len(graph["edges"]) == 256
    assert len(graph["staticRoutes"]) == 68
    release.validate_production_graph(graph)

    tampered = copy.deepcopy(graph)
    edge = next(edge for edge in tampered["edges"]
                if edge["resolved"] == "flock-voice-engine/assets/timbre/voice_maps")
    edge["specifier"] = "../../assets/timbre/"
    inner = {name: tampered[name] for name in
             ("files", "edges", "fileSha256", "staticRoutes")}
    tampered["sha256"] = hashlib.sha256(release.canonical(inner)).hexdigest()
    with pytest.raises(release.ReleaseError, match="PRODUCTION_GRAPH_INVALID"):
        release.validate_production_graph(tampered)


def test_release_validator_rejects_fully_rebound_static_only_subgraph(tmp_path):
    _repo, graph, _sources = committed_graph_repo(tmp_path)
    graph = copy.deepcopy(graph)
    retained = set(REQUIRED_STATIC_ROUTES.values())
    graph["files"] = sorted(retained)
    graph["edges"] = []
    graph["fileSha256"] = {
        path: digest for path, digest in graph["fileSha256"].items()
        if path in retained
    }
    graph["staticRoutes"] = [
        route for route in graph["staticRoutes"]
        if route["repoPath"] in retained
    ]
    inner = {name: graph[name] for name in
             ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(release.canonical(inner)).hexdigest()

    assert len(graph["files"]) == 11
    assert len(graph["edges"]) == 0
    assert len(graph["staticRoutes"]) == 12
    with pytest.raises(release.ReleaseError, match="PRODUCTION_GRAPH_INVALID"):
        release.validate_production_graph(graph)


def test_release_validator_rejects_fully_rebound_unknown_static_mime(tmp_path):
    _repo, graph, _sources = committed_graph_repo(tmp_path)
    graph = copy.deepcopy(graph)
    repo_path = "mvp/assets/payload.exe"
    graph["files"].append(repo_path)
    graph["files"].sort()
    graph["fileSha256"][repo_path] = hashlib.sha256(b"payload").hexdigest()
    graph["staticRoutes"].append({
        "url": "/assets/payload.exe",
        "repoPath": repo_path,
        "mime": None,
        "sha256": graph["fileSha256"][repo_path],
    })
    graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    inner = {name: graph[name] for name in
             ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(release.canonical(inner)).hexdigest()

    with pytest.raises(release.ReleaseError, match="PRODUCTION_GRAPH_INVALID"):
        release.validate_production_graph(graph)


def two_revision_release_repo(tmp_path):
    repo, graph_a, _sources = committed_graph_repo(tmp_path)
    required_build_files = (
        "flock-voice-engine/deploy/release.sh",
        "flock-voice-engine/deploy/import-release.sh",
        "flock-voice-engine/deploy/release_control.py",
        "flock-voice-engine/deploy/verify-smoke.mjs",
        "flock-voice-engine/deploy/verify-candidate.sh",
        "flock-voice-engine/runtime/tools/prepare-cutover-request.mjs",
        "flock-voice-engine/tools/build_release_artifact.py",
        "flock-voice-engine/tools/validate_phase5_acceptance.py",
        "flock-voice-engine/release/acceptance.schema.json",
        "flock-voice-engine/release/machine-attestation.schema.json",
    )
    for relative in required_build_files:
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"A:{relative}\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=Phase5 Test",
                    "-c", "user.email=phase5@example.invalid", "commit",
                    "-m", "revision A"], check=True, capture_output=True)
    revision_a = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    changed = (
        "mvp/index.html",
        "flock-voice-engine/client/voice-client.js",
        "flock-voice-engine/assets/timbre/latent_map.json",
        "flock-voice-engine/runtime/src/index.js",
        "flock-voice-engine/runtime/package.json",
        "flock-voice-engine/runtime/package-lock.json",
        "flock-voice-engine/deploy/Dockerfile.runtime",
        "flock-voice-engine/deploy/release.sh",
        "flock-voice-engine/server/audio_worker/__main__.py",
        "flock-voice-engine/tools/build_release_artifact.py",
    )
    for relative in changed:
        (repo / relative).write_text(f"B:{relative}\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=Phase5 Test",
                    "-c", "user.email=phase5@example.invalid", "commit",
                    "-m", "revision B"], check=True, capture_output=True)
    revision_b = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    subprocess.run(["git", "-C", str(repo), "switch", "--detach", revision_a],
                   check=True, capture_output=True)
    return repo, revision_a, revision_b, graph_a


def git_blob(repo: Path, revision: str, relative: str) -> bytes:
    return subprocess.check_output(
        ["git", "-C", str(repo), "show", f"{revision}:{relative}"])


class FakeBuildRunner:
    def __init__(self, repo, revision_a, revision_b, output, inputs, *,
                 tamper_after_images=False):
        self.repo = repo
        self.revision_a = revision_a
        self.revision_b = revision_b
        self.output = output
        self.inputs = inputs
        self.tamper_after_images = tamper_after_images
        self.build_calls = 0
        self.runtime_snapshot = {}
        self.audio_snapshot = {}
        self.builder_path = None
        self.builder_snapshot = None
        self.injected_mutable_builder = False
        self.transitions = []

    def __call__(self, *args, capture=False):
        if args[:4] == ("git", "-C", str(self.repo), "rev-parse"):
            revision = subprocess.check_output(args, text=True).strip()
            if not self.injected_mutable_builder:
                mutable_builder = (
                    self.repo / "flock-voice-engine/tools/build_release_artifact.py"
                )
                mutable_builder.write_bytes(git_blob(
                    self.repo,
                    self.revision_b,
                    "flock-voice-engine/tools/build_release_artifact.py",
                ))
                self.injected_mutable_builder = True
            return revision
        if args[:4] == ("git", "-C", str(self.repo), "status"):
            return subprocess.check_output(args, text=True).strip()
        if (args[0] == sys.executable
                and str(args[1]).endswith("build_release_artifact.py")):
            self.builder_path = Path(args[1]).resolve()
            self.builder_snapshot = self.builder_path.read_bytes()
            self.output.mkdir()
            source_manifest = {"schemaVersion": 1, "entries": []}
            (self.output / "source-manifest.json").write_bytes(
                release.canonical(source_manifest))
            manifest = {
                "schemaVersion": 1,
                "workerIdentity": {
                    "releaseRevision": self.revision_a,
                    "sourceManifestSha256": release.sha(
                        self.output / "source-manifest.json"),
                    "audioArtifactSha256": "c" * 64,
                    "protocolFamily": "flock-audio-ipc",
                    "protocolVersion": 1,
                    "audioArtifactKind": "release-artifact",
                },
                "geometry": {
                    "sampleRate": 44100,
                    "blockFrames": 4096,
                    "poolSize": 5,
                    "rowVoices": ["bass", "pad", "lead", "pluck", "pad"],
                },
                "baseImages": {
                    name: {
                        key: self.inputs["baseImages"][name][key]
                        for key in ("repository", "digest")
                    } for name in ("runtime", "audio")
                },
                "imageIdentity": {
                    "runtime": "sha256:" + "2" * 64,
                    "audio": "sha256:" + "3" * 64,
                },
            }
            release.write_manifest_pair(self.output, manifest)
            (
                self.repo / "flock-voice-engine/tools/build_release_artifact.py"
            ).write_bytes(git_blob(
                self.repo,
                self.revision_a,
                "flock-voice-engine/tools/build_release_artifact.py",
            ))
            subprocess.run(["git", "-C", str(self.repo), "switch", "--detach",
                            self.revision_b], check=True, capture_output=True)
            self.transitions.append("A->B")
            return ""
        if args[:3] == ("docker", "buildx", "build"):
            self.build_calls += 1
            context = Path(args[-1])
            if context.name == ".build-runtime-context" and not self.runtime_snapshot:
                self.runtime_snapshot = {
                    "packageJson": (context / "runtime-package/package.json").read_bytes(),
                    "packageLock": (context / "runtime-package/package-lock.json").read_bytes(),
                    "dockerfile": (context / "Dockerfile.runtime").read_bytes(),
                    "mvp": (context / "production-bundle/mvp/index.html").read_bytes(),
                    "runtimeIndex": (
                        context
                        / "production-bundle/flock-voice-engine/runtime/src/index.js"
                    ).read_bytes(),
                    "client": (
                        context
                        / "production-bundle/flock-voice-engine/client/voice-client.js"
                    ).read_bytes(),
                    "asset": (
                        context
                        / "production-bundle/flock-voice-engine/assets/timbre/latent_map.json"
                    ).read_bytes(),
                }
            if context.name == ".build-audio-context" and not self.audio_snapshot:
                self.audio_snapshot = {
                    "dockerfile": (context / "Dockerfile.audio").read_bytes(),
                    "requirements": (
                        context / "flock-voice-engine/deploy/requirements-audio.lock"
                    ).read_bytes(),
                    "server": (
                        context
                        / "flock-voice-engine/server/audio_worker/__main__.py"
                    ).read_bytes(),
                }
            if self.build_calls == 1:
                subprocess.run(["git", "-C", str(self.repo), "switch", "--detach",
                                self.revision_a], check=True, capture_output=True)
                self.transitions.append("B->A")
            if self.build_calls == 4 and self.tamper_after_images:
                graph = self.output / "production-graph.json"
                graph.write_bytes(graph.read_bytes() + b"\n")
            return ""
        if args[:3] == ("docker", "image", "inspect"):
            return "sha256:" + "1" * 64
        raise AssertionError(args)


def run_fake_local_build(tmp_path, monkeypatch, *, tamper_after_images=False):
    repo, revision_a, revision_b, graph_a = two_revision_release_repo(tmp_path)
    output = tmp_path / "release"
    inputs_value = {
        "baseImages": {
            "runtime": {
                "repository": "example/runtime",
                "digest": "sha256:" + "a" * 64,
            },
            "audio": {
                "repository": "example/audio",
                "digest": "sha256:" + "b" * 64,
            },
        },
    }
    inputs = tmp_path / "inputs.json"
    inputs.write_text(json.dumps(inputs_value))
    runner = FakeBuildRunner(
        repo, revision_a, revision_b, output, inputs_value,
        tamper_after_images=tamper_after_images,
    )

    def graph_builder(actual_repo, _output, revision):
        assert actual_repo == repo
        assert revision == revision_a
        assert subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip() == revision_b
        return copy.deepcopy(graph_a)

    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    args = type("A", (), {"inputs": str(inputs), "output": str(output)})()
    release.build_local(
        args,
        repo_root=repo,
        command_runner=runner,
        graph_builder=graph_builder,
        image_inspector=lambda _path: (
            "sha256:" + "2" * 64,
            "sha256:" + "1" * 64,
        ),
    )
    return repo, revision_a, graph_a, output, runner


def test_build_local_pins_every_git_read_to_captured_revision_across_aba(
        tmp_path, monkeypatch):
    repo, revision_a, graph_a, output, runner = run_fake_local_build(
        tmp_path, monkeypatch)
    assert runner.transitions == ["A->B", "B->A"]
    assert runner.builder_path is not None
    assert not runner.builder_path.is_relative_to(repo)
    assert runner.builder_snapshot == git_blob(
        repo, revision_a, "flock-voice-engine/tools/build_release_artifact.py")
    assert runner.runtime_snapshot == {
        "packageJson": git_blob(
            repo, revision_a, "flock-voice-engine/runtime/package.json"),
        "packageLock": git_blob(
            repo, revision_a, "flock-voice-engine/runtime/package-lock.json"),
        "dockerfile": git_blob(
            repo, revision_a, "flock-voice-engine/deploy/Dockerfile.runtime"),
        "mvp": git_blob(repo, revision_a, "mvp/index.html"),
        "runtimeIndex": git_blob(
            repo, revision_a, "flock-voice-engine/runtime/src/index.js"),
        "client": git_blob(
            repo, revision_a, "flock-voice-engine/client/voice-client.js"),
        "asset": git_blob(
            repo, revision_a,
            "flock-voice-engine/assets/timbre/latent_map.json"),
    }
    assert runner.audio_snapshot == {
        "dockerfile": git_blob(
            repo, revision_a, "flock-voice-engine/deploy/Dockerfile.audio"),
        "requirements": git_blob(
            repo, revision_a,
            "flock-voice-engine/deploy/requirements-audio.lock"),
        "server": git_blob(
            repo, revision_a,
            "flock-voice-engine/server/audio_worker/__main__.py"),
    }
    assert (output / "deploy/release.sh").read_bytes() == git_blob(
        repo, revision_a, "flock-voice-engine/deploy/release.sh")
    assert (output / "source/mvp/index.html").read_bytes() == git_blob(
        repo, revision_a, "mvp/index.html")
    assert (output / "production-graph.json").read_bytes() == release.canonical(graph_a)
    assert release.manifest_pair(output)["workerIdentity"]["releaseRevision"] == revision_a


def test_build_local_final_rehash_rejects_graph_mutated_after_image_builds(
        tmp_path, monkeypatch):
    with pytest.raises(release.ReleaseError,
                       match="PRODUCTION_GRAPH_BINDING_MISMATCH"):
        run_fake_local_build(tmp_path, monkeypatch, tamper_after_images=True)


def test_production_graph_archive_uses_explicit_revision_while_head_moves(
        tmp_path, monkeypatch):
    repo, revision_a, revision_b, graph_a = two_revision_release_repo(tmp_path)
    subprocess.run(["git", "-C", str(repo), "switch", "--detach", revision_b],
                   check=True, capture_output=True)
    output = tmp_path / "graph-output"; output.mkdir()

    def fake_npm(*args, **kwargs):
        assert kwargs["cwd"].joinpath("../../mvp/index.html").resolve().read_bytes() == (
            git_blob(repo, revision_a, "mvp/index.html"))
        return type("R", (), {"returncode": 0})()

    def fake_node(*args, **kwargs):
        snapshot = output / ".graph-head"
        assert (snapshot / "flock-voice-engine/runtime/package-lock.json").read_bytes() == (
            git_blob(repo, revision_a,
                     "flock-voice-engine/runtime/package-lock.json"))
        assert (snapshot / "flock-voice-engine/deploy/Dockerfile.runtime").read_bytes() == (
            git_blob(repo, revision_a,
                     "flock-voice-engine/deploy/Dockerfile.runtime"))
        return json.dumps(graph_a)

    assert release.production_graph_from_revision(
        repo, output, revision_a,
        npm_runner=fake_npm,
        node_runner=fake_node,
    ) == graph_a
    assert not (output / ".graph-head").exists()


def minimal_graph_revision_repo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "minimal-graph-repo"
    package = repo / "flock-voice-engine/runtime/package.json"
    package.parent.mkdir(parents=True)
    package.write_text("{}\n", encoding="utf-8")
    subprocess.run(
        ["git", "init", "--initial-branch=main", str(repo)],
        check=True,
        capture_output=True,
    )
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        [
            "git", "-C", str(repo),
            "-c", "user.name=Phase5 Test",
            "-c", "user.email=phase5@example.invalid",
            "commit", "-m", "graph fixture",
        ],
        check=True,
        capture_output=True,
    )
    revision = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    return repo, revision


@pytest.mark.parametrize("outcome", [
    "npm-failure",
    "node-failure",
    "bad-json",
    "success",
])
def test_production_graph_snapshot_cleanup_covers_entire_lifecycle(
        tmp_path, outcome):
    repo, revision = minimal_graph_revision_repo(tmp_path)
    output = tmp_path / "graph-cleanup-output"
    output.mkdir()
    graph = copy.deepcopy(authoritative_production_graph())

    def npm_runner(*_args, **_kwargs):
        if outcome == "npm-failure":
            raise subprocess.CalledProcessError(7, ["npm", "ci"])
        return subprocess.CompletedProcess(["npm", "ci"], 0)

    def node_runner(*_args, **_kwargs):
        if outcome == "node-failure":
            raise OSError("node execution failed")
        if outcome == "bad-json":
            return "{"
        return json.dumps(graph)

    if outcome == "success":
        assert release.production_graph_from_revision(
            repo,
            output,
            revision,
            npm_runner=npm_runner,
            node_runner=node_runner,
        ) == graph
    elif outcome == "npm-failure":
        expectation = pytest.raises(
            release.ReleaseError,
            match="PRODUCTION_GRAPH_DEPENDENCIES_INVALID",
        )
    elif outcome == "node-failure":
        expectation = pytest.raises(OSError, match="node execution failed")
    elif outcome == "bad-json":
        expectation = pytest.raises(
            release.ReleaseError,
            match="PRODUCTION_GRAPH_INVALID",
        )

    if outcome != "success":
        with expectation:
            release.production_graph_from_revision(
                repo,
                output,
                revision,
                npm_runner=npm_runner,
                node_runner=node_runner,
            )
    assert not (output / ".graph-head").exists()


def test_production_graph_cleanup_failure_fails_closed_after_success(
        tmp_path, monkeypatch):
    repo, revision = minimal_graph_revision_repo(tmp_path)
    output = tmp_path / "graph-cleanup-output"
    output.mkdir()
    graph = copy.deepcopy(authoritative_production_graph())

    def cleanup_failure(_path):
        raise OSError("cleanup denied")

    monkeypatch.setattr(release.shutil, "rmtree", cleanup_failure)

    with pytest.raises(
            release.ReleaseError,
            match="PRODUCTION_GRAPH_SNAPSHOT_CLEANUP_FAILED"):
        release.production_graph_from_revision(
            repo,
            output,
            revision,
            npm_runner=lambda *_args, **_kwargs: None,
            node_runner=lambda *_args, **_kwargs: json.dumps(graph),
        )


def test_production_graph_cleanup_failure_does_not_mask_primary_error(
        tmp_path, monkeypatch):
    repo, revision = minimal_graph_revision_repo(tmp_path)
    output = tmp_path / "graph-cleanup-output"
    output.mkdir()

    def cleanup_failure(_path):
        raise OSError("cleanup denied")

    monkeypatch.setattr(release.shutil, "rmtree", cleanup_failure)

    with pytest.raises(release.ReleaseError, match="PRODUCTION_GRAPH_INVALID"):
        release.production_graph_from_revision(
            repo,
            output,
            revision,
            npm_runner=lambda *_args, **_kwargs: None,
            node_runner=lambda *_args, **_kwargs: "{",
        )


def controlled_artifact_inputs(tmp_path: Path) -> Path:
    controlled = tmp_path / "controlled"

    def record(relative: str, body: bytes) -> dict:
        path = controlled / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return {
            "sourcePath": str(path.resolve()),
            "byteCount": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
        }

    specifications = (
        ("vendor/file.py", "vendor", b"VALUE = 1\n"),
        ("weights/model.bin", "weight", b"model"),
        ("maps/bass.json", "voice-map", b"{}"),
        ("calibration/output.json", "calibration", b"{}"),
        ("audio/amen.wav", "audio", b"amen"),
        ("audio/forest.wav", "audio", b"forest"),
    )
    artifacts = [{
        "logicalPath": relative,
        "mountPath": relative,
        "kind": kind,
        **record(relative, body),
    } for relative, kind, body in specifications]
    vendor_inventory = [{
        "logicalPath": item["logicalPath"],
        "byteCount": item["byteCount"],
        "sha256": item["sha256"],
    } for item in artifacts if item["kind"] == "vendor"]
    vendor_archive = record("upstream-vendor.tar", b"controlled upstream archive")
    value = {
        "schemaVersion": 1,
        "provenanceKind": "controlled-artifact",
        "vendor": {
            "provenanceKind": "controlled-artifact",
            "artifactPath": vendor_archive["sourcePath"],
            "artifactByteCount": vendor_archive["byteCount"],
            "artifactSha256": vendor_archive["sha256"],
            "treeSha256": hashlib.sha256(
                release.canonical(vendor_inventory)).hexdigest(),
        },
        "baseImages": {
            "runtime": {
                "repository": "example/runtime",
                "digest": "sha256:" + "1" * 64,
                "imageDigest": "sha256:" + "2" * 64,
            },
            "audio": {
                "repository": "example/audio",
                "digest": "sha256:" + "3" * 64,
                "imageDigest": "sha256:" + "4" * 64,
            },
        },
        "geometry": {
            "sampleRate": 44100,
            "blockFrames": 4096,
            "poolSize": 5,
            "rowVoices": ["bass", "pad", "lead", "pluck", "pad"],
        },
        "artifacts": artifacts,
    }
    path = tmp_path / "real-audio-inputs.json"
    path.write_bytes(release.canonical(value))
    return path


class RealAbaBuildRunner:
    def __init__(self, repo: Path, revision_a: str, revision_b: str,
                 changed: tuple[str, ...], output: Path):
        self.repo = repo
        self.revision_a = revision_a
        self.revision_b = revision_b
        self.changed = changed
        self.output = output
        self.injected = False
        self.transitions = []
        self.builder_bytes = None
        self.builder_path = None
        self.runtime_snapshot = None
        self.audio_snapshot = None

    def inject_hidden_b_worktree(self) -> None:
        subprocess.run(
            ["git", "-C", str(self.repo), "switch", "--detach", self.revision_b],
            check=True, capture_output=True)
        self.transitions.append("A->B")
        subprocess.run(
            ["git", "-C", str(self.repo), "update-ref", "HEAD", self.revision_a],
            check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "read-tree", self.revision_a],
            check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "update-index",
             "--assume-unchanged", "--", *self.changed],
            check=True)
        self.transitions.append("B->A")
        assert subprocess.check_output(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"],
            text=True).strip() == self.revision_a
        assert subprocess.check_output(
            ["git", "-C", str(self.repo), "status", "--porcelain",
             "--untracked-files=no"],
            text=True).strip() == ""

    def run_real_builder(self, args: tuple[object, ...]) -> None:
        self.builder_path = Path(args[1]).resolve()
        self.builder_bytes = self.builder_path.read_bytes()
        if sys.platform == "linux":
            subprocess.run([str(item) for item in args], check=True)
            return
        module_name = "_snapshot_release_builder_a"
        spec = importlib.util.spec_from_file_location(
            module_name, self.builder_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
            values = module._load_inputs(Path(args[5]))
            module._validate_clean_tree(self.repo)
            prepared = module._prepare_release_metadata(self.repo, values)
            self.output.mkdir()
            (self.output / "source-manifest.json").write_bytes(
                module.canonical_json(prepared.source_manifest))
            release.write_manifest_pair(
                self.output, prepared.release_manifest)
        finally:
            sys.modules.pop(module_name, None)

    def __call__(self, *args, capture=False):
        if args[:4] == ("git", "-C", str(self.repo), "rev-parse"):
            revision = subprocess.check_output(args, text=True).strip()
            if not self.injected:
                self.inject_hidden_b_worktree()
                self.injected = True
            return revision
        if args[:4] == ("git", "-C", str(self.repo), "status"):
            return subprocess.check_output(args, text=True).strip()
        if (args[0] == sys.executable
                and str(args[1]).endswith("build_release_artifact.py")):
            self.run_real_builder(args)
            return ""
        if args[:3] == ("docker", "buildx", "build"):
            context = Path(args[-1])
            if context.name == ".build-runtime-context" and self.runtime_snapshot is None:
                self.runtime_snapshot = {
                    "packageJson": (
                        context / "runtime-package/package.json").read_bytes(),
                    "runtimeIndex": (
                        context
                        / "production-bundle/flock-voice-engine/runtime/src/index.js"
                    ).read_bytes(),
                    "client": (
                        context
                        / "production-bundle/flock-voice-engine/client/voice-client.js"
                    ).read_bytes(),
                    "asset": (
                        context
                        / "production-bundle/flock-voice-engine/assets/timbre/latent_map.json"
                    ).read_bytes(),
                }
            if context.name == ".build-audio-context" and self.audio_snapshot is None:
                self.audio_snapshot = {
                    "server": (
                        context
                        / "flock-voice-engine/server/audio_worker/__main__.py"
                    ).read_bytes(),
                }
            return ""
        if args[:3] == ("docker", "image", "inspect"):
            return "sha256:" + "1" * 64
        raise AssertionError(args)


@pytest.fixture
def trusted_release_parent(tmp_path, request):
    if sys.platform != "linux":
        return tmp_path
    parent = Path(tempfile.mkdtemp(
        prefix=".flock-phase5-release-",
        dir=Path.home().resolve(),
    ))
    parent.chmod(0o700)
    request.addfinalizer(lambda: shutil.rmtree(parent))
    return parent


def test_real_builder_and_real_node_graph_pin_joint_aba_closure(
        tmp_path, monkeypatch, trusted_release_parent):
    repo = tmp_path / "real-repo"
    subprocess.run(
        ["git", "clone", "--quiet", "-c", "core.autocrlf=false",
         str(ROOT), str(repo)],
        check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(repo), "config", "core.autocrlf", "false"],
        check=True)
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.name", "Phase5 Test"],
        check=True)
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.email",
         "phase5@example.invalid"],
        check=True)
    revision_a = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        text=True).strip()
    changed = (
        "flock-voice-engine/tools/build_release_artifact.py",
        "flock-voice-engine/runtime/package.json",
        "flock-voice-engine/runtime/package-lock.json",
        "flock-voice-engine/runtime/src/index.js",
        "flock-voice-engine/deploy/release.sh",
        "flock-voice-engine/client/voice-client.js",
        "flock-voice-engine/assets/timbre/latent_map.json",
        "flock-voice-engine/server/audio_worker/__main__.py",
    )
    for relative in changed:
        (repo / relative).write_bytes(f"B:{relative}\n".encode())
    subprocess.run(["git", "-C", str(repo), "add", *changed], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "commit", "-m", "revision B"],
        check=True, capture_output=True)
    revision_b = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        text=True).strip()
    subprocess.run(
        ["git", "-C", str(repo), "switch", "--detach", revision_a],
        check=True, capture_output=True)

    inputs = controlled_artifact_inputs(tmp_path)
    output = trusted_release_parent / "real-release"
    runner = RealAbaBuildRunner(
        repo, revision_a, revision_b, changed, output)
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    args = type("A", (), {
        "inputs": str(inputs),
        "output": str(output),
    })()

    def real_graph_builder(actual_repo, actual_output, revision):
        if os.name != "nt":
            return release.production_graph_from_revision(
                actual_repo, actual_output, revision)
        npm = shutil.which("npm.cmd")
        assert npm is not None

        def windows_npm(command, **kwargs):
            return subprocess.run([npm, *command[1:]], **kwargs)

        return release.production_graph_from_revision(
            actual_repo,
            actual_output,
            revision,
            npm_runner=windows_npm,
        )

    release.build_local(
        args,
        repo_root=repo,
        command_runner=runner,
        graph_builder=real_graph_builder,
        image_inspector=lambda _path: (
            "sha256:" + "2" * 64,
            "sha256:" + "1" * 64,
        ),
    )

    assert runner.transitions == ["A->B", "B->A"]
    assert runner.builder_path is not None
    assert not runner.builder_path.is_relative_to(repo)
    assert runner.builder_bytes == git_blob(
        repo, revision_a,
        "flock-voice-engine/tools/build_release_artifact.py")
    assert (repo / changed[0]).read_bytes() == git_blob(
        repo, revision_b, changed[0])
    assert runner.runtime_snapshot == {
        "packageJson": git_blob(
            repo, revision_a, "flock-voice-engine/runtime/package.json"),
        "runtimeIndex": git_blob(
            repo, revision_a, "flock-voice-engine/runtime/src/index.js"),
        "client": git_blob(
            repo, revision_a, "flock-voice-engine/client/voice-client.js"),
        "asset": git_blob(
            repo, revision_a,
            "flock-voice-engine/assets/timbre/latent_map.json"),
    }
    assert runner.audio_snapshot == {
        "server": git_blob(
            repo, revision_a,
            "flock-voice-engine/server/audio_worker/__main__.py"),
    }
    graph = json.loads((output / "production-graph.json").read_bytes())
    assert graph["sha256"] == release.PRODUCTION_GRAPH_INNER_SHA256
    for relative in (
        "flock-voice-engine/runtime/src/index.js",
        "flock-voice-engine/client/voice-client.js",
        "flock-voice-engine/assets/timbre/latent_map.json",
        "flock-voice-engine/server/audio_worker/__main__.py",
    ):
        assert graph["fileSha256"][relative] == hashlib.sha256(
            git_blob(repo, revision_a, relative)).hexdigest()
    manifest = release.manifest_pair(output)
    assert manifest["workerIdentity"]["releaseRevision"] == revision_a
    assert manifest["workerIdentity"]["sourceManifestSha256"] == release.sha(
        output / "source-manifest.json")


def test_dockerfiles_use_only_digest_pinned_bases_and_split_gpu_dependencies():
    runtime = (DEPLOY / "Dockerfile.runtime").read_text()
    audio = (DEPLOY / "Dockerfile.audio").read_text()
    assert "FROM ${RUNTIME_BASE_REPOSITORY}@${RUNTIME_BASE_DIGEST}" in runtime
    assert "FROM ${AUDIO_BASE_REPOSITORY}@${AUDIO_BASE_DIGEST}" in audio
    assert "torch" not in runtime.lower() and "python" not in runtime.lower()
    assert "--require-hashes" in audio
    assert "latest" not in runtime.lower() + audio.lower()
    assert ("COPY runtime-package/package.json runtime-package/package-lock.json "
            "./flock-voice-engine/runtime/") in runtime
    assert "RUN cd flock-voice-engine/runtime && npm ci --omit=dev" in runtime
    assert "COPY production-bundle/ ./" in runtime
    assert 'CMD ["node", "flock-voice-engine/runtime/src/index.js"]' in runtime
    assert "./runtime/" not in runtime
    assert 'CMD ["node", "runtime/src/index.js"]' not in runtime


def test_runtime_healthcheck_uses_exact_container_loopback_ready_probe():
    runtime = (DEPLOY / "Dockerfile.runtime").read_text()
    healthchecks = [
        line.strip()
        for line in runtime.splitlines()
        if line.lstrip().startswith("HEALTHCHECK ")
    ]
    probe = (
        "const http=require('node:http');"
        "const deadline=setTimeout(()=>process.exit(1),1500);"
        "const request=http.get('http://127.0.0.1:8090/readyz',response=>{"
        "response.resume();response.on('end',()=>{clearTimeout(deadline);"
        "process.exit(response.statusCode>=200&&response.statusCode<300?0:1);"
        "});});request.on('error',()=>{clearTimeout(deadline);process.exit(1);});"
    )
    expected = (
        "HEALTHCHECK --interval=10s --timeout=3s --start-period=10s "
        '--retries=3 CMD ["node", "-e", '
        + json.dumps(probe)
        + "]"
    )

    assert healthchecks == [expected]
    assert all(
        forbidden not in healthchecks[0].lower()
        for forbidden in (
            "python",
            "curl",
            "wget",
            "18090",
            "localhost",
            "0.0.0.0",
            "origin",
            "process.env",
        )
    )


@pytest.mark.parametrize("scope", [None, "production", "prod"])
def test_every_mutating_entry_requires_explicit_local_scope(monkeypatch, scope):
    monkeypatch.delenv("FLOCK_DEPLOY_SCOPE", raising=False)
    if scope is not None: monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", scope)
    with pytest.raises(release.ReleaseError, match="LOCAL_DEPLOY_SCOPE_REQUIRED"):
        release.require_local_scope()


@pytest.mark.parametrize("field,value", [("digest", "latest"), ("digest", "sha256:bad"),
                                           ("repository", "node:latest")])
def test_mutable_or_missing_base_image_is_rejected(tmp_path, field, value):
    inputs = {"baseImages": {name: {"repository": f"example/{name}", "digest": "sha256:" + name[0] * 64}
                             for name in ("runtime", "audio")}}
    inputs["baseImages"]["runtime"][field] = value
    path = tmp_path / "inputs.json"; path.write_text(json.dumps(inputs))
    with pytest.raises(release.ReleaseError, match="BASE_IMAGE_DIGEST_INVALID"):
        release.validate_base_images(path)


@linux_release_security
def test_stage_has_gpu_only_on_audio_loopback_publish_and_shared_uds(tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path); calls = []
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(release, "run", lambda *args, **kwargs: calls.append(args) or ("sha256:" + "1" * 64 if args[:3] == ("docker", "image", "inspect") else ""))
    monkeypatch.setattr(release.subprocess, "run", lambda *args, **kwargs: type("R", (), {"returncode": 1})())
    release.stage_local(type("A", (), {"release_dir": str(candidate)})())
    audio, runtime = [call for call in calls if call[:2] == ("docker", "run")]
    assert "--gpus" in audio and "--publish" not in audio
    assert "--user" in audio and "--user" in runtime
    assert "--gpus" not in runtime
    assert runtime[runtime.index("--publish") + 1] == "127.0.0.1:18090:8090"
    assert "FLOCK_RUNTIME_PROFILE=container-local" in runtime
    assert any("dst=/run/flock-audio" in arg for arg in audio)
    assert any("dst=/run/flock-audio" in arg for arg in runtime)
    assert stat.S_IMODE((candidate / "run-flock-audio").stat().st_mode) == 0o770
    state = json.loads((candidate / "rollback-state.json").read_text())
    assert state["previousState"] == "absent" and state["kind"] == "reset"
    removals = []
    monkeypatch.setattr(release.subprocess, "run", lambda args, **kwargs: (
        removals.append(args) or type("R", (), {"returncode": 0})()))
    release.rollback(type("A", (), {"release_dir": str(candidate)})())
    assert [args[-1] for args in removals] == list(release.LOCAL_CONTAINERS)


def test_health_without_ready_or_exact_identity_never_succeeds(tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    monkeypatch.setattr(release, "get_json", lambda base, path: (200, {}) if path == "/healthz" else (503, {}))
    with pytest.raises(release.ReleaseError, match="CANDIDATE_NOT_IDENTITY_READY"):
        release.verify_candidate(type("A", (), {"release_dir": str(candidate),
                                                 "base_url": "http://127.0.0.1:18090"})())


def test_manifest_sidecar_is_exact_and_cannot_be_renamed(tmp_path):
    candidate = manifest_dir(tmp_path)
    sidecar = candidate / "release-manifest.json.sha256"
    sidecar.write_text(sidecar.read_text().replace("release-manifest.json", "renamed.json"))
    with pytest.raises(release.ReleaseError, match="RELEASE_MANIFEST_SIDECAR_INVALID"):
        release.manifest_pair(candidate)


def test_verify_package_prepare_path_generates_real_consistent_world_evidence(tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path); monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(release, "container_user", lambda: "1000:1000")
    output = candidate / "cutover-request.json"
    args = type("A", (), {"release_dir": str(candidate), "state_policy": "preserve",
                          "output": str(output)})()
    with pytest.raises(release.ReleaseError, match="CUTOVER_REQUEST_PREREQUISITE_MISSING"):
        release.prepare_request(args)
    deploy = candidate / "deploy"; deploy.mkdir()
    tool = deploy / "prepare-cutover-request.mjs"
    tool.write_bytes((ROOT / "flock-voice-engine/runtime/tools/prepare-cutover-request.mjs").read_bytes())
    runtime_source = candidate / "source/flock-voice-engine/runtime/src"
    shutil.copytree(ROOT / "flock-voice-engine/runtime/src", runtime_source)
    entries = []
    for source in sorted(runtime_source.rglob("*")):
        if source.is_file():
            entries.append({"path": source.relative_to(candidate / "source").as_posix(),
                            "byteCount": source.stat().st_size, "sha256": release.sha(source)})
    source_manifest = {"schemaVersion": 1, "entries": entries}
    (candidate / "source-manifest.json").write_bytes(release.canonical(source_manifest))
    manifest = release.manifest_pair(candidate)
    manifest["workerIdentity"]["sourceManifestSha256"] = release.sha(candidate / "source-manifest.json")
    manifest["deployExecutionIdentity"] = {"prepare-cutover-request.mjs": release.sha(tool)}
    release.write_manifest_pair(candidate, manifest)
    ready = {"runtimeOwner": "server", "audioOwner": "world", "workerReady": True,
             "workerIdentity": {"expected": manifest["workerIdentity"],
                                "reported": manifest["workerIdentity"]}, "phaseGate": "phase5-local"}
    monkeypatch.setattr(release, "get_json", lambda base, path: (200, ready)
                        if path in {"/healthz", "/readyz"} else (200, {}))
    original_run = release.run
    monkeypatch.setattr(release, "run", lambda *args, **kwargs: "")
    release.verify_local(type("A", (), {"release_dir": str(candidate),
                                         "base_url": "http://127.0.0.1:18090"})())
    assert not (candidate / "acceptance.json").exists()
    release_sha = release.sha(candidate / "release-manifest.json")
    (candidate / "acceptance.json").write_bytes(release.canonical(
        {"schemaVersion": 1, "status": "accepted",
         "release": {"releaseManifestSha256": release_sha}}))
    monkeypatch.setattr(release, "run", original_run)
    monkeypatch.setattr(release, "validate_acceptance_bundle", lambda *_: None)
    embedded = candidate / "acceptance-inputs/staging-equivalence.json"
    embedded.parent.mkdir(); embedded.write_text("{}")
    (deploy / "validate_phase5_acceptance.py").write_text("# test validator\n")
    monkeypatch.setattr(release, "materialize_acceptance_inputs", lambda *_: embedded)
    release.package(type("A", (), {"release_dir": str(candidate), "equivalence": None})())
    package_record = json.loads((candidate / "package.json").read_text())
    assert package_record["acceptanceSha256"] == release.sha(candidate / "acceptance.json")
    assert package_record["equivalenceSha256"] == release.sha(embedded)
    args.state_policy = "reset-new-world"
    def fake_run(*command, **kwargs):
        if command[:3] == ("docker", "image", "inspect"):
            return "sha256:" + "1" * 64
        if command[:2] == ("docker", "run"):
            subprocess.run(["node", tool, "--release-dir", candidate,
                            "--runtime-root", candidate / "source/flock-voice-engine/runtime",
                            "--state-policy", "reset-new-world", "--output", output], check=True)
            return ""
        raise AssertionError(command)
    monkeypatch.setattr(release, "run", fake_run)
    release.prepare_request(args)
    request = json.loads(output.read_text())
    initial = json.loads((candidate / "initial-world.json").read_text())
    bootstrap = json.loads((candidate / "bootstrap.json").read_text())
    replacement = json.loads((candidate / "state-replace.json").read_text())
    generation = request["newWorldGeneration"]
    assert generation == initial["worldGeneration"] == bootstrap["worldGeneration"]
    assert generation == replacement["value"]["world"]["worldGeneration"]
    assert request["initialWorldSha256"] == release.sha(candidate / "initial-world.json")


def test_packaging_uses_only_manifest_attested_validator_and_schemas(tmp_path):
    candidate = manifest_dir(tmp_path); deploy = candidate / "deploy"; deploy.mkdir()
    manifest = release.manifest_pair(candidate)
    names = ("validate_phase5_acceptance.py", "acceptance.schema.json",
             "machine-attestation.schema.json")
    manifest["deployExecutionIdentity"] = {}
    for name in names:
        (deploy / name).write_text("trusted")
        manifest["deployExecutionIdentity"][name] = release.sha(deploy / name)
    release.write_manifest_pair(candidate, manifest)
    (deploy / "validate_phase5_acceptance.py").write_text("tampered")
    with pytest.raises(release.ReleaseError, match="ACCEPTANCE_VALIDATOR_IDENTITY_MISMATCH"):
        release.validate_acceptance_bundle(candidate, tmp_path / "equivalence.json")


def test_prepare_rejects_acceptance_replaced_after_package(tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path); monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    release_sha = release.sha(candidate / "release-manifest.json")
    acceptance = {"schemaVersion": 1, "status": "accepted",
                  "release": {"releaseManifestSha256": release_sha}}
    (candidate / "acceptance.json").write_bytes(release.canonical(acceptance))
    inputs = candidate / "acceptance-inputs"; inputs.mkdir()
    (inputs / "staging-equivalence.json").write_text("{}")
    deploy = candidate / "deploy"; deploy.mkdir()
    (deploy / "validate_phase5_acceptance.py").write_text("trusted")
    package = {"schemaVersion": 1, "status": "packaged", "releaseManifestSha256": release_sha,
               "acceptanceSha256": release.sha(candidate / "acceptance.json"),
               "equivalenceSha256": release.sha(inputs / "staging-equivalence.json"),
               "acceptanceValidatorSha256": release.sha(deploy / "validate_phase5_acceptance.py")}
    (candidate / "package.json").write_bytes(release.canonical(package))
    acceptance["operatorListening"] = {"completed": False}
    (candidate / "acceptance.json").write_bytes(release.canonical(acceptance))
    args = type("A", (), {"release_dir": str(candidate), "state_policy": "reset-new-world",
                          "output": str(candidate / "cutover-request.json")})()
    with pytest.raises(release.ReleaseError, match="CUTOVER_REQUEST_PREREQUISITE_MISSING"):
        release.prepare_request(args)


def test_unknown_subcommand_and_production_cutover_fail_closed(tmp_path, monkeypatch, capsys):
    calls = []
    with monkeypatch.context() as gate_patch:
        gate_patch.setattr(release.sys, "platform", "win32")
        for function_name in (
            "build_local",
            "stage_local",
            "verify_local",
            "verify_candidate",
            "package",
            "import_release",
            "prepare_request",
            "rollback",
            "status",
        ):
            gate_patch.setattr(
                release,
                function_name,
                lambda _args, name=function_name: calls.append(name),
            )
        cli_cases = (
            ["build-local", "--inputs", "inputs.json", "--output", "release"],
            ["stage-local", "--release-dir", "release"],
            ["verify-local", "--release-dir", "release", "--base-url", "http://127.0.0.1:18090"],
            ["verify-candidate", "--release-dir", "release", "--base-url", "http://127.0.0.1:18090"],
            ["package", "--release-dir", "release"],
            ["import", "--release-dir", "release"],
            [
                "prepare-cutover-request",
                "--release-dir",
                "release",
                "--state-policy",
                "reset-new-world",
                "--output",
                "release/cutover-request.json",
            ],
            ["cutover"],
            ["rollback", "--release-dir", "release"],
            ["status"],
        )
        for argv in cli_cases:
            assert release.main(argv) == 2
            assert "RELEASE_GATE_REQUIRES_LINUX" in capsys.readouterr().err
        assert calls == []
    with monkeypatch.context() as linux_patch:
        linux_patch.setattr(release.sys, "platform", "linux")
        assert release.main(["cutover"]) == 2
        assert "PRODUCTION_RELEASE_AUTHORIZATION_REQUIRED" in capsys.readouterr().err

    deploy = tmp_path / "deploy"
    stub_bin = tmp_path / "bin"
    deploy.mkdir()
    stub_bin.mkdir()
    script = deploy / "release.sh"
    script.write_bytes((DEPLOY / "release.sh").read_bytes().replace(b"\r\n", b"\n"))
    script.chmod(0o755)
    shutil.copy2(DEPLOY / "release_control.py", deploy / "release_control.py")
    python3_shim(stub_bin / "python3")
    env = {**os.environ, "FLOCK_DEPLOY_SCOPE": "local"}
    unknown = run_bash_action(script, "surprise", stub_bin, env)
    cutover = run_bash_action(script, "cutover", stub_bin, env)
    unknown_stderr = unknown.stderr.decode("utf-8", errors="replace")
    cutover_stderr = cutover.stderr.decode("utf-8", errors="replace")
    assert unknown.returncode != 0
    expected = (
        "PRODUCTION_RELEASE_AUTHORIZATION_REQUIRED"
        if sys.platform == "linux"
        else "RELEASE_GATE_REQUIRES_LINUX"
    )
    assert cutover.returncode != 0 and expected in cutover_stderr
    assert "UnicodeDecodeError" not in unknown_stderr + cutover_stderr


def test_managed_renderer_preserves_human_content(tmp_path):
    doc = tmp_path / "handoff.md"; doc.write_text("human\n")
    renderer = ROOT / "flock-voice-engine/tools/render_cutover_docs.py"
    subprocess.run([sys.executable, renderer, "--initial-status", "legacy-not-cut-over", "--handoff", doc], check=True)
    first = doc.read_text()
    subprocess.run([sys.executable, renderer, "--initial-status", "legacy-not-cut-over", "--handoff", doc], check=True)
    assert doc.read_text() == first and first.startswith("human\n") and first.count("phase5-managed-status:start") == 1


def test_bootstrap_rejects_archive_traversal_before_execution(tmp_path):
    bootstrap = tmp_path / "import-release.sh"
    bootstrap.write_bytes((DEPLOY / "import-release.sh").read_bytes().replace(b"\r\n", b"\n"))
    bootstrap.chmod(0o755)
    stub_bin = tmp_path / "bin"
    stub_bin.mkdir()
    python3_shim(stub_bin / "python3")
    archive_tar = tmp_path / "release.tar"
    payload = tmp_path / "payload"; payload.write_text("escape")
    with tarfile.open(archive_tar, "w") as tf:
        tf.add(payload, arcname="../escape")
    archive = tmp_path / "release.tar.zst"
    subprocess.run(["zstd", "-q", "-f", archive_tar, "-o", archive], check=True)
    for path in (bootstrap, archive):
        (tmp_path / f"{path.name}.sha256").write_text(f"{release.sha(path)}  {path.name}\n")
    result = run_import_bootstrap(bootstrap, archive, stub_bin, os.environ.copy())
    stderr = result.stderr.decode("utf-8", errors="replace")
    assert result.returncode != 0 and "RELEASE_ARCHIVE_UNSAFE" in stderr
    assert "UnicodeDecodeError" not in stderr
    assert not (tmp_path.parent / "escape").exists()


def test_import_inspects_loaded_engine_identity(tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    manifest = release.manifest_pair(candidate)
    manifest["imageIdentity"] = {name: "sha256:" + "2" * 64 for name in ("runtime", "audio")}
    release.write_manifest_pair(candidate, manifest)
    images = candidate / "images"; images.mkdir()
    for name in ("runtime", "audio"): (images / f"{name}.oci.tar").write_bytes(b"oci")
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(release, "oci_manifest_digest", lambda path: ("sha256:" + "2" * 64,
                                                                      "sha256:" + "1" * 64))
    calls = []
    monkeypatch.setattr(release, "run", lambda *args, **kwargs: calls.append(args) or (
        "loaded" if args[:2] == ("docker", "load") else "sha256:" + "1" * 64))
    release.import_release(type("A", (), {"release_dir": str(candidate)})())
    assert sum(call[:3] == ("docker", "image", "inspect") for call in calls) == 2


@pytest.mark.parametrize("kind,record", [("reset", {}), ("snapshot", {"worldGeneration": 3})])
def test_rollback_rejects_missing_corresponding_state_record(tmp_path, monkeypatch, kind, record):
    candidate = manifest_dir(tmp_path); monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    state = {"schemaVersion": 1, "releaseManifestSha256": release.sha(candidate / "release-manifest.json"),
             "kind": kind, "stateRecord": record,
             "previousImageIdentity": {name: "sha256:" + "2" * 64 for name in ("runtime", "audio")},
             "previousImages": {name: {"tag": name, "localEngineImageId": "sha256:" + "1" * 64}
                                for name in ("runtime", "audio")}}
    (candidate / "rollback-state.json").write_bytes(release.canonical(state))
    with pytest.raises(release.ReleaseError, match="ROLLBACK_STATE_INVALID"):
        release.rollback(type("A", (), {"release_dir": str(candidate)})())


def test_renderer_rejects_unattested_cutover_record(tmp_path):
    record = tmp_path / "record.json"
    record.write_text(json.dumps({"releaseManifestSha256": "a" * 64,
                                  "runtimeImageDigest": "sha256:" + "b" * 64,
                                  "audioImageDigest": "sha256:" + "c" * 64},
                                 sort_keys=True, separators=(",", ":")))
    doc = tmp_path / "doc.md"; doc.write_text("human\n")
    result = subprocess.run([sys.executable, ROOT / "flock-voice-engine/tools/render_cutover_docs.py",
                             "--record", record, "--handoff", doc], capture_output=True)
    assert result.returncode != 0 and doc.read_text() == "human\n"
