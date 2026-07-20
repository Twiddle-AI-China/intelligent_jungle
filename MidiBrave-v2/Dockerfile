FROM train_base@sha256:2cf10849c51ad273b8bc44504e201105a02e89a7ad73f6b9e335165a2e9bc5d2

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DEFAULT_TIMEOUT=600 \
    TORCH_HOME=/data/model_weights/torchcrepe \
    HF_HOME=/data/model_weights/huggingface \
    PYTORCH_KERNEL_CACHE_PATH=/tmp/torch-kernels

WORKDIR /workspace/MidiBrave
COPY pyproject.toml README.md ./
RUN python -m pip install --no-deps torchcrepe==0.0.24
RUN python -m pip install --no-deps laion-clap==1.1.7
RUN python -m pip install \
    soundfile==0.12.1 pytest==8.3.5 librosa==0.11.0 resampy==0.4.3 \
    torchlibrosa==0.1.0 ftfy==6.3.1 braceexpand==0.1.7 \
    webdataset==1.0.2 wget==3.2 progressbar==2.5
RUN python -m pip install numpy==1.26.4 && \
    python -m pip uninstall -y opencv-python-headless
COPY src ./src
RUN python -m pip install --no-deps -e .
RUN mkdir -p /tmp/torch-kernels && chmod 1777 /tmp/torch-kernels

CMD ["/bin/bash"]
