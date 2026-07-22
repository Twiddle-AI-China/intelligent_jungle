from __future__ import annotations

import argparse
import json
import math
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import torch
from torch import Tensor
from torch.nn import functional as F
from torch.utils.data import DataLoader, Subset

from .config import Config
from .data import PairDataset, load_manifest, midi_to_hz
from .losses import MultiResolutionSTFTLoss, rms_db
from .model import MidiBrave


class MetricStore:
    def __init__(self) -> None:
        self.values: dict[str, list[float]] = {}

    def add(self, name: str, values: Tensor | list[float] | float) -> None:
        if isinstance(values, Tensor):
            items = values.detach().float().flatten().cpu().tolist()
        elif isinstance(values, list):
            items = values
        else:
            items = [values]
        self.values.setdefault(name, []).extend(
            float(value) for value in items if math.isfinite(float(value)))

    def summary(self) -> dict[str, dict[str, float | int]]:
        output: dict[str, dict[str, float | int]] = {}
        for name, values in sorted(self.values.items()):
            if not values:
                output[name] = {"count": 0}
                continue
            array = np.asarray(values, dtype=np.float64)
            output[name] = {
                "count": len(values),
                "mean": float(array.mean()),
                "median": float(np.median(array)),
                "p90": float(np.quantile(array, 0.9)),
            }
        return output


def move_batch(batch: dict[str, Any], device: torch.device) -> dict[str, Any]:
    return {name: value.to(device, non_blocking=True) if isinstance(value, Tensor) else value
            for name, value in batch.items()}


def mask_audio(audio: Tensor, valid_samples: Tensor | None) -> Tensor:
    if valid_samples is None:
        return audio
    positions = torch.arange(audio.shape[-1], device=audio.device)
    return audio * (positions[None, :] < valid_samples[:, None]).to(audio)[:, None]


def spectral_metrics(prediction: Tensor, target: Tensor, sample_rate: int) -> tuple[Tensor, Tensor]:
    with torch.autocast(device_type=prediction.device.type, enabled=False):
        window = torch.hann_window(2048, device=prediction.device)
        predicted = torch.stft(prediction.float().squeeze(1), 2048, 512, 2048, window,
                               return_complex=True, pad_mode="constant").abs().clamp_min(1e-7)
        reference = torch.stft(target.float().squeeze(1), 2048, 512, 2048, window,
                               return_complex=True, pad_mode="constant").abs().clamp_min(1e-7)
        lsd = ((20.0 * (predicted.log10() - reference.log10())).square()
               .mean(dim=(-1, -2)).sqrt())
        frequency = torch.fft.rfftfreq(2048, 1.0 / sample_rate).to(prediction.device)
        high = frequency >= 0.8 * (sample_rate / 2.0)
        predicted_energy = predicted[:, high].square().mean(dim=(-1, -2)).clamp_min(1e-12)
        reference_energy = reference[:, high].square().mean(dim=(-1, -2)).clamp_min(1e-12)
        upper_band_error_db = (10.0 * torch.log10(predicted_energy / reference_energy)).abs()
    return lsd, upper_band_error_db


def transient_metrics(prediction: Tensor, target: Tensor, sample_rate: int) -> tuple[Tensor, Tensor, Tensor]:
    predicted_difference = prediction.float().diff(dim=-1).abs().squeeze(1)
    target_difference = target.float().diff(dim=-1).abs().squeeze(1)
    median = target_difference.median(dim=-1).values
    deviation = (target_difference - median[:, None]).abs().median(dim=-1).values
    threshold = (median + 12.0 * deviation).clamp_min(1e-4)
    generated_clicks = (predicted_difference > threshold[:, None]).float().sum(-1)
    target_clicks = (target_difference > threshold[:, None]).float().sum(-1)
    seconds = prediction.shape[-1] / sample_rate
    generated_rate = generated_clicks / seconds
    target_rate = target_clicks / seconds
    crest = (prediction.float().abs().amax(dim=(-1, -2))
             / prediction.float().square().mean(dim=(-1, -2)).sqrt().clamp_min(1e-7))
    target_crest = (target.float().abs().amax(dim=(-1, -2))
                    / target.float().square().mean(dim=(-1, -2)).sqrt().clamp_min(1e-7))
    return generated_rate, target_rate, (crest - target_crest).abs()


def ripple_error(prediction: Tensor, target: Tensor) -> Tensor:
    predicted = F.avg_pool1d(prediction.float().square(), 256, 128).clamp_min(1e-8).sqrt()
    reference = F.avg_pool1d(target.float().square(), 256, 128).clamp_min(1e-8).sqrt()
    predicted_curvature = predicted[..., 2:] - 2 * predicted[..., 1:-1] + predicted[..., :-2]
    reference_curvature = reference[..., 2:] - 2 * reference[..., 1:-1] + reference[..., :-2]
    return (predicted_curvature - reference_curvature).abs().mean(dim=(-1, -2))


@torch.no_grad()
def pitch_measurements_by_sample(
        audio: Tensor, notes: Tensor, sample_rate: int,
        hop_length: int) -> tuple[list[list[float]], list[float | None], list[list[float]]]:
    import torchcrepe

    # torchcrepe's public preprocessing contract is [1, time], and it flattens
    # a larger leading dimension into one temporal sequence. Decode each signal
    # independently so Viterbi state never crosses waveform boundaries. Calling
    # at the source sample rate deliberately reuses torchcrepe's official
    # resampy path, matching the dataset F0-cache implementation exactly.
    pitches: list[Tensor] = []
    periodicities: list[Tensor] = []
    for signal in audio.float().squeeze(1):
        item_pitch, item_periodicity = torchcrepe.predict(
            signal.unsqueeze(0), sample_rate, hop_length,
            50.0, 2000.0, "tiny", batch_size=1024,
            device=audio.device, return_periodicity=True,
        )
        pitches.append(item_pitch.squeeze(0))
        periodicities.append(item_periodicity.squeeze(0))
    pitch = torch.stack(pitches)
    periodicity = torch.stack(periodicities)
    target = midi_to_hz(notes).to(pitch)[:, None]
    cents = 1200.0 * torch.log2((pitch + 1e-7) / (target + 1e-7))
    frame_errors: list[list[float]] = []
    medians: list[float | None] = []
    frame_periodicity: list[list[float]] = []
    for index in range(audio.shape[0]):
        # Generated audio with poor periodicity is a model failure that must be
        # measured, not silently removed from the F0 denominator.  Retain every
        # finite CREPE frame for F0/octave/MIDI-following and expose periodicity
        # separately so pitch accuracy and voicing quality remain distinguishable.
        valid = torch.isfinite(cents[index]) & torch.isfinite(periodicity[index])
        values = cents[index, valid]
        periodicity_values = periodicity[index, valid]
        if values.numel():
            frame_errors.append(values.cpu().tolist())
            frame_periodicity.append(periodicity_values.cpu().tolist())
            medians.append(float(values.median().item()))
        else:
            frame_errors.append([])
            frame_periodicity.append([])
            medians.append(None)
    return frame_errors, medians, frame_periodicity


@torch.no_grad()
def pitch_measurements(audio: Tensor, notes: Tensor, sample_rate: int,
                       hop_length: int) -> tuple[list[float], list[float | None], list[float]]:
    errors, medians, periodicity = pitch_measurements_by_sample(
        audio, notes, sample_rate, hop_length)
    return ([value for item in errors for value in item], medians,
            [value for item in periodicity for value in item])


def _pitch_band(note: int) -> str:
    if note <= 47:
        return "low"
    if note <= 59:
        return "mid"
    return "high"


def add_pitch_metrics(metrics: MetricStore, prefix: str,
                      errors: list[list[float]], periodicity: list[list[float]],
                      notes: Tensor, velocities: Tensor) -> None:
    for index, (sample_errors, sample_periodicity) in enumerate(zip(errors, periodicity)):
        absolute = [abs(value) for value in sample_errors]
        octave = [float(abs(value) > 600.0) for value in sample_errors]
        low_periodicity = [float(value < 0.5) for value in sample_periodicity]
        metrics.add(f"{prefix}_f0_signed_cents", sample_errors)
        metrics.add(f"{prefix}_f0_absolute_cents", absolute)
        metrics.add(f"{prefix}_f0_octave_error", octave)
        metrics.add(f"{prefix}_f0_periodicity", sample_periodicity)
        metrics.add(f"{prefix}_f0_low_periodicity_rate", low_periodicity)
        band = _pitch_band(int(notes[index].item()))
        velocity = int(velocities[index].item())
        metrics.add(f"{prefix}_f0_absolute_cents_{band}", absolute)
        metrics.add(f"{prefix}_f0_octave_error_{band}", octave)
        metrics.add(f"{prefix}_f0_periodicity_{band}", sample_periodicity)
        metrics.add(f"{prefix}_f0_absolute_cents_v{velocity}", absolute)
        metrics.add(f"{prefix}_f0_periodicity_v{velocity}", sample_periodicity)


def save_examples(root: Path, offset: int, batch: dict[str, Any], self_audio: Tensor,
                  cross_audio: Tensor, sample_rate: int, maximum: int) -> int:
    root.mkdir(parents=True, exist_ok=True)
    saved = offset
    for index in range(self_audio.shape[0]):
        if saved >= maximum:
            break
        stem = f"{saved:04d}-{batch['sample_id_a'][index]}-to-{batch['sample_id_b'][index]}"
        values = {
            "target-a": batch["audio_a"][index], "generated-self": self_audio[index],
            "target-b": batch["audio_b"][index], "generated-cross": cross_audio[index],
        }
        for suffix, waveform in values.items():
            sf.write(root / f"{stem}-{suffix}.wav",
                     waveform.detach().float().squeeze().cpu().numpy(), sample_rate,
                     subtype="FLOAT")
        saved += 1
    return saved


@torch.no_grad()
def generate_grid(model: MidiBrave, dataset: PairDataset, config: Config,
                  output: Path, preset_count: int) -> dict[str, Any]:
    preset_rows = {}
    if config.data.preset_manifest:
        with Path(config.data.preset_manifest).open(encoding="utf-8") as handle:
            preset_rows = {row["preset_id"]: row for row in map(json.loads, handle)}
    by_preset: dict[str, Any] = {}
    for record in dataset.records:
        by_preset.setdefault(record.preset_id, record)
    selected = []
    used_categories = set()
    for preset_id, record in sorted(by_preset.items()):
        category = preset_rows.get(preset_id, {}).get("category", "unknown")
        if category not in used_categories:
            selected.append((record, category))
            used_categories.add(category)
        if len(selected) == preset_count:
            break
    for preset_id, record in sorted(by_preset.items()):
        if len(selected) == preset_count:
            break
        if all(existing.preset_id != preset_id for existing, _ in selected):
            selected.append((record, preset_rows.get(preset_id, {}).get("category", "unknown")))

    output.mkdir(parents=True, exist_ok=True)
    rows = []
    device = next(model.parameters()).device
    notes = list(range(36, 72))
    for record, category in selected:
        clap = torch.from_numpy(np.load(
            Path(config.data.cache_root) / "clap" / f"{record.cache_id}.npy"
        ).astype(np.float32)).unsqueeze(0).to(device)
        z_timbre = model.timbre(clap)
        conditions = [(note, velocity) for note in notes for velocity in (50, 127)]
        for start in range(0, len(conditions), 4):
            chunk = conditions[start:start + 4]
            note = torch.tensor([item[0] for item in chunk], device=device)
            velocity = torch.tensor([item[1] for item in chunk], device=device, dtype=torch.float32)
            with torch.autocast("cuda", dtype=torch.float16):
                waveform = model.decode(z_timbre.expand(len(chunk), -1), note, velocity)
            for index, (midi_note, midi_velocity) in enumerate(chunk):
                relative = Path(record.preset_id) / f"n{midi_note:03d}-v{midi_velocity:03d}.wav"
                destination = output / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                sf.write(destination, waveform[index].float().squeeze().cpu().numpy(),
                         config.data.sample_rate, subtype="FLOAT")
                rows.append({
                    "preset_id": record.preset_id, "category": category,
                    "reference_sample_id": record.sample_id,
                    "midi_note": midi_note, "velocity": midi_velocity,
                    "audio_path": str(relative),
                })
    manifest = output / "grid.jsonl"
    manifest.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows),
                        encoding="utf-8")
    return {"presets": len(selected), "audio_files": len(rows), "manifest": str(manifest)}


@torch.no_grad()
def evaluate(config_path: str, checkpoint_path: str, output_path: str,
             pairs: int, batch_size: int, examples: int, grid_presets: int,
             velocity_pairs: int = 64) -> dict[str, Any]:
    if not torch.cuda.is_available():
        raise RuntimeError("evaluation requires CUDA")
    config = Config.load(config_path)
    device = torch.device("cuda")
    data_config = replace(config.data, split="validation", repeats=1, num_workers=2)
    dataset = PairDataset(data_config, config.seed + 991)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=2,
                        pin_memory=True, persistent_workers=True)
    model = MidiBrave(config.model, config.data.window_samples, config.data.sample_rate).to(device)
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model.load_state_dict(checkpoint["model"])
    model.eval()
    metrics = MetricStore()
    stft = MultiResolutionSTFTLoss().to(device)
    timbre_a: list[Tensor] = []
    timbre_b: list[Tensor] = []
    preset_ids: list[str] = []
    pitch_rows: list[dict[str, Any]] = []
    evaluated = 0
    saved = 0
    output = Path(output_path)
    example_root = output / "examples"
    for raw_batch in loader:
        if evaluated >= pairs:
            break
        batch = move_batch(raw_batch, device)
        with torch.autocast("cuda", dtype=torch.float16):
            result = model(
                batch["clap_a"], batch["note_a"], batch["velocity_a"],
                batch["note_b"], batch["velocity_b"], batch["clap_b"], grl_scale=0.0,
                source_excitation_seed=batch.get("excitation_seed_a"),
                target_excitation_seed=batch.get("excitation_seed_b"))
        current = min(result.self_audio.shape[0], pairs - evaluated)
        self_audio = result.self_audio[:current]
        cross_audio = result.cross_audio[:current]
        audio_a = batch["audio_a"][:current]
        audio_b = batch["audio_b"][:current]
        note_a = batch["note_a"][:current]
        note_b = batch["note_b"][:current]

        valid_a = batch.get("valid_samples_a")
        valid_b = batch.get("valid_samples_b")
        metrics.add("self_mr_stft", stft(self_audio, audio_a, valid_a))
        metrics.add("cross_mr_stft", stft(cross_audio, audio_b, valid_b))
        for prefix, prediction, target, valid_samples in (
                ("self", self_audio, audio_a, valid_a),
                ("cross", cross_audio, audio_b, valid_b)):
            prediction = mask_audio(prediction, valid_samples)
            target = mask_audio(target, valid_samples)
            lsd, upper = spectral_metrics(prediction, target, config.data.sample_rate)
            generated_click, target_click, crest_error = transient_metrics(
                prediction, target, config.data.sample_rate)
            metrics.add(f"{prefix}_lsd_db", lsd)
            metrics.add(f"{prefix}_upper_band_energy_error_db", upper)
            metrics.add(f"{prefix}_generated_clicks_per_second", generated_click)
            metrics.add(f"{prefix}_target_clicks_per_second", target_click)
            metrics.add(f"{prefix}_crest_factor_error", crest_error)
            metrics.add(f"{prefix}_envelope_ripple_error", ripple_error(prediction, target))
            metrics.add(f"{prefix}_rms_error_db",
                        (rms_db(prediction, valid_samples) - rms_db(target, valid_samples)).abs())

        branch_pitch: dict[str, tuple[list[list[float]], list[float | None],
                                      list[list[float]]]] = {}
        for prefix, generated, target, notes, velocities, sample_ids in (
                ("self", mask_audio(self_audio, valid_a), mask_audio(audio_a, valid_a),
                 note_a, batch["velocity_a"][:current],
                 raw_batch["sample_id_a"][:current]),
                ("cross", mask_audio(cross_audio, valid_b), mask_audio(audio_b, valid_b),
                 note_b, batch["velocity_b"][:current],
                 raw_batch["sample_id_b"][:current])):
            errors, medians, periodicity = pitch_measurements_by_sample(
                generated, notes, config.data.sample_rate, config.data.pitch_hop_length)
            add_pitch_metrics(metrics, prefix, errors, periodicity, notes, velocities)
            for item in errors:
                metrics.add("f0_signed_cents", item)
                metrics.add("f0_absolute_cents", [abs(value) for value in item])
                metrics.add("f0_octave_error", [float(abs(value) > 600.0) for value in item])
            for item in periodicity:
                metrics.add("f0_periodicity", item)
                metrics.add("f0_low_periodicity_rate", [float(value < 0.5) for value in item])
            branch_pitch[prefix] = (errors, medians, periodicity)

            target_errors, _, target_periodicity = pitch_measurements_by_sample(
                target, notes, config.data.sample_rate, config.data.pitch_hop_length)
            add_pitch_metrics(metrics, f"target_{prefix}", target_errors,
                              target_periodicity, notes, velocities)
            for item in target_errors:
                metrics.add("target_f0_absolute_cents", [abs(value) for value in item])
                metrics.add("target_f0_octave_error",
                            [float(abs(value) > 600.0) for value in item])
            for item in target_periodicity:
                metrics.add("target_f0_periodicity", item)
                metrics.add("target_f0_low_periodicity_rate",
                            [float(value < 0.5) for value in item])

            for index, (sample_errors, sample_periodicity) in enumerate(
                    zip(errors, periodicity)):
                absolute = np.abs(np.asarray(sample_errors, dtype=np.float64))
                period = np.asarray(sample_periodicity, dtype=np.float64)
                pitch_rows.append({
                    "branch": prefix,
                    "sample_id": sample_ids[index],
                    "note": int(notes[index].item()),
                    "velocity": int(velocities[index].item()),
                    "frames": int(absolute.size),
                    "f0_absolute_median": (float(np.median(absolute))
                                           if absolute.size else None),
                    "f0_absolute_p90": (float(np.quantile(absolute, 0.9))
                                        if absolute.size else None),
                    "periodicity_median": (float(np.median(period)) if period.size else None),
                    "low_periodicity_rate": (float(np.mean(period < 0.5))
                                             if period.size else None),
                })

        cross_medians = branch_pitch["cross"][1]
        for index, median in enumerate(cross_medians):
            if median is None or note_a[index] == note_b[index]:
                continue
            source_offset = 100.0 * float((note_b[index] - note_a[index]).item())
            metrics.add("midi_swap_following", float(abs(median) < abs(median + source_offset)))

        target_delta = (batch["velocity_reference_rms_db_b"]
                        - batch["velocity_reference_rms_db_a"])
        prediction_delta = rms_db(cross_audio, valid_b) - rms_db(self_audio, valid_a)
        velocity_mask = (note_a.eq(note_b)
                         & batch["velocity_a"][:current].ne(batch["velocity_b"][:current])
                         & batch.get("velocity_known_a", torch.ones_like(note_a, dtype=torch.bool))[:current]
                         & batch.get("velocity_known_b", torch.ones_like(note_b, dtype=torch.bool))[:current]
                         & target_delta.abs().ge(config.loss.velocity_margin_db))
        if velocity_mask.any():
            direction = torch.sign(target_delta[velocity_mask])
            directed = direction * prediction_delta[velocity_mask]
            metrics.add("velocity_direction_accuracy", directed.gt(0).float())
            metrics.add("velocity_margin_accuracy",
                        directed.ge(config.loss.velocity_margin_db).float())
            metrics.add("velocity_delta_error_db",
                        (prediction_delta[velocity_mask] - target_delta[velocity_mask]).abs())

        metrics.add("same_preset_timbre_cosine", F.cosine_similarity(
            result.timbre[:current], result.target_timbre[:current], dim=-1))
        metrics.add("pitch_adversary_accuracy", result.pitch_logits[:current].argmax(-1)
                    .eq(note_a).float())
        timbre_a.append(result.timbre[:current].float().cpu())
        timbre_b.append(result.target_timbre[:current].float().cpu())
        preset_ids.extend(raw_batch["preset_id"][:current])
        saved = save_examples(example_root, saved, batch, self_audio, cross_audio,
                              config.data.sample_rate, examples)
        evaluated += current

    targeted_velocity = 0
    if velocity_pairs > 0:
        # One validation traversal contains fewer than 64 pairs whose rendered
        # loudness difference exceeds the 1 dB validity margin.  Extend only
        # this deterministic pair stream; the main 128/256-pair contract above
        # remains unchanged.  Higher indices use new deterministic RNG seeds.
        velocity_dataset = PairDataset(
            replace(data_config, repeats=max(4, data_config.repeats)),
            config.seed + 991,
        )
        velocity_indices = list(range(
            2, len(velocity_dataset), len(PairDataset.PAIR_SEQUENCE)))
        velocity_loader = DataLoader(
            Subset(velocity_dataset, velocity_indices), batch_size=batch_size, shuffle=False,
            num_workers=2, pin_memory=True, persistent_workers=True)
        for raw_batch in velocity_loader:
            if targeted_velocity >= velocity_pairs:
                break
            batch = move_batch(raw_batch, device)
            with torch.autocast("cuda", dtype=torch.float16):
                result = model(
                    batch["clap_a"], batch["note_a"], batch["velocity_a"],
                    batch["note_b"], batch["velocity_b"], batch["clap_b"], grl_scale=0.0,
                    source_excitation_seed=batch.get("excitation_seed_a"),
                    target_excitation_seed=batch.get("excitation_seed_b"))
            target_delta = (batch["velocity_reference_rms_db_b"]
                            - batch["velocity_reference_rms_db_a"])
            prediction_delta = (rms_db(result.cross_audio, batch.get("valid_samples_b"))
                                - rms_db(result.self_audio, batch.get("valid_samples_a")))
            active = (batch["note_a"].eq(batch["note_b"])
                      & batch["velocity_a"].ne(batch["velocity_b"])
                      & batch.get("velocity_known_a", torch.ones_like(
                          batch["note_a"], dtype=torch.bool))
                      & batch.get("velocity_known_b", torch.ones_like(
                          batch["note_b"], dtype=torch.bool))
                      & target_delta.abs().ge(config.loss.velocity_margin_db))
            active_indices = torch.nonzero(active, as_tuple=False).flatten()
            remaining = velocity_pairs - targeted_velocity
            active_indices = active_indices[:remaining]
            if active_indices.numel():
                direction = torch.sign(target_delta.index_select(0, active_indices))
                target = target_delta.index_select(0, active_indices)
                prediction = prediction_delta.index_select(0, active_indices)
                directed = direction * prediction
                metrics.add("targeted_velocity_direction_accuracy", directed.gt(0).float())
                metrics.add("targeted_velocity_margin_accuracy",
                            directed.ge(config.loss.velocity_margin_db).float())
                metrics.add("targeted_velocity_delta_error_db", (prediction - target).abs())
                targeted_velocity += int(active_indices.numel())

    left = F.normalize(torch.cat(timbre_a), dim=-1)
    right = F.normalize(torch.cat(timbre_b), dim=-1)
    nearest = (left @ right.T).argmax(dim=-1)
    retrieval = [float(preset_ids[index] == preset_ids[candidate])
                 for index, candidate in enumerate(nearest.tolist())]
    metrics.add("timbre_preset_retrieval_at_1", retrieval)
    grid = generate_grid(model, dataset, config, output / "midi_grid", grid_presets)
    report = {
        "schema": 2,
        "config": str(Path(config_path).resolve()),
        "checkpoint": str(Path(checkpoint_path).resolve()),
        "checkpoint_phase": int(checkpoint["phase"]),
        "checkpoint_generator_updates": int(checkpoint["generator_updates"]),
        "evaluated_pairs": evaluated,
        "targeted_velocity_pairs": targeted_velocity,
        "metrics": metrics.summary(),
        "listening_examples": saved,
        "midi_grid": grid,
        "notes": {
            "upper_band_energy_error_db": "high-frequency reconstruction proxy, not a direct alias detector",
            "click_rate": "derivative outliers relative to each target waveform's robust threshold",
            "f0": "generated self+cross frames are unconditional; target_f0 is the matched evaluator control",
            "velocity": "target delta uses complete-render RMS because crop offsets are not model inputs",
        },
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "metrics.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (output / "pitch_diagnostics.jsonl").write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in pitch_rows),
        encoding="utf-8")
    print(json.dumps(report, sort_keys=True))
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--pairs", type=int, default=256)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--examples", type=int, default=24)
    parser.add_argument("--grid-presets", type=int, default=6)
    parser.add_argument("--velocity-pairs", type=int, default=64)
    args = parser.parse_args()
    evaluate(args.config, args.checkpoint, args.output, args.pairs,
             args.batch_size, args.examples, args.grid_presets, args.velocity_pairs)


if __name__ == "__main__":
    main()
