from __future__ import annotations

import argparse
import json
import platform
import statistics
import subprocess
import time
from pathlib import Path

import numpy as np


def _percentile(values: list[float], fraction: float) -> float:
    return float(np.percentile(np.asarray(values), fraction * 100))


def fixture_decode(control: np.ndarray, samples_per_frame: int) -> np.ndarray:
    repeated = np.repeat(np.tanh(control[:, :1, :]), samples_per_frame, axis=2)
    return repeated


def benchmark_fixture(voices: int, frames: int, repeats: int, samples_per_frame: int, stress_seconds: float = 0) -> tuple[list[float], int, list[float]]:
    control = np.zeros((voices, 16, frames), dtype=np.float32)
    times = []
    samples = 0
    for _ in range(repeats):
        start = time.perf_counter_ns()
        output = fixture_decode(control, samples_per_frame)
        times.append((time.perf_counter_ns() - start) / 1e6)
        samples = output.shape[-1]
    stress_times: list[float] = []
    deadline = time.monotonic() + stress_seconds
    while time.monotonic() < deadline:
        start = time.perf_counter_ns()
        fixture_decode(control, samples_per_frame)
        stress_times.append((time.perf_counter_ns() - start) / 1e6)
    return times, samples, stress_times


def benchmark_torchscript(model_path: Path, voices: int, latent_dim: int, frames: int, repeats: int, stress_seconds: float = 0) -> tuple[list[float], int, list[float]]:
    try:
        import torch
    except ImportError as error:
        raise SystemExit("torch is required; run `uv sync --extra rave` in research/") from error
    model = torch.jit.load(str(model_path), map_location="cpu").eval()
    control = torch.zeros((voices, latent_dim, frames), dtype=torch.float32)
    times: list[float] = []
    samples = 0
    with torch.inference_mode():
        for _ in range(3):
            model.decode(control)
        for _ in range(repeats):
            start = time.perf_counter_ns()
            output = model.decode(control)
            times.append((time.perf_counter_ns() - start) / 1e6)
            samples = int(output.shape[-1])
        stress_times: list[float] = []
        deadline = time.monotonic() + stress_seconds
        while time.monotonic() < deadline:
            start = time.perf_counter_ns()
            model.decode(control)
            stress_times.append((time.perf_counter_ns() - start) / 1e6)
    return times, samples, stress_times


def target_facts() -> dict:
    facts = {"system": platform.system(), "machine": platform.machine(), "processor": platform.processor(), "memory_bytes": 0}
    if facts["system"] == "Darwin":
        for key, field in (("machdep.cpu.brand_string", "processor"), ("hw.memsize", "memory_bytes")):
            try:
                value = subprocess.check_output(["/usr/sbin/sysctl", "-n", key], text=True).strip()
                facts[field] = int(value) if field == "memory_bytes" else value
            except (OSError, subprocess.CalledProcessError, ValueError):
                pass
    return facts


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure decoder latency/RTF without claiming fixture results as a model gate.")
    parser.add_argument("--backend", choices=("fixture", "torchscript"), required=True)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--voices", type=int, default=6)
    parser.add_argument("--latent-dim", type=int, default=128)
    parser.add_argument("--frames", type=int, default=4)
    parser.add_argument("--samples-per-frame", type=int, default=128)
    parser.add_argument("--sample-rate", type=int, default=48_000)
    parser.add_argument("--repeats", type=int, default=100)
    parser.add_argument("--stress-seconds", type=float, default=0, help="actually run repeated decode calls for this duration")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.backend == "torchscript":
        if not args.model:
            parser.error("--model is required for torchscript")
        times, samples, stress_times = benchmark_torchscript(args.model, args.voices, args.latent_dim, args.frames, args.repeats, args.stress_seconds)
    else:
        times, samples, stress_times = benchmark_fixture(args.voices, args.frames, args.repeats, args.samples_per_frame, args.stress_seconds)
    audio_ms = samples / args.sample_rate * 1000
    deadline_misses = sum(value > audio_ms for value in stress_times)
    report = {
        "backend": args.backend,
        "model": str(args.model) if args.model else None,
        "gate_eligible": args.backend != "fixture",
        "voices": args.voices,
        "audio_block_ms": audio_ms,
        "latency_ms": {"mean": statistics.fmean(times), "p50": _percentile(times, 0.5), "p95": _percentile(times, 0.95), "p99": _percentile(times, 0.99), "jitter_stdev": statistics.pstdev(times)},
        "estimated_control_latency_ms": _percentile(times, 0.95) + audio_ms,
        "rtf": statistics.fmean(times) / max(audio_ms, 1e-9),
        "target": target_facts(),
        "continuous_minutes": args.stress_seconds / 60.0,
        "stress_calls": len(stress_times),
        "deadline_misses": deadline_misses,
    }
    encoded = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded)


if __name__ == "__main__":
    main()
