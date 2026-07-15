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
from latent_cosmos_research.pitch_rave import PitchConditionedRAVE


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


class _PilotPitchConditionedRAVE(PitchConditionedRAVE):
    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        if FLAGS.bootstrap_brave_checkpoint:
            diagnostics = bootstrap_from_brave(self, FLAGS.bootstrap_brave_checkpoint)
            print("BRAVE bootstrap:", json.dumps(diagnostics, sort_keys=True))
        if FLAGS.initial_conditioned_checkpoint:
            if FLAGS.bootstrap_brave_checkpoint:
                raise ValueError("choose either BRAVE bootstrap or conditioned initialization")
            state = torch.load(FLAGS.initial_conditioned_checkpoint, map_location="cpu")
            incompatible = self.load_state_dict(state["state_dict"], strict=False)
            if incompatible.unexpected_keys or incompatible.missing_keys:
                raise RuntimeError(
                    "conditioned initialization mismatch: "
                    f"missing={incompatible.missing_keys}, unexpected={incompatible.unexpected_keys}"
                )
            print("Conditioned initialization:", FLAGS.initial_conditioned_checkpoint)
        if FLAGS.freeze_encoder:
            for parameter in self.encoder.parameters():
                parameter.requires_grad_(False)
            print("Encoder frozen for pitch-swap pilot")


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
        dataset = dataset_class(
            FLAGS.pilot_manifest,
            n_signal=n_signal,
            sample_rate=sr,
            repeats=FLAGS.pilot_repeats,
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
