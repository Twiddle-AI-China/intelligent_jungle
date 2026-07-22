#!/usr/bin/env bash
# 在 Spark 上以容器方式常驻 flock-voice-engine。
#
#   bash deploy/docker-run.sh build      构建镜像（在 Spark 上跑，不要交叉构建）
#   bash deploy/docker-run.sh start      启动
#   bash deploy/docker-run.sh stop       停止
#   bash deploy/docker-run.sh restart    重启
#   bash deploy/docker-run.sh logs       跟随日志
#   bash deploy/docker-run.sh status     只读核对运行身份
set -euo pipefail

EXPECTED_OPERATOR=yfhuang
if [[ "$(id -un)" != "$EXPECTED_OPERATOR" ]]; then
  echo "错误：本服务只允许 $EXPECTED_OPERATOR 操作" >&2
  exit 1
fi
docker info >/dev/null 2>&1 || {
  echo "错误：$EXPECTED_OPERATOR 当前不能访问 Docker；不要改用其它账号或 sudo 绕过" >&2
  exit 1
}

DOCKER=docker
IMAGE=twiddle/flock-voice-engine:latest
NAME=flock-voice-engine
PORT=8090
PROJECT=/srv/deploy/flock-voice-engine
LOG_DIR="$PROJECT/logs"
RUN_UID="$(id -u)"
RUN_GID="$(id -g)"

# 宿主机 site-packages：torch==2.12.1+cu130 与 CUDA 13 依赖经过本机验证。
# 挂到独立路径，由 Dockerfile 的 PYTHONPATH 引用；不得写回宿主机。
HOST_SITE_PACKAGES=/usr/local/lib/python3.12/dist-packages

preflight_release() {
  local revision_file="$PROJECT/.release-revision"
  local manifest_sha_file="$PROJECT/.release-source-manifest.sha256"
  [[ -r "$revision_file" ]] || {
    echo "错误：缺少 $revision_file；拒绝启动无法追溯的 release" >&2
    return 1
  }
  [[ -r "$manifest_sha_file" ]] || {
    echo "错误：缺少 $manifest_sha_file；拒绝启动没有源码 manifest 的 release" >&2
    return 1
  }
  RELEASE_REVISION="$(tr -d '\r\n' < "$revision_file")"
  SOURCE_MANIFEST_SHA256="$(tr -d '\r\n' < "$manifest_sha_file")"
  [[ "$RELEASE_REVISION" =~ ^[0-9a-f]{40}$ ]] || {
    echo "错误：release revision 必须是完整 40 位 Git SHA" >&2
    return 1
  }
  [[ "$SOURCE_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
    echo "错误：source manifest hash 必须是 64 位 SHA-256" >&2
    return 1
  }
}

verify_status_identity() {
  python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
    expected = {
        "releaseRevision": sys.argv[1],
        "sourceManifestSha256": sys.argv[2],
        "protocolFamily": "legacy-decoder",
        "protocolVersion": 1,
        "runtimeOwner": "browser",
        "audioOwner": "legacy",
    }
    valid = type(payload) is dict
    valid = valid and all(type(payload.get(key)) is type(value) for key, value in expected.items())
    valid = valid and all(payload.get(key) == value for key, value in expected.items())
except (json.JSONDecodeError, OSError, TypeError, ValueError):
    valid = False

if not valid:
    print("release identity mismatch", file=sys.stderr)
    raise SystemExit(1)
' "$RELEASE_REVISION" "$SOURCE_MANIFEST_SHA256"
}

start_container() {
  install -d "$LOG_DIR"

  # 端口被占时拒绝悄悄换契约端口；现有同名容器已经运行则保持幂等。
  if ss -lnt 2>/dev/null | grep -q ":$PORT "; then
    if [ "$($DOCKER inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; then
      echo "已在运行（容器 $NAME）"
      return 0
    fi
    echo "错误：端口 $PORT 已被非本容器的进程占用，请先确认归属后处理" >&2
    ss -lntp 2>/dev/null | grep ":$PORT " >&2 || true
    return 1
  fi

  $DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
  $DOCKER run -d \
    --name "$NAME" \
    --restart unless-stopped \
    --user "$RUN_UID:$RUN_GID" \
    --gpus all \
    -p "$PORT:$PORT" \
    -v /data/model_weights/midiBrave:/data/model_weights/midiBrave:ro \
    -v "$HOST_SITE_PACKAGES:/opt/host-site-packages:ro" \
    -v "$PROJECT/server:/app/server:ro" \
    -v "$PROJECT/vendor:/app/vendor:ro" \
    -v "$PROJECT/assets:/app/assets:ro" \
    -v "$PROJECT/web:/app/web:ro" \
    -v "$LOG_DIR:/app/logs" \
    -e FLOCK_VOICE_LOAD_LOG=/app/logs/flock-voice-load.jsonl \
    -e FLOCK_BUILD_REVISION="$RELEASE_REVISION" \
    -e FLOCK_SOURCE_MANIFEST_SHA256="$SOURCE_MANIFEST_SHA256" \
    -e FLOCK_RUNTIME_OWNER=browser \
    -e FLOCK_AUDIO_OWNER=legacy \
    -e OMP_NUM_THREADS=16 \
    --cpu-shares=262144 \
    "$IMAGE" \
    --host 0.0.0.0 --port "$PORT" --backend brave-voices --device cuda \
    --block-samples 4096 --pool-size 5 --static /app/web

  echo "已启动，等待就绪（模型加载约需十几秒）…"
  for _ in $(seq 1 40); do
    if curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
      echo "就绪"
      return 0
    fi
    sleep 3
  done
  echo "启动超时，最近日志：" >&2
  $DOCKER logs --tail 40 "$NAME" >&2
  return 1
}

stop_container() {
  $DOCKER rm -f "$NAME" >/dev/null 2>&1 && echo "已停止" || echo "本来就没在跑"
}

status_container() {
  if [ "$($DOCKER inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; then
    preflight_release
    curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/healthz" | verify_status_identity
    $DOCKER ps --filter "name=$NAME" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    $DOCKER stats --no-stream --format '内存: {{.MemUsage}}' "$NAME"
  else
    echo "未运行"
  fi
}

case "${1:-status}" in
  build)
    echo "构建 $IMAGE …"
    (
      cd "$PROJECT"
      $DOCKER build --network=host -f deploy/Dockerfile -t "$IMAGE" .
    )
    ;;

  start)
    preflight_release
    start_container
    ;;

  stop)
    stop_container
    ;;

  restart)
    preflight_release
    stop_container
    start_container
    ;;

  logs)
    $DOCKER logs -f --tail 100 "$NAME"
    ;;

  status)
    status_container
    ;;

  *)
    echo "用法: $0 {build|start|stop|restart|logs|status}" >&2
    exit 2
    ;;
esac
