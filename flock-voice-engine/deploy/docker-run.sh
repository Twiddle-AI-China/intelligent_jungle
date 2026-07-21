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
#   * --gpus all（2026-07-21 起）—— GPU 版本需要 nvidia-container-toolkit 把宿主机
#     驱动库（libcuda.so 等）注入容器；torch 本体走只读挂载，不在镜像里装，
#     理由见 Dockerfile 顶部注释。
#   * /data 只读挂载 —— 权重是 jyhu 的目录，任何情况下都不能写。
#   * 一切限制在 /home/rolf/ 内。
set -euo pipefail

# 宿主机 site-packages：torch==2.12.1+cu130 + 全套 CUDA13 依赖就在这儿，
# 是 tools/test_gpu_device.py 实测过的那一份（brave-voices pool=4 GPU p95
# 17.87ms）。挂到容器里一个不冲突的路径，靠 Dockerfile 里的 PYTHONPATH 拼进去。
HOST_SITE_PACKAGES=/usr/local/lib/python3.12/dist-packages

# rolf 不在 docker 组（uid 1005，组只有 rolf+sudo），但 sudo 免密可用。
# 容器仍以 --user 1005:1005 运行，所以进程归属还是 rolf，符合 GPU-GUARD 的追溯要求。
DOCKER="sudo docker"

IMAGE=rolf/flock-voice-engine:latest
NAME=flock-voice-engine
PORT=8090
PROJECT=/home/rolf/projects/flock-voice-engine

cd "$PROJECT"

# server/ 既 COPY 进镜像又在这里挂载：挂载会**遮蔽**镜像里的副本，好处是改代码
# 只要 restart 不用 rebuild（rebuild 要重下 torch，很慢）。镜像里的那份留作
# 兜底 —— 万一挂载路径不存在，容器仍能用镜像自带的代码起来。

case "${1:-status}" in
  build)
    echo "构建 $IMAGE …"
    $DOCKER build --network=host -f deploy/Dockerfile -t "$IMAGE" .
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
      --gpus all \
      -p "$PORT:$PORT" \
      -v /data/model_weights/midiBrave:/data/model_weights/midiBrave:ro \
      -v "$HOST_SITE_PACKAGES:/opt/host-site-packages:ro" \
      -v "$PROJECT/server:/app/server:ro" \
      -v "$PROJECT/vendor:/app/vendor:ro" \
      -v "$PROJECT/assets:/app/assets:ro" \
      -v "$PROJECT/web:/app/web:ro" \
      -v /home/rolf/logs:/home/rolf/logs \
      -e OMP_NUM_THREADS=16 \
      --cpu-shares=262144 \
      "$IMAGE" \
      --host 0.0.0.0 --port "$PORT" --backend brave-voices --device cuda \
      --pool-size 7 --static /app/web
      # pool-size 7，不是全局默认的 4：pad 和弦占了 3 行增补(行 4/5/6，
      # 见 server/backends/brave_voices.py 模块 docstring)。只在这里显式传，
      # 不改 server/config.py 的 DEFAULT_POOL_SIZE —— 那个默认值被 synth/silent
      # 后端和其它工具共用，不该因为 brave-voices 这一个后端的需要被改动。
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
