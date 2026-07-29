from __future__ import annotations

import copy
import base64
import functools
import hashlib
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
STRESS_TOOL = ROOT / "flock-voice-engine/tools/stress_audio_worker.py"
stress_spec = importlib.util.spec_from_file_location("stress_audio_worker", STRESS_TOOL)
stress = importlib.util.module_from_spec(stress_spec); stress_spec.loader.exec_module(stress)

H = "a" * 64
UUID_V4 = "123e4567-e89b-42d3-a456-426614174000"

REQUIRED_STATIC_ROUTES = {
    "/": "mvp/index.html",
    "/index.html": "mvp/index.html",
    "/demo.html": "flock-voice-engine/client/demo.html",
    "/tracks.html": "flock-voice-engine/client/tracks.html",
    "/voice-client.js": "flock-voice-engine/client/voice-client.js",
    "/voice-client-production.js":
        "flock-voice-engine/client/voice-client-production.js",
    "/pcm-player-worklet.js":
        "flock-voice-engine/client/pcm-player-worklet.js",
    "/assets/timbre/latent_map.json":
        "flock-voice-engine/assets/timbre/latent_map.json",
    "/assets/timbre/voice_maps/bass.json":
        "flock-voice-engine/assets/timbre/voice_maps/bass.json",
    "/assets/timbre/voice_maps/lead.json":
        "flock-voice-engine/assets/timbre/voice_maps/lead.json",
    "/assets/timbre/voice_maps/pad.json":
        "flock-voice-engine/assets/timbre/voice_maps/pad.json",
    "/assets/timbre/voice_maps/pluck.json":
        "flock-voice-engine/assets/timbre/voice_maps/pluck.json",
}


def route_mime(repo_path: str) -> str:
    if repo_path.endswith(".html"):
        return "text/html; charset=utf-8"
    if repo_path.endswith(".js"):
        return "application/javascript; charset=utf-8"
    if repo_path.endswith(".json"):
        return "application/json; charset=utf-8"
    raise AssertionError(repo_path)


@pytest.fixture
def release_manifest():
    return {"workerIdentity": {"releaseRevision": "b" * 40, "sourceManifestSha256": "c" * 64,
                               "audioArtifactSha256": "d" * 64},
            "productionGraphSha256": H,
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


def valid_lease_evidence():
    def http(entry_path, request_count):
        return {
            "entryPath": entry_path,
            "entrySeen": True,
            "requestCount": request_count,
            "getOnly": True,
            "status200Only": True,
            "candidateOriginOnly": True,
            "allowedPathOnly": True,
            "directOnly": True,
            "failureFree": True,
        }

    def socket(path, sent, received):
        return {
            "path": path,
            "lifecycle": ["open", "close"],
            "framesSent": sent,
            "framesReceived": received,
        }

    return {
        "schemaVersion": 1,
        "kind": "production-fixed-entry-chromium-lease-evidence",
        "sequence": ["demo", "tracks", "new-ui"],
        "surfaceLeases": {
            "demo": {"takeAccepted": True, "releaseAccepted": True},
            "tracks": {"takeAccepted": True, "releaseAccepted": True},
            "new-ui": {
                "takeAccepted": True,
                "releaseAccepted": True,
                "commandSeq": 9,
                "releaseCommandSeq": 10,
                "publicOwnerAfterRelease": "AGENT",
                "controlReleaseCommandId": UUID_V4,
            },
        },
        "audibleSpecies": {
            "bass": {
                "commandAccepted": True,
                "releaseAccepted": True,
                "commandSeq": 1,
                "releaseCommandSeq": 2,
                "peakAbs": 1e-5,
                "pcmBlocks": 1,
            },
            "pad": {
                "commandAccepted": True,
                "releaseAccepted": True,
                "commandSeq": 3,
                "releaseCommandSeq": 4,
                "peakAbs": 0.2,
                "pcmBlocks": 2,
            },
            "lead": {
                "commandAccepted": True,
                "releaseAccepted": True,
                "commandSeq": 5,
                "releaseCommandSeq": 6,
                "peakAbs": 0.3,
                "pcmBlocks": 3,
            },
            "pluck": {
                "commandAccepted": True,
                "releaseAccepted": True,
                "commandSeq": 7,
                "releaseCommandSeq": 8,
                "peakAbs": 1e20,
                "pcmBlocks": 4,
            },
        },
        "surfaceTransports": {
            "demo": {
                "http": http("/demo.html", 2),
                "webSockets": [socket("/decoder", 1, 3)],
            },
            "tracks": {
                "http": http("/tracks.html", 3),
                "webSockets": [socket("/decoder?split=1", 1, 4)],
            },
            "new-ui": {
                "http": http("/", 4),
                "webSockets": [
                    socket("/api/v1/audio", 0, 2),
                    socket("/api/v1/audio", 1, 3),
                    socket("/api/v1/runtime", 0, 4),
                    socket("/api/v1/runtime", 2, 5),
                    socket("/decoder", 1, 1),
                ],
            },
        },
    }


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


def test_acceptance_graph_digest_must_match_release_manifest(release_manifest):
    value = valid_acceptance(release_manifest)
    value["evidence"]["productionGraphSha256"] = "e" * 64
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
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


def test_fake_runner_records_fault_actions_observations_and_recovery(tmp_path):
    output = tmp_path / "fault-smoke.json"
    result = subprocess.run([sys.executable, STRESS_TOOL,
        "--backend", "fake", "--duration-seconds", "0.02",
        "--release-dir", tmp_path, "--output", output], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    value = json.loads(output.read_bytes())

    assert value["schemaVersion"] == 2
    assert value["scenarioCount"] == len(stress.SCENARIOS)
    assert [item["name"] for item in value["scenarios"]] == list(stress.SCENARIOS)
    assert value["scenarioEvidenceSha256"] == hashlib.sha256(
        stress.canonical(value["scenarios"])).hexdigest()
    for item in value["scenarios"]:
        assert set(item) == {
            "name", "passed", "faultAction", "observations", "recoveryEvidence"}
        assert item["passed"] is True
        assert set(item["faultAction"]) == {"operation", "target", "receipt"}
        assert item["faultAction"]["receipt"] == {"sequence": 1, "performed": True}
        assert set(item["observations"]) == {"before", "afterFault"}
        assert item["observations"]["before"]["eventSequence"] == 0
        assert item["observations"]["afterFault"]["eventSequence"] == 1
        assert item["observations"]["before"] != item["observations"]["afterFault"]
        assert set(item["recoveryEvidence"]) == {"action", "afterRecovery", "checks"}
        assert item["recoveryEvidence"]["action"]["receipt"] == {
            "sequence": 2, "performed": True}
        assert item["recoveryEvidence"]["afterRecovery"]["eventSequence"] == 2
        assert item["recoveryEvidence"]["afterRecovery"] != item["observations"]["afterFault"]
        assert item["recoveryEvidence"]["checks"]
        for check in item["recoveryEvidence"]["checks"]:
            assert set(check) == {"name", "observed", "expected"}
            assert check["observed"] == check["expected"]


def test_fault_scenario_validator_rejects_name_only_noop_and_missing_recovery():
    with pytest.raises(stress.StressError, match="FAULT_SCENARIO_EVIDENCE_INVALID"):
        stress.validate_fault_scenarios([
            {"name": name, "passed": True} for name in stress.SCENARIOS])

    _, scenarios = stress.run_fake(0.001)
    no_op = copy.deepcopy(scenarios)
    no_op[0]["observations"]["afterFault"] = copy.deepcopy(
        no_op[0]["observations"]["before"])
    no_op[0]["observations"]["afterFault"]["eventSequence"] = 1
    with pytest.raises(stress.StressError, match="FAULT_SCENARIO_EVIDENCE_INVALID"):
        stress.validate_fault_scenarios(no_op)

    no_recovery_effect = copy.deepcopy(scenarios)
    no_recovery_effect[0]["recoveryEvidence"]["afterRecovery"] = copy.deepcopy(
        no_recovery_effect[0]["observations"]["afterFault"])
    no_recovery_effect[0]["recoveryEvidence"]["afterRecovery"]["eventSequence"] = 2
    with pytest.raises(stress.StressError, match="FAULT_SCENARIO_EVIDENCE_INVALID"):
        stress.validate_fault_scenarios(no_recovery_effect)

    type_confused = copy.deepcopy(scenarios)
    type_confused[0]["faultAction"]["receipt"] = {
        "sequence": True, "performed": 1}
    type_confused[0]["recoveryEvidence"]["action"]["receipt"] = {
        "sequence": 2.0, "performed": 1.0}
    with pytest.raises(stress.StressError, match="FAULT_SCENARIO_EVIDENCE_INVALID"):
        stress.validate_fault_scenarios(type_confused)

    missing_recovery = copy.deepcopy(scenarios)
    del missing_recovery[0]["recoveryEvidence"]
    with pytest.raises(stress.StressError, match="FAULT_SCENARIO_EVIDENCE_INVALID"):
        stress.validate_fault_scenarios(missing_recovery)


def test_real_runner_cannot_turn_readiness_polling_into_fault_success(
        monkeypatch, release_manifest):
    calls = []
    ready = {"workerReady": True,
             "workerIdentity": {"expected": release_manifest["workerIdentity"],
                                "reported": release_manifest["workerIdentity"]},
             "workerTelemetry": {"renderP95Ms": 1, "renderP99Ms": 2,
                                 "blockDurationMs": 100}}
    monkeypatch.setattr(stress, "read_candidate_ops",
                        lambda path: calls.append(path) or (200, ready))
    with pytest.raises(stress.StressError, match="REAL_FAULT_ACTUATOR_REQUIRED"):
        stress.run_real(0.001, release_manifest)
    assert calls == []


def test_real_runner_cli_fails_before_writing_telemetry_only_evidence(
        tmp_path, release_manifest):
    raw = stress.canonical(release_manifest)
    (tmp_path / "release-manifest.json").write_bytes(raw)
    (tmp_path / "release-manifest.json.sha256").write_text(
        f"{hashlib.sha256(raw).hexdigest()}  release-manifest.json\n", encoding="ascii")
    output = tmp_path / "fault-smoke.json"
    result = subprocess.run([sys.executable, STRESS_TOOL,
        "--backend", "real", "--duration-seconds", "0.001",
        "--release-dir", tmp_path, "--output", output], capture_output=True, text=True)
    assert result.returncode == 2
    assert result.stdout == "REAL_FAULT_ACTUATOR_REQUIRED\n"
    assert result.stderr == ""
    assert not output.exists()
    assert not (tmp_path / "acceptance.json").exists()


def test_stress_manifest_uses_release_canonical_utf8_and_requires_release_tuple(
        tmp_path, release_manifest):
    release_manifest["localImageDiagnostics"] = {
        "runtime": {"repository": "镜像"}}
    raw = stress.canonical(release_manifest)
    (tmp_path / "release-manifest.json").write_bytes(raw)
    (tmp_path / "release-manifest.json.sha256").write_text(
        f"{hashlib.sha256(raw).hexdigest()}  release-manifest.json\n", encoding="ascii")
    assert stress.load_manifest(tmp_path) == release_manifest

    null_raw = b"null"
    (tmp_path / "release-manifest.json").write_bytes(null_raw)
    (tmp_path / "release-manifest.json.sha256").write_text(
        f"{hashlib.sha256(null_raw).hexdigest()}  release-manifest.json\n", encoding="ascii")
    with pytest.raises(stress.StressError, match="RELEASE_MANIFEST_INVALID"):
        stress.load_manifest(tmp_path)


def test_stress_manifest_maps_excessive_json_depth_to_stable_error(tmp_path):
    raw = b"[" * 1500 + b"0" + b"]" * 1500
    (tmp_path / "release-manifest.json").write_bytes(raw)
    (tmp_path / "release-manifest.json.sha256").write_text(
        f"{hashlib.sha256(raw).hexdigest()}  release-manifest.json\n", encoding="ascii")
    with pytest.raises(stress.StressError, match="RELEASE_MANIFEST_INVALID"):
        stress.load_manifest(tmp_path)


def test_real_stress_reads_ops_only_through_the_fixed_candidate_container():
    calls = []

    def fake_run(command, **options):
        calls.append((command, options))
        return subprocess.CompletedProcess(
            command, 0, stdout='{"statusCode":200,"body":{"workerReady":true}}\n',
            stderr="")

    status, value = stress.read_candidate_ops("/readyz", run=fake_run)
    assert status == 200
    assert value == {"workerReady": True}
    command, options = calls[0]
    assert command == [
        "node",
        str(ROOT / "flock-voice-engine/runtime/tools/lib/candidate-ops.mjs"),
        "/readyz",
    ]
    assert options == {
        "capture_output": True,
        "text": True,
        "timeout": 7,
        "check": False,
    }
    with pytest.raises(stress.StressError, match="CANDIDATE_OPS_PATH_INVALID"):
        stress.read_candidate_ops("/api/v1/bootstrap", run=fake_run)
    assert len(calls) == 1


def build_valid_evidence_bundle(tmp_path, release_manifest):
    value = valid_acceptance(release_manifest)
    raw = tmp_path / "acceptance-evidence"
    raw.mkdir()

    def write(path, item):
        path.write_bytes(acceptance.canonical(item))
        return acceptance.sha256(path)

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
            "body": base64.b64encode(acceptance.canonical(ready)).decode()},
            {"name": "phase5-lease-evidence", "contentType": "application/json",
             "body": ""}]}]}]}]}],
        "stats": {"expected": 1, "unexpected": 0, "skipped": 0, "flaky": 0}}
    value["evidence"]["productionGraphSha256"] = write(tmp_path / "production-graph.json", {})
    lease = valid_lease_evidence()
    lease_path = raw / "lease-evidence.json"

    def write_report():
        value["evidence"]["phase5E2eSha256"] = write(raw / "phase5-e2e.json", report)

    def bind_lease_bytes(lease_bytes):
        report["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"][1][
            "body"] = base64.b64encode(lease_bytes).decode()
        lease_path.write_bytes(lease_bytes)
        value["evidence"]["leaseEvidenceSha256"] = acceptance.sha256(lease_path)
        write_report()

    bind_lease_bytes(acceptance.canonical(lease))
    value["evidence"]["listeningChecklistSha256"] = write(
        tmp_path / "listening-checklist.json", value["operatorListening"])
    production = tmp_path / "production.json"
    staging = tmp_path / "staging.json"
    production.write_bytes(acceptance.canonical({}))
    staging.write_bytes(acceptance.canonical({}))
    value["evidence"]["productionMachineAttestationSha256"] = acceptance.sha256(production)
    value["evidence"]["stagingMachineAttestationSha256"] = acceptance.sha256(staging)
    return {
        "acceptance_path": tmp_path / "acceptance.json",
        "bind_lease_bytes": bind_lease_bytes,
        "lease": lease,
        "lease_path": lease_path,
        "production": production,
        "raw": raw,
        "ready": ready,
        "release": release_manifest,
        "report": report,
        "runtime_path": runtime_path,
        "staging": staging,
        "value": value,
        "write": write,
        "write_report": write_report,
    }


def validate_evidence_bundle(bundle):
    return acceptance.validate_evidence_files(
        bundle["acceptance_path"],
        bundle["value"],
        bundle["production"],
        bundle["staging"],
        bundle["release"],
    )


def test_raw_samples_are_recomputed_instead_of_trusting_aggregate(tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    validate_evidence_bundle(bundle)
    broad_ready = copy.deepcopy(bundle["ready"])
    broad_ready["value"]["unprojectedDiagnostic"] = "must-not-persist"
    bundle["report"]["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"][0][
        "body"] = base64.b64encode(acceptance.canonical(broad_ready)).decode()
    bundle["write_report"]()
    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_PRODUCTION_E2E_REQUIRED"):
        validate_evidence_bundle(bundle)
    bundle["report"]["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"][0][
        "body"] = base64.b64encode(acceptance.canonical(bundle["ready"])).decode()
    bundle["write_report"]()
    bundle["value"]["evidence"]["rawRuntimeReadySamplesSha256"] = bundle["write"](
        bundle["runtime_path"], [5000, 5000, 5000, 5000])
    with pytest.raises(acceptance.AcceptanceError, match="RAW_PERCENTILE_EVIDENCE_REQUIRED"):
        validate_evidence_bundle(bundle)


@pytest.mark.parametrize("mutate", [
    lambda samples: samples[0].update(atMs=-1),
    lambda samples: samples[1].update(atMs=samples[0]["atMs"]),
    lambda samples: samples[-1].update(atMs=1001),
])
def test_timed_sample_coverage_rejects_negative_duplicate_and_out_of_window_times(
        mutate):
    samples = [{"atMs": at_ms, "value": .25}
               for at_ms in (0, 250, 500, 750, 1000)]
    assert acceptance.timed_values(
        samples, "value", 1000, 250, 1, "RAW_PERCENTILE_EVIDENCE_REQUIRED"
    ) == [.25] * 5
    mutate(samples)
    with pytest.raises(
            acceptance.AcceptanceError, match="RAW_PERCENTILE_EVIDENCE_REQUIRED"):
        acceptance.timed_values(
            samples, "value", 1000, 250, 1, "RAW_PERCENTILE_EVIDENCE_REQUIRED")


LEASE_MUTATIONS = [
    ("missing-surface-transports", lambda lease: lease.pop("surfaceTransports")),
    ("top-level-maintenance-token", lambda lease: lease.update(maintenanceToken="secret")),
    ("probe-credential", lambda lease: lease["audibleSpecies"]["bass"].update(
        credential="secret")),
    ("transport-authorization", lambda lease: lease["surfaceTransports"]["demo"].update(
        authorization="secret")),
    ("http-raw-url", lambda lease: lease["surfaceTransports"]["demo"]["http"].update(
        rawUrl="http://secret.invalid/demo.html")),
    ("ws-socket-error", lambda lease: lease["surfaceTransports"]["demo"]["webSockets"][0].update(
        socketError="secret")),
    ("non-uuid", lambda lease: lease["surfaceLeases"]["new-ui"].update(
        controlReleaseCommandId="release-command")),
    ("non-v4-uuid", lambda lease: lease["surfaceLeases"]["new-ui"].update(
        controlReleaseCommandId="123e4567-e89b-12d3-a456-426614174000")),
    ("uppercase-uuid", lambda lease: lease["surfaceLeases"]["new-ui"].update(
        controlReleaseCommandId="123E4567-E89B-42D3-A456-426614174000")),
    ("bool-sequence", lambda lease: lease["audibleSpecies"]["bass"].update(commandSeq=True)),
    ("unsafe-sequence", lambda lease: lease["surfaceLeases"]["new-ui"].update(
        releaseCommandSeq=2**53)),
    ("fractional-sequence", lambda lease: lease["audibleSpecies"]["pad"].update(
        commandSeq=3.5)),
    ("zero-sequence", lambda lease: lease["audibleSpecies"]["bass"].update(commandSeq=0)),
    ("negative-count", lambda lease: lease["surfaceTransports"]["demo"]["webSockets"][0].update(
        framesSent=-1)),
    ("reversed-sequence", lambda lease: lease["audibleSpecies"]["bass"].update(
        releaseCommandSeq=1)),
    ("http-invariant-false", lambda lease: lease["surfaceTransports"]["demo"]["http"].update(
        directOnly=False)),
    ("http-count-zero", lambda lease: lease["surfaceTransports"]["demo"]["http"].update(
        requestCount=0)),
    ("http-count-over-limit", lambda lease: lease["surfaceTransports"]["demo"]["http"].update(
        requestCount=13)),
    ("wrong-entry-path", lambda lease: lease["surfaceTransports"]["tracks"]["http"].update(
        entryPath="/demo.html")),
    ("wrong-ws-multiset", lambda lease: lease["surfaceTransports"]["demo"]["webSockets"][0].update(
        path="/api/v1/audio")),
    ("unsorted-ws", lambda lease: lease["surfaceTransports"]["new-ui"]["webSockets"].reverse()),
    ("ws-error-lifecycle", lambda lease: lease["surfaceTransports"]["demo"]["webSockets"][0].update(
        lifecycle=["open", "error", "close"])),
    ("ws-missing-close", lambda lease: lease["surfaceTransports"]["demo"]["webSockets"][0].update(
        lifecycle=["open"])),
    ("ws-zero-received", lambda lease: lease["surfaceTransports"]["demo"]["webSockets"][0].update(
        framesReceived=0)),
    ("missing-species", lambda lease: lease["audibleSpecies"].pop("pluck")),
    ("extra-species", lambda lease: lease["audibleSpecies"].update(
        other=copy.deepcopy(lease["audibleSpecies"]["bass"]))),
    ("probe-extra-key", lambda lease: lease["audibleSpecies"]["lead"].update(
        failureText="secret")),
    ("global-order", lambda lease: lease["audibleSpecies"]["pad"].update(commandSeq=2)),
]


@pytest.mark.parametrize("_name,mutate", LEASE_MUTATIONS, ids=[item[0] for item in LEASE_MUTATIONS])
def test_lease_semantic_mutations_rebind_both_artifacts_and_fail_closed(
        tmp_path, release_manifest, _name, mutate):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    lease = valid_lease_evidence()
    mutate(lease)
    bundle["bind_lease_bytes"](acceptance.canonical(lease))

    with pytest.raises(acceptance.AcceptanceError):
        validate_evidence_bundle(bundle)


@pytest.mark.parametrize("peak", [float("nan"), float("inf"), float("-inf")],
                         ids=["nan", "infinity", "negative-infinity"])
def test_lease_strict_json_rejects_non_json_numeric_tokens(
        tmp_path, release_manifest, peak):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    lease = valid_lease_evidence()
    lease["audibleSpecies"]["bass"]["peakAbs"] = peak
    bundle["bind_lease_bytes"](acceptance.canonical(lease))

    with pytest.raises(acceptance.AcceptanceError):
        validate_evidence_bundle(bundle)


def test_lease_extreme_integer_peak_returns_acceptance_error(
        tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    lease = valid_lease_evidence()
    lease["audibleSpecies"]["bass"]["peakAbs"] = 10**400
    bundle["bind_lease_bytes"](acceptance.canonical(lease))

    with pytest.raises(acceptance.AcceptanceError):
        validate_evidence_bundle(bundle)


def test_lease_duplicate_members_are_rejected_in_attachment_and_file(
        tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    raw = acceptance.canonical(valid_lease_evidence()).replace(
        b"{", b'{"kind":"hidden-secret",', 1)
    bundle["bind_lease_bytes"](raw)

    with pytest.raises(acceptance.AcceptanceError):
        validate_evidence_bundle(bundle)


def test_lease_invalid_utf8_is_rejected_in_attachment_and_file(
        tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    bundle["bind_lease_bytes"](b'{"kind":"\xc3("}')

    with pytest.raises(acceptance.AcceptanceError):
        validate_evidence_bundle(bundle)


def deeply_nested_json_bytes():
    return b"[" * 5000 + b"0" + b"]" * 5000


def test_lease_attachment_deep_nesting_maps_to_acceptance_error(
        tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    bundle["report"]["suites"][0]["specs"][0]["tests"][0]["results"][0][
        "attachments"][1]["body"] = base64.b64encode(deeply_nested_json_bytes()).decode()
    bundle["write_report"]()

    with pytest.raises(acceptance.AcceptanceError,
                       match="PHASE5_PRODUCTION_E2E_REQUIRED"):
        validate_evidence_bundle(bundle)


@pytest.mark.parametrize("corruption", ["duplicate-key", "invalid-utf8", "deep-nesting"])
def test_independent_lease_file_strict_loader_rejects_corruption(
        tmp_path, release_manifest, corruption):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    if corruption == "duplicate-key":
        raw = acceptance.canonical(valid_lease_evidence()).replace(
            b"{", b'{"kind":"hidden-secret",', 1)
    elif corruption == "invalid-utf8":
        raw = b'{"kind":"\xc3("}'
    else:
        raw = deeply_nested_json_bytes()
    bundle["lease_path"].write_bytes(raw)
    bundle["value"]["evidence"]["leaseEvidenceSha256"] = acceptance.sha256(
        bundle["lease_path"])

    with pytest.raises(acceptance.AcceptanceError,
                       match="SEQUENTIAL_LEASE_EVIDENCE_REQUIRED"):
        validate_evidence_bundle(bundle)


def test_lease_base64_requires_canonical_pad_bits(tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    raw = acceptance.canonical(valid_lease_evidence())
    while len(raw) % 3 == 0:
        raw += b" "
    bundle["bind_lease_bytes"](raw)
    body = bundle["report"]["suites"][0]["specs"][0]["tests"][0]["results"][0][
        "attachments"][1]["body"]
    assert body.endswith("=")
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    index = len(body.rstrip("=")) - 1
    replacement = alphabet[alphabet.index(body[index]) ^ 1]
    attachment_body = list(body)
    attachment_body[index] = replacement
    bundle["report"]["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"][1][
        "body"] = "".join(attachment_body)
    bundle["write_report"]()

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_PRODUCTION_E2E_REQUIRED"):
        validate_evidence_bundle(bundle)


def test_python_safe_integer_parity_accepts_json_float_and_exponent_integer_spellings(
        tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    raw = acceptance.canonical(valid_lease_evidence())
    raw = raw.replace(b'"commandSeq":9', b'"commandSeq":9e0', 1)
    raw = raw.replace(b'"pcmBlocks":1', b'"pcmBlocks":1.0', 1)
    bundle["bind_lease_bytes"](raw)

    validate_evidence_bundle(bundle)


def node_canonical_lease_bytes(lease):
    script = """
import { canonicalJson } from './runtime/tools/lib/phase5-lease-evidence.mjs';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
process.stdout.write(canonicalJson(JSON.parse(raw)));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT / "flock-voice-engine",
        input=json.dumps(lease, separators=(",", ":")),
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.encode()


def test_python_accepts_actual_node_canonical_number_bytes(tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    lease = valid_lease_evidence()
    lease["audibleSpecies"]["bass"]["peakAbs"] = 1e-5
    lease["audibleSpecies"]["pluck"]["peakAbs"] = 1e20
    raw = node_canonical_lease_bytes(lease)
    assert b'"peakAbs":0.00001' in raw
    assert b'"peakAbs":100000000000000000000' in raw
    bundle["bind_lease_bytes"](raw)

    validate_evidence_bundle(bundle)


def test_lease_file_must_match_attachment_bytes_even_when_objects_are_equal(
        tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    attachment_bytes = acceptance.canonical(valid_lease_evidence())
    assert b'"peakAbs":1e-05' in attachment_bytes
    file_bytes = attachment_bytes.replace(b'"peakAbs":1e-05', b'"peakAbs":0.00001', 1)
    assert json.loads(file_bytes) == json.loads(attachment_bytes)
    bundle["bind_lease_bytes"](attachment_bytes)
    bundle["lease_path"].write_bytes(file_bytes)
    bundle["value"]["evidence"]["leaseEvidenceSha256"] = acceptance.sha256(
        bundle["lease_path"])

    with pytest.raises(acceptance.AcceptanceError):
        validate_evidence_bundle(bundle)


def test_chromium_report_structural_type_errors_map_to_acceptance_error(
        tmp_path, release_manifest):
    bundle = build_valid_evidence_bundle(tmp_path, release_manifest)
    bundle["report"]["config"]["metadata"] = []
    bundle["write_report"]()

    with pytest.raises(acceptance.AcceptanceError,
                       match="PHASE5_PRODUCTION_E2E_REQUIRED"):
        validate_evidence_bundle(bundle)


@functools.lru_cache(maxsize=1)
def authoritative_production_graph():
    graph = json.loads(subprocess.check_output(
        ["node", ROOT / "flock-voice-engine/runtime/tools/build-production-graph.mjs"],
        text=True,
    ))
    revision = subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
        text=True,
    ).strip()
    graph["fileSha256"] = {
        relative: hashlib.sha256(subprocess.check_output([
            "git", "-C", str(ROOT), "show", f"{revision}:{relative}",
        ])).hexdigest()
        for relative in graph["files"]
    }
    for route in graph["staticRoutes"]:
        route["sha256"] = graph["fileSha256"][route["repoPath"]]
    inner = {
        name: graph[name]
        for name in ("files", "edges", "fileSha256", "staticRoutes")
    }
    graph["sha256"] = hashlib.sha256(acceptance.canonical(inner)).hexdigest()
    assert graph["sha256"] == acceptance.PRODUCTION_GRAPH_INNER_SHA256
    return graph


def production_graph_bundle(tmp_path):
    graph = copy.deepcopy(authoritative_production_graph())
    hashes = graph["fileSha256"]
    files = graph["files"]
    graph_path = tmp_path / "production-graph.json"
    graph_path.write_bytes(acceptance.canonical(graph))
    source_path = tmp_path / "source-manifest.json"
    source_path.write_bytes(acceptance.canonical({
        "schemaVersion": 1,
        "entries": [{"path": path, "sha256": hashes[path]} for path in files],
    }))
    graph_sha = acceptance.sha256(graph_path)
    release_path = tmp_path / "release-manifest.json"
    release_path.write_bytes(acceptance.canonical({
        "productionGraphSha256": graph_sha,
        "workerIdentity": {
            "sourceManifestSha256": acceptance.sha256(source_path),
        },
    }))
    return release_path, graph_path, graph_sha, graph


def bind_graph_bundle(release_path, graph_path, graph):
    graph_path.write_bytes(acceptance.canonical(graph))
    graph_sha = acceptance.sha256(graph_path)
    source_sha = acceptance.sha256(release_path.parent / "source-manifest.json")
    release_path.write_bytes(acceptance.canonical({
        "productionGraphSha256": graph_sha,
        "workerIdentity": {"sourceManifestSha256": source_sha},
    }))
    return graph_sha


def test_production_graph_validates_canonical_static_route_digest(tmp_path):
    release_path, _graph_path, graph_sha, _graph = production_graph_bundle(tmp_path)
    acceptance.validate_production_graph(release_path, graph_sha)


def test_acceptance_rejects_fully_rebound_static_only_subgraph(tmp_path):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    retained = set(REQUIRED_STATIC_ROUTES.values())
    graph["files"] = sorted(retained)
    graph["edges"] = []
    graph["fileSha256"] = {
        path: digest for path, digest in graph["fileSha256"].items()
        if path in retained
    }
    graph["staticRoutes"] = [
        route for route in graph["staticRoutes"]
        if route["repoPath"] in retained
    ]
    inner = {name: graph[name] for name in
             ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(acceptance.canonical(inner)).hexdigest()
    source = json.loads((tmp_path / "source-manifest.json").read_bytes())
    source["entries"] = [
        entry for entry in source["entries"] if entry["path"] in retained
    ]
    (tmp_path / "source-manifest.json").write_bytes(acceptance.canonical(source))
    graph_sha = bind_graph_bundle(release_path, graph_path, graph)

    assert len(graph["files"]) == 11
    assert len(graph["edges"]) == 0
    assert len(graph["staticRoutes"]) == 12
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


def test_acceptance_rejects_fully_rebound_unknown_static_mime(tmp_path):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    repo_path = "mvp/assets/payload.exe"
    graph["files"].append(repo_path)
    graph["files"].sort()
    graph["fileSha256"][repo_path] = hashlib.sha256(b"payload").hexdigest()
    graph["staticRoutes"].append({
        "url": "/assets/payload.exe",
        "repoPath": repo_path,
        "mime": None,
        "sha256": graph["fileSha256"][repo_path],
    })
    graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    inner = {name: graph[name] for name in
             ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(acceptance.canonical(inner)).hexdigest()
    source = json.loads((tmp_path / "source-manifest.json").read_bytes())
    source["entries"].append({
        "path": repo_path,
        "sha256": graph["fileSha256"][repo_path],
    })
    (tmp_path / "source-manifest.json").write_bytes(acceptance.canonical(source))
    graph_sha = bind_graph_bundle(release_path, graph_path, graph)

    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


def test_acceptance_binds_canonical_source_manifest_bytes_to_release_identity(tmp_path):
    release_path, _graph_path, graph_sha, _graph = production_graph_bundle(tmp_path)
    source_path = tmp_path / "source-manifest.json"
    source = json.loads(source_path.read_bytes())
    source["entries"].append({
        "path": "unrelated.txt",
        "sha256": "f" * 64,
    })
    source_path.write_bytes(acceptance.canonical(source))

    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


def test_acceptance_validator_accepts_real_256_edge_graph(tmp_path):
    graph = copy.deepcopy(authoritative_production_graph())
    assert len(graph["files"]) == 165
    assert len(graph["edges"]) == 256
    assert len(graph["staticRoutes"]) == 68
    graph_path = tmp_path / "production-graph.json"
    graph_path.write_bytes(acceptance.canonical(graph))
    source_path = tmp_path / "source-manifest.json"
    source_path.write_bytes(acceptance.canonical({
        "schemaVersion": 1,
        "entries": [
            {"path": path, "sha256": graph["fileSha256"][path]}
            for path in graph["files"]
        ],
    }))
    graph_sha = acceptance.sha256(graph_path)
    release_path = tmp_path / "release-manifest.json"
    release_path.write_bytes(acceptance.canonical({
        "productionGraphSha256": graph_sha,
        "workerIdentity": {
            "sourceManifestSha256": acceptance.sha256(source_path),
        },
    }))

    acceptance.validate_production_graph(release_path, graph_sha)


def test_production_graph_rejects_static_route_drift_even_when_outer_sha_is_rebound(tmp_path):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    graph["staticRoutes"][0]["mime"] = "application/octet-stream"
    drifted_outer_sha = bind_graph_bundle(release_path, graph_path, graph)
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, drifted_outer_sha)


def test_production_graph_rejects_release_manifest_binding_drift(tmp_path):
    release_path, _graph_path, graph_sha, _graph = production_graph_bundle(tmp_path)
    release = json.loads(release_path.read_bytes())
    release["productionGraphSha256"] = "e" * 64
    release_path.write_bytes(acceptance.canonical(release))
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


@pytest.mark.parametrize("unsafe_url", [
    "/double//slash",
    "/trailing/",
    "/%2e%2e/path",
    "/back\\slash",
    "/query?x=1",
    "/fragment#x",
    "/dot/./path",
    "/dot/../path",
])
def test_acceptance_rejects_unsafe_static_route_urls(tmp_path, unsafe_url):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    graph["staticRoutes"][0]["url"] = unsafe_url
    graph_body = {name: graph[name] for name in
                  ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(acceptance.canonical(graph_body)).hexdigest()
    graph_sha = bind_graph_bundle(release_path, graph_path, graph)
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)


@pytest.mark.parametrize("mutation", [
    "non-object-edge",
    "wrong-mime",
    "missing-root",
    "extra-runtime-route",
    "replaced-mvp-route",
    "bad-static-root",
    "shadow-legacy-route",
    "rogue-mvp-route",
    "unknown-external",
    "external-wrong-source",
    "unknown-runtime-api",
    "wrong-runtime-api-specifier",
    "wrong-runtime-api-kind",
    "unknown-edge-kind",
    "wrong-source-extension",
    "wrong-target-extension",
    "mismatched-internal-specifier",
    "control-specifier",
    "duplicate-edge",
    "unsorted-edges",
])
def test_acceptance_rejects_fully_rebound_invalid_graph_semantics(tmp_path, mutation):
    release_path, graph_path, _graph_sha, graph = production_graph_bundle(tmp_path)
    if mutation == "non-object-edge":
        graph["edges"] = [7]
    elif mutation == "wrong-mime":
        graph["staticRoutes"][0]["mime"] = "application/octet-stream"
    elif mutation == "missing-root":
        graph["staticRoutes"] = [
            route for route in graph["staticRoutes"] if route["url"] != "/"
        ]
        graph["staticRoutes"].append({
            **next(route for route in graph["staticRoutes"]
                   if route["url"] == "/index.html"),
            "url": "/replacement",
        })
        graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    elif mutation == "extra-runtime-route":
        repo_path = "flock-voice-engine/runtime/src/simulation-runtime.js"
        graph["staticRoutes"].append({
            "url": "/runtime.js",
            "repoPath": repo_path,
            "mime": route_mime(repo_path),
            "sha256": graph["fileSha256"][repo_path],
        })
        graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
    elif mutation == "replaced-mvp-route":
        route = next(route for route in graph["staticRoutes"]
                     if route["url"] == "/src/server-main.js")
        route["url"] = "/src/replaced.js"
        graph["staticRoutes"].sort(key=lambda item: (item["url"], item["repoPath"]))
    elif mutation == "bad-static-root":
        edge = next(edge for edge in graph["edges"]
                    if edge["resolved"]
                    == "flock-voice-engine/assets/timbre/voice_maps")
        edge["specifier"] = "../../assets/timbre/"
    elif mutation == "shadow-legacy-route":
        repo_path = "mvp/assets/timbre/latent_map.json"
        graph["files"].append(repo_path)
        graph["files"].sort()
        graph["fileSha256"][repo_path] = hashlib.sha256(b"shadow").hexdigest()
        route = next(route for route in graph["staticRoutes"]
                     if route["url"] == "/assets/timbre/latent_map.json")
        route.update({
            "repoPath": repo_path,
            "sha256": graph["fileSha256"][repo_path],
        })
        source = json.loads((tmp_path / "source-manifest.json").read_bytes())
        source["entries"].append({
            "path": repo_path,
            "sha256": graph["fileSha256"][repo_path],
        })
        (tmp_path / "source-manifest.json").write_bytes(acceptance.canonical(source))
    elif mutation == "rogue-mvp-route":
        repo_path = "mvp/rogue.js"
        graph["files"].append(repo_path)
        graph["files"].sort()
        graph["fileSha256"][repo_path] = hashlib.sha256(b"rogue").hexdigest()
        graph["staticRoutes"].append({
            "url": "/rogue.js",
            "repoPath": repo_path,
            "mime": route_mime(repo_path),
            "sha256": graph["fileSha256"][repo_path],
        })
        graph["staticRoutes"].sort(key=lambda route: (route["url"], route["repoPath"]))
        source = json.loads((tmp_path / "source-manifest.json").read_bytes())
        source["entries"].append({
            "path": repo_path,
            "sha256": graph["fileSha256"][repo_path],
        })
        (tmp_path / "source-manifest.json").write_bytes(acceptance.canonical(source))
    elif mutation == "unknown-external":
        graph["edges"][0].update({
            "specifier": "external:evil",
            "resolved": "external:evil",
        })
    elif mutation == "external-wrong-source":
        graph["edges"][0]["source"] = "mvp/src/server-main.js"
    elif mutation == "unknown-runtime-api":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.runtime-api",
            "specifier": "/api/evil",
            "resolved": "runtime-api:/api/evil",
        })
    elif mutation == "wrong-runtime-api-specifier":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.runtime-api",
            "specifier": "/api/v1/latent-maps/pad",
            "resolved": "runtime-api:/api/v1/bootstrap",
        })
    elif mutation == "wrong-runtime-api-kind":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.fetch",
            "specifier": "/api/v1/bootstrap",
            "resolved": "runtime-api:/api/v1/bootstrap",
        })
    elif mutation == "unknown-edge-kind":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.unknown",
            "specifier": "../index.html",
            "resolved": "mvp/index.html",
        })
    elif mutation == "wrong-source-extension":
        graph["edges"][0].update({
            "source": "mvp/index.html",
            "kind": "js.import",
            "specifier": "src/server-main.js",
            "resolved": "mvp/src/server-main.js",
        })
    elif mutation == "wrong-target-extension":
        graph["edges"][0].update({
            "kind": "js.audio-worklet",
            "specifier": "./demo.html",
            "resolved": "flock-voice-engine/client/demo.html",
        })
    elif mutation == "mismatched-internal-specifier":
        graph["edges"][0].update({
            "source": "mvp/src/server-main.js",
            "kind": "js.import",
            "specifier": "./server-main.js",
            "resolved": "flock-voice-engine/runtime/src/simulation-runtime.js",
        })
    elif mutation == "control-specifier":
        graph["edges"][0]["specifier"] = "external:configurable-fetch\n"
    elif mutation == "duplicate-edge":
        graph["edges"].insert(1, copy.deepcopy(graph["edges"][0]))
    else:
        graph["edges"].reverse()
    graph_body = {name: graph[name] for name in
                  ("files", "edges", "fileSha256", "staticRoutes")}
    graph["sha256"] = hashlib.sha256(acceptance.canonical(graph_body)).hexdigest()
    graph_sha = bind_graph_bundle(release_path, graph_path, graph)
    with pytest.raises(acceptance.AcceptanceError,
                       match="PRODUCTION_GRAPH_EVIDENCE_REQUIRED"):
        acceptance.validate_production_graph(release_path, graph_sha)
