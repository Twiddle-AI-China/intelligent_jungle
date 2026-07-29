from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"
SPECIES_TEST = ROOT / "flock-voice-engine/tests/test_phase5_species_load_samples.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_summary_species_boundary", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

summary_spec = importlib.util.spec_from_file_location(
    "phase5_summary_fixture_for_summary_species_boundary", SUMMARY_TEST)
summary_fixture = importlib.util.module_from_spec(summary_spec)
summary_spec.loader.exec_module(summary_fixture)

species_spec = importlib.util.spec_from_file_location(
    "phase5_species_fixture_for_summary_species_boundary", SPECIES_TEST)
species_fixture = importlib.util.module_from_spec(species_spec)
species_spec.loader.exec_module(species_fixture)


def write_bundle(
        root: Path,
        normal: dict,
        burst: dict) -> tuple[dict, dict, dict]:
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
    blobs["speciesNormalSamplesSha256"] = validator.canonical(normal)
    blobs["speciesBurstSamplesSha256"] = validator.canonical(burst)
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
    projection = {
        "endpoint": binding["profile"]["speciesEndpoint"],
        "model": binding["profile"]["speciesModel"],
        "normalRequests": len(normal["samples"]),
        "burstRequests": len(burst["samples"]),
        "errors": 0,
        "normalLatencySamplesSha256": hashlib.sha256(
            blobs["speciesNormalSamplesSha256"]).hexdigest(),
        "burstLatencySamplesSha256": hashlib.sha256(
            blobs["speciesBurstSamplesSha256"]).hexdigest(),
    }
    summary["acceptanceProjection"]["speciesLoad"] = copy.deepcopy(
        projection)
    return summary, binding, projection


def valid_bundle(root: Path) -> tuple[dict, dict, dict]:
    normal, _binding = species_fixture.valid_species_samples("normal")
    burst, _binding = species_fixture.valid_species_samples("burst")
    return write_bundle(root, normal, burst)


def test_summary_species_boundary_recomputes_counts_and_digests(tmp_path):
    summary, binding, projection = valid_bundle(tmp_path)

    result = validator.validate_phase5_summary_species_boundary(
        summary, tmp_path.resolve(), binding)

    assert result["projection"] == projection
    assert result["normal"]["requestCount"] == projection["normalRequests"]
    assert result["burst"]["requestCount"] == projection["burstRequests"]


@pytest.mark.parametrize("field", [
    "endpoint",
    "model",
    "normalRequests",
    "burstRequests",
    "errors",
    "normalLatencySamplesSha256",
    "burstLatencySamplesSha256",
])
def test_summary_species_boundary_rejects_each_unrecomputed_claim(
        tmp_path, field):
    summary, binding, _projection = valid_bundle(tmp_path)
    value = summary["acceptanceProjection"]["speciesLoad"][field]
    if isinstance(value, int):
        summary["acceptanceProjection"]["speciesLoad"][field] = value + 1
    elif field.endswith("Sha256"):
        summary["acceptanceProjection"]["speciesLoad"][field] = "f" * 64
    else:
        summary["acceptanceProjection"]["speciesLoad"][field] = "other"

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_SPECIES_INVALID"):
        validator.validate_phase5_summary_species_boundary(
            summary, tmp_path.resolve(), binding)


def test_summary_species_boundary_rejects_rehashed_raw_with_stale_digest(
        tmp_path):
    normal, _binding = species_fixture.valid_species_samples("normal")
    burst, _binding = species_fixture.valid_species_samples("burst")
    original_summary, _binding, _projection = write_bundle(
        tmp_path, normal, burst)
    stale_species = copy.deepcopy(
        original_summary["acceptanceProjection"]["speciesLoad"])
    alternate_body = validator.canonical({
        "choices": [{
            "message": {
                "content": ' { "ok" : true } ',
            },
        }],
    })
    normal["samples"][0]["responseBodyBase64"] = base64.b64encode(
        alternate_body).decode("ascii")
    rebound_summary, binding, _projection = write_bundle(
        tmp_path, normal, burst)
    rebound_summary["acceptanceProjection"]["speciesLoad"] = stale_species

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_SPECIES_INVALID"):
        validator.validate_phase5_summary_species_boundary(
            rebound_summary, tmp_path.resolve(), binding)


def test_summary_species_boundary_maps_invalid_owned_response_to_stable_code(
        tmp_path):
    normal, _binding = species_fixture.valid_species_samples("normal")
    burst, _binding = species_fixture.valid_species_samples("burst")
    normal["samples"][0]["responseBodyBase64"] = base64.b64encode(
        b'{"choices":[]}').decode("ascii")
    summary, binding, _projection = write_bundle(tmp_path, normal, burst)

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_SPECIES_INVALID"):
        validator.validate_phase5_summary_species_boundary(
            summary, tmp_path.resolve(), binding)
