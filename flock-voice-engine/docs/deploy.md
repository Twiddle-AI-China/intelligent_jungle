# flock-voice-engine Spark 部署

服务跑在 DGX Spark（`rolf@192.168.9.140`），监听 **8090**，局域网可直接访问。

- 健康检查：`http://192.168.9.140:8090/healthz`
- 后端自述：`http://192.168.9.140:8090/api/decoder-status`
- 负载快照：`http://192.168.9.140:8090/api/load`
- 音频流：`ws://192.168.9.140:8090/decoder`

**2026-07-21 起：Docker 容器 + GPU（`--backend brave-voices --device cuda`）。**
本文档描述的是当前实际跑法。旧的 venv + 系统 python3 + CPU 的部署方式
（`deploy/run.sh` / `deploy/sync.sh`）已被取代，脚本还留着仅作历史参考，
**不要再用它们起服务**——两套部署方式互不知道对方的存在，同时开会抢 8090
端口。

---

## 0. 先看这条：本机代理会让你误判服务已经挂了

Mac 上有 `HTTP_PROXY=127.0.0.1:7897`。代理不会转发局域网地址，直接 curl 会拿到 **502**——
**这是代理返回的，不是服务返回的**。服务其实好好的。

```bash
curl http://192.168.9.140:8090/healthz                 # 502 ← 假故障，别信
curl --noproxy '*' http://192.168.9.140:8090/healthz   # {"ok": true, ...} ← 真相
```

写代码连服务时同理：Python `aiohttp.ClientSession(trust_env=False)`，
requests 用 `proxies={'http':None,'https':None}`，浏览器里给 192.168.9.140 加代理白名单。

**排查服务是否存活，永远先加 `--noproxy '*'` 再下结论。**

---

## 1. 为什么是「Docker + 运行时挂载宿主机 torch」，不是镜像里自己装

Spark 系统 python3（3.12.3）自带 `torch==2.12.1+cu130` 的 aarch64 构建 ——
这是 **NVIDIA 针对 DGX Spark GB10（Blackwell, sm_121a）专门构建的版本**，
带一整套配套的 CUDA 13 依赖（`nvidia-cudnn-cu13` / `nvidia-nccl-cu13` /
`nvidia-nvshmem-cu13` …）。PyPI / 清华镜像上**没有**对应的 aarch64 wheel，
在镜像里 `pip install torch` 装出来的要么装不上，要么装到一个跟这颗 GPU
不匹配的通用 CUDA 版本 —— 静默跑起来但性能/正确性都不保证。

所以镜像本身**不装 torch**，改成运行时把宿主机那份已验证可用的
`/usr/local/lib/python3.12/dist-packages` 只读挂进容器（`docker-run.sh` 的
`HOST_SITE_PACKAGES`），配合 `Dockerfile` 里的
`PYTHONPATH=/opt/host-site-packages:/opt/pydeps`。这样容器里跑的 torch
跟 `tools/test_gpu_device.py` 实测过的是**同一份二进制**，不是另外装出来的、
行为未知的版本。

镜像里只装宿主机没有的、纯 Python 无 CUDA 依赖的部分：`aiohttp` / `pyyaml`
/ `scipy` / `soundfile`（装到 `/opt/pydeps`，不是默认 site-packages —— 那个
路径会被上面的挂载整个盖住）。

代价：容器强绑定这台 Spark 的系统 torch 版本，镜像本身不能直接搬到别的机器上
跑（跨机分发需要另外解决 torch 来源）。对单机常驻服务这笔交易划算 ——
换来的是保证容器 GPU 路径与实测完全一致，而不是"大概率一样"。

---

## 2. 首次构建（已完成，重建时照做）

**必须在 Spark 上构建，不要在 Mac 上交叉构建**（`--network=host` 依赖宿主机
网络，且 aarch64 镜像在 x86 Mac 上构建要过 QEMU 模拟，慢且容易踩架构坑）。

```bash
ssh rolf@192.168.9.140          # 密码 shiyuxuan，sshpass 没装，脚本里用 expect
cd /home/rolf/projects/flock-voice-engine
bash deploy/docker-run.sh build
```

只有**改了依赖**（`aiohttp`/`pyyaml`/`scipy`/`soundfile` 版本，或加了新依赖）
才需要重新 `build`。改 `server/`、`assets/`、`web/`、`vendor/` 代码不需要——
这些目录是**挂载**进容器的（见 §3），`restart` 立刻生效。

校验镜像里 GPU 依赖到位：

```bash
sudo docker run --rm --gpus all \
  -v /usr/local/lib/python3.12/dist-packages:/opt/host-site-packages:ro \
  -e PYTHONPATH=/opt/host-site-packages \
  rolf/flock-voice-engine:latest \
  python3 -c "import torch; print(torch.__version__, torch.cuda.is_available())"
# 2.12.1+cu130 True
```

## 3. 同步代码（在 Mac 上跑）

```bash
cd ~/Desktop/twiddle-research/flock-voice-engine
scp -r server/ rolf@192.168.9.140:/home/rolf/projects/flock-voice-engine/
scp -r assets/timbre/voice_maps rolf@192.168.9.140:/home/rolf/projects/flock-voice-engine/assets/timbre/
```

`server/` 是**只读挂载**进容器的（不是 `COPY` 进镜像那份 —— 那份只是
挂载路径缺失时的兜底），所以同步完直接 `docker-run.sh restart` 就生效，
不需要 `build`。

> ⚠️ **`assets/timbre/` 与 `web/assets/timbre/` 是两份独立拷贝**（aiohttp
> serve 的是后者，不是符号链接）。新建/更新漫游地图后**两处都要放**，
> 只放一处浏览器 fetch 不到。

## 4. 启动 / 停止 / 查看

全部通过 `deploy/docker-run.sh`，在 **Spark 上**执行：

```bash
cd /home/rolf/projects/flock-voice-engine
bash deploy/docker-run.sh build     # 只在依赖变了的时候跑
bash deploy/docker-run.sh start     # 启动（读 CMD 默认值：brave-voices + cuda）
bash deploy/docker-run.sh status    # 存活 + 内存 + healthz
bash deploy/docker-run.sh logs      # 跟随日志
bash deploy/docker-run.sh restart   # 改完 server/ 代码后用这个，不用 build
bash deploy/docker-run.sh stop      # 停止（docker rm -f）
```

从 Mac 单行远程操作（`expect` 应答密码）：

```bash
expect -c 'spawn ssh -o StrictHostKeyChecking=no rolf@192.168.9.140 {bash /home/rolf/projects/flock-voice-engine/deploy/docker-run.sh status}
expect { -re {assword:} { send "shiyuxuan\r"; exp_continue } eof }'
```

> **不要用 `ssh ... bash -s < script.sh`**——stdin 被脚本占住，密码提示无人应答，直接死锁。
> 要么命令内联，要么先 `scp` 再 `bash /path/x.sh`。

容器启动参数（写死在 `docker-run.sh` 里，改后端/设备要改脚本，不是运行时传参）：

```
--host 0.0.0.0 --port 8090 --backend brave-voices --device cuda --static /app/web
```

`--backend` 三档：`synth`（程序合成兜底）/ `brave-voices`（v2 四音色神经音源，
**生产用这个**）/ `silent`（全零占位）。`--device` 认 `cpu` / `cuda` /
`cuda:N`；只有 `brave`/`brave-voices` 这两个神经后端吃这个参数，
`synth`/`silent` 给了也会被忽略。

关键 docker run 参数：

| 参数 | 作用 |
|---|---|
| `--user 1005:1005` | GPU-GUARD 规范：容器内进程以 rolf 身份跑，才能追溯到 SLURM/宿主机身份 |
| `--gpus all` | nvidia-container-toolkit 把宿主机驱动库（`libcuda.so` 等）注入容器 |
| `--restart unless-stopped` | 常驻，宿主机重启后自动拉起 |
| `--cpu-shares=262144` | cgroup v2 下 ≈ `cpu.weight` 10000（批处理任务默认 100）——CPU 争用时音频容器拿绝对优先，闲时批处理照样能用满整机 |
| `-v /data/model_weights/midiBrave:...:ro` | 权重是 jyhu 的目录，只读 |
| `-v $HOST_SITE_PACKAGES:/opt/host-site-packages:ro` | 见 §1 |
| `-v $PROJECT/{server,vendor,assets,web}:...:ro` | 代码/权重挂载，改完 `restart` 即生效，见 §3 |

**路径约定**：代码 `/home/rolf/projects/flock-voice-engine/`、
容器日志 `docker logs`（`--restart unless-stopped` 常驻，不需要额外落盘）、
负载日志 `/home/rolf/logs/flock-voice-load.jsonl`（挂进容器的
`/home/rolf/logs`，宿主机直接能读，不用 `docker exec`）、
临时产物 `/home/rolf/staging/`。不在 `/home/rolf/` 根目录建文件。

## 5. 内存实测（GPU 路径，2026-07-21）

Spark 统一内存 121 GB（GPU/CPU 共享同一物理池，Grace Blackwell 架构，
不是独立显存）。8081 的 vLLM 生产服务另外预留了大头。

| 场景 | 数值 |
|------|------|
| 4 个音色 checkpoint 全部加载到 GPU（进程峰值 RSS，`tools/test_gpu_device.py` 实测） | **1.76 GiB** |
| 生产容器 `docker stats` 实测（4 音色 + 若干并发连接） | **~1.4 GiB** |
| torch/CUDA context 固定开销（跑任何 CUDA 代码前就有） | **~0.6 GiB** |

模型权重跨会话共享（`_SHARED_VOICE_MODELS` 缓存），**不是每条 WS 连接各自
加载一份** —— 新连接只加一份很小的 per-voice 流式状态，内存不随并发连接数
线性增长。**建议给这个服务预留 ~3 GiB**（1.76 GiB 实测峰值 + 余量，覆盖
CUDA 内存碎片化和多连接场景），不需要预留到 10+ GiB 那个量级。

pad 和弦增补的 3 行（2026-07-21，见 §6）**没有**推高这个数字——4 个 pad 行
共用同一个已加载的模型实例，只多几份很小的 `StreamingVoice` 状态，不是 4 份
独立权重。真正收紧的是渲染时间预算（见 §6），不是内存。

CPU 路径（旧配置，仅供对比，已不是生产状态）：`docker stats` 实测约
414.8 MiB —— 更省内存，但渲染延迟在机器有其他负载时会超预算（见 §6）。

## 6. 验收记录

**CPU vs GPU 实测（2026-07-21，`tools/test_gpu_device.py`，走生产路径
`MultiVoiceBraveBackend` pool=4 block=2048，预算 46.44 ms）：**

```
device=cpu   p50=79.94ms p95=104.79ms  ✗ 超预算 2.3 倍（机器有其他负载、未调线程数）
device=cuda  p50=17.82ms p95=17.87ms   ✅ 余量充分，约 4.5 倍加速
```

GPU 侧输出正确性同步验证：`finite=True`（无 NaN/Inf），四轨 RMS 均在合理范围，
不是"更快但输出是垃圾"。

**pool=7 实测（同日，pad 和弦增补 3 行之后，`ROW_VOICES` 从 4 变 7，见
`server/backends/brave_voices.py`）：**

```
device=cuda（7 行满载，含真实 4 音 pad 和弦）  p50=36.78ms p95=37.49ms  ✅ 仍在预算内
```

仍然过预算，但余量从四行时的约 24–28 ms（约 60%）收窄到约 9 ms（约 19%）——
GPU 显存没有额外开销（`memory_allocated` 167.7→174.9 MB，4 个 pad 行共用同一个
已加载模型实例），瓶颈纯粹是逐行串行前向的时间。这台 GPU 跟其他项目共用
（jyhu 的 demo、vLLM 生产实例），余量变窄意味着抗共享争用的缓冲变薄了——
如果以后还要给别的声部加行，先重新跑这个脚本量一遍，别凭四行的旧数字外推。

**生产端到端验收（切到 GPU 之后，真实 WS 会话）：**

```
curl --noproxy '*' http://192.168.9.140:8090/healthz
→ {"ok": true, "backend": "brave-voices"}

WS ws://192.168.9.140:8090/decoder → ready 帧 OK，四轨各发一个 note，
                                     60 块音频全部 finite，peak 0.228，
                                     renderMs 稳定在 19–20 ms
```

## 7. 常见故障排查

| 现象 | 原因 / 处理 |
|------|------------|
| Mac 上 curl 返回 **502** | **代理**。加 `--noproxy '*'`。见第 0 节。服务大概率是好的。 |
| `docker-run.sh start` 报「端口 8090 已被占用」 | 8090 是硬约束，**不要改端口去试探**。先 `ss -ltnp \| grep 8090` 查是谁。若是本容器残留，`docker-run.sh stop`；若是别人的进程，**不要动**，找人协调。 |
| 容器起不来，日志里 `ModuleNotFoundError` | 大概率是某个依赖既不在宿主机挂载里也没进 `/opt/pydeps`。检查是不是 vendor 代码新 import 了什么（`import yaml` 这种系统级 apt 包和 pip 装的 torch/numpy 不在同一个目录，踩过一次，见 Dockerfile 注释）。 |
| `torch.cuda.is_available()` 是 `False` | 检查 `docker run` 有没有带 `--gpus all`；检查宿主机挂载路径 `/usr/local/lib/python3.12/dist-packages` 是否还是那份 cu130 torch（`python3 -c "import torch;print(torch.__version__)"` 直接在宿主机上确认）。 |
| 改了 `server/` 代码但没生效 | 用的是 `restart` 不是 `build`？两者都试过还不行，检查挂载路径是不是被覆盖（`docker inspect` 看 Mounts）。 |
| 进程活着但 healthz 无响应 | `docker-run.sh logs` 看栈。常见是端口绑定失败或后端 `load()` 抛异常（比如 checkpoint hash 校验不过）。 |
| ssh 命令挂住不动 | 用了 `ssh ... bash -s < file`。改成内联或 scp + bash。 |
| 客户端有爆音 / underrun | 属音频层不是部署层。看 telemetry 的 `estimatedBufferedFrames` 和 `underruns`，参考 `app.py` 的 `pacing_factor`（`docs/protocol.md` §5）。 |
| 占用其它端口 | 已占用勿动：22 / 4173(jyhu dashboard) / 7890 / 8081(vLLM 生产) / 8083(同事) / 8086 / 8766 / 8888 / 9090 / 9418。 |

## 8. 硬约束速查

- 一切限制在 `/home/rolf/` 内；`/data` 只读；不碰别人的目录和进程。
- 端口只用 **8090**。
- 本服务走 **GPU**（`--device cuda`，2026-07-21 起）。容器必须 `--gpus all` +
  `--user 1005:1005`（GPU-GUARD 规范）。这是常驻服务，不走 `qgpu` 批处理队列
  ——那套是给训练/批推理任务设计的，跟常驻进程的资源模型不匹配。
- Spark 是 **aarch64（ARM）**，选依赖和基础镜像时注意架构。
- torch 不进镜像，运行时挂载宿主机那份（见 §1）——镜像本身不能直接搬到
  别的机器跑。
- 权重、语料、渲染产物一律不进 Git。
