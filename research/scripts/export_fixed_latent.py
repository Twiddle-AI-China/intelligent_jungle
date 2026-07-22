"""Export a variational RAVE/BRAVE with an exact controllable PCA width.

acids-rave 2.3 exposes only a fidelity threshold. This wrapper keeps the
official exporter and model graph, but makes the desired power-of-two width
explicit and restores the checkpoint's real fidelity metadata before export.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import cached_conv as cc
import gin
import torch
import torch.nn as nn

import rave
import rave.blocks
import rave.core
from scripts.export import VariationalScriptedRAVE


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--latent-size", type=int, required=True)
    parser.add_argument("--streaming", action="store_true")
    args = parser.parse_args()
    if args.latent_size < 2 or args.latent_size & (args.latent_size - 1):
        raise SystemExit("--latent-size must be a power of two >= 2")

    cc.use_cached_conv(args.streaming)
    config = rave.core.search_for_config(str(args.run))
    if config is None:
        raise SystemExit(f"No RAVE config found for {args.run}")
    gin.parse_config_file(config)
    checkpoint_path = rave.core.search_for_run(str(args.run))
    pretrained = rave.RAVE()
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    pretrained.load_state_dict(checkpoint["state_dict"], strict=False)
    pretrained.eval()
    if not isinstance(pretrained.encoder, rave.blocks.VariationalEncoder):
        raise SystemExit("exact PCA width is only supported for variational checkpoints")
    if args.latent_size > pretrained.latent_size:
        raise SystemExit(f"requested {args.latent_size}D exceeds full {pretrained.latent_size}D")

    for module in pretrained.modules():
        if hasattr(module, "weight_g"):
            nn.utils.remove_weight_norm(module)

    real_fidelity = pretrained.fidelity.detach().clone()
    synthetic = torch.zeros_like(pretrained.fidelity)
    # The upstream exporter rounds the first threshold-crossing index upward
    # to a power of two. N/2+1 therefore resolves exactly to N.
    synthetic[args.latent_size // 2 + 1 :] = 1
    pretrained.fidelity.copy_(synthetic)
    scripted = VariationalScriptedRAVE(pretrained=pretrained, fidelity=0.5)
    scripted.fidelity.copy_(real_fidelity)
    if int(scripted.latent_size) != args.latent_size:
        raise RuntimeError(f"exporter produced {scripted.latent_size}D, expected {args.latent_size}D")

    probe = torch.zeros(1, pretrained.n_channels, 2**14)
    scripted.decode(scripted.encode(probe))
    args.output.mkdir(parents=True, exist_ok=True)
    suffix = "_streaming" if args.streaming else ""
    scripted.export_to_ts(str(args.output / f"{args.name}{suffix}.ts"))


if __name__ == "__main__":
    main()
