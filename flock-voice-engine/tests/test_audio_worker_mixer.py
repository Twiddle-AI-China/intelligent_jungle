from __future__ import annotations

import numpy as np

from server.audio_worker.mixer import ServerMixer


def state(**updates):
    value = {"species": {}, "masterGain": .5, "mute": {}, "solo": {}, "eq": {}, "reverb": {}}
    value.update(updates)
    return value


def test_master_is_stereo_limited_and_split_is_exact_premix():
    stems = np.vstack([np.linspace(-2, 2, 4096, dtype=np.float32) for _ in range(5)])
    mixer = ServerMixer(44100, 4096, ["bass", "pad", "lead", "pluck", "texture"])
    master, split = mixer.process(stems, state(species={"pad": .8}, reverb={"pad": .2}))
    assert master.shape == (4096, 2) and master.dtype == np.float32
    assert split.shape == (4096, 5) and np.array_equal(split, stems.T)
    assert np.max(np.abs(master)) <= 1.0 and np.isfinite(master).all()
    assert not np.array_equal(master[:, 0], split[:, 0])


def test_alternate_geometry_mute_solo_and_silence():
    mixer = ServerMixer(48000, 2048, ["bass", "lead", "texture"])
    zeros = np.zeros((3, 2048), dtype=np.float32)
    master, split = mixer.process(zeros, state())
    assert master.shape == (2048, 2) and split.shape == (2048, 3)
    assert np.max(np.abs(master)) <= 1e-7
    stems = np.ones((3, 2048), dtype=np.float32) * .1
    solo, _ = mixer.process(stems, state(solo={"melody": True}))
    muted, _ = mixer.process(stems, state(mute={"bass": True, "melody": True, "texture": True}))
    assert np.max(np.abs(solo)) > 0 and np.max(np.abs(muted)) <= 1e-7


def test_authoritative_assignments_and_all_three_eq_bands_are_consumed():
    stems = np.zeros((3, 2048), dtype=np.float32)
    stems[1] = np.sin(np.arange(2048) * .4).astype(np.float32) * .1
    base = {"mix": state(), "assignments": {"melody": 1}}
    muted = {"mix": state(mute={"melody": True}), "assignments": {"melody": 1}}
    assert np.max(np.abs(ServerMixer(44100, 2048, ["bass", "lead", "texture"]).process(stems, muted)[0])) <= 1e-7
    outputs = []
    for band in ("low", "mid", "high"):
        configured = {"mix": state(eq={"melody": {band: 6}}), "assignments": {"melody": 1}}
        outputs.append(ServerMixer(44100, 2048, ["bass", "lead", "texture"]).process(stems, configured)[0])
    assert not np.array_equal(outputs[0], outputs[1])
    assert not np.array_equal(outputs[1], outputs[2])


def test_reverb_is_normalized_and_does_not_pin_limiter():
    mixer = ServerMixer(44100, 4096, ["pad"])
    stems = np.ones((1, 4096), dtype=np.float32) * .1
    output = None
    for _ in range(5):
        output, _ = mixer.process(stems, state(masterGain=.5, reverb={"pad": .68}))
    assert output is not None
    assert np.mean(np.abs(output)) < .5
    assert np.mean(np.abs(output) > .99) == 0
