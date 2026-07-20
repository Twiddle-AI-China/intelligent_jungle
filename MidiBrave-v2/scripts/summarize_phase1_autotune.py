#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from pathlib import Path
from typing import Any

import yaml


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return float("nan")
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * fraction))]


def _finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def read_metrics(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def read_monitor(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _float(row: dict[str, Any], key: str, default: float = float("nan")) -> float:
    try:
        value = float(row[key])
    except (KeyError, TypeError, ValueError):
        return default
    return value


def summarize(*, case_id: str, config_path: Path, metrics_path: Path,
              monitor_path: Path, exit_code: int, expected_updates: int,
              warmup_updates: int, wall_seconds: float,
              nccl_mode: str = "nvl", cpu_bind: str = "cores") -> dict[str, Any]:
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    train = raw["train"]
    global_pairs = 8 * int(train["batch_per_gpu"]) * int(train["grad_accum"])
    rows = read_metrics(metrics_path)
    applied = [row for row in rows if int(row.get("generator_step_applied", 0)) == 1]
    measured = [row for row in applied if int(row.get("generator_updates", 0)) >= warmup_updates]
    final = max(rows, key=lambda row: int(row.get("loop_step", -1))) if rows else {}
    final_updates = int(final.get("generator_updates", -1))
    final_loop = int(final.get("loop_step", -1))

    steady_pairs_per_second = float("nan")
    steady_update_ms = float("nan")
    if len(measured) >= 2:
        first, last = measured[0], measured[-1]
        update_delta = int(last["generator_updates"]) - int(first["generator_updates"])
        seconds_delta = _float(last, "seconds") - _float(first, "seconds")
        if update_delta > 0 and seconds_delta > 0:
            steady_pairs_per_second = update_delta * global_pairs / seconds_delta
            steady_update_ms = seconds_delta * 1000.0 / update_delta
    end_to_end_pairs_per_second = (
        final_updates * global_pairs / wall_seconds
        if final_updates > 0 and wall_seconds > 0 else float("nan")
    )
    data_wait = [_float(row, "data_wait_ms") for row in measured]
    data_wait = [value for value in data_wait if math.isfinite(value)]
    peak_allocated = max(
        (_float(row, "peak_cuda_gib", 0.0) for row in rows), default=0.0)
    peak_reserved = max(
        (_float(row, "peak_cuda_reserved_gib", 0.0) for row in rows), default=0.0)

    monitor_rows = read_monitor(monitor_path)
    active_monitor = [
        row for row in monitor_rows if _float(row, "memory_used_mib", 0.0) >= 1000.0
    ]
    by_gpu: dict[str, list[dict[str, str]]] = {}
    for row in active_monitor:
        by_gpu.setdefault(row.get("index", "unknown").strip(), []).append(row)
    gpu_medians: dict[str, float] = {}
    gpu_memory_peaks: dict[str, float] = {}
    for index, gpu_rows in by_gpu.items():
        utils = [_float(row, "gpu_util") for row in gpu_rows]
        utils = [value for value in utils if math.isfinite(value)]
        memory = [_float(row, "memory_used_mib") for row in gpu_rows]
        memory = [value for value in memory if math.isfinite(value)]
        if utils:
            gpu_medians[index] = statistics.median(utils)
        if memory:
            gpu_memory_peaks[index] = max(memory)
    gpu_util_median = (
        statistics.median(gpu_medians.values()) if gpu_medians else float("nan")
    )
    gpu_util_skew = (
        max(gpu_medians.values()) - min(gpu_medians.values())
        if gpu_medians else float("nan")
    )
    max_monitor_memory_mib = max(gpu_memory_peaks.values(), default=0.0)
    max_temperature = max(
        (_float(row, "temperature_c", 0.0) for row in active_monitor), default=0.0)
    max_ecc = max(
        (_float(row, "ecc_uncorrected", 0.0) for row in active_monitor), default=0.0)
    throttle_values = []
    for row in active_monitor:
        text = row.get("throttle_reasons", "0").strip()
        try:
            throttle_values.append(int(text, 0))
        except ValueError:
            pass
    # GPU Idle (0x1), application clocks (0x2), software power cap (0x4), and
    # sync boost (0x10) are normal operating states.  Reject hardware slowdown,
    # software/hardware thermal slowdown, and external power-brake reasons.
    max_throttle = max(throttle_values, default=0)
    hazardous_throttle_mask = 0x8 | 0x20 | 0x40 | 0x80
    max_hazardous_throttle = max(
        (value & hazardous_throttle_mask for value in throttle_values), default=0)

    numeric_metrics_finite = all(
        math.isfinite(float(value))
        for row in applied for value in row.values()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    )
    skip_rate = (
        (final_loop - final_updates) / max(1, final_loop)
        if final_loop >= 0 and final_updates >= 0 else float("inf")
    )
    checks = {
        "process_exit_zero": exit_code == 0,
        "expected_updates_reached": final_updates >= expected_updates,
        "amp_skip_rate": 0.0 <= skip_rate <= 0.01,
        "metrics_finite": numeric_metrics_finite and bool(applied),
        "parameter_delta_positive": bool(applied) and all(
            _float(row, "generator_parameter_delta", 0.0) > 0.0 for row in applied),
        "peak_reserved_safe": 0.0 < peak_reserved <= 15.0,
        # Leave at least 1 GiB outside the training process on a 16 GiB V100.
        # PyTorch reserved memory alone misses CUDA/NCCL/driver allocations.
        "gpu_memory_headroom_safe": 0.0 < max_monitor_memory_mib <= 15_360.0,
        "data_wait_p90": bool(data_wait) and percentile(data_wait, 0.90) <= 5.0,
        "eight_gpus_monitored": len(gpu_medians) == 8,
        "gpu_utilization": math.isfinite(gpu_util_median) and gpu_util_median >= 90.0,
        "gpu_balance": math.isfinite(gpu_util_skew) and gpu_util_skew <= 10.0,
        "temperature_safe": max_temperature < 85.0,
        "ecc_clean": max_ecc == 0.0,
        "no_hazardous_throttle": max_hazardous_throttle == 0,
        "throughput_valid": math.isfinite(steady_pairs_per_second)
                            and steady_pairs_per_second > 0.0,
    }
    return {
        "schema": 1,
        "case_id": case_id,
        "config": str(config_path.resolve()),
        "exit_code": exit_code,
        "pass": all(checks.values()),
        "checks": checks,
        "expected_updates": expected_updates,
        "final_updates": final_updates,
        "final_loop": final_loop,
        "amp_skip_rate": skip_rate,
        "batch_per_gpu": int(train["batch_per_gpu"]),
        "global_pairs": global_pairs,
        "ddp_bucket_cap_mb": int(train["ddp_bucket_cap_mb"]),
        "compile_decoder": bool(train["compile_decoder"]),
        "log_every": int(train["log_every"]),
        "nccl_mode": nccl_mode,
        "cpu_bind": cpu_bind,
        "wall_seconds": wall_seconds,
        "steady_update_ms": steady_update_ms,
        "steady_pairs_per_second": steady_pairs_per_second,
        "end_to_end_pairs_per_second": end_to_end_pairs_per_second,
        "data_wait_p90_ms": percentile(data_wait, 0.90),
        "peak_allocated_gib": peak_allocated,
        "peak_reserved_gib": peak_reserved,
        "gpu_utilization_median": gpu_util_median,
        "gpu_utilization_skew": gpu_util_skew,
        "gpu_utilization_by_index": gpu_medians,
        "gpu_memory_peak_mib_by_index": gpu_memory_peaks,
        "max_monitor_memory_mib": max_monitor_memory_mib,
        "max_temperature_c": max_temperature,
        "max_ecc_uncorrected": max_ecc,
        "max_active_throttle_mask": max_throttle,
        "max_hazardous_throttle_mask": max_hazardous_throttle,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case-id", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--metrics", required=True)
    parser.add_argument("--monitor", required=True)
    parser.add_argument("--exit-code", type=int, required=True)
    parser.add_argument("--expected-updates", type=int, required=True)
    parser.add_argument("--warmup-updates", type=int, default=40)
    parser.add_argument("--wall-seconds", type=float, required=True)
    parser.add_argument("--nccl-mode", choices=("nvl", "default"), default="nvl")
    parser.add_argument("--cpu-bind", choices=("cores", "none"), default="cores")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = summarize(
        case_id=args.case_id, config_path=Path(args.config),
        metrics_path=Path(args.metrics), monitor_path=Path(args.monitor),
        exit_code=args.exit_code, expected_updates=args.expected_updates,
        warmup_updates=args.warmup_updates, wall_seconds=args.wall_seconds,
        nccl_mode=args.nccl_mode, cpu_bind=args.cpu_bind,
    )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
