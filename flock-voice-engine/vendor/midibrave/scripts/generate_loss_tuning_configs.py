#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import yaml


CANDIDATES = {
    "b0": {
        "pitch_activation": 0.0,
        "pitch_hard_negative": 0.0,
        "pitch_autocorrelation": 0.0,
    },
    "c1": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 0.0,
    },
    "c2": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 1.0,
    },
    "c3": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 1.0,
        "cross_pitch": 4.0,
    },
    "c4": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 1.0,
        "pitch_kl": 0.0,
    },
    "c5": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
    },
    "c6": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
    },
    "c7": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
        "pitch_kl": 0.0,
    },
    "c8": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
        "pitch_kl": 0.0,
        "cross_stft": 0.35,
    },
    "c9": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
        "pitch_kl": 0.0,
        "cross_stft": 0.50,
    },
    "c10": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
        "pitch_kl": 0.0,
        "cross_stft": 0.50,
        "self_rms": 0.50,
        "cross_rms": 1.0,
        "velocity_rank": 2.0,
        "velocity_delta": 2.0,
    },
    "c11": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
        "pitch_kl": 0.0,
        "cross_stft": 0.50,
        "self_rms": 1.0,
        "cross_rms": 2.0,
        "velocity_rank": 4.0,
        "velocity_delta": 4.0,
    },
    "c12": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
        "pitch_kl": 0.0,
        "cross_stft": 0.50,
        "velocity_rank": 1.0,
        "velocity_delta": 1.0,
    },
    "c13": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
        "pitch_kl": 0.0,
        "cross_stft": 0.50,
        "self_rms": 0.50,
        "cross_rms": 1.0,
        "velocity_rank": 2.0,
        "velocity_delta": 2.0,
    },
    "c14": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
        "pitch_kl": 0.0,
        "cross_stft": 0.50,
        "velocity_rank": 1.0,
        "velocity_delta": 1.0,
    },
    "c15": {
        "pitch_activation": 1.0,
        "pitch_hard_negative": 0.25,
        "pitch_autocorrelation": 20.0,
        "cross_pitch": 1.0,
        "pitch_kl": 0.0,
        "cross_stft": 0.50,
        "velocity_rank": 2.0,
        "velocity_delta": 2.0,
    },
}


MODEL_OVERRIDES = {
    "c14": {"condition_gain_hidden": 32, "condition_gain_max_db": 12.0},
    "c15": {"condition_gain_hidden": 32, "condition_gain_max_db": 12.0},
}


def sha256(paths: list[Path], root: Path) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\n")
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--candidates", default=",".join(CANDIDATES))
    parser.add_argument("--run-prefix", default="loss_tune_r1")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    training_code_hash = sha256([
        root / "src/midibrave/config.py",
        root / "src/midibrave/data.py",
        root / "src/midibrave/losses.py",
        root / "src/midibrave/trainer.py",
        root / "src/midibrave/model.py",
    ], root)
    evaluation_code_hash = sha256([
        root / "src/midibrave/evaluate.py",
        root / "scripts/check_short_quality_gate.py",
    ], root)
    base = yaml.safe_load(Path(args.base).read_text(encoding="utf-8"))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    requested = [item.strip().lower() for item in args.candidates.split(",") if item.strip()]
    unknown = sorted(set(requested) - set(CANDIDATES))
    if unknown:
        raise ValueError(f"unknown loss candidates: {unknown}")

    index = []
    for candidate in requested:
        raw = yaml.safe_load(yaml.safe_dump(base, sort_keys=False))
        raw["loss"].update(CANDIDATES[candidate])
        raw["model"].update(MODEL_OVERRIDES.get(candidate, {}))
        raw["train"].update({
            "phase1_steps": 5000,
            "phase2_steps": 1,
            "warmup_steps": 500,
            "pitch_adversary_start": 500,
            "pitch_adversary_ramp": 100,
            "checkpoint_every": 1000,
            "log_every": 21,
            "output_dir": "/data/midibrave/loss_tuning",
            "run_name": f"{args.run_prefix}_{candidate}",
        })
        path = output / f"{args.run_prefix}_{candidate}.yaml"
        text = yaml.safe_dump(raw, sort_keys=False)
        path.write_text(text, encoding="utf-8")
        config_hash = hashlib.sha256(text.encode()).hexdigest()
        index.append({
            "candidate": candidate,
            "config": str(path),
            "run_name": raw["train"]["run_name"],
            "code_hash": training_code_hash,
            "training_code_hash": training_code_hash,
            "evaluation_code_hash": evaluation_code_hash,
            "config_file_sha256": config_hash,
            "model": raw["model"],
            "loss": raw["loss"],
        })
    report = {
        "schema": 2,
        "code_hash": training_code_hash,
        "training_code_hash": training_code_hash,
        "evaluation_code_hash": evaluation_code_hash,
        "candidates": index,
    }
    (output / f"{args.run_prefix}_index.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
