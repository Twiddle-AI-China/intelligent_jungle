from __future__ import annotations

import numpy as np
import copy

from server.audio_worker.command_queue import CommandQueues
from server.audio_worker.pcm_ring import WorkerPcmRings
from server.audio_worker.render_loop import RenderLoop
from server.audio_worker.render_state import RenderState
from server.audio_worker.telemetry_queue import TelemetryQueue
from server.config import EngineConfig
from server.voices import VoicePool
from test_audio_worker_queue import replacement


class FakeBackend:
    backend_id = "fake"

    def __init__(self):
        self.events = []

    def reset(self):
        self.events.append(("reset",))

    def note_on(self, voice):
        self.events.append(("on", voice.row, voice.duration_seconds))

    def note_off(self, voice):
        self.events.append(("off", voice.row))

    def render_split(self, voices, frames):
        return np.zeros((len(voices), frames), dtype=np.float32)


class FakeHost:
    def __init__(self):
        self.config = EngineConfig(sample_rate=44100, block_samples=64, pool_size=2)
        self.geometry = {"sampleRate": 44100, "blockFrames": 64, "poolSize": 2,
                         "rowVoices": ["bass", "pad"]}
        self.voice_pool = VoicePool(2, 44100)
        self.backend = FakeBackend()

    def load_once(self):
        return self.backend


def test_blocked_writer_never_blocks_render_and_overflow_latches():
    queues = CommandQueues("epoch")
    rings = WorkerPcmRings(capacity_blocks=8)
    loop = RenderLoop(FakeHost(), RenderState(queues), rings, TelemetryQueue(), "epoch")
    for _ in range(20):
        loop.render_one_block()
    assert loop.rendered_blocks == 20
    assert loop.status.degraded is True
    assert loop.status.degraded_reason == "WORKER_PCM_RING_OVERFLOW"


def test_render_applies_due_commands_before_backend_and_publishes_stereo():
    queues = CommandQueues("epoch")
    applied = []
    queues.enqueue({"audioEpoch": "epoch", "commandSeq": 1, "targetFrame": "0",
                    "commands": [{"type": "note.on", "row": 0, "midi": 60, "velocity": 0.8}]})
    rings = WorkerPcmRings()
    loop = RenderLoop(FakeHost(), RenderState(queues, applied.append), rings, TelemetryQueue(), "epoch")
    assert loop.render_one_block()
    assert applied == [{"type": "note.on", "row": 0, "midi": 60, "velocity": 0.8}]
    master, split = rings.pop_pair()
    assert len(master.payload) == 64 * 2 * 4
    assert len(split.payload) == 64 * 2 * 4


def test_state_replace_emits_applied_only_at_render_boundary():
    queues = CommandQueues("epoch")
    assert queues.enqueue({"audioEpoch": "epoch", "commandSeq": 1, "targetFrame": "64",
                           "commands": [replacement()]}).accepted
    state = RenderState(queues, lambda _command: None)
    assert state.apply_due(0) == [] and state.take_applied() is None
    state.apply_due(64)
    assert state.take_applied() == {"type": "audio.state.applied", "audioEpoch": "epoch",
                                    "stateRevision": 1, "appliedCommandSeq": 1,
                                    "renderFrame": "64"}


def test_applied_barriers_can_be_drained_through_pcm_frame_without_losing_newer_event():
    queues = CommandQueues("epoch")
    state = RenderState(queues, lambda _command: None)
    assert queues.enqueue({"audioEpoch": "epoch", "commandSeq": 1, "targetFrame": "64",
                           "commands": [replacement()]}).accepted
    state.apply_due(64)
    newer = replacement()
    newer["value"]["stateRevision"] = 2
    assert queues.enqueue({"audioEpoch": "epoch", "commandSeq": 2, "targetFrame": "128",
                           "commands": [newer]}).accepted
    state.apply_due(128)
    assert [item["appliedCommandSeq"] for item in state.take_applied_through(64)] == [1]
    assert [item["appliedCommandSeq"] for item in state.take_applied_through(128)] == [2]


def test_model_host_replacement_applies_complete_snapshot_and_duration():
    from server.audio_worker.model_host import ModelHost

    host = FakeHost()
    model = ModelHost(host.config, host.geometry, allow_test_backend=True)
    model.backend = host.backend
    model.voice_pool = host.voice_pool
    value = copy.deepcopy(replacement()["value"])
    value["voices"] = {
        "assignments": {"bass": 0, "pad": 1},
        "activeNotes": [{"row": 0, "midi": 61, "velocity": 0.7, "durationSeconds": 2.5}],
        "activeGates": [{"row": 1, "midi": 64, "velocity": 0.6}],
        "releases": [{"row": 0}],
    }
    value["latent"] = {"modes": {"bass": "AGENT"},
                       "targets": {"bass": {"timbre_xy": [0.25, -0.5], "timbre_k": 4}}}
    value["mix"]["masterGain"] = 0.75
    model.apply_command({"type": "state.replace", "value": value})

    assert model.authoritative_state == value
    assert model.assignments == value["voices"]["assignments"]
    assert model.latent_state == value["latent"]
    assert model.mix_state == value["mix"]
    assert model.voice_pool[0].duration_seconds == 2.5
    assert model.voice_pool[0].gate is False
    assert model.voice_pool[0].timbre_xy == (0.25, -0.5)
    assert model.voice_pool[0].timbre_k == 4
    assert model.voice_pool[1].duration_seconds == 30.0
    assert model.voice_pool[1].gate is True


def test_model_host_replacement_clears_old_world_voice_parameters():
    from server.audio_worker.model_host import ModelHost

    host = FakeHost()
    model = ModelHost(host.config, host.geometry, allow_test_backend=True)
    model.backend = host.backend
    model.voice_pool = host.voice_pool
    model.apply_command({"type": "continuous.set", "row": 0, "param": "gain", "value": 0.1})
    model.apply_command({"type": "latent.set", "row": 0, "param": "timbre_xy", "value": [0.2, 0.3]})
    model.apply_command(replacement())
    assert model.voice_pool[0].gain == 0.8
    assert model.voice_pool[0].timbre_xy is None
