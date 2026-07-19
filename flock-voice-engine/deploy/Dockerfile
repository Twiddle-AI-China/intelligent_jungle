# flock-voice-engine —— 在 DGX Spark (aarch64) 上常驻的音源服务。
#
# 为什么基础镜像不带 torch：
#   Spark 的系统 python3 已经有 aarch64 版 torch 2.12.1+cu130，但那是宿主机的。
#   容器里要自己装。ARM64 的官方 torch wheel 走 PyPI 默认源在国内极慢，
#   所以用清华镜像；CPU-only 版本足够 —— 本服务不碰 GPU（也就不用过 qgpu）。
#
# 构建（在 Spark 上，不要在 Mac 上交叉构建）：
#   cd /home/rolf/projects/flock-voice-engine
#   docker build -f deploy/Dockerfile -t rolf/flock-voice-engine:latest .
#
# 运行见 deploy/docker-run.sh —— 必须 --user 1005:1005（GPU-GUARD 规范），
# 权重和 vendor 源码用挂载而不是 COPY 进镜像。

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn

# torch 单独一层：它最大、最少变，放前面利用缓存
RUN pip install --no-cache-dir \
      --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
      "torch==2.*" --extra-index-url https://download.pytorch.org/whl/cpu

# 服务端运行期依赖只有这三个。soundfile/librosa 只被 tools/ 的离线分析脚本用，
# 不进服务镜像 —— 它们要 libsndfile，会额外引入一个 apt 层和一个构建失败点。
RUN pip install --no-cache-dir aiohttp numpy pyyaml

WORKDIR /app

# 只 COPY 代码。权重(/data/model_weights)、vendor 源码、assets 都用挂载 ——
# 权重 96 MB 且是别人的只读目录，不该进镜像；vendor 是 jyhu 源码的镜像副本，
# 挂载能保证容器里跑的就是宿主机上那一份，避免版本漂移。
COPY server/ /app/server/

EXPOSE 8090

# 线程数：这台机器 20 核，但 8081 的 vLLM 也在跑，别把核占满。
ENV OMP_NUM_THREADS=8 \
    MKL_NUM_THREADS=8

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/healthz',timeout=4).status==200 else 1)"

ENTRYPOINT ["python3", "-u", "-m", "server.app"]
CMD ["--host", "0.0.0.0", "--port", "8090", "--backend", "brave"]
