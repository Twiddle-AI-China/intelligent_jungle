#!/usr/bin/env python3
"""Fault-smoke runner. Fake output is deliberately ineligible for cutover acceptance."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import time
from pathlib import Path

SCENARIOS = ("identity-tamper", "worker-crash", "worker-stall", "replace-timeout",
             "edge-overflow", "pcm-corruption", "slow-writer", "lease-disconnect",
             "provider-timeout", "world-continues")
CANDIDATE_OPS_READER = (
    Path(__file__).resolve().parents[1] / "runtime/tools/lib/candidate-ops.mjs")
OPS_PATHS = frozenset(("/healthz", "/readyz"))
REVISION = re.compile(r"^[0-9a-f]{40}$")
HEX = re.compile(r"^[0-9a-f]{64}$")
_FAKE_FAULT_SPECS = {
    "identity-tamper": {
        "operation": "inject-reported-worker-identity-mismatch",
        "target": "audio-worker-handshake",
        "recoveryOperation": "restore-release-bound-worker-identity",
        "initial": {
            "expectedIdentity": "release-identity",
            "reportedIdentity": "release-identity",
            "identityAccepted": True,
            "workerReady": True,
            "mismatchReason": None,
        },
        "fault": {
            "reportedIdentity": "tampered-identity",
            "identityAccepted": False,
            "workerReady": False,
            "mismatchReason": "WORKER_IDENTITY_MISMATCH",
        },
        "recovery": {
            "reportedIdentity": "release-identity",
            "identityAccepted": True,
            "workerReady": True,
            "mismatchReason": None,
        },
        "checks": (
            ("tampered-identity-rejected", "fault", "identityAccepted", False),
            ("readiness-fails-closed", "fault", "workerReady", False),
            ("release-identity-restored", "recovery", "reportedIdentity",
             "release-identity"),
            ("worker-ready-after-identity-recovery", "recovery", "workerReady", True),
        ),
    },
    "worker-crash": {
        "operation": "close-active-worker-connection",
        "target": "audio-worker-connection",
        "recoveryOperation": "connect-replacement-worker",
        "initial": {
            "worldGeneration": "world-stable",
            "worldRevision": 42,
            "workerAlive": True,
            "workerReady": True,
            "audioEpoch": "epoch-1",
            "streamBoundaries": 0,
        },
        "fault": {
            "workerAlive": False,
            "workerReady": False,
            "streamBoundaries": 1,
        },
        "recovery": {
            "workerAlive": True,
            "workerReady": True,
            "audioEpoch": "epoch-2",
        },
        "checks": (
            ("crashed-worker-not-ready", "fault", "workerReady", False),
            ("single-stream-boundary", "recovery", "streamBoundaries", 1),
            ("world-generation-preserved", "recovery", "worldGeneration", "world-stable"),
            ("replacement-epoch-observed", "recovery", "audioEpoch", "epoch-2"),
        ),
    },
    "worker-stall": {
        "operation": "suspend-worker-progress",
        "target": "audio-worker-heartbeat",
        "recoveryOperation": "resume-worker-progress",
        "initial": {
            "heartbeat": 3,
            "stalled": False,
            "workerReady": True,
        },
        "fault": {
            "stalled": True,
            "workerReady": False,
        },
        "recovery": {
            "heartbeat": 4,
            "stalled": False,
            "workerReady": True,
        },
        "checks": (
            ("stall-fails-readiness", "fault", "workerReady", False),
            ("heartbeat-resumes", "recovery", "heartbeat", 4),
            ("worker-ready-after-stall", "recovery", "workerReady", True),
        ),
    },
    "replace-timeout": {
        "operation": "withhold-state-applied-barrier",
        "target": "audio-state-replacement",
        "recoveryOperation": "retry-state-replacement",
        "initial": {
            "replacementPending": False,
            "replaceTimeouts": 0,
            "appliedStateRevision": 7,
            "workerReady": True,
            "reason": None,
        },
        "fault": {
            "replacementPending": True,
            "replaceTimeouts": 1,
            "workerReady": False,
            "reason": "AUDIO_REPLACE_TIMEOUT",
        },
        "recovery": {
            "replacementPending": False,
            "appliedStateRevision": 8,
            "workerReady": True,
            "reason": None,
        },
        "checks": (
            ("timeout-observed", "fault", "replaceTimeouts", 1),
            ("timeout-fails-readiness", "fault", "workerReady", False),
            ("replacement-applied-after-retry", "recovery", "appliedStateRevision", 8),
            ("worker-ready-after-replace", "recovery", "workerReady", True),
        ),
    },
    "edge-overflow": {
        "operation": "fill-client-egress-past-capacity",
        "target": "runtime-client-egress",
        "recoveryOperation": "drain-surviving-client-egress",
        "initial": {
            "capacity": 2,
            "offenderDepth": 1,
            "offenderOpen": True,
            "hotClientOpen": True,
            "overflowCloses": 0,
            "closeCode": None,
        },
        "fault": {
            "offenderDepth": 2,
            "offenderOpen": False,
            "hotClientOpen": True,
            "overflowCloses": 1,
            "closeCode": 4410,
        },
        "recovery": {
            "offenderDepth": 0,
            "hotClientOpen": True,
        },
        "checks": (
            ("overflowing-client-closed", "fault", "offenderOpen", False),
            ("overflow-code-observed", "fault", "closeCode", 4410),
            ("hot-client-isolated", "recovery", "hotClientOpen", True),
            ("surviving-egress-drained", "recovery", "offenderDepth", 0),
        ),
    },
    "pcm-corruption": {
        "operation": "publish-invalid-pcm-geometry",
        "target": "master-pcm-publisher",
        "recoveryOperation": "rebuild-stream-and-publish-valid-pcm",
        "initial": {
            "audioEpoch": "epoch-1",
            "publishedBlocks": 0,
            "rejectedBlocks": 0,
            "workerReady": True,
            "corruptionCode": None,
        },
        "fault": {
            "publishedBlocks": 0,
            "rejectedBlocks": 1,
            "workerReady": False,
            "corruptionCode": "AUDIO_PCM_GEOMETRY_MISMATCH",
        },
        "recovery": {
            "audioEpoch": "epoch-2",
            "publishedBlocks": 1,
            "workerReady": True,
        },
        "checks": (
            ("corrupt-block-not-published", "fault", "publishedBlocks", 0),
            ("corrupt-block-rejected", "fault", "rejectedBlocks", 1),
            ("new-audio-epoch-observed", "recovery", "audioEpoch", "epoch-2"),
            ("valid-pcm-published-after-recovery", "recovery", "publishedBlocks", 1),
        ),
    },
    "slow-writer": {
        "operation": "block-one-pcm-subscriber",
        "target": "slow-pcm-client",
        "recoveryOperation": "resume-slow-pcm-subscriber",
        "initial": {
            "hotBlocks": 0,
            "slowQueuedBlocks": 0,
            "slowDroppedBlocks": 0,
            "slowPaused": False,
            "hotClientOpen": True,
        },
        "fault": {
            "hotBlocks": 8,
            "slowQueuedBlocks": 2,
            "slowDroppedBlocks": 6,
            "slowPaused": True,
        },
        "recovery": {
            "hotBlocks": 9,
            "slowQueuedBlocks": 0,
            "slowPaused": False,
        },
        "checks": (
            ("hot-client-keeps-consuming", "fault", "hotBlocks", 8),
            ("slow-client-pressure-observed", "fault", "slowPaused", True),
            ("slow-client-queue-recovers", "recovery", "slowQueuedBlocks", 0),
            ("hot-client-remains-open", "recovery", "hotClientOpen", True),
        ),
    },
    "lease-disconnect": {
        "operation": "disconnect-exact-lease-generation",
        "target": "latent-control-lease",
        "recoveryOperation": "acquire-new-lease-generation",
        "initial": {
            "leaseOwner": "client",
            "connectionGeneration": "generation-1",
            "leaseActive": True,
            "worldRevision": 42,
            "releasedGeneration": None,
        },
        "fault": {
            "leaseOwner": "AGENT",
            "connectionGeneration": None,
            "leaseActive": False,
            "worldRevision": 43,
            "releasedGeneration": "generation-1",
        },
        "recovery": {
            "leaseOwner": "client-recovered",
            "connectionGeneration": "generation-2",
            "leaseActive": True,
            "worldRevision": 44,
        },
        "checks": (
            ("exact-generation-released", "fault", "releasedGeneration", "generation-1"),
            ("agent-regains-control", "fault", "leaseOwner", "AGENT"),
            ("world-remains-live", "recovery", "worldRevision", 44),
            ("new-generation-acquires-lease", "recovery", "connectionGeneration",
             "generation-2"),
        ),
    },
    "provider-timeout": {
        "operation": "withhold-provider-settlement",
        "target": "bird-agent-provider",
        "recoveryOperation": "settle-next-provider-request",
        "initial": {
            "providerPending": True,
            "providerStatus": "pending",
            "providerFailures": 0,
            "worldTicks": 0,
        },
        "fault": {
            "providerPending": False,
            "providerStatus": "timeout",
            "providerFailures": 1,
            "worldTicks": 4,
        },
        "recovery": {
            "providerStatus": "success",
            "worldTicks": 5,
        },
        "checks": (
            ("provider-timeout-observed", "fault", "providerStatus", "timeout"),
            ("world-ticks-during-provider-timeout", "fault", "worldTicks", 4),
            ("next-provider-request-settles", "recovery", "providerStatus", "success"),
            ("world-continues-after-provider-recovery", "recovery", "worldTicks", 5),
        ),
    },
    "world-continues": {
        "operation": "advance-world-during-audio-outage",
        "target": "authoritative-world-runtime",
        "recoveryOperation": "reconnect-audio-without-world-reset",
        "initial": {
            "worldGeneration": "world-stable",
            "worldRevision": 100,
            "audioEpoch": "epoch-1",
            "audioReady": True,
            "recovering": False,
        },
        "fault": {
            "worldRevision": 105,
            "audioReady": False,
            "recovering": True,
        },
        "recovery": {
            "worldRevision": 106,
            "audioEpoch": "epoch-2",
            "audioReady": True,
            "recovering": False,
        },
        "checks": (
            ("world-advances-during-audio-outage", "fault", "worldRevision", 105),
            ("audio-outage-observed", "fault", "audioReady", False),
            ("world-generation-not-reset", "recovery", "worldGeneration", "world-stable"),
            ("audio-recovers-on-new-epoch", "recovery", "audioEpoch", "epoch-2"),
        ),
    },
}


class StressError(RuntimeError):
    pass


def canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False).encode()


def _snapshot(state: dict) -> dict:
    return json.loads(canonical(state))


def _semantic_state_changed(before: dict, after: dict) -> bool:
    before_state = {key: value for key, value in before.items() if key != "eventSequence"}
    after_state = {key: value for key, value in after.items() if key != "eventSequence"}
    return canonical(before_state) != canonical(after_state)


def _fake_fault_scenario(name: str) -> dict:
    spec = _FAKE_FAULT_SPECS[name]
    state = {"eventSequence": 0, **spec["initial"]}
    before = _snapshot(state)
    state.update(spec["fault"])
    state["eventSequence"] = 1
    after_fault = _snapshot(state)
    fault_performed = _semantic_state_changed(before, after_fault)
    state.update(spec["recovery"])
    state["eventSequence"] = 2
    after_recovery = _snapshot(state)
    recovery_performed = _semantic_state_changed(after_fault, after_recovery)
    phase_values = {"fault": after_fault, "recovery": after_recovery}
    checks = [
        {"name": check_name, "observed": phase_values[phase][field],
         "expected": expected}
        for check_name, phase, field, expected in spec["checks"]
    ]
    passed = (fault_performed and recovery_performed
              and all(item["observed"] == item["expected"] for item in checks))
    return {
        "name": name,
        "passed": passed,
        "faultAction": {
            "operation": spec["operation"],
            "target": spec["target"],
            "receipt": {"sequence": 1, "performed": fault_performed},
        },
        "observations": {"before": before, "afterFault": after_fault},
        "recoveryEvidence": {
            "action": {
                "operation": spec["recoveryOperation"],
                "target": spec["target"],
                "receipt": {"sequence": 2, "performed": recovery_performed},
            },
            "afterRecovery": after_recovery,
            "checks": checks,
        },
    }


def validate_fault_scenarios(outcomes: object) -> list[dict]:
    def valid_receipt(value: object, sequence: int) -> bool:
        return (isinstance(value, dict)
                and set(value) == {"sequence", "performed"}
                and type(value["sequence"]) is int
                and value["sequence"] == sequence
                and value["performed"] is True)

    try:
        if not isinstance(outcomes, list) or len(outcomes) != len(SCENARIOS):
            raise ValueError
        for index, name in enumerate(SCENARIOS):
            item = outcomes[index]
            spec = _FAKE_FAULT_SPECS[name]
            if (not isinstance(item, dict)
                    or set(item) != {"name", "passed", "faultAction",
                                     "observations", "recoveryEvidence"}
                    or item["name"] != name or item["passed"] is not True):
                raise ValueError
            action = item["faultAction"]
            observations = item["observations"]
            recovery = item["recoveryEvidence"]
            expected_before = {"eventSequence": 0, **spec["initial"]}
            expected_after_fault = {**expected_before, **spec["fault"], "eventSequence": 1}
            expected_after_recovery = {
                **expected_after_fault,
                **spec["recovery"],
                "eventSequence": 2,
            }
            if (not isinstance(action, dict)
                    or set(action) != {"operation", "target", "receipt"}
                    or action["operation"] != spec["operation"]
                    or action["target"] != spec["target"]
                    or not valid_receipt(action["receipt"], 1)
                    or not isinstance(observations, dict)
                    or set(observations) != {"before", "afterFault"}
                    or not isinstance(observations["before"], dict)
                    or not isinstance(observations["afterFault"], dict)
                    or observations["before"].get("eventSequence") != 0
                    or observations["afterFault"].get("eventSequence") != 1
                    or canonical(observations["before"]) != canonical(expected_before)
                    or canonical(observations["afterFault"]) != canonical(expected_after_fault)
                    or not _semantic_state_changed(
                        observations["before"], observations["afterFault"])):
                raise ValueError
            if (not isinstance(recovery, dict)
                    or set(recovery) != {"action", "afterRecovery", "checks"}
                    or not isinstance(recovery["action"], dict)
                    or set(recovery["action"]) != {"operation", "target", "receipt"}
                    or recovery["action"]["operation"] != spec["recoveryOperation"]
                    or recovery["action"]["target"] != spec["target"]
                    or not valid_receipt(recovery["action"]["receipt"], 2)
                    or not isinstance(recovery["afterRecovery"], dict)
                    or recovery["afterRecovery"].get("eventSequence") != 2
                    or canonical(recovery["afterRecovery"])
                    != canonical(expected_after_recovery)
                    or not _semantic_state_changed(
                        observations["afterFault"], recovery["afterRecovery"])
                    or not isinstance(recovery["checks"], list)
                    or not recovery["checks"]):
                raise ValueError
            expected_names = [entry[0] for entry in spec["checks"]]
            if [entry.get("name") for entry in recovery["checks"]
                    if isinstance(entry, dict)] != expected_names:
                raise ValueError
            phases = {
                "fault": observations["afterFault"],
                "recovery": recovery["afterRecovery"],
            }
            for check, (check_name, phase, field, expected) in zip(
                    recovery["checks"], spec["checks"], strict=True):
                if (not isinstance(check, dict)
                        or set(check) != {"name", "observed", "expected"}
                        or check["name"] != check_name
                        or field not in phases[phase]
                        or canonical(check["observed"]) != canonical(phases[phase][field])
                        or canonical(check["expected"]) != canonical(expected)
                        or canonical(check["observed"]) != canonical(check["expected"])):
                    raise ValueError
        canonical(outcomes)
    except (KeyError, TypeError, ValueError, OverflowError, RecursionError) as exc:
        raise StressError("FAULT_SCENARIO_EVIDENCE_INVALID") from exc
    return outcomes


def load_manifest(release_dir: Path) -> dict:
    path = release_dir / "release-manifest.json"
    sidecar = release_dir / "release-manifest.json.sha256"
    try:
        raw = path.read_bytes()
        value = json.loads(raw)
        expected = f"{hashlib.sha256(raw).hexdigest()}  release-manifest.json\n"
        identity = value.get("workerIdentity") if isinstance(value, dict) else None
        geometry = value.get("geometry") if isinstance(value, dict) else None
        if (raw != canonical(value) or sidecar.read_text("ascii") != expected
                or not isinstance(identity, dict)
                or not isinstance(identity.get("releaseRevision"), str)
                or REVISION.fullmatch(identity["releaseRevision"]) is None
                or not isinstance(identity.get("sourceManifestSha256"), str)
                or HEX.fullmatch(identity["sourceManifestSha256"]) is None
                or not isinstance(identity.get("audioArtifactSha256"), str)
                or HEX.fullmatch(identity["audioArtifactSha256"]) is None
                or not isinstance(geometry, dict)
                or type(geometry.get("sampleRate")) is not int
                or type(geometry.get("blockFrames")) is not int
                or type(geometry.get("poolSize")) is not int
                or min(geometry["sampleRate"], geometry["blockFrames"],
                       geometry["poolSize"]) <= 0
                or not isinstance(geometry.get("rowVoices"), list)
                or len(geometry["rowVoices"]) != geometry["poolSize"]
                or any(not isinstance(item, str) or not item
                       for item in geometry["rowVoices"])):
            raise ValueError
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError,
            RecursionError) as exc:
        raise StressError("RELEASE_MANIFEST_INVALID") from exc
    return value


def run_fake(duration_seconds: float) -> tuple[list[float], list[dict]]:
    started = time.monotonic()
    samples: list[float] = []
    checksum = 0.0
    while time.monotonic() - started < duration_seconds:
        step = len(samples) + 1
        tick = time.monotonic()
        block = [math.sin((step + offset) * 0.03125) for offset in range(256)]
        checksum += sum(block)
        samples.append((time.monotonic() - tick) * 1000)
        time.sleep(min(0.01, max(0.0, duration_seconds - (time.monotonic() - started))))
    if not math.isfinite(checksum) or not samples:
        raise StressError("FAULT_SMOKE_FAILED")
    outcomes = validate_fault_scenarios([
        _fake_fault_scenario(name) for name in SCENARIOS])
    return samples, outcomes


def read_candidate_ops(path: str, *, run=subprocess.run) -> tuple[int, dict]:
    if path not in OPS_PATHS:
        raise StressError("CANDIDATE_OPS_PATH_INVALID")
    try:
        result = run(
            ["node", str(CANDIDATE_OPS_READER), path],
            capture_output=True,
            text=True,
            timeout=7,
            check=False,
        )
        if (result.returncode != 0 or result.stderr != ""
                or len(result.stdout.encode()) > 65_536):
            raise ValueError
        value = json.loads(result.stdout)
        if (not isinstance(value, dict) or set(value) != {"statusCode", "body"}
                or type(value["statusCode"]) is not int
                or not 100 <= value["statusCode"] <= 599
                or not isinstance(value["body"], dict)):
            raise ValueError
        return value["statusCode"], value["body"]
    except StressError:
        raise
    except Exception as exc:
        raise StressError("CANDIDATE_OPS_READ_FAILED") from exc


def run_real(duration_seconds: float, manifest: dict) -> tuple[list[dict], list[dict]]:
    del duration_seconds, manifest
    # Readiness polling is observation, not fault injection. Real mode remains closed until
    # an exact, release-attested actuator for the isolated candidate is wired here.
    raise StressError("REAL_FAULT_ACTUATOR_REQUIRED")


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=("fake", "real"), required=True)
    parser.add_argument("--duration-seconds", type=float, required=True)
    parser.add_argument("--release-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        if not math.isfinite(args.duration_seconds) or args.duration_seconds <= 0:
            raise StressError("DURATION_INVALID")
        output = args.output.resolve()
        if output.name != "fault-smoke.json" or output.exists():
            raise StressError("FAULT_SMOKE_OUTPUT_REQUIRED")
        manifest = load_manifest(args.release_dir.resolve()) if args.backend == "real" else None
        started = time.monotonic()
        samples, scenarios = (run_fake(args.duration_seconds) if args.backend == "fake"
                              else run_real(args.duration_seconds, manifest))
        report = {"schemaVersion": 2, "kind": "local-fake-fault-smoke" if args.backend == "fake"
                  else "real-worker-fault-smoke", "cutoverEligible": False,
                   "measuredDurationSeconds": time.monotonic() - started,
                   "sampleCount": len(samples),
                   "scenarioCount": len(scenarios),
                   "scenarioEvidenceSha256": hashlib.sha256(canonical(scenarios)).hexdigest(),
                   "scenarios": scenarios}
        if args.backend == "fake":
            report["fakeLoopP95Ms"] = percentile(samples, .95)
        else:
            report["renderP95BlockFraction"] = percentile(
                [item["renderP95BlockFraction"] for item in samples], .95)
            report["renderP99BlockFraction"] = percentile(
                [item["renderP99BlockFraction"] for item in samples], .99)
        if manifest is not None:
            report["releaseRevision"] = manifest.get("workerIdentity", {}).get("releaseRevision")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(canonical(report))
    except StressError as exc:
        print(str(exc))
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
