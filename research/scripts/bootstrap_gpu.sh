#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CUDA_VISIBLE_DEVICES:-}" ]]; then
  echo "Run this script inside qgpu; CUDA_VISIBLE_DEVICES is unset." >&2
  exit 2
fi

if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# The RTX host's route to PyPI is substantially slower than its regional
# mirror. uv still verifies the hashes pinned in uv.lock.
export UV_DEFAULT_INDEX="${UV_DEFAULT_INDEX:-https://mirrors.aliyun.com/pypi/simple}"
uv python install 3.11
uv sync --python 3.11 --extra rave --extra analysis
ffmpeg_paths="$(uv run static_ffmpeg_paths)"
ffmpeg_path="$(printf '%s\n' "$ffmpeg_paths" | sed -n 's/^FFMPEG=//p')"
ffprobe_path="$(printf '%s\n' "$ffmpeg_paths" | sed -n 's/^FFPROBE=//p')"
test -x "$ffmpeg_path" && test -x "$ffprobe_path"
python_version="$(uv run python -c 'import sys; print(sys.version.split()[0])')"
torch_status="$(uv run python -c 'import torch; print(torch.__version__, torch.cuda.is_available())')"
rave_status="$(uv run rave --help >/dev/null && printf ready)"
printf 'python=%s\ntorch=%s\nrave_cli=%s\nffmpeg=%s\nffprobe=%s\n' "$python_version" "$torch_status" "$rave_status" "$ffmpeg_path" "$ffprobe_path"
