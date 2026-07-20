#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def compose(
    batch_selection: dict[str, Any], infra_selection: dict[str, Any], *,
    minimum_improvement: float,
) -> dict[str, Any]:
    # The quality fallback must be exactly the b10 runtime used by q50_baseline.
    baseline = dict(batch_selection["baseline"])
    candidate = dict(infra_selection["selected"])
    baseline_rate = float(baseline["steady_pairs_per_second"])
    candidate_rate = float(candidate["steady_pairs_per_second"])
    improvement = candidate_rate / baseline_rate - 1.0
    if improvement + 1e-12 >= minimum_improvement:
        chosen = candidate
        selection_kind = "performance_candidate"
        reason = (
            f"repeat-stable batch plus confirmed infra improved {improvement:.3%} "
            "over the exact b10 q50 quality baseline"
        )
    else:
        chosen = baseline
        selection_kind = "baseline_fallback"
        reason = (
            f"end-to-end candidate improved {improvement:.3%}, below the required "
            f"{minimum_improvement:.3%}; using exact b10 q50 quality baseline"
        )
    return {
        "schema": 2,
        "selection_kind": selection_kind,
        "reason": reason,
        "minimum_improvement": minimum_improvement,
        "measured_improvement": improvement,
        "baseline": baseline,
        "fastest": candidate,
        "selected": chosen,
        "batch_selection_kind": batch_selection.get("selection_kind"),
        "infra_selection_kind": infra_selection.get("selection_kind"),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-selection", required=True)
    parser.add_argument("--infra-selection", required=True)
    parser.add_argument("--minimum-improvement", type=float, default=0.03)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = compose(
        json.loads(Path(args.batch_selection).read_text(encoding="utf-8")),
        json.loads(Path(args.infra_selection).read_text(encoding="utf-8")),
        minimum_improvement=args.minimum_improvement,
    )
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
