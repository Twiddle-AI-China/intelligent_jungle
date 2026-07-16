"""Export a pitch-conditioned BRAVE checkpoint as a conditioned TorchScript.

Extends the official variational exporter with a ``decode_conditioned`` method
whose single input stacks the latent and the pitch-conditioning-v2 channels at
latent-frame rate: ``[batch, latent_size + 4, frames]`` with the last four
channels being f0_hz, loudness, gate, periodicity. The harmonic oscillator
phase lives in a buffer so streaming blocks stay phase-continuous. Loaders must
check the ``conditioning_schema`` attribute instead of guessing channel
meanings; the v1→v2 bump is intentionally load-breaking for old hosts.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import cached_conv as cc
import gin
import torch
import torch.nn as nn

import rave
import rave.blocks
import rave.core
from scripts.export import VariationalScriptedRAVE

from latent_cosmos_research.conditioning import CONDITIONING_CHANNELS, CONDITIONING_SCHEMA
from latent_cosmos_research.pitch_rave import ConditionedGeneratorAdapter, PitchConditionedRAVE


class ConditionedScriptedRAVE(VariationalScriptedRAVE):

    def __init__(self, pretrained: PitchConditionedRAVE, fidelity: float = 0.95) -> None:
        super().__init__(pretrained=pretrained, fidelity=fidelity)
        self.conditioned_generator = pretrained.decoder.generator
        self.excitation = pretrained.excitation
        self.register_buffer("excitation_phase", torch.zeros(1))

        decode_ratio = int(self.decode_params[1].item())
        self.register_method(
            "decode_conditioned",
            in_channels=self.latent_size + len(CONDITIONING_CHANNELS),
            in_ratio=decode_ratio,
            out_channels=self.target_channels,
            out_ratio=1,
            input_labels=[
                f"(signal) Latent dimension {i + 1}" for i in range(self.latent_size)
            ] + [f"(signal) {name}" for name in CONDITIONING_CHANNELS],
            output_labels=[
                "(signal) Channel %d" % d for d in range(1, self.target_channels + 1)
            ],
        )
        self.register_attribute("conditioning_schema", CONDITIONING_SCHEMA)

    @torch.jit.export
    def get_conditioning_schema(self) -> str:
        return self.conditioning_schema[0]

    @torch.jit.export
    def set_conditioning_schema(self, schema: str) -> int:
        # The schema is a contract, not a knob.
        return -1

    @torch.jit.export
    def decode_conditioned(self, x: torch.Tensor) -> torch.Tensor:
        z = x[:, : self.latent_size]
        conditioning = x[:, self.latent_size : self.latent_size + 4]
        if self.excitation_phase.shape[0] != x.shape[0]:
            self.excitation_phase = torch.zeros(
                x.shape[0], device=x.device, dtype=self.excitation_phase.dtype
            )
        excitation, phase = self.excitation(conditioning, self.excitation_phase)
        self.excitation_phase = phase
        bands = self.pqmf(excitation)

        z_full = self.pre_process_latent(z)
        y = self.conditioned_generator(z_full, bands)
        y = self.pqmf.inverse(y)

        decode_ratio = int(self.decode_params[1].item())
        if y.shape[-1] > x.shape[-1] * decode_ratio:
            y = y[..., : x.shape[-1] * decode_ratio]
        return y


def load_pretrained(run: Path, streaming: bool) -> PitchConditionedRAVE:
    cc.use_cached_conv(streaming)
    config = rave.core.search_for_config(str(run))
    if config is None:
        raise SystemExit(f"No RAVE config found for {run}")
    gin.parse_config_file(config)
    checkpoint_path = rave.core.search_for_run(str(run))
    if checkpoint_path is None:
        raise SystemExit(f"No checkpoint found for {run}")
    pretrained = PitchConditionedRAVE()
    checkpoint = torch.load(checkpoint_path, map_location="cpu")
    pretrained.load_state_dict(checkpoint["state_dict"], strict=False)
    pretrained.eval()

    if not isinstance(pretrained.encoder, rave.blocks.VariationalEncoder):
        raise SystemExit("conditioned export requires a variational checkpoint")
    if not isinstance(pretrained.decoder, ConditionedGeneratorAdapter):
        raise SystemExit("checkpoint was not trained with the brave_pitch decoder")

    for module in pretrained.modules():
        if hasattr(module, "weight_g"):
            nn.utils.remove_weight_norm(module)
    return pretrained


def export(pretrained: PitchConditionedRAVE, output: Path, name: str, streaming: bool,
           latent_size: int | None, fidelity: float) -> Path:
    if latent_size is None:
        scripted = ConditionedScriptedRAVE(pretrained=pretrained, fidelity=fidelity)
    else:
        if latent_size < 2 or latent_size & (latent_size - 1):
            raise SystemExit("--latent-size must be a power of two >= 2")
        if latent_size > pretrained.latent_size:
            raise SystemExit(
                f"requested {latent_size}D exceeds full {pretrained.latent_size}D"
            )
        # Same synthetic-fidelity trick as export_fixed_latent.py: the upstream
        # exporter rounds the first threshold crossing up to a power of two.
        real_fidelity = pretrained.fidelity.detach().clone()
        synthetic = torch.zeros_like(pretrained.fidelity)
        synthetic[latent_size // 2 + 1 :] = 1
        pretrained.fidelity.copy_(synthetic)
        scripted = ConditionedScriptedRAVE(pretrained=pretrained, fidelity=0.5)
        scripted.fidelity.copy_(real_fidelity)
        pretrained.fidelity.copy_(real_fidelity)
        if int(scripted.latent_size) != latent_size:
            raise RuntimeError(
                f"exporter produced {scripted.latent_size}D, expected {latent_size}D"
            )

    probe = torch.zeros(1, int(scripted.latent_size) + len(CONDITIONING_CHANNELS), 16)
    probe[:, int(scripted.latent_size)] = 220.0
    probe[:, int(scripted.latent_size) + 1] = 0.1
    probe[:, int(scripted.latent_size) + 2] = 1.0
    probe[:, int(scripted.latent_size) + 3] = 1.0
    scripted.decode_conditioned(probe)
    # The probe validates the method but must not leak its oscillator state into
    # the serialized instrument. Every freshly loaded session starts at phase 0.
    scripted.excitation_phase.zero_()

    output.mkdir(parents=True, exist_ok=True)
    suffix = "_streaming" if streaming else ""
    artifact = output / f"{name}{suffix}.ts"
    scripted.export_to_ts(str(artifact))
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--streaming", action="store_true")
    parser.add_argument("--latent-size", type=int, default=None)
    parser.add_argument("--fidelity", type=float, default=0.95)
    args = parser.parse_args()

    pretrained = load_pretrained(args.run, args.streaming)
    artifact = export(pretrained, args.output, args.name, args.streaming,
                      args.latent_size, args.fidelity)

    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    print(f"{digest}  {artifact}")
    print(f"conditioning_schema={CONDITIONING_SCHEMA}")


if __name__ == "__main__":
    main()
