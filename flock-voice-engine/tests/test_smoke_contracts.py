from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from server.backends.brave_voices import ROW_VOICES
from server.config import DEFAULT_BLOCK_SAMPLES
from tools import smoke_client


ENGINE = Path(__file__).resolve().parents[1]
PAD_SMOKE = ENGINE / "tools/test_trajectorybrave_pad.py"
TRAJECTORY_BACKEND = ENGINE / "server/backends/trajectorybrave_pad.py"
BRAVE_VOICES_BACKEND = ENGINE / "server/backends/brave_voices.py"
PROTOCOL = ENGINE / "docs/protocol.md"
APP = ENGINE / "server/app.py"
PCA_RENDER = ENGINE / "tools/render_pca100.py"


def _render_split_calls(tree: ast.AST) -> list[ast.Call]:
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "render_split"
    ]


def test_pad_smoke_tracks_current_rows_and_block_contract() -> None:
    source = PAD_SMOKE.read_text(encoding="utf-8")
    tree = ast.parse(source)

    assert [row for row, name in enumerate(ROW_VOICES) if name == "pad"] == [1, 4]
    assert DEFAULT_BLOCK_SAMPLES == 4096
    assert "from server.config import DEFAULT_BLOCK_SAMPLES" in source
    assert "BLOCK_SAMPLES = DEFAULT_BLOCK_SAMPLES" in source
    assert "assert PAD_ROWS == [1, 4]" in source

    render_calls = _render_split_calls(tree)
    assert render_calls
    assert all(
        len(call.args) >= 2
        and isinstance(call.args[1], ast.Name)
        and call.args[1].id == "BLOCK_SAMPLES"
        for call in render_calls
    )
    backend_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "MultiVoiceBraveBackend"
    ]
    assert len(backend_calls) == 1
    block_keywords = [
        keyword.value
        for keyword in backend_calls[0].keywords
        if keyword.arg == "block_samples"
    ]
    assert len(block_keywords) == 1
    assert isinstance(block_keywords[0], ast.Name)
    assert block_keywords[0].id == "BLOCK_SAMPLES"
    assert "budget_ms = BLOCK_SAMPLES / 44100 * 1000" in source

    topology_text = (
        TRAJECTORY_BACKEND.read_text(encoding="utf-8")
        + BRAVE_VOICES_BACKEND.read_text(encoding="utf-8")
    )
    for stale_topology in ("1/4/5/6", "pad 仍占 4 行", "pad 的 4 行"):
        assert stale_topology not in topology_text
    assert topology_text.count("历史 2048 配置") >= 2
    assert "backend.warm_up_live(self.block_samples)" in topology_text


def test_smoke_client_uses_worklet_deadline_not_server_block_counter() -> None:
    expected_interval = 32 * 128 / 48_000
    assert smoke_client.BUFFER_REPORT_EVERY_QUANTA == 32
    assert smoke_client.WORKLET_RENDER_QUANTUM_FRAMES == 128
    assert smoke_client.WORKLET_SAMPLE_RATE == 48_000
    assert smoke_client.BUFFER_REPORT_INTERVAL_SECONDS == pytest.approx(expected_interval)

    deadline = 10.0
    assert smoke_client.advance_buffer_report_deadline(
        deadline, deadline - 0.001
    ) == pytest.approx(deadline)
    assert smoke_client.advance_buffer_report_deadline(
        deadline, deadline
    ) == pytest.approx(deadline + expected_interval)
    skipped = smoke_client.advance_buffer_report_deadline(
        deadline, deadline + expected_interval * 2.5
    )
    assert skipped == pytest.approx(deadline + expected_interval * 3)
    assert skipped > deadline + expected_interval * 2.5

    run_source = inspect.getsource(smoke_client.run)
    assert "time.monotonic()" in run_source
    assert "buffer_report_deadline" in run_source
    assert "REPORT_EVERY_BLOCKS" not in run_source
    assert "blocks %" not in run_source


def test_current_timing_comments_use_production_block_geometry() -> None:
    protocol = PROTOCOL.read_text(encoding="utf-8")
    app = APP.read_text(encoding="utf-8")

    cadence = "40 × 4096 / 44100 ≈ 3.72 s"
    assert cadence in protocol
    assert cadence in app
    assert "过期上限约一个生产块（约 **92.88 ms**）" in protocol
    assert "过期上限约 1 个块（约 92.88 ms）" in app
    assert "每约 1.9 s" not in protocol
    assert "过期上限约 1 个块(46 ms)" not in app


def test_render_pca_usage_is_isolated_from_active_production_tree() -> None:
    source = PCA_RENDER.read_text(encoding="utf-8")
    module_docstring = ast.get_docstring(ast.parse(source))

    assert module_docstring is not None
    assert "隔离 candidate checkout" in module_docstring
    assert "staging" in module_docstring
    assert "/srv/deploy/flock-voice-engine" not in module_docstring
    assert "ssh " not in module_docstring
