#!/usr/bin/env bash
set -euo pipefail
for directory in /data/model_weights/laion-clap /data/model_weights/huggingface; do
  if [[ ! -d "$directory" ]]; then
    echo "ERROR: $directory does not exist. Create it with sudo and grant it to $(id -un)." >&2
    exit 1
  fi
  if [[ ! -w "$directory" ]]; then
    echo "ERROR: $directory is not writable by $(id -un)." >&2
    exit 1
  fi
done
docker run --rm \
  -v /data/model_weights:/data/model_weights \
  -e HF_HOME=/data/model_weights/huggingface \
  -e HF_ENDPOINT=https://hf-mirror.com \
  midibrave:v0.1 bash -lc '
    python -c "from transformers import BertTokenizer, RobertaModel; BertTokenizer.from_pretrained(\"bert-base-uncased\"); RobertaModel.from_pretrained(\"roberta-base\")"
    if [[ ! -f /data/model_weights/laion-clap/music_audioset_epoch_15_esc_90.14.pt.complete ]]; then
      curl --fail --location --continue-at - \
        --retry 30 --retry-delay 2 --retry-all-errors \
        --connect-timeout 20 --speed-limit 1024 --speed-time 60 \
        --output /data/model_weights/laion-clap/music_audioset_epoch_15_esc_90.14.pt \
        https://hf-mirror.com/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt
      touch /data/model_weights/laion-clap/music_audioset_epoch_15_esc_90.14.pt.complete
    fi
    chown -R 1004:1004 /data/model_weights/laion-clap /data/model_weights/huggingface
  '
