#!/usr/bin/env python3
"""Build loss and full-train embedding artifacts for the listening dashboard."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import torch

from midibrave.config import Config
from midibrave.data import load_manifest
from midibrave.model import TimbreAdapter


LOSS_GROUPS = {
    "reconstruction": [
        "total",
        "self_stft",
        "cross_stft",
        "self_envelope",
        "cross_envelope",
        "self_pitch",
        "cross_pitch",
        "self_rms",
        "cross_rms",
    ],
    "conditioning": [
        "velocity_rank",
        "velocity_delta",
        "timbre_pair",
        "distribution",
        "pitch_adversary",
    ],
    "pitch_diagnostics": [
        "self_pitch_activation",
        "self_pitch_autocorrelation",
        "self_pitch_cents",
        "self_pitch_distribution",
        "self_pitch_hard_negative",
        "cross_pitch_activation",
        "cross_pitch_autocorrelation",
        "cross_pitch_cents",
        "cross_pitch_distribution",
        "cross_pitch_hard_negative",
    ],
}

WEIGHT_KEYS = [
    "self_stft",
    "self_envelope",
    "self_pitch",
    "self_rms",
    "cross_stft",
    "cross_envelope",
    "cross_pitch",
    "cross_rms",
    "velocity_rank",
    "velocity_delta",
    "timbre_pair",
    "distribution",
    "pitch_adversary",
]

CURVE_KEYS = [
    "total",
    "self_stft",
    "cross_stft",
    "self_pitch",
    "cross_pitch",
    "self_rms",
    "cross_rms",
    "distribution",
    "timbre_pair",
]


def finite(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def summary(values: Iterable[float]) -> dict[str, float | int | None]:
    array = np.asarray([value for value in values if math.isfinite(value)], dtype=np.float64)
    if not len(array):
        return {"count": 0, "mean": None, "p10": None, "median": None, "p90": None}
    return {
        "count": int(len(array)),
        "mean": float(array.mean()),
        "p10": float(np.quantile(array, 0.10)),
        "median": float(np.median(array)),
        "p90": float(np.quantile(array, 0.90)),
    }


def downsample(records: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if limit <= 0 or len(records) <= limit:
        return records
    indices = np.linspace(0, len(records) - 1, limit).round().astype(np.int64)
    indices = np.unique(np.concatenate((indices, np.asarray([len(records) - 1]))))
    return [records[int(index)] for index in indices]


def loss_payload(
    log_path: Path,
    checkpoint_step: int,
    config: Config,
    window_updates: int,
    curve_points: int,
) -> dict[str, Any]:
    all_records: list[dict[str, Any]] = []
    with log_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            step = int(record.get("generator_updates", -1))
            if step < 0:
                continue
            all_records.append(record)
    records = [record for record in all_records
               if int(record["generator_updates"]) <= checkpoint_step
               and record.get("generator_step_applied") == 1
               and record.get("gradients_finite") == 1]
    curve_source = [record for record in all_records
                    if record.get("generator_step_applied") == 1
                    and record.get("gradients_finite") == 1]
    if not records or not curve_source:
        raise ValueError(f"no finite applied loss records: {log_path}")

    exact_candidates = [record for record in records
                        if int(record.get("generator_updates", -1)) == checkpoint_step]
    if not exact_candidates:
        raise ValueError(f"no exact loss record for checkpoint {checkpoint_step}: {log_path}")
    exact_record = exact_candidates[-1]
    window = [record for record in records
              if int(record["generator_updates"]) > checkpoint_step - window_updates]

    all_raw_keys = [key for group in LOSS_GROUPS.values() for key in group]
    weighted_keys = [f"weighted_{key}" for key in WEIGHT_KEYS]
    all_keys = all_raw_keys + weighted_keys
    exact = {key: finite(exact_record.get(key)) for key in all_keys}
    aggregates = {
        key: summary(value for record in window
                     if (value := finite(record.get(key))) is not None)
        for key in all_keys
    }

    curve_records: list[dict[str, Any]] = []
    for record in curve_source:
        item: dict[str, Any] = {
            "step": int(record["generator_updates"]),
            "loopStep": int(record.get("loop_step", record["generator_updates"])),
        }
        for key in CURVE_KEYS:
            item[key] = finite(record.get(key))
        curve_records.append(item)

    applied_indices = [index for index, record in enumerate(all_records)
                       if record.get("generator_step_applied") == 1
                       and record.get("gradients_finite") == 1]
    terminal_records = all_records[applied_indices[-1] + 1:] if applied_indices else all_records
    generator_steps = [int(record["generator_updates"]) for record in all_records]
    loop_steps = [int(record.get("loop_step", record["generator_updates"]))
                  for record in all_records]
    non_finite = [record for record in all_records if record.get("gradients_finite") != 1]
    unapplied = [record for record in all_records if record.get("generator_step_applied") != 1]
    sampled_curve = downsample(curve_records, curve_points)

    weights = {key: finite(getattr(config.loss, key, None)) for key in WEIGHT_KEYS}
    return {
        "checkpointStep": checkpoint_step,
        "log": str(log_path),
        "windowUpdates": window_updates,
        "windowStartExclusive": checkpoint_step - window_updates,
        "windowRecordCount": len(window),
        "finiteAppliedRecordsToCheckpoint": len(records),
        "logRange": {
            "firstGeneratorStep": min(generator_steps),
            "lastGeneratorStep": max(generator_steps),
            "firstLoopStep": min(loop_steps),
            "lastLoopStep": max(loop_steps),
            "rawRecordCount": len(all_records),
            "finiteAppliedRecordCount": len(curve_source),
            "nonFiniteRecordCount": len(non_finite),
            "unappliedRecordCount": len(unapplied),
            "lastFiniteAppliedStep": int(curve_source[-1]["generator_updates"]),
            "terminalInvalidRecordCount": len(terminal_records),
            "terminalStalledGeneratorStep": (
                int(terminal_records[0]["generator_updates"]) if terminal_records else None
            ),
            "terminalInvalidFirstLoopStep": (
                int(terminal_records[0].get("loop_step", terminal_records[0]["generator_updates"]))
                if terminal_records else None
            ),
            "curvePointCount": len(sampled_curve),
            "curveDownsampled": len(sampled_curve) < len(curve_records),
        },
        "exactSelfBranchExecuted": bool(exact_record.get("self_branch_executed")),
        "exactSelfSamplingScale": finite(exact_record.get("self_sampling_scale")),
        "exact": exact,
        "window": aggregates,
        "weights": weights,
        "curve": sampled_curve,
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_clap_matrix(
    manifest_path: Path,
    q150_manifest_path: Path,
    cache_root: Path,
    split: str,
) -> tuple[np.ndarray, list[Any], np.ndarray]:
    records = [record for record in load_manifest(manifest_path) if record.split == split]
    if not records:
        raise ValueError(f"manifest has no {split} records: {manifest_path}")
    q150_ids = {record.sample_id for record in load_manifest(q150_manifest_path)}
    matrix = np.empty((len(records), 512), dtype=np.float32)
    subset = np.empty(len(records), dtype=np.bool_)
    missing: list[str] = []
    for index, record in enumerate(records):
        path = cache_root / "clap" / f"{record.sample_id}.npy"
        try:
            value = np.load(path, allow_pickle=False)
        except (OSError, ValueError):
            missing.append(str(path))
            continue
        if value.shape != (512,) or not np.isfinite(value).all():
            missing.append(str(path))
            continue
        matrix[index] = value
        subset[index] = record.sample_id in q150_ids
        if (index + 1) % 8192 == 0:
            print(json.dumps({"stage": "load_clap", "loaded": index + 1,
                              "total": len(records)}), flush=True)
    if missing:
        raise ValueError(f"missing/invalid CLAP cache files: {len(missing)}; first={missing[:3]}")
    return matrix, records, subset


def encode_checkpoint(
    inputs: np.ndarray,
    checkpoint_path: Path,
    config: Config,
    expected_step: int,
    device: torch.device,
    batch_size: int,
) -> np.ndarray:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    actual_step = int(checkpoint.get("generator_updates", -1))
    if actual_step != expected_step:
        raise ValueError(f"checkpoint step mismatch: {checkpoint_path}: {actual_step}")
    state = checkpoint["model"]
    prefix = "timbre."
    adapter_state = {key[len(prefix):]: value for key, value in state.items()
                     if key.startswith(prefix)}
    if not adapter_state:
        raise ValueError(f"checkpoint has no timbre adapter: {checkpoint_path}")
    adapter = TimbreAdapter(config.model.clap_dim, config.model.timbre_dim).to(device)
    adapter.load_state_dict(adapter_state)
    adapter.eval()
    output = np.empty((len(inputs), config.model.timbre_dim), dtype=np.float32)
    with torch.inference_mode():
        for start in range(0, len(inputs), batch_size):
            stop = min(len(inputs), start + batch_size)
            batch = torch.from_numpy(inputs[start:stop]).to(device, non_blocking=True)
            output[start:stop] = adapter(batch).float().cpu().numpy()
    del adapter, checkpoint, state, adapter_state
    if device.type == "cuda":
        torch.cuda.empty_cache()
    if not np.isfinite(output).all():
        raise ValueError(f"non-finite adapter output: {checkpoint_path}")
    return output


def orient_components(components: np.ndarray) -> np.ndarray:
    result = components.copy()
    for index in range(result.shape[1]):
        column = result[:, index]
        anchor = int(np.argmax(np.abs(column)))
        if column[anchor] < 0:
            result[:, index] *= -1
    return result


def density(coords: np.ndarray, x_edges: np.ndarray, y_edges: np.ndarray,
            mask: np.ndarray | None = None) -> list[list[int]]:
    selected = coords if mask is None else coords[mask]
    counts, _, _ = np.histogram2d(selected[:, 0], selected[:, 1], bins=(x_edges, y_edges))
    return counts.T.astype(np.int64).tolist()


def histogram(values: np.ndarray, edges: np.ndarray) -> dict[str, Any]:
    counts, _ = np.histogram(values, bins=edges)
    return {"edges": edges.astype(float).tolist(), "counts": counts.astype(int).tolist()}


def effective_rank(eigenvalues: np.ndarray) -> tuple[float, float]:
    positive = np.clip(eigenvalues, 0.0, None)
    total = positive.sum()
    if total <= 0:
        return 0.0, 0.0
    probabilities = positive / total
    entropy = -np.sum(probabilities * np.log(probabilities + 1e-12))
    entropy_rank = float(np.exp(entropy))
    participation = float(total * total / np.square(positive).sum())
    return entropy_rank, participation


def embedding_stats(z: np.ndarray, preset_ids: list[str], std_floor: float) -> dict[str, Any]:
    mean = z.mean(axis=0, dtype=np.float64)
    centered = z.astype(np.float64) - mean
    covariance = centered.T @ centered / max(1, len(z) - 1)
    dimension_std = np.sqrt(np.clip(np.diag(covariance), 0.0, None))
    eigenvalues = np.linalg.eigvalsh(covariance)[::-1]
    entropy_rank, participation = effective_rank(eigenvalues)
    off_diagonal = covariance - np.diag(np.diag(covariance))
    variance_penalty = np.maximum(std_floor - np.sqrt(np.diag(covariance) + 1e-4), 0.0).mean()
    covariance_penalty = np.square(off_diagonal).sum() / max(1, z.shape[1] * (z.shape[1] - 1))
    norms = np.linalg.norm(z, axis=1)

    groups: dict[str, list[int]] = {}
    for index, preset in enumerate(preset_ids):
        groups.setdefault(preset, []).append(index)
    centroids = np.stack([z[indices].mean(axis=0) for indices in groups.values()])
    within_sum = 0.0
    for indices, centroid in zip(groups.values(), centroids):
        delta = z[indices] - centroid
        within_sum += float(np.square(delta).sum())
    within_variance = within_sum / max(1, len(z) * z.shape[1])
    centered_centroids = centroids - centroids.mean(axis=0, keepdims=True)
    between_variance = float(np.square(centered_centroids).mean())

    return {
        "meanNorm": float(np.linalg.norm(mean)),
        "sampleNorm": summary(norms.tolist()),
        "dimensionStd": dimension_std.astype(float).tolist(),
        "dimensionStdSummary": summary(dimension_std.tolist()),
        "dimensionsBelowStdFloor": int((dimension_std < std_floor).sum()),
        "stdFloor": std_floor,
        "effectiveRankEntropy": entropy_rank,
        "effectiveRankParticipation": participation,
        "topEigenvalueShare": float(eigenvalues[0] / max(eigenvalues.sum(), 1e-12)),
        "tanhSaturationRate": float(np.mean(np.abs(z) >= 0.95)),
        "distributionPenalty": {
            "variance": float(variance_penalty),
            "covariance": float(covariance_penalty),
            "total": float(variance_penalty + covariance_penalty),
        },
        "presetCount": len(groups),
        "withinPresetVariance": float(within_variance),
        "betweenPresetVariance": float(between_variance),
        "betweenWithinRatio": float(between_variance / max(within_variance, 1e-12)),
    }


def embedding_payload(
    inputs: np.ndarray,
    records: list[Any],
    subset: np.ndarray,
    q150: np.ndarray,
    full: np.ndarray,
    std_floor: float,
    scatter_points: int,
    seed: int,
) -> dict[str, Any]:
    joint_mean = (q150.mean(axis=0, dtype=np.float64)
                  + full.mean(axis=0, dtype=np.float64)) / 2.0
    centered_q150 = q150.astype(np.float64) - joint_mean
    centered_full = full.astype(np.float64) - joint_mean
    covariance = (centered_q150.T @ centered_q150 + centered_full.T @ centered_full)
    covariance /= max(1, len(q150) + len(full) - 1)
    eigenvalues, components = np.linalg.eigh(covariance)
    order = np.argsort(eigenvalues)[::-1]
    eigenvalues = eigenvalues[order]
    components = orient_components(components[:, order])
    coords_q150 = (centered_q150 @ components[:, :2]).astype(np.float32)
    coords_full = (centered_full @ components[:, :2]).astype(np.float32)
    both_coords = np.concatenate((coords_q150, coords_full), axis=0)
    low = np.quantile(both_coords, 0.005, axis=0)
    high = np.quantile(both_coords, 0.995, axis=0)
    padding = np.maximum((high - low) * 0.04, 1e-6)
    low -= padding
    high += padding
    x_edges = np.linspace(low[0], high[0], 65)
    y_edges = np.linspace(low[1], high[1], 49)

    q_indices = np.flatnonzero(subset)
    extra_indices = np.flatnonzero(~subset)
    rng = np.random.default_rng(seed)
    half = scatter_points // 2
    chosen_q = rng.choice(q_indices, min(len(q_indices), half), replace=False)
    chosen_extra = rng.choice(extra_indices, min(len(extra_indices), scatter_points - len(chosen_q)),
                              replace=False)
    chosen = np.sort(np.concatenate((chosen_q, chosen_extra)))
    scatter = []
    for index in chosen:
        record = records[int(index)]
        scatter.append({
            "sampleId": record.sample_id,
            "preset": record.preset_id,
            "note": int(record.midi_note),
            "velocity": int(record.velocity),
            "q150Subset": bool(subset[index]),
            "q150": [float(coords_q150[index, 0]), float(coords_q150[index, 1])],
            "full": [float(coords_full[index, 0]), float(coords_full[index, 1])],
        })

    q_norm = np.linalg.norm(q150, axis=1)
    full_norm = np.linalg.norm(full, axis=1)
    norm_min = float(min(q_norm.min(), full_norm.min()))
    norm_max = float(max(q_norm.max(), full_norm.max()))
    norm_edges = np.linspace(norm_min, norm_max + 1e-8, 41)
    std_values = np.concatenate((q150.std(axis=0, ddof=1), full.std(axis=0, ddof=1)))
    std_edges = np.linspace(float(std_values.min()), float(std_values.max()) + 1e-8, 33)

    q_norm_safe = np.maximum(q_norm, 1e-12)
    full_norm_safe = np.maximum(full_norm, 1e-12)
    paired_cosine = np.sum(q150 * full, axis=1) / (q_norm_safe * full_norm_safe)
    paired_l2 = np.linalg.norm(full - q150, axis=1)
    explained = eigenvalues / max(eigenvalues.sum(), 1e-12)
    preset_ids = [record.preset_id for record in records]

    def version_payload(z: np.ndarray, coords: np.ndarray, norms: np.ndarray) -> dict[str, Any]:
        stats = embedding_stats(z, preset_ids, std_floor)
        stats.update({
            "densityAll": density(coords, x_edges, y_edges),
            "densityQ150Subset": density(coords, x_edges, y_edges, subset),
            "densityFullExtra": density(coords, x_edges, y_edges, ~subset),
            "normHistogram": histogram(norms, norm_edges),
            "dimensionStdHistogram": histogram(z.std(axis=0, ddof=1), std_edges),
            "pcaCentroid": coords.mean(axis=0).astype(float).tolist(),
            "pcaStd": coords.std(axis=0, ddof=1).astype(float).tolist(),
        })
        return stats

    return {
        "definition": "128-D z_timbre = checkpoint TimbreAdapter(normalized 512-D CLAP)",
        "projection": "joint PCA fitted to both checkpoints on the same full train split",
        "pca": {
            "explainedVarianceRatio": explained[:10].astype(float).tolist(),
            "xEdges": x_edges.astype(float).tolist(),
            "yEdges": y_edges.astype(float).tolist(),
            "grid": {"columns": 64, "rows": 48},
        },
        "sourceClapNorm": summary(np.linalg.norm(inputs, axis=1).tolist()),
        "versions": {
            "phase1": version_payload(q150, coords_q150, q_norm),
            "phase2": version_payload(full, coords_full, full_norm),
        },
        "pairedShift": {
            "cosineSimilarity": summary(paired_cosine.tolist()),
            "l2Distance": summary(paired_l2.tolist()),
            "pcaDisplacement": summary(np.linalg.norm(coords_full - coords_q150, axis=1).tolist()),
        },
        "scatter": scatter,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--q150-manifest", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path, required=True)
    parser.add_argument("--q150-checkpoint", type=Path, required=True)
    parser.add_argument("--full-checkpoint", type=Path, required=True)
    parser.add_argument("--q150-log", type=Path, required=True)
    parser.add_argument("--full-log", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--split", default="train")
    parser.add_argument("--batch-size", type=int, default=4096)
    parser.add_argument("--window-updates", type=int, default=1000)
    parser.add_argument("--curve-points", type=int, default=0,
                        help="maximum finite curve records; 0 keeps every logged point")
    parser.add_argument("--scatter-points", type=int, default=2400)
    parser.add_argument("--seed", type=int, default=20260719)
    args = parser.parse_args()

    if args.output.exists():
        raise ValueError(f"refusing to overwrite output: {args.output}")
    config = Config.load(args.config)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        raise RuntimeError("embedding analysis requires the allocated CUDA device")

    print(json.dumps({"stage": "start", "device": str(device)}), flush=True)
    inputs, records, subset = load_clap_matrix(
        args.manifest, args.q150_manifest, args.cache_root, args.split)
    print(json.dumps({"stage": "encode_q150", "samples": len(records)}), flush=True)
    q150 = encode_checkpoint(inputs, args.q150_checkpoint, config, 23_162,
                             device, args.batch_size)
    print(json.dumps({"stage": "encode_full", "samples": len(records)}), flush=True)
    full = encode_checkpoint(inputs, args.full_checkpoint, config, 75_365,
                             device, args.batch_size)
    print(json.dumps({"stage": "summarize"}), flush=True)

    payload = {
        "schema": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "scope": {
            "manifest": str(args.manifest),
            "manifestSha256": sha256_file(args.manifest),
            "split": args.split,
            "sampleCount": len(records),
            "presetCount": len({record.preset_id for record in records}),
            "noteMin": min(record.midi_note for record in records),
            "noteMax": max(record.midi_note for record in records),
            "velocities": sorted({record.velocity for record in records}),
            "q150SubsetSamples": int(subset.sum()),
            "fullExtraSamples": int((~subset).sum()),
            "clapCacheRoot": str(args.cache_root / "clap"),
            "clapDimension": config.model.clap_dim,
            "timbreDimension": config.model.timbre_dim,
        },
        "versions": {
            "phase1": {"label": "Q150 · 23,162", "checkpoint": str(args.q150_checkpoint)},
            "phase2": {"label": "FULL · 75,365", "checkpoint": str(args.full_checkpoint)},
        },
        "losses": {
            "interpretation": "training telemetry; exact checkpoint/window summaries plus every finite applied loss record across each complete metrics log",
            "groups": LOSS_GROUPS,
            "weightedKeys": [f"weighted_{key}" for key in WEIGHT_KEYS],
            "curveKeys": CURVE_KEYS,
            "versions": {
                "phase1": loss_payload(args.q150_log, 23_162, config,
                                       args.window_updates, args.curve_points),
                "phase2": loss_payload(args.full_log, 75_365, config,
                                       args.window_updates, args.curve_points),
            },
        },
        "embeddings": embedding_payload(
            inputs, records, subset, q150, full, config.loss.latent_std_floor,
            args.scatter_points, args.seed),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
                         encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps({"stage": "complete", "output": str(args.output),
                      "bytes": args.output.stat().st_size}), flush=True)


if __name__ == "__main__":
    main()
