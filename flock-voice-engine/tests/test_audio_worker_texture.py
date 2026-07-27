from __future__ import annotations

from pathlib import Path
import numpy as np
import pytest

from server.audio_worker.texture import TextureRenderer
from server.audio_worker.jungle import jungle_slice_for_cell

ROOT = Path(__file__).parents[2]
AMEN = ROOT / "mvp/assets/audio/amen/cw_amen_jungle.wav"
FOREST = ROOT / "mvp/assets/audio/ambience/forest-soundreality-537925.mp3"


def test_controlled_samples_decode_and_render_deterministically():
    first = TextureRenderer(AMEN, FOREST, 44100, "seed")
    second = TextureRenderer(AMEN, FOREST, 44100, "seed")
    event = {"pitchBranchId": 2, "stepIndex": 4, "tension": .7, "masterBpm": 60}
    left = first.render(event, 4096)
    right = second.render(event, 4096)
    assert left.shape == (4096,) and left.dtype == np.float32
    assert np.max(np.abs(left - right)) <= 1e-6
    assert np.max(np.abs(left)) > 0
    assert first.ambience(1024).shape == (1024,)
    silent = first.render({**event, "velocity": 0}, 4096)
    assert np.max(np.abs(silent)) <= 1e-7


def test_decode_failure_is_worker_not_ready(tmp_path):
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"not audio")
    with pytest.raises(Exception):
        TextureRenderer(bad, FOREST, 44100)


def test_frozen_tempo_multiplier_controls_exact_output_duration():
    assert jungle_slice_for_cell(masterBpm=60, tempoMultiplier=1)["outputSeconds"] == 1
    assert jungle_slice_for_cell(masterBpm=60, tempoMultiplier=4)["outputSeconds"] == .25
