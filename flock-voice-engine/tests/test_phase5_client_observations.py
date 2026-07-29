from __future__ import annotations

import copy
import hashlib
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "flock-voice-engine/tools/validate_phase5_acceptance.py"
SUMMARY_TEST = ROOT / "flock-voice-engine/tests/test_phase5_summary_schema.py"

validator_spec = importlib.util.spec_from_file_location(
    "phase5_acceptance_client_observations", TOOL)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

fixture_spec = importlib.util.spec_from_file_location(
    "phase5_summary_fixture_for_client_observations", SUMMARY_TEST)
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)


H = "a" * 64
EPOCH = "phase5-audio-epoch-1"
WORLD = "phase5-world-generation-1"
PAUSE_TRANSPORT_SEQUENCE = 10_001
RESUME_TRANSPORT_SEQUENCE = 10_002
DISCONTINUITY_TRANSPORT_SEQUENCE = 5_001
PAUSE_TRANSPORT_SHA256 = "b" * 64
RESUME_TRANSPORT_SHA256 = "c" * 64
DISCONTINUITY_TRANSPORT_SHA256 = "d" * 64


def _identity(client: int) -> str:
    return hashlib.sha256(f"phase5-client-{client}".encode()).hexdigest()


def _frame_sha(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


def valid_client_observations() -> tuple[dict, dict, dict]:
    summary = fixture.structurally_valid_summary()
    binding = {
        name: copy.deepcopy(summary[name])
        for name in ("runId", "challenge", "release", "geometry", "profile")
    }
    window = copy.deepcopy(summary["window"])
    clients = [
        {"client": client, "clientIdentitySha256": _identity(client)}
        for client in range(1, 5)
    ]
    drafts: list[dict] = []
    insertion_order = 0

    def add(relative: int, client: int, event_type: str,
            generation: int, payload: dict) -> None:
        nonlocal insertion_order
        insertion_order += 1
        drafts.append({
            "_order": insertion_order,
            "client": client,
            "type": event_type,
            "connectionGeneration": generation,
            "atMonotonicMs": window["startedAtMonotonicMs"] + relative,
            "atUnixMs": window["startedAtUnixMs"] + relative,
            "payload": payload,
        })

    for client in range(1, 5):
        add(0, client, "runtime.open", 1, {"mode": "bootstrap"})
        add(0, client, "runtime.ready", 1, {
            "frameSha256": _frame_sha(f"runtime-ready-{client}-1"),
            "worldGeneration": WORLD,
            "revision": 1,
            "eventSeq": 1,
        })
        add(0, client, "audio.open", 1, {})
        add(0, client, "audio.ready", 1, {
            "frameSha256": _frame_sha(f"audio-ready-{client}-1"),
            "audioEpoch": EPOCH,
            "streamRevision": 1,
            "blockSeq": 0,
            "resumeStartFrame": "0",
        })

    add(100_000, 1, "runtime.snapshot", 1, {
        "frameSha256": _frame_sha("runtime-snapshot-1-1"),
        "worldGeneration": WORLD,
        "revision": 2,
        "eventSeq": 2,
        "probeSeq": 1,
    })
    add(100_500, 2, "audio.discontinuity", 1, {
        "frameSha256": _frame_sha("audio-discontinuity-2-1"),
        "scope": "client",
        "audioEpoch": EPOCH,
        "streamRevision": 1,
        "blockSeq": 100,
        "resumeStartFrame": str(100 * 4096),
    })

    add(500_000, 4, "runtime.close", 1, {
        "code": 1_000,
        "reason": "PHASE5_RUNTIME_RECONNECT",
    })
    add(500_100, 4, "runtime.open", 2, {"mode": "resume"})
    add(500_200, 4, "runtime.ready", 2, {
        "frameSha256": _frame_sha("runtime-ready-4-2"),
        "worldGeneration": WORLD,
        "revision": 3,
        "eventSeq": 3,
    })
    add(600_000, 4, "runtime.snapshot", 2, {
        "frameSha256": _frame_sha("runtime-snapshot-4-2"),
        "worldGeneration": WORLD,
        "revision": 4,
        "eventSeq": 4,
        "probeSeq": 1,
    })

    add(700_500, 1, "audio.close", 1, {
        "code": 1_000,
        "reason": "PHASE5_AUDIO_RECONNECT",
    })
    add(700_600, 1, "audio.open", 2, {})
    add(700_700, 1, "audio.ready", 2, {
        "frameSha256": _frame_sha("audio-ready-1-2"),
        "audioEpoch": EPOCH,
        "streamRevision": 1,
        "blockSeq": 700,
        "resumeStartFrame": str(700 * 4096),
    })

    add(899_500, 4, "audio.pause", 1, {
        "transportSequence": PAUSE_TRANSPORT_SEQUENCE,
        "transportEventSha256": PAUSE_TRANSPORT_SHA256,
    })
    add(906_500, 4, "audio.resume", 1, {
        "transportSequence": RESUME_TRANSPORT_SEQUENCE,
        "transportEventSha256": RESUME_TRANSPORT_SHA256,
    })

    pcm_index = {client: 0 for client in range(1, 5)}
    for relative in range(1_000, validator.PHASE5_WINDOW_DURATION_MS + 1, 1_000):
        for client in range(1, 5):
            if client == 4 and 900_000 <= relative <= 906_000:
                continue
            index = pcm_index[client]
            generation = 2 if client == 1 and relative > 700_500 else 1
            add(relative, client, "audio.pcm", generation, {
                "frameSha256": _frame_sha(f"pcm-{client}-{index}"),
                "byteLength": 32_800,
                "wireVersion": 1,
                "flags": 0,
                "headerBytes": 32,
                "audioEpoch": EPOCH,
                "streamRevision": 1,
                "blockSeq": index,
                "startFrame": str(index * 4096),
                "frameCount": 4_096,
                "channels": 2,
                "format": 1,
                "headerValid": True,
                "lengthValid": True,
                "finiteSamples": True,
                "cursorValid": True,
            })
            pcm_index[client] += 1

    drafts.sort(key=lambda event: (
        event["atMonotonicMs"], event["atUnixMs"], event["_order"]))
    events = []
    for sequence, draft in enumerate(drafts, start=1):
        event = copy.deepcopy(draft)
        event.pop("_order")
        events.append({"sequence": sequence, **event})

    value = {
        "schemaVersion": 2,
        "kind": "isolated-equivalent-spark-phase5-client-observations",
        **binding,
        "window": window,
        "clients": clients,
        "events": events,
    }

    runtime_opens = []
    for event in events:
        if event["type"] != "runtime.open":
            continue
        runtime_opens.append({
            "client": event["client"],
            "connectionGeneration": event["connectionGeneration"],
            "atMonotonicMs": event["atMonotonicMs"],
            "atUnixMs": event["atUnixMs"],
            "mode": event["payload"]["mode"],
            "clientIdentitySha256": _identity(event["client"]),
        })
    audio_lifecycle = [{
        "client": event["client"],
        "connectionGeneration": event["connectionGeneration"],
        "type": event["type"],
        "atMonotonicMs": event["atMonotonicMs"],
        "atUnixMs": event["atUnixMs"],
        "payload": copy.deepcopy(event["payload"]),
    } for event in events if event["type"] in {
        "audio.open", "audio.close",
    }]

    def receipt(event_type: str) -> dict:
        event = next(item for item in events if item["type"] == event_type)
        return {
            "connectionGeneration": event["connectionGeneration"],
            "atMonotonicMs": event["atMonotonicMs"],
            "atUnixMs": event["atUnixMs"],
            **copy.deepcopy(event["payload"]),
        }

    discontinuity = next(
        item for item in events if item["type"] == "audio.discontinuity")
    signed_transport_projection = {
        "schemaVersion": 1,
        "kind": "phase5-client-observations-signed-transport-projection",
        **copy.deepcopy(binding),
        "window": copy.deepcopy(window),
        "runtimeOpens": runtime_opens,
        "audioLifecycle": audio_lifecycle,
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
            "transportSequence": DISCONTINUITY_TRANSPORT_SEQUENCE,
            "transportEventSha256": DISCONTINUITY_TRANSPORT_SHA256,
            **{
                name: copy.deepcopy(discontinuity["payload"][name])
                for name in (
                    "scope", "audioEpoch", "streamRevision",
                    "blockSeq", "resumeStartFrame",
                )
            },
        }],
    }
    return value, binding, signed_transport_projection


def find_event(value: dict, event_type: str, client: int | None = None,
               occurrence: int = 0) -> dict:
    matches = [
        event for event in value["events"]
        if event["type"] == event_type
        and (client is None or event["client"] == client)
    ]
    return matches[occurrence]


def validate(value: dict, binding: dict, signed: dict) -> dict:
    return validator.validate_phase5_client_observations_bytes(
        validator.canonical(value), binding, signed)


def test_client_observations_accept_and_recompute_raw_projection():
    value, binding, signed = valid_client_observations()

    result = validate(value, binding, signed)

    assert result["value"] == value
    assert result["projection"] == {
        "schemaVersion": 1,
        "kind": "phase5-client-observations-projection",
        "eventCount": len(value["events"]),
        "clients": [
            {
                "client": client,
                "clientIdentitySha256": _identity(client),
                "runtimeOpenCount": 2 if client == 4 else 1,
                "runtimeSnapshotCount": 1 if client in (1, 4) else 0,
                "audioPcmFrameCount": (
                    1_793 if client == 4 else 1_800
                ),
                "audioPcmByteLength": (
                    1_793 if client == 4 else 1_800
                ) * 32_800,
                "audioDiscontinuityCount": 1 if client == 2 else 0,
            }
            for client in range(1, 5)
        ],
        "slowClient": {
            "client": 4,
            "pause": copy.deepcopy(signed["slowClient"]["pause"]),
            "resume": copy.deepcopy(signed["slowClient"]["resume"]),
            "pausedMonotonicMs": 7_000,
            "pausedUnixMs": 7_000,
        },
        "pcmCorruptions": 0,
        "cursorDiscontinuitiesUnexpected": 0,
    }


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schemaVersion=1),
    lambda value: value.update(kind="client-observations"),
    lambda value: value.update(runId="ffffffff-ffff-1fff-afff-ffffffffffff"),
    lambda value: value["release"].update(releaseRevision="f" * 39),
    lambda value: value["geometry"].update(blockFrames=2048),
    lambda value: value["profile"].update(clients=3),
    lambda value: value["window"].update(endedAtUnixMs=1_700_001_800_001),
    lambda value: value.update(hidden=True),
])
def test_client_observations_reject_top_binding_and_window_attacks(mutation):
    value, binding, signed = valid_client_observations()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


@pytest.mark.parametrize("mutation", [
    lambda value: value["clients"].reverse(),
    lambda value: value["clients"][1].update(
        clientIdentitySha256=value["clients"][0]["clientIdentitySha256"]),
    lambda value: value["clients"][0].update(client=False),
    lambda value: value["clients"][0].update(hidden=True),
])
def test_client_observations_require_four_sorted_unique_exact_clients(mutation):
    value, binding, signed = valid_client_observations()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_bind_client_identities_to_all_signed_runtime_opens():
    value, binding, signed = valid_client_observations()
    signed["runtimeOpens"][-1]["clientIdentitySha256"] = "f" * 64

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_bind_signed_projection_to_full_release_context():
    value, binding, signed = valid_client_observations()
    signed["challenge"] = "f" * 64

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


@pytest.mark.parametrize("mutation", [
    lambda value: value["events"][1].update(sequence=1),
    lambda value: value["events"][1].update(client=0),
    lambda value: value["events"][1].update(connectionGeneration=False),
    lambda value: value["events"][1].update(
        atMonotonicMs=value["window"]["startedAtMonotonicMs"] - 1),
    lambda value: value["events"][1].update(
        atUnixMs=value["events"][1]["atUnixMs"] + 2),
    lambda value: value["events"][2].update(
        atMonotonicMs=value["events"][1]["atMonotonicMs"] - 1),
    lambda value: value["events"][1].update(hidden=True),
    lambda value: value["events"][1].update(type="runtime.unknown"),
])
def test_client_observations_reject_event_envelope_sequence_and_clock_attacks(
        mutation):
    value, binding, signed = valid_client_observations()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_reject_event_count_above_controlled_limit(
        monkeypatch):
    value, binding, signed = valid_client_observations()
    monkeypatch.setattr(
        validator,
        "MAX_PHASE5_CLIENT_EVENTS",
        len(value["events"]) - 1,
    )

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


@pytest.mark.parametrize("event_type", [
    "runtime.error",
    "runtime.invalid-frame",
    "audio.error",
    "audio.invalid-frame",
])
def test_client_observations_reject_recorded_error_and_invalid_frames(
        event_type):
    value, binding, signed = valid_client_observations()
    target = find_event(value, "runtime.snapshot")
    target["type"] = event_type
    target["payload"] = (
        {}
        if event_type.endswith(".error")
        else {
            "frameSha256": H,
            "byteLength": 1,
            "validationCode": "INVALID_FRAME",
        }
    )
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


@pytest.mark.parametrize("event_type", [
    "runtime.open",
    "runtime.ready",
    "runtime.snapshot",
    "runtime.close",
    "audio.open",
    "audio.ready",
    "audio.pcm",
    "audio.discontinuity",
    "audio.pause",
    "audio.resume",
    "audio.close",
])
def test_client_observations_require_exact_payload_for_every_accepted_type(
        event_type):
    value, binding, signed = valid_client_observations()
    find_event(value, event_type)["payload"]["hidden"] = True
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


@pytest.mark.parametrize(("field", "bad_value"), [
    ("frameSha256", "f" * 63),
    ("byteLength", 32_799),
    ("wireVersion", 2),
    ("flags", 1),
    ("headerBytes", 31),
    ("audioEpoch", ""),
    ("streamRevision", 0),
    ("blockSeq", False),
    ("startFrame", "00"),
    ("frameCount", 2_048),
    ("channels", 1),
    ("format", 2),
    ("headerValid", False),
    ("lengthValid", False),
    ("finiteSamples", False),
    ("cursorValid", False),
])
def test_client_observations_reject_pcm_wire_header_and_validation_attacks(
        field, bad_value):
    value, binding, signed = valid_client_observations()
    find_event(value, "audio.pcm")["payload"][field] = bad_value
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


@pytest.mark.parametrize("mutation", [
    lambda value: find_event(
        value, "audio.pcm", client=1)["payload"].update(blockSeq=1),
    lambda value: find_event(
        value, "audio.pcm", client=1)["payload"].update(startFrame="4096"),
    lambda value: find_event(
        value, "runtime.open", client=4, occurrence=1).update(
            connectionGeneration=3),
    lambda value: find_event(
        value, "audio.open", client=1, occurrence=1).update(
            connectionGeneration=1),
    lambda value: find_event(
        value, "audio.ready", client=1, occurrence=1)["payload"].update(
            resumeStartFrame="0"),
])
def test_client_observations_reject_generation_and_cursor_transition_attacks(
        mutation):
    value, binding, signed = valid_client_observations()
    mutation(value)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


@pytest.mark.parametrize("indices", [
    (0,),
    (100, 101),
    (-1, -2),
])
def test_client_observations_hot_clients_have_no_boundary_or_pair_gap_exemption(
        indices):
    value, binding, signed = valid_client_observations()
    pcm = [
        event for event in value["events"]
        if event["type"] == "audio.pcm" and event["client"] == 1
    ]
    remove = {id(pcm[index]) for index in indices}
    value["events"] = [
        event for event in value["events"] if id(event) not in remove
    ]
    for sequence, event in enumerate(value["events"], start=1):
        event["sequence"] = sequence
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


@pytest.mark.parametrize("mutation", [
    lambda value, signed: find_event(
        value, "audio.pause")["payload"].update(
            transportEventSha256="e" * 64),
    lambda value, signed: find_event(
        value, "audio.pause").update(client=3),
    lambda value, signed: find_event(
        value, "audio.pause").update(connectionGeneration=2),
    lambda value, signed: signed["slowClient"]["resume"].update(
        transportSequence=99_999),
    lambda value, signed: signed.update(hidden=True),
])
def test_client_observations_slow_client_receipts_are_exact_signed_projection(
        mutation):
    value, binding, signed = valid_client_observations()
    mutation(value, signed)
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_reject_pcm_received_while_slow_client_paused():
    value, binding, signed = valid_client_observations()
    first_after_resume = next(
        event for event in value["events"]
        if event["type"] == "audio.pcm"
        and event["client"] == 4
        and event["atMonotonicMs"]
        > signed["slowClient"]["resume"]["atMonotonicMs"]
    )
    relative = 900_000
    first_after_resume["atMonotonicMs"] = (
        value["window"]["startedAtMonotonicMs"] + relative)
    first_after_resume["atUnixMs"] = (
        value["window"]["startedAtUnixMs"] + relative)
    value["events"].sort(key=lambda event: (
        event["atMonotonicMs"], event["atUnixMs"], event["sequence"]))
    for sequence, event in enumerate(value["events"], start=1):
        event["sequence"] = sequence
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_reject_resume_without_any_later_pcm():
    value, binding, signed = valid_client_observations()
    resume_at = signed["slowClient"]["resume"]["atMonotonicMs"]
    value["events"] = [
        event for event in value["events"]
        if not (
            event["type"] == "audio.pcm"
            and event["client"] == 4
            and event["atMonotonicMs"] > resume_at
        )
    ]
    for sequence, event in enumerate(value["events"], start=1):
        event["sequence"] = sequence
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_discontinuities_biject_signed_transport_projection():
    value, binding, signed = valid_client_observations()
    signed["discontinuities"] = []
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)

    value, binding, signed = valid_client_observations()
    signed["discontinuities"].append(
        copy.deepcopy(signed["discontinuities"][0]))
    signed["discontinuities"][-1]["transportSequence"] += 1
    signed["discontinuities"][-1]["transportEventSha256"] = "e" * 64
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_reject_same_epoch_stream_cursor_rollback():
    value, binding, signed = valid_client_observations()
    discontinuity = find_event(
        value, "audio.discontinuity", client=2)
    prior_block = discontinuity["payload"]["blockSeq"]
    discontinuity["payload"].update(
        scope="stream",
        streamRevision=2,
        blockSeq=0,
        resumeStartFrame="0",
    )
    signed_discontinuity = signed["discontinuities"][0]
    signed_discontinuity.update(
        scope="stream",
        streamRevision=2,
        blockSeq=0,
        resumeStartFrame="0",
    )
    for event in value["events"]:
        if (event["type"] == "audio.pcm"
                and event["client"] == 2
                and event["sequence"] > discontinuity["sequence"]):
            event["payload"]["streamRevision"] = 2
            event["payload"]["blockSeq"] -= prior_block
            event["payload"]["startFrame"] = str(
                int(event["payload"]["startFrame"])
                - prior_block * 4096
            )

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_reject_reuse_of_historical_stream_epoch():
    value, binding, signed = valid_client_observations()
    first = find_event(value, "audio.discontinuity", client=2)
    first["payload"].update(
        scope="stream",
        audioEpoch="phase5-audio-epoch-2",
        streamRevision=2,
        blockSeq=0,
        resumeStartFrame="0",
    )
    signed["discontinuities"][0].update(
        scope="stream",
        audioEpoch="phase5-audio-epoch-2",
        streamRevision=2,
        blockSeq=0,
        resumeStartFrame="0",
    )

    second = {
        "sequence": 0,
        "client": 2,
        "type": "audio.discontinuity",
        "connectionGeneration": 1,
        "atMonotonicMs": first["atMonotonicMs"] + 1,
        "atUnixMs": first["atUnixMs"] + 1,
        "payload": {
            "frameSha256": _frame_sha("audio-discontinuity-2-2"),
            "scope": "stream",
            "audioEpoch": EPOCH,
            "streamRevision": 3,
            "blockSeq": 0,
            "resumeStartFrame": "0",
        },
    }
    value["events"].append(second)
    value["events"].sort(key=lambda event: (
        event["atMonotonicMs"], event["atUnixMs"], event["sequence"]))
    for sequence, event in enumerate(value["events"], start=1):
        event["sequence"] = sequence

    signed["discontinuities"].append({
        "client": 2,
        "connectionGeneration": 1,
        "atMonotonicMs": second["atMonotonicMs"],
        "atUnixMs": second["atUnixMs"],
        "transportSequence": DISCONTINUITY_TRANSPORT_SEQUENCE + 1,
        "transportEventSha256": "e" * 64,
        "scope": "stream",
        "audioEpoch": EPOCH,
        "streamRevision": 3,
        "blockSeq": 0,
        "resumeStartFrame": "0",
    })

    pcm_after_second = [
        event for event in value["events"]
        if event["type"] == "audio.pcm"
        and event["client"] == 2
        and event["atMonotonicMs"] > second["atMonotonicMs"]
    ]
    for block_seq, event in enumerate(pcm_after_second):
        event["payload"].update(
            audioEpoch=EPOCH,
            streamRevision=3,
            blockSeq=block_seq,
            startFrame=str(block_seq * 4096),
        )

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_bind_every_audio_open_and_close_to_signed_transport():
    value, binding, signed = valid_client_observations()
    close = next(
        item for item in signed["audioLifecycle"]
        if item["type"] == "audio.close"
    )
    close["payload"]["code"] = 4001

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_reject_unsigned_complete_audio_reconnect():
    value, binding, signed = valid_client_observations()
    window = value["window"]
    reconnect_at = 800_100
    injected = [
        {
            "sequence": 0,
            "client": 3,
            "type": "audio.close",
            "connectionGeneration": 1,
            "atMonotonicMs":
                window["startedAtMonotonicMs"] + reconnect_at,
            "atUnixMs": window["startedAtUnixMs"] + reconnect_at,
            "payload": {
                "code": 4_001,
                "reason": "PHASE5_UNSIGNED_AUDIO_RECONNECT",
            },
        },
        {
            "sequence": 0,
            "client": 3,
            "type": "audio.open",
            "connectionGeneration": 2,
            "atMonotonicMs":
                window["startedAtMonotonicMs"] + reconnect_at + 100,
            "atUnixMs": window["startedAtUnixMs"] + reconnect_at + 100,
            "payload": {},
        },
        {
            "sequence": 0,
            "client": 3,
            "type": "audio.ready",
            "connectionGeneration": 2,
            "atMonotonicMs":
                window["startedAtMonotonicMs"] + reconnect_at + 200,
            "atUnixMs": window["startedAtUnixMs"] + reconnect_at + 200,
            "payload": {
                "frameSha256": _frame_sha(
                    "unsigned-audio-ready-3-2"),
                "audioEpoch": EPOCH,
                "streamRevision": 1,
                "blockSeq": 800,
                "resumeStartFrame": str(800 * 4096),
            },
        },
    ]
    value["events"].extend(injected)
    for event in value["events"]:
        if (event["type"] == "audio.pcm"
                and event["client"] == 3
                and event["atMonotonicMs"]
                    > injected[-1]["atMonotonicMs"]):
            event["connectionGeneration"] = 2
    value["events"].sort(key=lambda event: (
        event["atMonotonicMs"], event["atUnixMs"], event["sequence"]))
    for sequence, event in enumerate(value["events"], start=1):
        event["sequence"] = sequence

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


def test_client_observations_signed_receipt_chain_time_follows_transport_sequence():
    value, binding, signed = valid_client_observations()
    signed["discontinuities"][0]["transportSequence"] = (
        RESUME_TRANSPORT_SEQUENCE + 1)

    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validate(value, binding, signed)


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
def test_client_observations_require_strict_canonical_bytes(transform):
    value, binding, signed = valid_client_observations()
    with pytest.raises(
            validator.AcceptanceError,
            match="PHASE5_CLIENT_OBSERVATIONS_INVALID"):
        validator.validate_phase5_client_observations_bytes(
            transform(validator.canonical(value)), binding, signed)
