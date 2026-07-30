from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import inspect
import json
import os
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
ACCEPTANCE_TEST = ROOT / "flock-voice-engine/tests/test_phase5_acceptance.py"
MACHINE_TEST = ROOT / "flock-voice-engine/tests/test_machine_attestation.py"


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
acceptance_fixture = load_module(
    "phase5_acceptance_fixture_for_owned_summary", ACCEPTANCE_TEST)
machine_fixture = load_module(
    "phase5_machine_fixture_for_owned_summary", MACHINE_TEST)


OWNED_TOOL_SOURCES = (
    ("validate_phase5_acceptance.py", TOOL),
    (
        "acceptance.schema.json",
        ROOT / "flock-voice-engine/release/acceptance.schema.json",
    ),
    (
        "machine-attestation.schema.json",
        ROOT / "flock-voice-engine/release/machine-attestation.schema.json",
    ),
    (
        "phase5-summary/phase5-summary.schema.json",
        ROOT / "flock-voice-engine/release/phase5-summary.schema.json",
    ),
    (
        "phase5-summary/soak-phase5.mjs",
        ROOT / "flock-voice-engine/runtime/tools/soak-phase5.mjs",
    ),
    (
        "phase5-summary/capture_machine_attestation.py",
        ROOT / "flock-voice-engine/tools/capture_machine_attestation.py",
    ),
    (
        "phase5-fault-verifier/verify-phase5-fault-evidence.mjs",
        ROOT / "flock-voice-engine/runtime/tools/"
        "verify-phase5-fault-evidence.mjs",
    ),
    (
        "phase5-fault-verifier/lib/phase5-fault-evidence.mjs",
        ROOT / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-evidence.mjs",
    ),
    (
        "phase5-fault-verifier/lib/phase5-fault-validation.mjs",
        ROOT / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-validation.mjs",
    ),
    (
        "phase5-fault-verifier/lib/phase5-fault-transport-projection.mjs",
        ROOT / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-transport-projection.mjs",
    ),
    (
        "phase5-fault-verifier/lib/phase5-fault-semantics.mjs",
        ROOT / "flock-voice-engine/runtime/tools/lib/"
        "phase5-fault-semantics.mjs",
    ),
    (
        "phase5-fault-verifier/verify-phase5-capture-proof.mjs",
        ROOT / "flock-voice-engine/runtime/tools/"
        "verify-phase5-capture-proof.mjs",
    ),
    (
        "src/capture/phase5-capture-proof.js",
        ROOT / "flock-voice-engine/runtime/src/capture/"
        "phase5-capture-proof.js",
    ),
    (
        "src/capture/capture-wire.js",
        ROOT / "flock-voice-engine/runtime/src/capture/capture-wire.js",
    ),
)


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


def owned_summary_inputs(tmp_path):
    values, _fixture_binding, _fixture_signed, _fixture_latency = (
        nonfault_values()
    )
    tool_artifacts = tuple(
        (name, path.read_bytes())
        for name, path in OWNED_TOOL_SOURCES
    )
    tool_identity = {
        name: hashlib.sha256(raw).hexdigest()
        for name, raw in tool_artifacts
    }
    source_raw = validator.phase5_canonical({
        "schemaVersion": 1,
        "entries": [],
    })
    worker_identity = {
        "releaseRevision": "b" * 40,
        "sourceManifestSha256": hashlib.sha256(source_raw).hexdigest(),
        "audioArtifactSha256": "c" * 64,
    }
    release_manifest = {
        "workerIdentity": copy.deepcopy(worker_identity),
        "geometry": copy.deepcopy(
            summary_fixture.structurally_valid_summary()["geometry"]
        ),
        "productionGraphSha256": hashlib.sha256(b"{}").hexdigest(),
        "deployExecutionIdentity": copy.deepcopy(tool_identity),
    }
    release_raw = validator.phase5_canonical(release_manifest)
    binding = {
        "runId": "123e4567-e89b-42d3-a456-426614174000",
        "challenge": "a" * 64,
        "release": {
            "releaseManifestSha256":
                hashlib.sha256(release_raw).hexdigest(),
            **copy.deepcopy(worker_identity),
        },
        "geometry": copy.deepcopy(release_manifest["geometry"]),
        "profile": copy.deepcopy(
            summary_fixture.structurally_valid_summary()["profile"]
        ),
    }
    for value in values.values():
        for name, item in binding.items():
            value[name] = copy.deepcopy(item)
    signed = signed_projection(
        values["clientObservationsSha256"],
        binding,
    )
    latency = {
        **validator.validate_phase5_runtime_ready_samples_bytes(
            validator.phase5_canonical(
                values["rawRuntimeReadySamplesSha256"]
            ),
            binding,
        )["projection"],
        **validator.validate_phase5_ui_state_lag_samples_bytes(
            validator.phase5_canonical(
                values["rawUiStateLagSamplesSha256"]
            ),
            binding,
        )["projection"],
        **validator.validate_phase5_render_samples_bytes(
            validator.phase5_canonical(
                values["rawRenderSamplesSha256"]
            ),
            binding,
        )["projection"],
    }

    production_path = tmp_path / "production-machine-attestation.json"
    production_value = machine_fixture.attestation()
    production_evidence = machine_fixture.write_machine_evidence(
        production_path,
        production_value,
    )
    production_bundle = validator.OwnedPhase5AttestationBundle(
        production_path.read_bytes(),
        tuple(
            (name, (production_evidence / name).read_bytes())
            for name in sorted(os.listdir(production_evidence))
        ),
    )

    legacy_root = tmp_path / "legacy"
    legacy_root.mkdir()
    legacy = acceptance_fixture.build_valid_evidence_bundle(
        legacy_root,
        release_manifest,
    )
    summary_template = summary_fixture.structurally_valid_summary()
    soak = json.loads(
        (legacy["raw"] / "soak-run.json").read_bytes()
    )
    soak.update({
        "startedAtUnixMs": summary_template["window"]["startedAtUnixMs"],
        "endedAtUnixMs": summary_template["window"]["endedAtUnixMs"],
    })
    lease_raw = legacy["lease_path"].read_bytes()
    e2e_raw = (legacy["raw"] / "phase5-e2e.json").read_bytes()
    checklist_raw = validator.phase5_canonical(
        summary_template["acceptanceProjection"]["operatorListening"]
    )

    blobs = {
        artifact: validator.phase5_canonical({
            "artifact": artifact,
            "ordinal": index,
        })
        for index, (artifact, _path) in enumerate(
            validator.PHASE5_RAW_ARTIFACTS,
            start=1,
        )
    }
    blobs.update({
        artifact: validator.phase5_canonical(value)
        for artifact, value in values.items()
    })
    blobs["faultEventsSha256"] = validator.phase5_canonical({
        "schemaVersion": 2,
        "kind": "owned-summary-fault-fixture",
    })
    blobs["soakRunSha256"] = validator.phase5_canonical(soak)
    blobs["phase5E2eSha256"] = e2e_raw
    blobs["leaseEvidenceSha256"] = lease_raw
    blobs["productionGraphSha256"] = b"{}"
    blobs["productionMachineAttestationSha256"] = (
        production_bundle.attestation_raw
    )
    blobs["listeningChecklistSha256"] = checklist_raw
    blobs["equivalenceSha256"] = validator.phase5_canonical({
        "schemaVersion": 1,
        "kind": "isolated-equivalent-spark",
        "productionMachineAttestationSha256": hashlib.sha256(
            production_bundle.attestation_raw
        ).hexdigest(),
        "gpuModel": "NVIDIA GB10",
        "architecture": "aarch64",
        "sampleRate": binding["geometry"]["sampleRate"],
        "blockFrames": binding["geometry"]["blockFrames"],
        "poolSize": binding["geometry"]["poolSize"],
        "speciesLoadEndpoint": binding["profile"]["speciesEndpoint"],
        "speciesModel": binding["profile"]["speciesModel"],
    })
    manifest = validator.phase5_raw_manifest_from_blobs(
        binding,
        summary_template["window"],
        blobs,
    )
    manifest_raw = validator.phase5_canonical(manifest)
    manifest_sha256 = hashlib.sha256(manifest_raw).hexdigest()
    raw_bundle = validator.OwnedPhase5RawBundle(
        manifest_raw,
        tuple(
            (artifact, blobs[artifact])
            for artifact, _path in validator.PHASE5_RAW_ARTIFACTS
        ),
    )

    session = {
        "schemaVersion": 2,
        "kind": "phase5-fault-session-attestation",
        **copy.deepcopy(binding),
        "signer": {
            "algorithm": "Ed25519",
            "publicKeySpkiDerBase64": base64.b64encode(
                machine_fixture.ED25519_SPKI
            ).decode("ascii"),
            "publicKeySpkiSha256": hashlib.sha256(
                machine_fixture.ED25519_SPKI
            ).hexdigest(),
        },
        "captureProof": {
            "captureNonce": "8" * 64,
            "rawManifestSha256": manifest_sha256,
            "signature": base64.b64encode(b"\0" * 64).decode("ascii"),
        },
    }
    session_raw = validator.phase5_canonical(session)
    full_binding = {
        **copy.deepcopy(binding),
        "signerSpkiSha256":
            session["signer"]["publicKeySpkiSha256"],
        "faultSessionEvidenceSha256": hashlib.sha256(
            session_raw
        ).hexdigest(),
        "captureNonce": session["captureProof"]["captureNonce"],
        "rawManifestSha256": manifest_sha256,
    }
    capture_validation = {
        "schemaVersion": 1,
        "kind": "phase5-capture-proof-validation-result",
        "passed": True,
        **copy.deepcopy(full_binding),
    }
    capture_boundary = {
        "schemaVersion": 1,
        "kind": "phase5-capture-proof-boundary-result",
        "captureValidation": capture_validation,
        "faultRunBindingProjection":
            validator.phase5_fault_run_binding_projection(full_binding),
    }
    session_bundle = validator.OwnedPhase5SessionBundle(
        session_raw,
        validator.phase5_canonical(full_binding),
        validator.phase5_canonical(capture_boundary),
    )

    capture = machine_fixture.import_capture(
        "capture_machine_owned_summary_fixture"
    )
    staging_blobs = {
        **machine_fixture.fixed_staging_host_evidence(),
        "vllm-normal-profile.json":
            blobs["speciesNormalSamplesSha256"],
        "vllm-burst-profile.json":
            blobs["speciesBurstSamplesSha256"],
        "fault-session-attestation.json": session_raw,
    }
    staging_value = capture._attestation_value(
        staging_blobs,
        "staging-phase5",
        full_binding,
        include_hostname=False,
    )
    staging_bundle = validator.OwnedPhase5AttestationBundle(
        validator.phase5_canonical(staging_value),
        tuple(
            (name, staging_blobs[name])
            for name in capture.STAGING_EVIDENCE_FILES
        ),
    )
    release_bundle = validator.OwnedPhase5ReleaseBundle(
        release_raw,
        source_raw,
    )
    tool_bundle = validator.OwnedPhase5ToolBundle(tool_artifacts)

    expected = summary_fixture.structurally_valid_summary()
    for name, item in binding.items():
        expected[name] = copy.deepcopy(item)
    expected["window"] = copy.deepcopy(manifest["window"])
    expected["session"] = {
        "signerSpkiSha256": full_binding["signerSpkiSha256"],
        "faultSessionEvidenceSha256":
            full_binding["faultSessionEvidenceSha256"],
    }
    expected["rawArtifacts"] = {
        **{
            item["artifact"]: item["sha256"]
            for item in manifest["artifacts"]
        },
        "rawManifestSha256": manifest_sha256,
        "stagingMachineAttestationSha256": hashlib.sha256(
            staging_bundle.attestation_raw
        ).hexdigest(),
    }
    expected["faultValidation"].update({
        **copy.deepcopy(binding),
        "window": copy.deepcopy(manifest["window"]),
        "signerSpkiSha256": full_binding["signerSpkiSha256"],
        "faultSessionEvidenceSha256":
            full_binding["faultSessionEvidenceSha256"],
    })
    expected["faultValidation"]["evidence"]["faultEventsSha256"] = (
        expected["rawArtifacts"]["faultEventsSha256"]
    )
    expected["acceptanceProjection"].update({
        "release": copy.deepcopy(binding["release"]),
        "geometry": copy.deepcopy(binding["geometry"]),
        "latency": latency,
        "speciesLoad": {
            "endpoint": binding["profile"]["speciesEndpoint"],
            "model": binding["profile"]["speciesModel"],
            "normalRequests": len(
                values["speciesNormalSamplesSha256"]["samples"]
            ),
            "burstRequests": len(
                values["speciesBurstSamplesSha256"]["samples"]
            ),
            "errors": 0,
            "normalLatencySamplesSha256": hashlib.sha256(
                blobs["speciesNormalSamplesSha256"]
            ).hexdigest(),
            "burstLatencySamplesSha256": hashlib.sha256(
                blobs["speciesBurstSamplesSha256"]
            ).hexdigest(),
        },
    })
    tool_digests = {
        name: hashlib.sha256(body).hexdigest()
        for name, body in tool_bundle.artifacts
    }
    expected["acceptanceTool"] = {
        "validatePhase5AcceptancePySha256":
            tool_digests["validate_phase5_acceptance.py"],
        "phase5SummarySchemaSha256":
            tool_digests["phase5-summary/phase5-summary.schema.json"],
        "acceptanceSchemaSha256":
            tool_digests["acceptance.schema.json"],
        "soakPhase5MjsSha256":
            tool_digests["phase5-summary/soak-phase5.mjs"],
        "captureMachineAttestationPySha256":
            tool_digests[
                "phase5-summary/capture_machine_attestation.py"
            ],
        **{
            summary_name: tool_digests[deploy_name]
            for deploy_name, summary_name
            in validator.PHASE5_FAULT_VERIFIER_SUMMARY_FIELDS
        },
    }
    return (
        expected,
        raw_bundle,
        session_bundle,
        production_bundle,
        staging_bundle,
        release_bundle,
        tool_bundle,
        signed,
    )


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
    capture_nonce = "8" * 64
    session_raw = validator.phase5_canonical({
        "schemaVersion": 2,
        "kind": "phase5-fault-session-attestation",
        "runId": summary["runId"],
        "challenge": summary["challenge"],
        "release": copy.deepcopy(summary["release"]),
        "geometry": copy.deepcopy(summary["geometry"]),
        "profile": copy.deepcopy(summary["profile"]),
        "signer": {
            "algorithm": "Ed25519",
            "publicKeySpkiDerBase64": "A" * 60,
            "publicKeySpkiSha256":
                summary["session"]["signerSpkiSha256"],
        },
        "captureProof": {
            "captureNonce": capture_nonce,
            "rawManifestSha256":
                summary["rawArtifacts"]["rawManifestSha256"],
            "signature": "A" * 88,
        },
    })
    session_sha256 = hashlib.sha256(session_raw).hexdigest()
    summary["session"]["faultSessionEvidenceSha256"] = session_sha256
    summary["faultValidation"][
        "faultSessionEvidenceSha256"
    ] = session_sha256
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

    capture_validation = {
        "schemaVersion": 1,
        "kind": "phase5-capture-proof-validation-result",
        "passed": True,
        **{
            name: copy.deepcopy(summary[name])
            for name in (
                "runId", "challenge", "release", "geometry", "profile",
            )
        },
        "signerSpkiSha256":
            summary["session"]["signerSpkiSha256"],
        "faultSessionEvidenceSha256": session_sha256,
        "captureNonce": capture_nonce,
        "rawManifestSha256":
            summary["rawArtifacts"]["rawManifestSha256"],
    }
    capture_boundary = {
        "schemaVersion": 1,
        "kind": "phase5-capture-proof-boundary-result",
        "captureValidation": capture_validation,
        "faultRunBindingProjection": fault_run_binding(summary),
    }
    captured = validator._compose_phase5_captured_summary_result(
        capture_boundary,
        session_raw,
        result,
        summary["rawArtifacts"]["rawManifestSha256"],
    )

    assert captured == {
        "schemaVersion": 1,
        "kind": "phase5-captured-summary-boundary-result",
        "sessionRaw": session_raw,
        "captureValidation": capture_validation,
        "faultRunBindingProjection": fault_run_binding(summary),
        "summaryComposite": result,
    }
    with pytest.raises(
            validator.AcceptanceError,
            match=r"^PHASE5_CAPTURED_SUMMARY_INVALID$"):
        validator._compose_phase5_captured_summary_result(
            capture_boundary,
            session_raw,
            result,
            "f" * 64,
        )


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


def owned_five_field_binding(expected):
    return {
        name: copy.deepcopy(expected[name])
        for name in (
            "runId", "challenge", "release", "geometry", "profile",
        )
    }


def replace_owned_raw_artifact(
        raw_bundle, binding, artifact, replacement):
    loaded = validator.validate_phase5_owned_raw_bundle(
        raw_bundle,
        binding,
    )
    blobs = dict(loaded["blobs"])
    blobs[artifact] = replacement
    manifest = validator.phase5_raw_manifest_from_blobs(
        binding,
        loaded["manifest"]["window"],
        blobs,
    )
    return validator.OwnedPhase5RawBundle(
        validator.phase5_canonical(manifest),
        tuple(
            (name, blobs[name])
            for name, _path in validator.PHASE5_RAW_ARTIFACTS
        ),
    )


def test_owned_prearm_boundary_has_only_external_binding_and_byte_bundles():
    parameters = inspect.signature(
        validator.validate_phase5_prearm_owned_bundle
    ).parameters

    assert tuple(parameters) == (
        "raw_bundle",
        "expected_binding",
        "production_attestation_bundle",
        "release_bundle",
        "tool_bundle",
    )
    forbidden = {
        "root",
        "path",
        "runner",
        "session",
        "staging",
        "capture_boundary",
        "node_executable",
    }
    assert forbidden.isdisjoint(parameters)
    assert all(
        parameter.annotation not in {Path, "Path"}
        for parameter in parameters.values()
    )


def test_owned_prearm_boundary_recomputes_all_session_independent_evidence(
        tmp_path, monkeypatch):
    (
        expected,
        raw_bundle,
        _session_bundle,
        production_bundle,
        _staging_bundle,
        release_bundle,
        tool_bundle,
        _signed,
    ) = owned_summary_inputs(tmp_path)
    binding = owned_five_field_binding(expected)
    graph_calls = []
    monkeypatch.setattr(
        validator,
        "_validate_phase5_production_graph_owned_bundle",
        lambda raw, release: graph_calls.append((raw, release)),
    )
    monkeypatch.setattr(
        validator,
        "read_regular_file_no_follow",
        lambda *_args, **_kwargs: pytest.fail("prearm reopened a path"),
    )
    monkeypatch.setattr(
        Path,
        "read_bytes",
        lambda *_args, **_kwargs: pytest.fail("prearm reopened a path"),
    )

    result = validator.validate_phase5_prearm_owned_bundle(
        raw_bundle,
        binding,
        production_bundle,
        release_bundle,
        tool_bundle,
    )

    assert result == {
        "schemaVersion": 1,
        "kind": "phase5-prearm-owned-validation-result",
        "binding": binding,
        "rawManifestSha256": hashlib.sha256(
            raw_bundle.manifest_raw
        ).hexdigest(),
        "releaseManifestSha256": hashlib.sha256(
            release_bundle.release_manifest_raw
        ).hexdigest(),
        "sourceManifestSha256": hashlib.sha256(
            release_bundle.source_manifest_raw
        ).hexdigest(),
        "productionGraphSha256": hashlib.sha256(b"{}").hexdigest(),
        "productionMachineAttestationSha256": hashlib.sha256(
            production_bundle.attestation_raw
        ).hexdigest(),
    }
    assert graph_calls == [(b"{}", release_bundle)]


def test_owned_prearm_boundary_rejects_valid_attestation_from_second_read(
        tmp_path, monkeypatch):
    (
        expected,
        raw_bundle,
        _session_bundle,
        _production_bundle,
        _staging_bundle,
        release_bundle,
        tool_bundle,
        _signed,
    ) = owned_summary_inputs(tmp_path)
    replacement_path = tmp_path / "replacement" / (
        "production-machine-attestation.json"
    )
    replacement_path.parent.mkdir()
    replacement_value = machine_fixture.attestation(
        address="192.168.9.142",
        gpu="GPU-replacement",
    )
    replacement_evidence = machine_fixture.write_machine_evidence(
        replacement_path,
        replacement_value,
    )
    replacement_bundle = validator.OwnedPhase5AttestationBundle(
        replacement_path.read_bytes(),
        tuple(
            (name, (replacement_evidence / name).read_bytes())
            for name in sorted(os.listdir(replacement_evidence))
        ),
    )
    assert validator.validate_machine_attestation_owned_bundle(
        replacement_bundle,
        "production-baseline",
    )["gpuUuids"] == ["GPU-replacement"]
    monkeypatch.setattr(
        validator,
        "_validate_phase5_production_graph_owned_bundle",
        lambda *_args, **_kwargs: None,
    )

    with pytest.raises(
            validator.AcceptanceError,
            match=r"^PHASE5_PREARM_COMPOSITE_RAW_INVALID$"):
        validator.validate_phase5_prearm_owned_bundle(
            raw_bundle,
            owned_five_field_binding(expected),
            replacement_bundle,
            release_bundle,
            tool_bundle,
        )


@pytest.mark.parametrize("artifact", [
    "soakRunSha256",
    "rawRuntimeReadySamplesSha256",
    "rawUiStateLagSamplesSha256",
    "rawRenderSamplesSha256",
    "speciesNormalSamplesSha256",
    "speciesBurstSamplesSha256",
    "phase5E2eSha256",
    "leaseEvidenceSha256",
    "listeningChecklistSha256",
    "equivalenceSha256",
])
def test_owned_prearm_boundary_semantically_validates_each_movable_leaf(
        tmp_path, monkeypatch, artifact):
    (
        expected,
        raw_bundle,
        _session_bundle,
        production_bundle,
        _staging_bundle,
        release_bundle,
        tool_bundle,
        _signed,
    ) = owned_summary_inputs(tmp_path)
    binding = owned_five_field_binding(expected)
    rebound = replace_owned_raw_artifact(
        raw_bundle,
        binding,
        artifact,
        b"{}",
    )
    monkeypatch.setattr(
        validator,
        "_validate_phase5_production_graph_owned_bundle",
        lambda *_args, **_kwargs: None,
    )

    with pytest.raises(
            validator.AcceptanceError,
            match=r"^PHASE5_PREARM_COMPOSITE_RAW_INVALID$"):
        validator.validate_phase5_prearm_owned_bundle(
            rebound,
            binding,
            production_bundle,
            release_bundle,
            tool_bundle,
        )


def test_owned_prearm_boundary_binds_source_and_tool_closure(
        tmp_path, monkeypatch):
    (
        expected,
        raw_bundle,
        _session_bundle,
        production_bundle,
        _staging_bundle,
        release_bundle,
        tool_bundle,
        _signed,
    ) = owned_summary_inputs(tmp_path)
    binding = owned_five_field_binding(expected)
    monkeypatch.setattr(
        validator,
        "_validate_phase5_production_graph_owned_bundle",
        lambda *_args, **_kwargs: None,
    )
    bad_source = validator.OwnedPhase5ReleaseBundle(
        release_bundle.release_manifest_raw,
        release_bundle.source_manifest_raw + b"\n",
    )
    mutated_tools = list(tool_bundle.artifacts)
    mutated_tools[0] = (
        mutated_tools[0][0],
        mutated_tools[0][1] + b"\n",
    )
    bad_tools = validator.OwnedPhase5ToolBundle(
        tuple(mutated_tools)
    )

    for candidate_release, candidate_tools in (
            (bad_source, tool_bundle),
            (release_bundle, bad_tools)):
        with pytest.raises(
                validator.AcceptanceError,
                match=r"^PHASE5_PREARM_COMPOSITE_RAW_INVALID$"):
            validator.validate_phase5_prearm_owned_bundle(
                raw_bundle,
                binding,
                production_bundle,
                candidate_release,
                candidate_tools,
            )


def test_owned_summary_builder_has_no_caller_summary_or_filesystem_seam():
    parameters = inspect.signature(
        validator.build_phase5_summary_from_owned_bundle
    ).parameters

    assert tuple(parameters) == (
        "raw_bundle",
        "session_bundle",
        "production_attestation_bundle",
        "staging_attestation_bundle",
        "release_bundle",
        "tool_bundle",
    )
    forbidden = {
        "value",
        "summary",
        "root",
        "path",
        "runner",
        "verifier_path",
        "node_executable",
    }
    assert forbidden.isdisjoint(parameters)
    assert all(
        parameter.annotation not in {Path, "Path"}
        for parameter in parameters.values()
    )


def test_owned_summary_reread_boundary_is_byte_only():
    parameters = inspect.signature(
        validator.validate_phase5_summary_from_owned_bundle
    ).parameters

    assert tuple(parameters) == (
        "summary_raw",
        "raw_bundle",
        "session_bundle",
        "production_attestation_bundle",
        "staging_attestation_bundle",
        "release_bundle",
        "tool_bundle",
    )
    assert parameters["summary_raw"].annotation in {bytes, "bytes"}
    assert all(
        parameter.annotation not in {Path, "Path"}
        for parameter in parameters.values()
    )


def test_owned_summary_builder_recomputes_canonical_bytes_without_path_reads(
        tmp_path, monkeypatch):
    (
        expected,
        raw_bundle,
        session_bundle,
        production_bundle,
        staging_bundle,
        release_bundle,
        tool_bundle,
        signed,
    ) = owned_summary_inputs(tmp_path)
    fault_result = {
        "faultValidation": copy.deepcopy(expected["faultValidation"]),
        "signedTransportProjection": copy.deepcopy(signed),
    }
    monkeypatch.setattr(
        validator,
        "_run_phase5_fault_composite_from_owned_tools",
        lambda *_args, **_kwargs: copy.deepcopy(fault_result),
        raising=False,
    )
    monkeypatch.setattr(
        validator,
        "_validate_phase5_production_graph_owned_bundle",
        lambda *_args, **_kwargs: None,
        raising=False,
    )
    monkeypatch.setattr(
        validator,
        "read_regular_file_no_follow",
        lambda *_args, **_kwargs: pytest.fail("builder reopened a path"),
    )
    monkeypatch.setattr(
        Path,
        "read_bytes",
        lambda *_args, **_kwargs: pytest.fail("builder reopened a path"),
    )

    value, raw = validator.build_phase5_summary_from_owned_bundle(
        raw_bundle,
        session_bundle,
        production_bundle,
        staging_bundle,
        release_bundle,
        tool_bundle,
    )

    assert value == expected
    assert raw == validator.phase5_canonical(value)
    assert validator.strict_json_bytes(
        raw,
        "PHASE5_SUMMARY_COMPOSITE_RAW_INVALID",
    ) == value
    assert value["rawArtifacts"] == expected["rawArtifacts"]
    assert validator.validate_phase5_summary_from_owned_bundle(
        raw,
        raw_bundle,
        session_bundle,
        production_bundle,
        staging_bundle,
        release_bundle,
        tool_bundle,
    ) == value
    projected, projected_raw = (
        validator.build_phase5_acceptance_from_verified_summary(
            raw, value, tool_bundle,
        )
    )
    assert projected_raw == validator.phase5_canonical(projected)
    assert projected["schemaVersion"] == 2
    assert projected["runId"] == value["runId"]
    assert {
        name: projected[name]
        for name in value["acceptanceProjection"]
    } == value["acceptanceProjection"]
    assert projected["evidence"]["phase5SummarySha256"] == (
        hashlib.sha256(raw).hexdigest()
    )
    assert validator.validate_phase5_acceptance_from_verified_summary(
        projected_raw, raw, value, tool_bundle,
    ) == projected

    legacy = copy.deepcopy(projected)
    legacy["schemaVersion"] = 1
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_ACCEPTANCE_PROJECTION_INVALID"):
        validator.validate_phase5_acceptance_from_verified_summary(
            validator.phase5_canonical(legacy),
            raw,
            value,
            tool_bundle,
        )


def test_validate_bundle_requires_and_owns_full_v2_composite(
        tmp_path, monkeypatch):
    (
        expected,
        raw_bundle,
        session_bundle,
        production_bundle,
        staging_bundle,
        release_bundle,
        tool_bundle,
        signed,
    ) = owned_summary_inputs(tmp_path)
    fault_result = {
        "faultValidation": copy.deepcopy(expected["faultValidation"]),
        "signedTransportProjection": copy.deepcopy(signed),
    }
    monkeypatch.setattr(
        validator,
        "_run_phase5_fault_composite_from_owned_tools",
        lambda *_args, **_kwargs: copy.deepcopy(fault_result),
    )
    monkeypatch.setattr(
        validator,
        "_validate_phase5_production_graph_owned_bundle",
        lambda *_args, **_kwargs: None,
    )
    summary, summary_raw = validator.build_phase5_summary_from_owned_bundle(
        raw_bundle,
        session_bundle,
        production_bundle,
        staging_bundle,
        release_bundle,
        tool_bundle,
    )
    acceptance, acceptance_raw = (
        validator.build_phase5_acceptance_from_verified_summary(
            summary_raw, summary, tool_bundle,
        )
    )
    equivalence_raw = dict(raw_bundle.artifacts)["equivalenceSha256"]
    acceptance_path = tmp_path / "acceptance.json"
    release_path = tmp_path / "release-manifest.json"
    equivalence_path = tmp_path / "staging-equivalence.json"
    acceptance_path.write_bytes(acceptance_raw)
    release_path.write_bytes(release_bundle.release_manifest_raw)
    equivalence_path.write_bytes(equivalence_raw)
    owned = validator.OwnedPhase5AcceptanceComposite(
        acceptance_raw,
        summary_raw,
        equivalence_raw,
        raw_bundle,
        session_bundle,
        production_bundle,
        staging_bundle,
        release_bundle,
        tool_bundle,
    )

    assert validator.validate_bundle(
        acceptance_path, release_path, equivalence_path, owned,
    ) is None
    assert acceptance["runId"] == summary["runId"]
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_ACCEPTANCE_COMPOSITE_REQUIRED"):
        validator.validate_bundle(
            acceptance_path, release_path, equivalence_path,
        )
    rebound = owned._replace(
        equivalence_raw=equivalence_raw + b"\n",
    )
    with pytest.raises(
            validator.AcceptanceError,
            match="EQUIVALENT_STAGING_REQUIRED"):
        validator.validate_bundle(
            acceptance_path, release_path, equivalence_path, rebound,
        )
