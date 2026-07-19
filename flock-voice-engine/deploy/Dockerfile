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

# libsndfile1：vendor 的 midibrave 源码 import soundfile。
# （这一层当初被删过，因为容器内 DNS 解析失败；根因是 BuildKit 的网络命名空间，
#  已由 docker-run.sh 的 --network=host 解决，与 apt 源本身无关。）
RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# torch 单独一层：它最大、最少变，放前面利用缓存。
#
# 索引源的组合是踩出来的，两个都不能少：
#   --index-url  download.pytorch.org/whl/cpu  → torch 本身。这里的 aarch64 wheel
#       是 **CPU-only** 的；若从 PyPI/清华解析，会拖进全套 CUDA 依赖
#       (nvidia_cusolver 223MB、nvidia_cusparse 162MB…)，镜像膨胀到数 GB，
#       而本服务一个 CUDA 包都用不上。
#   --extra-index-url  清华  → torch 的纯 Python 依赖(sympy/networkx/jinja2…)。
#       只挂 CPU 源的话这些解析不到；只挂清华的话又会拿到 GPU 版 torch。
# 超时/重试放宽：默认 15 秒对几百 MB 的 wheel 必然中断。
RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
      --timeout 180 --retries 10 \
      "torch==2.*"

# 依赖必须同时覆盖 server/ 与 vendor/midibrave —— 后者 import scipy(PQMF firwin)、
# soundfile、yaml。只清点 server/ 的话会漏，表现为容器启动时 ModuleNotFoundError。
RUN pip install --no-cache-dir --timeout 180 --retries 10 \
      aiohttp numpy pyyaml scipy soundfile

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
