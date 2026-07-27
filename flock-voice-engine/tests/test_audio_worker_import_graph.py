from pathlib import Path

from tools.python_import_graph import python_import_graph


def test_worker_import_graph_never_depends_on_legacy_app():
    root = Path(__file__).resolve().parents[2]
    entry = root / "flock-voice-engine/server/audio_worker/__main__.py"
    graph = python_import_graph(entry, root / "flock-voice-engine")
    assert "server/app.py" not in graph
    assert "server/backend_factory.py" in graph


def test_worker_graph_has_no_dynamic_production_import_call():
    root = Path(__file__).resolve().parents[1]
    for relative in python_import_graph(root / "server/audio_worker/__main__.py", root):
        if relative.startswith("server/audio_worker/"):
            source = (root / relative).read_text("utf-8")
            assert "import_module(" not in source
