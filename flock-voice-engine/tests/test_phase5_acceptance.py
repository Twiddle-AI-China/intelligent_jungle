from __future__ import annotations

import copy
import base64
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
spec = importlib.util.spec_from_file_location("phase5_acceptance", TOOL)
acceptance = importlib.util.module_from_spec(spec); spec.loader.exec_module(acceptance)

H = "a" * 64


@pytest.fixture
def release_manifest():
    return {"workerIdentity": {"releaseRevision": "b" * 40, "sourceManifestSha256": "c" * 64,
                               "audioArtifactSha256": "d" * 64},
            "geometry": {"sampleRate": 44100, "blockFrames": 4096, "poolSize": 5,
                         "rowVoices": ["bass", "pad", "lead", "pluck", "pad"]}}


def valid_acceptance(release_manifest):
    return {"schemaVersion": 1, "status": "accepted",
            "environment": {"kind": "isolated-equivalent-spark",
                            "surfaceProfile": "production-fixed-entry"},
            "release": {"releaseManifestSha256": H, **release_manifest["workerIdentity"]},
            "geometry": copy.deepcopy(release_manifest["geometry"]),
            "durationMinutes": 30, "clients": 4, "slowClients": 1,
            "stability": {"hotClientAbnormalCloses": 0, "hotClientReconnectStorms": 0,
                          "hotClientUnderruns": 0, "pcmCorruptions": 0,
                          "cursorDiscontinuitiesUnexpected": 0},
            "latency": {"runtimeReadyP95Ms": 999, "uiStateLagP95Ms": 149,
                        "renderP95BlockFraction": .69, "renderP99BlockFraction": .89},
            "speciesLoad": {"endpoint": "http://127.0.0.1:8081/v1", "model": "bird_agent",
                            "normalRequests": 1, "burstRequests": 1, "errors": 0,
                            "normalLatencySamplesSha256": H,
                            "burstLatencySamplesSha256": H},
            "audibleSpecies": {name: True for name in ("bass", "pad", "lead", "pluck")},
            "leaseExercise": ["demo", "tracks", "new-ui"],
            "evidence": {name: H for name in ("productionGraphSha256", "phase5E2eSha256",
                         "rawRuntimeReadySamplesSha256", "rawUiStateLagSamplesSha256",
                         "rawRenderSamplesSha256", "soakRunSha256", "productionMachineAttestationSha256",
                         "stagingMachineAttestationSha256", "leaseEvidenceSha256",
                         "listeningChecklistSha256")},
            "operatorListening": {"completed": True, "noClicks": True, "noStalls": True,
                                  "allSpeciesAudible": True, "operator": "tester"}}


def test_valid_acceptance_passes(release_manifest):
    acceptance.validate_acceptance(valid_acceptance(release_manifest), release_manifest)


def test_acceptance_rejects_idle_gpu_numbers(release_manifest):
    value = valid_acceptance(release_manifest)
    value["speciesLoad"]["normalRequests"] = value["speciesLoad"]["burstRequests"] = 0
    with pytest.raises(acceptance.AcceptanceError, match="SPECIES_LOAD_EVIDENCE_REQUIRED"):
        acceptance.validate_acceptance(value, release_manifest)


def test_fake_local_evidence_can_never_satisfy_cutover(release_manifest):
    value = valid_acceptance(release_manifest); value["environment"]["kind"] = "local-fake"
    with pytest.raises(acceptance.AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        acceptance.validate_acceptance(value, release_manifest)


@pytest.mark.parametrize("mutate,code", [
    (lambda x: x.update(durationMinutes=29.99), "SOAK_DURATION_TOO_SHORT"),
    (lambda x: x.update(clients=3), "CLIENT_LOAD_INVALID"),
    (lambda x: x["latency"].update(renderP99BlockFraction=.91), "LATENCY_THRESHOLD_EXCEEDED"),
    (lambda x: x["stability"].update(hotClientUnderruns=1), "SHARED_LOAD_STABILITY_FAILED"),
    (lambda x: x["speciesLoad"].update(errors=1), "SPECIES_LOAD_EVIDENCE_REQUIRED"),
    (lambda x: x["release"].update(releaseRevision="e" * 40), "RELEASE_TUPLE_MISMATCH"),
    (lambda x: x["geometry"].update(poolSize=4), "AUDIO_GEOMETRY_MISMATCH"),
    (lambda x: x["evidence"].update(rawRenderSamplesSha256="bad"),
     "RAW_PERCENTILE_EVIDENCE_REQUIRED"),
    (lambda x: x.update(durationMinutes=float("nan")), "SOAK_DURATION_TOO_SHORT"),
    (lambda x: x["latency"].update(runtimeReadyP95Ms=float("nan")),
     "LATENCY_EVIDENCE_INVALID"),
])
def test_acceptance_fail_closed_cases(release_manifest, mutate, code):
    value = valid_acceptance(release_manifest); mutate(value)
    with pytest.raises(acceptance.AcceptanceError, match=code):
        acceptance.validate_acceptance(value, release_manifest)


def test_schemas_are_strict_json_contracts():
    for name in ("acceptance.schema.json", "machine-attestation.schema.json"):
        value = json.loads((ROOT / "flock-voice-engine/release" / name).read_text())
        assert value["additionalProperties"] is False
        assert value["$schema"].endswith("2020-12/schema")


def test_fake_runner_can_only_write_ineligible_fault_smoke(tmp_path):
    output = tmp_path / "fault-smoke.json"
    result = subprocess.run([sys.executable,
        ROOT / "flock-voice-engine/tools/stress_audio_worker.py",
        "--backend", "fake", "--duration-seconds", "0.02",
        "--release-dir", tmp_path, "--output", output], capture_output=True, text=True)
    assert result.returncode == 0
    value = json.loads(output.read_text())
    assert value["kind"] == "local-fake-fault-smoke"
    assert value["cutoverEligible"] is False
    assert not (tmp_path / "acceptance.json").exists()


def test_raw_samples_are_recomputed_instead_of_trusting_aggregate(tmp_path, release_manifest):
    value = valid_acceptance(release_manifest); raw = tmp_path / "acceptance-evidence"; raw.mkdir()
    def write(path, item):
        path.write_bytes(acceptance.canonical(item)); return acceptance.sha256(path)
    runtime_path = raw / "runtime-ready-samples.json"
    value["evidence"]["rawRuntimeReadySamplesSha256"] = write(runtime_path, [10, 20, 30, 40])
    value["latency"]["runtimeReadyP95Ms"] = 40
    ui = [{"atMs": index * 2000, "latencyMs": 40} for index in range(900)]
    value["evidence"]["rawUiStateLagSamplesSha256"] = write(
        raw / "ui-state-lag-samples.json", ui)
    value["latency"]["uiStateLagP95Ms"] = 40
    render_p95 = [{"atMs": index * 250, "value": .2} for index in range(7200)]
    render_p99 = [{"atMs": index * 250, "value": .3} for index in range(7200)]
    value["evidence"]["rawRenderSamplesSha256"] = write(raw / "render-samples.json",
        {"p95BlockFractions": render_p95, "p99BlockFractions": render_p99})
    value["latency"]["renderP95BlockFraction"] = .2
    value["latency"]["renderP99BlockFraction"] = .3
    value["evidence"]["soakRunSha256"] = write(raw / "soak-run.json", {
        "startedAtUnixMs": 0, "endedAtUnixMs": 1_800_000, "measuredDurationMs": 1_800_000,
        "pcmBlocks": [1, 1, 1, 1], "hotClientMaxPcmGapMs": 100,
        "hotClientFinalPcmAgeMs": [100, 100, 100], "stability": value["stability"]})
    normal = [{"atMs": index * 2000, "ok": True, "latencyMs": 10}
              for index in range(900)]
    burst = [{"atMs": index * 2500, "ok": True, "latencyMs": 20}
             for index in range(720)]
    value["speciesLoad"]["normalRequests"] = len(normal)
    value["speciesLoad"]["burstRequests"] = len(burst)
    value["speciesLoad"]["normalLatencySamplesSha256"] = write(
        raw / "species-normal-samples.json", normal)
    value["speciesLoad"]["burstLatencySamplesSha256"] = write(
        raw / "species-burst-samples.json", burst)
    ready = {"status": 200, "value": {"workerReady": True, "runtimeOwner": "server",
        "audioOwner": "world", "phaseGate": "phase5-local", "workerIdentity": {
            "expected": release_manifest["workerIdentity"],
            "reported": release_manifest["workerIdentity"]}}}
    report = {"config": {"configFile": "/x/playwright.phase5-acceptance.config.js",
        "metadata": {"phase5Mode": True, "phase5Acceptance": True,
                     "surfaceProfile": "production-fixed-entry"},
        "projects": [{"name": "chromium"}]},
        "suites": [{"file": "phase5-local.spec.js", "specs": [{"ok": True, "tests": [{
            "projectName": "chromium", "status": "expected", "results": [{"status": "passed",
            "attachments": [{"name": "phase5-runtime-identity", "contentType": "application/json",
            "body": base64.b64encode(json.dumps(ready).encode()).decode()},
            {"name": "phase5-lease-evidence", "contentType": "application/json",
             "body": ""}]}]}]}]}],
        "stats": {"expected": 1, "unexpected": 0, "skipped": 0, "flaky": 0}}
    value["evidence"]["productionGraphSha256"] = write(tmp_path / "production-graph.json", {})
    lease = {"schemaVersion": 1, "kind": "production-fixed-entry-chromium-lease-evidence",
             "sequence": ["demo", "tracks", "new-ui"], "surfaceLeases": {
                 name: {"takeAccepted": True, "releaseAccepted": True}
                 for name in ("demo", "tracks", "new-ui")}, "audibleSpecies": {
                 name: {"commandAccepted": True, "releaseAccepted": True,
                        "commandSeq": index * 2 + 1, "releaseCommandSeq": index * 2 + 2,
                        "peakAbs": .1, "pcmBlocks": 1}
                 for index, name in enumerate(("bass", "pad", "lead", "pluck"))}}
    lease["surfaceLeases"]["new-ui"].update({"commandSeq": 9, "releaseCommandSeq": 10})
    report["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"][1]["body"] = (
        base64.b64encode(json.dumps(lease).encode()).decode())
    value["evidence"]["phase5E2eSha256"] = write(raw / "phase5-e2e.json", report)
    value["evidence"]["leaseEvidenceSha256"] = write(raw / "lease-evidence.json", lease)
    value["evidence"]["listeningChecklistSha256"] = write(
        tmp_path / "listening-checklist.json", value["operatorListening"])
    production = tmp_path / "production.json"; staging = tmp_path / "staging.json"
    production.write_bytes(acceptance.canonical({})); staging.write_bytes(acceptance.canonical({}))
    value["evidence"]["productionMachineAttestationSha256"] = acceptance.sha256(production)
    value["evidence"]["stagingMachineAttestationSha256"] = acceptance.sha256(staging)
    acceptance.validate_evidence_files(tmp_path / "acceptance.json", value, production, staging,
                                       release_manifest)
    value["evidence"]["rawRuntimeReadySamplesSha256"] = write(runtime_path, [5000, 5000, 5000, 5000])
    with pytest.raises(acceptance.AcceptanceError, match="RAW_PERCENTILE_EVIDENCE_REQUIRED"):
        acceptance.validate_evidence_files(tmp_path / "acceptance.json", value, production, staging,
                                           release_manifest)
