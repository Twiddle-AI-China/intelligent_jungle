from __future__ import annotations

from server.audio_worker.command_queue import CommandQueues
import threading
import time


def batch(epoch, seq, frame, commands):
    return {"audioEpoch": epoch, "commandSeq": seq, "targetFrame": str(frame), "commands": commands}


def note_on(**extra):
    return {"type": "note.on", "row": 0, "midi": 60, "velocity": 0.8, **extra}


def gate_on(**extra):
    return {"type": "gate.on", "row": 0, "midi": 60, "velocity": 0.8, **extra}


def replacement(epoch="epoch", sample_rate=44100):
    return {"type": "state.replace", "value": {
        "stateRevision": 1,
        "world": {"worldId": "w", "worldGeneration": "g", "revision": 1, "worldTimeSeconds": 0.0},
        "frameMap": {"audioEpoch": epoch, "worldTimeSeconds": 0.0, "renderFrame": "0", "sampleRate": sample_rate},
        "voices": {"assignments": {}, "activeNotes": [], "activeGates": [], "releases": []},
        "latent": {"modes": {}, "targets": {}}, "mix": {"species": {}, "masterGain": 1,
        "mute": {}, "solo": {}, "eq": {}, "reverb": {}}, "audioOwner": "world",
        "voiceMode": "production", "deterministicSeed": "seed", "configRevision": 1,
    }}


def test_same_frame_has_fixed_priority():
    queues = CommandQueues("epoch")
    queues.enqueue(batch("epoch", 6, 4096, [note_on()]))
    queues.enqueue(batch("epoch", 7, 4096, [{"type": "continuous.set", "worldId": "w", "voice": "bass", "param": "gain", "value": 0.5}]))
    queues.enqueue(batch("epoch", 8, 4096, [{"type": "note.off", "row": 0}]))
    queues.enqueue(batch("epoch", 9, 4096, [replacement()]))
    # state.replace 原子丢弃旧世界队列。
    assert [item.command["type"] for item in queues.drain_due(4096)] == ["state.replace"]


def test_priority_order_without_replacement():
    queues = CommandQueues("epoch")
    commands = [note_on(), {"type": "continuous.set", "worldId": "w", "voice": "bass", "param": "gain", "value": 0.5},
                {"type": "note.off", "row": 0}]
    assert queues.enqueue(batch("epoch", 1, 10, commands)).accepted
    assert [item.command["type"] for item in queues.drain_due(10)] == ["note.off", "continuous.set", "note.on"]


def test_mixed_batch_reservation_is_all_or_none():
    queues = CommandQueues("epoch", reliable_capacity=2)
    assert queues.enqueue(batch("epoch", 1, 0, [gate_on()])).accepted
    before = queues.snapshot()
    result = queues.enqueue(batch("epoch", 2, 0, [
        {"type": "continuous.set", "worldId": "w", "voice": "bass", "param": "gain", "value": 0.5},
        gate_on(), note_on(),
    ]))
    assert result.code == "RELIABLE_EDGE_OVERFLOW"
    assert queues.snapshot() == before
    assert queues.degraded and queues.rebuild_required


def test_reliable_overflow_never_drops_and_seq_failures_do_not_mutate():
    queues = CommandQueues("epoch", reliable_capacity=2)
    assert queues.enqueue(batch("epoch", 1, 0, [gate_on(), note_on()])).accepted
    before = queues.snapshot()
    assert queues.enqueue(batch("epoch", 2, 0, [gate_on()])).code == "RELIABLE_EDGE_OVERFLOW"
    assert queues.snapshot() == before
    assert queues.enqueue(batch("old", 3, 0, [note_on()])).code == "AUDIO_EPOCH_MISMATCH"
    assert queues.enqueue(batch("epoch", 1, 0, [note_on()])).code == "COMMAND_SEQ_INVALID"


def test_continuous_coalesces_by_world_voice_param_and_late_frames_count():
    queues = CommandQueues("epoch")
    for seq, value in [(1, 0.1), (2, 0.9)]:
        queues.enqueue(batch("epoch", seq, 5, [{"type": "continuous.set", "worldId": "w",
                                                "voice": "bass", "param": "gain", "value": value}]))
    due = queues.drain_due(9)
    assert len(due) == 1 and due[0].command["value"] == 0.9
    assert queues.late_frames == 4


def test_wire_u64_and_replacement_schema_fail_before_ack_without_mutation():
    queues = CommandQueues("epoch")
    before = queues.snapshot()
    invalid = {"audioEpoch": "epoch", "commandSeq": 1,
               "targetFrame": 18446744073709551616, "commands": [note_on()]}
    assert queues.enqueue(invalid).code == "TARGET_FRAME_INVALID"
    assert queues.enqueue(batch("epoch", 1, 0, [{"type": "state.replace"}])).code == "STATE_REPLACE_INVALID"
    assert queues.enqueue(batch("epoch", 1, 0, [{"type": "preview.start", "expiresAtFrame": "bad"}])).code == "COMMAND_SCHEMA_INVALID"
    assert queues.snapshot() == before


def test_replacement_uses_manifest_geometry_instead_of_hardcoded_sample_rate():
    queues = CommandQueues("epoch", expected_sample_rate=48000)
    assert queues.enqueue(batch("epoch", 1, 0, [replacement(sample_rate=48000)])).accepted
    wrong = CommandQueues("epoch", expected_sample_rate=48000)
    assert wrong.enqueue(batch("epoch", 1, 0, [replacement(sample_rate=44100)])).code == "STATE_REPLACE_INVALID"


def test_all_command_schema_errors_are_rejected_before_ack_and_commit():
    queues = CommandQueues("epoch")
    invalid_commands = [
        {"type": "note.on"},
        {"type": "note.on", "row": 0, "midi": float("nan"), "velocity": 0.8},
        {"type": "continuous.set", "row": 0, "param": "gain", "value": float("inf")},
        {"type": "note.on", "row": 999, "midi": 60, "velocity": 0.8},
        {"type": "note.on", "voice": "bogus", "midi": 60, "velocity": 0.8},
        {"type": "continuous.set", "row": 0, "param": "bogus", "value": 0.5},
        {**replacement(), "value": {**replacement()["value"], "voices": None}},
        {**replacement(), "value": {**replacement()["value"], "voices": {
            **replacement()["value"]["voices"], "activeNotes": [None]}}},
        {**replacement(), "value": {**replacement()["value"], "voices": {
            **replacement()["value"]["voices"],
            "activeNotes": [{"type": "note.off", "row": 0, "midi": 60, "velocity": 0.8}]}}},
        {"type": "continuous.set", "row": 0, "param": "gain", "value": []},
        {"type": "latent.set", "row": 0, "param": "timbre_xy", "value": 1},
        {"type": "latent.set", "row": 0, "param": "timbre_k", "value": [1]},
        {"type": "note.on", "row": 0, "midi": 60, "velocity": 0.8, "durationSeconds": 99},
        {**replacement(), "value": {**replacement()["value"],
                                     "latent": {"modes": {}, "targets": {"unknown": {"timbre": 0}}}}},
    ]
    for command in invalid_commands:
        before = queues.snapshot()
        assert not queues.enqueue(batch("epoch", 1, 0, [command])).accepted
        assert queues.snapshot() == before


def test_continuous_coalesce_keeps_distinct_rows():
    queues = CommandQueues("epoch")
    commands = [
        {"type": "continuous.set", "row": 0, "param": "gain", "value": 0.1},
        {"type": "continuous.set", "row": 1, "param": "gain", "value": 0.9},
    ]
    assert queues.enqueue(batch("epoch", 1, 0, commands)).accepted
    due = queues.drain_due(0)
    assert [(item.command["row"], item.command["value"]) for item in due] == [(0, 0.1), (1, 0.9)]


def test_jungle_metadata_and_species_mix_commands_are_pre_ack_safe():
    queues = CommandQueues("epoch")
    jungle = {"type": "note.on", "row": 3, "midi": 60, "velocity": .8,
              "pitchBranchId": 4, "stepIndex": 15, "masterBpm": 90,
              "jungleEditPlan": {"breakEdit": "repeat2", "toneEdit": "reverse",
                                  "evidence": {"onsetCount": 8, "conflictRatio": .1,
                                               "patternSimilarity": .9, "tension": .8}}}
    assert queues.enqueue(batch("epoch", 1, 0, [jungle])).accepted
    for seq, command in enumerate((
        {"type": "mix.set", "param": "mute", "species": "texture", "value": True},
        {"type": "mix.set", "param": "species", "species": "melody", "value": .5},
        {"type": "mix.set", "param": "masterGain", "value": .7},
    ), 2):
        assert queues.enqueue(batch("epoch", seq, 0, [command])).accepted
    assert not queues.enqueue(batch("epoch", 5, 0, [
        {"type": "mix.set", "param": "mute", "value": True}])).accepted
    assert not queues.enqueue(batch("epoch", 5, 0, [
        {"type": "mix.set", "param": "eq", "species": "bass", "value": .5}])).accepted
    assert not queues.enqueue(batch("epoch", 5, 0, [
        {"type": "mix.set", "param": "reverb", "species": "bass", "value": {"send": .5}}])).accepted


def test_concurrent_enqueue_and_drain_never_duplicate_or_lose_reliable_edges():
    queues = CommandQueues("epoch", reliable_capacity=256)
    done = threading.Event()
    applied = []

    def produce():
        for seq in range(1, 101):
            assert queues.enqueue(batch("epoch", seq, 0, [note_on()])).accepted
        done.set()

    def consume():
        while not done.is_set() or queues.depth:
            applied.extend(item.command_seq for item in queues.drain_due(0))
            time.sleep(0)

    producer = threading.Thread(target=produce)
    consumer = threading.Thread(target=consume)
    producer.start(); consumer.start()
    producer.join(); consumer.join()
    assert sorted(applied) == list(range(1, 101))
    assert len(applied) == len(set(applied))


def test_accept_callback_happens_before_command_becomes_render_visible():
    queues = CommandQueues("epoch")
    observed = []
    result = queues.enqueue(batch("epoch", 1, 0, [note_on()]),
                            on_accept=lambda accepted: observed.append((accepted.command_seq, queues.depth)))
    assert result.accepted
    assert observed == [(1, 0)]
    assert queues.depth == 1


def test_blocked_ack_does_not_hold_render_queue_lock():
    queues = CommandQueues("epoch")
    assert queues.enqueue(batch("epoch", 1, 0, [note_on()])).accepted
    entered = threading.Event()
    release = threading.Event()

    def blocked_ack(_accepted):
        entered.set()
        release.wait(2)

    result = []
    thread = threading.Thread(target=lambda: result.append(
        queues.enqueue(batch("epoch", 2, 0, [{"type": "note.off", "row": 0}]), on_accept=blocked_ack)))
    thread.start()
    assert entered.wait(1)
    assert [item.command_seq for item in queues.drain_due(0)] == [1]
    release.set(); thread.join(timeout=2)
    assert result[0].accepted
    assert [item.command_seq for item in queues.drain_due(0)] == [2]
