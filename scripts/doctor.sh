#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

failures=0
fail() {
  echo "[失败] $1" >&2
  failures=$((failures + 1))
}

for command in docker curl python3 uname; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令 $command"
done

architecture="$(uname -m 2>/dev/null || true)"
[[ "$architecture" == "aarch64" ]] || fail "需要 DGX Spark aarch64，当前是 ${architecture:-unknown}"

if ! lcs_docker info >/dev/null 2>&1; then
  fail "当前用户无法访问 Docker daemon；请加入 docker 组或配置免交互 sudo docker"
elif ! lcs_docker info --format '{{json .Runtimes}}' | grep -q 'nvidia'; then
  fail "Docker 未发现 nvidia runtime；请安装 NVIDIA Container Toolkit"
fi

[[ -d "$LCS_HOST_SITE_PACKAGES" ]] \
  || fail "宿主 Python 依赖目录不存在: $LCS_HOST_SITE_PACKAGES"

if [[ -d "$LCS_HOST_SITE_PACKAGES" ]]; then
  if ! PYTHONPATH="$LCS_HOST_SITE_PACKAGES" python3 -c \
    'import torch; assert str(torch.version.cuda or "").startswith("13."); assert torch.cuda.is_available(); print(f"Torch {torch.__version__}, CUDA {torch.version.cuda}")'; then
    fail "宿主 Torch 必须支持 CUDA 13 且 torch.cuda.is_available() 为 true"
  fi
fi

if (( failures > 0 )); then
  echo "环境检查失败，共 $failures 项。未修改容器或模型文件。" >&2
  exit 1
fi

echo "环境检查通过：DGX Spark、Docker、NVIDIA runtime、Torch/CUDA 均可用。"
