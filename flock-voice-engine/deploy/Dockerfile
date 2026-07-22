# flock-voice-engine —— 在 DGX Spark (aarch64) 上常驻的音源服务。
#
# GPU 版本(2026-07-21 起)：torch 不在镜像里装，运行时挂载宿主机那份。
#   Spark 系统 python3 (3.12) 自带 torch==2.12.1+cu130 + 全套 CUDA 13 依赖
#   (nvidia-cudnn-cu13 / nvidia-nccl-cu13 / nvidia-nvshmem-cu13 …) ——
#   这是 NVIDIA 针对 DGX Spark GB10 (Blackwell, sm_121a) 专门构建的版本,
#   PyPI/清华镜像上没有对应 aarch64 wheel,装了大概率装错(要么装不上,
#   要么装到不匹配这颗 GPU 的通用 CUDA 版本)。tools/test_gpu_device.py
#   已经用宿主机这份实测过(brave-voices pool=4 GPU p95 17.87ms，CPU
#   p95 104.79ms，见 2026-07-21 记录)——容器要跑的必须是同一份,不是
#   another 装出来的、行为未知的版本。见 docker-run.sh 的
#   /usr/local/lib/python3.12/dist-packages 只读挂载 + PYTHONPATH。
#   镜像里只装宿主机没有的轻量纯 Python 依赖(aiohttp/scipy/soundfile)。
#
# 构建（在 Spark 上，不要在 Mac 上交叉构建）：
#   cd /home/rolf/projects/flock-voice-engine
#   docker build -f deploy/Dockerfile -t rolf/flock-voice-engine:latest .
#
# 运行见 deploy/docker-run.sh —— 必须 --user 1005:1005（GPU-GUARD 规范）+
# --gpus all；权重、vendor 源码、宿主机 site-packages 都用挂载而不是 COPY 进镜像。

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

# 宿主机 site-packages 挂载带来 torch / numpy（都在 /usr/local/lib/python3.12/
# dist-packages，pip 管的那份）。pyyaml 是 apt 装的，在另一个路径
# （/usr/lib/python3/dist-packages），没跟着这次挂载一起进来，干脆跟
# aiohttp/scipy/soundfile 一起在镜像里装了，省得再挂一个目录。
# 装到独立目录（不是默认 site-packages）——运行时的只读挂载会整个目录
# 覆盖掉容器自己的 /usr/local/lib/python3.12/dist-packages，装在那儿会被
# 挂载遮住，见 docker-run.sh 的 PYTHONPATH 顺序（先 host 挂载，再这个目录）。
RUN pip install --no-cache-dir --target=/opt/pydeps --timeout 180 --retries 10 \
      aiohttp pyyaml scipy soundfile

ENV PYTHONPATH=/opt/host-site-packages:/opt/pydeps

WORKDIR /app

# 只 COPY 代码。权重(/data/model_weights)、vendor 源码、assets 都用挂载 ——
# 权重 96 MB 且是别人的只读目录，不该进镜像；vendor 是 jyhu 源码的镜像副本，
# 挂载能保证容器里跑的就是宿主机上那一份，避免版本漂移。
COPY server/ /app/server/

EXPOSE 8090

# 线程数：GPU 路径下 render 不再是纯 CPU 瓶颈，但 CLAP/预处理等边角逻辑
# 仍可能用到 —— 保留同一套线程配置，不为了"反正用 GPU 了"就随便改。
ENV OMP_NUM_THREADS=16 \
    MKL_NUM_THREADS=8

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/healthz',timeout=4).status==200 else 1)"

ENTRYPOINT ["python3", "-u", "-m", "server.app"]
CMD ["--host", "0.0.0.0", "--port", "8090", "--backend", "brave-voices", "--device", "cuda"]
