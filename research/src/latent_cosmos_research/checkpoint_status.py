from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Create an auditable checkpoint/TensorBoard status snapshot.")
    parser.add_argument("run", type=Path, help="RAVE/BRAVE version directory containing checkpoints and events")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    try:
        import torch
        from tensorboard.backend.event_processing.event_accumulator import EventAccumulator
    except ImportError as error:
        raise SystemExit("checkpoint inspection requires `uv sync --extra rave --extra analysis`") from error

    run = args.run.resolve()
    checkpoints = []
    for path in sorted((run / "checkpoints").glob("*.ckpt")):
        payload = torch.load(path, map_location="cpu", weights_only=False)
        checkpoints.append({
            "name": path.name,
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
            "epoch": payload.get("epoch"),
            "global_step": payload.get("global_step"),
        })

    event_paths = sorted(run.glob("events.out.tfevents.*"))
    scalars: dict[str, dict] = {}
    if event_paths:
        # Read the version directory so resumed runs are aggregated instead of
        # silently reporting only the newest event file.
        accumulator = EventAccumulator(str(run), size_guidance={"scalars": 0})
        accumulator.Reload()
        for tag in accumulator.Tags().get("scalars", []):
            values = accumulator.Scalars(tag)
            if not values:
                continue
            latest = values[-1]
            item = {"count": len(values), "latest_step": latest.step, "latest_value": latest.value}
            if tag == "validation":
                minimum = min(values, key=lambda value: value.value)
                item["minimum_step"] = minimum.step
                item["minimum_value"] = minimum.value
            scalars[tag] = item

    report = {
        "schema": 1,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "run": str(run),
        "checkpoints": checkpoints,
        "scalars": scalars,
        "claims": {
            "checkpoint_exists": bool(checkpoints),
            "export_measured": False,
            "listening_gate_passed": False,
            "target_runtime_gate_passed": False,
        },
    }
    encoded = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
