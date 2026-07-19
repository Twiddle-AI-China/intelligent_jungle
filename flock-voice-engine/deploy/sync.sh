#!/usr/bin/env bash
# 从本机把 flock-voice-engine 代码同步到 Spark。
#
#   bash deploy/sync.sh            # 同步代码
#   bash deploy/sync.sh --restart  # 同步后顺带重启服务
#
# 用 expect 应答密码（Spark 上没装 sshpass，本机也不一定有）。
# 注意：绝不要用 `ssh ... bash -s < file`，会和密码提示死锁。
set -euo pipefail

REMOTE_USER=rolf
REMOTE_HOST=192.168.9.140
REMOTE_PASS=shiyuxuan
REMOTE_DIR=/home/rolf/projects/flock-voice-engine

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v expect >/dev/null || { echo "错误：本机需要 expect" >&2; exit 1; }

# rsync 排除：虚拟环境、权重、音频产物、缓存、git 全部不传
#
# 【重要】绝对不要加 --delete-excluded。
# --delete 配合 --exclude 时，被排除的路径在接收端是"受保护"的，不会被删；
# 而 --delete-excluded 恰恰相反 —— 它会把接收端所有匹配排除规则的文件删掉，
# 也就是把服务器上的 .venv/ 和 vendor/ 一起清空。（本项目已经踩过一次这个坑。）
rsync_cmd=(
  rsync -az --delete
  --exclude '.venv/'
  --exclude '.git/'
  --exclude '__pycache__/'
  --exclude '*.pyc'
  --exclude '*.pt'
  --exclude '*.ckpt'
  --exclude '*.safetensors'
  --exclude '*.wav'
  --exclude '*.flac'
  --exclude '*.mp3'
  --exclude '*.ogg'
  --exclude 'staging/'
  --exclude 'vendor/'
  --exclude '.DS_Store'
  "$LOCAL_DIR/"
  "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"
)

echo "同步 $LOCAL_DIR → $REMOTE_HOST:$REMOTE_DIR"
# 用 RSYNC_RSH 而不是 rsync -e：-e 的值带空格，经 expect spawn 会被再切一次词
export RSYNC_RSH='ssh -o StrictHostKeyChecking=no'
expect -c "
set timeout 600
spawn ${rsync_cmd[*]}
expect {
  -re {assword:} { send \"$REMOTE_PASS\r\"; exp_continue }
  eof
}
catch wait result
exit [lindex \$result 3]
"

echo "同步完成"

if [[ "${1:-}" == "--restart" ]]; then
  echo "重启远端服务..."
  expect -c "
  set timeout 180
  spawn ssh -o StrictHostKeyChecking=no $REMOTE_USER@$REMOTE_HOST {bash $REMOTE_DIR/deploy/run.sh restart}
  expect {
    -re {assword:} { send \"$REMOTE_PASS\r\"; exp_continue }
    eof
  }
  catch wait result
  exit [lindex \$result 3]
  "
fi
