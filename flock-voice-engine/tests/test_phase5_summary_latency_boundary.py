from __future__ import annotations

import copy
import hashlib
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"
LATENCY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_latency_samples.py"
RENDER_TEST = ROOT / "flock-voice-engine/tests/test_phase5_render_samples.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_summary_latency_boundary", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

summary_spec = importlib.util.spec_from_file_location(
    "phase5_summary_fixture_for_summary_latency_boundary", SUMMARY_TEST)
summary_fixture = importlib.util.module_from_spec(summary_spec)
summary_spec.loader.exec_module(summary_fixture)

latency_spec = importlib.util.spec_from_file_location(
    "phase5_latency_fixture_for_summary_latency_boundary", LATENCY_TEST)
latency_fixture = importlib.util.module_from_spec(latency_spec)
latency_spec.loader.exec_module(latency_fixture)

render_spec = importlib.util.spec_from_file_location(
    "phase5_render_fixture_for_summary_latency_boundary", RENDER_TEST)
render_fixture = importlib.util.module_from_spec(render_spec)
render_spec.loader.exec_module(render_fixture)


def valid_raw_values() -> dict[str, dict]:
    runtime, _binding = latency_fixture.valid_runtime_ready_samples()
    ui, _binding = latency_fixture.valid_ui_state_lag_samples()
    render, _binding = render_fixture.valid_render_samples()
    return {
        "rawRuntimeReadySamplesSha256": runtime,
        "rawUiStateLagSamplesSha256": ui,
        "rawRenderSamplesSha256": render,
    }


def write_bundle(
        root: Path,
        raw_values: dict[str, dict]) -> tuple[dict, dict, dict]:
    summary = summary_fixture.structurally_valid_summary()
    binding = {
        name: copy.deepcopy(summary[name])
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    blobs = {
        artifact: validator.canonical({
            "artifact": artifact,
            "ordinal": index,
        })
        for index, (artifact, _path) in enumerate(
            validator.PHASE5_RAW_ARTIFACTS, 1)
    }
    for artifact, value in raw_values.items():
        blobs[artifact] = validator.canonical(value)
    manifest = validator.phase5_raw_manifest_from_blobs(
        binding, summary["window"], blobs)
    for artifact, path in validator.PHASE5_RAW_ARTIFACTS:
        destination = root.joinpath(*path.split("/"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(blobs[artifact])
    manifest_raw = validator.canonical(manifest)
    (
        root / "acceptance-evidence/phase5-raw-manifest.json"
    ).write_bytes(manifest_raw)
    summary["rawArtifacts"].update({
        item["artifact"]: item["sha256"]
        for item in manifest["artifacts"]
    })
    summary["rawArtifacts"]["rawManifestSha256"] = hashlib.sha256(
        manifest_raw).hexdigest()
    projection = {}
    projection.update(
        validator.validate_phase5_runtime_ready_samples_bytes(
            blobs["rawRuntimeReadySamplesSha256"], binding)["projection"])
    projection.update(
        validator.validate_phase5_ui_state_lag_samples_bytes(
            blobs["rawUiStateLagSamplesSha256"], binding)["projection"])
    projection.update(
        validator.validate_phase5_render_samples_bytes(
            blobs["rawRenderSamplesSha256"], binding)["projection"])
    summary["acceptanceProjection"]["latency"] = copy.deepcopy(projection)
    return summary, binding, projection


def test_summary_latency_boundary_recomputes_all_four_values_from_one_bundle(
        tmp_path):
    summary, binding, projection = write_bundle(
        tmp_path, valid_raw_values())

    result = validator.validate_phase5_summary_latency_boundary(
        summary, tmp_path.resolve(), binding)

    assert result["projection"] == projection
    assert set(result["loaded"]["blobs"]) == {
        name for name, _path in validator.PHASE5_RAW_ARTIFACTS
    }


def test_summary_latency_boundary_accepts_node_integer_percentile_spelling(
        tmp_path):
    summary, binding, projection = write_bundle(
        tmp_path, valid_raw_values())
    for field in ("runtimeReadyP95Ms", "uiStateLagP95Ms"):
        assert projection[field].is_integer()
        summary["acceptanceProjection"]["latency"][field] = int(
            projection[field])

    result = validator.validate_phase5_summary_latency_boundary(
        summary, tmp_path.resolve(), binding)

    assert result["projection"]["runtimeReadyP95Ms"] == 100
    assert result["projection"]["uiStateLagP95Ms"] == 100


def test_summary_latency_boundaries_accept_node_zero_render_spelling(tmp_path):
    raw_values = valid_raw_values()
    for sample in raw_values["rawRenderSamplesSha256"]["samples"]:
        sample["renderP95Ms"] = 0
        sample["renderP99Ms"] = 0
    summary, binding, projection = write_bundle(tmp_path, raw_values)
    assert projection["renderP95BlockFraction"] == 0.0
    assert projection["renderP99BlockFraction"] == 0.0
    summary["acceptanceProjection"]["latency"].update(
        renderP95BlockFraction=0,
        renderP99BlockFraction=0,
    )

    render_result = validator.validate_phase5_summary_render_boundary(
        summary, tmp_path.resolve(), binding)
    latency_result = validator.validate_phase5_summary_latency_boundary(
        summary, tmp_path.resolve(), binding)

    assert render_result["render"]["projection"] == {
        "renderP95BlockFraction": 0.0,
        "renderP99BlockFraction": 0.0,
    }
    assert latency_result["projection"]["renderP95BlockFraction"] == 0.0


@pytest.mark.parametrize("field", [
    "runtimeReadyP95Ms",
    "uiStateLagP95Ms",
    "renderP95BlockFraction",
    "renderP99BlockFraction",
])
def test_summary_latency_boundary_rejects_each_unrecomputed_claim(
        tmp_path, field):
    summary, binding, _projection = write_bundle(
        tmp_path, valid_raw_values())
    summary["acceptanceProjection"]["latency"][field] += 0.000001

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_LATENCY_INVALID"):
        validator.validate_phase5_summary_latency_boundary(
            summary, tmp_path.resolve(), binding)


def test_summary_latency_boundary_rejects_rehashed_runtime_with_stale_claim(
        tmp_path):
    raw_values = valid_raw_values()
    original_summary, _binding, _projection = write_bundle(
        tmp_path, raw_values)
    stale_latency = copy.deepcopy(
        original_summary["acceptanceProjection"]["latency"])
    for sample in raw_values["rawRuntimeReadySamplesSha256"]["samples"]:
        sample["readyAtMonotonicMs"] += 1
        sample["readyAtUnixMs"] += 1
    rebound_summary, binding, _projection = write_bundle(
        tmp_path, raw_values)
    rebound_summary["acceptanceProjection"]["latency"] = stale_latency

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_LATENCY_INVALID"):
        validator.validate_phase5_summary_latency_boundary(
            rebound_summary, tmp_path.resolve(), binding)


def test_summary_latency_boundary_maps_invalid_owned_leaf_to_stable_code(
        tmp_path):
    raw_values = valid_raw_values()
    raw_values["rawUiStateLagSamplesSha256"]["samples"][0][
        "snapshotFrameSha256"
    ] = "x" * 64
    summary = summary_fixture.structurally_valid_summary()
    binding = {
        name: copy.deepcopy(summary[name])
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    blobs = {
        artifact: validator.canonical({
            "artifact": artifact,
            "ordinal": index,
        })
        for index, (artifact, _path) in enumerate(
            validator.PHASE5_RAW_ARTIFACTS, 1)
    }
    for artifact, value in raw_values.items():
        blobs[artifact] = validator.canonical(value)
    manifest = validator.phase5_raw_manifest_from_blobs(
        binding, summary["window"], blobs)
    for artifact, path in validator.PHASE5_RAW_ARTIFACTS:
        destination = tmp_path.joinpath(*path.split("/"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(blobs[artifact])
    manifest_raw = validator.canonical(manifest)
    (
        tmp_path / "acceptance-evidence/phase5-raw-manifest.json"
    ).write_bytes(manifest_raw)
    summary["rawArtifacts"].update({
        item["artifact"]: item["sha256"]
        for item in manifest["artifacts"]
    })
    summary["rawArtifacts"]["rawManifestSha256"] = hashlib.sha256(
        manifest_raw).hexdigest()

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_LATENCY_INVALID"):
        validator.validate_phase5_summary_latency_boundary(
            summary, tmp_path.resolve(), binding)
