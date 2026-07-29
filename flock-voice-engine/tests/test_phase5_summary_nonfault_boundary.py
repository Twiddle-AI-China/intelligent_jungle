from __future__ import annotations

import copy
import hashlib
import importlib.util
import inspect
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"
CROSS_TEST = (
    ROOT
    / "flock-voice-engine/tests/test_phase5_latency_client_cross_binding.py"
)
CLIENT_TEST = ROOT / "flock-voice-engine/tests/test_phase5_client_observations.py"
RENDER_TEST = ROOT / "flock-voice-engine/tests/test_phase5_render_samples.py"
SPECIES_TEST = (
    ROOT / "flock-voice-engine/tests/test_phase5_species_load_samples.py"
)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = load_module("phase5_acceptance_summary_nonfault", TOOL)
summary_fixture = load_module(
    "phase5_summary_fixture_for_nonfault", SUMMARY_TEST)
cross_fixture = load_module(
    "phase5_cross_fixture_for_nonfault", CROSS_TEST)
client_fixture = load_module(
    "phase5_client_fixture_for_nonfault", CLIENT_TEST)
render_fixture = load_module(
    "phase5_render_fixture_for_nonfault", RENDER_TEST)
species_fixture = load_module(
    "phase5_species_fixture_for_nonfault", SPECIES_TEST)


def signed_projection(client_value: dict, binding: dict) -> dict:
    clients = {
        item["client"]: item["clientIdentitySha256"]
        for item in client_value["clients"]
    }
    runtime_opens = [
        {
            "client": event["client"],
            "connectionGeneration": event["connectionGeneration"],
            "atMonotonicMs": event["atMonotonicMs"],
            "atUnixMs": event["atUnixMs"],
            "mode": event["payload"]["mode"],
            "clientIdentitySha256": clients[event["client"]],
        }
        for event in client_value["events"]
        if event["type"] == "runtime.open"
    ]

    def receipt(event_type: str) -> dict:
        event = next(
            item for item in client_value["events"]
            if item["type"] == event_type
        )
        return {
            "connectionGeneration": event["connectionGeneration"],
            "atMonotonicMs": event["atMonotonicMs"],
            "atUnixMs": event["atUnixMs"],
            **copy.deepcopy(event["payload"]),
        }

    discontinuity = next(
        item for item in client_value["events"]
        if item["type"] == "audio.discontinuity"
    )
    return {
        "schemaVersion": 1,
        "kind": "phase5-client-observations-signed-transport-projection",
        **copy.deepcopy(binding),
        "window": copy.deepcopy(client_value["window"]),
        "runtimeOpens": runtime_opens,
        "audioLifecycle": [{
            "client": event["client"],
            "connectionGeneration": event["connectionGeneration"],
            "type": event["type"],
            "atMonotonicMs": event["atMonotonicMs"],
            "atUnixMs": event["atUnixMs"],
            "payload": copy.deepcopy(event["payload"]),
        } for event in client_value["events"] if event["type"] in {
            "audio.open", "audio.close",
        }],
        "slowClient": {
            "client": 4,
            "pause": receipt("audio.pause"),
            "resume": receipt("audio.resume"),
        },
        "discontinuities": [{
            "client": discontinuity["client"],
            "connectionGeneration": discontinuity["connectionGeneration"],
            "atMonotonicMs": discontinuity["atMonotonicMs"],
            "atUnixMs": discontinuity["atUnixMs"],
            "transportSequence":
                client_fixture.DISCONTINUITY_TRANSPORT_SEQUENCE,
            "transportEventSha256":
                client_fixture.DISCONTINUITY_TRANSPORT_SHA256,
            **{
                name: copy.deepcopy(discontinuity["payload"][name])
                for name in (
                    "scope", "audioEpoch", "streamRevision",
                    "blockSeq", "resumeStartFrame",
                )
            },
        }],
    }


def nonfault_values() -> tuple[dict, dict, dict, dict]:
    runtime, ui, client = cross_fixture.validated_cross_binding_inputs()
    render, _binding = render_fixture.valid_render_samples()
    normal, _binding = species_fixture.valid_species_samples("normal")
    burst, _binding = species_fixture.valid_species_samples("burst")
    binding = {
        name: copy.deepcopy(client["value"][name])
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    values = {
        "rawRuntimeReadySamplesSha256":
            copy.deepcopy(runtime["value"]),
        "rawUiStateLagSamplesSha256": copy.deepcopy(ui["value"]),
        "rawRenderSamplesSha256": render,
        "clientObservationsSha256": copy.deepcopy(client["value"]),
        "speciesNormalSamplesSha256": normal,
        "speciesBurstSamplesSha256": burst,
    }
    return values, binding, signed_projection(
        values["clientObservationsSha256"], binding), {
            **runtime["projection"],
            **ui["projection"],
            **validator.validate_phase5_render_samples_bytes(
                validator.canonical(render), binding)["projection"],
        }


def write_bundle(
        root: Path,
        values: dict,
        binding: dict,
        latency_projection: dict) -> dict:
    summary = summary_fixture.structurally_valid_summary()
    blobs = {
        artifact: validator.canonical({
            "artifact": artifact,
            "ordinal": index,
        })
        for index, (artifact, _path) in enumerate(
            validator.PHASE5_RAW_ARTIFACTS, 1)
    }
    for artifact, value in values.items():
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
    summary["acceptanceProjection"]["latency"] = copy.deepcopy(
        latency_projection)
    summary["acceptanceProjection"]["speciesLoad"] = {
        "endpoint": binding["profile"]["speciesEndpoint"],
        "model": binding["profile"]["speciesModel"],
        "normalRequests":
            len(values["speciesNormalSamplesSha256"]["samples"]),
        "burstRequests":
            len(values["speciesBurstSamplesSha256"]["samples"]),
        "errors": 0,
        "normalLatencySamplesSha256": hashlib.sha256(
            blobs["speciesNormalSamplesSha256"]).hexdigest(),
        "burstLatencySamplesSha256": hashlib.sha256(
            blobs["speciesBurstSamplesSha256"]).hexdigest(),
    }
    return summary


def fault_run_binding(summary: dict) -> dict:
    return {
        "runId": summary["runId"],
        "challenge": summary["challenge"],
        "release": copy.deepcopy(summary["release"]),
        "geometry": copy.deepcopy(summary["geometry"]),
        "profile": copy.deepcopy(summary["profile"]),
        "signerSpkiSha256":
            summary["session"]["signerSpkiSha256"],
        "faultSessionEvidenceSha256":
            summary["session"]["faultSessionEvidenceSha256"],
    }


def composite_runner(
        summary: dict,
        signed: dict,
        seen: list | None = None):
    composite = {
        "schemaVersion": 1,
        "kind": "phase5-fault-validation-with-client-projection-result",
        "faultValidation": copy.deepcopy(summary["faultValidation"]),
        "signedTransportProjection": copy.deepcopy(signed),
    }

    def run(path, envelope):
        if seen is not None:
            seen.append((path, envelope))
        return validator.canonical(composite) + b"\n"

    return run


@pytest.mark.parametrize("boundary_name", [
    "validate_phase5_summary_fault_boundary",
    "validate_phase5_summary_fault_projection_boundary",
    "validate_phase5_summary_composite_raw_boundary",
])
def test_public_signed_fault_boundaries_have_no_verifier_injection_seam(
        boundary_name):
    parameters = inspect.signature(
        getattr(validator, boundary_name)
    ).parameters

    assert "verifier_path" not in parameters
    assert "verifier_runner" not in parameters
    assert "verifier_identity" not in parameters
    assert "node_executable" not in parameters


def test_summary_composite_raw_boundary_uses_only_fixed_composite_projection(
        tmp_path, monkeypatch):
    values, binding, signed, latency = nonfault_values()
    summary = write_bundle(tmp_path, values, binding, latency)
    summary["faultValidation"]["evidence"]["faultEventsSha256"] = (
        summary["rawArtifacts"]["faultEventsSha256"])
    real_reader = validator.read_regular_file_no_follow
    reads = []
    seen = []

    def counted(path, code, max_bytes=None):
        reads.append(Path(path))
        return real_reader(path, code, max_bytes=max_bytes)

    monkeypatch.setattr(validator, "read_regular_file_no_follow", counted)

    result = validator._validate_phase5_summary_composite_raw_boundary(
        summary,
        tmp_path.resolve(),
        fault_run_binding(summary),
        verifier_path=Path("trusted-verifier.mjs"),
        verifier_runner=composite_runner(summary, signed, seen),
    )

    assert result["faultComposite"]["signedTransportProjection"] == signed
    assert result["clientObservations"]["projection"][
        "pcmCorruptions"] == 0
    assert result["latencyClientBinding"]["runtimeReadySampleCount"] == 4
    assert len(seen) == 1
    envelope = validator.strict_json_bytes(
        seen[0][1][:-1],
        "PHASE5_SUMMARY_COMPOSITE_RAW_INVALID",
    )
    assert validator.canonical(envelope["evidence"]) == (
        tmp_path / "acceptance-evidence/fault-events.json"
    ).read_bytes()
    bundle_root = tmp_path.resolve()
    bundle_reads = [
        path for path in reads if path.is_relative_to(bundle_root)
    ]
    assert len(bundle_reads) == 15
    assert len(set(bundle_reads)) == 15


def test_summary_composite_raw_boundary_rejects_neutral_projection_kind(
        tmp_path):
    values, binding, signed, latency = nonfault_values()
    summary = write_bundle(tmp_path, values, binding, latency)
    summary["faultValidation"]["evidence"]["faultEventsSha256"] = (
        summary["rawArtifacts"]["faultEventsSha256"])
    signed["kind"] = "phase5-client-observations-transport-projection"

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_COMPOSITE_RAW_INVALID"):
        validator._validate_phase5_summary_composite_raw_boundary(
            summary,
            tmp_path.resolve(),
            fault_run_binding(summary),
            verifier_path=Path("trusted-verifier.mjs"),
            verifier_runner=composite_runner(summary, signed),
        )


def test_summary_nonfault_boundary_reads_manifest_and_leaves_only_once(
        tmp_path, monkeypatch):
    values, binding, signed, latency = nonfault_values()
    summary = write_bundle(tmp_path, values, binding, latency)
    real_reader = validator.read_regular_file_no_follow
    reads = []

    def counted(path, code, max_bytes=None):
        reads.append(Path(path))
        return real_reader(path, code, max_bytes=max_bytes)

    monkeypatch.setattr(validator, "read_regular_file_no_follow", counted)
    result = validator.validate_phase5_summary_nonfault_boundary(
        summary, tmp_path.resolve(), binding, signed)

    assert result["latencyClientBinding"]["runtimeReadySampleCount"] == 4
    assert result["clientObservations"]["projection"][
        "pcmCorruptions"
    ] == 0
    assert result["species"]["projection"] == (
        summary["acceptanceProjection"]["speciesLoad"])
    # One summary-schema read plus one manifest and fourteen fixed leaves.
    assert len(reads) == 16
    assert len(set(reads)) == 16


def test_summary_nonfault_boundary_rejects_ui_frame_rebound_from_client_raw(
        tmp_path):
    values, binding, signed, latency = nonfault_values()
    values["rawUiStateLagSamplesSha256"]["samples"][0][
        "snapshotFrameSha256"
    ] = "f" * 64
    summary = write_bundle(tmp_path, values, binding, latency)

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_NONFAULT_INVALID"):
        validator.validate_phase5_summary_nonfault_boundary(
            summary, tmp_path.resolve(), binding, signed)


def test_summary_nonfault_boundary_rejects_untrusted_transport_rebind(
        tmp_path):
    values, binding, signed, latency = nonfault_values()
    signed["slowClient"]["pause"]["transportEventSha256"] = "f" * 64
    summary = write_bundle(tmp_path, values, binding, latency)

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SUMMARY_NONFAULT_INVALID"):
        validator.validate_phase5_summary_nonfault_boundary(
            summary, tmp_path.resolve(), binding, signed)
