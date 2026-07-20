from __future__ import annotations

import json
import math
from pathlib import Path

import yaml

from scripts.compose_phase1_performance_selection import compose
from scripts.confirm_phase1_infra import confirm
from scripts.generate_phase1_autotune_config import generate_config
from scripts.select_phase1_autotune import select, select_replicated


ROOT = Path(__file__).parents[1]


def test_autotune_config_preserves_pair_exposure_and_warmup(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.jsonl"
    manifest.write_text("{}\n", encoding="utf-8")
    metadata = tmp_path / "metadata.json"
    metadata.write_text(json.dumps({
        "split_samples": {"train": 75362},
        "pitch_contract": {"window_samples": 49152, "window_valid_ratio_min": 0.75},
    }), encoding="utf-8")
    output = tmp_path / "candidate.yaml"
    result = generate_config(
        base=ROOT / "configs" / "full_c9_optimized.yaml",
        manifest=manifest, metadata=metadata, output=output,
        run_name="test", output_dir=str(tmp_path / "runs"),
        batch_per_gpu=12, ddp_bucket_cap_mb=32,
        compile_decoder=True, log_every=100,
    )
    raw = yaml.safe_load(output.read_text(encoding="utf-8"))
    expected_steps = math.ceil(75362 * 16 * 16 / 96)
    assert result["global_pairs"] == 96
    assert result["phase1_steps"] == expected_steps
    assert raw["train"]["phase1_steps"] == expected_steps
    assert raw["train"]["warmup_steps"] == round(10000 * 80 / 96)
    assert raw["train"]["lr"] == 0.0002
    assert raw["train"]["self_full_fraction"] == 0.1
    assert raw["train"]["self_probability"] == 0.5
    assert raw["train"]["ddp_bucket_cap_mb"] == 32
    assert raw["train"]["compile_decoder"] is True


def _summary(case: str, rate: float, *, passed: bool = True,
             batch: int = 10) -> dict:
    return {
        "case_id": case,
        "pass": passed,
        "config": f"/{case}.yaml",
        "batch_per_gpu": batch,
        "global_pairs": batch * 8,
        "ddp_bucket_cap_mb": 16,
        "compile_decoder": False,
        "log_every": 100,
        "nccl_mode": "nvl",
        "cpu_bind": "cores",
        "steady_update_ms": 200.0,
        "steady_pairs_per_second": rate,
        "end_to_end_pairs_per_second": rate - 5.0,
        "peak_allocated_gib": 11.0,
        "peak_reserved_gib": 12.0,
        "gpu_utilization_median": 92.0,
        "gpu_utilization_skew": 5.0,
        "data_wait_p90_ms": 1.0,
    }


def test_selector_requires_three_percent_or_falls_back() -> None:
    baseline = _summary("batch-b10", 400.0)
    too_small = _summary("candidate-small", 411.0, batch=11)
    result = select([baseline, too_small], baseline_case="batch-b10",
                    minimum_improvement=0.03)
    assert result["selection_kind"] == "baseline_fallback"
    assert result["selected"]["case_id"] == "batch-b10"

    fast = _summary("candidate-fast", 420.0, batch=12)
    result = select([baseline, fast], baseline_case="batch-b10",
                    minimum_improvement=0.03)
    assert result["selection_kind"] == "performance_candidate"
    assert result["selected"]["case_id"] == "candidate-fast"


def test_replicated_selector_rejects_fast_candidate_with_one_failed_repeat() -> None:
    rows = [
        _summary("b10-r1", 400.0, batch=10),
        _summary("b10-r2", 402.0, batch=10),
        _summary("b12-r1", 420.0, batch=12),
        _summary("b12-r2", 422.0, batch=12),
        _summary("b13-r1", 430.0, batch=13),
        _summary("b13-r2", 431.0, batch=13, passed=False),
    ]
    rows[-1]["checks"] = {"no_hazardous_throttle": False}
    result = select_replicated(
        rows, group_field="batch_per_gpu", baseline_group="10",
        minimum_replicates=2, minimum_improvement=0.03,
    )
    assert result["selection_kind"] == "replicated_performance_candidate"
    assert result["selected"]["batch_per_gpu"] == 12
    assert result["selected"]["steady_pairs_per_second"] == 421.0
    assert result["healthy_groups"] == ["10", "12"]
    assert result["rejected_groups"] == ["13"]
    assert result["replicates"]["13"][1]["failed_checks"] == [
        "no_hazardous_throttle"
    ]


def test_infra_confirmation_and_composition_preserve_exact_b10_fallback() -> None:
    b10 = _summary("batch_per_gpu-10-replicated", 401.0, batch=10)
    b12 = _summary("batch_per_gpu-12-replicated", 421.0, batch=12)
    batch_selection = {
        "selection_kind": "replicated_performance_candidate",
        "baseline": b10,
        "selected": b12,
    }
    infra_baseline = dict(b12)
    infra_baseline["case_id"] = "infra-baseline"
    proposal = dict(b12)
    proposal.update({
        "case_id": "infra-fast", "steady_pairs_per_second": 430.0,
        "nccl_mode": "default", "cpu_bind": "none",
    })
    preliminary = {
        "selection_kind": "performance_candidate",
        "baseline": infra_baseline,
        "selected": proposal,
    }
    failed_confirmation = dict(proposal)
    failed_confirmation.update({
        "case_id": "infra-confirm-selected", "pass": False,
        "steady_pairs_per_second": 431.0,
    })
    infra = confirm(preliminary, failed_confirmation, minimum_improvement=0.01)
    assert infra["selection_kind"] == "infra_confirmation_fallback"
    assert infra["selected"]["case_id"] == "infra-baseline"

    performance = compose(
        batch_selection, infra, minimum_improvement=0.03)
    assert performance["selection_kind"] == "performance_candidate"
    assert performance["baseline"]["case_id"] == "batch_per_gpu-10-replicated"
    assert performance["selected"]["batch_per_gpu"] == 12

    slow_infra = dict(infra)
    slow_infra["selected"] = dict(b10, steady_pairs_per_second=409.0)
    fallback = compose(batch_selection, slow_infra, minimum_improvement=0.03)
    assert fallback["selection_kind"] == "baseline_fallback"
    assert fallback["selected"]["case_id"] == "batch_per_gpu-10-replicated"
