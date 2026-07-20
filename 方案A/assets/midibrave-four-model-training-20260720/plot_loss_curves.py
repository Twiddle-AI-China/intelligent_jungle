from __future__ import annotations

import json
import math
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter
import numpy as np


ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
MODELS = ("pad", "lead", "base", "pluck")
COLORS = {
    "pad": "#2563eb",
    "lead": "#dc2626",
    "base": "#16a34a",
    "pluck": "#9333ea",
}
def load_rows(model: str) -> list[dict]:
    rows = []
    with (RAW / f"{model}-metrics.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            step = row.get("generator_updates")
            if isinstance(step, (int, float)) and math.isfinite(float(step)):
                rows.append(row)
    return rows


def raw_series(rows: list[dict], field: str, positive: bool = False) -> tuple[np.ndarray, np.ndarray]:
    points = []
    for row in rows:
        step = row.get("generator_updates")
        value = row.get(field)
        if not isinstance(step, (int, float)) or not isinstance(value, (int, float)):
            continue
        if not math.isfinite(float(step)) or not math.isfinite(float(value)):
            continue
        if positive and float(value) <= 0:
            continue
        points.append((float(step), float(value)))
    points.sort(key=lambda item: item[0])
    if not points:
        return np.asarray([]), np.asarray([])
    return np.asarray([item[0] for item in points]), np.asarray([item[1] for item in points])


def exponential_moving_average(values: np.ndarray, span: int) -> np.ndarray:
    if values.size == 0:
        return values
    alpha = 2.0 / (max(1, span) + 1.0)
    output = np.empty_like(values, dtype=float)
    output[0] = values[0]
    for index in range(1, values.size):
        output[index] = alpha * values[index] + (1.0 - alpha) * output[index - 1]
    return output


def segmented_ema(xs: np.ndarray, values: np.ndarray, span: int,
                  maximum_gap: float | None = None) -> np.ndarray:
    if maximum_gap is None or values.size == 0:
        return exponential_moving_average(values, span)
    output = np.full_like(values, np.nan, dtype=float)
    starts = [0]
    starts.extend((np.nonzero(np.diff(xs) > maximum_gap)[0] + 1).tolist())
    starts.append(values.size)
    for start, stop in zip(starts[:-1], starts[1:]):
        output[start:stop] = exponential_moving_average(values[start:stop], span)
        if start:
            # Preserve the real logging gap instead of drawing a line across it.
            output[start] = np.nan
    return output


def curve_summary(rows: list[dict], field: str) -> dict[str, float | int | None]:
    xs, ys = raw_series(rows, field)
    if not ys.size:
        return {
            "first": None, "last": None, "minimum": None, "maximum": None,
            "mean_first_1000": None, "mean_last_1000": None, "raw_points": 0,
        }
    first_mask = xs < xs.min() + 1000
    last_mask = xs >= xs.max() - 1000
    return {
        "first": float(ys[0]),
        "last": float(ys[-1]),
        "minimum": float(ys.min()),
        "maximum": float(ys.max()),
        "mean_first_1000": float(ys[first_mask].mean()),
        "mean_last_1000": float(ys[last_mask].mean()),
        "raw_points": int(ys.size),
    }


def k_formatter(value: float, _position: int) -> str:
    return f"{value / 1000:g}k" if value else "0"


def style_axis(axis, title: str, log: bool = False) -> None:
    axis.set_title(title, fontsize=10, fontweight="bold")
    axis.grid(True, which="both", alpha=0.22, linewidth=0.7)
    axis.xaxis.set_major_formatter(FuncFormatter(k_formatter))
    axis.set_xlabel("Generator updates")
    if log:
        axis.set_yscale("log")


def plot_fields(axis, rows: list[dict], fields: tuple[tuple[str, str, str], ...],
                title: str, log: bool = False) -> None:
    for field, label, color in fields:
        xs, ys = raw_series(rows, field, positive=log)
        if xs.size:
            # Every actual metrics.jsonl point remains visible. The EMA line is
            # a display aid only; no binning or point selection is performed.
            sparse = "clap" in field
            axis.scatter(
                xs, ys, color=color, s=12 if sparse else 5,
                alpha=0.30 if sparse else 0.10, edgecolors="none", rasterized=True,
            )
            span = 5 if sparse else 25
            axis.plot(
                xs, segmented_ema(xs, ys, span, 500 if sparse else None),
                label=f"{label} EMA",
                color=color, linewidth=2.0,
            )
    style_axis(axis, title, log)
    axis.legend(fontsize=7.5, frameon=False, loc="best")


def plot_model(model: str, rows: list[dict]) -> None:
    fig, axes = plt.subplots(4, 2, figsize=(13, 15), constrained_layout=True)
    fig.suptitle(
        f"MidiBrave {model.capitalize()} — Phase 1 loss curves\n"
        f"all raw logged points + EMA; snapshot update {max(r['generator_updates'] for r in rows):,}",
        fontsize=15,
        fontweight="bold",
    )
    plot_fields(axes[0, 0], rows, (("total", "Total (mixed schedule)", "#111827"),),
                "Logged total loss (composition varies)", True)
    plot_fields(axes[0, 1], rows, (
        ("self_stft", "Self STFT", "#2563eb"),
        ("cross_stft", "Cross STFT", "#dc2626"),
    ), "STFT reconstruction", True)
    plot_fields(axes[1, 0], rows, (
        ("self_pitch", "Self pitch", "#2563eb"),
        ("cross_pitch", "Cross pitch", "#dc2626"),
    ), "MIDI pitch constraint", True)
    plot_fields(axes[1, 1], rows, (
        ("self_clap", "Self CLAP", "#2563eb"),
        ("cross_clap", "Cross CLAP", "#dc2626"),
    ), "Frozen-CLAP reconstruction", False)
    plot_fields(axes[2, 0], rows, (
        ("self_envelope", "Self envelope", "#2563eb"),
        ("cross_envelope", "Cross envelope", "#dc2626"),
    ), "Multi-scale envelope", True)
    plot_fields(axes[2, 1], rows, (
        ("self_rms", "Self RMS", "#2563eb"),
        ("cross_rms", "Cross RMS", "#dc2626"),
    ), "Window RMS", True)
    plot_fields(axes[3, 0], rows, (
        ("timbre_pair", "Timbre pair", "#0891b2"),
        ("distribution", "Latent distribution", "#f59e0b"),
    ), "Latent regularization", True)
    plot_fields(axes[3, 1], rows, (
        ("velocity_rank", "Velocity rank", "#9333ea"),
        ("pitch_adversary", "Pitch adversary CE", "#16a34a"),
    ), "Auxiliary objectives", False)
    fig.savefig(ROOT / f"{model}-loss-curves.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def plot_comparison(all_rows: dict[str, list[dict]]) -> None:
    panels = (
        ("cross_stft", "Cross STFT", True),
        ("cross_pitch", "Cross pitch", True),
        ("cross_clap", "Cross CLAP", False),
        ("cross_envelope", "Cross envelope", True),
        ("cross_rms", "Cross RMS", True),
        ("distribution", "Latent distribution", True),
    )
    fig, axes = plt.subplots(2, 3, figsize=(16, 8.5), constrained_layout=True)
    fig.suptitle(
        "MidiBrave four-model Phase 1 comparison — all raw logged points + EMA",
        fontsize=15,
        fontweight="bold",
    )
    for axis, (field, title, log) in zip(axes.flat, panels):
        for model, rows in all_rows.items():
            xs, ys = raw_series(rows, field, positive=log)
            if xs.size:
                sparse = "clap" in field
                axis.scatter(
                    xs, ys, color=COLORS[model], s=9 if sparse else 3,
                    alpha=0.20 if sparse else 0.035, edgecolors="none", rasterized=True,
                )
                axis.plot(
                    xs, segmented_ema(
                        xs, ys, 5 if sparse else 25, 500 if sparse else None),
                    label=model.capitalize(), color=COLORS[model], linewidth=2,
                )
        style_axis(axis, title, log)
        axis.legend(fontsize=8, frameon=False)
    fig.savefig(ROOT / "four-model-loss-comparison.png", dpi=180, bbox_inches="tight")
    plt.close(fig)


def main() -> None:
    all_rows = {model: load_rows(model) for model in MODELS}
    for model, rows in all_rows.items():
        plot_model(model, rows)
    plot_comparison(all_rows)
    fields = (
        "total", "self_stft", "cross_stft", "self_pitch", "cross_pitch",
        "self_clap", "cross_clap", "self_envelope", "cross_envelope",
        "self_rms", "cross_rms", "timbre_pair", "distribution",
        "velocity_rank", "pitch_adversary",
    )
    summary = {}
    for model, rows in all_rows.items():
        summary[model] = {
            "latest_update": max(int(row["generator_updates"]) for row in rows),
            "log_rows": len(rows),
            "skipped_updates": sum(
                1 for row in rows if row.get("generator_step_applied") == 0
            ),
            "curves": {field: curve_summary(rows, field) for field in fields},
        }
    (ROOT / "loss-curve-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
