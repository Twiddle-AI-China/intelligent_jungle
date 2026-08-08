from __future__ import annotations

import sys
import types

import numpy as np

from server.backends import trajectorybrave_pad


def test_cuda_live_warmup_uses_production_shape_once_and_clears_state(monkeypatch):
    instances = []

    class FakeBlock:
        def __init__(self, render_ms):
            self.render_ms = render_ms

    class FakeRenderer:
        def __init__(self, model, block_samples):
            self.model = model
            self.block_samples = block_samples
            self.started = None
            self.render_calls = []
            self.panicked = False
            instances.append(self)

        def start(self, coordinate, **kwargs):
            self.started = (np.asarray(coordinate).copy(), kwargs)

        def render_block(self, samples):
            self.render_calls.append(samples)
            return FakeBlock(806.58 if len(self.render_calls) == 1 else 5.71)

        def panic(self):
            self.panicked = True

    trajectory_package = types.ModuleType("trajectorybrave")
    trajectory_package.__path__ = []
    demo_package = types.ModuleType("trajectorybrave.demo")
    demo_package.__path__ = []
    live_module = types.ModuleType("trajectorybrave.demo.live")
    live_module.LiveRenderer = FakeRenderer
    monkeypatch.setitem(sys.modules, "trajectorybrave", trajectory_package)
    monkeypatch.setitem(sys.modules, "trajectorybrave.demo", demo_package)
    monkeypatch.setitem(sys.modules, "trajectorybrave.demo.live", live_module)

    backend = object.__new__(trajectorybrave_pad.TrajectoryBravePadBackend)
    backend.device = "cuda"
    backend.model = object()
    backend.default_control_coordinate = np.arange(8, dtype=np.float32)
    trajectorybrave_pad._WARMED_LIVE_GEOMETRIES.clear()

    timing = backend.warm_up_live(4096)
    assert timing == {
        "blockSamples": 4096,
        "firstRenderMs": 806.58,
        "secondRenderMs": 5.71,
    }
    assert backend.warm_up_live(4096) is None
    assert len(instances) == 1
    assert instances[0].block_samples == 4096
    assert instances[0].started[1] == {
        "note": 60,
        "velocity": 127,
        "mode": "natural",
    }
    assert instances[0].render_calls == [4096, 4096]
    assert instances[0].panicked is True
    trajectorybrave_pad._WARMED_LIVE_GEOMETRIES.clear()


def test_cpu_does_not_run_live_warmup():
    backend = object.__new__(trajectorybrave_pad.TrajectoryBravePadBackend)
    backend.device = "cpu"
    backend.model = object()
    assert backend.warm_up_live(4096) is None
