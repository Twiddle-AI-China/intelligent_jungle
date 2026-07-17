# Model research pipeline

```bash
cd research
uv sync                    # corpus/atlas tooling only
uv sync --extra rave --extra analysis  # model training and TorchScript bake-off
uv run lcs-corpus ../data/corpus/v1 --duration 1800
uv run lcs-bakeoff --backend torchscript --model /path/model.ts --voices 6 --stress-seconds 1800 --output ../reports/rave-6v.json
uv run lcs-gate ../reports/rave-6v.json
uv run lcs-atlas ../renders/model-v1 ../reports/atlas-v1.json
uv run lcs-checkpoint-status /path/to/run/version_0 --output ../reports/checkpoint-status.json
uv run lcs-model-probe /path/to/model.ts /path/to/pulse.wav /path/to/resonance.wav --output ../renders/model-probe
PROBE_DIR=../renders/model-probe bash scripts/install_mvp_assets.sh
```

`fixture` backend only verifies reporting code and always sets `gate_eligible=false`.
The 30-minute stress duration and deadline misses are measured by the command, not accepted as user-entered claims. The hard gate also requires the report to originate on the 16 GB Apple Silicon target; RTX results are training diagnostics only.

GPU training must run through `qgpu`, for example:

```bash
qgpu -n lcs-brave-v1 -c 12 -m 40G -t 72:00:00 -- \
  env DB_PATH=../data/preprocessed/v1 OUT_PATH=../checkpoints \
  BRAVE_REPO=../vendor/BRAVE bash scripts/train_brave.sh
```

Set `SMOKE_TEST=1` to exercise one training/validation batch before reserving a long run. `MAX_STEPS` defaults to RAVE's six-million-step schedule and can be reduced only for an explicitly labeled pilot.

After a run is complete, `export_latest_checkpoints.sh` exports both `best.ckpt` and the newest periodic/final checkpoint and writes their SHA-256 values. A checkpoint existing on disk is not interpreted as an exported or measured model.

The RTX 5080 host currently defaults to Python 3.13. Run `bootstrap_gpu.sh` inside a short qgpu allocation first; it installs an isolated Python 3.11 environment through `uv`. RAVE 2.3.1 pins SciPy 1.10 and Lightning 1.9, so Python 3.12 is intentionally excluded. Torch/Torchaudio 2.11 are pinned to keep the Blackwell-compatible CUDA stack observed in the host probe instead of silently upgrading the experiment environment.

RAVE shells out to both `ffmpeg` and `ffprobe`. The locked `static-ffmpeg` dependency installs the two binaries without elevated privileges, and the scripts fail before spawning RAVE workers if either executable is missing. This avoids RAVE 2.3's otherwise silent multiprocessing deadlock.

The procedural corpus is stored at 48 kHz, while preprocessing defaults to 44.1 kHz because the official BRAVE configuration fixes that model rate. The eventual 48 kHz CoreAudio host must include sample-rate conversion in its measured latency; changing BRAVE's architecture merely to remove that boundary is not an admissible baseline comparison.

All model commands call `uv run` explicitly; qgpu jobs do not rely on an activated interactive shell. BRAVE is trained at the corpus sample rate using its official `configs/brave.gin`; the RAVE comparator uses the official `v2 + causal` configuration. Export is a separate gate because a successful checkpoint does not prove streaming latency.

External model/config revisions used for the experiment are recorded in `model-sources.lock.json`; update that file intentionally when changing a source revision.

Do not commit `data/`, `renders/`, `reports/*.json` generated from experiments, checkpoints, `.venv`, or model weights.

## Pitch-conditioned BRAVE branch

The executable conditioning contract and staged gates are documented in
[`../docs/pitch-conditioned-brave.md`](../docs/pitch-conditioned-brave.md).
The v1 decoder condition is always `[f0_hz, target_rms_loudness, gate]` at
latent-frame rate. `f0=0` remains reserved for unvoiced/noise excitation;
note-off uses the independent gate channel.

Run the contract, reference-excitation, TorchScript, FiLM and training
integration tests with:

```bash
uv run --extra rave python -m unittest discover -s tests -v
```

Training uses the official acids-rave Lightning trainer through
`scripts/train_pitch.py`, which only swaps the model class for
`PitchConditionedRAVE`; conditioning is extracted from the training audio
itself (torchaudio's NCCF pitch estimate -- not YIN -- plus per-frame RMS and
gate, smoke quality until P0-C). On the GPU host:

```bash
qgpu -n lcs-brave-pitch -c 12 -m 40G -t 72:00:00 -- \
  env DB_PATH=... OUT_PATH=... BRAVE_REPO=../vendor/BRAVE \
  bash scripts/train_brave_pitch.sh
```

`SMOKE_TEST=1` runs two steps with per-step validation so `best.ckpt` saving
is exercised. Export the conditioned TorchScript (offline + streaming, with
SHA-256 report) inside a qgpu allocation:

```bash
qgpu -n lcs-pitch-export -c 8 -m 24G -t 00:30:00 -- \
  env RUN_DIR=.../version_0 bash scripts/export_pitch_checkpoints.sh
```

The exported model retains the audit-level `decode_conditioned` method taking
`[batch, latent_size + 4, latent_frames]` (latent, then
f0_hz/loudness/gate/periodicity). The product-facing `decode_pitch` method takes
only `[batch, latent_size + 3, latent_frames]` and internally sets
`periodicity=gate`. Loaders must validate `conditioning_schema` and
`pitch_performance_schema` instead of guessing channel order. A smoke checkpoint
exporting and loading does not claim pitch control.

### P0-C pitch-label benchmark

The P0-B on-the-fly NCCF estimator is smoke-only. Reproduce the synthetic
ground-truth comparison against offline pYIN with:

```bash
uv run --extra rave --extra analysis lcs-pitch-label-benchmark \
  --output ../reports/p0c1-pitch-label-benchmark.json
```

The report measures cents, gross/octave error, voiced/unvoiced error and gate
error by harmonic profile and MIDI note. Generated JSON stays under ignored
`reports/`; the checked-in decision record is
[`../docs/p0c1-pitch-label-benchmark.md`](../docs/p0c1-pitch-label-benchmark.md).
Synthetic accuracy is a label-selection gate, not evidence that the decoder
obeys pitch conditioning.

For the P0-C1b real-sample audit and the reference-only Dexed pilot manifest:

```bash
uv run --extra analysis lcs-real-pitch-audit \
  --nsynth-root /path/to/nsynth-valid/audio \
  --tinysol-root /path/to/tinysol/audio \
  --limit-per-source 12 --output ../reports/p0c1b-real-pitch-audit.json

uv run --extra analysis lcs-dexed-pilot-manifest \
  --database /path/to/dexed_corpus_export.db \
  --render-manifest /path/to/spinvae_16k/manifest.jsonl \
  --count 24 --output ../reports/p0c1b-dexed-pilot.json \
  --audit ../reports/p0c1b-dexed-real-pitch-audit.json \
  --verified-output ../reports/p0c1b-dexed-pilot-verified.json
```

The Dexed manifest references existing controlled renders instead of copying
audio. Its f0/gate truth comes from the renderer contract; pYIN is used only to
reject presets that do not track the four commanded pitches consistently.

For the P0-C2 renderer-truth overfit, pass the verified manifest and the trained
phase-1 BRAVE checkpoint to the existing trainer:

```bash
PILOT_MANIFEST=/path/to/p0c1b-dexed-pilot-verified.json \
BOOTSTRAP_BRAVE_CHECKPOINT=/path/to/brave/best.ckpt \
PILOT_REPEATS=16 MAX_STEPS=2000 VAL_EVERY=250 \
DB_PATH=/path/to/spinvae_16k OUT_PATH=/path/to/checkpoints \
BRAVE_REPO=/path/to/BRAVE RUN_NAME=latent_cosmos_brave_pitch_p0c2 \
bash scripts/train_brave_pitch.sh
```

This mode returns paired `audio` and renderer-truth conditioning from the
dataset, aligns random crops to 128-sample frames, and bypasses audio-derived
NCCF labels. Evaluate the causal pitch path separately:

```bash
uv run --extra rave --extra analysis lcs-pitch-intervention \
  --conditioned-run /path/to/conditioned/run \
  --baseline-run /path/to/brave/baseline/run \
  --manifest /path/to/p0c1b-dexed-pilot-verified.json \
  --output ../reports/p0c2-pitch-intervention.json
```

The 2,000-step P0-C2 checkpoint failed this intervention (pitch-response slope
approximately zero), so it is a diagnostic checkpoint rather than a usable
instrument model. See `docs/p0c2-overfit-intervention-result.md`.

P0-C3 forces the decoder to use target pitch by pairing a source and a different
target note from the same preset:

```bash
PILOT_MANIFEST=/path/to/p0c1b-dexed-pilot-verified.json \
INITIAL_CONDITIONED_CHECKPOINT=/path/to/p0c2/best.ckpt \
PITCH_SWAP=1 FREEZE_ENCODER=1 PILOT_REPEATS=16 \
MAX_STEPS=2000 VAL_EVERY=250 \
DB_PATH=/path/to/spinvae_16k OUT_PATH=/path/to/checkpoints \
BRAVE_REPO=/path/to/BRAVE RUN_NAME=latent_cosmos_brave_pitch_p0c3 \
bash scripts/train_brave_pitch.sh
```

The source and target crops share a frame-aligned time origin, but always use
different MIDI notes. The final small-pilot result passed all four interventions
for 6/8 presets; it is evidence for the causal pitch path, not a general model.

P0-C4A restricts the swap pilot to the six harmonic presets that already pass,
unfreezes only the encoder tail, and trains a frame-wise source-pitch adversary:

```bash
PILOT_MANIFEST=/path/to/p0c1b-dexed-pilot-verified.json \
INITIAL_CONDITIONED_CHECKPOINT=/path/to/p0c3/best.ckpt \
PITCH_SWAP=1 \
PILOT_PRESET_INDICES=1580,12816,49633,49984,52404,63836 \
PITCH_ADVERSARY=1 PITCH_ADVERSARY_WEIGHT=0.05 \
PITCH_ADVERSARY_WARMUP_BATCHES=94 \
PITCH_ADVERSARY_UPDATES_PER_BATCH=3 \
ENCODER_TAIL_MODULES=2 PILOT_REPEATS=16 \
MAX_STEPS=500 VAL_EVERY=100 \
DB_PATH=/path/to/preprocessed OUT_PATH=/path/to/checkpoints \
BRAVE_REPO=/path/to/BRAVE RUN_NAME=latent_cosmos_brave_pitch_p0c4a \
bash scripts/train_brave_pitch.sh
```

Evaluate the harmonic subset with an external leave-one-preset-out pitch probe
and a leave-one-pitch-out preset-identity probe:

```bash
uv run --extra rave --extra analysis lcs-pitch-intervention \
  --conditioned-run /path/to/p0c4a/run \
  --baseline-run /path/to/brave/run \
  --manifest /path/to/p0c1b-dexed-pilot-verified.json \
  --preset-indices 1580,12816,49633,49984,52404,63836 \
  --output /path/to/p0c4a-probe.json
```

The first P0-C4A pilot reduced external source-pitch balanced accuracy from
0.6875 to 0.6354 while preserving 6/6 pitch intervention, but did not reach the
0.35 gate. It is a diagnostic checkpoint, not evidence of disentanglement.

The non-adversarial paired-latent experiment is enabled with
`LATENT_PITCH_CONSISTENCY_WEIGHT`. Weight 10 reached 0.5365 while preserving
6/6 control, then plateaued and regressed under an additional 1,880 batches.
Neither configuration is approved for large-corpus training; see
`docs/p0c4-scale-readiness-decision.md`.
