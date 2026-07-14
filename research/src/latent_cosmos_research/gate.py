from __future__ import annotations

import argparse
import json
from pathlib import Path


def evaluate(report: dict) -> dict:
    target = report.get("target", {})
    checks = {
        "real_model": bool(report.get("gate_eligible")),
        "target_mac": target.get("system") == "Darwin" and target.get("machine") == "arm64",
        "target_processor": str(target.get("processor", "")).startswith("Apple M4"),
        "target_memory": 15_000_000_000 <= target.get("memory_bytes", 0) <= 18_000_000_000,
        "six_voices": report.get("voices", 0) >= 6,
        "control_latency": report.get("estimated_control_latency_ms", float("inf")) <= 30,
        "jitter": report.get("latency_ms", {}).get("jitter_stdev", float("inf")) <= 5,
        "realtime_factor": report.get("rtf", float("inf")) < 1,
        "thirty_minute_stress": report.get("continuous_minutes", 0) >= 30,
        "zero_deadline_misses": report.get("deadline_misses", -1) == 0,
    }
    return {"passed": all(checks.values()), "checks": checks}


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply the Phase 1 hard gate to measured decoder reports.")
    parser.add_argument("reports", type=Path, nargs="+")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = {str(path): evaluate(json.loads(path.read_text(encoding="utf-8"))) for path in args.reports}
    encoded = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded)
    if not all(value["passed"] for value in result.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
