from __future__ import annotations

import ast
import copy
import functools
import hashlib
import importlib.util
import inspect
import io
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from types import SimpleNamespace

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

FAULT_VERIFIER_DEPLOY_SOURCES = {
    "phase5-fault-verifier/verify-phase5-fault-evidence.mjs":
        "flock-voice-engine/runtime/tools/verify-phase5-fault-evidence.mjs",
    "phase5-fault-verifier/verify-phase5-capture-proof.mjs":
        "flock-voice-engine/runtime/tools/verify-phase5-capture-proof.mjs",
    "phase5-fault-verifier/lib/phase5-fault-evidence.mjs":
        "flock-voice-engine/runtime/tools/lib/phase5-fault-evidence.mjs",
    "phase5-fault-verifier/lib/phase5-fault-validation.mjs":
        "flock-voice-engine/runtime/tools/lib/phase5-fault-validation.mjs",
    "phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs":
        "flock-voice-engine/runtime/tools/lib/phase5-fault-transport-projection.mjs",
    "phase5-fault-verifier/lib/phase5-fault-semantics.mjs":
        "flock-voice-engine/runtime/tools/lib/phase5-fault-semantics.mjs",
    "src/capture/phase5-capture-proof.js":
        "flock-voice-engine/runtime/src/capture/phase5-capture-proof.js",
    "src/capture/capture-wire.js":
        "flock-voice-engine/runtime/src/capture/capture-wire.js",
}

CAPTURE_PROOF_DEPLOY_NAMES = (
    "phase5-fault-verifier/verify-phase5-capture-proof.mjs",
    "src/capture/phase5-capture-proof.js",
    "src/capture/capture-wire.js",
)

PHASE5_SUMMARY_DEPLOY_SOURCES = {
    "phase5-summary/phase5-summary.schema.json":
        "flock-voice-engine/release/phase5-summary.schema.json",
    "phase5-summary/soak-phase5.mjs":
        "flock-voice-engine/runtime/tools/soak-phase5.mjs",
    "phase5-summary/capture_machine_attestation.py":
        "flock-voice-engine/tools/capture_machine_attestation.py",
}

EXPECTED_DEPLOY_EXECUTION_PARENT_NAMES = (
    "phase5-fault-verifier",
    "phase5-fault-verifier/lib",
    "src",
    "src/capture",
    "phase5-summary",
)

EXPECTED_DEPLOY_EXECUTION_NAMES = (
    "release.sh",
    "release_control.py",
    "phase5_candidate_attempt.py",
    "phase5_candidate_bootstrap.py",
    "verify-smoke.mjs",
    "verify-candidate.sh",
    "legacy-lease.mjs",
    "prepare-cutover-request.mjs",
    "validate_phase5_acceptance.py",
    "acceptance.schema.json",
    "machine-attestation.schema.json",
    *FAULT_VERIFIER_DEPLOY_SOURCES,
    *PHASE5_SUMMARY_DEPLOY_SOURCES,
)


def route_mime(repo_path: str) -> str:
    if repo_path.endswith(".html"):
        return "text/html; charset=utf-8"
    if repo_path.endswith(".js"):
        return "application/javascript; charset=utf-8"
    if repo_path.endswith(".json"):
        return "application/json; charset=utf-8"
    raise AssertionError(repo_path)


def trusted_bash() -> Path:
    override = os.environ.get("PHASE6_APPROVED_BASH_EXE")
    windows_git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    bash = (
        Path(override)
        if override
        else windows_git_bash
        if windows_git_bash.is_file()
        else Path("/bin/bash")
    )
    assert bash.is_absolute()
    assert bash.is_file(), "需要 Git Bash 或 POSIX /bin/bash 执行发布契约测试"
    return bash


def trusted_zstd() -> Path:
    override = os.environ.get("PHASE6_APPROVED_ZSTD_EXE")
    discovered = shutil.which("zstd") if not override else None
    zstd = Path(override or discovered or "")
    assert zstd.is_absolute()
    assert zstd.is_file(), "需要受控 zstd 执行发布归档契约测试"
    return zstd


def trusted_node() -> Path:
    override = os.environ.get("PHASE6_APPROVED_NODE_EXE")
    discovered = shutil.which("node") if not override else None
    node = Path(override or discovered or "")
    assert node.is_absolute()
    assert node.is_file(), "需要受控 Node.js 执行发布契约测试"
    return node


def trusted_windows_npm_command() -> list[str]:
    node_override = os.environ.get("PHASE6_APPROVED_NODE_EXE")
    npm_cli_override = os.environ.get("PHASE6_APPROVED_NPM_CLI")
    assert bool(node_override) == bool(npm_cli_override)
    if node_override and npm_cli_override:
        node = Path(node_override)
        npm_cli = Path(npm_cli_override)
    else:
        node = trusted_node()
        npm_cli = node.parent / "node_modules/npm/bin/npm-cli.js"
    assert node.is_absolute() and node.is_file()
    assert npm_cli.is_absolute() and npm_cli.is_file()
    return [str(node), str(npm_cli)]


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


def import_bootstrap_python() -> tuple[ast.Module, dict[str, object]]:
    source = (DEPLOY / "import-release.sh").read_text()
    body = source.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    tree = ast.parse(body)
    definitions = ast.Module(
        body=[
            node for node in tree.body
            if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef))
        ],
        type_ignores=[],
    )
    namespace: dict[str, object] = {}
    exec(compile(definitions, str(DEPLOY / "import-release.sh"), "exec"),
         namespace)
    return tree, namespace


def test_package_excludes_candidate_runtime_secrets_and_sockets():
    source = inspect.getsource(release.package)
    assert "--exclude={release_dir.name}/run-flock-audio" in source


def manifest_dir(tmp_path: Path) -> Path:
    lease_tool_body = b"fixture legacy lease tool\n"
    candidate_controller_bodies = {
        name: (DEPLOY / name).read_bytes()
        for name in (
            "phase5_candidate_attempt.py",
            "phase5_candidate_bootstrap.py",
        )
    }
    value = {"schemaVersion": 1, "workerIdentity": {"releaseRevision": "a" * 40,
              "sourceManifestSha256": "b" * 64, "audioArtifactSha256": "c" * 64,
              "protocolFamily": "flock-audio-ipc", "protocolVersion": 1,
              "audioArtifactKind": "release-artifact"},
             "geometry": {"sampleRate": 44100, "blockFrames": 4096, "poolSize": 5,
                          "rowVoices": ["bass", "pad", "lead", "pluck", "pad"]},
             "imageIdentity": {"runtime": "sha256:" + "2" * 64,
                               "audio": "sha256:" + "3" * 64},
             "localImageDiagnostics": {"runtime": {"tag": "flock-runtime:r-a", "localEngineImageId": "sha256:" + "1" * 64},
                                        "audio": {"tag": "flock-audio:r-a", "localEngineImageId": "sha256:" + "1" * 64}},
             "deployExecutionIdentity": {
                 "legacy-lease.mjs": hashlib.sha256(lease_tool_body).hexdigest(),
                 **{
                     name: hashlib.sha256(body).hexdigest()
                     for name, body in candidate_controller_bodies.items()
                 },
             }}
    path = tmp_path / "candidate"; path.mkdir()
    deploy = path / "deploy"; deploy.mkdir()
    (deploy / "legacy-lease.mjs").write_bytes(lease_tool_body)
    for name, body in candidate_controller_bodies.items():
        (deploy / name).write_bytes(body)
    (path / "release-manifest.json").write_bytes(release.canonical(value))
    digest = release.sha(path / "release-manifest.json")
    (path / "release-manifest.json.sha256").write_text(f"{digest}  release-manifest.json\n")
    return path


def install_acceptance_execution_closure(candidate: Path) -> None:
    deploy = candidate / "deploy"
    manifest = release.manifest_pair(candidate)
    names = (
        "validate_phase5_acceptance.py",
        "acceptance.schema.json",
        "machine-attestation.schema.json",
        *FAULT_VERIFIER_DEPLOY_SOURCES,
        *PHASE5_SUMMARY_DEPLOY_SOURCES,
    )
    for name in names:
        path = deploy / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "def validate_bundle(*_args):\n    return None\n"
            if name == "validate_phase5_acceptance.py"
            else f"trusted {name}\n"
        )
        manifest["deployExecutionIdentity"][name] = release.sha(path)
    release.write_manifest_pair(candidate, manifest)


def test_phase5_fault_verifier_has_an_exact_nested_deploy_identity():
    assert release.DEPLOY_EXECUTION_NAMES == EXPECTED_DEPLOY_EXECUTION_NAMES
    assert (
        release.DEPLOY_EXECUTION_PARENT_NAMES
        == EXPECTED_DEPLOY_EXECUTION_PARENT_NAMES
    )
    assert tuple(FAULT_VERIFIER_DEPLOY_SOURCES) == (
        "phase5-fault-verifier/verify-phase5-fault-evidence.mjs",
        "phase5-fault-verifier/verify-phase5-capture-proof.mjs",
        "phase5-fault-verifier/lib/phase5-fault-evidence.mjs",
        "phase5-fault-verifier/lib/phase5-fault-validation.mjs",
        "phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs",
        "phase5-fault-verifier/lib/phase5-fault-semantics.mjs",
        "src/capture/phase5-capture-proof.js",
        "src/capture/capture-wire.js",
    )


def test_phase5_summary_tooling_has_an_exact_nested_deploy_identity():
    assert dict(release.PHASE5_SUMMARY_DEPLOY_SOURCES) == {
        source: destination
        for destination, source in PHASE5_SUMMARY_DEPLOY_SOURCES.items()
    }
    assert all(
        not source.startswith(release.GRAPH_SOURCE_PREFIXES)
        for source in PHASE5_SUMMARY_DEPLOY_SOURCES.values()
    )
    assert tuple(PHASE5_SUMMARY_DEPLOY_SOURCES) == (
        "phase5-summary/phase5-summary.schema.json",
        "phase5-summary/soak-phase5.mjs",
        "phase5-summary/capture_machine_attestation.py",
    )


def test_import_bootstrap_declares_the_exact_deploy_execution_closure():
    tree, _namespace = import_bootstrap_python()
    assignments = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "names"
                for target in node.targets)
    ]
    assert len(assignments) == 1
    assert ast.literal_eval(assignments[0].value) == EXPECTED_DEPLOY_EXECUTION_NAMES


def test_import_bootstrap_declares_the_exact_nested_execution_parents():
    tree, _namespace = import_bootstrap_python()
    assignments = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name)
            and target.id == "nested_parent_names"
            for target in node.targets
        )
    ]
    assert len(assignments) == 1
    assert (
        ast.literal_eval(assignments[0].value)
        == EXPECTED_DEPLOY_EXECUTION_PARENT_NAMES
    )


def test_import_bootstrap_execution_parents_include_top_level_deploy(
        tmp_path):
    _tree, namespace = import_bootstrap_python()
    execution_parent_paths = namespace.get("execution_parent_paths")
    assert callable(execution_parent_paths)

    root = tmp_path / "release"
    assert execution_parent_paths(
        root,
        EXPECTED_DEPLOY_EXECUTION_PARENT_NAMES,
    ) == (
        root / "deploy",
        *(
            root / "deploy" / name
            for name in EXPECTED_DEPLOY_EXECUTION_PARENT_NAMES
        ),
    )


def test_import_bootstrap_executes_verified_private_snapshot_after_replacement(
        tmp_path):
    tree, namespace = import_bootstrap_python()
    execution_snapshot = namespace.get("execution_snapshot")
    materialize_execution_snapshot = namespace.get(
        "materialize_execution_snapshot")
    execute_release_snapshot = namespace.get("execute_release_snapshot")
    assert callable(execution_snapshot)
    assert callable(materialize_execution_snapshot)
    assert callable(execute_release_snapshot)

    release_root = tmp_path / "release"
    deploy = release_root / "deploy"
    deploy.mkdir(parents=True)
    trusted = {
        "release.sh": b"#!/usr/bin/env bash\ntrusted release\n",
        "release_control.py": b"trusted controller\n",
    }
    verified = {}
    for name, body in trusted.items():
        path = deploy / name
        path.write_bytes(body)
        digest, captured = execution_snapshot(path)
        assert digest == hashlib.sha256(body).hexdigest()
        verified[name] = captured
        path.write_bytes(f"replacement {name}\n".encode())

    snapshot_deploy = materialize_execution_snapshot(
        tmp_path / "private-execution",
        verified,
    )
    observed = []

    def fake_runner(command):
        observed.append(command)
        assert Path(command[1]).read_bytes() == trusted["release.sh"]
        assert (
            Path(command[1]).with_name("release_control.py").read_bytes()
            == trusted["release_control.py"]
        )
        return SimpleNamespace(returncode=0)

    assert execute_release_snapshot(
        snapshot_deploy,
        release_root,
        runner=fake_runner,
    ) == 0
    assert observed == [[
        "bash",
        str(snapshot_deploy / "release.sh"),
        "import",
        "--release-dir",
        str(release_root),
    ]]

    called_names = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert {
        "execution_snapshot",
        "materialize_execution_snapshot",
        "execute_release_snapshot",
    } <= called_names
    final_snapshot_exits = [
        node
        for node in ast.walk(tree)
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "SystemExit"
            and len(node.args) == 1
            and isinstance(node.args[0], ast.Call)
            and isinstance(node.args[0].func, ast.Name)
            and node.args[0].func.id == "execute_release_snapshot"
        )
    ]
    assert len(final_snapshot_exits) == 1


def test_import_bootstrap_decompresses_checked_archive_snapshot_after_replacement(
        tmp_path):
    tree, namespace = import_bootstrap_python()
    capture_archive = namespace.get("capture_checked_archive_snapshot")
    decompress_archive = namespace.get("decompress_archive_snapshot")
    assert callable(capture_archive)
    assert callable(decompress_archive)

    trusted_archive = b"trusted compressed release bytes\n"
    archive = tmp_path / "release.tar.zst"
    sidecar = tmp_path / "release.tar.zst.sha256"
    archive.write_bytes(trusted_archive)
    sidecar.write_text(
        f"{hashlib.sha256(trusted_archive).hexdigest()}  "
        "release.tar.zst\n",
        encoding="ascii",
    )
    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    snapshot = private / "archive.snapshot"

    assert capture_archive(archive, sidecar, snapshot) == snapshot
    archive.write_bytes(b"replacement archive bytes\n")

    tar_path = private / "release.tar"
    observed = []

    def fake_zstd(command, stdout):
        observed.append(command)
        assert Path(command[-1]) == snapshot
        assert snapshot.read_bytes() == trusted_archive
        stdout.write(b"trusted decompressed tar bytes\n")
        return SimpleNamespace(returncode=0)

    assert decompress_archive(
        snapshot,
        tar_path,
        runner=fake_zstd,
    ) == tar_path
    assert tar_path.read_bytes() == b"trusted decompressed tar bytes\n"
    assert observed == [[
        "zstd",
        "-q",
        "-d",
        "-c",
        str(snapshot),
    ]]

    called_names = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert {
        "capture_checked_archive_snapshot",
        "decompress_archive_snapshot",
    } <= called_names


@pytest.mark.parametrize("link_kind", ("symlink", "reparse"))
def test_import_bootstrap_rejects_fault_verifier_parent_link_or_reparse(
        tmp_path, monkeypatch, link_kind):
    _tree, namespace = import_bootstrap_python()
    parent = tmp_path / "phase5-fault-verifier"
    parent.mkdir()
    original_lstat = Path.lstat
    actual = original_lstat(parent)
    fake = SimpleNamespace(
        st_mode=(
            stat.S_IFLNK | 0o777
            if link_kind == "symlink"
            else actual.st_mode
        ),
        st_file_attributes=(
            getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
            if link_kind == "reparse"
            else 0
        ),
        st_dev=actual.st_dev,
        st_ino=actual.st_ino,
        st_size=actual.st_size,
        st_mtime_ns=actual.st_mtime_ns,
    )
    monkeypatch.setattr(
        Path,
        "lstat",
        lambda path: fake if path == parent else original_lstat(path),
    )

    with pytest.raises(SystemExit):
        namespace["real_directory_state"](parent)


def test_fault_verifier_materializer_uses_only_the_captured_revision(
        tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    deploy = tmp_path / "release/deploy"
    revision = "a" * 40
    observed = []

    def pinned_blob(actual_repo, actual_revision, source):
        observed.append((actual_repo, actual_revision, source))
        return f"{actual_revision}:{source}\n".encode()

    monkeypatch.setattr(release, "git_blob", pinned_blob)
    release.materialize_fault_verifier_closure(repo, revision, deploy)

    assert observed == [
        (repo, revision, source)
        for source in FAULT_VERIFIER_DEPLOY_SOURCES.values()
    ]
    for destination, source in FAULT_VERIFIER_DEPLOY_SOURCES.items():
        assert (deploy / destination).read_bytes() == (
            f"{revision}:{source}\n".encode()
        )


def test_phase5_summary_materializer_uses_only_the_captured_revision(
        tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    deploy = tmp_path / "release/deploy"
    revision = "a" * 40
    observed = []

    def pinned_blob(actual_repo, actual_revision, source):
        observed.append((actual_repo, actual_revision, source))
        return f"{actual_revision}:{source}\n".encode()

    monkeypatch.setattr(release, "git_blob", pinned_blob)
    release.materialize_phase5_summary_closure(repo, revision, deploy)

    assert observed == [
        (repo, revision, source)
        for source in PHASE5_SUMMARY_DEPLOY_SOURCES.values()
    ]
    for destination, source in PHASE5_SUMMARY_DEPLOY_SOURCES.items():
        assert (deploy / destination).read_bytes() == (
            f"{revision}:{source}\n".encode()
        )


@functools.lru_cache(maxsize=1)
def authoritative_production_graph() -> dict:
    graph = json.loads(subprocess.check_output(
        [
            str(trusted_node()),
            ROOT / "flock-voice-engine/runtime/tools/build-production-graph.mjs",
        ],
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
        "flock-voice-engine/deploy/phase5_candidate_attempt.py",
        "flock-voice-engine/deploy/phase5_candidate_bootstrap.py",
        "flock-voice-engine/deploy/verify-smoke.mjs",
        "flock-voice-engine/deploy/verify-candidate.sh",
        "flock-voice-engine/runtime/tools/legacy-lease.mjs",
        "flock-voice-engine/runtime/tools/prepare-cutover-request.mjs",
        *FAULT_VERIFIER_DEPLOY_SOURCES.values(),
        *PHASE5_SUMMARY_DEPLOY_SOURCES.values(),
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
        "flock-voice-engine/deploy/phase5_candidate_attempt.py",
        "flock-voice-engine/deploy/phase5_candidate_bootstrap.py",
        "flock-voice-engine/runtime/tools/legacy-lease.mjs",
        *FAULT_VERIFIER_DEPLOY_SOURCES.values(),
        *PHASE5_SUMMARY_DEPLOY_SOURCES.values(),
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


def git_read(repo: Path, *args: str, no_replace: bool = False,
             text: bool = False):
    command = ["git"]
    if no_replace:
        command.append("--no-replace-objects")
    command.extend(("-C", str(repo), *args))
    return subprocess.check_output(command, text=text)


def controller_replace_repo(
        tmp_path: Path, replacement_kind: str) -> tuple[Path, str]:
    repo = tmp_path / f"controller-{replacement_kind}-replace"
    repo.mkdir()
    subprocess.run(
        ["git", "init", "--initial-branch=main", str(repo)],
        check=True,
        capture_output=True,
    )
    (repo / "kept.txt").write_bytes(b"A\n")
    subprocess.run(["git", "-C", str(repo), "add", "kept.txt"], check=True)
    subprocess.run(
        [
            "git", "-C", str(repo),
            "-c", "user.name=Replace Ref Test",
            "-c", "user.email=replace@example.invalid",
            "commit", "-m", "revision A",
        ],
        check=True,
        capture_output=True,
    )
    revision_a = git_read(
        repo, "rev-parse", "HEAD", no_replace=True, text=True).strip()
    (repo / "kept.txt").write_bytes(b"B\n")
    (repo / "replacement-only.txt").write_bytes(b"replacement\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        [
            "git", "-C", str(repo),
            "-c", "user.name=Replace Ref Test",
            "-c", "user.email=replace@example.invalid",
            "commit", "-m", "revision B",
        ],
        check=True,
        capture_output=True,
    )
    revision_b = git_read(
        repo, "rev-parse", "HEAD", no_replace=True, text=True).strip()
    if replacement_kind == "commit":
        replaced, replacement = revision_a, revision_b
    else:
        replaced = git_read(
            repo, "rev-parse", f"{revision_a}:kept.txt",
            no_replace=True, text=True).strip()
        replacement = git_read(
            repo, "rev-parse", f"{revision_b}:kept.txt",
            no_replace=True, text=True).strip()
    subprocess.run(
        ["git", "-C", str(repo), "replace", replaced, replacement],
        check=True,
        capture_output=True,
    )
    return repo, revision_a


@pytest.mark.parametrize("replacement_kind", ("commit", "blob"))
def test_controller_git_helpers_ignore_replace_refs(
        tmp_path, replacement_kind):
    repo, revision_a = controller_replace_repo(tmp_path, replacement_kind)
    ordinary_names = git_read(
        repo, "ls-tree", "-r", "--name-only", revision_a,
        text=True).splitlines()
    authoritative_names = git_read(
        repo, "ls-tree", "-r", "--name-only", revision_a,
        no_replace=True, text=True).splitlines()
    ordinary_body = git_read(repo, "show", f"{revision_a}:kept.txt")
    authoritative_body = git_read(
        repo, "show", f"{revision_a}:kept.txt", no_replace=True)

    assert authoritative_names == ["kept.txt"]
    assert authoritative_body == b"A\n"
    assert ordinary_body == b"B\n"
    if replacement_kind == "commit":
        assert ordinary_names == ["kept.txt", "replacement-only.txt"]
    else:
        assert ordinary_names == authoritative_names

    actual = (
        release.git_tree_names(repo, revision_a),
        release.git_blob(repo, revision_a, "kept.txt"),
    )
    assert actual == (authoritative_names, authoritative_body)


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
        self.git_state_calls = []

    def __call__(self, *args, capture=False):
        prefix = ("git", "--no-replace-objects", "-C", str(self.repo))
        if args == (*prefix, "rev-parse", "HEAD"):
            self.git_state_calls.append(args)
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
        if args == (
                *prefix, "status", "--porcelain", "--untracked-files=no"):
            self.git_state_calls.append(args)
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


def controller_replace_state_views(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "controller-replace-state"
    repo.mkdir()
    subprocess.run(
        ["git", "init", "--initial-branch=main", str(repo)],
        check=True,
        capture_output=True,
    )
    (repo / "kept.txt").write_bytes(b"A\n")
    subprocess.run(["git", "-C", str(repo), "add", "kept.txt"], check=True)
    subprocess.run(
        [
            "git", "-C", str(repo),
            "-c", "user.name=Replace Ref Test",
            "-c", "user.email=replace@example.invalid",
            "commit", "-m", "revision A",
        ],
        check=True,
        capture_output=True,
    )
    revision_a = git_read(
        repo, "rev-parse", "HEAD", no_replace=True, text=True).strip()
    (repo / "kept.txt").write_bytes(b"B\n")
    (repo / "replacement-only.txt").write_bytes(b"replacement\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        [
            "git", "-C", str(repo),
            "-c", "user.name=Replace Ref Test",
            "-c", "user.email=replace@example.invalid",
            "commit", "-m", "revision B",
        ],
        check=True,
        capture_output=True,
    )
    revision_b = git_read(
        repo, "rev-parse", "HEAD", no_replace=True, text=True).strip()
    subprocess.run(
        ["git", "-C", str(repo), "replace", revision_a, revision_b],
        check=True,
        capture_output=True,
    )

    subprocess.run(
        [
            "git", "--no-replace-objects", "-C", str(repo),
            "checkout", "--detach", "--force", revision_a,
        ],
        check=True,
        capture_output=True,
    )
    ordinary_raw_a = git_read(
        repo, "status", "--porcelain", "--untracked-files=no",
        text=True).strip()
    authoritative_raw_a = git_read(
        repo, "status", "--porcelain", "--untracked-files=no",
        no_replace=True, text=True).strip()
    assert ordinary_raw_a
    assert authoritative_raw_a == ""

    subprocess.run(
        [
            "git", "-C", str(repo),
            "read-tree", "--reset", "-u", revision_a,
        ],
        check=True,
        capture_output=True,
    )
    ordinary_replacement_b = git_read(
        repo, "status", "--porcelain", "--untracked-files=no",
        text=True).strip()
    authoritative_replacement_b = git_read(
        repo, "status", "--porcelain", "--untracked-files=no",
        no_replace=True, text=True).strip()
    assert ordinary_replacement_b == ""
    assert authoritative_replacement_b

    subprocess.run(
        [
            "git", "--no-replace-objects", "-C", str(repo),
            "checkout", "--detach", "--force", revision_a,
        ],
        check=True,
        capture_output=True,
    )
    assert git_read(
        repo, "status", "--porcelain", "--untracked-files=no",
        no_replace=True, text=True).strip() == ""
    return repo, revision_a


def test_build_local_git_state_reads_disable_replace_refs(
        tmp_path):
    repo, revision_a = controller_replace_state_views(tmp_path)
    prefix = ("git", "--no-replace-objects", "-C", str(repo))
    observed = []

    def runner(*args, capture=False):
        assert capture is True
        observed.append(args)
        return subprocess.check_output(args, text=True).strip()

    captured = release.capture_candidate_revision(runner, repo)
    release.verify_candidate_repository_state(runner, repo, captured)

    assert captured == revision_a
    assert observed == [
        (*prefix, "rev-parse", "HEAD"),
        (*prefix, "status", "--porcelain", "--untracked-files=no"),
        (*prefix, "rev-parse", "HEAD"),
    ]


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
    lease_tool = output / "deploy/legacy-lease.mjs"
    assert lease_tool.read_bytes() == git_blob(
        repo, revision_a, "flock-voice-engine/runtime/tools/legacy-lease.mjs")
    assert release.manifest_pair(output)["deployExecutionIdentity"][
        "legacy-lease.mjs"
    ] == release.sha(lease_tool)
    for name in (
            "phase5_candidate_attempt.py",
            "phase5_candidate_bootstrap.py"):
        deployed = output / "deploy" / name
        source = f"flock-voice-engine/deploy/{name}"
        assert deployed.read_bytes() == git_blob(
            repo, revision_a, source)
        assert release.manifest_pair(output)["deployExecutionIdentity"][
            name
        ] == release.sha(deployed)
    for destination, source in FAULT_VERIFIER_DEPLOY_SOURCES.items():
        deployed = output / "deploy" / destination
        assert deployed.read_bytes() == git_blob(repo, revision_a, source)
        assert release.manifest_pair(output)["deployExecutionIdentity"][
            destination
        ] == release.sha(deployed)
    for destination, source in PHASE5_SUMMARY_DEPLOY_SOURCES.items():
        deployed = output / "deploy" / destination
        assert deployed.read_bytes() == git_blob(repo, revision_a, source)
        assert release.manifest_pair(output)["deployExecutionIdentity"][
            destination
        ] == release.sha(deployed)
    assert (output / "source/mvp/index.html").read_bytes() == git_blob(
        repo, revision_a, "mvp/index.html")
    assert (output / "production-graph.json").read_bytes() == release.canonical(graph_a)
    assert release.manifest_pair(output)["workerIdentity"]["releaseRevision"] == revision_a


def test_build_local_final_rehash_rejects_graph_mutated_after_image_builds(
        tmp_path, monkeypatch):
    with pytest.raises(release.ReleaseError,
                       match="PRODUCTION_GRAPH_BINDING_MISMATCH"):
        run_fake_local_build(tmp_path, monkeypatch, tamper_after_images=True)


def test_production_graph_snapshot_uses_explicit_revision_while_head_moves(
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


def hostile_revision_snapshot_repo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "hostile-revision-snapshot-repo"
    repo.mkdir()
    subprocess.run(
        ["git", "init", "--initial-branch=main", str(repo)],
        check=True,
        capture_output=True,
    )
    files = {
        ".gitattributes": (
            b"substituted.txt export-subst text eol=crlf\n"
            b"ignored.txt export-ignore\n"
        ),
        "plain-lf.txt": b"line one\nline two\n",
        "binary.bin": b"left\r\nmiddle\x00right\n",
        "executable.sh": b"#!/bin/sh\nexit 0\n",
        "non-executable.txt": b"not executable\n",
        "substituted.txt": b"$Format:%H$\n",
        "ignored.txt": b"must remain present\n",
        "flock-voice-engine/runtime/package.json": b"{}\n",
        "flock-voice-engine/runtime/tools/build-production-graph.mjs":
            b"process.stdout.write('{}')\n",
    }
    for relative, body in files.items():
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "update-index", "--chmod=+x", "executable.sh"],
        check=True,
    )
    subprocess.run(
        [
            "git", "-C", str(repo),
            "-c", "user.name=Phase5 Test",
            "-c", "user.email=phase5@example.invalid",
            "commit", "-m", "hostile snapshot fixture",
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(repo), "config", "core.autocrlf", "true"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(repo), "config", "core.eol", "crlf"],
        check=True,
    )
    revision = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    return repo, revision


def test_revision_snapshot_uses_exact_committed_blobs_under_hostile_attributes(
        tmp_path):
    repo, revision = hostile_revision_snapshot_repo(tmp_path)
    destination = tmp_path / "revision-snapshot"

    assert release.materialize_revision_snapshot(
        repo, revision, destination) == destination

    inventory = subprocess.check_output(
        [
            "git", "--no-replace-objects", "-C", str(repo),
            "ls-tree", "-r", "-z", "--full-tree", revision,
        ],
    )
    records = [record for record in inventory.split(b"\0") if record]
    expected = {}
    for record in records:
        metadata, raw_path = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split(" ")
        assert kind == "blob"
        relative = raw_path.decode("utf-8")
        expected[relative] = (
            mode,
            subprocess.check_output(
                [
                    "git", "--no-replace-objects", "-C", str(repo),
                    "cat-file", "blob", oid,
                ],
            ),
        )

    assert {
        path.relative_to(destination).as_posix()
        for path in destination.rglob("*")
        if path.is_file()
    } == set(expected)
    for relative, (mode, body) in expected.items():
        materialized = destination / relative
        assert materialized.read_bytes() == body
        if os.name != "nt":
            assert stat.S_IMODE(materialized.stat().st_mode) == (
                0o755 if mode == "100755" else 0o644
            )


def test_production_graph_snapshot_uses_shared_exact_blob_materializer(
        tmp_path, monkeypatch):
    repo, revision = hostile_revision_snapshot_repo(tmp_path)
    output = tmp_path / "graph-output"
    output.mkdir()
    calls = []
    real_materializer = release.materialize_revision_snapshot

    def materializer(actual_repo, actual_revision, destination):
        calls.append((actual_repo, actual_revision, destination))
        return real_materializer(actual_repo, actual_revision, destination)

    def fake_npm(*_args, **kwargs):
        snapshot = kwargs["cwd"].parents[1]
        for relative in ("ignored.txt", "substituted.txt", "plain-lf.txt"):
            assert (snapshot / relative).read_bytes() == subprocess.check_output(
                [
                    "git", "--no-replace-objects", "-C", str(repo),
                    "cat-file", "blob", f"{revision}:{relative}",
                ],
            )
        if os.name != "nt":
            assert stat.S_IMODE(
                (snapshot / "executable.sh").stat().st_mode) == 0o755
            assert stat.S_IMODE(
                (snapshot / "non-executable.txt").stat().st_mode) == 0o644
        return subprocess.CompletedProcess(["npm", "ci"], 0)

    monkeypatch.setattr(release, "materialize_revision_snapshot", materializer)
    monkeypatch.setattr(release, "validate_production_graph", lambda _value: None)

    assert release.production_graph_from_revision(
        repo,
        output,
        revision,
        npm_runner=fake_npm,
        node_runner=lambda *_args, **_kwargs: "{}",
    ) == {}
    assert calls == [(repo, revision, output / ".graph-head")]
    assert not (output / ".graph-head").exists()


def revision_inventory_record(
        path: bytes,
        *,
        mode: bytes = b"100644",
        kind: bytes = b"blob",
        oid: bytes = b"a" * 40,
) -> bytes:
    return mode + b" " + kind + b" " + oid + b"\t" + path + b"\0"


@pytest.mark.parametrize("inventory", [
    revision_inventory_record(b"link", mode=b"120000"),
    revision_inventory_record(b"nested", mode=b"160000", kind=b"commit"),
    revision_inventory_record(b"tree", kind=b"tree"),
    revision_inventory_record(b"unknown", mode=b"100600"),
    revision_inventory_record(b"bad-oid", oid=b"A" * 40),
    revision_inventory_record(b"bad-oid", oid=b"a" * 39),
    b"100644 blob " + b"a" * 40 + b" no-tab\0",
    b"100644  blob " + b"a" * 40 + b"\tspaces\0",
    revision_inventory_record(b"\xff"),
    revision_inventory_record(b""),
    revision_inventory_record(b"/absolute"),
    revision_inventory_record(b"a//b"),
    revision_inventory_record(b"a/./b"),
    revision_inventory_record(b"a/../b"),
    revision_inventory_record(b"C:/drive"),
    revision_inventory_record(b"file:ads"),
    revision_inventory_record(b".GIT/config"),
    revision_inventory_record(b"con"),
    revision_inventory_record(b"AUX.txt"),
    revision_inventory_record(b"com9.log"),
    revision_inventory_record(b"Lpt1"),
    revision_inventory_record(b"trailing."),
    revision_inventory_record(b"trailing "),
    revision_inventory_record(b"control-\x01"),
    revision_inventory_record(b"delete-\x7f"),
    revision_inventory_record(b"unterminated")[:-1],
] + [
    revision_inventory_record(f"bad-{character}".encode("utf-8"))
    for character in '<>:"\\|?*'
])
def test_revision_snapshot_inventory_rejects_nonportable_entries(inventory):
    with pytest.raises(release.ReleaseError, match="^SOURCE_PATH_INVALID$"):
        release._parse_revision_inventory(inventory)


@pytest.mark.parametrize("inventory", [
    (
        revision_inventory_record(b"same/path", oid=b"a" * 40)
        + revision_inventory_record(b"same/path", oid=b"b" * 40)
    ),
    (
        revision_inventory_record("é/File".encode(), oid=b"a" * 40)
        + revision_inventory_record("e\u0301/file".encode(), oid=b"b" * 40)
    ),
    (
        revision_inventory_record(b"Parent", oid=b"a" * 40)
        + revision_inventory_record(b"parent/child", oid=b"b" * 40)
    ),
    (
        revision_inventory_record(b"parent/child", oid=b"a" * 40)
        + revision_inventory_record(b"PARENT", oid=b"b" * 40)
    ),
    (
        revision_inventory_record(b"Dir/a", oid=b"a" * 40)
        + revision_inventory_record(b"dir/b", oid=b"b" * 40)
    ),
    (
        revision_inventory_record("é/a".encode(), oid=b"a" * 40)
        + revision_inventory_record("e\u0301/b".encode(), oid=b"b" * 40)
    ),
])
def test_revision_snapshot_inventory_rejects_collisions(inventory):
    with pytest.raises(release.ReleaseError, match="^SOURCE_PATH_INVALID$"):
        release._parse_revision_inventory(inventory)


@pytest.mark.parametrize("path", [
    *[
        f"{prefix}{suffix}{extension}"
        for prefix in ("COM", "LPT")
        for suffix in ("¹", "²", "³")
        for extension in ("", ".txt")
    ],
    "CONIN$",
    "conin$.txt",
    "CONOUT$",
    "conout$.txt",
    "NUL .txt",
])
def test_revision_snapshot_inventory_rejects_extended_windows_devices(path):
    with pytest.raises(release.ReleaseError, match="^SOURCE_PATH_INVALID$"):
        release._parse_revision_inventory(
            revision_inventory_record(path.encode("utf-8")))


def test_revision_snapshot_rejects_inventory_before_starting_batch_or_writing(
        tmp_path, monkeypatch):
    inventory = revision_inventory_record(b"../escape")
    starts = []
    monkeypatch.setattr(
        release.subprocess,
        "check_output",
        lambda *_args, **_kwargs: inventory,
    )
    monkeypatch.setattr(
        release.subprocess,
        "Popen",
        lambda *_args, **_kwargs: starts.append(True),
    )
    destination = tmp_path / "rejected-snapshot"

    with pytest.raises(release.ReleaseError, match="^SOURCE_PATH_INVALID$"):
        release.materialize_revision_snapshot(
            tmp_path, "a" * 40, destination)

    assert starts == []
    assert not destination.exists()


def test_revision_snapshot_root_resolution_failure_cleans_created_destination(
        tmp_path, monkeypatch):
    inventory = revision_inventory_record(b"file.bin")
    monkeypatch.setattr(
        release.subprocess,
        "check_output",
        lambda *_args, **_kwargs: inventory,
    )
    destination = tmp_path / "resolve-failure-snapshot"
    real_resolve = release.Path.resolve

    def fail_destination_resolve(path, *args, **kwargs):
        if path == destination:
            raise OSError("resolve denied")
        return real_resolve(path, *args, **kwargs)

    monkeypatch.setattr(release.Path, "resolve", fail_destination_resolve)

    with pytest.raises(
            release.ReleaseError,
            match="^REVISION_SNAPSHOT_WRITE_FAILED$"):
        release.materialize_revision_snapshot(
            tmp_path, "a" * 40, destination)

    assert not destination.exists()


class FakeBatchInput(io.BytesIO):
    def __init__(self):
        super().__init__()
        self.flushes = 0

    def flush(self):
        self.flushes += 1
        return super().flush()


class FakeBatchProcess:
    def __init__(self, response: bytes, *, returncode: int = 0):
        self.stdin = FakeBatchInput()
        self.stdout = io.BytesIO(response)
        self.returncode = returncode
        self.terminated = False
        self.waited = False

    def poll(self):
        return self.returncode if self.waited else None

    def terminate(self):
        self.terminated = True

    def wait(self, **_kwargs):
        self.waited = True
        return self.returncode


class InterlockedBatchProcess:
    class Input:
        def __init__(self, owner):
            self.owner = owner
            self.buffer = b""
            self.closed = False

        def write(self, body):
            if self.owner.pending is not None:
                raise AssertionError("next OID sent before prior response drained")
            self.buffer += body
            return len(body)

        def flush(self):
            assert self.buffer.endswith(b"\n")
            oid = self.buffer[:-1]
            assert b"\n" not in oid
            self.buffer = b""
            body = self.owner.bodies[oid]
            self.owner.requests.append(oid)
            self.owner.pending = io.BytesIO(
                oid + b" blob " + str(len(body)).encode() + b"\n"
                + body + b"\n"
            )

        def close(self):
            self.closed = True

    class Output:
        def __init__(self, owner):
            self.owner = owner

        def _read(self, name, *args):
            if self.owner.pending is None:
                return b""
            value = getattr(self.owner.pending, name)(*args)
            if self.owner.pending.tell() == len(self.owner.pending.getvalue()):
                self.owner.pending = None
            return value

        def readline(self, *args):
            return self._read("readline", *args)

        def read(self, *args):
            return self._read("read", *args)

    def __init__(self, bodies):
        self.bodies = bodies
        self.requests = []
        self.pending = None
        self.stdin = self.Input(self)
        self.stdout = self.Output(self)
        self.waited = False
        self.terminated = False

    def poll(self):
        return 0 if self.waited else None

    def terminate(self):
        self.terminated = True

    def wait(self, **_kwargs):
        self.waited = True
        return 0


def git_object_oid(body: bytes) -> bytes:
    return hashlib.sha1(
        b"blob " + str(len(body)).encode("ascii") + b"\0" + body
    ).hexdigest().encode("ascii")


def fake_revision_materialization(
        tmp_path, monkeypatch, response: bytes, *,
        body: bytes = b"body\n", returncode: int = 0,
) -> tuple[Path, FakeBatchProcess, bytes]:
    oid = git_object_oid(body)
    inventory = revision_inventory_record(b"file.bin", oid=oid)
    process = FakeBatchProcess(response, returncode=returncode)
    monkeypatch.setattr(
        release.subprocess,
        "check_output",
        lambda *_args, **_kwargs: inventory,
    )
    monkeypatch.setattr(
        release.subprocess,
        "Popen",
        lambda *_args, **_kwargs: process,
    )
    destination = tmp_path / "protocol-snapshot"
    return destination, process, oid


@pytest.mark.parametrize("response_factory", [
    lambda oid, body: b"b" * 40 + b" blob 5\nbody\n\n",
    lambda oid, body: oid + b" missing\n",
    lambda oid, body: oid + b" tree 5\nbody\n\n",
    lambda oid, body: oid + b" blob bad\n",
    lambda oid, body: oid + b" blob -1\n",
    lambda oid, body: oid + b" blob 05\nbody\n\n",
    lambda oid, body: oid + b" blob 5",
    lambda oid, body: oid + b" blob 6\nbody\n",
    lambda oid, body: oid + b" blob 5\nbody\n",
    lambda oid, body: oid + b" blob 5\nbody\n\n\n",
    lambda oid, body: oid + b" blob 5\nother\n",
])
def test_revision_snapshot_rejects_malformed_batch_protocol(
        tmp_path, monkeypatch, response_factory):
    body = b"body\n"
    oid = git_object_oid(body)
    destination, process, _ = fake_revision_materialization(
        tmp_path,
        monkeypatch,
        response_factory(oid, body),
        body=body,
    )

    with pytest.raises(
            release.ReleaseError,
            match="^PRODUCTION_GRAPH_SOURCE_READ_FAILED$"):
        release.materialize_revision_snapshot(
            tmp_path, "a" * 40, destination)

    assert process.terminated
    assert process.waited
    assert not destination.exists()


@pytest.mark.parametrize(("extra", "returncode"), [
    (b"unexpected", 0),
    (b"", 7),
])
def test_revision_snapshot_rejects_extra_batch_output_or_nonzero_exit(
        tmp_path, monkeypatch, extra, returncode):
    body = b"body\n"
    oid = git_object_oid(body)
    response = oid + b" blob 5\n" + body + b"\n" + extra
    destination, process, _ = fake_revision_materialization(
        tmp_path,
        monkeypatch,
        response,
        body=body,
        returncode=returncode,
    )

    with pytest.raises(
            release.ReleaseError,
            match="^PRODUCTION_GRAPH_SOURCE_READ_FAILED$"):
        release.materialize_revision_snapshot(
            tmp_path, "a" * 40, destination)

    assert process.waited
    assert not destination.exists()


def test_revision_snapshot_requests_and_drains_each_blob_before_next_oid(
        tmp_path, monkeypatch):
    bodies = {
        git_object_oid(b"first"): b"first",
        git_object_oid(b"second\n"): b"second\n",
    }
    inventory = b"".join(
        revision_inventory_record(
            f"file-{index}.bin".encode(), oid=oid)
        for index, oid in enumerate(bodies, start=1)
    )
    process = InterlockedBatchProcess(bodies)
    monkeypatch.setattr(
        release.subprocess,
        "check_output",
        lambda *_args, **_kwargs: inventory,
    )
    monkeypatch.setattr(
        release.subprocess,
        "Popen",
        lambda *_args, **_kwargs: process,
    )
    destination = tmp_path / "interlocked-snapshot"

    release.materialize_revision_snapshot(
        tmp_path, "a" * 40, destination)

    assert process.requests == list(bodies)
    assert process.stdin.closed
    assert process.waited
    assert [
        (destination / f"file-{index}.bin").read_bytes()
        for index in (1, 2)
    ] == list(bodies.values())


def test_revision_snapshot_uses_exact_single_inventory_and_batch_commands(
        tmp_path, monkeypatch):
    body = b"body\n"
    oid = git_object_oid(body)
    inventory = revision_inventory_record(b"file.bin", oid=oid)
    process = FakeBatchProcess(
        oid + b" blob 5\n" + body + b"\n")
    commands = []

    def inventory_command(command, **kwargs):
        commands.append(("inventory", command, kwargs))
        return inventory

    def batch_command(command, **kwargs):
        commands.append(("batch", command, kwargs))
        return process

    monkeypatch.setattr(
        release.subprocess, "check_output", inventory_command)
    monkeypatch.setattr(release.subprocess, "Popen", batch_command)
    repo = tmp_path / "repo"
    destination = tmp_path / "command-snapshot"

    release.materialize_revision_snapshot(
        repo, "a" * 40, destination)

    assert commands == [
        (
            "inventory",
            [
                "git", "--no-replace-objects", "-C", str(repo),
                "ls-tree", "-r", "-z", "--full-tree", "a" * 40,
            ],
            {"stderr": subprocess.DEVNULL},
        ),
        (
            "batch",
            [
                "git", "--no-replace-objects", "-C", str(repo),
                "cat-file", "--batch",
            ],
            {
                "stdin": subprocess.PIPE,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.DEVNULL,
            },
        ),
    ]


def test_revision_snapshot_batch_launch_failure_is_source_read_and_cleans(
        tmp_path, monkeypatch):
    monkeypatch.setattr(
        release.subprocess,
        "check_output",
        lambda *_args, **_kwargs: revision_inventory_record(b"file.bin"),
    )
    monkeypatch.setattr(
        release.subprocess,
        "Popen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("cat-file unavailable")),
    )
    destination = tmp_path / "launch-failure-snapshot"

    with pytest.raises(
            release.ReleaseError,
            match="^PRODUCTION_GRAPH_SOURCE_READ_FAILED$"):
        release.materialize_revision_snapshot(
            tmp_path, "a" * 40, destination)

    assert not destination.exists()


@pytest.mark.parametrize("kind", ["file", "directory", "symlink"])
def test_revision_snapshot_never_replaces_preexisting_destination(
        tmp_path, kind):
    repo, revision = hostile_revision_snapshot_repo(tmp_path)
    destination = tmp_path / "preexisting"
    if kind == "file":
        destination.write_bytes(b"sentinel")
    elif kind == "directory":
        destination.mkdir()
        (destination / "sentinel").write_bytes(b"sentinel")
    else:
        target = tmp_path / "symlink-target"
        target.write_bytes(b"sentinel")
        try:
            destination.symlink_to(target)
        except OSError as exc:
            pytest.skip(f"symlink unavailable: {exc}")

    with pytest.raises(
            release.ReleaseError,
            match="^REVISION_SNAPSHOT_WRITE_FAILED$"):
        release.materialize_revision_snapshot(repo, revision, destination)

    if kind == "file":
        assert destination.read_bytes() == b"sentinel"
    elif kind == "directory":
        assert (destination / "sentinel").read_bytes() == b"sentinel"
    else:
        assert destination.is_symlink()
        assert destination.read_bytes() == b"sentinel"


def test_revision_snapshot_chmod_failure_cleans_only_created_destination(
        tmp_path, monkeypatch):
    body = b"body\n"
    oid = git_object_oid(body)
    response = oid + b" blob 5\n" + body + b"\n"
    destination, process, _ = fake_revision_materialization(
        tmp_path, monkeypatch, response, body=body)
    neighbor = tmp_path / "neighbor"
    neighbor.write_bytes(b"keep")
    monkeypatch.setattr(
        release.os,
        "fchmod",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("chmod denied")),
    )

    with pytest.raises(
            release.ReleaseError,
            match="^REVISION_SNAPSHOT_WRITE_FAILED$"):
        release.materialize_revision_snapshot(
            tmp_path, "a" * 40, destination)

    assert process.waited
    assert not destination.exists()
    assert neighbor.read_bytes() == b"keep"


def test_revision_snapshot_rejects_impossible_local_write_count_and_cleans(
        tmp_path, monkeypatch):
    body = b"body\n"
    oid = git_object_oid(body)
    response = oid + b" blob 5\n" + body + b"\n"
    destination, process, _ = fake_revision_materialization(
        tmp_path, monkeypatch, response, body=body)
    monkeypatch.setattr(
        release.os,
        "write",
        lambda _descriptor, chunk: len(chunk) + 1,
    )

    with pytest.raises(
            release.ReleaseError,
            match="^REVISION_SNAPSHOT_WRITE_FAILED$"):
        release.materialize_revision_snapshot(
            tmp_path, "a" * 40, destination)

    assert process.terminated
    assert process.waited
    assert not destination.exists()


def test_revision_snapshot_mid_write_failure_cleans_partial_file_and_root(
        tmp_path, monkeypatch):
    body = b"body\n"
    oid = git_object_oid(body)
    response = oid + b" blob 5\n" + body + b"\n"
    destination, process, _ = fake_revision_materialization(
        tmp_path, monkeypatch, response, body=body)
    real_write = release.os.write
    writes = 0

    def partial_then_fail(descriptor, chunk):
        nonlocal writes
        writes += 1
        if writes == 1:
            return real_write(descriptor, bytes(chunk[:2]))
        raise OSError("disk write failed")

    monkeypatch.setattr(release.os, "write", partial_then_fail)

    with pytest.raises(
            release.ReleaseError,
            match="^REVISION_SNAPSHOT_WRITE_FAILED$"):
        release.materialize_revision_snapshot(
            tmp_path, "a" * 40, destination)

    assert writes == 2
    assert process.terminated
    assert process.waited
    assert not destination.exists()


def test_revision_snapshot_cleanup_failure_preserves_primary_and_adds_note(
        tmp_path, monkeypatch):
    body = b"body\n"
    oid = git_object_oid(body)
    response = oid + b" blob 5\n" + body + b"\n"
    destination, _process, _ = fake_revision_materialization(
        tmp_path, monkeypatch, response, body=body)
    monkeypatch.setattr(
        release.os,
        "fchmod",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("chmod denied")),
    )
    monkeypatch.setattr(
        release.shutil,
        "rmtree",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("cleanup denied")),
    )

    with pytest.raises(release.ReleaseError) as caught:
        release.materialize_revision_snapshot(
            tmp_path, "a" * 40, destination)

    assert caught.value.args == ("REVISION_SNAPSHOT_WRITE_FAILED",)
    assert "REVISION_SNAPSHOT_CLEANUP_FAILED" in getattr(
        caught.value, "__notes__", [])


def revision_builder_cleanup_fixture(tmp_path, monkeypatch, *, builder_fails):
    inputs = tmp_path / "inputs.json"
    inputs.write_text(json.dumps({
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
    }))
    output = tmp_path / "release"

    def materializer(_repo, _revision, destination):
        builder = (
            destination
            / "flock-voice-engine/tools/build_release_artifact.py"
        )
        builder.parent.mkdir(parents=True)
        builder.write_bytes(b"builder")
        return destination

    def runner(*args, capture=False):
        if args[:3] == ("git", "--no-replace-objects", "-C"):
            return "a" * 40
        if args[0] == sys.executable:
            if builder_fails:
                raise ValueError("builder failed")
            return ""
        raise AssertionError(args)

    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(
        release, "materialize_revision_snapshot", materializer)
    monkeypatch.setattr(
        release.shutil,
        "rmtree",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("cleanup denied")),
    )
    args = type("A", (), {"inputs": str(inputs), "output": str(output)})()
    return args, runner


def test_builder_revision_snapshot_cleanup_does_not_mask_builder_failure(
        tmp_path, monkeypatch):
    args, runner = revision_builder_cleanup_fixture(
        tmp_path, monkeypatch, builder_fails=True)

    with pytest.raises(ValueError, match="builder failed") as caught:
        release.build_local(
            args, repo_root=tmp_path, command_runner=runner)

    assert "REVISION_SNAPSHOT_CLEANUP_FAILED" in getattr(
        caught.value, "__notes__", [])


def test_builder_revision_snapshot_cleanup_failure_is_explicit_after_success(
        tmp_path, monkeypatch):
    args, runner = revision_builder_cleanup_fixture(
        tmp_path, monkeypatch, builder_fails=False)

    with pytest.raises(
            release.ReleaseError,
            match="^REVISION_SNAPSHOT_CLEANUP_FAILED$"):
        release.build_local(
            args, repo_root=tmp_path, command_runner=runner)


def test_revision_materializers_share_helper_and_do_not_invoke_git_archive():
    consumer_sources = {
        "production_graph_from_revision":
            inspect.getsource(release.production_graph_from_revision),
        "build_local": inspect.getsource(release.build_local),
    }
    helper_source = inspect.getsource(release.materialize_revision_snapshot)

    for consumer, source in consumer_sources.items():
        direct_shared_calls = [
            node
            for node in ast.walk(ast.parse(source))
            if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "materialize_revision_snapshot")
        ]
        assert len(direct_shared_calls) == 1, consumer
        assert '"archive"' not in source
        assert "'archive'" not in source
    assert '"archive"' not in helper_source
    assert "'archive'" not in helper_source


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
        self.git_state_calls = []

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
        prefix = ("git", "--no-replace-objects", "-C", str(self.repo))
        if args == (*prefix, "rev-parse", "HEAD"):
            self.git_state_calls.append(args)
            revision = subprocess.check_output(args, text=True).strip()
            if not self.injected:
                self.inject_hidden_b_worktree()
                self.injected = True
            return revision
        if args == (
                *prefix, "status", "--porcelain", "--untracked-files=no"):
            self.git_state_calls.append(args)
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
        "flock-voice-engine/runtime/tools/legacy-lease.mjs",
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
        npm_command = trusted_windows_npm_command()

        def windows_npm(command, **kwargs):
            assert command[:2] == ["npm", "ci"]
            return subprocess.run(
                [*npm_command, "ci", "--offline", *command[2:]],
                **kwargs,
            )

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
    lease_tool = output / "deploy/legacy-lease.mjs"
    assert lease_tool.read_bytes() == git_blob(
        repo, revision_a, "flock-voice-engine/runtime/tools/legacy-lease.mjs")
    assert manifest["deployExecutionIdentity"]["legacy-lease.mjs"] == release.sha(
        lease_tool)


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


def test_local_scope_ignores_ssh_transport_metadata(monkeypatch):
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setenv(
        "SSH_CONNECTION",
        "192.168.9.10 52144 192.168.9.140 22",
    )
    monkeypatch.setenv(
        "SSH_CLIENT",
        "192.168.9.10 52144 22",
    )
    monkeypatch.delenv("DOCKER_HOST", raising=False)
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)
    monkeypatch.delenv("DOCKER_TLS_VERIFY", raising=False)
    monkeypatch.delenv("DOCKER_CERT_PATH", raising=False)
    monkeypatch.setattr(release.sys, "argv", [
        "release_control.py",
        "stage-local",
        "--release-dir",
        "/tmp/flock-candidate",
    ])

    release.require_local_scope("/tmp/flock-candidate")


def test_local_scope_pins_every_docker_child_to_the_local_engine(
        monkeypatch):
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setenv("DOCKER_CONFIG", "/tmp/remote-active-context")
    monkeypatch.delenv("DOCKER_HOST", raising=False)
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)
    monkeypatch.delenv("DOCKER_TLS_VERIFY", raising=False)
    monkeypatch.delenv("DOCKER_CERT_PATH", raising=False)
    monkeypatch.setattr(release.sys, "argv", [
        "release_control.py",
        "stage-local",
        "--release-dir",
        "/tmp/flock-candidate",
    ])

    release.require_local_scope("/tmp/flock-candidate")

    assert release.os.environ["DOCKER_HOST"] == (
        "unix:///var/run/docker.sock"
    )
    assert "DOCKER_CONTEXT" not in release.os.environ
    assert "DOCKER_TLS_VERIFY" not in release.os.environ
    assert "DOCKER_CERT_PATH" not in release.os.environ


@pytest.mark.parametrize(
    "name,value",
    (
        ("DOCKER_HOST", "ssh://yfhuang@192.168.9.140"),
        ("DOCKER_HOST", "tcp://127.0.0.1:2375"),
        ("DOCKER_HOST", "https://docker.example.invalid"),
        ("DOCKER_HOST", "unix:///tmp/alternate-docker.sock"),
        ("DOCKER_CONTEXT", "remote-spark"),
        ("DOCKER_TLS_VERIFY", "1"),
        ("DOCKER_CERT_PATH", "/tmp/client-certificates"),
    ),
)
def test_local_scope_rejects_explicit_remote_docker_target(
        monkeypatch, name, value):
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    for key in (
            "DOCKER_HOST", "DOCKER_CONTEXT",
            "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv(name, value)
    monkeypatch.setattr(release.sys, "argv", [
        "release_control.py",
        "stage-local",
        "--release-dir",
        "/tmp/flock-candidate",
    ])

    with pytest.raises(
            release.ReleaseError,
            match="PRODUCTION_TARGET_REJECTED"):
        release.require_local_scope("/tmp/flock-candidate")


@pytest.mark.parametrize(
    "target",
    (
        "/srv/deploy/flock-voice-engine",
        "http://192.168.9.140:8090",
        "0.0.0.0:8090:8090",
    ),
)
def test_local_scope_rejects_explicit_production_target(
        monkeypatch, target):
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    for key in (
            "DOCKER_HOST", "DOCKER_CONTEXT",
            "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(
        release.sys, "argv", ["release_control.py"])

    with pytest.raises(
            release.ReleaseError,
            match="PRODUCTION_TARGET_REJECTED"):
        release.require_local_scope(target)


@pytest.mark.parametrize("field,value", [("digest", "latest"), ("digest", "sha256:bad"),
                                           ("repository", "node:latest")])
def test_mutable_or_missing_base_image_is_rejected(tmp_path, field, value):
    inputs = {"baseImages": {name: {"repository": f"example/{name}", "digest": "sha256:" + name[0] * 64}
                             for name in ("runtime", "audio")}}
    inputs["baseImages"]["runtime"][field] = value
    path = tmp_path / "inputs.json"; path.write_text(json.dumps(inputs))
    with pytest.raises(release.ReleaseError, match="BASE_IMAGE_DIGEST_INVALID"):
        release.validate_base_images(path)


class FakePhase5Attempt:
    def __init__(self, registry_root, attempt_id, events):
        self.bootstrap_bind_source = (
            registry_root / attempt_id / "run-flock-phase5-bootstrap"
        )
        self.candidate_bind_source = (
            registry_root / attempt_id / "run-flock-phase5-candidate"
        )
        self.intent_sha256 = "d" * 64
        self.events = events

    def close(self):
        self.events.append(("attempt-close",))


class FakePhase5Bootstrap:
    def __init__(self, identity, events, *, fail_complete=False):
        self.identity = copy.deepcopy(identity)
        self.events = events
        self.fail_complete = fail_complete

    def complete(self, expected_pid, expected_uid, commit_admission):
        self.events.append(("bootstrap-complete", expected_pid, expected_uid))
        if self.fail_complete:
            raise release.ReleaseError("BOOTSTRAP_FAILED")
        admission_raw = b"trusted admission\n"
        result = commit_admission(
            admission_raw=admission_raw,
            candidate_pid=expected_pid,
            candidate_uid=expected_uid,
            expected_identity=copy.deepcopy(self.identity),
        )
        assert result == {
            "admissionSha256": hashlib.sha256(admission_raw).hexdigest(),
        }

    def close(self):
        self.events.append(("bootstrap-close",))


class FakePhase5Cidfiles:
    def __init__(self, candidate):
        self.audio_cidfile = candidate.parent / "audio.cid"
        self.runtime_cidfile = candidate.parent / "runtime.cid"
        self.closed = False

    def close(self):
        self.closed = True


def fake_phase5_stage_controller(events, *, fail_complete=False):
    def create_attempt(
            registry_root, attempt_id, release_manifest_sha256,
            controller_uid, controller_gid):
        events.append((
            "attempt-create",
            registry_root,
            attempt_id,
            release_manifest_sha256,
            controller_uid,
            controller_gid,
        ))
        return FakePhase5Attempt(registry_root, attempt_id, events)

    def prepare_bootstrap(bootstrap_directory, expected_identity):
        events.append((
            "bootstrap-prepare",
            bootstrap_directory,
            copy.deepcopy(expected_identity),
        ))
        return FakePhase5Bootstrap(
            expected_identity,
            events,
            fail_complete=fail_complete,
        )

    def commit_admission(**values):
        events.append(("admission-commit", copy.deepcopy(values)))
        return SimpleNamespace(
            admission_sha256=hashlib.sha256(
                values["admission_raw"]
            ).hexdigest(),
        )

    return SimpleNamespace(
        create_phase5_candidate_attempt=create_attempt,
        prepare_phase5_candidate_bootstrap_linux=prepare_bootstrap,
        commit_phase5_candidate_admission=commit_admission,
    )


def test_candidate_controller_is_loaded_only_from_verified_release_bytes(
        tmp_path):
    candidate = manifest_dir(tmp_path)
    manifest = release.manifest_pair(candidate)
    sources = release._verified_phase5_candidate_controller_sources(
        candidate, manifest)

    controller = release._load_phase5_candidate_controller_sources(
        sources)

    assert set(sources) == {
        "phase5_candidate_attempt.py",
        "phase5_candidate_bootstrap.py",
    }
    assert all(
        callable(getattr(controller, name))
        for name in (
            "create_phase5_candidate_attempt",
            "prepare_phase5_candidate_bootstrap_linux",
            "commit_phase5_candidate_admission",
        )
    )
    source = inspect.getsource(release)
    assert "import phase5_candidate_attempt" not in source
    assert "import phase5_candidate_bootstrap" not in source


def test_stage_controller_anchor_yields_authoritative_linux_attempt():
    if sys.platform != "linux":
        pytest.skip("Linux dirfd authority is required")
    with tempfile.TemporaryDirectory(
            prefix="p5c-", dir="/tmp") as temporary:
        candidate = manifest_dir(Path(temporary))
        manifest = release.manifest_pair(candidate)
        controller = release._load_phase5_candidate_controller_sources(
            release._verified_phase5_candidate_controller_sources(
                candidate, manifest)
        )
        registry_root = release._phase5_candidate_registry_root(
            candidate)
        layout = controller.create_phase5_candidate_attempt(
            registry_root,
            "1" * 32,
            release.sha(candidate / "release-manifest.json"),
            os.geteuid(),
            os.getegid(),
        )
        try:
            assert layout.authoritative is True
            assert registry_root == (
                candidate.parent
                / ".p5c"
                / "a"
            )
            assert candidate not in registry_root.parents
            anchor = registry_root.parent
            assert stat.S_IMODE(anchor.stat().st_mode) == 0o700
            assert anchor.stat().st_uid == os.geteuid()
            assert anchor.stat().st_gid == os.getegid()
        finally:
            layout.close()


def test_stage_composes_real_linux_bootstrap_and_attempt_without_docker(
        monkeypatch):
    if sys.platform != "linux":
        pytest.skip("Linux UDS and SO_PEERCRED authority are required")
    child_source = r"""
import base64
import hashlib
import json
import os
import socket
import stat
import sys

def canonical(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")

bootstrap_socket, capture_socket, spki_base64 = sys.argv[1:]
capture = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
capture.bind(capture_socket)
os.chmod(capture_socket, 0o600)
capture.listen(1)
state = os.lstat(capture_socket)
assert stat.S_ISSOCK(state.st_mode)
assert stat.S_IMODE(state.st_mode) == 0o600

channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
channel.connect(bootstrap_socket)
request_raw = b""
while not request_raw.endswith(b"\n"):
    request_raw += channel.recv(4096)
request = json.loads(request_raw)
assert request_raw == canonical(request) + b"\n"
spki = base64.b64decode(spki_base64)
admission = {
    "schemaVersion": 1,
    "kind": "phase5-candidate-capture-admission",
    "runId": request["identity"]["runId"],
    "challenge": request["identity"]["challenge"],
    "captureNonce": request["captureNonce"],
    "signerSpkiSha256": hashlib.sha256(spki).hexdigest(),
    "trustedSignerSpkiDerBase64": spki_base64,
}
admission_raw = canonical(admission) + b"\n"
channel.sendall(admission_raw)
ack_raw = b""
while not ack_raw.endswith(b"\n"):
    chunk = channel.recv(4096)
    assert chunk
    ack_raw += chunk
ack = json.loads(ack_raw)
assert ack_raw == canonical(ack) + b"\n"
receipt = {
    "schemaVersion": 1,
    "kind": "phase5-candidate-capture-admission-receipt",
    "admissionSha256": hashlib.sha256(admission_raw).hexdigest(),
    "receiptChallenge": ack["receiptChallenge"],
}
channel.sendall(canonical(receipt) + b"\n")
channel.close()
capture.close()
"""
    spki_base64 = (
        "MCowBQYDK2VwAyEAb0aAWQv8xav2fgaG1jjaMotHemDd5XS/HGup0cz1cMI="
    )
    runtime_id = "b" * 64
    audio_id = "a" * 64
    process = None
    with tempfile.TemporaryDirectory(
            prefix="p5s-", dir="/tmp") as temporary:
        candidate = manifest_dir(Path(temporary))
        monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")

        def fake_run(*args, **kwargs):
            nonlocal process
            if args[:3] == ("docker", "image", "inspect"):
                return "sha256:" + "1" * 64
            if args[:2] == ("docker", "run"):
                assert kwargs == {"capture": True}
                cidfile = Path(
                    args[args.index("--cidfile") + 1])
                if "flock-audio-candidate" in args:
                    cidfile.write_text(audio_id + "\n")
                    return audio_id
                cidfile.write_text(runtime_id + "\n")
                bootstrap_mount = next(
                    value for value in args
                    if isinstance(value, str)
                    and "dst=/run/flock-phase5-bootstrap" in value
                )
                candidate_mount = next(
                    value for value in args
                    if isinstance(value, str)
                    and "dst=/run/flock-phase5-candidate" in value
                )
                bootstrap_source = bootstrap_mount.split(
                    "src=", 1)[1].split(",dst=", 1)[0]
                candidate_source = candidate_mount.split(
                    "src=", 1)[1].split(",dst=", 1)[0]
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        child_source,
                        str(Path(bootstrap_source) / "bootstrap.sock"),
                        str(Path(candidate_source) / "capture.sock"),
                        spki_base64,
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                return runtime_id
            if args[:4] == (
                    "docker", "container", "inspect", "--format"):
                assert args[5] == runtime_id
                assert process is not None
                if args[4] == "{{.State.Pid}}":
                    return str(process.pid)
                if args[4] == "{{.Config.User}}":
                    return f"{os.geteuid()}:{os.getegid()}"
            raise AssertionError((args, kwargs))

        def fake_subprocess_run(args, **kwargs):
            assert tuple(args)[:3] == (
                "docker", "container", "inspect")
            return SimpleNamespace(returncode=1)

        monkeypatch.setattr(release, "run", fake_run)
        monkeypatch.setattr(
            release.subprocess, "run", fake_subprocess_run)

        try:
            release.stage_local(
                type("A", (), {"release_dir": str(candidate)})()
            )

            assert process is not None
            stdout, stderr = process.communicate(timeout=5)
            assert process.returncode == 0
            assert stdout == b""
            assert stderr == b""
            records = list(
                (candidate.parent / ".p5c" / "a").glob(
                    "*/admission.json")
            )
            assert len(records) == 1
            record = json.loads(records[0].read_bytes())
            assert record["candidate"] == {
                "containerId": runtime_id,
                "pid": process.pid,
                "uid": os.geteuid(),
            }
            assert record["identity"]["release"][
                "releaseManifestSha256"
            ] == release.sha(
                candidate / "release-manifest.json")
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)


def test_stage_controller_registry_preserves_linux_uds_path_budget(
        monkeypatch):
    created = []
    monkeypatch.setattr(
        release.os,
        "mkdir",
        lambda path, mode: created.append((path, mode)),
    )

    registry_root = release._phase5_candidate_registry_root(
        Path("/srv/deploy/release-candidate"))

    assert registry_root == Path("/srv/deploy/.p5c/a")
    assert created == [(Path("/srv/deploy/.p5c"), 0o700)]
    bootstrap_socket = (
        registry_root
        / ("f" * 32)
        / "run-flock-phase5-bootstrap"
        / "bootstrap.sock"
    )
    assert len(os.fsencode(bootstrap_socket)) <= 107


def test_stage_controller_registry_rejects_exhausted_uds_budget_before_create(
        monkeypatch):
    created = []
    monkeypatch.setattr(
        release.os,
        "mkdir",
        lambda path, mode: created.append((path, mode)),
    )
    release_dir = (
        Path("/srv/deploy")
        / ("nonascii-长路径-" * 12)
        / "release-candidate"
    )

    with pytest.raises(
            release.ReleaseError,
            match="PHASE5_BOOTSTRAP_SOCKET_PATH_TOO_LONG"):
        release._phase5_candidate_registry_root(release_dir)

    assert created == []


def install_fake_phase5_stage(
        candidate, monkeypatch, events, *, fail_complete=False,
        cleanup_returncodes=(), cid_behaviors=None):
    controller_uid = 1004
    controller_gid = 1004
    audio_id = "a" * 64
    runtime_id = "b" * 64
    cleanup_codes = iter(cleanup_returncodes)
    cid_behaviors = dict(cid_behaviors or {})
    controller = fake_phase5_stage_controller(
        events,
        fail_complete=fail_complete,
    )
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(
        release,
        "_load_phase5_candidate_controller_sources",
        lambda _sources: controller,
        raising=False,
    )
    monkeypatch.setattr(
        release,
        "_effective_controller_ids",
        lambda: (controller_uid, controller_gid),
        raising=False,
    )
    monkeypatch.setattr(
        release,
        "_phase5_candidate_registry_root",
        lambda _release_dir: candidate.parent / ".p5c" / "a",
    )
    cidfiles = FakePhase5Cidfiles(candidate)
    monkeypatch.setattr(
        release,
        "_create_phase5_candidate_cidfile_layout",
        lambda *_args: cidfiles,
        raising=False,
    )
    monkeypatch.setattr(
        release,
        "container_user",
        lambda: f"{controller_uid}:{controller_gid}",
    )

    def fake_run(*args, **kwargs):
        events.append(("run", args, dict(kwargs)))
        if args[:3] == ("docker", "image", "inspect"):
            return "sha256:" + "1" * 64
        if args[:4] == (
                "docker", "container", "inspect", "--format"):
            if args[4] == "{{.State.Pid}}":
                assert args[5] == runtime_id
                return "4242"
            if args[4] == "{{.Config.User}}":
                assert args[5] == runtime_id
                return f"{controller_uid}:{controller_gid}"
        if args[:2] == ("docker", "run"):
            assert kwargs == {"capture": True}
            role = (
                "audio"
                if "flock-audio-candidate" in args
                else "runtime"
            )
            container_id = (
                audio_id if role == "audio" else runtime_id
            )
            assert "--cidfile" in args
            cidfile = Path(args[args.index("--cidfile") + 1])
            assert cidfile == getattr(
                cidfiles, f"{role}_cidfile")
            behavior = cid_behaviors.get(role, "success")
            if behavior == "old":
                raise AssertionError(
                    "docker run reached a pre-existing cidfile")
            cidfile.write_bytes(
                b"partial"
                if behavior == "partial"
                else f"{container_id}\n".encode("ascii")
            )
            if behavior in {"command-failure", "partial"}:
                raise release.ReleaseError("COMMAND_FAILED")
            if behavior == "malformed-stdout":
                return "not-a-container-id"
            return container_id
        raise AssertionError((args, kwargs))

    def fake_subprocess_run(args, **kwargs):
        command = tuple(args)
        events.append(("subprocess", command, dict(kwargs)))
        if command[:3] == ("docker", "container", "inspect"):
            return SimpleNamespace(returncode=1)
        if command[:3] == ("docker", "rm", "-f"):
            return SimpleNamespace(returncode=next(cleanup_codes, 0))
        raise AssertionError((args, kwargs))

    monkeypatch.setattr(release, "run", fake_run)
    monkeypatch.setattr(release.subprocess, "run", fake_subprocess_run)
    return (
        controller_uid,
        controller_gid,
        audio_id,
        runtime_id,
    )


@linux_release_security
def test_stage_has_gpu_only_on_audio_loopback_publish_and_shared_uds(tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    events = []
    _uid, _gid, _audio_id, _runtime_id = install_fake_phase5_stage(
        candidate,
        monkeypatch,
        events,
    )
    release.stage_local(type("A", (), {"release_dir": str(candidate)})())
    calls = [
        event[1]
        for event in events
        if event[0] == "run"
    ]
    audio, runtime = [call for call in calls if call[:2] == ("docker", "run")]
    assert "--gpus" in audio and "--publish" not in audio
    assert "--user" in audio and "--user" in runtime
    assert "--gpus" not in runtime
    assert runtime[runtime.index("--publish") + 1] == "127.0.0.1:18090:8090"
    assert "FLOCK_RUNTIME_PROFILE=container-local" in runtime
    assert any("dst=/run/flock-audio" in arg for arg in audio)
    assert any("dst=/run/flock-audio" in arg for arg in runtime)
    attempt = next(
        event for event in events
        if event[0] == "attempt-create"
    )
    prepared = next(
        event for event in events
        if event[0] == "bootstrap-prepare"
    )
    assert attempt[1] == (
        candidate.parent / ".p5c" / "a"
    )
    assert re.fullmatch(r"[0-9a-f]{32}", attempt[2])
    assert attempt[3] == release.sha(candidate / "release-manifest.json")
    assert prepared[1] == str(
        attempt[1] / attempt[2] / "run-flock-phase5-bootstrap"
    )
    assert events.index(prepared) < next(
        index
        for index, event in enumerate(events)
        if event[0] == "run" and event[1][:2] == ("docker", "run")
    )
    assert (
        "type=bind,"
        f"src={prepared[1]},"
        "dst=/run/flock-phase5-bootstrap,readonly"
    ) in runtime
    assert any(
        argument
        == (
            "type=bind,"
            f"src={attempt[1] / attempt[2] / 'run-flock-phase5-candidate'},"
            "dst=/run/flock-phase5-candidate"
        )
        for argument in runtime
    )
    lease_mounts = [
        arg for arg in runtime
        if isinstance(arg, str) and "dst=/app/flock-voice-engine/runtime/legacy-lease.mjs" in arg
    ]
    assert lease_mounts == []
    assert not any(
        isinstance(arg, str) and "legacy-lease.mjs" in arg
        for arg in audio
    )
    assert stat.S_IMODE((candidate / "run-flock-audio").stat().st_mode) == 0o770
    state = json.loads((candidate / "rollback-state.json").read_text())
    assert state["previousState"] == "absent" and state["kind"] == "reset"
    removals = []
    monkeypatch.setattr(release.subprocess, "run", lambda args, **kwargs: (
        removals.append(args) or type("R", (), {"returncode": 0})()))
    release.rollback(type("A", (), {"release_dir": str(candidate)})())
    assert [args[-1] for args in removals] == list(release.LOCAL_CONTAINERS)


def test_stage_binds_exact_identity_and_commits_the_inspected_runtime(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    events = []
    uid, gid, _audio_id, runtime_id = install_fake_phase5_stage(
        candidate,
        monkeypatch,
        events,
    )

    release.stage_local(type("A", (), {"release_dir": str(candidate)})())

    attempt = next(
        event for event in events if event[0] == "attempt-create"
    )
    identity = next(
        event[2] for event in events
        if event[0] == "bootstrap-prepare"
    )
    manifest = release.manifest_pair(candidate)
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-"
        r"[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        identity["runId"],
    )
    assert re.fullmatch(r"[0-9a-f]{64}", identity["challenge"])
    assert identity["release"] == {
        "releaseManifestSha256":
            release.sha(candidate / "release-manifest.json"),
        "releaseRevision": manifest["workerIdentity"]["releaseRevision"],
        "sourceManifestSha256":
            manifest["workerIdentity"]["sourceManifestSha256"],
        "audioArtifactSha256":
            manifest["workerIdentity"]["audioArtifactSha256"],
    }
    assert identity["geometry"] == manifest["geometry"]
    assert identity["profile"] == {
        "clients": 4,
        "slowClient": 4,
        "durationMinutes": 30,
        "speciesEndpoint": "http://127.0.0.1:8081/v1",
        "speciesModel": "bird_agent",
    }
    assert attempt[4:] == (uid, gid)
    assert ("bootstrap-complete", 4242, uid) in events
    committed = next(
        event[1] for event in events
        if event[0] == "admission-commit"
    )
    assert committed["attempt"] is not None
    assert committed["expected_intent_sha256"] == "d" * 64
    assert committed["candidate_container_id"] == runtime_id
    assert committed["candidate_pid"] == 4242
    assert committed["candidate_uid"] == uid
    assert committed["expected_identity"] == identity
    assert events[-2:] == [
        ("bootstrap-close",),
        ("attempt-close",),
    ]


@pytest.mark.parametrize(
    "controller_name",
    ["phase5_candidate_attempt.py", "phase5_candidate_bootstrap.py"],
)
def test_stage_rejects_untrusted_candidate_controller_before_any_side_effect(
        tmp_path, monkeypatch, controller_name):
    candidate = manifest_dir(tmp_path)
    (candidate / "deploy" / controller_name).write_text("tampered\n")
    events = []
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(
        release,
        "_load_phase5_candidate_controller_sources",
        lambda _sources: (_ for _ in ()).throw(
            AssertionError("unverified controller reached loader")
        ),
        raising=False,
    )
    monkeypatch.setattr(
        release,
        "run",
        lambda *args, **kwargs: events.append(("run", args, kwargs)),
    )
    monkeypatch.setattr(
        release.subprocess,
        "run",
        lambda *args, **kwargs: events.append(
            ("subprocess", args, kwargs)
        ),
    )

    with pytest.raises(
            release.ReleaseError,
            match="DEPLOY_EXECUTION_DIGEST_MISMATCH"):
        release.stage_local(
            type("A", (), {"release_dir": str(candidate)})()
        )

    assert events == []
    assert not (candidate / "rollback-state.json").exists()
    assert not (candidate / "run-flock-audio").exists()


def test_stage_failure_closes_handles_and_cleans_exact_ids_runtime_first(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    events = []
    _uid, _gid, audio_id, runtime_id = install_fake_phase5_stage(
        candidate,
        monkeypatch,
        events,
        fail_complete=True,
    )

    with pytest.raises(release.ReleaseError, match="BOOTSTRAP_FAILED"):
        release.stage_local(
            type("A", (), {"release_dir": str(candidate)})()
        )

    assert ("bootstrap-close",) in events
    assert ("attempt-close",) in events
    removals = [
        event[1]
        for event in events
        if event[0] == "subprocess"
        and event[1][:3] == ("docker", "rm", "-f")
    ]
    assert removals == [
        ("docker", "rm", "-f", runtime_id),
        ("docker", "rm", "-f", audio_id),
    ]
    assert all(
        command[-1] not in release.LOCAL_CONTAINERS
        for command in removals
    )


def test_stage_reports_cleanup_failure_without_hiding_primary_failure(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    events = []
    install_fake_phase5_stage(
        candidate,
        monkeypatch,
        events,
        fail_complete=True,
        cleanup_returncodes=(1, 0),
    )

    with pytest.raises(
            release.ReleaseError,
            match="BOOTSTRAP_FAILED.*PARTIAL_STAGE_CLEANUP_FAILED"):
        release.stage_local(
            type("A", (), {"release_dir": str(candidate)})()
        )


def test_stage_recovers_audio_id_from_cidfile_after_run_command_failure(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    events = []
    _uid, _gid, audio_id, _runtime_id = install_fake_phase5_stage(
        candidate,
        monkeypatch,
        events,
        cid_behaviors={"audio": "command-failure"},
    )

    with pytest.raises(release.ReleaseError, match="COMMAND_FAILED"):
        release.stage_local(
            type("A", (), {"release_dir": str(candidate)})()
        )

    removals = [
        event[1]
        for event in events
        if event[0] == "subprocess"
        and event[1][:3] == ("docker", "rm", "-f")
    ]
    assert removals == [("docker", "rm", "-f", audio_id)]


def test_stage_recovers_runtime_cidfile_when_stdout_is_malformed(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    events = []
    _uid, _gid, audio_id, runtime_id = install_fake_phase5_stage(
        candidate,
        monkeypatch,
        events,
        cid_behaviors={"runtime": "malformed-stdout"},
    )

    with pytest.raises(
            release.ReleaseError,
            match="CANDIDATE_CONTAINER_ID_INVALID"):
        release.stage_local(
            type("A", (), {"release_dir": str(candidate)})()
        )

    removals = [
        event[1]
        for event in events
        if event[0] == "subprocess"
        and event[1][:3] == ("docker", "rm", "-f")
    ]
    assert removals == [
        ("docker", "rm", "-f", runtime_id),
        ("docker", "rm", "-f", audio_id),
    ]


def test_stage_rejects_preexisting_cidfile_before_docker_run(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    events = []
    install_fake_phase5_stage(
        candidate,
        monkeypatch,
        events,
        cid_behaviors={"audio": "old"},
    )
    (candidate.parent / "audio.cid").write_text(
        "f" * 64 + "\n")

    with pytest.raises(
            release.ReleaseError,
            match="CANDIDATE_CIDFILE_PREEXISTING"):
        release.stage_local(
            type("A", (), {"release_dir": str(candidate)})()
        )

    assert not any(
        event[0] == "run"
        and event[1][:2] == ("docker", "run")
        for event in events
    )


def test_stage_never_uses_partial_cidfile_as_cleanup_authority(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    events = []
    install_fake_phase5_stage(
        candidate,
        monkeypatch,
        events,
        cid_behaviors={"audio": "partial"},
    )

    with pytest.raises(
            release.ReleaseError,
            match="COMMAND_FAILED.*CANDIDATE_CIDFILE_INVALID"):
        release.stage_local(
            type("A", (), {"release_dir": str(candidate)})()
        )

    assert not any(
        event[0] == "subprocess"
        and event[1][:3] == ("docker", "rm", "-f")
        for event in events
    )


@pytest.mark.parametrize("mutation", ["missing", "tampered"])
def test_stage_rejects_untrusted_lease_tool_before_any_side_effect(
        tmp_path, monkeypatch, mutation):
    candidate = manifest_dir(tmp_path)
    tool = candidate / "deploy/legacy-lease.mjs"
    if mutation == "missing":
        tool.unlink()
    else:
        tool.write_text("tampered")
    calls = []
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(release, "run", lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(
        release.subprocess,
        "run",
        lambda *args, **kwargs: calls.append(args) or type("R", (), {"returncode": 1})(),
    )

    with pytest.raises(release.ReleaseError, match="DEPLOY_EXECUTION_DIGEST_MISMATCH"):
        release.stage_local(type("A", (), {"release_dir": str(candidate)})())

    assert calls == []
    assert not (candidate / "rollback-state.json").exists()
    assert not (candidate / "run-flock-audio").exists()


def test_stage_rejects_symlinked_lease_tool_before_any_side_effect(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    tool = candidate / "deploy/legacy-lease.mjs"
    replacement = candidate / "replacement.mjs"
    replacement.write_bytes(tool.read_bytes())
    tool.unlink()
    try:
        tool.symlink_to(replacement)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable on this local filesystem")
    calls = []
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(release, "run", lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(
        release.subprocess,
        "run",
        lambda *args, **kwargs: calls.append(args) or type("R", (), {"returncode": 1})(),
    )

    with pytest.raises(release.ReleaseError, match="DEPLOY_EXECUTION_DIGEST_MISMATCH"):
        release.stage_local(type("A", (), {"release_dir": str(candidate)})())

    assert calls == []
    assert not (candidate / "rollback-state.json").exists()
    assert not (candidate / "run-flock-audio").exists()


def test_maintenance_secret_is_created_exclusively_at_private_mode(
        tmp_path, monkeypatch):
    path = tmp_path / "maintenance-token"
    events = []
    original_open = release.os.open
    original_fchmod = release.os.fchmod

    def recording_open(target, flags, mode=0o777):
        events.append(("open", Path(target), flags, mode))
        return original_open(target, flags, mode)

    def recording_fchmod(descriptor, mode):
        events.append(("fchmod", mode))
        return original_fchmod(descriptor, mode)

    monkeypatch.setattr(release.os, "open", recording_open)
    monkeypatch.setattr(release.os, "fchmod", recording_fchmod)
    release.create_private_secret(path, "private-value")

    assert path.read_text() == "private-value"
    assert events[0] == (
        "open",
        path,
        release.os.O_WRONLY | release.os.O_CREAT | release.os.O_EXCL,
        0o400,
    )
    assert events[1] == ("fchmod", 0o400)
    with pytest.raises(release.ReleaseError, match="MAINTENANCE_SECRET_CREATE_FAILED"):
        release.create_private_secret(path, "replacement")
    assert path.read_text() == "private-value"


def test_supported_lease_command_streams_verified_bytes_to_exact_runtime_id(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    tool = candidate / "deploy/legacy-lease.mjs"
    verified_body = tool.read_bytes()
    runtime_id = "b" * 64
    calls = []
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")

    def fake_run(*args, **kwargs):
        calls.append(("run", args, kwargs))
        assert kwargs == {"capture": True}
        if args == (
            "docker", "container", "inspect", "--format", "{{.Id}}",
            "flock-runtime-candidate",
        ):
            # Rebinding the release pathname after verification cannot alter
            # the already-captured stdin program.
            tool.write_bytes(b"replacement after verification\n")
            return runtime_id
        assert args == (
            "docker", "container", "inspect", "--format",
            "{{json .Mounts}}", runtime_id,
        )
        return "[]"

    def fake_subprocess_run(args, **kwargs):
        calls.append(("exec", tuple(args), kwargs))
        return type("R", (), {"returncode": 143})()

    monkeypatch.setattr(release, "run", fake_run)
    monkeypatch.setattr(release.subprocess, "run", fake_subprocess_run)
    args = type("A", (), {
        "release_dir": str(candidate),
        "action": "hold",
        "decoder_session_id": "decoder-7",
        "lease_token": None,
    })()

    assert release.legacy_lease(args) == 143
    assert calls[-1] == (
        "exec",
        (
            "docker", "exec", "-i", "--workdir",
            release.LEGACY_LEASE_WORKDIR, runtime_id,
            "node", "--input-type=module", "-",
            "hold", "decoder-7",
        ),
        {
            "check": False,
            "input": (
                verified_body
                + release.LEGACY_LEASE_STDIN_SHIM.encode("utf-8")
            ),
        },
    )

    tool.write_bytes(b"tampered")
    calls.clear()
    with pytest.raises(release.ReleaseError, match="DEPLOY_EXECUTION_DIGEST_MISMATCH"):
        release.legacy_lease(args)
    assert calls == []


def test_supported_lease_command_exposes_only_hold_and_rejects_bad_session_early(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    calls = []
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(release, "run", lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(
        release.subprocess,
        "run",
        lambda *args, **kwargs: calls.append(args) or type("R", (), {"returncode": 0})(),
    )
    for decoder_session_id in ("", "decoder\ninjected", "x" * 161):
        args = type("A", (), {
            "release_dir": str(candidate),
            "action": "hold",
            "decoder_session_id": decoder_session_id,
        })()
        with pytest.raises(release.ReleaseError, match="LEGACY_LEASE_ARGUMENT_INVALID"):
            release.legacy_lease(args)
    assert calls == []

    with pytest.raises(SystemExit):
        release.parser().parse_args([
            "legacy-lease", "--release-dir", str(candidate),
            "take", "decoder-session",
        ])


@pytest.mark.parametrize("mutation", [
    "read-write",
    "wrong-source",
    "wrong-type",
    "duplicate-destination",
])
def test_supported_lease_command_rejects_any_legacy_mount_destination(
        tmp_path, monkeypatch, mutation):
    candidate = manifest_dir(tmp_path)
    tool = (candidate / "deploy/legacy-lease.mjs").resolve()
    runtime_id = "b" * 64
    mount = {
        "Type": "bind",
        "Source": str(tool),
        "Destination": release.LEGACY_LEASE_CONTAINER_PATH,
        "RW": False,
    }
    mounts = [mount]
    if mutation == "read-write":
        mount["RW"] = True
    elif mutation == "wrong-source":
        mount["Source"] = str((candidate / "deploy/not-the-tool.mjs").resolve())
    elif mutation == "wrong-type":
        mount["Type"] = "volume"
    else:
        mounts.append(dict(mount))
    exec_calls = []
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")

    def fake_run(*args, **kwargs):
        if args[-1] == "flock-runtime-candidate":
            return runtime_id
        assert args[-1] == runtime_id
        return json.dumps(mounts)

    monkeypatch.setattr(release, "run", fake_run)
    monkeypatch.setattr(
        release.subprocess,
        "run",
        lambda *args, **kwargs: exec_calls.append(args)
        or type("R", (), {"returncode": 0})(),
    )
    args = type("A", (), {
        "release_dir": str(candidate),
        "action": "hold",
        "decoder_session_id": "decoder-7",
    })()

    with pytest.raises(release.ReleaseError, match="LEGACY_LEASE_MOUNT_MISMATCH"):
        release.legacy_lease(args)
    assert exec_calls == []


def test_supported_lease_command_rejects_non_utf8_verified_source_before_docker(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    tool = candidate / "deploy/legacy-lease.mjs"
    tool.write_bytes(b"\xff\xfeinvalid module bytes")
    manifest = release.manifest_pair(candidate)
    manifest["deployExecutionIdentity"][
        release.LEGACY_LEASE_TOOL_NAME
    ] = release.sha(tool)
    release.write_manifest_pair(candidate, manifest)
    calls = []
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    monkeypatch.setattr(
        release,
        "run",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    with pytest.raises(
            release.ReleaseError,
            match="LEGACY_LEASE_SOURCE_INVALID"):
        release.legacy_lease(type("A", (), {
            "release_dir": str(candidate),
            "action": "hold",
            "decoder_session_id": "decoder-7",
        })())

    assert calls == []


def test_supported_lease_command_wraps_exec_spawn_failure(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    runtime_id = "b" * 64
    monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")

    def fake_run(*args, **_kwargs):
        return (
            runtime_id
            if args[-1] == "flock-runtime-candidate"
            else "[]"
        )

    monkeypatch.setattr(release, "run", fake_run)
    monkeypatch.setattr(
        release.subprocess,
        "run",
        lambda *_args, **_kwargs: (
            (_ for _ in ()).throw(OSError("docker unavailable"))
        ),
    )

    with pytest.raises(release.ReleaseError, match="COMMAND_FAILED"):
        release.legacy_lease(type("A", (), {
            "release_dir": str(candidate),
            "action": "hold",
            "decoder_session_id": "decoder-7",
        })())


def test_health_without_ready_or_exact_identity_never_succeeds(tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    smoke = candidate / "deploy/verify-smoke.mjs"
    smoke.write_bytes(b"fixture candidate browser smoke\n")
    manifest = release.manifest_pair(candidate)
    manifest["deployExecutionIdentity"]["verify-smoke.mjs"] = release.sha(smoke)
    release.write_manifest_pair(candidate, manifest)
    monkeypatch.setattr(
        release,
        "get_candidate_ops_json",
        lambda path: (200, {}) if path == "/healthz" else (503, {}),
    )
    monkeypatch.setattr(release, "container_user", lambda: "1000:1000")
    monkeypatch.setattr(
        release,
        "run",
        lambda *command, **_kwargs: (
            manifest["localImageDiagnostics"]["runtime"]["localEngineImageId"]
            if command == (
                "docker", "image", "inspect", "--format", "{{.Id}}",
                manifest["localImageDiagnostics"]["runtime"]["tag"],
            )
            else pytest.fail(f"unexpected external command: {command!r}")
        ),
    )
    with pytest.raises(release.ReleaseError, match="CANDIDATE_NOT_IDENTITY_READY"):
        release.verify_candidate(type("A", (), {"release_dir": str(candidate),
                                                 "base_url": "http://127.0.0.1:18090"})())


def test_verify_candidate_separates_internal_ops_from_browser_smoke(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    smoke = candidate / "deploy/verify-smoke.mjs"
    smoke_source = "export const marker = '候选 artifact smoke';\n"
    smoke.write_bytes(smoke_source.encode("utf-8"))
    manifest = release.manifest_pair(candidate)
    manifest["deployExecutionIdentity"]["verify-smoke.mjs"] = release.sha(smoke)
    release.write_manifest_pair(candidate, manifest)
    poison_deploy = tmp_path / "poison-worktree/deploy"
    poison_deploy.mkdir(parents=True)
    (poison_deploy / "verify-smoke.mjs").write_bytes(b"poison worktree smoke\n")
    monkeypatch.setattr(
        release, "__file__", str(poison_deploy / "release_control.py"))
    monkeypatch.setattr(release, "container_user", lambda: "1000:1000")
    runtime = manifest["localImageDiagnostics"]["runtime"]
    ready = {
        "runtimeOwner": "server",
        "audioOwner": "world",
        "workerReady": True,
        "workerIdentity": {
            "expected": manifest["workerIdentity"],
            "reported": manifest["workerIdentity"],
        },
        "phaseGate": "phase5-local",
    }
    calls = []
    inspect_command = (
        "docker", "image", "inspect", "--format", "{{.Id}}", runtime["tag"],
    )
    helper_command = (
        "docker", "run", "-i", "--rm", "--pull", "never", "--network",
        "host", "--read-only", "--cap-drop", "ALL", "--security-opt",
        "no-new-privileges", "--user", "1000:1000", "--workdir",
        "/app/flock-voice-engine/runtime", "--entrypoint", "node",
        runtime["localEngineImageId"], "--input-type=module", "-",
        "http://127.0.0.1:18090",
    )

    def fake_run(*command, **kwargs):
        calls.append((command, kwargs))
        if command == inspect_command:
            assert kwargs == {"capture": True}
            return runtime["localEngineImageId"]
        if command[:4] == (
                "docker", "exec", "flock-runtime-candidate", "node"):
            assert kwargs == {
                "capture": True,
                "timeout": 7,
                "strict_stderr": True,
            }
            assert command[4] == "-e"
            probe = command[5]
            assert "http://127.0.0.1:8090" in probe
            assert "18090" not in probe
            assert "origin" not in probe.lower()
            path = command[6]
            body = ready if path == "/readyz" else {}
            return json.dumps({"statusCode": 200, "body": body})
        if command == helper_command:
            assert kwargs == {"input_text": smoke_source, "timeout": 45}
            return ""
        raise AssertionError(f"unexpected external command: {command!r}")

    monkeypatch.setattr(release, "run", fake_run)
    release.verify_candidate(type("A", (), {
        "release_dir": str(candidate),
        "base_url": "http://127.0.0.1:18090",
    })())

    assert calls[0][0] == inspect_command
    assert [command[-1] for command, _ in calls[1:3]] == [
        "/healthz",
        "/readyz",
    ]
    assert len(calls) == 4
    helper = calls[-1][0]
    assert helper == helper_command
    assert helper[helper.index("--entrypoint") + 2] == runtime["localEngineImageId"]
    assert runtime["tag"] not in helper
    assert manifest["imageIdentity"]["runtime"] not in helper
    assert "--mount" not in helper
    assert "--volume" not in helper
    assert all(command[0] == "docker" for command, _ in calls)
    joined_commands = "\0".join(
        item for command, _ in calls for item in command)
    assert "bind" not in joined_commands
    assert "NODE_PATH" not in joined_commands
    assert "npm" not in joined_commands
    assert "node_modules" not in joined_commands
    assert str(smoke) not in joined_commands
    assert str(poison_deploy) not in joined_commands
    assert [
        kwargs["input_text"]
        for _, kwargs in calls
        if "input_text" in kwargs
    ] == [smoke_source]


def test_verify_candidate_keeps_verified_smoke_bytes_when_path_is_replaced(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    smoke = candidate / "deploy/verify-smoke.mjs"
    verified_source = "export const marker = 'verified bytes';\n"
    replacement_source = "throw new Error('replacement path bytes');\n"
    smoke.write_bytes(verified_source.encode("utf-8"))
    manifest = release.manifest_pair(candidate)
    manifest["deployExecutionIdentity"]["verify-smoke.mjs"] = release.sha(smoke)
    release.write_manifest_pair(candidate, manifest)
    runtime = manifest["localImageDiagnostics"]["runtime"]
    ready = {
        "runtimeOwner": "server",
        "audioOwner": "world",
        "workerReady": True,
        "workerIdentity": {
            "expected": manifest["workerIdentity"],
            "reported": manifest["workerIdentity"],
        },
        "phaseGate": "phase5-local",
    }
    helper_calls = []

    def fake_run(*command, **kwargs):
        if command == (
                "docker", "image", "inspect", "--format", "{{.Id}}",
                runtime["tag"]):
            smoke.write_bytes(replacement_source.encode("utf-8"))
            return runtime["localEngineImageId"]
        if command[:4] == (
                "docker", "exec", "flock-runtime-candidate", "node"):
            path = command[-1]
            body = ready if path == "/readyz" else {}
            return json.dumps({"statusCode": 200, "body": body})
        if command[:2] == ("docker", "run"):
            helper_calls.append((command, kwargs))
            return ""
        raise AssertionError(f"unexpected external command: {command!r}")

    monkeypatch.setattr(release, "run", fake_run)
    monkeypatch.setattr(release, "container_user", lambda: "1000:1000")
    release.verify_candidate(type("A", (), {
        "release_dir": str(candidate),
        "base_url": "http://127.0.0.1:18090",
    })())

    assert smoke.read_bytes() == replacement_source.encode("utf-8")
    assert len(helper_calls) == 1
    helper_command, helper_kwargs = helper_calls[0]
    assert str(smoke) not in helper_command
    assert "--mount" not in helper_command
    assert helper_kwargs == {"input_text": verified_source, "timeout": 45}


def test_verify_candidate_rejects_invalid_utf8_before_any_external_operation(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    smoke = candidate / "deploy/verify-smoke.mjs"
    smoke.write_bytes(b"\xff\xfeinvalid utf-8 smoke\n")
    manifest = release.manifest_pair(candidate)
    manifest["deployExecutionIdentity"]["verify-smoke.mjs"] = release.sha(smoke)
    release.write_manifest_pair(candidate, manifest)
    calls = []

    monkeypatch.setattr(
        release,
        "run",
        lambda *command, **_kwargs: calls.append(("run", command)) or "",
    )
    monkeypatch.setattr(
        release,
        "get_candidate_ops_json",
        lambda path: calls.append(("ops", path)) or (200, {}),
    )
    monkeypatch.setattr(
        release,
        "container_user",
        lambda: calls.append(("container_user",)) or "1000:1000",
    )

    with pytest.raises(
            release.ReleaseError, match="DEPLOY_EXECUTION_UTF8_INVALID"):
        release.verify_candidate(type("A", (), {
            "release_dir": str(candidate),
            "base_url": "http://127.0.0.1:18090",
        })())

    assert calls == []


def test_run_sends_stdin_with_explicit_utf8(monkeypatch):
    calls = []

    def fake_subprocess_run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(release.subprocess, "run", fake_subprocess_run)
    source = "export const marker = '显式 UTF-8';\n"
    release.run("node", "-", input_text=source, timeout=45)

    assert len(calls) == 1
    command, kwargs = calls[0]
    assert command == ("node", "-")
    assert kwargs["input"] == source
    assert kwargs["encoding"] == "utf-8"
    assert "text" not in kwargs
    assert kwargs["timeout"] == 45


def test_verify_candidate_rejects_tampered_smoke_before_any_external_operation(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    smoke = candidate / "deploy/verify-smoke.mjs"
    smoke.write_bytes(b"fixture candidate browser smoke\n")
    manifest = release.manifest_pair(candidate)
    manifest["deployExecutionIdentity"]["verify-smoke.mjs"] = release.sha(smoke)
    release.write_manifest_pair(candidate, manifest)
    smoke.write_bytes(b"tampered candidate browser smoke\n")
    calls = []

    def fake_ops(path):
        calls.append(("ops", path))
        ready = {
            "runtimeOwner": "server",
            "audioOwner": "world",
            "workerReady": True,
            "workerIdentity": {
                "expected": manifest["workerIdentity"],
                "reported": manifest["workerIdentity"],
            },
            "phaseGate": "phase5-local",
        }
        return 200, ready if path == "/readyz" else {}

    monkeypatch.setattr(release, "get_candidate_ops_json", fake_ops)
    monkeypatch.setattr(
        release,
        "run",
        lambda *command, **_kwargs: calls.append(("run", command)) or "",
    )
    monkeypatch.setattr(
        release,
        "container_user",
        lambda: calls.append(("container_user",)) or "1000:1000",
    )

    with pytest.raises(
            release.ReleaseError, match="DEPLOY_EXECUTION_DIGEST_MISMATCH"):
        release.verify_candidate(type("A", (), {
            "release_dir": str(candidate),
            "base_url": "http://127.0.0.1:18090",
        })())

    assert calls == []


@pytest.mark.parametrize(
    "tag,image_id,inspect_result,error,expected_run_count",
    [
        (None, "sha256:" + "1" * 64, None,
         "IMMUTABLE_IMAGE_TAG_REQUIRED", 0),
        ("flock-runtime:latest", "sha256:" + "1" * 64, None,
         "IMMUTABLE_IMAGE_TAG_REQUIRED", 0),
        ("flock-runtime:r-a", "sha256:bad", None,
         "LOADED_IMAGE_CONFIG_MISMATCH", 0),
        ("flock-runtime:r-a", "sha256:" + "1" * 64,
         "sha256:" + "9" * 64, "LOADED_IMAGE_CONFIG_MISMATCH", 1),
    ],
)
def test_verify_candidate_rejects_untrusted_runtime_diagnostics_before_ops(
        tmp_path, monkeypatch, tag, image_id, inspect_result, error,
        expected_run_count):
    candidate = manifest_dir(tmp_path)
    smoke = candidate / "deploy/verify-smoke.mjs"
    smoke.write_bytes(b"fixture candidate browser smoke\n")
    manifest = release.manifest_pair(candidate)
    manifest["deployExecutionIdentity"]["verify-smoke.mjs"] = release.sha(smoke)
    runtime = manifest["localImageDiagnostics"]["runtime"]
    runtime["tag"] = tag
    runtime["localEngineImageId"] = image_id
    release.write_manifest_pair(candidate, manifest)
    calls = []
    ops_calls = []

    def fake_run(*command, **kwargs):
        calls.append((command, kwargs))
        if command == (
                "docker", "image", "inspect", "--format", "{{.Id}}", tag):
            assert kwargs == {"capture": True}
            return inspect_result
        return ""

    monkeypatch.setattr(release, "run", fake_run)
    monkeypatch.setattr(
        release,
        "get_candidate_ops_json",
        lambda path: ops_calls.append(path) or (200, {}),
    )
    monkeypatch.setattr(release, "container_user", lambda: "1000:1000")

    with pytest.raises(release.ReleaseError, match=error):
        release.verify_candidate(type("A", (), {
            "release_dir": str(candidate),
            "base_url": "http://127.0.0.1:18090",
        })())

    assert len(calls) == expected_run_count
    assert ops_calls == []


@pytest.mark.parametrize("payload", [
    "not-json",
    json.dumps({"statusCode": 200, "body": []}),
    json.dumps({"statusCode": True, "body": {}}),
    json.dumps({"statusCode": 200, "body": {}, "extra": "alias"}),
])
def test_candidate_ops_probe_rejects_nonexact_output(monkeypatch, payload):
    monkeypatch.setattr(release, "run", lambda *args, **kwargs: payload)
    with pytest.raises(release.ReleaseError, match="CANDIDATE_OPS_PROBE_INVALID"):
        release.get_candidate_ops_json("/readyz")


def test_candidate_ops_probe_rejects_unapproved_path_before_docker(monkeypatch):
    calls = []
    monkeypatch.setattr(
        release, "run", lambda *args, **kwargs: calls.append(args) or "")
    with pytest.raises(release.ReleaseError, match="CANDIDATE_OPS_PROBE_PATH_INVALID"):
        release.get_candidate_ops_json("/api/decoder-status")
    assert calls == []


def test_candidate_ops_outer_timeout_is_fail_closed(monkeypatch):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs.get("timeout", 0))

    monkeypatch.setattr(release.subprocess, "run", timeout)
    with pytest.raises(release.ReleaseError, match="CANDIDATE_OPS_PROBE_FAILED"):
        release.get_candidate_ops_json("/readyz")


def test_candidate_ops_stderr_is_fail_closed(monkeypatch):
    def warning(command, **_kwargs):
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps({"statusCode": 200, "body": {}}),
            stderr="warning\n",
        )

    monkeypatch.setattr(release.subprocess, "run", warning)
    with pytest.raises(release.ReleaseError, match="CANDIDATE_OPS_PROBE_FAILED"):
        release.get_candidate_ops_json("/readyz")


def test_candidate_ops_node_probe_has_an_independent_exact_path_gate(monkeypatch):
    command = []

    def capture(*args, **_kwargs):
        command.extend(args)
        return json.dumps({"statusCode": 200, "body": {}})

    monkeypatch.setattr(release, "run", capture)
    assert release.get_candidate_ops_json("/healthz") == (200, {})
    result = subprocess.run(
        [str(trusted_node()), "-e", command[5], "/api/decoder-status"],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stdout == result.stderr == b""


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
    deploy = candidate / "deploy"; deploy.mkdir(exist_ok=True)
    tool = deploy / "prepare-cutover-request.mjs"
    tool.write_bytes((ROOT / "flock-voice-engine/runtime/tools/prepare-cutover-request.mjs").read_bytes())
    smoke = deploy / "verify-smoke.mjs"
    smoke.write_bytes(b"fixture candidate browser smoke\n")
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
    manifest["deployExecutionIdentity"] = {
        "prepare-cutover-request.mjs": release.sha(tool),
        "verify-smoke.mjs": release.sha(smoke),
    }
    release.write_manifest_pair(candidate, manifest)
    ready = {"runtimeOwner": "server", "audioOwner": "world", "workerReady": True,
             "workerIdentity": {"expected": manifest["workerIdentity"],
                                "reported": manifest["workerIdentity"]}, "phaseGate": "phase5-local"}
    monkeypatch.setattr(
        release,
        "get_candidate_ops_json",
        lambda path: (200, ready) if path in {"/healthz", "/readyz"}
        else (200, {}),
    )
    original_run = release.run
    monkeypatch.setattr(
        release,
        "run",
        lambda *command, **_kwargs: (
            manifest["localImageDiagnostics"]["runtime"]["localEngineImageId"]
            if command[:3] == ("docker", "image", "inspect")
            else ""
        ),
    )
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
            subprocess.run(
                [
                    str(trusted_node()),
                    tool,
                    "--release-dir",
                    candidate,
                    "--runtime-root",
                    candidate / "source/flock-voice-engine/runtime",
                    "--state-policy",
                    "reset-new-world",
                    "--output",
                    output,
                ],
                check=True,
            )
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
    candidate = manifest_dir(tmp_path)
    deploy = candidate / "deploy"
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


def test_acceptance_executes_verified_validator_bytes_after_source_path_replacement(
        tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path)
    install_acceptance_execution_closure(candidate)
    validator_path = candidate / "deploy/validate_phase5_acceptance.py"
    verified_source = (
        "def validate_bundle(*_args):\n"
        "    raise RuntimeError('VERIFIED_VALIDATOR_EXECUTED')\n"
    )
    replacement_source = (
        "def validate_bundle(*_args):\n"
        "    raise RuntimeError('REPLACEMENT_VALIDATOR_EXECUTED')\n"
    )
    validator_path.write_text(verified_source)
    manifest = release.manifest_pair(candidate)
    manifest["deployExecutionIdentity"][
        "validate_phase5_acceptance.py"
    ] = release.sha(validator_path)
    release.write_manifest_pair(candidate, manifest)

    original_parent_state = release._verified_nested_deploy_parent_state
    parent_state_calls = 0

    def replace_after_final_parent_snapshot(release_dir, code):
        nonlocal parent_state_calls
        state = original_parent_state(release_dir, code)
        parent_state_calls += 1
        if parent_state_calls == 2:
            validator_path.write_text(replacement_source)
        return state

    monkeypatch.setattr(
        release,
        "_verified_nested_deploy_parent_state",
        replace_after_final_parent_snapshot,
    )

    with pytest.raises(
            release.ReleaseError,
            match="^VERIFIED_VALIDATOR_EXECUTED$"):
        release.validate_acceptance_bundle(
            candidate, tmp_path / "equivalence.json")
    assert validator_path.read_text() == replacement_source


@pytest.mark.parametrize("name", tuple(FAULT_VERIFIER_DEPLOY_SOURCES))
@pytest.mark.parametrize("mutation", ("missing", "tampered"))
def test_acceptance_gate_rejects_each_incomplete_fault_verifier_dependency(
        tmp_path, name, mutation):
    candidate = manifest_dir(tmp_path)
    install_acceptance_execution_closure(candidate)
    path = candidate / "deploy" / name
    if mutation == "missing":
        path.unlink()
    else:
        path.write_text("tampered\n")

    with pytest.raises(
            release.ReleaseError,
            match="ACCEPTANCE_VALIDATOR_IDENTITY_MISMATCH"):
        release.validate_acceptance_bundle(
            candidate, tmp_path / "equivalence.json")


@pytest.mark.parametrize("name", CAPTURE_PROOF_DEPLOY_NAMES)
@pytest.mark.parametrize("link_kind", ("symlink", "reparse"))
def test_acceptance_gate_rejects_capture_proof_leaf_link_or_reparse(
        tmp_path, monkeypatch, name, link_kind):
    candidate = manifest_dir(tmp_path)
    install_acceptance_execution_closure(candidate)
    path = candidate / "deploy" / name
    if link_kind == "symlink":
        replacement = candidate / f"replacement-{path.name}"
        replacement.write_bytes(path.read_bytes())
        path.unlink()
        try:
            path.symlink_to(replacement)
        except (OSError, NotImplementedError) as exc:
            pytest.skip(f"symlink creation is unavailable: {exc}")
    else:
        original_lstat = Path.lstat
        actual = original_lstat(path)
        fake = SimpleNamespace(
            st_mode=actual.st_mode,
            st_file_attributes=getattr(
                stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400),
            st_dev=actual.st_dev,
            st_ino=actual.st_ino,
            st_size=actual.st_size,
            st_mtime_ns=actual.st_mtime_ns,
        )
        monkeypatch.setattr(
            Path,
            "lstat",
            lambda current: (
                fake if current == path else original_lstat(current)
            ),
        )

    with pytest.raises(
            release.ReleaseError,
            match="ACCEPTANCE_VALIDATOR_IDENTITY_MISMATCH"):
        release.validate_acceptance_bundle(
            candidate, tmp_path / "equivalence.json")


@pytest.mark.parametrize("name", tuple(PHASE5_SUMMARY_DEPLOY_SOURCES))
@pytest.mark.parametrize("mutation", ("missing", "tampered"))
def test_acceptance_gate_rejects_each_incomplete_phase5_summary_dependency(
        tmp_path, name, mutation):
    candidate = manifest_dir(tmp_path)
    install_acceptance_execution_closure(candidate)
    path = candidate / "deploy" / name
    if mutation == "missing":
        path.unlink()
    else:
        path.write_text("tampered\n")

    with pytest.raises(
            release.ReleaseError,
            match="ACCEPTANCE_VALIDATOR_IDENTITY_MISMATCH"):
        release.validate_acceptance_bundle(
            candidate, tmp_path / "equivalence.json")


@pytest.mark.parametrize("name", tuple(PHASE5_SUMMARY_DEPLOY_SOURCES))
@pytest.mark.parametrize("link_kind", ("symlink", "reparse"))
def test_acceptance_gate_rejects_phase5_summary_leaf_link_or_reparse(
        tmp_path, monkeypatch, name, link_kind):
    candidate = manifest_dir(tmp_path)
    install_acceptance_execution_closure(candidate)
    path = candidate / "deploy" / name
    if link_kind == "symlink":
        replacement = candidate / f"replacement-{path.name}"
        replacement.write_bytes(path.read_bytes())
        path.unlink()
        try:
            path.symlink_to(replacement)
        except (OSError, NotImplementedError) as exc:
            pytest.skip(f"symlink creation is unavailable: {exc}")
    else:
        original_lstat = Path.lstat
        actual = original_lstat(path)
        fake = SimpleNamespace(
            st_mode=actual.st_mode,
            st_file_attributes=getattr(
                stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400),
            st_dev=actual.st_dev,
            st_ino=actual.st_ino,
            st_size=actual.st_size,
            st_mtime_ns=actual.st_mtime_ns,
        )
        monkeypatch.setattr(
            Path,
            "lstat",
            lambda current: fake if current == path else original_lstat(current),
        )

    with pytest.raises(
            release.ReleaseError,
            match="ACCEPTANCE_VALIDATOR_IDENTITY_MISMATCH"):
        release.validate_acceptance_bundle(
            candidate, tmp_path / "equivalence.json")


@pytest.mark.parametrize("parent_name", (
    "phase5-fault-verifier",
    "phase5-fault-verifier/lib",
    "phase5-summary",
))
@pytest.mark.parametrize("link_kind", ("symlink", "reparse"))
def test_acceptance_gate_rejects_fault_verifier_link_or_reparse_parent(
        tmp_path, monkeypatch, parent_name, link_kind):
    candidate = manifest_dir(tmp_path)
    install_acceptance_execution_closure(candidate)
    parent = candidate / "deploy" / parent_name
    original_lstat = Path.lstat
    actual = original_lstat(parent)
    fake = SimpleNamespace(
        st_mode=(
            stat.S_IFLNK | 0o777
            if link_kind == "symlink"
            else actual.st_mode
        ),
        st_file_attributes=(
            getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
            if link_kind == "reparse"
            else 0
        ),
        st_dev=actual.st_dev,
        st_ino=actual.st_ino,
        st_size=actual.st_size,
        st_mtime_ns=actual.st_mtime_ns,
    )

    def fake_lstat(path):
        return fake if path == parent else original_lstat(path)

    monkeypatch.setattr(Path, "lstat", fake_lstat)
    with pytest.raises(
            release.ReleaseError,
            match="ACCEPTANCE_VALIDATOR_IDENTITY_MISMATCH"):
        release.validate_acceptance_bundle(
            candidate, tmp_path / "equivalence.json")


def test_prepare_rejects_acceptance_replaced_after_package(tmp_path, monkeypatch):
    candidate = manifest_dir(tmp_path); monkeypatch.setenv("FLOCK_DEPLOY_SCOPE", "local")
    release_sha = release.sha(candidate / "release-manifest.json")
    acceptance = {"schemaVersion": 1, "status": "accepted",
                  "release": {"releaseManifestSha256": release_sha}}
    (candidate / "acceptance.json").write_bytes(release.canonical(acceptance))
    inputs = candidate / "acceptance-inputs"; inputs.mkdir()
    (inputs / "staging-equivalence.json").write_text("{}")
    deploy = candidate / "deploy"
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
            "legacy_lease",
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
            [
                "legacy-lease", "--release-dir", "release",
                "hold", "decoder-session",
            ],
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
    subprocess.run(
        [str(trusted_zstd()), "-q", "-f", archive_tar, "-o", archive],
        check=True,
    )
    for path in (bootstrap, archive):
        (tmp_path / f"{path.name}.sha256").write_text(f"{release.sha(path)}  {path.name}\n")
    result = run_import_bootstrap(bootstrap, archive, stub_bin, os.environ.copy())
    stderr = result.stderr.decode("utf-8", errors="replace")
    assert result.returncode != 0 and "RELEASE_ARCHIVE_UNSAFE" in stderr
    assert "UnicodeDecodeError" not in stderr
    assert not (tmp_path.parent / "escape").exists()


def test_import_bootstrap_attests_legacy_lease_tool_before_execution(tmp_path):
    bootstrap = tmp_path / "import-release.sh"
    bootstrap.write_bytes(
        (DEPLOY / "import-release.sh").read_bytes().replace(b"\r\n", b"\n"))
    bootstrap.chmod(0o755)
    stub_bin = tmp_path / "bin"; stub_bin.mkdir()
    python3_shim(stub_bin / "python3")
    root = tmp_path / "release"; deploy = root / "deploy"; deploy.mkdir(parents=True)
    release_script = deploy / "release.sh"
    release_script.write_text("#!/bin/sh\nexit 0\n")
    release_script.chmod(0o755)
    execution_names = (
        "release.sh",
        "release_control.py",
        "phase5_candidate_attempt.py",
        "phase5_candidate_bootstrap.py",
        "verify-smoke.mjs",
        "verify-candidate.sh",
        "legacy-lease.mjs",
        "prepare-cutover-request.mjs",
        "validate_phase5_acceptance.py",
        "acceptance.schema.json",
        "machine-attestation.schema.json",
        *FAULT_VERIFIER_DEPLOY_SOURCES,
        *PHASE5_SUMMARY_DEPLOY_SOURCES,
    )
    for name in execution_names[1:]:
        path = deploy / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"trusted {name}\n")
    manifest = {
        "schemaVersion": 1,
        "deployReleaseScriptSha256": release.sha(release_script),
        "bootstrapSha256": release.sha(bootstrap),
        "deployExecutionIdentity": {
            name: release.sha(deploy / name) for name in execution_names
        },
    }
    manifest_path = root / "release-manifest.json"
    manifest_path.write_bytes(release.canonical(manifest))
    (root / "release-manifest.json.sha256").write_text(
        f"{release.sha(manifest_path)}  release-manifest.json\n")
    archive_tar = tmp_path / "release.tar"
    archive = tmp_path / "release.tar.zst"

    def pack() -> None:
        with tarfile.open(archive_tar, "w") as tf:
            tf.add(root, arcname=root.name)
        subprocess.run(
            [str(trusted_zstd()), "-q", "-f", archive_tar, "-o", archive],
            check=True,
        )
        (tmp_path / "release.tar.zst.sha256").write_text(
            f"{release.sha(archive)}  release.tar.zst\n")
        (tmp_path / "import-release.sh.sha256").write_text(
            f"{release.sha(bootstrap)}  import-release.sh\n")

    import_env = os.environ.copy()
    if os.name == "nt":
        import_env["PATH"] = (
            str(trusted_bash().parent)
            + os.pathsep
            + import_env.get("PATH", "")
        )
        (stub_bin / "python3").write_bytes((
            "#!/bin/sh\n"
            f"export PATH={shlex.quote(import_env['PATH'])}\n"
            f"exec {shlex.quote(Path(sys.executable).as_posix())} \"$@\"\n"
        ).encode("utf-8"))
        (stub_bin / "python3").chmod(0o755)
    pack()
    accepted = run_import_bootstrap(
        bootstrap, archive, stub_bin, import_env)
    accepted_stderr = accepted.stderr.decode("utf-8", errors="replace")
    if os.name == "nt":
        # The bootstrap reached the trusted release script; Windows has no
        # authoritative POSIX execution target for that final Linux-only hop.
        assert "DEPLOY_EXECUTION_DIGEST_MISMATCH" not in accepted_stderr
    else:
        assert accepted.returncode == 0, accepted_stderr

    (deploy / "legacy-lease.mjs").write_text("tampered\n")
    pack()
    rejected = run_import_bootstrap(
        bootstrap, archive, stub_bin, import_env)
    stderr = rejected.stderr.decode("utf-8", errors="replace")
    assert rejected.returncode != 0
    assert "DEPLOY_EXECUTION_DIGEST_MISMATCH" in stderr

    (deploy / "legacy-lease.mjs").write_text("trusted legacy-lease.mjs\n")
    nested_dependency = deploy / next(iter(FAULT_VERIFIER_DEPLOY_SOURCES))
    nested_dependency.write_text("tampered nested verifier\n")
    pack()
    rejected_nested = run_import_bootstrap(
        bootstrap, archive, stub_bin, import_env)
    stderr = rejected_nested.stderr.decode("utf-8", errors="replace")
    assert rejected_nested.returncode != 0
    assert "DEPLOY_EXECUTION_DIGEST_MISMATCH" in stderr

    nested_dependency.write_text(
        f"trusted {next(iter(FAULT_VERIFIER_DEPLOY_SOURCES))}\n")
    summary_dependency = deploy / next(iter(PHASE5_SUMMARY_DEPLOY_SOURCES))
    summary_dependency.write_text("tampered summary dependency\n")
    pack()
    rejected_summary = run_import_bootstrap(
        bootstrap, archive, stub_bin, import_env)
    stderr = rejected_summary.stderr.decode("utf-8", errors="replace")
    assert rejected_summary.returncode != 0
    assert "DEPLOY_EXECUTION_DIGEST_MISMATCH" in stderr

    summary_dependency.write_text(
        f"trusted {next(iter(PHASE5_SUMMARY_DEPLOY_SOURCES))}\n")
    alias = deploy / "legacy_lease.mjs"
    alias.write_text("unapproved alias\n")
    manifest["deployExecutionIdentity"]["legacy_lease.mjs"] = release.sha(alias)
    manifest_path.write_bytes(release.canonical(manifest))
    (root / "release-manifest.json.sha256").write_text(
        f"{release.sha(manifest_path)}  release-manifest.json\n")
    pack()
    rebound = run_import_bootstrap(
        bootstrap, archive, stub_bin, import_env)
    stderr = rebound.stderr.decode("utf-8", errors="replace")
    assert rebound.returncode != 0
    assert "DEPLOY_EXECUTION_DIGEST_MISMATCH" in stderr


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
