"""Train the pitch-conditioned BRAVE variant with the official RAVE trainer.

The acids-rave CLI hardcodes ``rave.RAVE`` as the model class. Replacing that
symbol on the real ``rave`` module would also redirect gin's dynamic
registration, detaching the ``rave.RAVE:`` bindings in brave.gin from the
decorated base class. Instead, ``scripts.train`` gets a proxy module whose
``RAVE`` attribute is the conditioned subclass: gin bindings stay on
``rave.model.RAVE`` and reach the subclass through ``super().__init__``, while
only the instantiation site sees the swap. Pass the same flags as
``rave train``, including
``--config $BRAVE_REPO/configs/brave.gin --config configs/brave_pitch.gin``.
"""
from __future__ import annotations

import json

import torch
from absl import app, flags

import rave
import scripts.train as official_train

from latent_cosmos_research.brave_bootstrap import bootstrap_from_brave
from latent_cosmos_research.pitch_pilot_dataset import (
    DexedPitchPilotDataset,
    DexedPitchSwapDataset,
    pilot_conditioning_diagnostics,
)
from latent_cosmos_research.pitch_rave import PitchConditionedRAVE, unfreeze_encoder_tail


FLAGS = flags.FLAGS
flags.DEFINE_string(
    "pilot_manifest", None, "Verified P0-C2 Dexed manifest; enables paired conditioning."
)
flags.DEFINE_integer("pilot_repeats", 16, "Deterministic crop repeats per pilot clip.")
flags.DEFINE_string(
    "bootstrap_brave_checkpoint", None, "Phase-1 BRAVE checkpoint used to initialize P0-C2."
)
flags.DEFINE_string(
    "initial_conditioned_checkpoint", None, "Conditioned checkpoint used to initialize P0-C3."
)
flags.DEFINE_bool("pitch_swap", False, "Train same-preset source/target pitch pairs.")
flags.DEFINE_bool("freeze_encoder", False, "Freeze the encoder during the pitch-swap pilot.")
flags.DEFINE_string(
    "pilot_preset_indices",
    None,
    "Optional comma-separated preset indices retained by the pitch-swap dataset.",
)
flags.DEFINE_bool(
    "pitch_adversary", False, "Remove source pitch from latent with gradient reversal."
)
flags.DEFINE_float("pitch_adversary_weight", 0.05, "Pitch-adversary loss weight.")
flags.DEFINE_float("pitch_adversary_grl_scale", 1.0, "Encoder gradient-reversal scale.")
flags.DEFINE_integer(
    "pitch_adversary_warmup_batches",
    0,
    "Classifier-only batches before encoder gradient reversal starts.",
)
flags.DEFINE_integer(
    "pitch_adversary_updates_per_batch",
    1,
    "Detached-latent classifier updates before each encoder update.",
)
flags.DEFINE_integer(
    "encoder_tail_modules", 0, "Freeze the encoder except for this many final modules."
)
flags.DEFINE_float(
    "latent_pitch_consistency_weight",
    0.0,
    "Paired same-preset latent-consistency weight; zero disables it.",
)


class _PilotPitchConditionedRAVE(PitchConditionedRAVE):
    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        if FLAGS.freeze_encoder and FLAGS.encoder_tail_modules:
            raise ValueError("choose either a fully frozen encoder or a trainable encoder tail")
        if FLAGS.pitch_adversary:
            if not FLAGS.pitch_swap:
                raise ValueError("pitch adversary requires pitch-swap training")
            if FLAGS.freeze_encoder:
                raise ValueError("pitch adversary cannot learn with a frozen encoder")
            self.enable_pitch_adversary(
                weight=FLAGS.pitch_adversary_weight,
                grl_scale=FLAGS.pitch_adversary_grl_scale,
                warmup_batches=FLAGS.pitch_adversary_warmup_batches,
                updates_per_batch=FLAGS.pitch_adversary_updates_per_batch,
            )
        if FLAGS.latent_pitch_consistency_weight:
            if not FLAGS.pitch_swap:
                raise ValueError("latent pitch consistency requires pitch-swap training")
            if FLAGS.freeze_encoder:
                raise ValueError("latent pitch consistency cannot learn with a frozen encoder")
            self.enable_latent_pitch_consistency(
                FLAGS.latent_pitch_consistency_weight
            )
        if FLAGS.bootstrap_brave_checkpoint:
            diagnostics = bootstrap_from_brave(self, FLAGS.bootstrap_brave_checkpoint)
            print("BRAVE bootstrap:", json.dumps(diagnostics, sort_keys=True))
        if FLAGS.initial_conditioned_checkpoint:
            if FLAGS.bootstrap_brave_checkpoint:
                raise ValueError("choose either BRAVE bootstrap or conditioned initialization")
            state = torch.load(FLAGS.initial_conditioned_checkpoint, map_location="cpu")
            incompatible = self.load_state_dict(state["state_dict"], strict=False)
            allowed_missing = {
                key
                for key in incompatible.missing_keys
                if FLAGS.pitch_adversary and key.startswith("pitch_adversary")
            }
            disallowed_missing = set(incompatible.missing_keys) - allowed_missing
            if incompatible.unexpected_keys or disallowed_missing:
                raise RuntimeError(
                    "conditioned initialization mismatch: "
                    f"missing={sorted(disallowed_missing)}, "
                    f"unexpected={incompatible.unexpected_keys}"
                )
            print("Conditioned initialization:", FLAGS.initial_conditioned_checkpoint)
        if FLAGS.freeze_encoder:
            self.freeze_encoder_for_pitch_swap()
            print("Encoder frozen for pitch-swap pilot (parameters + running statistics)")
        if FLAGS.encoder_tail_modules:
            diagnostics = unfreeze_encoder_tail(self.encoder, FLAGS.encoder_tail_modules)
            print("Encoder tail trainable:", json.dumps(diagnostics, sort_keys=True))


class _DatasetProxy:
    def __getattr__(self, name):
        return getattr(rave.dataset, name)

    def get_training_channels(self, db_path, target_channels):
        if FLAGS.pilot_manifest:
            return 1
        return rave.dataset.get_training_channels(db_path, target_channels)

    def get_dataset(self, db_path, sr, n_signal, **kwargs):
        if not FLAGS.pilot_manifest:
            return rave.dataset.get_dataset(db_path, sr, n_signal, **kwargs)
        dataset_class = DexedPitchSwapDataset if FLAGS.pitch_swap else DexedPitchPilotDataset
        preset_indices = (
            {int(value) for value in FLAGS.pilot_preset_indices.split(",") if value}
            if FLAGS.pilot_preset_indices
            else None
        )
        if preset_indices and not FLAGS.pitch_swap:
            raise ValueError("pilot preset filtering is only defined for pitch-swap training")
        dataset = dataset_class(
            FLAGS.pilot_manifest,
            n_signal=n_signal,
            sample_rate=sr,
            repeats=FLAGS.pilot_repeats,
            **({"preset_indices": preset_indices} if FLAGS.pitch_swap else {}),
        )
        print("Dexed pilot:", json.dumps(pilot_conditioning_diagnostics(dataset), sort_keys=True))
        return dataset


class _RaveModuleProxy:
    RAVE = _PilotPitchConditionedRAVE
    dataset = _DatasetProxy()

    def __getattr__(self, name):
        return getattr(rave, name)


def main() -> None:
    official_train.rave = _RaveModuleProxy()
    app.run(official_train.main)


if __name__ == "__main__":
    main()
