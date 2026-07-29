from __future__ import annotations

import copy
import hashlib
import importlib.util
import os
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_raw_manifest", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

fixture_spec = importlib.util.spec_from_file_location(
    "phase5_summary_fixture_for_raw_manifest", SUMMARY_TEST)
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)


EXPECTED_ARTIFACTS = (
    ("faultEventsSha256", "acceptance-evidence/fault-events.json"),
    ("soakRunSha256", "acceptance-evidence/soak-run.json"),
    (
        "rawRuntimeReadySamplesSha256",
        "acceptance-evidence/runtime-ready-samples.json",
    ),
    (
        "rawUiStateLagSamplesSha256",
        "acceptance-evidence/ui-state-lag-samples.json",
    ),
    ("rawRenderSamplesSha256", "acceptance-evidence/render-samples.json"),
    (
        "clientObservationsSha256",
        "acceptance-evidence/client-observations.json",
    ),
    (
        "speciesNormalSamplesSha256",
        "acceptance-evidence/species-normal-samples.json",
    ),
    (
        "speciesBurstSamplesSha256",
        "acceptance-evidence/species-burst-samples.json",
    ),
    ("phase5E2eSha256", "acceptance-evidence/phase5-e2e.json"),
    ("leaseEvidenceSha256", "acceptance-evidence/lease-evidence.json"),
    ("productionGraphSha256", "production-graph.json"),
    (
        "productionMachineAttestationSha256",
        "production-machine-attestation.json",
    ),
    ("listeningChecklistSha256", "listening-checklist.json"),
    ("equivalenceSha256", "staging-equivalence.json"),
)


def binding_and_window() -> tuple[dict, dict]:
    summary = fixture.structurally_valid_summary()
    binding = {
        name: copy.deepcopy(summary[name])
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    return binding, copy.deepcopy(summary["window"])


def raw_blobs() -> dict[str, bytes]:
    return {
        artifact: validator.canonical({
            "artifact": artifact,
            "ordinal": index,
        })
        for index, (artifact, _path) in enumerate(EXPECTED_ARTIFACTS, 1)
    }


def valid_manifest() -> tuple[dict, dict, dict, dict]:
    binding, window = binding_and_window()
    blobs = raw_blobs()
    value = validator.phase5_raw_manifest_from_blobs(
        binding, window, blobs)
    return value, binding, window, blobs


def write_raw_bundle(root: Path) -> tuple[dict, dict, dict]:
    value, binding, _window, blobs = valid_manifest()
    for artifact, path in EXPECTED_ARTIFACTS:
        destination = root.joinpath(*path.split("/"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(blobs[artifact])
    manifest_path = root / "acceptance-evidence/phase5-raw-manifest.json"
    manifest_path.write_bytes(validator.canonical(value))
    return value, binding, blobs


def summary_bound_to_raw_bundle(root: Path) -> tuple[dict, dict, dict]:
    manifest, binding, blobs = write_raw_bundle(root)
    summary = fixture.structurally_valid_summary()
    digests = {
        item["artifact"]: item["sha256"]
        for item in manifest["artifacts"]
    }
    summary["rawArtifacts"].update(digests)
    manifest_raw = validator.canonical(manifest)
    summary["rawArtifacts"]["rawManifestSha256"] = hashlib.sha256(
        manifest_raw).hexdigest()
    return summary, binding, blobs


def test_raw_manifest_builder_freezes_exact_fourteen_leaf_order_and_digests():
    value, binding, window, blobs = valid_manifest()

    assert tuple(validator.PHASE5_RAW_ARTIFACTS) == EXPECTED_ARTIFACTS
    assert value == {
        "schemaVersion": 2,
        "kind": "isolated-equivalent-spark-phase5-raw-manifest",
        **binding,
        "window": window,
        "artifacts": [
            {
                "artifact": artifact,
                "path": path,
                "byteLength": len(blobs[artifact]),
                "sha256": hashlib.sha256(blobs[artifact]).hexdigest(),
            }
            for artifact, path in EXPECTED_ARTIFACTS
        ],
    }
    assert validator.validate_phase5_raw_manifest_structure(
        value, binding) == value
    assert validator.validate_phase5_raw_manifest_bytes(
        validator.canonical(value), binding) == value
    assert validator.phase5_raw_artifact_digests(value) == {
        item["artifact"]: item["sha256"] for item in value["artifacts"]
    }


def test_raw_manifest_bundle_reads_each_fixed_leaf_once_and_returns_owned_bytes(
        tmp_path, monkeypatch):
    value, binding, blobs = write_raw_bundle(tmp_path)
    real_reader = validator.read_regular_file_no_follow
    reads = []

    def counted(path, code, max_bytes=None):
        reads.append(Path(path))
        return real_reader(path, code, max_bytes=max_bytes)

    monkeypatch.setattr(validator, "read_regular_file_no_follow", counted)
    loaded = validator.load_phase5_raw_manifest_bundle(
        tmp_path.resolve(), binding)

    assert loaded["manifest"] == value
    assert loaded["manifestRaw"] == validator.canonical(value)
    assert loaded["manifestSha256"] == hashlib.sha256(
        loaded["manifestRaw"]).hexdigest()
    assert loaded["blobs"] == blobs
    assert len(reads) == 15
    assert len(set(reads)) == 15


def test_raw_manifest_rejects_declared_leaf_above_cap_before_leaf_read(
        tmp_path, monkeypatch):
    value, binding, _window, _blobs = valid_manifest()
    value["artifacts"][0]["byteLength"] = (
        validator.PHASE5_RAW_ARTIFACT_MAX_BYTES[
            "faultEventsSha256"
        ] + 1
    )
    manifest_path = (
        tmp_path / "acceptance-evidence/phase5-raw-manifest.json"
    )
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_bytes(validator.canonical(value))
    real_reader = validator.read_regular_file_no_follow
    reads = []

    def counted(path, code, max_bytes=None):
        reads.append(Path(path))
        return real_reader(path, code, max_bytes=max_bytes)

    monkeypatch.setattr(validator, "read_regular_file_no_follow", counted)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.load_phase5_raw_manifest_bundle(
            tmp_path.resolve(), binding)

    assert reads == [manifest_path]


def test_regular_file_reader_rejects_fstat_size_above_limit(tmp_path):
    path = tmp_path / "bounded.bin"
    path.write_bytes(b"four")

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.read_regular_file_no_follow(
            path.resolve(),
            "PHASE5_RAW_MANIFEST_INVALID",
            max_bytes=3,
        )


def test_raw_manifest_bundle_rejects_leaf_changed_after_manifest(tmp_path):
    _value, binding, _blobs = write_raw_bundle(tmp_path)
    (tmp_path / "acceptance-evidence/fault-events.json").write_bytes(
        b"rebound")

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.load_phase5_raw_manifest_bundle(
            tmp_path.resolve(), binding)


def test_raw_manifest_bundle_rejects_actual_case_alias_leaf_name(tmp_path):
    _value, binding, _blobs = write_raw_bundle(tmp_path)
    parent = tmp_path / "acceptance-evidence"
    canonical_leaf = parent / "fault-events.json"
    alias_leaf = parent / "FAULT-events.json"
    original = canonical_leaf.read_bytes()
    alias_leaf.write_bytes(original)
    names = {entry.name for entry in parent.iterdir()}
    if {"fault-events.json", "FAULT-events.json"} - names:
        temporary = parent / "fault-events.case-rename.tmp"
        canonical_leaf.rename(temporary)
        temporary.rename(alias_leaf)
        names = {entry.name for entry in parent.iterdir()}
    assert "FAULT-events.json" in names

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.load_phase5_raw_manifest_bundle(
            tmp_path.resolve(), binding)


@pytest.mark.parametrize("linked_parent", [False, True])
def test_raw_manifest_bundle_rejects_leaf_and_parent_symlinks(
        tmp_path, linked_parent):
    _value, binding, _blobs = write_raw_bundle(tmp_path)
    leaf = tmp_path / "acceptance-evidence/fault-events.json"
    try:
        if linked_parent:
            real_parent = tmp_path / "acceptance-evidence"
            external_parent = tmp_path / "real-acceptance-evidence"
            real_parent.replace(external_parent)
            os.symlink(
                external_parent,
                real_parent,
                target_is_directory=True,
            )
        else:
            external_leaf = tmp_path / "external-fault-events.json"
            leaf.replace(external_leaf)
            os.symlink(external_leaf, leaf)
    except OSError as exc:
        pytest.skip(f"symlink unavailable: {exc}")

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.load_phase5_raw_manifest_bundle(
            tmp_path.resolve(), binding)


def test_summary_raw_manifest_boundary_binds_all_fourteen_leaves_and_manifest(
        tmp_path):
    summary, binding, blobs = summary_bound_to_raw_bundle(tmp_path)

    loaded = validator.validate_phase5_summary_raw_manifest_boundary(
        summary, tmp_path.resolve(), binding)

    assert loaded["blobs"] == blobs
    assert loaded["blobs"]["faultEventsSha256"] == blobs[
        "faultEventsSha256"]


@pytest.mark.parametrize(
    "artifact",
    [name for name, _path in EXPECTED_ARTIFACTS] + ["rawManifestSha256"],
)
def test_summary_raw_manifest_boundary_rejects_every_digest_rebind(
        tmp_path, artifact):
    summary, binding, _blobs = summary_bound_to_raw_bundle(tmp_path)
    summary["rawArtifacts"][artifact] = "f" * 64

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.validate_phase5_summary_raw_manifest_boundary(
            summary, tmp_path.resolve(), binding)


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(
        runId="ffffffff-ffff-4fff-afff-ffffffffffff"),
    lambda value: value.update(challenge="f" * 64),
    lambda value: value["window"].update(
        startedAtMonotonicMs=2_000,
        endedAtMonotonicMs=1_802_000,
    ),
])
def test_summary_raw_manifest_boundary_rejects_top_or_window_rebind(
        tmp_path, mutation):
    summary, binding, _blobs = summary_bound_to_raw_bundle(tmp_path)
    mutation(summary)

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.validate_phase5_summary_raw_manifest_boundary(
            summary, tmp_path.resolve(), binding)


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schemaVersion=1),
    lambda value: value.update(schemaVersion=2.0),
    lambda value: value.update(kind="phase5-raw-manifest"),
    lambda value: value.update(runId="ffffffff-ffff-1fff-afff-ffffffffffff"),
    lambda value: value.update(challenge="f" * 63),
    lambda value: value["release"].update(releaseRevision="f" * 39),
    lambda value: value["release"].update(hidden=True),
    lambda value: value["geometry"].update(sampleRate=48_000),
    lambda value: value["profile"].update(clients=3),
    lambda value: value["window"].update(endedAtMonotonicMs=1_801_001),
    lambda value: value["window"].update(startedAtUnixMs=True),
    lambda value: value.update(hidden=True),
])
def test_raw_manifest_rejects_invalid_top_binding_and_window(mutation):
    value, binding, _window, _blobs = valid_manifest()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.validate_phase5_raw_manifest_structure(value, binding)


@pytest.mark.parametrize("mutation", [
    lambda value: value["artifacts"].pop(),
    lambda value: value["artifacts"].append(
        copy.deepcopy(value["artifacts"][-1])),
    lambda value: value["artifacts"].reverse(),
    lambda value: value["artifacts"][0].update(
        artifact="stagingMachineAttestationSha256"),
    lambda value: value["artifacts"][0].update(
        path="../fault-events.json"),
    lambda value: value["artifacts"][0].update(
        path="acceptance-evidence/FAULT-events.json"),
    lambda value: value["artifacts"][0].update(byteLength=True),
    lambda value: value["artifacts"][0].update(byteLength=0),
    lambda value: value["artifacts"][0].update(
        byteLength=validator.JS_MAX_SAFE_INTEGER + 1),
    lambda value: value["artifacts"][0].update(sha256="f" * 63),
    lambda value: value["artifacts"][0].update(hidden=True),
])
def test_raw_manifest_rejects_inventory_order_path_size_and_digest_attacks(
        mutation):
    value, binding, _window, _blobs = valid_manifest()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.validate_phase5_raw_manifest_structure(value, binding)


@pytest.mark.parametrize("mutation", [
    lambda value: value.pop("faultEventsSha256"),
    lambda value: value.update(hidden=b"hidden"),
    lambda value: value.update(faultEventsSha256="not-bytes"),
    lambda value: value.update(faultEventsSha256=b""),
])
def test_raw_manifest_builder_rejects_missing_extra_nonbytes_and_empty_blobs(
        mutation):
    binding, window = binding_and_window()
    blobs = raw_blobs()
    mutation(blobs)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.phase5_raw_manifest_from_blobs(binding, window, blobs)


@pytest.mark.parametrize("raw_transform", [
    lambda raw: raw + b"\n",
    lambda raw: b" " + raw,
    lambda raw: raw.replace(
        b'{"artifacts":',
        b'{"schemaVersion":2,"artifacts":',
        1,
    ),
    lambda _raw: b"\xff",
])
def test_raw_manifest_bytes_are_strict_canonical_json(raw_transform):
    value, binding, _window, _blobs = valid_manifest()
    raw = raw_transform(validator.canonical(value))
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.validate_phase5_raw_manifest_bytes(raw, binding)


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(
        runId="ffffffff-ffff-4fff-afff-ffffffffffff"),
    lambda value: value.update(challenge="f" * 64),
    lambda value: value["release"].update(releaseManifestSha256="f" * 64),
    lambda value: value["geometry"].update(poolSize=6),
    lambda value: value["profile"].update(durationMinutes=31),
    lambda value: value.update(hidden=True),
])
def test_raw_manifest_rejects_validly_shaped_but_wrong_expected_binding(
        mutation):
    value, binding, _window, _blobs = valid_manifest()
    mutation(binding)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RAW_MANIFEST_INVALID"):
        validator.validate_phase5_raw_manifest_structure(value, binding)
