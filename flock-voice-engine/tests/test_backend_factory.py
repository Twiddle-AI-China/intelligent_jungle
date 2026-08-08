from server import app
from server.backend_factory import make_backend
from server.config import EngineConfig


def test_legacy_app_reexports_permanent_backend_factory():
    assert app.make_backend is make_backend
    for backend in ("silent", "synth"):
        config = EngineConfig(backend=backend)
        direct = make_backend(config).info()
        legacy = app.make_backend(config).info()
        assert direct["id"] == legacy["id"]
        assert direct["sampleRate"] == legacy["sampleRate"]


def test_unknown_backend_preserves_legacy_synth_fallback():
    assert make_backend(EngineConfig(backend="definitely-missing")).backend_id == "synth-s"


def test_xy_control_keeps_current_per_checkpoint_map_reachable():
    assert app._resolve_xy([13.665, -8.2]) == (13.665, -8.2)
    assert app._resolve_xy([100, -100]) == (16.0, -16.0)
    assert app._resolve_xy(None) is None
