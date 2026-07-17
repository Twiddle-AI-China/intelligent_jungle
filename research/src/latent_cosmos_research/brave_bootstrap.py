"""Copy a trained BRAVE baseline into the isomorphic conditioned decoder."""
from __future__ import annotations

from pathlib import Path

import torch


def conditioned_key_for_brave(key: str, stages: int = 4) -> str | None:
    if not key.startswith("decoder."):
        return key
    if key.startswith("decoder.net.0."):
        return key.replace("decoder.net.0.", "decoder.generator.initial.", 1)
    for index in range(stages):
        upsample = f"decoder.net.{1 + 2 * index}."
        residual = f"decoder.net.{2 + 2 * index}."
        if key.startswith(upsample):
            return key.replace(
                upsample, f"decoder.generator.stages.{index}.upsample.", 1
            )
        if key.startswith(residual):
            return key.replace(
                residual, f"decoder.generator.stages.{index}.residual.", 1
            )
    if key.startswith("decoder.synth."):
        return key.replace("decoder.synth.", "decoder.generator.synth.", 1)
    return None


def bootstrap_from_brave(model: torch.nn.Module, checkpoint_path: str | Path) -> dict[str, int]:
    """Load all shape-compatible base weights and remap the decoder hierarchy."""
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    source = checkpoint.get("state_dict", checkpoint)
    target = model.state_dict()
    copied: dict[str, torch.Tensor] = {}
    skipped = 0
    for source_key, value in source.items():
        target_key = conditioned_key_for_brave(source_key)
        if target_key is None or target_key not in target or target[target_key].shape != value.shape:
            skipped += 1
            continue
        copied[target_key] = value
    result = model.load_state_dict(copied, strict=False)
    decoder_copied = sum(key.startswith("decoder.generator") for key in copied)
    if decoder_copied == 0:
        raise RuntimeError("BRAVE bootstrap copied no decoder weights")
    return {
        "source_tensors": len(source),
        "copied_tensors": len(copied),
        "decoder_tensors": decoder_copied,
        "skipped_source_tensors": skipped,
        "new_conditioning_tensors": sum(
            "film" in key or "condition_downsamplers" in key for key in result.missing_keys
        ),
        "missing_target_tensors": len(result.missing_keys),
        "unexpected_tensors": len(result.unexpected_keys),
    }
