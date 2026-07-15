import importlib.util
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

        self.assertEqual(CONDITIONING_SCHEMA, "pitch-conditioning-v1:f0_hz,loudness,gate")
        voiced = self._sine_batch(batch_size=1)
        silence = torch.zeros_like(voiced)
        audio = torch.cat([voiced, silence], dim=0)
        conditioning = extract_conditioning(audio, self.SAMPLE_RATE, 128)

        self.assertEqual(tuple(conditioning.shape), (2, 3, self.N_SIGNAL // 128))
        f0, loudness, gate = conditioning[:, 0], conditioning[:, 1], conditioning[:, 2]
        self.assertTrue(bool((gate[0] == 1.0).all()))
        self.assertTrue(bool((gate[1] == 0.0).all()))
        self.assertTrue(bool((f0[1] == 0.0).all()))
        self.assertTrue(bool(((f0[0] > 180.0) & (f0[0] < 260.0)).all()))
        expected_rms = 0.2 / math.sqrt(2.0)
        self.assertTrue(bool((loudness[0] - expected_rms).abs().max() < 0.02))

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
        conditioning = torch.zeros(1, 3, frames)
        conditioning[:, 0] = 220.0
        conditioning[:, 1] = 0.1
        conditioning[:, 2] = 1.0

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
