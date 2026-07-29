from __future__ import annotations

import copy
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_render_samples", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

fixture_spec = importlib.util.spec_from_file_location(
    "phase5_summary_fixture_for_render_samples", SUMMARY_TEST)
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)


SAMPLE_COUNT = math.floor(
    validator.PHASE5_WINDOW_DURATION_MS / 250 * 0.90)
BLOCK_DURATION_MS = 4096 / 44100 * 1000


def test_phase5_wire_canonical_matches_ecmascript_number_spelling():
    assert validator.phase5_canonical({
        "integerFloat": 1.0,
        "smallFixed": 1e-5,
        "smallExponent": 1e-7,
        "largeFixed": 1e20,
        "largeExponent": 1e21,
        "negativeZero": -0.0,
    }) == (
        b'{"integerFloat":1,"largeExponent":1e+21,'
        b'"largeFixed":100000000000000000000,"negativeZero":0,'
        b'"smallExponent":1e-7,"smallFixed":0.00001}'
    )


def test_phase5_wire_canonical_sorts_object_keys_by_utf16_code_units():
    assert validator.phase5_canonical({
        "\ue000": 1,
        "\U0001f600": 2,
    }) == '{"😀":2,"\ue000":1}'.encode()


def test_phase5_wire_canonical_rejects_integer_outside_safe_number_domain():
    with pytest.raises(ValueError, match="PHASE5_SAFE_JSON_INTEGER_REQUIRED"):
        validator.phase5_canonical(validator.JS_MAX_SAFE_INTEGER + 1)


def test_phase5_wire_canonical_matches_node_for_ieee_boundary_vectors():
    values = [
        -0.0,
        0.0,
        -5e-324,
        5e-324,
        sys.float_info.min,
        sys.float_info.max,
        math.nextafter(1e-6, 0.0),
        1e-6,
        math.nextafter(1e-6, math.inf),
        math.nextafter(1e21, 0.0),
        1e21,
        math.nextafter(1e21, math.inf),
        333333333.33333329,
    ]
    script = (
        "const fs=require('node:fs');"
        "const xs=JSON.parse(fs.readFileSync(0,'utf8'));"
        "process.stdout.write(JSON.stringify(xs.map("
        "(value)=>JSON.stringify(value))));"
    )
    completed = subprocess.run(
        ["node", "-e", script],
        input=json.dumps(values, separators=(",", ":")).encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )

    assert [
        validator.phase5_canonical(value).decode()
        for value in values
    ] == json.loads(completed.stdout)


def valid_render_samples() -> tuple[dict, dict]:
    summary = fixture.structurally_valid_summary()
    binding = {
        name: copy.deepcopy(summary[name])
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    window = copy.deepcopy(summary["window"])
    samples = []
    for index in range(SAMPLE_COUNT):
        relative = (
            index * validator.PHASE5_WINDOW_DURATION_MS // SAMPLE_COUNT)
        samples.append({
            "sequence": index + 1,
            "atMonotonicMs": window["startedAtMonotonicMs"] + relative,
            "atUnixMs": window["startedAtUnixMs"] + relative,
            "renderP95Ms": 10,
            "renderP99Ms": 20,
            "blockDurationMs": BLOCK_DURATION_MS,
            "recentUnderruns": 0,
        })
    return {
        "schemaVersion": 2,
        "kind": "isolated-equivalent-spark-phase5-render-samples",
        **binding,
        "window": window,
        "samples": samples,
    }, binding


def test_render_samples_recompute_percentiles_from_raw_time_values():
    value, binding = valid_render_samples()
    raw = validator.canonical(value)

    result = validator.validate_phase5_render_samples_bytes(raw, binding)

    assert result["value"] == value
    assert result["projection"] == {
        "renderP95BlockFraction": 10 / BLOCK_DURATION_MS,
        "renderP99BlockFraction": 20 / BLOCK_DURATION_MS,
    }


def test_render_samples_accept_node_canonical_small_decimal_spelling():
    value, binding = valid_render_samples()
    value["samples"][0].update(
        renderP95Ms=1e-5,
        renderP99Ms=1e-5,
    )
    node_canonical = validator.canonical(value).replace(
        b'"renderP95Ms":1e-05,"renderP99Ms":1e-05',
        b'"renderP95Ms":0.00001,"renderP99Ms":0.00001',
        1,
    )

    result = validator.validate_phase5_render_samples_bytes(
        node_canonical, binding)

    assert result["value"]["samples"][0]["renderP95Ms"] == 1e-5


def test_render_samples_reject_metric_outside_js_safe_number_domain():
    value, binding = valid_render_samples()
    value["samples"][0].update(
        renderP95Ms=validator.JS_MAX_SAFE_INTEGER + 1,
        renderP99Ms=validator.JS_MAX_SAFE_INTEGER + 1,
    )

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RENDER_SAMPLES_INVALID"):
        validator.validate_phase5_render_samples_bytes(
            validator.canonical(value), binding)


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schemaVersion=1),
    lambda value: value.update(kind="render-samples"),
    lambda value: value.update(runId="ffffffff-ffff-1fff-afff-ffffffffffff"),
    lambda value: value["release"].update(releaseRevision="f" * 39),
    lambda value: value["geometry"].update(blockFrames=2048),
    lambda value: value["profile"].update(durationMinutes=31),
    lambda value: value["window"].update(endedAtUnixMs=1_700_001_800_001),
    lambda value: value.update(hidden=True),
])
def test_render_samples_reject_invalid_top_binding_and_window(mutation):
    value, binding = valid_render_samples()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RENDER_SAMPLES_INVALID"):
        validator.validate_phase5_render_samples_bytes(
            validator.canonical(value), binding)


@pytest.mark.parametrize("mutation", [
    lambda value: value["samples"].pop(),
    lambda value: value["samples"][0].update(sequence=2),
    lambda value: value["samples"][1].update(
        atMonotonicMs=value["samples"][0]["atMonotonicMs"]),
    lambda value: value["samples"][1].update(
        atUnixMs=value["samples"][1]["atUnixMs"] + 2),
    lambda value: value["samples"][0].update(
        atMonotonicMs=value["window"]["startedAtMonotonicMs"] + 501,
        atUnixMs=value["window"]["startedAtUnixMs"] + 501),
    lambda value: value["samples"][-1].update(
        atMonotonicMs=value["window"]["endedAtMonotonicMs"] - 751,
        atUnixMs=value["window"]["endedAtUnixMs"] - 751),
    lambda value: value["samples"][0].update(renderP95Ms=-1),
    lambda value: value["samples"][0].update(
        renderP95Ms=21, renderP99Ms=20),
    lambda value: value["samples"][0].update(
        blockDurationMs=BLOCK_DURATION_MS + 0.000001),
    lambda value: value["samples"][0].update(recentUnderruns=1),
    lambda value: value["samples"][0].update(recentUnderruns=False),
    lambda value: value["samples"][0].update(hidden=True),
])
def test_render_samples_reject_sequence_clock_coverage_and_raw_value_attacks(
        mutation):
    value, binding = valid_render_samples()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RENDER_SAMPLES_INVALID"):
        validator.validate_phase5_render_samples_bytes(
            validator.canonical(value), binding)


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
def test_render_samples_require_strict_canonical_bytes(transform):
    value, binding = valid_render_samples()
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_RENDER_SAMPLES_INVALID"):
        validator.validate_phase5_render_samples_bytes(
            transform(validator.canonical(value)), binding)
