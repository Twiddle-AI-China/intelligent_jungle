import numpy as np

from server.audio_worker.mixer import ServerMixer


def test_split_excludes_master_ambience_eq_and_reverb():
    ambience = np.linspace(-.2, .2, 10000, dtype=np.float32)
    mixer = ServerMixer(44100, 256, ["bass", "texture"], ambience=ambience)
    stems = np.vstack([np.ones(256, dtype=np.float32), np.zeros(256, dtype=np.float32)])
    master, split = mixer.process(stems, {"masterGain": .2, "species": {}, "mute": {}, "solo": {},
                                          "eq": {"bass": {"low": .5}}, "reverb": {"bass": .4}})
    assert np.array_equal(split, stems.T)
    assert master.shape == (256, 2)
    assert not np.array_equal(master[:, 0], split[:, 0])
