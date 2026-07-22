from __future__ import annotations

import hashlib
import json
import math
import random
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly
from torch.utils.data import Dataset

from .config import DataConfig


REQUIRED_FIELDS = {
    "sample_id",
    "audio_path",
    "source_id",
    "midi_note",
    "velocity",
    "sample_rate",
    "num_samples",
    "duration_seconds",
    "a4_tuning_hz",
    "render_or_recording",
}


@dataclass(frozen=True)
class SampleRecord:
    sample_id: str
    audio_path: str
    source_id: str
    preset_id: str
    articulation_id: str
    midi_note: int
    midi_note_sent: int | None
    transpose_semitones: int | None
    velocity: int
    sample_rate: int
    num_samples: int
    duration_seconds: float
    a4_tuning_hz: float
    render_or_recording: str
    render_gain_db: float
    median_cents_error: float | None = None
    split: str | None = None
    dataset_id: str | None = None
    timbre_id: str | None = None
    class_name: str | None = None
    velocity_known: bool = True
    instrument_id: str | None = None
    label_score: float | None = None
    clap_score: float | None = None
    selection_score: float | None = None

    @property
    def group_id(self) -> str:
        dataset = self.dataset_id or self.source_id
        timbre = self.timbre_id or self.preset_id
        return f"{dataset}|{timbre}|{self.articulation_id}"

    @property
    def cache_id(self) -> str:
        return (f"{self.dataset_id}__{self.sample_id}"
                if self.dataset_id else self.sample_id)


def read_jsonl(path: str | Path) -> list[dict[str, Any]]:
    path = Path(path)
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{line_number}: expected object")
            missing = REQUIRED_FIELDS - value.keys()
            if missing:
                raise ValueError(f"{path}:{line_number}: missing {sorted(missing)}")
            rows.append(value)
    if not rows:
        raise ValueError(f"empty manifest: {path}")
    return rows


def load_manifest(path: str | Path) -> list[SampleRecord]:
    records: list[SampleRecord] = []
    seen: set[str] = set()
    for row in read_jsonl(path):
        normalized = dict(row)
        normalized.setdefault("dataset_id", None)
        normalized.setdefault("timbre_id", normalized.get("preset_id") or normalized.get("instrument_id"))
        normalized.setdefault("preset_id", normalized.get("instrument_id") or normalized.get("timbre_id"))
        normalized.setdefault("instrument_id", None)
        normalized.setdefault("articulation_id", "default")
        normalized.setdefault("midi_note_sent", None)
        normalized.setdefault("transpose_semitones", None)
        normalized.setdefault("render_gain_db", 0.0)
        normalized.setdefault("velocity_known", True)
        record = SampleRecord(**{
            key: normalized.get(key) for key in SampleRecord.__dataclass_fields__
        })
        if record.sample_id in seen:
            raise ValueError(f"duplicate sample_id: {record.sample_id}")
        seen.add(record.sample_id)
        records.append(record)
    return records


def dataset_root(cfg: DataConfig, manifest_path: str | Path) -> Path:
    """Resolve audio paths independently from the derived manifest location."""
    if cfg.dataset_root:
        return Path(cfg.dataset_root).resolve()
    return Path(manifest_path).resolve().parent


def record_audio_path(record: SampleRecord, root: str | Path | dict[str, str]) -> Path:
    if isinstance(root, dict):
        dataset = record.dataset_id or record.source_id
        if dataset not in root:
            raise KeyError(f"no dataset root configured for {dataset}: {record.sample_id}")
        base = Path(root[dataset]).resolve()
    else:
        base = Path(root).resolve()
    return (base / record.audio_path).resolve()


def configured_roots(cfg: DataConfig, manifest_path: str | Path) -> str | dict[str, str]:
    return cfg.dataset_roots if cfg.dataset_roots else str(dataset_root(cfg, manifest_path))


def stable_split(group_id: str, seed: int) -> str:
    digest = hashlib.sha256(f"{seed}:{group_id}".encode()).digest()
    bucket = int.from_bytes(digest[:8], "big") % 100
    if bucket < 90:
        return "train"
    if bucket < 95:
        return "validation"
    return "test"


def assign_splits(records: Iterable[SampleRecord], seed: int) -> list[SampleRecord]:
    group_splits: dict[str, str] = {}
    output: list[SampleRecord] = []
    for record in records:
        chosen = record.split or stable_split(record.group_id, seed)
        if chosen not in {"train", "validation", "test"}:
            raise ValueError(f"invalid split {chosen}: {record.sample_id}")
        prior = group_splits.setdefault(record.group_id, chosen)
        if prior != chosen:
            raise ValueError(f"preset split leakage: {record.group_id}: {prior} vs {chosen}")
        output.append(SampleRecord(**{**asdict(record), "split": chosen}))
    return output


def write_manifest(path: str | Path, records: Iterable[SampleRecord]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(asdict(record), ensure_ascii=False, sort_keys=True) + "\n")


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _atomic_save_npy(path: Path, value: np.ndarray) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        np.save(handle, value)
    temporary.replace(path)


def _atomic_save_npz(path: Path, **values: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        np.savez(handle, **values)
    temporary.replace(path)


def _valid_clap_cache(path: Path, dimension: int = 512) -> bool:
    try:
        value = np.load(path, allow_pickle=False)
        return value.shape == (dimension,) and np.isfinite(value).all()
    except (OSError, ValueError, EOFError):
        return False


def _pitch_valid_mask(f0: np.ndarray, periodicity: np.ndarray, frame_rms: np.ndarray,
                      record: SampleRecord, cfg: DataConfig) -> np.ndarray:
    frame_db = 20.0 * np.log10(frame_rms.astype(np.float64) + 1e-8)
    threshold_db = max(cfg.pitch_energy_floor_db,
                       float(frame_db.max()) - cfg.pitch_energy_dynamic_range_db)
    target_hz = record.a4_tuning_hz * 2.0 ** ((record.midi_note - 69.0) / 12.0)
    cents = 1200.0 * np.log2((f0.astype(np.float64) + 1e-7) / (target_hz + 1e-7))
    return (np.isfinite(f0) & np.isfinite(periodicity)
            & (periodicity >= cfg.pitch_confidence_min)
            & (np.abs(cents) <= cfg.pitch_cents_tolerance)
            & (frame_db >= threshold_db))


def _eligible_pitch_offset_frames(valid: np.ndarray, cfg: DataConfig,
                                  window_samples: int | None = None) -> np.ndarray:
    window_samples = cfg.window_samples if window_samples is None else int(window_samples)
    window_samples -= window_samples % cfg.pitch_hop_length
    if window_samples <= 0 or cfg.window_samples % cfg.pitch_hop_length:
        raise ValueError("window_samples must be divisible by pitch_hop_length")
    window_frames = window_samples // cfg.pitch_hop_length
    edge_frames = (0 if window_samples < cfg.window_samples else math.ceil(
        cfg.stable_edge_seconds * cfg.sample_rate / cfg.pitch_hop_length))
    first = edge_frames
    last = len(valid) - window_frames - edge_frames
    if last < first:
        return np.empty(0, dtype=np.int64)
    cumulative = np.concatenate((np.zeros(1, dtype=np.int64),
                                 np.cumsum(valid.astype(np.int64))))
    starts = np.arange(first, last + 1, dtype=np.int64)
    valid_counts = cumulative[starts + window_frames] - cumulative[starts]
    minimum = math.ceil(cfg.pitch_window_valid_ratio_min * window_frames)
    return starts[valid_counts >= minimum]


def _pitch_cache_status(path: Path, record: SampleRecord,
                        cfg: DataConfig) -> tuple[bool, bool]:
    try:
        with np.load(path, allow_pickle=False) as pitch:
            required = {"f0", "periodicity", "valid", "stable_intervals",
                        "hop_length", "frame_rms"}
            if not required.issubset(pitch.files):
                return False, False
            if int(pitch["hop_length"]) != cfg.pitch_hop_length:
                return False, False
            f0 = pitch["f0"]
            periodicity = pitch["periodicity"]
            valid = pitch["valid"]
            frame_rms = pitch["frame_rms"]
            if (f0.ndim != 1 or periodicity.shape != f0.shape
                    or valid.shape != f0.shape or frame_rms.shape != f0.shape):
                return False, False
            if (not np.isfinite(f0).all() or not np.isfinite(periodicity).all()
                    or not np.isfinite(frame_rms).all()):
                return False, False
            derived_valid = _pitch_valid_mask(f0, periodicity, frame_rms, record, cfg)
            usable_samples = min(cfg.window_samples, record.num_samples)
            minimum_valid = min(cfg.minimum_valid_samples, cfg.window_samples)
            usable_samples = max(minimum_valid, usable_samples)
            usable_samples = min(usable_samples, record.num_samples)
            return True, bool(len(_eligible_pitch_offset_frames(
                derived_valid, cfg, usable_samples)))
    except (OSError, ValueError, EOFError):
        return False, False


def _supports_all_pair_modes(records: list[SampleRecord]) -> bool:
    has_pitch = has_velocity = has_pitch_velocity = False
    for a in records:
        has_pitch |= any(b.midi_note != a.midi_note and b.velocity == a.velocity
                         for b in records)
        has_velocity |= any(b.midi_note == a.midi_note and b.velocity != a.velocity
                            for b in records)
        has_pitch_velocity |= any(b.midi_note != a.midi_note and b.velocity != a.velocity
                                  for b in records)
    return has_pitch and has_velocity and has_pitch_velocity


def prepare_serum_manifests(dataset: str | Path, output: str | Path,
                            seed: int = 20260716) -> dict[str, Any]:
    """Create immutable training views without changing the published Serum dataset."""
    dataset = Path(dataset).resolve()
    output = Path(output).resolve()
    marker = dataset / "reports" / "FORMAL2000_COMPLETE"
    qa_path = dataset / "reports" / "qa_summary.json"
    source_samples = dataset / "metadata" / "samples.jsonl"
    source_presets = dataset / "metadata" / "presets.jsonl"
    if not marker.is_file():
        raise ValueError(f"missing formal completion marker: {marker}")
    qa = json.loads(qa_path.read_text(encoding="utf-8"))
    if qa.get("passed") is not True:
        raise ValueError("published Serum QA did not pass")
    records = load_manifest(source_samples)
    strict = [record for record in records
              if record.num_samples == 220500
              and math.isclose(record.duration_seconds, 5.0, rel_tol=0.0, abs_tol=1e-9)
              and 36 <= record.midi_note_sent <= 71]
    strict = assign_splits(strict, seed)
    output.mkdir(parents=True, exist_ok=True)
    strict_path = output / "serum_strict_1822.jsonl"
    write_manifest(strict_path, strict)

    preset_rows = [json.loads(line) for line in source_presets.read_text(encoding="utf-8").splitlines()
                   if line.strip()]
    categories = {row["preset_id"]: row.get("category") for row in preset_rows}
    by_preset: dict[str, list[SampleRecord]] = {}
    for record in strict:
        by_preset.setdefault(record.preset_id, []).append(record)
    pools: dict[str, list[str]] = {}
    for preset_id, members in by_preset.items():
        category = categories.get(preset_id)
        if category and _supports_all_pair_modes(members):
            pools.setdefault(category, []).append(preset_id)
    quality_ids: dict[str, str] = {}
    category_selection: dict[str, int] = {}
    for category in sorted(pools):
        ordered = sorted(
            pools[category],
            key=lambda preset_id: hashlib.sha256(
                f"{seed}:quality300:{preset_id}".encode()).digest(),
        )
        if len(ordered) < 50:
            raise ValueError(f"category {category} has only {len(ordered)} complete pair presets")
        for index, preset_id in enumerate(ordered[:50]):
            quality_ids[preset_id] = "train" if index < 45 else (
                "validation" if index < 47 else "test")
        category_selection[category] = 50
    if len(quality_ids) != 300:
        raise ValueError(f"quality subset expected 300 presets, got {len(quality_ids)}")
    quality = [SampleRecord(**{**asdict(record), "split": quality_ids[record.preset_id]})
               for record in strict if record.preset_id in quality_ids]
    quality_path = output / "serum_quality300.jsonl"
    write_manifest(quality_path, quality)

    def summarize(items: list[SampleRecord]) -> dict[str, Any]:
        split_samples: dict[str, int] = {}
        split_presets: dict[str, set[str]] = {}
        for item in items:
            split = item.split or "unset"
            split_samples[split] = split_samples.get(split, 0) + 1
            split_presets.setdefault(split, set()).add(item.preset_id)
        return {
            "samples": len(items),
            "presets": len({item.preset_id for item in items}),
            "note_min": min(item.midi_note for item in items),
            "note_max": max(item.midi_note for item in items),
            "split_samples": split_samples,
            "split_presets": {key: len(value) for key, value in split_presets.items()},
        }

    provenance = {
        "schema": 1,
        "profile": "strict-5s-sent36-71",
        "seed": seed,
        "dataset_root": str(dataset),
        "source_samples": str(source_samples),
        "source_samples_sha256": sha256_file(source_samples),
        "source_presets_sha256": sha256_file(source_presets),
        "qa_summary_sha256": sha256_file(qa_path),
        "filter": {"num_samples": 220500, "duration_seconds": 5.0,
                   "midi_note_sent_min": 36, "midi_note_sent_max": 71},
        "strict": summarize(strict),
        "quality300": {**summarize(quality), "category_selection": category_selection},
    }
    strict_meta = output / "serum_strict_1822.meta.json"
    quality_meta = output / "serum_quality300.meta.json"
    strict_meta.write_text(json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True)
                           + "\n", encoding="utf-8")
    quality_meta.write_text(json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True)
                            + "\n", encoding="utf-8")
    return {"strict_manifest": str(strict_path), "quality_manifest": str(quality_path),
            **provenance}


def validate_manifest(records: list[SampleRecord], cfg: DataConfig, manifest_path: str | Path) -> dict[str, Any]:
    root = configured_roots(cfg, manifest_path)
    cache_root = Path(cfg.cache_root)
    by_group: dict[str, list[SampleRecord]] = {}
    errors: list[str] = []
    if cfg.manifest_metadata:
        metadata_path = Path(cfg.manifest_metadata)
        if not metadata_path.is_file():
            errors.append(f"missing manifest metadata: {metadata_path}")
        else:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            expected_manifest_hash = metadata.get("eligible_manifest_sha256")
            if (expected_manifest_hash is not None
                    and expected_manifest_hash != sha256_file(manifest_path)):
                errors.append("eligible manifest hash does not match manifest metadata")
    for record in records:
        by_group.setdefault(record.group_id, []).append(record)
        audio = record_audio_path(record, root)
        if not audio.is_file():
            errors.append(f"missing audio: {record.sample_id}: {audio}")
        else:
            info = sf.info(audio)
            if info.samplerate != record.sample_rate or info.channels != 1:
                errors.append(f"audio format: {record.sample_id}: {info.samplerate} Hz/{info.channels}ch")
            if info.frames != record.num_samples:
                errors.append(f"audio length: {record.sample_id}: {info.frames} != {record.num_samples}")
        if record.sample_rate != cfg.sample_rate:
            errors.append(f"sample rate: {record.sample_id}: {record.sample_rate}")
        if not cfg.note_min <= record.midi_note <= cfg.note_max:
            errors.append(f"note range: {record.sample_id}: {record.midi_note}")
        if cfg.velocities and record.velocity not in cfg.velocities:
            errors.append(f"velocity: {record.sample_id}: {record.velocity}")
        if record.midi_note_sent is not None and not 0 <= record.midi_note_sent <= 127:
            errors.append(f"sent MIDI range: {record.sample_id}: {record.midi_note_sent}")
        if (record.midi_note_sent is not None and record.transpose_semitones is not None
                and record.transpose_semitones != record.midi_note - record.midi_note_sent):
            errors.append(
                f"transpose: {record.sample_id}: {record.transpose_semitones} != "
                f"{record.midi_note} - {record.midi_note_sent}"
            )
        expected_seconds = record.num_samples / record.sample_rate
        if not math.isclose(record.duration_seconds, expected_seconds, rel_tol=0.0, abs_tol=1e-5):
            errors.append(
                f"duration: {record.sample_id}: {record.duration_seconds} != {expected_seconds}"
            )
        if cfg.require_pitch_cache:
            pitch_path = cache_root / "pitch" / f"{record.cache_id}.npz"
            clap_path = cache_root / "clap" / f"{record.cache_id}.npy"
            if not clap_path.is_file():
                errors.append(f"missing CLAP cache: {record.sample_id}")
            elif not _valid_clap_cache(clap_path):
                errors.append(f"invalid CLAP cache: {record.sample_id}")
            if not pitch_path.is_file():
                errors.append(f"missing pitch cache: {record.sample_id}")
            else:
                structurally_valid, has_eligible_window = _pitch_cache_status(
                    pitch_path, record, cfg)
                if not structurally_valid:
                    errors.append(f"invalid pitch cache: {record.sample_id}")
                elif not has_eligible_window:
                    errors.append(f"no eligible pitch-supported window: {record.sample_id}")
    coverage: list[dict[str, int]] = []
    for group, members in by_group.items():
        notes = {item.midi_note for item in members}
        if len(notes) < cfg.minimum_distinct_notes_per_preset:
            errors.append(
                f"insufficient pitch coverage: {group}: {len(notes)} < "
                f"{cfg.minimum_distinct_notes_per_preset}"
            )
        if not any(a.midi_note != b.midi_note for a in members for b in members):
            errors.append(f"missing pitch pair coverage: {group}")
        coverage.append({
            "samples": len(members),
            "distinct_notes": len(notes),
            "conditions": len({(item.midi_note, item.velocity) for item in members}),
        })
    if errors:
        raise ValueError("manifest validation failed:\n" + "\n".join(errors[:100]))
    return {
        "samples": len(records),
        "presets": len(by_group),
        "coverage": {
            "samples_per_preset_min": min(item["samples"] for item in coverage),
            "samples_per_preset_max": max(item["samples"] for item in coverage),
            "distinct_notes_min": min(item["distinct_notes"] for item in coverage),
            "distinct_notes_max": max(item["distinct_notes"] for item in coverage),
            "duplicate_final_conditions": sum(
                item["samples"] - item["conditions"] for item in coverage),
        },
        "notes": sorted({r.midi_note for r in records}),
        "sent_notes": sorted({r.midi_note_sent for r in records}),
        "velocities": sorted({r.velocity for r in records}),
    }


def load_audio(path: Path, expected_sr: int) -> np.ndarray:
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    if sr != expected_sr:
        raise ValueError(f"expected {expected_sr} Hz, got {sr}: {path}")
    if audio.shape[1] != 1:
        raise ValueError(f"expected mono audio: {path}")
    waveform = audio[:, 0]
    if not np.isfinite(waveform).all():
        raise ValueError(f"non-finite audio: {path}")
    return waveform


def _sharded(records: list[SampleRecord], shard_index: int, shard_count: int) -> list[SampleRecord]:
    if shard_count <= 0 or not 0 <= shard_index < shard_count:
        raise ValueError("shard_index must satisfy 0 <= shard_index < shard_count")
    return [record for index, record in enumerate(records) if index % shard_count == shard_index]


def _cache_progress(stage: str, done: int, total: int, shard_index: int,
                    succeeded: int, existing: int, **extra: int) -> None:
    if done % 500 != 0 and done != total:
        return
    print(json.dumps({
        "event": "cache_progress", "stage": stage, "done": done, "total": total,
        "shard_index": shard_index, "cached": succeeded, "existing": existing,
        **extra,
    }, sort_keys=True), flush=True)


def active_region(audio: np.ndarray, minimum_samples: int, threshold_db: float = -55.0) -> tuple[int, int]:
    frame = 2048
    hop = 512
    if len(audio) < minimum_samples:
        raise ValueError(f"audio shorter than training window: {len(audio)} < {minimum_samples}")
    rms: list[float] = []
    for start in range(0, max(1, len(audio) - frame + 1), hop):
        chunk = audio[start : start + frame]
        rms.append(float(np.sqrt(np.mean(chunk * chunk) + 1e-12)))
    db = 20.0 * np.log10(np.asarray(rms) + 1e-8)
    active = np.flatnonzero(db >= threshold_db)
    if not len(active):
        raise ValueError("no active audio")
    start = max(0, int(active[0] * hop))
    end = min(len(audio), int(active[-1] * hop + frame))
    if end - start < minimum_samples:
        center = (start + end) // 2
        start = max(0, center - minimum_samples // 2)
        end = start + minimum_samples
        if end > len(audio):
            end = len(audio)
            start = end - minimum_samples
    return start, end


def cache_audio_regions(manifest: str | Path, cache_root: str | Path, window_samples: int,
                        root: str | Path | dict[str, str] | None = None, shard_index: int = 0,
                        shard_count: int = 1) -> dict[str, int]:
    manifest = Path(manifest).resolve()
    root = root if isinstance(root, dict) else (Path(root).resolve() if root is not None else manifest.parent)
    output = Path(cache_root) / "audio"
    output.mkdir(parents=True, exist_ok=True)
    succeeded = 0
    existing = 0
    records = _sharded(load_manifest(manifest), shard_index, shard_count)
    for record_index, record in enumerate(records, 1):
        destination = output / f"{record.cache_id}.npz"
        try:
            with np.load(destination, allow_pickle=False) as cached:
                if {"start", "end", "peak"}.issubset(cached.files):
                    existing += 1
                    continue
        except (OSError, ValueError, EOFError):
            pass
        audio = load_audio(record_audio_path(record, root), record.sample_rate)
        start, end = active_region(audio, min(window_samples, len(audio)))
        _atomic_save_npz(
            destination, start=start, end=end, peak=float(np.max(np.abs(audio))))
        succeeded += 1
        _cache_progress("audio", record_index, len(records), shard_index,
                        succeeded, existing)
    return {"cached": succeeded, "existing": existing,
            "shard_index": shard_index, "shard_count": shard_count}


def cache_clap_embeddings(
    manifest: str | Path,
    cache_root: str | Path,
    checkpoint: str | Path,
    device: str,
    root: str | Path | dict[str, str] | None = None,
    shard_index: int = 0,
    shard_count: int = 1,
) -> dict[str, int]:
    import laion_clap

    manifest = Path(manifest).resolve()
    root = root if isinstance(root, dict) else (Path(root).resolve() if root is not None else manifest.parent)
    output = Path(cache_root) / "clap"
    output.mkdir(parents=True, exist_ok=True)
    model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base", device=device)
    model.load_ckpt(str(checkpoint))
    model.eval()
    succeeded = 0
    existing = 0
    records = _sharded(load_manifest(manifest), shard_index, shard_count)
    for record_index, record in enumerate(records, 1):
        destination = output / f"{record.cache_id}.npy"
        if _valid_clap_cache(destination):
            existing += 1
            continue
        audio = load_audio(record_audio_path(record, root), record.sample_rate)
        if record.sample_rate != 48000:
            audio = resample_poly(audio, 160, 147).astype(np.float32)
        tensor = torch.from_numpy(audio).unsqueeze(0).to(device)
        with torch.no_grad():
            embedding = model.get_audio_embedding_from_data(tensor, use_tensor=True)
            embedding = torch.nn.functional.normalize(embedding.float(), dim=-1)
        _atomic_save_npy(destination, embedding[0].cpu().numpy().astype(np.float32))
        succeeded += 1
        _cache_progress("clap", record_index, len(records), shard_index,
                        succeeded, existing)
    return {"cached": succeeded, "existing": existing,
            "shard_index": shard_index, "shard_count": shard_count}


def _frame_rms(audio: np.ndarray, frames: int, hop_length: int, frame_length: int = 2048) -> np.ndarray:
    centers = np.arange(frames, dtype=np.int64) * hop_length
    starts = np.clip(centers - frame_length // 2, 0, len(audio))
    ends = np.clip(centers + frame_length // 2, 0, len(audio))
    cumulative = np.concatenate((np.zeros(1, dtype=np.float64),
                                 np.cumsum(audio.astype(np.float64) ** 2)))
    energy = cumulative[ends] - cumulative[starts]
    return np.sqrt(energy / np.maximum(1, ends - starts) + 1e-12).astype(np.float32)


def _stable_intervals(valid: np.ndarray, hop_length: int, audio_samples: int,
                      edge_samples: int, minimum_samples: int) -> np.ndarray:
    padded = np.pad(valid.astype(np.int8), (1, 1))
    changes = np.flatnonzero(np.diff(padded))
    intervals: list[tuple[int, int]] = []
    for first, last in changes.reshape(-1, 2):
        start = int(first * hop_length + edge_samples)
        end = int(min(audio_samples, last * hop_length) - edge_samples)
        if end - start >= minimum_samples:
            intervals.append((start, end))
    return np.asarray(intervals, dtype=np.int64).reshape(-1, 2)


def cache_pitch_features(manifest: str | Path, cache_root: str | Path, device: str,
                         cfg: DataConfig, root: str | Path | dict[str, str] | None = None,
                         shard_index: int = 0, shard_count: int = 1) -> dict[str, int]:
    import torchcrepe

    manifest = Path(manifest).resolve()
    root = root if isinstance(root, dict) else (Path(root).resolve() if root is not None else manifest.parent)
    output = Path(cache_root) / "pitch"
    output.mkdir(parents=True, exist_ok=True)
    succeeded = 0
    existing = 0
    rejected = 0
    records = _sharded(load_manifest(manifest), shard_index, shard_count)
    for record_index, record in enumerate(records, 1):
        destination = output / f"{record.cache_id}.npz"
        structurally_valid, has_eligible_window = _pitch_cache_status(
            destination, record, cfg)
        if structurally_valid:
            existing += 1
            rejected += int(not has_eligible_window)
            continue
        waveform = load_audio(record_audio_path(record, root), record.sample_rate)
        audio = torch.from_numpy(waveform).view(1, -1)
        pitch, periodicity = torchcrepe.predict(
            audio.to(device), record.sample_rate, cfg.pitch_hop_length, 50.0, 2000.0, "tiny",
            batch_size=1024, device=device, return_periodicity=True,
        )
        pitch_np = pitch[0].detach().cpu().numpy().astype(np.float32)
        periodicity_np = periodicity[0].detach().cpu().numpy().astype(np.float32)
        frame_energy = _frame_rms(waveform, len(pitch_np), cfg.pitch_hop_length)
        frame_db = 20.0 * np.log10(frame_energy + 1e-8)
        threshold_db = max(cfg.pitch_energy_floor_db,
                           float(frame_db.max()) - cfg.pitch_energy_dynamic_range_db)
        target_hz = record.a4_tuning_hz * 2.0 ** ((record.midi_note - 69.0) / 12.0)
        cents = 1200.0 * np.log2((pitch_np + 1e-7) / (target_hz + 1e-7))
        valid = (np.isfinite(pitch_np) & np.isfinite(periodicity_np)
                 & (periodicity_np >= cfg.pitch_confidence_min)
                 & (np.abs(cents) <= cfg.pitch_cents_tolerance)
                 & (frame_db >= threshold_db))
        intervals = _stable_intervals(
            valid, cfg.pitch_hop_length, len(waveform),
            int(round(cfg.stable_edge_seconds * record.sample_rate)), cfg.window_samples,
        )
        _atomic_save_npz(
            destination,
            f0=pitch_np,
            periodicity=periodicity_np,
            valid=valid.astype(np.bool_),
            stable_intervals=intervals,
            hop_length=np.int64(cfg.pitch_hop_length),
            frame_rms=frame_energy,
        )
        succeeded += 1
        rejected += int(not len(_eligible_pitch_offset_frames(valid, cfg)))
        _cache_progress("pitch", record_index, len(records), shard_index,
                        succeeded, existing,
                        without_eligible_pitch_window=rejected)
    return {"cached": succeeded, "existing": existing,
            "without_eligible_pitch_window": rejected,
            "shard_index": shard_index, "shard_count": shard_count}


def finalize_cache_manifest(manifest: str | Path, cfg: DataConfig,
                            output_manifest: str | Path,
                            output_metadata: str | Path | None = None) -> dict[str, Any]:
    """Freeze the subset that has valid CLAP data and a usable stable pitch window."""
    manifest = Path(manifest).resolve()
    # Capture the selected-manifest provenance before output replacement.  The
    # v2 qualification pipeline intentionally freezes cache eligibility back to
    # the same canonical path consumed by training.
    source_manifest_hash = sha256_file(manifest)
    output_manifest = Path(output_manifest).resolve()
    output_metadata = (Path(output_metadata).resolve() if output_metadata is not None
                       else output_manifest.with_suffix(".meta.json"))
    cache_root = Path(cfg.cache_root)
    records = load_manifest(manifest)
    cache_rejections = {
        "missing_clap": 0,
        "invalid_clap": 0,
        "missing_pitch": 0,
        "invalid_pitch": 0,
        "no_eligible_pitch_window": 0,
    }
    cache_eligible: list[SampleRecord] = []
    for record in records:
        clap_path = cache_root / "clap" / f"{record.cache_id}.npy"
        pitch_path = cache_root / "pitch" / f"{record.cache_id}.npz"
        usable = True
        if not clap_path.is_file():
            cache_rejections["missing_clap"] += 1
            usable = False
        elif not _valid_clap_cache(clap_path):
            cache_rejections["invalid_clap"] += 1
            usable = False
        if not pitch_path.is_file():
            cache_rejections["missing_pitch"] += 1
            usable = False
        else:
            structurally_valid, has_eligible_window = _pitch_cache_status(
                pitch_path, record, cfg)
            if not structurally_valid:
                cache_rejections["invalid_pitch"] += 1
                usable = False
            elif not has_eligible_window:
                cache_rejections["no_eligible_pitch_window"] += 1
                usable = False
        if usable:
            cache_eligible.append(record)

    by_group: dict[str, list[SampleRecord]] = {}
    for record in cache_eligible:
        by_group.setdefault(record.group_id, []).append(record)
    retained: list[SampleRecord] = []
    dropped_groups: dict[str, str] = {}
    all_group_ids = {record.group_id for record in records}
    for group_id in sorted(all_group_ids - by_group.keys()):
        dropped_groups[group_id] = "no_cache_eligible_samples"
    for group_id, members in sorted(by_group.items()):
        distinct_notes = len({record.midi_note for record in members})
        if distinct_notes < cfg.minimum_distinct_notes_per_preset:
            dropped_groups[group_id] = "insufficient_distinct_notes"
        elif not any(a.midi_note != b.midi_note for a in members for b in members):
            dropped_groups[group_id] = "missing_pitch_pair"
        else:
            retained.extend(members)
    if not retained:
        raise ValueError("no records remain after cache and pair-coverage eligibility checks")

    output_manifest.parent.mkdir(parents=True, exist_ok=True)
    temporary_manifest = output_manifest.with_suffix(output_manifest.suffix + ".tmp")
    write_manifest(temporary_manifest, retained)
    temporary_manifest.replace(output_manifest)

    split_samples: dict[str, int] = {}
    split_presets: dict[str, set[str]] = {}
    for record in retained:
        split = record.split or "unset"
        split_samples[split] = split_samples.get(split, 0) + 1
        split_presets.setdefault(split, set()).add(record.preset_id)
    retained_id_hash = hashlib.sha256(
        ("\n".join(sorted(record.sample_id for record in retained)) + "\n").encode()
    ).hexdigest()

    def cache_collection_hash(directory: str, suffix: str) -> str:
        digest = hashlib.sha256()
        for record in sorted(retained, key=lambda item: item.sample_id):
            path = cache_root / directory / f"{record.cache_id}{suffix}"
            digest.update(record.cache_id.encode())
            digest.update(b"\0")
            digest.update(sha256_file(path).encode())
            digest.update(b"\n")
        return digest.hexdigest()

    clap_checkpoint_hash = None
    if cfg.clap_checkpoint and Path(cfg.clap_checkpoint).is_file():
        clap_checkpoint_hash = sha256_file(cfg.clap_checkpoint)
    metadata = {
        "schema": 1,
        "source_manifest": str(manifest),
        "source_manifest_sha256": source_manifest_hash,
        "cache_root": str(cache_root.resolve()),
        "clap_contract": {
            "implementation": "laion-clap-1.1.7/HTSAT-base/no-fusion",
            "dimension": 512,
            "checkpoint": cfg.clap_checkpoint,
            "checkpoint_sha256": clap_checkpoint_hash,
        },
        "pitch_contract": {
            "implementation": "torchcrepe-0.0.24/tiny",
            "frequency_min_hz": 50.0,
            "frequency_max_hz": 2000.0,
            "hop_length": cfg.pitch_hop_length,
            "window_samples": cfg.window_samples,
            "confidence_min": cfg.pitch_confidence_min,
            "cents_tolerance": cfg.pitch_cents_tolerance,
            "stable_edge_seconds": cfg.stable_edge_seconds,
            "window_valid_ratio_min": cfg.pitch_window_valid_ratio_min,
            "energy_floor_db": cfg.pitch_energy_floor_db,
            "energy_dynamic_range_db": cfg.pitch_energy_dynamic_range_db,
        },
        "source_samples": len(records),
        "cache_eligible_samples": len(cache_eligible),
        "retained_samples": len(retained),
        "retained_presets": len({record.group_id for record in retained}),
        "split_samples": split_samples,
        "split_presets": {key: len(value) for key, value in split_presets.items()},
        "cache_rejections": cache_rejections,
        "dropped_groups": dropped_groups,
        "retained_sample_ids_sha256": retained_id_hash,
        "eligible_manifest_sha256": sha256_file(output_manifest),
        "clap_cache_collection_sha256": cache_collection_hash("clap", ".npy"),
        "pitch_cache_collection_sha256": cache_collection_hash("pitch", ".npz"),
    }
    output_metadata.parent.mkdir(parents=True, exist_ok=True)
    temporary_metadata = output_metadata.with_suffix(output_metadata.suffix + ".tmp")
    temporary_metadata.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary_metadata.replace(output_metadata)
    return {"manifest": str(output_manifest), "metadata": str(output_metadata), **metadata}


class PairDataset(Dataset[dict[str, Any]]):
    PAIR_SEQUENCE = ("pitch", "pitch", "velocity", "pitch_velocity")

    def __init__(self, cfg: DataConfig, seed: int) -> None:
        self.cfg = cfg
        self.seed = seed
        self.epoch = 0
        self.manifest = Path(cfg.manifest).resolve()
        self.roots = configured_roots(cfg, self.manifest)
        records = assign_splits(load_manifest(self.manifest), seed)
        self.records = [record for record in records if record.split == cfg.split]
        if not self.records:
            raise ValueError(f"no records in split {cfg.split}")
        self.groups: dict[str, list[SampleRecord]] = {}
        for record in self.records:
            self.groups.setdefault(record.group_id, []).append(record)
        self.group_ids = sorted(self.groups)
        self.group_modes: dict[str, dict[str, list[SampleRecord]]] = {}
        for group_id, members in self.groups.items():
            modes = {
                mode: [record for record in members if self._candidates(record, mode)]
                for mode in set(self.PAIR_SEQUENCE)
            }
            if not modes["pitch"] and not modes["pitch_velocity"]:
                raise ValueError(f"group cannot construct a pitch-changing pair: {group_id}")
            self.group_modes[group_id] = modes
        self.cache_root = Path(cfg.cache_root)
        # Worker-local memoization.  The reference covers the complete render,
        # so velocity supervision is a condition-level property and cannot
        # flip merely because A/B were cropped at independent offsets.
        self.velocity_reference_rms_db: dict[str, float] = {}
        self.difficulty_ema: dict[str, float] = {group_id: 0.0 for group_id in self.group_ids}
        self.training_update = 0

    def set_epoch(self, epoch: int) -> None:
        self.epoch = epoch

    def set_training_update(self, update: int) -> None:
        self.training_update = int(update)

    def sampler_state_dict(self) -> dict[str, Any]:
        return {"training_update": self.training_update,
                "difficulty_ema": dict(self.difficulty_ema)}

    def load_sampler_state_dict(self, state: dict[str, Any]) -> None:
        self.training_update = int(state.get("training_update", 0))
        values = state.get("difficulty_ema", {})
        self.difficulty_ema.update({key: float(value) for key, value in values.items()
                                    if key in self.difficulty_ema})

    def __len__(self) -> int:
        return len(self.group_ids) * len(self.PAIR_SEQUENCE) * self.cfg.repeats

    def _candidates(self, a: SampleRecord, mode: str) -> list[SampleRecord]:
        candidates = self.groups[a.group_id]
        if mode == "pitch":
            return [b for b in candidates
                    if b.sample_id != a.sample_id and b.midi_note != a.midi_note
                    and b.velocity == a.velocity]
        if mode == "velocity":
            return [b for b in candidates
                    if b.sample_id != a.sample_id and b.midi_note == a.midi_note
                    and b.velocity != a.velocity and a.velocity_known and b.velocity_known]
        if mode == "pitch_velocity":
            return [b for b in candidates
                    if b.sample_id != a.sample_id and b.midi_note != a.midi_note
                    and b.velocity != a.velocity]
        raise ValueError(f"unknown pair mode: {mode}")

    def _window(self, record: SampleRecord, rng: random.Random) -> dict[str, Any]:
        audio = load_audio(record_audio_path(record, self.roots), self.cfg.sample_rate)
        minimum_valid = min(self.cfg.minimum_valid_samples, self.cfg.window_samples)
        if len(audio) < minimum_valid:
            raise RuntimeError(f"audio shorter than minimum valid region: {record.sample_id}")
        reference_rms_db = self.velocity_reference_rms_db.get(record.cache_id)
        if reference_rms_db is None:
            rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2) + 1e-8))
            reference_rms_db = float(20.0 * np.log10(rms + 1e-7))
            self.velocity_reference_rms_db[record.cache_id] = reference_rms_db
        pitch_file = self.cache_root / "pitch" / f"{record.cache_id}.npz"
        pitch_cache: dict[str, np.ndarray] | None = None
        hop = self.cfg.pitch_hop_length
        if pitch_file.is_file():
            with np.load(pitch_file) as values:
                pitch_cache = {name: values[name].copy() for name in values.files}
            hop = int(pitch_cache["hop_length"])
            if hop != self.cfg.pitch_hop_length:
                raise ValueError(f"pitch hop mismatch: {record.sample_id}: {hop}")
            derived_valid = _pitch_valid_mask(
                pitch_cache["f0"], pitch_cache["periodicity"],
                pitch_cache["frame_rms"], record, self.cfg)
        else:
            if self.cfg.require_pitch_cache:
                raise FileNotFoundError(f"missing pitch cache: {pitch_file}")
            derived_valid = None
        active_start, active_end = active_region(
            audio, min(minimum_valid, len(audio)),
            threshold_db=self.cfg.active_threshold_db,
        )
        maximum_offset = max(0, len(audio) - minimum_valid)
        if rng.random() < self.cfg.onset_crop_probability:
            crop_kind = "onset"
            offset_frame = max(0, min(maximum_offset // hop, active_start // hop))
        else:
            crop_kind = "active"
            first_frame = max(0, math.floor(active_start / hop))
            last_sample = min(maximum_offset, max(active_start, active_end - minimum_valid))
            last_frame = max(first_frame, math.floor(last_sample / hop))
            eligible_offsets = np.empty(0, dtype=np.int64)
            if derived_valid is not None:
                eligible_offsets = _eligible_pitch_offset_frames(derived_valid, self.cfg)
                eligible_offsets = eligible_offsets[(eligible_offsets >= first_frame)
                                                    & (eligible_offsets <= last_frame)]
            if len(eligible_offsets):
                offset_frame = int(eligible_offsets[rng.randrange(len(eligible_offsets))])
            else:
                offset_frame = (first_frame if first_frame == last_frame
                                else rng.randint(first_frame, last_frame))
        offset = offset_frame * hop
        source = audio[offset : offset + self.cfg.window_samples]
        valid_samples = len(source)
        if valid_samples < minimum_valid:
            raise RuntimeError(f"bad valid window length: {record.sample_id}: {valid_samples}")
        window = np.zeros(self.cfg.window_samples, dtype=np.float32)
        window[:valid_samples] = source
        pitch_frames = self.cfg.window_samples // hop
        if pitch_cache is None:
            f0 = np.full(pitch_frames, record.a4_tuning_hz * 2 ** ((record.midi_note - 69) / 12),
                         dtype=np.float32)
            confidence = np.ones(pitch_frames, dtype=np.float32)
            valid = np.ones(pitch_frames, dtype=np.bool_)
        else:
            stop = offset_frame + pitch_frames
            f0 = np.zeros(pitch_frames, dtype=np.float32)
            confidence = np.zeros(pitch_frames, dtype=np.float32)
            valid = np.zeros(pitch_frames, dtype=np.bool_)
            available = max(0, min(pitch_frames, len(pitch_cache["f0"]) - offset_frame))
            if available:
                f0[:available] = pitch_cache["f0"][offset_frame:stop][:available]
                confidence[:available] = pitch_cache["periodicity"][offset_frame:stop][:available]
                valid[:available] = derived_valid[offset_frame:stop][:available]
        valid &= ((np.arange(pitch_frames) + 1) * hop <= valid_samples)
        noise_digest = hashlib.sha256(
            f"{self.seed}:{record.cache_id}:{offset}:{self.epoch}".encode()).digest()
        excitation_seed = int.from_bytes(noise_digest[:8], "big") % (2**63 - 1)
        return {
            "audio": torch.from_numpy(window.copy()).unsqueeze(0),
            "pitch_f0": torch.from_numpy(f0.copy()),
            "pitch_confidence": torch.from_numpy(confidence.copy()),
            "pitch_valid_mask": torch.from_numpy(valid.copy()),
            "crop_offset": torch.tensor(offset, dtype=torch.long),
            "valid_samples": torch.tensor(valid_samples, dtype=torch.long),
            "velocity_reference_rms_db": torch.tensor(reference_rms_db, dtype=torch.float32),
            "crop_kind": crop_kind,
            "excitation_seed": torch.tensor(excitation_seed, dtype=torch.long),
        }

    def _clap(self, record: SampleRecord) -> torch.Tensor:
        path = self.cache_root / "clap" / f"{record.cache_id}.npy"
        if not path.is_file():
            raise FileNotFoundError(f"missing CLAP cache: {path}")
        return torch.from_numpy(np.load(path).astype(np.float32))

    def __getitem__(self, index: int) -> dict[str, Any]:
        rng = random.Random(self.seed + self.epoch * 1_000_003 + index)
        requested_mode = self.PAIR_SEQUENCE[index % len(self.PAIR_SEQUENCE)]
        group_slot = (index // len(self.PAIR_SEQUENCE) + self.epoch * 7919) % len(self.group_ids)
        group_id = self.group_ids[group_slot]
        modes = self.group_modes[group_id]
        mode = requested_mode
        if not modes[mode]:
            mode = next(candidate for candidate in ("pitch", "pitch_velocity", "velocity")
                        if modes[candidate])
        anchors = modes[mode]
        a = anchors[rng.randrange(len(anchors))]
        candidates = self._candidates(a, mode)
        b = candidates[rng.randrange(len(candidates))]
        if rng.random() < 0.5:
            a, b = b, a
        window_a = self._window(a, rng)
        window_b = self._window(b, rng)
        return {
            "audio_a": window_a["audio"],
            "audio_b": window_b["audio"],
            "clap_a": self._clap(a),
            "clap_b": self._clap(b),
            "note_a": torch.tensor(a.midi_note, dtype=torch.long),
            "note_b": torch.tensor(b.midi_note, dtype=torch.long),
            "velocity_a": torch.tensor(a.velocity, dtype=torch.float32),
            "velocity_b": torch.tensor(b.velocity, dtype=torch.float32),
            "pitch_f0_a": window_a["pitch_f0"],
            "pitch_f0_b": window_b["pitch_f0"],
            "pitch_confidence_a": window_a["pitch_confidence"],
            "pitch_confidence_b": window_b["pitch_confidence"],
            "pitch_valid_mask_a": window_a["pitch_valid_mask"],
            "pitch_valid_mask_b": window_b["pitch_valid_mask"],
            "crop_offset_a": window_a["crop_offset"],
            "crop_offset_b": window_b["crop_offset"],
            "valid_samples_a": window_a["valid_samples"],
            "valid_samples_b": window_b["valid_samples"],
            "crop_kind_a": window_a["crop_kind"],
            "crop_kind_b": window_b["crop_kind"],
            "excitation_seed_a": window_a["excitation_seed"],
            "excitation_seed_b": window_b["excitation_seed"],
            "velocity_reference_rms_db_a": window_a["velocity_reference_rms_db"],
            "velocity_reference_rms_db_b": window_b["velocity_reference_rms_db"],
            "velocity_known_a": torch.tensor(a.velocity_known, dtype=torch.bool),
            "velocity_known_b": torch.tensor(b.velocity_known, dtype=torch.bool),
            "sample_id_a": a.sample_id,
            "sample_id_b": b.sample_id,
            "preset_id": a.preset_id,
            "pair_mode": mode,
            "midi_note_sent_a": torch.tensor(-1 if a.midi_note_sent is None else a.midi_note_sent,
                                               dtype=torch.long),
            "midi_note_sent_b": torch.tensor(-1 if b.midi_note_sent is None else b.midi_note_sent,
                                               dtype=torch.long),
            "transpose_semitones_a": torch.tensor(0 if a.transpose_semitones is None else a.transpose_semitones,
                                                    dtype=torch.long),
            "transpose_semitones_b": torch.tensor(0 if b.transpose_semitones is None else b.transpose_semitones,
                                                    dtype=torch.long),
        }


def midi_to_hz(note: torch.Tensor, a4: float = 440.0) -> torch.Tensor:
    return a4 * torch.pow(2.0, (note.float() - 69.0) / 12.0)
