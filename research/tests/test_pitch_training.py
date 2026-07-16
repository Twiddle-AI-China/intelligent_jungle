import importlib.util
import json
import math
import tempfile
import unittest
from functools import partial
from pathlib import Path


torch_available = importlib.util.find_spec("torch") is not None and importlib.util.find_spec("rave") is not None


def _load_export_module():
    path = Path(__file__).resolve().parent.parent / "scripts" / "export_pitch_conditioned.py"
    spec = importlib.util.spec_from_file_location("export_pitch_conditioned", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(torch_available, "pitch training tests require the rave extra")
class PitchTrainingTest(unittest.TestCase):
    SAMPLE_RATE = 44_100
    N_SIGNAL = 4_096
    LATENT_SIZE = 8

    @classmethod
    def setUpClass(cls):
        import torch
        cls.torch = torch

    def setUp(self):
        import cached_conv as cc
        import gin
        import rave.blocks  # noqa: F401 -- registers the gin configurables

        gin.clear_config()
        gin.bind_parameter("normalization.mode", "identity")
        gin.bind_parameter("ResidualStack.kernel_sizes", [3])
        gin.bind_parameter("ResidualStack.dilations_list", [[3, 1], [9, 1]])
        gin.bind_parameter("cc.get_padding.mode", "causal")
        cc.use_cached_conv(False)
        self.torch.manual_seed(0)

    def tearDown(self):
        import cached_conv as cc
        import gin

        cc.use_cached_conv(False)
        gin.clear_config()

    def _build_model(self):
        from torch import nn
        from rave import blocks, core, discriminator, pqmf
        from latent_cosmos_research.pitch_rave import PitchConditionedRAVE, build_pitch_decoder

        encoder = partial(
            blocks.VariationalEncoder,
            encoder=partial(
                blocks.Encoder,
                data_size=16,
                capacity=4,
                latent_size=self.LATENT_SIZE,
                ratios=[2, 2, 2, 1],
                n_out=2,
                sample_norm=False,
                repeat_layers=1,
            ),
        )
        decoder = partial(
            build_pitch_decoder,
            latent_size=self.LATENT_SIZE,
            capacity=4,
            data_size=16,
            ratios=[2, 2, 2, 1],
            loud_stride=1,
            use_noise=False,
        )
        disc = partial(
            discriminator.MultiScaleDiscriminator,
            n_discriminators=1,
            convnet=partial(
                discriminator.ConvNet,
                out_size=1,
                capacity=4,
                n_layers=2,
                kernel_size=15,
                stride=4,
                conv=nn.Conv1d,
            ),
        )
        audio_distance = partial(
            core.AudioDistanceV1,
            multiscale_stft=partial(
                core.MultiScaleSTFT,
                scales=[256, 128],
                sample_rate=self.SAMPLE_RATE,
                magnitude=True,
            ),
            log_epsilon=1e-7,
        )
        return PitchConditionedRAVE(
            latent_size=self.LATENT_SIZE,
            sampling_rate=self.SAMPLE_RATE,
            encoder=encoder,
            decoder=decoder,
            discriminator=disc,
            phase_1_duration=100,
            gan_loss=core.hinge_gan,
            valid_signal_crop=False,
            feature_matching_fun=partial(core.mean_difference, norm="L1"),
            num_skipped_features=0,
            audio_distance=audio_distance,
            multiband_audio_distance=audio_distance,
            weights={"feature_matching": 10},
            pqmf=partial(pqmf.CachedPQMF, attenuation=40, n_band=16),
            n_channels=1,
            input_mode="pqmf",
            output_mode="pqmf",
        )

    def _sine_batch(self, batch_size=2, frequency=220.0, amplitude=0.2):
        torch = self.torch
        t = torch.arange(self.N_SIGNAL, dtype=torch.float32) / self.SAMPLE_RATE
        wave = amplitude * torch.sin(2 * math.pi * frequency * t)
        return wave.reshape(1, 1, -1).repeat(batch_size, 1, 1)

    def test_extract_conditioning_matches_schema_and_reserves_zero_f0(self):
        torch = self.torch
        from latent_cosmos_research.conditioning import CONDITIONING_SCHEMA
        from latent_cosmos_research.pitch_rave import extract_conditioning

        self.assertEqual(
            CONDITIONING_SCHEMA, "pitch-conditioning-v2:f0_hz,loudness,gate,periodicity"
        )
        voiced = self._sine_batch(batch_size=1)
        silence = torch.zeros_like(voiced)
        audio = torch.cat([voiced, silence], dim=0)
        conditioning = extract_conditioning(audio, self.SAMPLE_RATE, 128)

        self.assertEqual(tuple(conditioning.shape), (2, 4, self.N_SIGNAL // 128))
        f0, loudness, gate = conditioning[:, 0], conditioning[:, 1], conditioning[:, 2]
        periodicity = conditioning[:, 3]
        self.assertTrue(bool((gate[0] == 1.0).all()))
        self.assertTrue(bool((gate[1] == 0.0).all()))
        self.assertTrue(bool((f0[1] == 0.0).all()))
        self.assertTrue(bool(((f0[0] > 180.0) & (f0[0] < 260.0)).all()))
        self.assertTrue(bool((periodicity[0] == 1.0).all()))
        self.assertTrue(bool((periodicity[1] == 0.0).all()))
        expected_rms = 0.2 / math.sqrt(2.0)
        self.assertTrue(bool((loudness[0] - expected_rms).abs().max() < 0.02))

    def test_verified_pilot_dataset_keeps_crop_and_labels_aligned(self):
        import numpy as np
        import soundfile as sf
        from latent_cosmos_research.pitch_pilot_dataset import DexedPitchPilotDataset

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            signal = np.full(16_000 * 4, 0.1, dtype=np.float32)
            sf.write(root / "clip.wav", signal, 16_000, subtype="FLOAT")
            clip = {
                "preset_index": 1,
                "midi_note": 57,
                "velocity": 75,
                "expected_f0_hz": 220.0,
                "source_wav": "clip.wav",
                "note_on_seconds": 0.0,
                "note_off_seconds": 3.0,
            }
            manifest = {
                "schema_version": "p0c-dexed-pilot-verified-v1",
                "selection": {"source_root": str(root)},
                "clips": [clip, {**clip, "preset_index": 2}],
            }
            path = root / "manifest.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            n_signal = 44_032
            dataset = DexedPitchPilotDataset(
                path, n_signal=n_signal, sample_rate=44_100, repeats=2
            )
            example = dataset[3]
            self.assertEqual(tuple(example["audio"].shape), (1, n_signal))
            self.assertEqual(tuple(example["conditioning"].shape), (4, n_signal // 128))
            gate = example["conditioning"][2]
            f0 = example["conditioning"][0]
            periodicity = example["conditioning"][3]
            self.assertTrue(bool((f0[gate == 0] == 0).all()))
            self.assertTrue(bool((f0[gate == 1] == 220.0).all()))
            # A constant DC clip is aperiodic: pYIN must not claim confidence.
            self.assertTrue(bool((periodicity >= 0).all() and (periodicity <= 1).all()))
            self.assertTrue(bool((periodicity[gate == 0] == 0).all()))
            self.assertLess(float(periodicity.mean()), 0.5)
            cache_files = list(Path(tmp).glob("*.npz"))
            self.assertEqual(len(cache_files), 1)
            cached_again = DexedPitchPilotDataset(
                path, n_signal=n_signal, sample_rate=44_100, repeats=2
            )
            self.assertTrue(
                bool(
                    (cached_again[3]["conditioning"][3] == periodicity).all()
                )
            )

    def test_pitch_swap_dataset_pairs_different_notes_from_the_same_preset(self):
        import numpy as np
        import soundfile as sf
        from latent_cosmos_research.pitch_pilot_dataset import DexedPitchSwapDataset

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            clips = []
            for preset in (1, 2):
                for note in (41, 48, 56, 63):
                    filename = f"{preset}-{note}.wav"
                    sf.write(
                        root / filename,
                        np.full(16_000 * 4, note / 1000.0, dtype=np.float32),
                        16_000,
                        subtype="FLOAT",
                    )
                    clips.append(
                        {
                            "preset_index": preset,
                            "midi_note": note,
                            "velocity": 75,
                            "expected_f0_hz": float(note * 4),
                            "source_wav": filename,
                            "note_on_seconds": 0.0,
                            "note_off_seconds": 3.0,
                        }
                    )
            manifest = {
                "schema_version": "p0c-dexed-pilot-verified-v1",
                "selection": {"source_root": str(root)},
                "clips": clips,
            }
            path = root / "manifest.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            dataset = DexedPitchSwapDataset(
                path, n_signal=44_032, sample_rate=44_100, repeats=3
            )
            self.assertEqual(len(dataset), 24)
            for index in range(len(dataset)):
                example = dataset[index]
                self.assertNotEqual(
                    int(example["source_midi_note"]), int(example["target_midi_note"])
                )
                expected = float(example["target_midi_note"] * 4)
                gate = example["conditioning"][2] == 1
                self.assertTrue(bool((example["conditioning"][0, gate] == expected).all()))
                self.assertIn(int(example["source_pitch_class"]), range(4))

            filtered = DexedPitchSwapDataset(
                path,
                n_signal=44_032,
                sample_rate=44_100,
                repeats=1,
                preset_indices={2},
            )
            self.assertEqual(len(filtered), 4)
            self.assertTrue(all(int(filtered[index]["preset_index"]) == 2 for index in range(4)))

            weighted = DexedPitchSwapDataset(
                path,
                n_signal=44_032,
                sample_rate=44_100,
                repeats=1,
                preset_weights={2: 3},
            )
            counts = {1: 0, 2: 0}
            for index in range(len(weighted)):
                counts[int(weighted[index]["preset_index"])] += 1
            self.assertEqual(counts, {1: 4, 2: 12})
            with self.assertRaisesRegex(ValueError, "positive"):
                DexedPitchSwapDataset(
                    path,
                    n_signal=44_032,
                    sample_rate=44_100,
                    repeats=1,
                    preset_weights={2: 0},
                )

    def test_pitch_swap_forward_uses_source_latent_and_target_distance(self):
        torch = self.torch
        model = self._build_model()
        source = self._sine_batch(batch_size=2, frequency=220.0)
        target = self._sine_batch(batch_size=2, frequency=330.0)
        frames = self.N_SIGNAL // 128
        conditioning = torch.zeros(2, 4, frames)
        conditioning[:, 0] = 330.0
        conditioning[:, 1] = 0.1
        conditioning[:, 2] = 1.0
        conditioning[:, 3] = 1.0
        with torch.enable_grad():
            output, latent, distances = model._swap_forward(source, target, conditioning)
            loss = sum(distances.values())
            loss.backward()
        self.assertEqual(tuple(output.shape), tuple(target.shape))
        self.assertEqual(tuple(latent.shape), (2, self.LATENT_SIZE, frames))
        self.assertTrue(distances)
        gradients = [
            site.film.projection.weight.grad for site in model.decoder.generator.film_sites
        ]
        self.assertTrue(
            all(
                gradient is not None
                and bool(torch.isfinite(gradient).all())
                and bool((gradient != 0).any())
                for gradient in gradients
            )
        )
        downsampler_gradients = [
            layer.weight.grad for layer in model.decoder.generator.condition_downsamplers
        ]
        self.assertTrue(
            all(
                gradient is not None
                and bool(torch.isfinite(gradient).all())
                for gradient in downsampler_gradients
            )
        )
        # FiLM projections start at exact pass-through (zero condition weights),
        # so the first backward legitimately gives the upstream condition
        # pyramid zero gradients. The two-step Trainer test below locks that the
        # pyramid starts changing once FiLM has taken its first update.
        self.assertTrue(all(bool((gradient == 0).all()) for gradient in downsampler_gradients))

    def test_frozen_encoder_stays_in_eval_mode_and_preserves_running_statistics(self):
        torch = self.torch
        from torch import nn

        model = self._build_model()
        # The tiny test config uses identity normalization, so attach a probe
        # BatchNorm to exercise the stateful-buffer part of the freeze contract.
        model.encoder.freeze_probe = nn.BatchNorm1d(2)
        model.freeze_encoder_for_pitch_swap()
        before_mean = model.encoder.freeze_probe.running_mean.detach().clone()
        before_var = model.encoder.freeze_probe.running_var.detach().clone()

        # Lightning calls train() on the root module at epoch boundaries.
        model.train()
        self.assertFalse(model.encoder.training)
        self.assertFalse(model.encoder.freeze_probe.training)
        self.assertTrue(
            all(not parameter.requires_grad for parameter in model.encoder.parameters())
        )
        model.encoder.freeze_probe(torch.randn(8, 2, 16))
        torch.testing.assert_close(
            model.encoder.freeze_probe.running_mean, before_mean, rtol=0, atol=0
        )
        torch.testing.assert_close(
            model.encoder.freeze_probe.running_var, before_var, rtol=0, atol=0
        )

    def test_latent_pitch_consistency_reaches_encoder_without_an_adversary(self):
        torch = self.torch
        model = self._build_model()
        model.enable_latent_pitch_consistency(weight=1.0)
        source = self._sine_batch(batch_size=2, frequency=220.0)
        target = self._sine_batch(batch_size=2, frequency=330.0)
        frames = self.N_SIGNAL // 128
        conditioning = torch.zeros(2, 4, frames)
        conditioning[:, 0] = 330.0
        conditioning[:, 1] = 0.1
        conditioning[:, 2] = 1.0
        conditioning[:, 3] = 1.0
        with torch.enable_grad():
            _, _, distances = model._swap_forward(source, target, conditioning)
            consistency = distances["latent_pitch_consistency"]
            consistency.backward()
        self.assertGreater(float(consistency.detach()), 0.0)
        self.assertTrue(
            any(
                parameter.grad is not None and bool((parameter.grad != 0).any())
                for parameter in model.encoder.parameters()
            )
        )

    def test_pitch_adversary_reverses_gradient_and_only_unfreezes_encoder_tail(self):
        torch = self.torch
        from latent_cosmos_research.pitch_rave import (
            _GradientReverse,
            unfreeze_encoder_tail,
        )

        with torch.enable_grad():
            value = torch.ones(2, requires_grad=True)
            _GradientReverse.apply(value, 0.25).sum().backward()
        self.assertTrue(bool((value.grad == -0.25).all()))

        model = self._build_model()
        diagnostics = unfreeze_encoder_tail(model.encoder, 2)
        self.assertEqual(diagnostics["parameterized_modules"], 2)
        self.assertGreater(diagnostics["trainable_parameters"], 0)
        self.assertTrue(any(parameter.requires_grad for parameter in model.encoder.parameters()))
        self.assertTrue(any(not parameter.requires_grad for parameter in model.encoder.parameters()))

        model.enable_pitch_adversary(weight=0.05)
        optimizers = model.configure_optimizers()
        self.assertEqual(len(optimizers), 2)
        latent = torch.randn(3, self.LATENT_SIZE, 8)
        self.assertEqual(tuple(model.pitch_adversary(latent).shape), (3, 4, 8))

    def test_pitch_adversary_warmup_uses_one_global_step_per_batch(self):
        torch = self.torch
        import pytorch_lightning as pl

        model = self._build_model()
        model.enable_pitch_adversary(
            weight=0.05,
            warmup_batches=1,
            updates_per_batch=3,
        )
        classifier_before = [
            parameter.detach().clone() for parameter in model.pitch_adversary.parameters()
        ]
        frames = self.N_SIGNAL // 128
        examples = []
        for pitch_class, frequency in enumerate((110.0, 165.0, 220.0, 330.0)):
            conditioning = torch.zeros(4, frames)
            conditioning[0] = frequency
            conditioning[1] = 0.1
            conditioning[2] = 1.0
            conditioning[3] = 1.0
            examples.append(
                {
                    "source_audio": self._sine_batch(1, frequency)[0],
                    "target_audio": self._sine_batch(1, 440.0)[0],
                    "conditioning": conditioning,
                    "source_pitch_class": torch.tensor(pitch_class),
                }
            )
        loader = torch.utils.data.DataLoader(examples, batch_size=2)
        with tempfile.TemporaryDirectory() as tmp:
            trainer = pl.Trainer(
                accelerator="cpu",
                max_steps=2,
                max_epochs=2,
                limit_train_batches=2,
                limit_val_batches=0,
                logger=pl.loggers.TensorBoardLogger(tmp, name="adversary-smoke"),
                enable_checkpointing=False,
                enable_progress_bar=False,
            )
            trainer.fit(model, loader)
        self.assertEqual(trainer.global_step, 2)
        self.assertEqual(int(model.pitch_adversary_batches_seen), 2)
        self.assertTrue(
            any(
                not torch.equal(before, after)
                for before, after in zip(
                    classifier_before, model.pitch_adversary.parameters()
                )
            )
        )

    def test_brave_bootstrap_remaps_isomorphic_decoder_weights(self):
        from latent_cosmos_research.brave_bootstrap import conditioned_key_for_brave

        self.assertEqual(
            conditioned_key_for_brave("decoder.net.0.weight_v"),
            "decoder.generator.initial.weight_v",
        )
        self.assertEqual(
            conditioned_key_for_brave("decoder.net.4.net.branch.weight_g"),
            "decoder.generator.stages.1.residual.net.branch.weight_g",
        )
        self.assertEqual(
            conditioned_key_for_brave("decoder.synth.branches.0.weight_v"),
            "decoder.generator.synth.branches.0.weight_v",
        )
        self.assertIsNone(conditioned_key_for_brave("decoder.unknown.weight"))

    def test_training_step_reaches_film_sites_and_checkpoint_roundtrips(self):
        torch = self.torch
        import pytorch_lightning as pl

        model = self._build_model()
        film_weights = [site.film.projection.weight for site in model.decoder.generator.film_sites]
        for weight in film_weights:
            self.assertEqual(float(weight.abs().sum()), 0.0)
        downsampler_before = [
            conv.weight.detach().clone() for conv in model.decoder.generator.condition_downsamplers
        ]

        dataset = [self._sine_batch(batch_size=1)[0] for _ in range(4)]
        loader = torch.utils.data.DataLoader(dataset, batch_size=2)
        with tempfile.TemporaryDirectory() as tmp:
            trainer = pl.Trainer(
                accelerator="cpu",
                max_epochs=1,
                limit_train_batches=2,
                limit_val_batches=1,
                num_sanity_val_steps=0,
                logger=pl.loggers.TensorBoardLogger(tmp, name="smoke"),
                enable_checkpointing=False,
                enable_progress_bar=False,
            )
            trainer.fit(model, loader, loader)

            for weight in film_weights:
                self.assertGreater(float(weight.abs().sum()), 0.0)
            for before, conv in zip(downsampler_before, model.decoder.generator.condition_downsamplers):
                self.assertFalse(torch.allclose(before, conv.weight))
            for parameter in model.parameters():
                self.assertTrue(bool(torch.isfinite(parameter).all()))

            checkpoint_path = str(Path(tmp) / "smoke.ckpt")
            trainer.save_checkpoint(checkpoint_path)
            restored = self._build_model()
            state = torch.load(checkpoint_path, map_location="cpu")["state_dict"]
            restored.load_state_dict(state, strict=True)
            for site_a, site_b in zip(
                model.decoder.generator.film_sites, restored.decoder.generator.film_sites
            ):
                torch.testing.assert_close(
                    site_a.film.projection.weight, site_b.film.projection.weight, rtol=0, atol=0
                )

        self.assertGreater(int(model.receptive_field.sum()), 0)

    def test_conditioned_export_offline_matches_eager_and_streams(self):
        torch = self.torch
        import cached_conv as cc
        from latent_cosmos_research.conditioning import CONDITIONING_SCHEMA

        export_module = _load_export_module()

        model = self._build_model()
        model.eval()
        # Full-width synthetic fidelity keeps pre_process_latent noise-free so
        # the scripted output can be compared exactly.
        model.fidelity[self.LATENT_SIZE // 2 + 1 :] = 1
        scripted = export_module.ConditionedScriptedRAVE(pretrained=model, fidelity=0.5)
        self.assertEqual(int(scripted.latent_size), self.LATENT_SIZE)

        frames = 16
        z = torch.randn(1, self.LATENT_SIZE, frames)
        conditioning = torch.zeros(1, 4, frames)
        conditioning[:, 0] = 220.0
        conditioning[:, 1] = 0.1
        conditioning[:, 2] = 1.0
        conditioning[:, 3] = 1.0

        with torch.no_grad():
            eager_audio, _ = model.decode_conditioned(z, conditioning)

        with tempfile.TemporaryDirectory() as tmp:
            artifact = Path(tmp) / "pitch.ts"
            scripted.excitation_phase.zero_()
            scripted.export_to_ts(str(artifact))
            loaded = torch.jit.load(str(artifact))

            self.assertEqual(loaded.get_conditioning_schema(), CONDITIONING_SCHEMA)
            with torch.no_grad():
                scripted_audio = loaded.decode_conditioned(torch.cat([z, conditioning], dim=1))
            torch.testing.assert_close(scripted_audio, eager_audio, rtol=1e-4, atol=1e-5)

        cc.use_cached_conv(True)
        streaming_model = self._build_model()
        streaming_model.eval()
        streaming_model.fidelity[self.LATENT_SIZE // 2 + 1 :] = 1
        streaming_scripted = export_module.ConditionedScriptedRAVE(
            pretrained=streaming_model, fidelity=0.5
        )
        with tempfile.TemporaryDirectory() as tmp:
            artifact = Path(tmp) / "pitch_streaming.ts"
            streaming_scripted.excitation_phase.zero_()
            streaming_scripted.export_to_ts(str(artifact))
            loaded = torch.jit.load(str(artifact))

            block = torch.cat([z[..., :8], conditioning[..., :8]], dim=1)
            with torch.no_grad():
                first = loaded.decode_conditioned(block)
                phase_after_first = loaded.excitation_phase.clone()
                second = loaded.decode_conditioned(block)
            self.assertEqual(tuple(first.shape), (1, 1, 8 * 128))
            self.assertTrue(bool(torch.isfinite(first).all()))
            self.assertTrue(bool(torch.isfinite(second).all()))
            self.assertGreater(float(phase_after_first.abs().sum()), 0.0)
            self.assertFalse(torch.equal(phase_after_first, loaded.excitation_phase))


if __name__ == "__main__":
    unittest.main()
