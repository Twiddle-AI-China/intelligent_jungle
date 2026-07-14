# Model research pipeline

```bash
cd research
uv sync                    # corpus/atlas tooling only
uv sync --extra rave --extra analysis  # model training and TorchScript bake-off
uv run lcs-corpus ../data/corpus/v1 --duration 1800
uv run lcs-bakeoff --backend torchscript --model /path/model.ts --voices 6 --stress-seconds 1800 --output ../reports/rave-6v.json
uv run lcs-gate ../reports/rave-6v.json
uv run lcs-atlas ../renders/model-v1 ../reports/atlas-v1.json
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

The RTX 5080 host currently defaults to Python 3.13. Run `bootstrap_gpu.sh` inside a short qgpu allocation first; it installs an isolated Python 3.11 environment through `uv`. RAVE 2.3.1 pins SciPy 1.10 and Lightning 1.9, so Python 3.12 is intentionally excluded. Torch/Torchaudio 2.11 are pinned to keep the Blackwell-compatible CUDA stack observed in the host probe instead of silently upgrading the experiment environment.

RAVE shells out to both `ffmpeg` and `ffprobe`. The locked `static-ffmpeg` dependency installs the two binaries without elevated privileges, and the scripts fail before spawning RAVE workers if either executable is missing. This avoids RAVE 2.3's otherwise silent multiprocessing deadlock.

The procedural corpus is stored at 48 kHz, while preprocessing defaults to 44.1 kHz because the official BRAVE configuration fixes that model rate. The eventual 48 kHz CoreAudio host must include sample-rate conversion in its measured latency; changing BRAVE's architecture merely to remove that boundary is not an admissible baseline comparison.

All model commands call `uv run` explicitly; qgpu jobs do not rely on an activated interactive shell. BRAVE is trained at the corpus sample rate using its official `configs/brave.gin`; the RAVE comparator uses the official `v2 + causal` configuration. Export is a separate gate because a successful checkpoint does not prove streaming latency.

External model/config revisions used for the experiment are recorded in `model-sources.lock.json`; update that file intentionally when changing a source revision.

Do not commit `data/`, `renders/`, `reports/*.json` generated from experiments, checkpoints, `.venv`, or model weights.
