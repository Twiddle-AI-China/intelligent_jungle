#!/usr/bin/env bash
# 在 Spark 上以容器方式常驻 flock-voice-engine。
#
#   bash deploy/docker-run.sh build      构建镜像（在 Spark 上跑，不要在 Mac 交叉构建）
#   bash deploy/docker-run.sh start      启动
#   bash deploy/docker-run.sh stop       停止
#   bash deploy/docker-run.sh restart
#   bash deploy/docker-run.sh logs       跟随日志
#   bash deploy/docker-run.sh status
#
# 规范约束：
#   * --user 1005:1005 —— GPU-GUARD 要求容器以 rolf 身份跑，才能把进程追回到本人。
#     本服务不用 GPU，但保持同一套约定，免得以后加 GPU 时忘掉。
#   * /data 只读挂载 —— 权重是 jyhu 的目录，任何情况下都不能写。
#   * 一切限制在 /home/rolf/ 内。
set -euo pipefail

# rolf 不在 docker 组（uid 1005，组只有 rolf+sudo），但 sudo 免密可用。
# 容器仍以 --user 1005:1005 运行，所以进程归属还是 rolf，符合 GPU-GUARD 的追溯要求。
DOCKER="sudo docker"

IMAGE=rolf/flock-voice-engine:latest
NAME=flock-voice-engine
PORT=8090
PROJECT=/home/rolf/projects/flock-voice-engine

cd "$PROJECT"

case "${1:-status}" in
  build)
    echo "构建 $IMAGE …"
    $DOCKER build -f deploy/Dockerfile -t "$IMAGE" .
    ;;

  start)
    # 端口预检：被占就报错退出，不换端口试探 —— 换端口会让上游契约悄悄失效。
    if ss -lnt 2>/dev/null | grep -q ":$PORT "; then
      if [ "$($DOCKER inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; then
        echo "已在运行（容器 $NAME）"; exit 0
      fi
      echo "错误：端口 $PORT 已被非本容器的进程占用。先停掉它：" >&2
      ss -lntp 2>/dev/null | grep ":$PORT " >&2 || true
      echo "（venv 方式跑的话用 bash deploy/run.sh stop）" >&2
      exit 1
    fi
    $DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
    $DOCKER run -d \
      --name "$NAME" \
      --restart unless-stopped \
      --user 1005:1005 \
      -p "$PORT:$PORT" \
      -v /data/model_weights/midiBrave:/data/model_weights/midiBrave:ro \
      -v "$PROJECT/vendor:/app/vendor:ro" \
      -v "$PROJECT/assets:/app/assets:ro" \
      -v /home/rolf/logs:/home/rolf/logs \
      -e OMP_NUM_THREADS=8 \
      "$IMAGE"
    echo "已启动，等待就绪（模型加载约需十几秒）…"
    for _ in $(seq 1 40); do
      if curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
        echo "就绪: $(curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/healthz")"
        exit 0
      fi
      sleep 3
    done
    echo "启动超时，最近日志：" >&2
    $DOCKER logs --tail 40 "$NAME" >&2
    exit 1
    ;;

  stop)
    $DOCKER rm -f "$NAME" >/dev/null 2>&1 && echo "已停止" || echo "本来就没在跑"
    ;;

  restart)
    "$0" stop
    "$0" start
    ;;

  logs)
    $DOCKER logs -f --tail 100 "$NAME"
    ;;

  status)
    if [ "$($DOCKER inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; then
      $DOCKER ps --filter "name=$NAME" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
      echo "内存: $($DOCKER stats --no-stream --format '{{.MemUsage}}' "$NAME")"
      curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/healthz" && echo
    else
      echo "未运行"
    fi
    ;;

  *)
    echo "用法: $0 {build|start|stop|restart|logs|status}" >&2
    exit 2
    ;;
esac
