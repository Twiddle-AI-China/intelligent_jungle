from __future__ import annotations

import copy
import importlib.util
import math
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_latency_samples", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

fixture_spec = importlib.util.spec_from_file_location(
    "phase5_summary_fixture_for_latency_samples", SUMMARY_TEST)
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)


UI_SAMPLE_COUNT = math.floor(
    validator.PHASE5_WINDOW_DURATION_MS / 2000 * 0.95)


def binding_and_window() -> tuple[dict, dict]:
    summary = fixture.structurally_valid_summary()
    binding = {
        name: copy.deepcopy(summary[name])
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    return binding, copy.deepcopy(summary["window"])


def valid_runtime_ready_samples() -> tuple[dict, dict]:
    binding, window = binding_and_window()
    samples = []
    for index in range(4):
        relative = 10 + index * 10
        samples.append({
            "sequence": index + 1,
            "client": index + 1,
            "connectionGeneration": 1,
            "openedAtMonotonicMs":
                window["startedAtMonotonicMs"] + relative,
            "openedAtUnixMs": window["startedAtUnixMs"] + relative,
            "readyAtMonotonicMs":
                window["startedAtMonotonicMs"] + relative + 100,
            "readyAtUnixMs": window["startedAtUnixMs"] + relative + 100,
            "readyFrameSha256": f"{index + 1:064x}",
        })
    return {
        "schemaVersion": 2,
        "kind": "isolated-equivalent-spark-phase5-runtime-ready-samples",
        **binding,
        "window": window,
        "samples": samples,
    }, binding


def valid_ui_state_lag_samples() -> tuple[dict, dict]:
    binding, window = binding_and_window()
    samples = []
    per_client_probe = [0, 0, 0, 0]
    for index in range(UI_SAMPLE_COUNT):
        client = index % 4 + 1
        per_client_probe[client - 1] += 1
        relative = (
            index * validator.PHASE5_WINDOW_DURATION_MS
            // UI_SAMPLE_COUNT
        )
        samples.append({
            "sequence": index + 1,
            "client": client,
            "connectionGeneration": 1,
            "probeSeq": per_client_probe[client - 1],
            "sentAtMonotonicMs":
                window["startedAtMonotonicMs"] + relative,
            "sentAtUnixMs": window["startedAtUnixMs"] + relative,
            "observedAtMonotonicMs":
                window["startedAtMonotonicMs"] + relative + 100,
            "observedAtUnixMs":
                window["startedAtUnixMs"] + relative + 100,
            "snapshotFrameSha256": f"{index + 1:064x}",
        })
    return {
        "schemaVersion": 2,
        "kind": "isolated-equivalent-spark-phase5-ui-state-lag-samples",
        **binding,
        "window": window,
        "samples": samples,
    }, binding


def test_runtime_ready_recomputes_p95_from_four_raw_clock_pairs():
    value, binding = valid_runtime_ready_samples()
    value["samples"][0]["readyAtMonotonicMs"] -= 90
    value["samples"][0]["readyAtUnixMs"] -= 90

    result = validator.validate_phase5_runtime_ready_samples_bytes(
        validator.canonical(value), binding)

    assert result["value"] == value
    assert result["projection"] == {"runtimeReadyP95Ms": 100}


def test_runtime_ready_rejects_open_exactly_at_window_start():
    value, binding = valid_runtime_ready_samples()
    sample = value["samples"][0]
    sample["openedAtMonotonicMs"] = value["window"][
        "startedAtMonotonicMs"]
    sample["openedAtUnixMs"] = value["window"]["startedAtUnixMs"]

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RUNTIME_READY_SAMPLES_INVALID"):
        validator.validate_phase5_runtime_ready_samples_bytes(
            validator.canonical(value), binding)


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schemaVersion=1),
    lambda value: value.update(kind="runtime-ready"),
    lambda value: value["release"].update(releaseRevision="f" * 39),
    lambda value: value["window"].update(endedAtUnixMs=1_700_001_800_001),
    lambda value: value.update(hidden=True),
    lambda value: value["samples"].pop(),
    lambda value: value["samples"].reverse(),
    lambda value: value["samples"][0].update(connectionGeneration=2),
    lambda value: value["samples"][0].update(
        readyAtMonotonicMs=value["samples"][0]["openedAtMonotonicMs"] - 1),
    lambda value: value["samples"][0].update(
        readyAtUnixMs=value["samples"][0]["readyAtUnixMs"] + 2),
    lambda value: value["samples"][0].update(readyFrameSha256="f" * 63),
    lambda value: value["samples"][0].update(hidden=True),
])
def test_runtime_ready_rejects_binding_order_clock_and_shape_attacks(mutation):
    value, binding = valid_runtime_ready_samples()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RUNTIME_READY_SAMPLES_INVALID"):
        validator.validate_phase5_runtime_ready_samples_bytes(
            validator.canonical(value), binding)


def test_ui_state_lag_recomputes_p95_from_raw_clock_pairs():
    value, binding = valid_ui_state_lag_samples()
    value["samples"][0]["observedAtMonotonicMs"] -= 90
    value["samples"][0]["observedAtUnixMs"] -= 90

    result = validator.validate_phase5_ui_state_lag_samples_bytes(
        validator.canonical(value), binding)

    assert result["value"] == value
    assert result["projection"] == {"uiStateLagP95Ms": 100}


def test_ui_state_lag_resets_probe_sequence_for_a_new_connection_generation():
    value, binding = valid_ui_state_lag_samples()
    probe = 0
    for sample in value["samples"][4:]:
        if sample["client"] != 1:
            continue
        probe += 1
        sample["connectionGeneration"] = 2
        sample["probeSeq"] = probe

    result = validator.validate_phase5_ui_state_lag_samples_bytes(
        validator.canonical(value), binding)

    assert result["projection"] == {"uiStateLagP95Ms": 100}


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schemaVersion=1),
    lambda value: value.update(kind="ui-state-lag"),
    lambda value: value["geometry"].update(blockFrames=2048),
    lambda value: value["window"].update(endedAtMonotonicMs=1_801_001),
    lambda value: value.update(hidden=True),
    lambda value: value["samples"].pop(),
    lambda value: value["samples"][0].update(sequence=2),
    lambda value: value["samples"][1].update(client=1),
    lambda value: value["samples"][4].update(probeSeq=1),
    lambda value: value["samples"][4].update(connectionGeneration=2),
    lambda value: value["samples"][0].update(connectionGeneration=False),
    lambda value: value["samples"][0].update(connectionGeneration=2),
    lambda value: [
        sample.update(connectionGeneration=2)
        for sample in value["samples"]
    ],
    lambda value: value["samples"][0].update(
        observedAtMonotonicMs=value["samples"][0]["sentAtMonotonicMs"] - 1),
    lambda value: value["samples"][0].update(
        observedAtUnixMs=value["samples"][0]["observedAtUnixMs"] + 2),
    lambda value: value["samples"][0].update(
        sentAtMonotonicMs=value["window"]["startedAtMonotonicMs"] + 4001,
        sentAtUnixMs=value["window"]["startedAtUnixMs"] + 4001,
        observedAtMonotonicMs=value["window"]["startedAtMonotonicMs"] + 4101,
        observedAtUnixMs=value["window"]["startedAtUnixMs"] + 4101),
    lambda value: value["samples"][-1].update(
        observedAtMonotonicMs=value["window"]["endedAtMonotonicMs"] - 6001,
        observedAtUnixMs=value["window"]["endedAtUnixMs"] - 6001),
    lambda value: value["samples"][1].update(
        sentAtMonotonicMs=value["samples"][0]["sentAtMonotonicMs"] + 8001,
        sentAtUnixMs=value["samples"][0]["sentAtUnixMs"] + 8001,
        observedAtMonotonicMs=
            value["samples"][0]["observedAtMonotonicMs"] + 8001,
        observedAtUnixMs=value["samples"][0]["observedAtUnixMs"] + 8001),
    lambda value: value["samples"][0].update(snapshotFrameSha256="x" * 64),
    lambda value: value["samples"][0].update(hidden=True),
])
def test_ui_state_lag_rejects_binding_coverage_sequence_and_clock_attacks(
        mutation):
    value, binding = valid_ui_state_lag_samples()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_UI_STATE_LAG_SAMPLES_INVALID"):
        validator.validate_phase5_ui_state_lag_samples_bytes(
            validator.canonical(value), binding)


@pytest.mark.parametrize(
    ("factory", "validator_name", "code"),
    [
        (
            valid_runtime_ready_samples,
            "validate_phase5_runtime_ready_samples_bytes",
            "PHASE5_RUNTIME_READY_SAMPLES_INVALID",
        ),
        (
            valid_ui_state_lag_samples,
            "validate_phase5_ui_state_lag_samples_bytes",
            "PHASE5_UI_STATE_LAG_SAMPLES_INVALID",
        ),
    ],
)
@pytest.mark.parametrize("transform", [
    lambda raw: raw + b"\n",
    lambda raw: b" " + raw,
    lambda raw: raw.replace(
        b'{"challenge":',
        b'{"schemaVersion":2,"challenge":',
        1,
    ),
    lambda _raw: b"\xff",
])
def test_latency_samples_require_strict_canonical_bytes(
        factory, validator_name, code, transform):
    value, binding = factory()
    with pytest.raises(validator.AcceptanceError, match=code):
        getattr(validator, validator_name)(
            transform(validator.canonical(value)), binding)
