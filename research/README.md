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

The exported model adds `decode_conditioned` taking
`[batch, latent_size + 3, latent_frames]` (latent, then f0_hz/loudness/gate)
and embeds the `conditioning_schema` attribute; loaders must validate that ID
instead of guessing channel order. A smoke checkpoint exporting and loading
does not claim pitch control.

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
