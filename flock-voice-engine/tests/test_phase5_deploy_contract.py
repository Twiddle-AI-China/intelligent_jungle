from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "flock-voice-engine/deploy"
spec = importlib.util.spec_from_file_location("release_control", DEPLOY / "release_control.py")
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)


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


def test_dockerfiles_use_only_digest_pinned_bases_and_split_gpu_dependencies():
    runtime = (DEPLOY / "Dockerfile.runtime").read_text()
    audio = (DEPLOY / "Dockerfile.audio").read_text()
    assert "FROM ${RUNTIME_BASE_REPOSITORY}@${RUNTIME_BASE_DIGEST}" in runtime
    assert "FROM ${AUDIO_BASE_REPOSITORY}@${AUDIO_BASE_DIGEST}" in audio
    assert "torch" not in runtime.lower() and "python" not in runtime.lower()
    assert "--require-hashes" in audio
    assert "latest" not in runtime.lower() + audio.lower()


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
    monkeypatch.setattr(release, "run", original_run)
    release.package(type("A", (), {"release_dir": str(candidate)})())
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


def test_unknown_subcommand_and_production_cutover_fail_closed(monkeypatch):
    script = DEPLOY / "release.sh"
    env = {**os.environ, "FLOCK_DEPLOY_SCOPE": "local"}
    unknown = subprocess.run(["bash", script, "surprise"], env=env, text=True, capture_output=True)
    cutover = subprocess.run(["bash", script, "cutover"], env=env, text=True, capture_output=True)
    assert unknown.returncode != 0
    assert cutover.returncode != 0 and "PRODUCTION_RELEASE_AUTHORIZATION_REQUIRED" in cutover.stderr


def test_managed_renderer_preserves_human_content(tmp_path):
    doc = tmp_path / "handoff.md"; doc.write_text("human\n")
    renderer = ROOT / "flock-voice-engine/tools/render_cutover_docs.py"
    subprocess.run(["python3", renderer, "--initial-status", "legacy-not-cut-over", "--handoff", doc], check=True)
    first = doc.read_text()
    subprocess.run(["python3", renderer, "--initial-status", "legacy-not-cut-over", "--handoff", doc], check=True)
    assert doc.read_text() == first and first.startswith("human\n") and first.count("phase5-managed-status:start") == 1


def test_bootstrap_rejects_archive_traversal_before_execution(tmp_path):
    bootstrap = tmp_path / "import-release.sh"
    bootstrap.write_bytes((DEPLOY / "import-release.sh").read_bytes())
    archive_tar = tmp_path / "release.tar"
    payload = tmp_path / "payload"; payload.write_text("escape")
    with tarfile.open(archive_tar, "w") as tf:
        tf.add(payload, arcname="../escape")
    archive = tmp_path / "release.tar.zst"
    subprocess.run(["zstd", "-q", "-f", archive_tar, "-o", archive], check=True)
    for path in (bootstrap, archive):
        (tmp_path / f"{path.name}.sha256").write_text(f"{release.sha(path)}  {path.name}\n")
    result = subprocess.run(["bash", bootstrap, archive, tmp_path / "release.tar.zst.sha256",
                             tmp_path / "import-release.sh.sha256"], text=True, capture_output=True)
    assert result.returncode != 0 and "RELEASE_ARCHIVE_UNSAFE" in result.stderr
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
    result = subprocess.run(["python3", ROOT / "flock-voice-engine/tools/render_cutover_docs.py",
                             "--record", record, "--handoff", doc], text=True, capture_output=True)
    assert result.returncode != 0 and doc.read_text() == "human\n"
