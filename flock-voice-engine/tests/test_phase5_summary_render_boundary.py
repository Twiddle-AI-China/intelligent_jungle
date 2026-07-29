from __future__ import annotations

import copy
import hashlib
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"
RENDER_TEST = ROOT / "flock-voice-engine/tests/test_phase5_render_samples.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_summary_render_boundary", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

summary_spec = importlib.util.spec_from_file_location(
    "phase5_summary_fixture_for_summary_render_boundary", SUMMARY_TEST)
summary_fixture = importlib.util.module_from_spec(summary_spec)
summary_spec.loader.exec_module(summary_fixture)

render_spec = importlib.util.spec_from_file_location(
    "phase5_render_fixture_for_summary_render_boundary", RENDER_TEST)
render_fixture = importlib.util.module_from_spec(render_spec)
render_spec.loader.exec_module(render_fixture)


def write_bundle(root: Path, render_value: dict) -> tuple[dict, dict]:
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
    blobs["rawRenderSamplesSha256"] = validator.canonical(render_value)
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
    projection = validator.validate_phase5_render_samples_bytes(
        blobs["rawRenderSamplesSha256"], binding)["projection"]
    summary["acceptanceProjection"]["latency"].update(projection)
    return summary, binding


def test_summary_render_boundary_recomputes_projection_from_manifest_owned_bytes(
        tmp_path):
    render, _render_binding = render_fixture.valid_render_samples()
    summary, binding = write_bundle(tmp_path, render)

    result = validator.validate_phase5_summary_render_boundary(
        summary, tmp_path.resolve(), binding)

    assert result["render"]["projection"] == {
        "renderP95BlockFraction":
            10 / validator.PHASE5_RENDER_BLOCK_DURATION_MS,
        "renderP99BlockFraction":
            20 / validator.PHASE5_RENDER_BLOCK_DURATION_MS,
    }
    assert result["loaded"]["blobs"]["rawRenderSamplesSha256"] == (
        validator.canonical(render)
    )


def test_summary_render_boundary_rejects_claim_changed_without_raw_change(
        tmp_path):
    render, _render_binding = render_fixture.valid_render_samples()
    summary, binding = write_bundle(tmp_path, render)
    summary["acceptanceProjection"]["latency"][
        "renderP95BlockFraction"
    ] += 0.000001

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_RENDER_INVALID"):
        validator.validate_phase5_summary_render_boundary(
            summary, tmp_path.resolve(), binding)


def test_summary_render_boundary_rejects_rehashed_raw_with_stale_projection(
        tmp_path):
    original, _render_binding = render_fixture.valid_render_samples()
    original_summary, _binding = write_bundle(tmp_path, original)
    expected_projection = copy.deepcopy(
        original_summary["acceptanceProjection"]["latency"])

    changed = copy.deepcopy(original)
    for sample in changed["samples"]:
        sample["renderP95Ms"] = 11
    rebound_summary, binding = write_bundle(tmp_path, changed)
    rebound_summary["acceptanceProjection"]["latency"] = expected_projection

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_RENDER_INVALID"):
        validator.validate_phase5_summary_render_boundary(
            rebound_summary, tmp_path.resolve(), binding)


def test_summary_render_boundary_maps_invalid_render_leaf_to_stable_code(
        tmp_path):
    render, _render_binding = render_fixture.valid_render_samples()
    render["samples"][0]["recentUnderruns"] = 1
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
    blobs["rawRenderSamplesSha256"] = validator.canonical(render)
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
            match="PHASE5_SUMMARY_RENDER_INVALID"):
        validator.validate_phase5_summary_render_boundary(
            summary, tmp_path.resolve(), binding)
