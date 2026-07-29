from __future__ import annotations

import copy
import importlib.util
import shutil
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
spec = importlib.util.spec_from_file_location("phase5_acceptance_summary", TOOL)
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)

H = "a" * 64
REVISION = "b" * 40
RUN_ID = "123e4567-e89b-42d3-a456-426614174000"
WINDOW = {
    "startedAtMonotonicMs": 1_000,
    "endedAtMonotonicMs": 1_801_000,
    "startedAtUnixMs": 1_700_000_000_000,
    "endedAtUnixMs": 1_700_001_800_000,
}
SCENARIOS = (
    (
        "worker-crash-restart",
        15_000,
        ("signal-worker", "candidate-audio-worker"),
        ("await-supervisor-ready", "candidate-audio-supervisor"),
    ),
    (
        "runtime-reconnect",
        5_000,
        ("disconnect-runtime", "runtime-client-4"),
        ("reconnect-runtime", "runtime-client-4"),
    ),
    (
        "slow-client",
        7_000,
        ("pause-audio", "audio-client-4"),
        ("resume-audio", "audio-client-4"),
    ),
    (
        "queue-pressure",
        5_000,
        ("saturate-egress", "egress-client-4"),
        ("reconnect-egress", "egress-client-4"),
    ),
    (
        "agent-timeout",
        15_000,
        ("inject-provider-timeout", "bird_agent"),
        ("clear-provider-timeout", "bird_agent"),
    ),
    (
        "agent-malformed-response",
        15_000,
        ("inject-provider-malformed-response", "bird_agent"),
        ("clear-provider-malformed-response", "bird_agent"),
    ),
    (
        "audio-epoch-discontinuity",
        10_000,
        ("rotate-audio-epoch", "candidate-audio-worker"),
        ("settle-audio-epoch", "all-audio-clients"),
    ),
)


def _action(operation: str, target: str, at_ms: int) -> dict:
    return {
        "operation": operation,
        "target": target,
        "atMonotonicMs": at_ms,
    }


def _ledger() -> list[dict]:
    result = []
    for index, (scenario, slo, fault, recovery) in enumerate(SCENARIOS):
        at_ms = 2_000 + index * 10_000
        result.append({
            "scenario": scenario,
            "passed": True,
            "recoveryDurationMs": min(slo, 1_000),
            "recoverySloMs": slo,
            "faultAction": _action(*fault, at_ms),
            "recoveryAction": _action(*recovery, at_ms + 500),
            "observationEventCount": 0,
            "effects": [{
                "phase": "fault",
                "sequence": index + 1,
                "type": "worker.sample",
                "client": 0,
            }],
        })
    return result


def structurally_valid_summary() -> dict:
    release = {
        "releaseManifestSha256": H,
        "releaseRevision": REVISION,
        "sourceManifestSha256": H,
        "audioArtifactSha256": H,
    }
    geometry = {
        "sampleRate": 44_100,
        "blockFrames": 4_096,
        "poolSize": 5,
        "rowVoices": ["bass", "pad", "lead", "pluck", "pad"],
    }
    profile = {
        "clients": 4,
        "slowClient": 4,
        "durationMinutes": 30,
        "speciesEndpoint": "http://127.0.0.1:8081/v1",
        "speciesModel": "bird_agent",
    }
    operator_listening = {
        "completed": True,
        "noClicks": True,
        "noStalls": True,
        "allSpeciesAudible": True,
        "operator": "tester",
    }
    return {
        "schemaVersion": 2,
        "kind": "isolated-equivalent-spark-phase5-summary",
        "status": "accepted",
        "runId": RUN_ID,
        "challenge": H,
        "release": copy.deepcopy(release),
        "geometry": copy.deepcopy(geometry),
        "profile": copy.deepcopy(profile),
        "window": copy.deepcopy(WINDOW),
        "session": {
            "signerSpkiSha256": H,
            "faultSessionEvidenceSha256": H,
        },
        "rawArtifacts": {
            name: H for name in (
                "faultEventsSha256",
                "soakRunSha256",
                "rawRuntimeReadySamplesSha256",
                "rawUiStateLagSamplesSha256",
                "rawRenderSamplesSha256",
                "clientObservationsSha256",
                "rawManifestSha256",
                "speciesNormalSamplesSha256",
                "speciesBurstSamplesSha256",
                "phase5E2eSha256",
                "leaseEvidenceSha256",
                "productionGraphSha256",
                "productionMachineAttestationSha256",
                "stagingMachineAttestationSha256",
                "listeningChecklistSha256",
                "equivalenceSha256",
            )
        },
        "faultValidation": {
            "schemaVersion": 1,
            "kind": "phase5-fault-validation-result",
            "passed": True,
            "runId": RUN_ID,
            "challenge": H,
            "release": copy.deepcopy(release),
            "geometry": copy.deepcopy(geometry),
            "profile": copy.deepcopy(profile),
            "window": copy.deepcopy(WINDOW),
            "signerSpkiSha256": H,
            "faultSessionEvidenceSha256": H,
            "evidence": {
                "schemaVersion": 2,
                "faultEventsSha256": H,
                "scenarioEventCount": 35,
                "transportEventCount": 1,
                "projectedStateCount": 21,
                "unexpectedStabilityFailureCount": 0,
                "eventChainSha256": H,
                "transportChainSha256": H,
            },
            "ledger": _ledger(),
        },
        "acceptanceProjection": {
            "environment": {
                "kind": "isolated-equivalent-spark",
                "surfaceProfile": "production-fixed-entry",
            },
            "release": copy.deepcopy(release),
            "geometry": copy.deepcopy(geometry),
            "durationMinutes": 30,
            "clients": 4,
            "slowClients": 1,
            "stability": {
                "hotClientAbnormalCloses": 0,
                "hotClientReconnectStorms": 0,
                "hotClientUnderruns": 0,
                "pcmCorruptions": 0,
                "cursorDiscontinuitiesUnexpected": 0,
            },
            "latency": {
                "runtimeReadyP95Ms": 1_000,
                "uiStateLagP95Ms": 150,
                "renderP95BlockFraction": 0.70,
                "renderP99BlockFraction": 0.90,
            },
            "speciesLoad": {
                "endpoint": "http://127.0.0.1:8081/v1",
                "model": "bird_agent",
                "normalRequests": 1,
                "burstRequests": 1,
                "errors": 0,
                "normalLatencySamplesSha256": H,
                "burstLatencySamplesSha256": H,
            },
            "audibleSpecies": {
                "bass": True,
                "pad": True,
                "lead": True,
                "pluck": True,
            },
            "leaseExercise": ["demo", "tracks", "new-ui"],
            "operatorListening": copy.deepcopy(operator_listening),
        },
        "acceptanceTool": {
            name: H for name in (
                "validatePhase5AcceptancePySha256",
                "phase5SummarySchemaSha256",
                "acceptanceSchemaSha256",
                "soakPhase5MjsSha256",
                "captureMachineAttestationPySha256",
                "verifyPhase5FaultEvidenceMjsSha256",
                "phase5FaultValidationMjsSha256",
                "phase5FaultEvidenceMjsSha256",
                "phase5FaultTransportProjectionMjsSha256",
                "phase5FaultSemanticsMjsSha256",
            )
        },
    }


def test_deployed_validator_resolves_summary_schema_from_trusted_nested_closure(
        tmp_path):
    deploy = tmp_path / "deploy"
    summary_closure = deploy / "phase5-summary"
    summary_closure.mkdir(parents=True)
    deployed_validator = deploy / "validate_phase5_acceptance.py"
    shutil.copyfile(TOOL, deployed_validator)
    shutil.copyfile(
        ROOT / "flock-voice-engine/release/phase5-summary.schema.json",
        summary_closure / "phase5-summary.schema.json",
    )

    deployed_spec = importlib.util.spec_from_file_location(
        "deployed_phase5_summary_validator", deployed_validator)
    deployed = importlib.util.module_from_spec(deployed_spec)
    deployed_spec.loader.exec_module(deployed)

    deployed.validate_phase5_summary_structure(structurally_valid_summary())
    (deploy / "phase5-summary.schema.json").write_bytes(b"{}")
    invalid = structurally_valid_summary()
    invalid["schemaVersion"] = 1
    with pytest.raises(
            deployed.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        deployed.validate_phase5_summary_structure(invalid)


OBJECT_PATHS = (
    (),
    ("release",),
    ("geometry",),
    ("profile",),
    ("window",),
    ("session",),
    ("rawArtifacts",),
    ("faultValidation",),
    ("faultValidation", "release"),
    ("faultValidation", "geometry"),
    ("faultValidation", "profile"),
    ("faultValidation", "window"),
    ("faultValidation", "evidence"),
    ("faultValidation", "ledger", 0),
    ("faultValidation", "ledger", 0, "faultAction"),
    ("faultValidation", "ledger", 0, "recoveryAction"),
    ("faultValidation", "ledger", 0, "effects", 0),
    ("acceptanceProjection",),
    ("acceptanceProjection", "environment"),
    ("acceptanceProjection", "release"),
    ("acceptanceProjection", "geometry"),
    ("acceptanceProjection", "stability"),
    ("acceptanceProjection", "latency"),
    ("acceptanceProjection", "speciesLoad"),
    ("acceptanceProjection", "audibleSpecies"),
    ("acceptanceProjection", "operatorListening"),
    ("acceptanceTool",),
)


def _at_path(value: object, path: tuple[object, ...]) -> object:
    current = value
    for part in path:
        current = current[part]
    return current


def _set_path(value: object, path: tuple[object, ...], replacement: object) -> None:
    parent = _at_path(value, path[:-1])
    parent[path[-1]] = replacement


def test_phase5_summary_v2_structural_contract_accepts_in_memory_value():
    acceptance.validate_phase5_summary_structure(structurally_valid_summary())


def test_phase5_summary_rejects_v1():
    value = structurally_valid_summary()
    value["schemaVersion"] = 1

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        acceptance.validate_phase5_summary_structure(value)


@pytest.mark.parametrize("name", (
    "clientObservationsSha256",
    "rawManifestSha256",
))
def test_phase5_summary_requires_final_raw_authentication_digests(name):
    value = structurally_valid_summary()
    del value["rawArtifacts"][name]

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        acceptance.validate_phase5_summary_structure(value)


@pytest.mark.parametrize("path", OBJECT_PATHS)
def test_phase5_summary_rejects_extra_members_at_every_object_level(path):
    value = structurally_valid_summary()
    _at_path(value, path)["unexpected"] = 0

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        acceptance.validate_phase5_summary_structure(value)


@pytest.mark.parametrize("path", OBJECT_PATHS)
def test_phase5_summary_rejects_missing_members_at_every_object_level(path):
    value = structurally_valid_summary()
    target = _at_path(value, path)
    del target[next(iter(target))]

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        acceptance.validate_phase5_summary_structure(value)


@pytest.mark.parametrize(("path", "replacement"), (
    (("schemaVersion",), "2"),
    (("runId",), 2),
    (("geometry", "sampleRate"), True),
    (("geometry", "rowVoices"), "bass,pad,lead,pluck,pad"),
    (("faultValidation", "passed"), 1),
    (("faultValidation", "ledger"), {}),
    (("faultValidation", "ledger", 0, "effects", 0, "client"), False),
    (("acceptanceProjection", "latency", "runtimeReadyP95Ms"), "100"),
    (("acceptanceProjection", "leaseExercise"), {}),
    (("acceptanceProjection", "operatorListening", "completed"), 1),
    (("acceptanceTool", "acceptanceSchemaSha256"), 7),
))
def test_phase5_summary_rejects_wrong_json_types(path, replacement):
    value = structurally_valid_summary()
    _set_path(value, path, replacement)

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        acceptance.validate_phase5_summary_structure(value)


@pytest.mark.parametrize(("path", "replacement"), (
    (("window", "startedAtUnixMs"), acceptance.JS_MAX_SAFE_INTEGER + 1),
    (
        ("faultValidation", "ledger", 0, "faultAction", "atMonotonicMs"),
        acceptance.JS_MAX_SAFE_INTEGER + 1,
    ),
    (
        ("faultValidation", "ledger", 0, "effects", 0, "sequence"),
        acceptance.JS_MAX_SAFE_INTEGER + 1,
    ),
    (
        ("faultValidation", "evidence", "transportEventCount"),
        acceptance.JS_MAX_SAFE_INTEGER + 1,
    ),
    (
        ("acceptanceProjection", "speciesLoad", "normalRequests"),
        acceptance.JS_MAX_SAFE_INTEGER + 1,
    ),
    (("faultValidation", "ledger", 0, "observationEventCount"), -1),
    (("acceptanceProjection", "latency", "runtimeReadyP95Ms"), float("nan")),
    (("acceptanceProjection", "latency", "uiStateLagP95Ms"), float("inf")),
    (("acceptanceProjection", "latency", "renderP95BlockFraction"), 0.700_001),
    (("acceptanceProjection", "latency", "renderP99BlockFraction"), 0.900_001),
))
def test_phase5_summary_rejects_unsafe_or_out_of_contract_numbers(
        path, replacement):
    value = structurally_valid_summary()
    _set_path(value, path, replacement)

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        acceptance.validate_phase5_summary_structure(value)


@pytest.mark.parametrize(("path", "replacement"), (
    (("kind",), "phase5-summary"),
    (("status",), "pending"),
    (("runId",), "not-a-uuid"),
    (("challenge",), "f" * 63),
    (("geometry", "poolSize"), 4),
    (("profile", "slowClient"), 3),
    (("faultValidation", "evidence", "scenarioEventCount"), 34),
    (("faultValidation", "ledger", 0, "scenario"), "runtime-reconnect"),
    (("faultValidation", "ledger", 0, "faultAction", "operation"), "noop"),
    (("faultValidation", "ledger", 0, "effects", 0, "phase"), "before"),
    (("faultValidation", "ledger", 0, "effects", 0, "type"), "unknown"),
    (("acceptanceProjection", "leaseExercise"), ["new-ui", "tracks", "demo"]),
    (("acceptanceProjection", "operatorListening", "operator"), " tester "),
    (("acceptanceProjection", "operatorListening", "operator"), "\ufeff"),
    (("acceptanceProjection", "operatorListening", "operator"), "tester\u0085"),
    (("acceptanceProjection", "operatorListening", "operator"), "章\n哥"),
))
def test_phase5_summary_rejects_fixed_contract_drift(path, replacement):
    value = structurally_valid_summary()
    _set_path(value, path, replacement)

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        acceptance.validate_phase5_summary_structure(value)


@pytest.mark.parametrize(("started", "ended"), (
    (1_000, 1_800_999),
    (1_000, 1_801_001),
))
def test_phase5_summary_requires_exact_thirty_minute_dual_clock_window(
        started, ended):
    value = structurally_valid_summary()
    value["window"]["startedAtMonotonicMs"] = started
    value["window"]["endedAtMonotonicMs"] = ended

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        acceptance.validate_phase5_summary_structure(value)


def test_phase5_summary_rejects_unpaired_unicode_surrogates():
    value = structurally_valid_summary()
    value["acceptanceProjection"]["operatorListening"]["operator"] = "\ud800"

    with pytest.raises(acceptance.AcceptanceError, match="PHASE5_SUMMARY_INVALID"):
        acceptance.validate_phase5_summary_structure(value)
