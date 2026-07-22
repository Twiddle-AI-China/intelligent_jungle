# MidiBrave

Independent dual-branch MIDI-conditioned BRAVE training framework for Octopus.

The model is conditioned only on MIDI note and velocity. Full Serum renders are
retained for CLAP, QA, and fixed condition-level velocity RMS references. Decoder targets use 49,152-sample (about 1.115 s)
windows with at least 75% reliable CREPE frames; unreliable frames are masked only from pitch loss,
not removed from reconstruction. The host owns the performance envelope.
Training reconstructs two phase-agnostic outputs:

```text
A_hat = Decoder(z_timbre_A, z_midi_A)
B_hat = Decoder(z_timbre_A, z_midi_B)
```

MIDI note also drives a parameter-free harmonic excitation clock. Its 16-band
PQMF pyramid is injected at every BRAVE upsampling scale, while velocity remains
a learned part of the 32-D MIDI condition. Losses use fullband/PQMF MR-STFT,
envelope dynamics, frozen differentiable CREPE with absolute target activation,
hard-negative and target-period autocorrelation constraints, generated-waveform
dB RMS, masked same-note velocity ranking, and optional observed velocity
dB-delta matching (disabled in the validated C9 profile).
Window reconstruction losses always use the sampled windows; only the relative
velocity target uses complete-render RMS so independently sampled crop offsets
cannot flip its label. There is no sample waveform loss or voiced loss.

`condition_gain_hidden > 0` enables an experimental, zero-initialized bounded
output-gain head. It is disabled by default: the C14/C15 ablation did not make
arbitrary non-monotonic velocity responses generalize to unseen presets and
increased crest/ripple error. No long training should be launched until the
product chooses between exact preset-specific velocity response and a unified
real-time MIDI velocity semantic.

Phase 2 uses the official-size three-scale BRAVE waveform discriminator
(1,940,451 parameters). The trainer counts only finite, jointly applied G/D
updates and stores exact-resume checkpoint format 3.

The published formal profiles lock the validated C9 pitch-repair loss:
`cross_stft=0.5`, `cross_pitch=1.0`, KL off, target activation 1.0,
hard-negative 0.25, target-period autocorrelation 20.0, velocity rank 0.5,
and velocity delta off. Use `configs/full_c9_optimized.yaml` for the full
16+2-epoch run and `configs/quality300_c9_optimized.yaml` for the matching
q300 view. The quality-first full-compute profile is stored separately under
`training_profiles/pre_time_optimization_c9/`: it keeps the same C9 loss and
algebra-preserving speedups, but restores Self on every update and the fixed
1,000,000 + 250,000 update budget.

## Quick smoke

```bash
midibrave fixture --root fixtures/generated
midibrave validate --config configs/smoke.yaml
midibrave-train --config configs/smoke.yaml --phase 1 --max-effective-updates 4
midibrave-train --config configs/smoke.yaml --phase 2 --max-effective-updates 3 \
  --resume artifacts/candidate/smoke_continuous_v02/phase1/step-000000004.pt
```

GPU work on Octopus must run through SLURM and Docker. See `scripts/`.

Build the image and cache frozen preprocessing models under `/data/model_weights`:

```bash
./scripts/build_image.sh
./scripts/download_models.sh
```

## Published Serum data

The source dataset is immutable. Build strict derived views, cache frozen
features, and freeze a cache-eligible manifest before training:

```bash
midibrave prepare-serum \
  --dataset-root /data/datasets/latent-cosmos-synth/serum-dataset \
  --output /data/midibrave/manifests
midibrave preprocess --config configs/quality300.yaml --stage all --device cuda
midibrave finalize-cache --config configs/quality300.yaml \
  --output-manifest /data/midibrave/manifests/serum_quality300_eligible_optimized.jsonl \
  --output-metadata /data/midibrave/manifests/serum_quality300_eligible_optimized.meta.json
```

The older `serum_quality300_eligible.jsonl` is intentionally retained as the
65,536-sample/15%-valid historical comparison and must not be paired with a
49,152-sample/75%-valid optimized config.

Audio conditioning always uses the audited final `midi_note`; `midi_note_sent`
and `transpose_semitones` are retained only for provenance checks. Missing grid
cells are not negatives and no 72/72 grid is assumed.
