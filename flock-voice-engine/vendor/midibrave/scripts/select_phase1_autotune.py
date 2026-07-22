#!/usr/bin/env python3
from __future__ import annotations

import argparse
import glob
import json
import math
import statistics
from pathlib import Path
from typing import Any


def load_summaries(pattern: str) -> list[dict[str, Any]]:
    paths = sorted(glob.glob(pattern))
    if not paths:
        raise ValueError(f"no benchmark summaries match: {pattern}")
    return [json.loads(Path(path).read_text(encoding="utf-8")) for path in paths]


def select(summaries: list[dict[str, Any]], *, baseline_case: str,
           minimum_improvement: float) -> dict[str, Any]:
    by_id = {str(row["case_id"]): row for row in summaries}
    if baseline_case not in by_id:
        raise ValueError(f"missing baseline case: {baseline_case}")
    baseline = by_id[baseline_case]
    if not bool(baseline.get("pass")):
        raise ValueError(f"baseline benchmark failed: {baseline_case}")
    healthy = [
        row for row in summaries
        if bool(row.get("pass"))
        and math.isfinite(float(row.get("steady_pairs_per_second", float("nan"))))
    ]
    if not healthy:
        raise ValueError("no healthy autotune candidates")
    fastest = max(
        healthy,
        key=lambda row: (
            float(row["steady_pairs_per_second"]),
            float(row.get("end_to_end_pairs_per_second", 0.0)),
            -float(row.get("peak_reserved_gib", 99.0)),
        ),
    )
    baseline_rate = float(baseline["steady_pairs_per_second"])
    fastest_rate = float(fastest["steady_pairs_per_second"])
    improvement = fastest_rate / baseline_rate - 1.0
    if improvement + 1e-12 < minimum_improvement:
        chosen = baseline
        selection_kind = "baseline_fallback"
        reason = (
            f"fastest healthy candidate improved {improvement:.3%}, below "
            f"the required {minimum_improvement:.3%}"
        )
    else:
        chosen = fastest
        selection_kind = "performance_candidate"
        reason = (
            f"fastest healthy candidate improved {improvement:.3%} over {baseline_case}"
        )
    copied_fields = (
        "case_id", "config", "batch_per_gpu", "global_pairs",
        "ddp_bucket_cap_mb", "compile_decoder", "log_every",
        "nccl_mode", "cpu_bind", "steady_update_ms",
        "steady_pairs_per_second", "end_to_end_pairs_per_second",
        "peak_allocated_gib", "peak_reserved_gib", "gpu_utilization_median",
        "gpu_utilization_skew", "data_wait_p90_ms",
    )
    return {
        "schema": 1,
        "selection_kind": selection_kind,
        "reason": reason,
        "minimum_improvement": minimum_improvement,
        "measured_improvement": improvement,
        "baseline": {key: baseline.get(key) for key in copied_fields},
        "fastest": {key: fastest.get(key) for key in copied_fields},
        "selected": {key: chosen.get(key) for key in copied_fields},
        "healthy_cases": [row["case_id"] for row in healthy],
        "rejected_cases": [row["case_id"] for row in summaries if not row.get("pass")],
    }


def select_replicated(
    summaries: list[dict[str, Any]], *, group_field: str,
    baseline_group: str, minimum_replicates: int,
    minimum_improvement: float,
) -> dict[str, Any]:
    """Select only candidates whose independent replicates all pass.

    Throughput is aggregated with the median while memory and input-wait use the
    worst replicate.  A single failed repeat rejects the whole candidate; this
    keeps a warm-GPU failure from being hidden by a successful cold first run.
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in summaries:
        if group_field not in row:
            raise ValueError(f"summary missing replicate group field: {group_field}")
        groups.setdefault(str(row[group_field]), []).append(row)

    def aggregate(value: str, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
        rates = [float(row.get("steady_pairs_per_second", float("nan"))) for row in rows]
        if (len(rows) < minimum_replicates or not all(bool(row.get("pass")) for row in rows)
                or not all(math.isfinite(rate) and rate > 0.0 for rate in rates)):
            return None
        representative = max(rows, key=lambda row: float(row["steady_pairs_per_second"]))
        aggregated = dict(representative)
        aggregated["case_id"] = f"{group_field}-{value}-replicated"
        aggregated["steady_pairs_per_second"] = statistics.median(rates)
        aggregated["steady_update_ms"] = statistics.median(
            float(row["steady_update_ms"]) for row in rows)
        aggregated["end_to_end_pairs_per_second"] = statistics.median(
            float(row["end_to_end_pairs_per_second"]) for row in rows)
        aggregated["peak_allocated_gib"] = max(
            float(row["peak_allocated_gib"]) for row in rows)
        aggregated["peak_reserved_gib"] = max(
            float(row["peak_reserved_gib"]) for row in rows)
        aggregated["data_wait_p90_ms"] = max(
            float(row["data_wait_p90_ms"]) for row in rows)
        aggregated["replicate_case_ids"] = [str(row["case_id"]) for row in rows]
        aggregated["replicate_rates"] = rates
        return aggregated

    aggregated = {
        value: result for value, rows in groups.items()
        if (result := aggregate(value, rows)) is not None
    }
    if baseline_group not in groups:
        raise ValueError(f"missing baseline replicate group: {baseline_group}")
    if baseline_group not in aggregated:
        raise ValueError(f"baseline replicate group failed: {baseline_group}")
    if not aggregated:
        raise ValueError("no repeat-stable autotune candidates")

    baseline = aggregated[baseline_group]
    fastest = max(
        aggregated.values(),
        key=lambda row: (
            float(row["steady_pairs_per_second"]),
            float(row.get("end_to_end_pairs_per_second", 0.0)),
            -float(row.get("peak_reserved_gib", 99.0)),
        ),
    )
    baseline_rate = float(baseline["steady_pairs_per_second"])
    fastest_rate = float(fastest["steady_pairs_per_second"])
    improvement = fastest_rate / baseline_rate - 1.0
    if improvement + 1e-12 < minimum_improvement:
        chosen = baseline
        selection_kind = "replicated_baseline_fallback"
        reason = (
            f"fastest repeat-stable candidate improved {improvement:.3%}, below "
            f"the required {minimum_improvement:.3%}"
        )
    else:
        chosen = fastest
        selection_kind = "replicated_performance_candidate"
        reason = (
            f"fastest repeat-stable candidate improved {improvement:.3%} over "
            f"{group_field}={baseline_group}"
        )
    copied_fields = (
        "case_id", "config", "batch_per_gpu", "global_pairs",
        "ddp_bucket_cap_mb", "compile_decoder", "log_every",
        "nccl_mode", "cpu_bind", "steady_update_ms",
        "steady_pairs_per_second", "end_to_end_pairs_per_second",
        "peak_allocated_gib", "peak_reserved_gib", "gpu_utilization_median",
        "gpu_utilization_skew", "data_wait_p90_ms", "replicate_case_ids",
        "replicate_rates",
    )
    return {
        "schema": 2,
        "selection_kind": selection_kind,
        "reason": reason,
        "replicate_group_field": group_field,
        "minimum_replicates": minimum_replicates,
        "minimum_improvement": minimum_improvement,
        "measured_improvement": improvement,
        "baseline": {key: baseline.get(key) for key in copied_fields},
        "fastest": {key: fastest.get(key) for key in copied_fields},
        "selected": {key: chosen.get(key) for key in copied_fields},
        "healthy_groups": sorted(aggregated),
        "rejected_groups": sorted(set(groups) - set(aggregated)),
        "replicates": {
            value: [
                {
                    "case_id": row.get("case_id"),
                    "pass": bool(row.get("pass")),
                    "steady_pairs_per_second": row.get("steady_pairs_per_second"),
                    "failed_checks": sorted(
                        key for key, passed in row.get("checks", {}).items() if not passed),
                }
                for row in rows
            ]
            for value, rows in sorted(groups.items())
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--summaries", required=True, help="Glob for summary JSON files")
    parser.add_argument("--baseline-case")
    parser.add_argument("--replicate-field")
    parser.add_argument("--baseline-group")
    parser.add_argument("--minimum-replicates", type=int, default=2)
    parser.add_argument("--minimum-improvement", type=float, default=0.0)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    summaries = load_summaries(args.summaries)
    if args.replicate_field:
        if args.baseline_group is None:
            parser.error("--baseline-group is required with --replicate-field")
        result = select_replicated(
            summaries, group_field=args.replicate_field,
            baseline_group=args.baseline_group,
            minimum_replicates=args.minimum_replicates,
            minimum_improvement=args.minimum_improvement,
        )
    else:
        if args.baseline_case is None:
            parser.error("--baseline-case is required without --replicate-field")
        result = select(
            summaries, baseline_case=args.baseline_case,
            minimum_improvement=args.minimum_improvement,
        )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
