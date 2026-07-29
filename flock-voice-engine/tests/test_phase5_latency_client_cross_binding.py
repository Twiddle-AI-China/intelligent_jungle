from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
CLIENT_TEST = ROOT / "flock-voice-engine/tests/test_phase5_client_observations.py"
LATENCY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_latency_samples.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_latency_client_cross_binding", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

client_spec = importlib.util.spec_from_file_location(
    "phase5_client_fixture_for_latency_cross_binding", CLIENT_TEST)
client_fixture = importlib.util.module_from_spec(client_spec)
client_spec.loader.exec_module(client_fixture)

latency_spec = importlib.util.spec_from_file_location(
    "phase5_latency_fixture_for_client_cross_binding", LATENCY_TEST)
latency_fixture = importlib.util.module_from_spec(latency_spec)
latency_spec.loader.exec_module(latency_fixture)


def validated_cross_binding_inputs() -> tuple[dict, dict, dict]:
    client_value, binding, signed = (
        client_fixture.valid_client_observations())
    client_value["events"] = [
        event for event in client_value["events"]
        if event["type"] != "runtime.snapshot"
        and not (
            event["client"] == 4
            and event["type"] in {
                "runtime.close", "runtime.open", "runtime.ready",
            }
            and event["atMonotonicMs"]
                >= client_value["window"]["startedAtMonotonicMs"] + 500_000
        )
    ]
    signed["runtimeOpens"] = [
        item for item in signed["runtimeOpens"]
        if not (
            item["client"] == 4
            and item["connectionGeneration"] == 2
        )
    ]

    runtime_value, _runtime_binding = (
        latency_fixture.valid_runtime_ready_samples())
    for sample in runtime_value["samples"]:
        sample["readyAtMonotonicMs"] = (
            sample["openedAtMonotonicMs"] + 50)
        sample["readyAtUnixMs"] = sample["openedAtUnixMs"] + 50
        client = sample["client"]
        opened = next(
            event for event in client_value["events"]
            if event["client"] == client
            and event["type"] == "runtime.open"
            and event["connectionGeneration"] == 1
        )
        ready = next(
            event for event in client_value["events"]
            if event["client"] == client
            and event["type"] == "runtime.ready"
            and event["connectionGeneration"] == 1
        )
        opened.update({
            "atMonotonicMs": sample["openedAtMonotonicMs"],
            "atUnixMs": sample["openedAtUnixMs"],
        })
        ready.update({
            "atMonotonicMs": sample["readyAtMonotonicMs"],
            "atUnixMs": sample["readyAtUnixMs"],
        })
        signed_open = next(
            item for item in signed["runtimeOpens"]
            if item["client"] == client
            and item["connectionGeneration"] == 1
        )
        signed_open.update({
            "atMonotonicMs": sample["openedAtMonotonicMs"],
            "atUnixMs": sample["openedAtUnixMs"],
        })
        sample.update({
            "openedAtMonotonicMs": opened["atMonotonicMs"],
            "openedAtUnixMs": opened["atUnixMs"],
            "readyAtMonotonicMs": ready["atMonotonicMs"],
            "readyAtUnixMs": ready["atUnixMs"],
            "readyFrameSha256": ready["payload"]["frameSha256"],
        })

    ui_value, _ui_binding = latency_fixture.valid_ui_state_lag_samples()
    next_tiebreak = len(client_value["events"]) + 1
    drafts = []
    for event in client_value["events"]:
        drafts.append((event, event["sequence"]))
    for sample in ui_value["samples"]:
        drafts.append(({
            "sequence": 0,
            "client": sample["client"],
            "type": "runtime.snapshot",
            "connectionGeneration": sample["connectionGeneration"],
            "atMonotonicMs": sample["observedAtMonotonicMs"],
            "atUnixMs": sample["observedAtUnixMs"],
            "payload": {
                "frameSha256": sample["snapshotFrameSha256"],
                "worldGeneration": client_fixture.WORLD,
                "revision": sample["sequence"] + 10,
                "eventSeq": sample["sequence"] + 10,
                "probeSeq": sample["probeSeq"],
            },
        }, next_tiebreak))
        next_tiebreak += 1
    drafts.sort(key=lambda item: (
        item[0]["atMonotonicMs"],
        item[0]["atUnixMs"],
        item[1],
    ))
    client_value["events"] = [event for event, _order in drafts]
    for sequence, event in enumerate(client_value["events"], start=1):
        event["sequence"] = sequence

    runtime_result = (
        validator.validate_phase5_runtime_ready_samples_bytes(
            validator.canonical(runtime_value), binding))
    ui_result = validator.validate_phase5_ui_state_lag_samples_bytes(
        validator.canonical(ui_value), binding)
    client_result = validator.validate_phase5_client_observations_bytes(
        validator.canonical(client_value), binding, signed)
    return runtime_result, ui_result, client_result


@pytest.fixture(scope="module")
def valid_results():
    return validated_cross_binding_inputs()


def test_latency_samples_exactly_cross_bind_client_receive_events(
        valid_results):
    runtime, ui, client = valid_results

    projection = validator.validate_phase5_latency_client_cross_binding(
        runtime, ui, client)

    assert projection == {
        "runtimeReadySampleCount": 4,
        "uiStateLagSampleCount":
            len(ui["value"]["samples"]),
        "runtimeSnapshotEventCount":
            len(ui["value"]["samples"]),
    }


@pytest.mark.parametrize("mutation", [
    lambda runtime, _ui, _client: runtime["value"]["samples"][0].update(
        openedAtMonotonicMs=
            runtime["value"]["samples"][0]["openedAtMonotonicMs"] + 1,
        openedAtUnixMs=
            runtime["value"]["samples"][0]["openedAtUnixMs"] + 1),
    lambda runtime, _ui, _client: runtime["value"]["samples"][0].update(
        readyFrameSha256="f" * 64),
    lambda _runtime, ui, _client: ui["value"]["samples"][0].update(
        observedAtMonotonicMs=
            ui["value"]["samples"][0]["observedAtMonotonicMs"] + 1,
        observedAtUnixMs=
            ui["value"]["samples"][0]["observedAtUnixMs"] + 1),
    lambda _runtime, ui, _client: ui["value"]["samples"][0].update(
        snapshotFrameSha256="f" * 64),
    lambda _runtime, _ui, client: client["value"]["events"].append(
        copy.deepcopy(next(
            event for event in client["value"]["events"]
            if event["type"] == "runtime.snapshot"
        ))),
])
def test_latency_client_cross_binding_rejects_rebound_or_unconsumed_events(
        valid_results, mutation):
    runtime, ui, client = copy.deepcopy(valid_results)
    mutation(runtime, ui, client)

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_LATENCY_CLIENT_BINDING_INVALID"):
        validator.validate_phase5_latency_client_cross_binding(
            runtime, ui, client)
