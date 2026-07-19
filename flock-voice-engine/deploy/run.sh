#!/usr/bin/env bash
# flock-voice-engine 服务管理脚本（在 Spark 上运行）。
#
# 用法：
#   bash deploy/run.sh start [--backend synth|brave|silent] [其他 app.py 参数...]
#   bash deploy/run.sh stop
#   bash deploy/run.sh restart
#   bash deploy/run.sh status
#   bash deploy/run.sh logs [行数]
#   bash deploy/run.sh mem        # 打印当前 RSS 实测值
#
# 为什么是 venv 不是 Docker：见 docs/deploy.md「为什么不用容器」。
set -euo pipefail

PROJECT_DIR=/home/rolf/projects/flock-voice-engine
VENV="$PROJECT_DIR/.venv"
PY="$VENV/bin/python"
LOG_DIR=/home/rolf/logs
LOG_FILE="$LOG_DIR/flock-voice-engine.log"
PID_FILE="$LOG_DIR/flock-voice-engine.pid"
PORT=8090

mkdir -p "$LOG_DIR"

# 取运行中的 PID（存在且活着才回显）
running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

cmd_start() {
  if pid=$(running_pid); then
    echo "已经在跑了 (pid=$pid)。要重启用 restart。"
    exit 0
  fi
  # 端口占用检查：8090 是本项目的硬约束，被别人占了就停手，不要换端口去试探
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
    echo "错误：端口 $PORT 已被占用。不要改端口，先查清楚是谁占的。" >&2
    ss -ltnp 2>/dev/null | grep ":$PORT" >&2 || true
    exit 1
  fi
  [[ -x "$PY" ]] || { echo "错误：venv 不存在，先跑 docs/deploy.md 里的首次安装步骤" >&2; exit 1; }

  cd "$PROJECT_DIR"
  # setsid + nohup：脱离 SSH 会话，断开连接不会带走服务
  setsid nohup "$PY" -u -m server.app --host 0.0.0.0 --port "$PORT" "$@" \
    >>"$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
  sleep 3

  if pid=$(running_pid); then
    echo "已启动 pid=$pid，日志 $LOG_FILE"
    # 本机自检（服务器上没有代理问题）
    if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz"; then
      echo
      cmd_mem
    else
      echo "警告：进程活着但 /healthz 没响应，看日志：bash deploy/run.sh logs" >&2
      exit 1
    fi
  else
    echo "启动失败，日志尾部：" >&2
    tail -30 "$LOG_FILE" >&2
    exit 1
  fi
}

cmd_stop() {
  if pid=$(running_pid); then
    kill "$pid"
    for _ in $(seq 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "已停止 pid=$pid"
  else
    echo "没在跑"
    rm -f "$PID_FILE"
  fi
}

cmd_status() {
  if pid=$(running_pid); then
    echo "运行中 pid=$pid"
    ps -o pid,rss,etime,cmd -p "$pid" | tail -n +1
    curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" && echo
  else
    echo "未运行"
    exit 1
  fi
}

cmd_mem() {
  if pid=$(running_pid); then
    local rss_kb
    rss_kb=$(awk '/VmRSS/{print $2}' "/proc/$pid/status")
    echo "内存 RSS: $((rss_kb / 1024)) MiB (预算 4096 MiB)"
  else
    echo "未运行" >&2
    exit 1
  fi
}

case "${1:-}" in
  start)   shift; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  restart) shift; cmd_stop; cmd_start "$@" ;;
  status)  cmd_status ;;
  mem)     cmd_mem ;;
  logs)    tail -n "${2:-80}" "$LOG_FILE" ;;
  *)       echo "用法: $0 {start|stop|restart|status|mem|logs}" >&2; exit 2 ;;
esac
