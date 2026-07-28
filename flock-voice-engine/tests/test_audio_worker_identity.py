from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

from linux_release_security import linux_release_security
import server.audio_worker.identity as identity_module
from server.audio_worker.identity import (WorkerIdentityError, load_trusted_release_manifest,
                                          load_verified_asset_bundle, load_worker_identity)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def release_pair(root: Path):
    mounts = root / "mounts"
    (mounts / "vendor").mkdir(parents=True)
    (mounts / "weights").mkdir()
    vendor = b"archive"
    weight = b"weight"
    (mounts / "vendor/upstream.artifact").write_bytes(vendor)
    (mounts / "weights/model.bin").write_bytes(weight)
    manifest = {"schemaVersion": 1,
                "vendorProvenance": {"mountPath": "vendor/upstream.artifact", "byteCount": len(vendor),
                                     "sha256": hashlib.sha256(vendor).hexdigest(), "treeSha256": "4" * 64},
                "entries": [{"logicalPath": "weights/model.bin", "mountPath": "weights/model.bin",
                             "byteCount": len(weight), "sha256": hashlib.sha256(weight).hexdigest(),
                             "kind": "weight"}]}
    manifest_body = canonical(manifest)
    identity = {"releaseRevision": "1" * 40, "sourceManifestSha256": "2" * 64,
                "protocolFamily": "flock-audio-ipc", "protocolVersion": 1,
                "audioArtifactKind": "release-artifact",
                "audioArtifactSha256": hashlib.sha256(manifest_body).hexdigest()}
    identity_path = root / "audio-identity.json"
    manifest_path = root / "audio-artifact-manifest.json"
    identity_path.write_bytes(canonical(identity))
    manifest_path.write_bytes(manifest_body)
    return identity_path, manifest_path, identity


@linux_release_security
def test_worker_recomputes_artifact_and_returns_exact_identity(tmp_path):
    identity_path, manifest_path, identity = release_pair(tmp_path)
    assert load_worker_identity(identity_path, manifest_path) == identity
    bundle = load_verified_asset_bundle(identity_path, manifest_path)
    assert bundle.path("weights/model.bin").read_bytes() == b"weight"
    assert bundle.manifest_sha256 == identity["audioArtifactSha256"]
    (tmp_path / "mounts/weights/model.bin").write_bytes(b"changed-after-verification")
    assert bundle.path("weights/model.bin").read_bytes() == b"weight"
    private_root = bundle.materialized_root
    bundle.close()
    assert private_root is not None and not private_root.exists()


@linux_release_security
def test_tamper_and_symlink_fail_closed(tmp_path):
    identity_path, manifest_path, _ = release_pair(tmp_path)
    (tmp_path / "mounts/weights/model.bin").write_bytes(b"tampered")
    with pytest.raises(WorkerIdentityError, match="AUDIO_ARTIFACT_DIGEST_MISMATCH"):
        load_worker_identity(identity_path, manifest_path)
    target = tmp_path / "target"
    target.write_bytes(identity_path.read_bytes())
    identity_path.unlink()
    identity_path.symlink_to(target)
    with pytest.raises(WorkerIdentityError, match="AUDIO_IDENTITY_UNTRUSTED"):
        load_worker_identity(identity_path, manifest_path)


def test_release_geometry_is_digest_and_identity_bound(tmp_path, monkeypatch):
    identity_path, artifact_path, identity = release_pair(tmp_path)
    geometry = {"sampleRate": 48000, "blockFrames": 1024, "poolSize": 2,
                "rowVoices": ["bass", "pad"]}
    release = {"schemaVersion": 1, "workerIdentity": identity, "geometry": geometry,
               "manifestGeometrySha256": hashlib.sha256(canonical(geometry)).hexdigest(),
               "baseImages": {}, "imageIdentity": {}}
    path = tmp_path / "release-manifest.json"
    body = canonical(release)
    path.write_bytes(body)
    digest_path = tmp_path / "release-manifest.json.sha256"
    digest_path.write_bytes(
        f"{hashlib.sha256(body).hexdigest()}  release-manifest.json\n".encode("ascii")
    )
    if sys.platform == "win32":
        real_lstat = identity_module.os.lstat
        real_fstat = identity_module.os.fstat

        def trusted_metadata(value: os.stat_result) -> os.stat_result:
            fields = list(value)
            fields[0] &= ~0o022
            fields[4] = 0
            return os.stat_result(fields)

        monkeypatch.setattr(identity_module.os, "geteuid", lambda: 0, raising=False)
        monkeypatch.setattr(
            identity_module.os,
            "lstat",
            lambda target: trusted_metadata(real_lstat(target)),
        )
        monkeypatch.setattr(
            identity_module.os,
            "fstat",
            lambda descriptor: trusted_metadata(real_fstat(descriptor)),
        )
        monkeypatch.setattr(identity_module.os, "open", lambda *_args, **_kwargs: 1)
        monkeypatch.setattr(identity_module.os, "close", lambda _descriptor: None)
        monkeypatch.setattr(
            identity_module,
            "_read_regular_at",
            lambda _descriptor, relative: (tmp_path / relative).read_bytes(),
        )
    assert load_trusted_release_manifest(path, digest_path, identity)["geometry"] == geometry
    release["geometry"]["sampleRate"] = 44100
    tampered = canonical(release)
    path.write_bytes(tampered)
    digest_path.write_bytes(
        f"{hashlib.sha256(tampered).hexdigest()}  release-manifest.json\n".encode("ascii")
    )
    with pytest.raises(WorkerIdentityError, match="GEOMETRY_DIGEST_MISMATCH"):
        load_trusted_release_manifest(path, digest_path, identity)
