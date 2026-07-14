from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np

from .descriptors import describe


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _mono(array: np.ndarray) -> np.ndarray:
    audio = np.asarray(array, dtype=np.float32)
    return audio.mean(axis=1) if audio.ndim == 2 else audio


def _write(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, np.clip(np.asarray(audio).squeeze(), -1, 1), sample_rate, subtype="PCM_16")


def probe(model_path: Path, inputs: list[Path], output: Path, seconds: float, traversal_dimensions: int) -> dict:
    import librosa
    import soundfile as sf
    import torch

    torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
    model = torch.jit.load(str(model_path), map_location="cpu").eval()
    sample_rate = int(model.sr[0] if hasattr(model.sr, "__len__") else model.sr)
    latent_size = int(model.latent_size)
    output.mkdir(parents=True, exist_ok=True)
    renders: list[dict] = []
    latent_examples = []

    with torch.inference_mode():
        for input_path in inputs:
            audio, source_rate = sf.read(input_path, always_2d=False)
            audio = _mono(audio)
            if source_rate != sample_rate:
                audio = librosa.resample(audio, orig_sr=source_rate, target_sr=sample_rate)
            required = int(seconds * sample_rate)
            if len(audio) < required:
                audio = np.pad(audio, (0, required - len(audio)))
            audio = audio[:required]
            tensor = torch.from_numpy(audio).float()[None, None]
            latent = model.encode(tensor)
            latent_examples.append(latent)

            torch.manual_seed(20260714)
            started = time.perf_counter()
            reconstructed = model.decode(latent).detach().cpu().numpy().squeeze()
            elapsed = time.perf_counter() - started
            name = input_path.stem
            reconstruction_path = output / f"{name}_reconstruction.wav"
            _write(reconstruction_path, reconstructed, sample_rate)
            renders.append({
                "kind": "reconstruction",
                "source": str(input_path),
                "file": reconstruction_path.name,
                "seconds": len(reconstructed) / sample_rate,
                "decode_seconds": elapsed,
                "rtf": elapsed / max(len(reconstructed) / sample_rate, 1e-9),
                "descriptors": describe(reconstructed, sample_rate),
            })

        anchor = latent_examples[0]
        steps = (-1.0, -0.5, 0.0, 0.5, 1.0)
        for dimension in range(min(traversal_dimensions, latent_size)):
            scale = max(float(anchor[:, dimension].std()), 0.25)
            for step in steps:
                moved = anchor.clone()
                moved[:, dimension] += step * scale
                torch.manual_seed(20260714)
                decoded = model.decode(moved).detach().cpu().numpy().squeeze()
                path = output / f"latent_{dimension:02d}_{step:+.1f}.wav"
                _write(path, decoded, sample_rate)
                renders.append({
                    "kind": "traversal",
                    "dimension": dimension,
                    "step": step,
                    "file": path.name,
                    "descriptors": describe(decoded, sample_rate),
                })

        voice_pairs = []
        pair_dimensions = max(1, min(traversal_dimensions, latent_size))
        for voice in range(6):
            source_index = voice % len(latent_examples)
            dimension = (voice // len(latent_examples)) % pair_dimensions
            voice_anchor = latent_examples[source_index]
            scale = max(float(voice_anchor[:, dimension].std()), 0.25)
            pair = {}
            for label, step in (("low", -1.0), ("high", 1.0)):
                moved = voice_anchor.clone()
                moved[:, dimension] += step * scale
                torch.manual_seed(20260714)
                decoded = model.decode(moved).detach().cpu().numpy().squeeze()
                path = output / f"voice_{voice:02d}_{label}.wav"
                _write(path, decoded, sample_rate)
                descriptors = describe(decoded, sample_rate)
                renders.append({
                    "kind": "voice_texture",
                    "voice": voice,
                    "source": str(inputs[source_index]),
                    "dimension": dimension,
                    "step": step,
                    "file": path.name,
                    "descriptors": descriptors,
                })
                pair[label] = path.name
            voice_pairs.append({
                "voice": voice,
                "source": str(inputs[source_index].resolve()),
                "dimension": dimension,
                **pair,
            })

        torch.manual_seed(4242)
        repeat_a = model.decode(anchor).detach().cpu().numpy()
        torch.manual_seed(4242)
        repeat_b = model.decode(anchor).detach().cpu().numpy()
        repeat_error = float(np.max(np.abs(repeat_a - repeat_b)))

    invalid = [item["file"] for item in renders if not item["descriptors"].get("valid")]
    report = {
        "schema": 1,
        "model": str(model_path.resolve()),
        "model_sha256": file_sha256(model_path),
        "sample_rate": sample_rate,
        "latent_size": latent_size,
        "inputs": [str(path.resolve()) for path in inputs],
        "repeat_max_abs_error_with_fixed_seed": repeat_error,
        "invalid_renders": invalid,
        "renders": renders,
        "claims": {
            "export_loaded": True,
            "automated_render_safety_passed": not invalid and repeat_error < 1e-6,
            "listening_gate_passed": False,
            "semantic_directions_named": False,
        },
    }
    (output / "probe-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    texture_files = [name for pair in voice_pairs for name in (pair["low"], pair["high"])]
    manifest = {
        "schema": 1,
        "engine": "brave-latent-texture-bank",
        "model_sha256": report["model_sha256"],
        "sample_rate": sample_rate,
        "files": texture_files,
        "voices": voice_pairs,
        "automated_render_safety_passed": report["claims"]["automated_render_safety_passed"],
        "listening_gate_passed": False,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Render deterministic reconstructions and latent traversals from an exported RAVE/BRAVE model.")
    parser.add_argument("model", type=Path)
    parser.add_argument("inputs", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=8.0)
    parser.add_argument("--dimensions", type=int, default=4)
    args = parser.parse_args()
    report = probe(args.model, args.inputs, args.output, args.seconds, args.dimensions)
    print(json.dumps({key: report[key] for key in ("model_sha256", "sample_rate", "latent_size", "repeat_max_abs_error_with_fixed_seed", "invalid_renders", "claims")}, indent=2))
    if not report["claims"]["automated_render_safety_passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
