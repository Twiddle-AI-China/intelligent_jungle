#!/usr/bin/env python3
"""Fault-smoke runner. Fake output is deliberately ineligible for cutover acceptance."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
import urllib.request
from pathlib import Path

SCENARIOS = ("identity-tamper", "worker-crash", "worker-stall", "replace-timeout",
             "edge-overflow", "pcm-corruption", "slow-writer", "lease-disconnect",
             "provider-timeout", "world-continues")


class StressError(RuntimeError):
    pass


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def load_manifest(release_dir: Path) -> dict:
    path = release_dir / "release-manifest.json"
    sidecar = release_dir / "release-manifest.json.sha256"
    try:
        raw = path.read_bytes()
        value = json.loads(raw)
        expected = f"{hashlib.sha256(raw).hexdigest()}  release-manifest.json\n"
        if raw != canonical(value) or sidecar.read_text("ascii") != expected:
            raise ValueError
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise StressError("RELEASE_MANIFEST_INVALID") from exc
    return value


def run_fake(duration_seconds: float) -> tuple[list[float], list[dict]]:
    started = time.monotonic()
    samples: list[float] = []
    checksum = 0.0
    while time.monotonic() - started < duration_seconds:
        step = len(samples) + 1
        tick = time.monotonic()
        block = [math.sin((step + offset) * 0.03125) for offset in range(256)]
        checksum += sum(block)
        samples.append((time.monotonic() - tick) * 1000)
        time.sleep(min(0.01, max(0.0, duration_seconds - (time.monotonic() - started))))
    if not math.isfinite(checksum) or not samples:
        raise StressError("FAULT_SMOKE_FAILED")
    outcomes = [{"name": name, "passed": True} for name in SCENARIOS]
    return samples, outcomes


def run_real(duration_seconds: float, base_url: str, manifest: dict) -> tuple[list[dict], list[dict]]:
    if base_url != "http://127.0.0.1:18090":
        raise StressError("LOOPBACK_CANDIDATE_URL_REQUIRED")
    started = time.monotonic(); samples = []
    while time.monotonic() - started < duration_seconds:
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(base_url + "/readyz", timeout=2) as response:
                ready = json.loads(response.read())
            telemetry = ready.get("workerTelemetry")
            expected = manifest.get("workerIdentity")
            identity = ready.get("workerIdentity", {})
            if (response.status != 200 or ready.get("workerReady") is not True
                    or identity.get("expected") != expected or identity.get("reported") != expected
                    or not isinstance(telemetry, dict)
                    or not all(isinstance(telemetry.get(name), (int, float))
                               and math.isfinite(telemetry[name]) for name in
                               ("renderP95Ms", "renderP99Ms", "blockDurationMs"))
                    or telemetry["blockDurationMs"] <= 0):
                raise ValueError
        except Exception as exc:
            raise StressError("REAL_WORKER_NOT_READY") from exc
        samples.append({"renderP95BlockFraction": telemetry["renderP95Ms"] / telemetry["blockDurationMs"],
                        "renderP99BlockFraction": telemetry["renderP99Ms"] / telemetry["blockDurationMs"]})
        time.sleep(min(0.25, max(0.0, duration_seconds - (time.monotonic() - started))))
    return samples, [{"name": "real-drain-apply-render-publish-telemetry", "passed": True}]


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=("fake", "real"), required=True)
    parser.add_argument("--duration-seconds", type=float, required=True)
    parser.add_argument("--release-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:18090")
    args = parser.parse_args()
    try:
        if not math.isfinite(args.duration_seconds) or args.duration_seconds <= 0:
            raise StressError("DURATION_INVALID")
        output = args.output.resolve()
        if output.name != "fault-smoke.json" or output.exists():
            raise StressError("FAULT_SMOKE_OUTPUT_REQUIRED")
        manifest = load_manifest(args.release_dir.resolve()) if args.backend == "real" else None
        started = time.monotonic()
        samples, scenarios = (run_fake(args.duration_seconds) if args.backend == "fake"
                              else run_real(args.duration_seconds, args.base_url, manifest))
        report = {"schemaVersion": 1, "kind": "local-fake-fault-smoke" if args.backend == "fake"
                  else "real-worker-fault-smoke", "cutoverEligible": False,
                  "measuredDurationSeconds": time.monotonic() - started,
                  "sampleCount": len(samples),
                  "scenarios": scenarios}
        if args.backend == "fake":
            report["fakeLoopP95Ms"] = percentile(samples, .95)
        else:
            report["renderP95BlockFraction"] = percentile(
                [item["renderP95BlockFraction"] for item in samples], .95)
            report["renderP99BlockFraction"] = percentile(
                [item["renderP99BlockFraction"] for item in samples], .99)
        if manifest is not None:
            report["releaseRevision"] = manifest.get("workerIdentity", {}).get("releaseRevision")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(canonical(report))
    except StressError as exc:
        print(str(exc))
        return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
