from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

import tools.build_release_artifact as release_builder
from tools.build_release_artifact import (
    IdentityError,
    ReleaseBuildError,
    build_release,
    canonical_json,
    manifest_sha256,
    verify_audio_artifact,
)


def _git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


@pytest.fixture()
def fake_repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "fixture@example.invalid")
    _git(root, "config", "user.name", "Fixture")
    (root / "candidate.txt").write_text("phase5\n", encoding="utf-8")
    _git(root, "add", "candidate.txt")
    _git(root, "commit", "-qm", "fixture")
    return root


def _file(path: Path, value: bytes) -> dict[str, object]:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)
    return {
        "sourcePath": str(path.resolve()),
        "byteCount": len(value),
        "sha256": hashlib.sha256(value).hexdigest(),
    }


@pytest.fixture()
def valid_inputs(tmp_path: Path) -> Path:
    sources = tmp_path / "controlled"
    specifications = [
        ("vendor/file.py", "vendor/file.py", "vendor", b"VALUE = 1\n"),
        ("weights/model.bin", "weights/model.bin", "weight", b"model"),
        ("maps/bass.json", "maps/bass.json", "voice-map", b"{}"),
        ("calibration/output.json", "calibration/output.json", "calibration", b"{}"),
        ("audio/amen.wav", "audio/amen.wav", "audio", b"amen"),
        ("audio/forest.wav", "audio/forest.wav", "audio", b"forest"),
    ]
    artifacts = []
    for logical, mount, kind, body in specifications:
        artifacts.append({"logicalPath": logical, "mountPath": mount, "kind": kind,
                          **_file(sources / mount, body)})
    vendor_inventory = [
        {"logicalPath": item["logicalPath"], "byteCount": item["byteCount"], "sha256": item["sha256"]}
        for item in artifacts if item["kind"] == "vendor"
    ]
    vendor_digest = manifest_sha256(vendor_inventory)
    vendor_artifact = _file(sources / "upstream-vendor.tar", b"controlled upstream archive")
    data = {
        "schemaVersion": 1,
        "provenanceKind": "controlled-artifact",
        "vendor": {"provenanceKind": "controlled-artifact",
                   "artifactPath": vendor_artifact["sourcePath"],
                   "artifactByteCount": vendor_artifact["byteCount"],
                   "artifactSha256": vendor_artifact["sha256"], "treeSha256": vendor_digest},
        "baseImages": {
            "runtime": {"repository": "example/runtime", "digest": f"sha256:{'1' * 64}",
                        "imageDigest": f"sha256:{'2' * 64}"},
            "audio": {"repository": "example/audio", "digest": f"sha256:{'3' * 64}",
                      "imageDigest": f"sha256:{'4' * 64}"},
        },
        "geometry": {"sampleRate": 44100, "blockFrames": 4096, "poolSize": 5,
                     "rowVoices": ["bass", "pad", "lead", "pluck", "pad"]},
        "artifacts": artifacts,
    }
    path = tmp_path / "audio-inputs.json"
    path.write_bytes(canonical_json(data))
    return path


def _rewrite(path: Path, mutate) -> None:
    data = json.loads(path.read_text("utf-8"))
    mutate(data)
    path.write_bytes(canonical_json(data))


def test_release_revision_comes_from_git_head(fake_repo: Path, valid_inputs: Path, tmp_path: Path):
    required_entry = "4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9"
    result = build_release(fake_repo, valid_inputs, tmp_path / "release")
    assert result["releaseRevision"] == _git(fake_repo, "rev-parse", "HEAD")
    assert result["releaseRevision"] != required_entry


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        (lambda data: data.update(provenanceKind="vendor-tree"), "UNCONTROLLED_VENDOR"),
        (lambda data: data["baseImages"]["runtime"].update(digest="latest"), "BASE_IMAGE_DIGEST_INVALID"),
        (lambda data: data["artifacts"].pop(), "AUDIO_ARTIFACT_INVENTORY_INCOMPLETE"),
        (lambda data: data["artifacts"][0].update(byteCount=999), "AUDIO_ARTIFACT_BYTE_COUNT_MISMATCH"),
        (lambda data: data["artifacts"][1].update(logicalPath=data["artifacts"][0]["logicalPath"]),
         "AUDIO_ARTIFACT_PATH_DUPLICATE"),
    ],
)
def test_invalid_controlled_inputs_fail_closed(fake_repo, valid_inputs, tmp_path, mutation, reason):
    _rewrite(valid_inputs, mutation)
    with pytest.raises(ReleaseBuildError, match=reason):
        build_release(fake_repo, valid_inputs, tmp_path / "release")


def test_dirty_tracked_tree_is_rejected(fake_repo, valid_inputs, tmp_path):
    (fake_repo / "candidate.txt").write_text("dirty\n", encoding="utf-8")
    with pytest.raises(ReleaseBuildError, match="TRACKED_TREE_DIRTY"):
        build_release(fake_repo, valid_inputs, tmp_path / "release")


def test_tampered_weight_rejects_worker_identity(fake_repo, valid_inputs, tmp_path):
    release = tmp_path / "release"
    build_release(fake_repo, valid_inputs, release)
    (release / "mounts/weights/model.bin").write_bytes(b"tampered")
    with pytest.raises(IdentityError, match="AUDIO_ARTIFACT_DIGEST_MISMATCH"):
        verify_audio_artifact(release / "audio-identity.json", release / "audio-artifact-manifest.json")


def test_vendor_archive_and_extracted_tree_have_independent_digests(fake_repo, valid_inputs, tmp_path):
    _rewrite(valid_inputs, lambda data: data["vendor"].update(artifactSha256="0" * 64))
    with pytest.raises(ReleaseBuildError, match="AUDIO_ARTIFACT_DIGEST_MISMATCH"):
        build_release(fake_repo, valid_inputs, tmp_path / "release")


def test_preexisting_or_symlink_output_is_never_followed(fake_repo, valid_inputs, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    output = tmp_path / "release"
    output.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ReleaseBuildError, match="OUTPUT_PATH_EXISTS"):
        build_release(fake_repo, valid_inputs, output)
    assert list(outside.iterdir()) == []


def test_source_manifest_is_stably_sorted(fake_repo, valid_inputs, tmp_path):
    (fake_repo / "z.txt").write_text("z", encoding="utf-8")
    (fake_repo / "a.txt").write_text("a", encoding="utf-8")
    _git(fake_repo, "add", "z.txt", "a.txt")
    _git(fake_repo, "commit", "-qm", "more")
    release = tmp_path / "release"
    build_release(fake_repo, valid_inputs, release)
    entries = json.loads((release / "source-manifest.json").read_text("utf-8"))["entries"]
    assert [entry["path"] for entry in entries] == sorted(entry["path"] for entry in entries)


def test_source_manifest_is_pinned_to_captured_revision_during_aba(fake_repo, valid_inputs, tmp_path, monkeypatch):
    revision_a = _git(fake_repo, "rev-parse", "HEAD")
    (fake_repo / "candidate.txt").write_text("revision-b\n", encoding="utf-8")
    _git(fake_repo, "commit", "-am", "revision b", "-q")
    revision_b = _git(fake_repo, "rev-parse", "HEAD")
    _git(fake_repo, "checkout", "-q", revision_a)
    original = release_builder._source_manifest

    def race(root, pinned_revision):
        _git(fake_repo, "checkout", "-q", revision_b)
        try:
            return original(root, pinned_revision)
        finally:
            _git(fake_repo, "checkout", "-q", revision_a)

    monkeypatch.setattr(release_builder, "_source_manifest", race)
    release = tmp_path / "release"
    result = build_release(fake_repo, valid_inputs, release)
    expected = original(fake_repo, revision_a)
    assert result["releaseRevision"] == revision_a
    assert result["sourceManifestSha256"] == manifest_sha256(expected)


def test_atomic_publish_never_replaces_a_racing_target(tmp_path):
    parent_fd = os.open(tmp_path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.mkdir("staging", dir_fd=parent_fd)
        os.mkdir("release", dir_fd=parent_fd)
        with pytest.raises(ReleaseBuildError, match="OUTPUT_PATH_EXISTS"):
            release_builder._rename_noreplace(parent_fd, "staging", "release")
        assert (tmp_path / "staging").is_dir()
        assert (tmp_path / "release").is_dir()
    finally:
        os.close(parent_fd)


def test_missing_real_inputs_is_an_explicit_blocker(fake_repo, tmp_path):
    with pytest.raises(ReleaseBuildError, match="AUDIO_INPUTS_MISSING"):
        build_release(fake_repo, tmp_path / "missing.json", tmp_path / "release")
