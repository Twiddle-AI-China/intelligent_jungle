from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import soundfile as sf

from .config import Config
from .data import (SampleRecord, assign_splits, cache_audio_regions,
                   cache_clap_embeddings, cache_pitch_features, finalize_cache_manifest,
                   load_manifest, prepare_serum_manifests, validate_manifest,
                   write_manifest)
from .selection import run_selection


def create_fixture(root: str | Path, sample_rate: int = 44100,
                   samples: int = 65536) -> Path:
    root = Path(root).resolve()
    audio_root = root / "audio"
    clap_root = root / "cache" / "clap"
    pitch_root = root / "cache" / "pitch"
    audio_root.mkdir(parents=True, exist_ok=True)
    clap_root.mkdir(parents=True, exist_ok=True)
    pitch_root.mkdir(parents=True, exist_ok=True)
    records = []
    notes = (36, 48, 60, 71)
    velocities = (50, 127)
    for preset_index in range(4):
        rng = np.random.default_rng(1000 + preset_index)
        clap = rng.standard_normal(512).astype(np.float32)
        clap /= np.linalg.norm(clap)
        for note in notes:
            for velocity in velocities:
                sample_id = f"fixture-p{preset_index:02d}-n{note:03d}-v{velocity:03d}"
                time = np.arange(samples, dtype=np.float64) / sample_rate
                frequency = 440.0 * 2 ** ((note - 69) / 12)
                phase = 0.17 * preset_index
                audio = sum((0.8 / harmonic) * np.sin(2 * np.pi * frequency * harmonic * time + phase)
                            for harmonic in range(1, 5 + preset_index))
                audio *= 0.35 * velocity / 127
                audio = np.tanh(audio).astype(np.float32)
                audio_path = audio_root / f"{sample_id}.wav"
                sf.write(audio_path, audio, sample_rate, subtype="FLOAT")
                np.save(clap_root / f"{sample_id}.npy", clap)
                pitch_frames = samples // 128
                np.savez(
                    pitch_root / f"{sample_id}.npz",
                    f0=np.full(pitch_frames, frequency, dtype=np.float32),
                    periodicity=np.ones(pitch_frames, dtype=np.float32),
                    valid=np.ones(pitch_frames, dtype=np.bool_),
                    stable_intervals=np.asarray([[0, samples]], dtype=np.int64),
                    hop_length=np.int64(128),
                    frame_rms=np.full(pitch_frames, np.sqrt(np.mean(audio * audio)), dtype=np.float32),
                )
                records.append(SampleRecord(
                    sample_id=sample_id,
                    audio_path=str(audio_path.relative_to(root)),
                    source_id="serum-fixture",
                    preset_id=f"preset-{preset_index:02d}",
                    articulation_id="sustain",
                    midi_note=note,
                    midi_note_sent=note,
                    transpose_semitones=0,
                    velocity=velocity,
                    sample_rate=sample_rate,
                    num_samples=samples,
                    duration_seconds=samples / sample_rate,
                    a4_tuning_hz=440.0,
                    render_or_recording="render",
                    render_gain_db=0.0,
                    median_cents_error=0.0,
                    split="train",
                ))
    manifest = root / "samples.jsonl"
    write_manifest(manifest, records)
    cache_audio_regions(manifest, root / "cache", samples)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(prog="midibrave")
    subparsers = parser.add_subparsers(dest="command", required=True)
    fixture = subparsers.add_parser("fixture")
    fixture.add_argument("--root", default="fixtures/generated")
    fixture.add_argument("--samples", type=int, default=65536)
    split = subparsers.add_parser("split")
    split.add_argument("manifest")
    split.add_argument("output")
    split.add_argument("--seed", type=int, default=20260716)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--config", required=True)
    preprocess = subparsers.add_parser("preprocess")
    preprocess.add_argument("--config", required=True)
    preprocess.add_argument("--stage", choices=("audio", "clap", "pitch", "all"), default="all")
    preprocess.add_argument("--device", default="cuda")
    preprocess.add_argument("--shard-index", type=int, default=0)
    preprocess.add_argument("--shard-count", type=int, default=1)
    preprocess.add_argument(
        "--clap-checkpoint",
        default=None,
    )
    prepare = subparsers.add_parser("prepare-serum")
    prepare.add_argument("--dataset-root", required=True)
    prepare.add_argument("--output", default="/data/midibrave/manifests")
    prepare.add_argument("--seed", type=int, default=20260716)
    finalize = subparsers.add_parser("finalize-cache")
    finalize.add_argument("--config", required=True)
    finalize.add_argument("--output-manifest", required=True)
    finalize.add_argument("--output-metadata")
    select = subparsers.add_parser("select-timbres")
    select.add_argument("--config", required=True)
    select.add_argument("--stage", choices=("inventory", "clap", "assign", "all"),
                        default="all")
    select.add_argument("--device", default="cuda")
    args = parser.parse_args()
    if args.command == "fixture":
        print(json.dumps({"manifest": str(create_fixture(args.root, samples=args.samples))}))
    elif args.command == "split":
        records = assign_splits(load_manifest(args.manifest), args.seed)
        write_manifest(args.output, records)
        print(json.dumps({"records": len(records), "output": str(Path(args.output).resolve())}))
    elif args.command == "validate":
        config = Config.load(args.config)
        print(json.dumps(validate_manifest(load_manifest(config.data.manifest), config.data,
                                           config.data.manifest), sort_keys=True))
    elif args.command == "prepare-serum":
        print(json.dumps(prepare_serum_manifests(
            args.dataset_root, args.output, args.seed), ensure_ascii=False, sort_keys=True))
    elif args.command == "finalize-cache":
        config = Config.load(args.config)
        print(json.dumps(finalize_cache_manifest(
            config.data.manifest, config.data, args.output_manifest,
            args.output_metadata), ensure_ascii=False, sort_keys=True))
    elif args.command == "select-timbres":
        print(json.dumps(run_selection(args.config, args.stage, args.device),
                         ensure_ascii=False, sort_keys=True))
    else:
        config = Config.load(args.config)
        result = {}
        root = config.data.dataset_roots or config.data.dataset_root
        if args.stage in {"audio", "all"}:
            result["audio"] = cache_audio_regions(config.data.manifest, config.data.cache_root,
                                                   config.data.window_samples, root,
                                                   args.shard_index, args.shard_count)
        if args.stage in {"clap", "all"}:
            clap_checkpoint = args.clap_checkpoint or config.data.clap_checkpoint
            if not clap_checkpoint:
                raise ValueError("CLAP preprocessing requires data.clap_checkpoint or --clap-checkpoint")
            result["clap"] = cache_clap_embeddings(config.data.manifest, config.data.cache_root,
                                                    clap_checkpoint, args.device, root,
                                                    args.shard_index, args.shard_count)
        if args.stage in {"pitch", "all"}:
            result["pitch"] = cache_pitch_features(config.data.manifest, config.data.cache_root,
                                                    args.device, config.data, root,
                                                    args.shard_index, args.shard_count)
        print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
