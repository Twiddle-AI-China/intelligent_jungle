#!/usr/bin/env bash
#SBATCH --job-name=mbv2-roberta-cache
#SBATCH --partition=gpu1
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:1
#SBATCH --mem=15G
#SBATCH --time=02:00:00
#SBATCH --output=/home/jyhu/MidiBrave-v2/artifacts/roberta-cache-%j.out
set -euo pipefail
mkdir -p /home/jyhu/MidiBrave-v2/artifacts /data/model_weights/huggingface/hub
srun --kill-on-bad-exit=1 docker run --rm \
  --gpus "device=${CUDA_VISIBLE_DEVICES}" --shm-size=8g \
  -v /home/jyhu/MidiBrave-v2:/workspace/MidiBrave -v /data:/data \
  -w /workspace/MidiBrave -e PYTHONPATH=/workspace/MidiBrave/src \
  -e HF_HOME=/data/model_weights/huggingface \
  -e HF_ENDPOINT=https://hf-mirror.com \
  midibrave:v0.9.0-five-model-fp16 bash -lc '
    set -euo pipefail
    python -c "from huggingface_hub import snapshot_download; print(snapshot_download(repo_id=\"roberta-base\", cache_dir=\"/data/model_weights/huggingface/hub\", allow_patterns=[\"config.json\",\"merges.txt\",\"vocab.json\",\"tokenizer.json\",\"tokenizer_config.json\",\"special_tokens_map.json\",\"model.safetensors\"]))"
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 python -c "import laion_clap; model=laion_clap.CLAP_Module(enable_fusion=False, amodel=\"HTSAT-base\", device=\"cuda\"); model.load_ckpt(\"/data/model_weights/laion-clap/music_audioset_epoch_15_esc_90.14.pt\"); value=model.get_text_embedding([\"tonal synthesizer\"], use_tensor=True); print({\"offline_clap_ok\": bool(value.isfinite().all().item()), \"shape\": list(value.shape)})"
  '
