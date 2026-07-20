#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any


RUNTIME_FIELDS = (
    "batch_per_gpu", "ddp_bucket_cap_mb", "compile_decoder", "log_every",
    "nccl_mode", "cpu_bind",
)


def confirm(
    preliminary: dict[str, Any], confirmation: dict[str, Any], *,
    minimum_improvement: float,
) -> dict[str, Any]:
    baseline = dict(preliminary["baseline"])
    proposed = dict(preliminary["selected"])
    mismatches = [
        field for field in RUNTIME_FIELDS
        if proposed.get(field) != confirmation.get(field)
    ]
    if mismatches:
        raise ValueError(
            "confirmation runtime does not match proposed selection: "
            + ", ".join(mismatches))

    baseline_rate = float(baseline["steady_pairs_per_second"])
    proposed_rate = float(proposed["steady_pairs_per_second"])
    confirmation_rate = float(
        confirmation.get("steady_pairs_per_second", float("nan")))
    proposed_is_baseline = all(
        proposed.get(field) == baseline.get(field) for field in RUNTIME_FIELDS)
    confirmation_healthy = (
        bool(confirmation.get("pass"))
        and math.isfinite(confirmation_rate)
        and confirmation_rate > 0.0
    )
    confirmed_rate = (
        statistics.median([proposed_rate, confirmation_rate])
        if confirmation_healthy else float("nan")
    )
    improvement = (
        confirmed_rate / baseline_rate - 1.0
        if math.isfinite(confirmed_rate) and baseline_rate > 0.0 else float("nan")
    )

    if proposed_is_baseline:
        chosen = baseline
        selection_kind = "infra_baseline"
        reason = "preliminary infra scan found no material improvement"
    elif confirmation_healthy and improvement + 1e-12 >= minimum_improvement:
        chosen = dict(confirmation)
        chosen["steady_pairs_per_second"] = confirmed_rate
        selection_kind = "confirmed_infra_candidate"
        reason = (
            f"infra candidate independently confirmed at {improvement:.3%} "
            "over the selected-batch runtime baseline"
        )
    else:
        chosen = baseline
        selection_kind = "infra_confirmation_fallback"
        reason = (
            "infra candidate failed independent health/throughput confirmation; "
            "using selected-batch runtime baseline"
        )
    return {
        "schema": 1,
        "selection_kind": selection_kind,
        "reason": reason,
        "minimum_improvement": minimum_improvement,
        "confirmed_improvement": improvement,
        "baseline": baseline,
        "preliminary_selected": proposed,
        "confirmation": confirmation,
        "selected": chosen,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preliminary", required=True)
    parser.add_argument("--confirmation", required=True)
    parser.add_argument("--minimum-improvement", type=float, default=0.01)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = confirm(
        json.loads(Path(args.preliminary).read_text(encoding="utf-8")),
        json.loads(Path(args.confirmation).read_text(encoding="utf-8")),
        minimum_improvement=args.minimum_improvement,
    )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
