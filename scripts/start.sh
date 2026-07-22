#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

python3 "$SCRIPT_DIR/model_assets.py" verify \
  --manifest "$LCS_ROOT/config/model-assets.json" \
  --output "$LCS_ENGINE_ROOT/model_weights/midiBrave"
python3 "$SCRIPT_DIR/assemble_web.py" \
  --root "$LCS_ROOT" \
  --output "$LCS_ROOT/runtime/web"
mkdir -p "$LCS_ROOT/runtime/logs"

if lcs_docker inspect "$LCS_CONTAINER_NAME" >/dev/null 2>&1; then
  lcs_docker rm -f "$LCS_CONTAINER_NAME" >/dev/null
fi

if command -v ss >/dev/null 2>&1 && ss -lnt | grep -q ":$LCS_HOST_PORT "; then
  echo "错误：端口 $LCS_HOST_PORT 已被其他进程占用；不会换端口或停止其他服务。" >&2
  ss -lntp 2>/dev/null | grep ":$LCS_HOST_PORT " >&2 || true
  exit 1
fi

agent_key_args=()
if [[ -n "${LCS_AGENT_API_KEY:-}" ]]; then
  agent_key_args=(-e LCS_AGENT_API_KEY)
fi

lcs_docker run -d \
  --name "$LCS_CONTAINER_NAME" \
  --restart unless-stopped \
  --init \
  --user "$(id -u):$(id -g)" \
  --gpus all \
  --add-host host.docker.internal:host-gateway \
  --cpu-shares 262144 \
  -p "$LCS_HOST_PORT:$LCS_CONTAINER_PORT" \
  -v "$LCS_HOST_SITE_PACKAGES:/opt/host-site-packages:ro" \
  -v "$LCS_ENGINE_ROOT/server:/app/server:ro" \
  -v "$LCS_ENGINE_ROOT/vendor:/app/vendor:ro" \
  -v "$LCS_ENGINE_ROOT/assets:/app/assets:ro" \
  -v "$LCS_ENGINE_ROOT/model_weights/midiBrave:/app/model_weights/midiBrave:ro" \
  -v "$LCS_ROOT/runtime/web:/app/web:ro" \
  -v "$LCS_ROOT/config:/app/config:ro" \
  -v "$LCS_ROOT/runtime:/app/runtime" \
  -e OMP_NUM_THREADS=16 \
  -e MKL_NUM_THREADS=8 \
  -e LCS_RUNTIME_CONFIG=/app/config/runtime.json \
  -e LCS_STATIC_ROOT=/app/web \
  -e LCS_MODEL_DIR=/app/model_weights/midiBrave \
  -e LCS_LOAD_LOG_PATH=/app/runtime/logs/flock-voice-load.jsonl \
  "${agent_key_args[@]}" \
  "$LCS_IMAGE" >/dev/null

echo "容器已启动，等待神经模型加载。"
for attempt in $(seq 1 60); do
  if curl -fsS --noproxy '*' "http://127.0.0.1:$LCS_HOST_PORT/healthz" >/dev/null 2>&1; then
    echo "服务已就绪: http://127.0.0.1:$LCS_HOST_PORT/"
    curl -fsS --noproxy '*' "http://127.0.0.1:$LCS_HOST_PORT/api/runtime-status"
    echo
    exit 0
  fi
  if [[ "$(lcs_docker inspect -f '{{.State.Running}}' "$LCS_CONTAINER_NAME" 2>/dev/null || true)" != "true" ]]; then
    echo "容器在就绪前退出，最近日志：" >&2
    lcs_docker logs --tail 80 "$LCS_CONTAINER_NAME" >&2 || true
    exit 1
  fi
  if (( attempt % 10 == 0 )); then
    echo "仍在加载模型（${attempt}/60）"
  fi
  sleep 3
done

echo "启动超时，最近日志：" >&2
lcs_docker logs --tail 80 "$LCS_CONTAINER_NAME" >&2 || true
exit 1
