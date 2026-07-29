from __future__ import annotations

import base64
import copy
import importlib.util
import math
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_species_load_samples", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

fixture_spec = importlib.util.spec_from_file_location(
    "phase5_summary_fixture_for_species_load_samples", SUMMARY_TEST)
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)


NORMAL_COUNT = math.floor(
    validator.PHASE5_WINDOW_DURATION_MS / 2000 * 0.95)
BURST_BATCH_COUNT = math.floor(
    validator.PHASE5_WINDOW_DURATION_MS / 10_000 * 0.95)
RESPONSE_BODY = validator.canonical({
    "choices": [{
        "message": {
            "content": '{"ok":true}',
        },
    }],
})
RESPONSE_BODY_BASE64 = base64.b64encode(RESPONSE_BODY).decode("ascii")


def binding_and_window() -> tuple[dict, dict]:
    summary = fixture.structurally_valid_summary()
    binding = {
        name: copy.deepcopy(summary[name])
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    return binding, copy.deepcopy(summary["window"])


def valid_species_samples(mode: str) -> tuple[dict, dict]:
    binding, window = binding_and_window()
    samples = []
    if mode == "normal":
        batches = NORMAL_COUNT
        slots = 1
    else:
        batches = BURST_BATCH_COUNT
        slots = 4
    sequence = 0
    for batch_index in range(batches):
        relative = (
            batch_index * validator.PHASE5_WINDOW_DURATION_MS // batches
        )
        for slot in range(1, slots + 1):
            sequence += 1
            started_relative = relative + slot - 1
            samples.append({
                "sequence": sequence,
                "batchSequence": batch_index + 1,
                "slot": slot,
                "startedAtMonotonicMs":
                    window["startedAtMonotonicMs"] + started_relative,
                "startedAtUnixMs":
                    window["startedAtUnixMs"] + started_relative,
                "settledAtMonotonicMs":
                    window["startedAtMonotonicMs"] + started_relative + 100,
                "settledAtUnixMs":
                    window["startedAtUnixMs"] + started_relative + 100,
                "httpStatus": 200,
                "responseBodyBase64": RESPONSE_BODY_BASE64,
            })
    return {
        "schemaVersion": 2,
        "kind": "isolated-equivalent-spark-phase5-species-load-samples",
        **binding,
        "window": window,
        "mode": mode,
        "samples": samples,
    }, binding


@pytest.mark.parametrize(
    ("mode", "expected_count"),
    [("normal", NORMAL_COUNT), ("burst", BURST_BATCH_COUNT * 4)],
)
def test_species_samples_validate_raw_response_and_recompute_counts(
        mode, expected_count):
    value, binding = valid_species_samples(mode)
    raw = validator.canonical(value)

    result = validator.validate_phase5_species_load_samples_bytes(
        raw, binding, mode)

    assert result["value"] == value
    assert result["requestCount"] == expected_count
    assert result["errors"] == 0
    assert result["sha256"] == validator.hashlib.sha256(raw).hexdigest()
    assert result["latenciesMs"] == [100] * expected_count


def test_normal_species_tail_uses_last_actual_response_not_last_sequence():
    value, binding = valid_species_samples("normal")
    window = value["window"]
    duration = validator.PHASE5_WINDOW_DURATION_MS
    schedule_duration = duration - 12_000
    for index, sample in enumerate(value["samples"]):
        relative = index * schedule_duration // len(value["samples"])
        sample.update(
            startedAtMonotonicMs=
                window["startedAtMonotonicMs"] + relative,
            startedAtUnixMs=window["startedAtUnixMs"] + relative,
            settledAtMonotonicMs=
                window["startedAtMonotonicMs"] + relative + 100,
            settledAtUnixMs=
                window["startedAtUnixMs"] + relative + 100,
        )
    penultimate = value["samples"][-2]
    penultimate["settledAtMonotonicMs"] = (
        penultimate["startedAtMonotonicMs"] + 15_000)
    penultimate["settledAtUnixMs"] = (
        penultimate["startedAtUnixMs"] + 15_000)

    result = validator.validate_phase5_species_load_samples_bytes(
        validator.canonical(value), binding, "normal")

    assert result["requestCount"] == NORMAL_COUNT


def test_burst_species_tail_uses_last_actual_response_across_batches():
    value, binding = valid_species_samples("burst")
    window = value["window"]
    duration = validator.PHASE5_WINDOW_DURATION_MS
    schedule_duration = duration - 40_000
    batch_count = len(value["samples"]) // 4
    for index, sample in enumerate(value["samples"]):
        batch_index = index // 4
        slot_offset = index % 4
        relative = (
            batch_index * schedule_duration // batch_count
            + slot_offset
        )
        sample.update(
            startedAtMonotonicMs=
                window["startedAtMonotonicMs"] + relative,
            startedAtUnixMs=window["startedAtUnixMs"] + relative,
            settledAtMonotonicMs=
                window["startedAtMonotonicMs"] + relative + 100,
            settledAtUnixMs=
                window["startedAtUnixMs"] + relative + 100,
        )
    previous_batch = value["samples"][-8]
    previous_batch["settledAtMonotonicMs"] = (
        previous_batch["startedAtMonotonicMs"] + 15_000)
    previous_batch["settledAtUnixMs"] = (
        previous_batch["startedAtUnixMs"] + 15_000)

    result = validator.validate_phase5_species_load_samples_bytes(
        validator.canonical(value), binding, "burst")

    assert result["requestCount"] == BURST_BATCH_COUNT * 4


def test_species_rejects_oversized_base64_before_decoding(
        monkeypatch):
    value, binding = valid_species_samples("normal")
    maximum_encoded = 4 * (
        (validator.MAX_PHASE5_SPECIES_RESPONSE_BYTES + 2) // 3
    )
    value["samples"][0]["responseBodyBase64"] = "A" * (
        maximum_encoded + 4)

    def must_not_decode(_value, _code):
        pytest.fail("oversized base64 reached decoder")

    monkeypatch.setattr(
        validator,
        "decode_canonical_base64",
        must_not_decode,
    )
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SPECIES_LOAD_SAMPLES_INVALID"):
        validator.validate_phase5_species_load_samples_bytes(
            validator.canonical(value), binding, "normal")


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schemaVersion=1),
    lambda value: value.update(kind="species-load"),
    lambda value: value.update(mode="burst"),
    lambda value: value["profile"].update(speciesModel="other"),
    lambda value: value["window"].update(endedAtUnixMs=1_700_001_800_001),
    lambda value: value.update(hidden=True),
    lambda value: value["samples"].pop(),
    lambda value: value["samples"][0].update(sequence=2),
    lambda value: value["samples"][0].update(batchSequence=2),
    lambda value: value["samples"][0].update(slot=2),
    lambda value: value["samples"][0].update(
        settledAtMonotonicMs=
            value["samples"][0]["startedAtMonotonicMs"] - 1),
    lambda value: value["samples"][0].update(
        settledAtUnixMs=value["samples"][0]["settledAtUnixMs"] + 2),
    lambda value: value["samples"][0].update(
        settledAtMonotonicMs=
            value["samples"][0]["startedAtMonotonicMs"] + 15_001,
        settledAtUnixMs=
            value["samples"][0]["startedAtUnixMs"] + 15_001),
    lambda value: value["samples"][0].update(httpStatus=False),
    lambda value: value["samples"][0].update(httpStatus=500),
    lambda value: value["samples"][0].update(responseBodyBase64="AA"),
    lambda value: value["samples"][0].update(
        responseBodyBase64=base64.b64encode(
            b'{"choices":[]}'
        ).decode("ascii")),
    lambda value: value["samples"][0].update(
        responseBodyBase64=base64.b64encode(
            b'{"choices":[{"message":{"content":"{\\"ok\\":false}"}}]}'
        ).decode("ascii")),
    lambda value: value["samples"][0].update(
        responseBodyBase64=base64.b64encode(
            b'{"choices":[{"message":{"content":"{\\"ok\\":true,'
            b'\\"ok\\":true}"}}]}'
        ).decode("ascii")),
    lambda value: value["samples"][0].update(hidden=True),
])
def test_normal_species_samples_reject_shape_clock_schedule_and_response_attacks(
        mutation):
    value, binding = valid_species_samples("normal")
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SPECIES_LOAD_SAMPLES_INVALID"):
        validator.validate_phase5_species_load_samples_bytes(
            validator.canonical(value), binding, "normal")


@pytest.mark.parametrize("mutation", [
    lambda value: value["samples"].pop(),
    lambda value: value["samples"][1].update(slot=1),
    lambda value: value["samples"][4].update(batchSequence=1),
    lambda value: value["samples"][3].update(
        startedAtMonotonicMs=
            value["samples"][0]["startedAtMonotonicMs"] + 101,
        startedAtUnixMs=value["samples"][0]["startedAtUnixMs"] + 101,
        settledAtMonotonicMs=
            value["samples"][0]["settledAtMonotonicMs"] + 101,
        settledAtUnixMs=value["samples"][0]["settledAtUnixMs"] + 101),
    lambda value: value["samples"][0].update(
        startedAtMonotonicMs=
            value["window"]["startedAtMonotonicMs"] + 20_001,
        startedAtUnixMs=value["window"]["startedAtUnixMs"] + 20_001,
        settledAtMonotonicMs=
            value["window"]["startedAtMonotonicMs"] + 20_101,
        settledAtUnixMs=value["window"]["startedAtUnixMs"] + 20_101),
    lambda value: value["samples"][4].update(
        startedAtMonotonicMs=
            value["samples"][0]["startedAtMonotonicMs"] + 50_001,
        startedAtUnixMs=value["samples"][0]["startedAtUnixMs"] + 50_001,
        settledAtMonotonicMs=
            value["samples"][0]["settledAtMonotonicMs"] + 50_001,
        settledAtUnixMs=
            value["samples"][0]["settledAtUnixMs"] + 50_001),
])
def test_burst_species_samples_reject_batch_and_coverage_attacks(mutation):
    value, binding = valid_species_samples("burst")
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SPECIES_LOAD_SAMPLES_INVALID"):
        validator.validate_phase5_species_load_samples_bytes(
            validator.canonical(value), binding, "burst")


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
def test_species_samples_require_strict_canonical_outer_bytes(transform):
    value, binding = valid_species_samples("normal")
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_SPECIES_LOAD_SAMPLES_INVALID"):
        validator.validate_phase5_species_load_samples_bytes(
            transform(validator.canonical(value)), binding, "normal")
