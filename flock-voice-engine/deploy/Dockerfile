# Intelligent Jungle 神经音源服务镜像（DGX Spark / aarch64）。
#
# DGX Spark 系统提供经过 GB10 验证的 torch 2.12.1+cu130 与 CUDA 13 Python
# 包；运行时以只读目录挂到 /opt/host-site-packages。镜像只安装音源服务缺少的
# 轻量依赖，不安装 vLLM，也不包含任何通用 LLM 或神经音源权重。

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --target=/opt/pydeps --timeout 180 --retries 10 \
      aiohttp pyyaml scipy soundfile

ENV PYTHONPATH=/opt/host-site-packages:/opt/pydeps:/app \
    OMP_NUM_THREADS=16 \
    MKL_NUM_THREADS=8

WORKDIR /app
COPY server/ /app/server/

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/healthz',timeout=4).status==200 else 1)"

ENTRYPOINT ["python3", "-u", "-m", "server.app"]
