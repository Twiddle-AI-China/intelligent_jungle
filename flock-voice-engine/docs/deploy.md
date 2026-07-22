# flock-voice-engine Spark 部署

服务跑在 DGX Spark（`yfhuang@192.168.9.140`），**只监听 8090**，局域网可直接访问。

- 健康检查：`http://192.168.9.140:8090/healthz`
- 后端自述：`http://192.168.9.140:8090/api/decoder-status`
- 负载快照：`http://192.168.9.140:8090/api/load`
- 音频流：`ws://192.168.9.140:8090/decoder`

**当前生效配置（2026-07-22，`deploy/docker-run.sh`）：**
`--backend brave-voices --device cuda --pool-size 5`，块长 4096（`server/config.py`
的 `DEFAULT_BLOCK_SAMPLES`），即 **pool 5 + 块 4096 + GPU**。前端从同一容器的
`web/`（挂载 `$PROJECT/web:/app/web:ro`）静态托管，`no-store`，改前端只需覆盖
`web/` 里的文件、**不用重启容器**（见 §3）。

**2026-07-21 起：Docker 容器 + GPU（`--backend brave-voices --device cuda`）。**
本文档保留此前现网参数作为迁移背景；Phase 0 的本地候选尚未应用到生产。
候选树已删除 `deploy/run.sh` 与 `deploy/sync.sh`：venv/nohup 入口会与 Docker
争抢 8090，旧同步入口同时存在凭据自动应答和直接热覆盖 production 的风险。
Phase 0 不提供替代的热同步或 apply 脚本。

**2026-07-22 的两处变更（都在缓解同机 GPU 争用下的实时卡顿，见 §9）：**

1. **`--pool-size` 7 → 5**：pad 和弦从 4 行（`[1,4,5,6]`）收窄到 2 行（`[1,4]`），
   `ROW_VOICES` 从 7 项变 5 项。降低每块渲染成本，代价是和弦最多 2 音。前端
   `mvp/src/config.js` 的 `voiceEngine.species.pad.rows` 同步改成 `[1,4]`——**这两处
   必须一致**，否则前端会往后端不存在的行发音。
2. **块长 2048 → 4096**（`server/config.py` `DEFAULT_BLOCK_SAMPLES`）：把每块渲染
   硬截止从 46.44 ms 提到 92.88 ms，让偶发的 GPU 争用尖峰仍落在预算内。代价是
   端到端延迟 +46 ms（仍在 BRIEF 的 100–300 ms 预算内）。

**8099 已下线（2026-07-22）。** 它曾短暂是 8090 的第二端口映射（顶替停更的
`mvp/` 独立静态站 `/home/jnzhang/deploy/latent-cosmos-synth/`），排查卡顿时撤掉
验证后不再恢复。现在容器**只映射 8090**。`/home/jnzhang/…` 那个旧静态站目录
早已冻结在 `de2e368`、无人指向，**不要再往那边部署或起 `http.server`**。

---

## 🚀 快速部署 Runbook（可直接照做 / 交给 LLM 执行）

> **Phase 0 边界：** 本次只更新本地候选源码，尚未同步、启动或重启生产。
> 候选 active 契约只允许 `yfhuang` 直接访问 Docker；不得换用其他账号或 sudo
> 绕过。后续受控发布的目标 release 根目录是 **`/srv/deploy/flock-voice-engine/`**，
> 旧个人副本不再作为发布源。

**部署位置与端口（记住这几个即可）：**

| 项 | 值 |
|---|---|
| 部署根目录（`$P`） | `/srv/deploy/flock-voice-engine` |
| 前端静态目录 | `$P/web/`（容器 `--static /app/web` 只读挂载，`no-store`） |
| 后端代码 | `$P/server/`（只读挂载，改完 `restart` 生效） |
| 部署脚本 | `$P/deploy/docker-run.sh` |
| 服务端口 | **8090**（唯一） |
| SSH | 仅允许 `yfhuang` 使用公钥认证；文档和脚本均不保存密码 |

### A. 更新前端（最常见；**不重启容器**，改完刷新浏览器即可）

前端是静态托管、`no-store`，覆盖 `web/` 里的文件就立即生效。从**有仓库 checkout
的机器**上把 `mvp/` 的四类东西同步过去（**不要带 `--delete`**，否则会删掉服务端
独有的 `web/_client/` 和 `web/runtime-config.js`）：

```bash
# 在有 git checkout 的机器上，仓库根目录执行（先 git checkout beta && git pull）：
P=/srv/deploy/flock-voice-engine
rsync -a mvp/src/          yfhuang@192.168.9.140:$P/web/src/
rsync -a mvp/eval/         yfhuang@192.168.9.140:$P/web/eval/
rsync -a mvp/assets/       yfhuang@192.168.9.140:$P/web/assets/
rsync -a mvp/index.html    yfhuang@192.168.9.140:$P/web/index.html
```

> **必须保留、不能覆盖的服务端独有文件**：`web/_client/voice-client.js`（音源接入
> 包）、`web/runtime-config.js`（StepFun 地址）。上面按子目录同步、且无 `--delete`，
> 天然不会碰它们。**别整目录 `rsync --delete mvp/ → web/`**。

### B. 更新后端（改 `server/` 或 `server/config.py`）→ **必须 restart**

```bash
# 1) 同步后端代码到 /srv/deploy（从有 checkout 的机器）：
rsync -a flock-voice-engine/server/ yfhuang@192.168.9.140:/srv/deploy/flock-voice-engine/server/
# 2) 在 Spark 上重启容器（docker 组成员不用 sudo；~15s 会断一次现有连接）：
ssh yfhuang@192.168.9.140 'bash /srv/deploy/flock-voice-engine/deploy/docker-run.sh restart'
```

### C. 起停查（都在 Spark 上，走 `docker-run.sh`）

```bash
P=/srv/deploy/flock-voice-engine
bash $P/deploy/docker-run.sh status    # 存活 + healthz
bash $P/deploy/docker-run.sh restart   # 改完 server/ 用这个
bash $P/deploy/docker-run.sh logs      # 跟随日志
bash $P/deploy/docker-run.sh stop      # 停
bash $P/deploy/docker-run.sh build     # 仅在改了依赖时才需要（见 §2）
```

### D. 部署后必须验证

```bash
# 在 Spark 本机（或给 192.168.9.140 配了代理白名单的机器）：
curl --noproxy '*' -s http://127.0.0.1:8090/healthz            # {"ok": true, ...}
curl --noproxy '*' -s http://127.0.0.1:8090/api/decoder-status # 看 poolSize/blockSamples/rowsBySpecies
# 前端关键文件在不在（应全 200）：
for f in / src/main.js _client/voice-client.js runtime-config.js; do
  curl --noproxy '*' -s -o /dev/null -w "$f = %{http_code}\n" http://127.0.0.1:8090/$f
done
```

**硬不变量（改完必查）：** 前端 `web/src/config.js` 的 `voiceEngine.species.pad.rows`
必须与后端 `/api/decoder-status` 的 `rowsBySpecies.pad` **完全一致**（当前都是
`[1,4]`，对应 `--pool-size 5`）。不一致 = 前端往后端不存在的行发音、静默丢弃。

> Mac 上直接 curl 局域网 IP 会因本机代理拿到假 **502**（见 §0），排查前先加
> `--noproxy '*'`，别误判服务挂了。

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
ssh yfhuang@192.168.9.140   # Public-key authentication only; no scripted password response.
cd /srv/deploy/flock-voice-engine
bash deploy/docker-run.sh build
```

只有**改了依赖**（`aiohttp`/`pyyaml`/`scipy`/`soundfile` 版本，或加了新依赖）
才需要重新 `build`。改 `server/`、`assets/`、`web/`、`vendor/` 代码不需要——
这些目录是**挂载**进容器的（见 §3），`restart` 立刻生效。

校验镜像里 GPU 依赖到位：

```bash
docker run --rm --gpus all \
  -v /usr/local/lib/python3.12/dist-packages:/opt/host-site-packages:ro \
  -e PYTHONPATH=/opt/host-site-packages \
  twiddle/flock-voice-engine:latest \
  python3 -c "import torch; print(torch.__version__, torch.cuda.is_available())"
# 2.12.1+cu130 True
```

## 3. 同步代码（从有仓库 checkout 的机器）

> 日常部署直接用顶部 Runbook 的 A/B 段即可；这里是原理说明。

```bash
cd <仓库根>/flock-voice-engine
rsync -a server/ yfhuang@192.168.9.140:/srv/deploy/flock-voice-engine/server/
rsync -a assets/timbre/voice_maps yfhuang@192.168.9.140:/srv/deploy/flock-voice-engine/assets/timbre/
```

`server/` 是**只读挂载**进容器的（不是 `COPY` 进镜像那份 —— 那份只是
挂载路径缺失时的兜底），所以同步完直接 `docker-run.sh restart` 就生效，
不需要 `build`。

> ⚠️ **`assets/timbre/` 与 `web/assets/timbre/` 是两份独立拷贝**（aiohttp
> serve 的是后者，不是符号链接）。新建/更新漫游地图后**两处都要放**，
> 只放一处浏览器 fetch 不到。

## 4. 启动 / 停止 / 查看

全部通过 `deploy/docker-run.sh`，在 **Spark 上**执行（`docker` 组成员不用 sudo）：

```bash
cd /srv/deploy/flock-voice-engine
bash deploy/docker-run.sh build     # 只在依赖变了的时候跑
bash deploy/docker-run.sh start     # 启动（读 CMD 默认值：brave-voices + cuda）
bash deploy/docker-run.sh status    # 存活 + 内存 + healthz
bash deploy/docker-run.sh logs      # 跟随日志
bash deploy/docker-run.sh restart   # 改完 server/ 代码后用这个，不用 build
bash deploy/docker-run.sh stop      # 停止（docker rm -f）
```

远程访问只允许 `yfhuang` 使用公钥认证。凭据只可由环境变量或未跟踪的只读
secret file 注入；文档与脚本均不保存口令，也不提供自动口令应答。Phase 0 只
更新本地候选源码，不把脚本同步到服务器，也不启动或重启现有容器。

容器启动参数（写死在 `docker-run.sh` 里，改后端/设备要改脚本，不是运行时传参）：

```
--host 0.0.0.0 --port 8090 --backend brave-voices --device cuda \
  --block-samples 4096 --pool-size 5 --static /app/web
```

`--backend` 三档：`synth`（程序合成兜底）/ `brave-voices`（v2 四音色神经音源，
**生产用这个**）/ `silent`（全零占位）。`--device` 认 `cpu` / `cuda` /
`cuda:N`；只有 `brave`/`brave-voices` 这两个神经后端吃这个参数，
`synth`/`silent` 给了也会被忽略。

关键 docker run 参数：

| 参数 | 作用 |
|---|---|
| `--user "$RUN_UID:$RUN_GID"` | GPU-GUARD 规范：容器内进程以 yfhuang 身份跑，才能追溯到 SLURM/宿主机身份 |
| `--gpus all` | nvidia-container-toolkit 把宿主机驱动库（`libcuda.so` 等）注入容器 |
| `--restart unless-stopped` | 常驻，宿主机重启后自动拉起 |
| `--cpu-shares=262144` | cgroup v2 下 ≈ `cpu.weight` 10000（批处理任务默认 100）——CPU 争用时音频容器拿绝对优先，闲时批处理照样能用满整机 |
| `-v /data/model_weights/midiBrave:...:ro` | 权重是 jyhu 的目录，只读 |
| `-v $HOST_SITE_PACKAGES:/opt/host-site-packages:ro` | 见 §1 |
| `-v $PROJECT/{server,vendor,assets,web}:...:ro` | 代码/权重挂载，改完 `restart` 即生效，见 §3 |

**路径约定**：后续受控发布的代码位于 **`/srv/deploy/flock-voice-engine/`**，
容器日志用 `docker logs`
（`--restart unless-stopped` 常驻，不需要额外落盘）、负载日志
`/srv/deploy/flock-voice-engine/logs/flock-voice-load.jsonl`（由候选脚本挂到
`/app/logs`，容器使用 `yfhuang` 的动态 UID/GID 写入）。

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
device=cuda（7 行满载，含真实 4 音 pad 和弦，纯串行逐行前向）  p50=36.78ms p95=37.49ms  ✅
```

余量从四行时的约 24–28 ms（约 60%）收窄到约 9 ms（约 19%）——GPU 显存没有额外
开销（`memory_allocated` 167.7→174.9 MB，4 个 pad 行共用同一个已加载模型实例），
瓶颈纯粹是逐行串行前向的时间：原实现每行前向完立刻 `.cpu()` 拷回，`.cpu()`
本身就是同步点，等于逐行强制串行，哪怕 7 行之间毫无依赖。

**跨行 CUDA stream 并行（同日第三次更新）**：`server/backends/brave_voices.py`
的 `render_split` 改成——每行发到自己持久的 `torch.cuda.Stream()`（`load()` 里
建好，跨块复用），全部发完才一次性 `torch.cuda.synchronize()`，最后统一拷回
CPU，而不是逐行拷。各行跨块状态（`streaming.py` 的 `_VoiceState`：
`*_cache`/`z_current`/`sample_pos`）完全独立，模型权重推理期只读
（`@torch.no_grad()`），并发没有数据竞争——包括 pad 4 行共用同一个模型实例、
并发读同一份权重的情况。实测：

```
device=cuda（7 行满载，跨行 stream 并行）  p50=30.16ms p95=33.83ms  ✅ 余量回到约 27%
```

p50 降了约 18%、p95 降了约 10%，音频输出数值上与并行前完全一致（`tools/
test_multivoice.py`/`test_roam.py`/`test_note_expiry.py` 三个回归脚本重跑过，
逐行 RMS/peak 分毫不差）——这是纯调度层面的改动，没有碰任何数值计算逻辑。
CPU 设备没有这个机制，`_streams` 留 `None`，走原来的纯串行分支，行为不受影响。

四行同一个 checkpoint 的**批处理**（把 4 个 pad 前向合并成一次带 batch 维的
调用，理论上比 stream 并行更快）暂时没做——pad 和弦的成员是动态的（栖鸟随时
落位/起飞），要合并调用就要动 `streaming.py` 里逐帧维护的因果卷积缓存
（跨块状态，且缓存形状跟"当前有几个音在响"绑定），批组成随时变会让缓存
管理明显复杂化，出错代价是把这条数值精度卡到 6.9e-07 的流式路径搞错，
风险收益比现在不划算，先不做。

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
| 客户端有爆音 / underrun | 先看是不是 GPU 争用（§9）。再看 telemetry 的 `estimatedBufferedFrames` 和 `underruns`，参考 `app.py` 的 `pacing_factor`（`docs/protocol.md` §5）。 |
| 播放**间歇卡顿**、`renderMsMax` 忽高忽低（20→80 ms） | 同机 vLLM（8081）突发推理抢 GPU，见 §9。不是本服务的 bug，代码层已用 pool 5 + 块 4096 缓解到极限。 |
| 第二个用户一连上，第一个就「断开连接中」 | 已知问题，见 §9「并发」。当前生产版本未修（那版 fix 验证过但因另一路问题回退了）。 |
| 占用其它端口 | 已占用勿动：22 / 4173(jyhu dashboard) / 7890 / 8081(vLLM 生产) / 8083(同事) / 8086 / 8766 / 8888 / 9090 / 9418。 |

## 8. 硬约束速查

- 后续受控发布的目标目录是 **`/srv/deploy/flock-voice-engine/`**；`/data` 只读，
  不碰别人的目录和进程。Phase 0 不向该目录同步或应用候选脚本。
- 端口只用 **8090**。
- 本服务走 **GPU**（`--device cuda`，2026-07-21 起）。容器必须 `--gpus all` +
  `--user "$RUN_UID:$RUN_GID"`（GPU-GUARD 规范）。这是常驻服务，不走 `qgpu` 批处理队列
  ——那套是给训练/批推理任务设计的，跟常驻进程的资源模型不匹配。
- Spark 是 **aarch64（ARM）**，选依赖和基础镜像时注意架构。
- torch 不进镜像，运行时挂载宿主机那份（见 §1）——镜像本身不能直接搬到
  别的机器跑。
- 权重、语料、渲染产物一律不进 Git。

## 9. 已知问题：共享 GPU 争用与并发（2026-07-22）

这块 GPU 是**和同机 vLLM 生产服务（8081，占约 70 GB 显存）共享**的
（DGX Spark 统一内存，GPU/CPU 同一物理池，没有硬隔离）。本服务是这台机器上
延迟敏感的小租户，vLLM 是大租户。两类已观测到的实时卡顿都源于此，**都不是
本服务代码的 bug**：

**（1）突发 GPU 争用 → 间歇卡顿。** vLLM 的推理是**亚秒级突发**：生成时瞬间
打满 GPU，间隙全空。`nvidia-smi` 按 1 秒采样只看到均值（常显示约 20%），完全
错过这些尖峰。落在尖峰窗口里的单块渲染会从常态约 13 ms 被拖到 60–90 ms，一旦
越过块预算就抽干客户端缓冲 → underrun → 卡顿。**软件侧已经做到极限**：pool 7→5
降渲染成本、块 2048→4096 把预算翻到 92.88 ms 吸收尖峰、`TARGET_FRAMES` 提到
13000（约 295 ms）加大缓冲。这些能扛住短突发，但**扛不住 vLLM 持续满载**
（实测见过 90%+ 持续数秒的窗口，那种情况下 4096 块也可能被顶穿）。

- 诊断：读 `/api/load` 看活跃会话的 `renderMs`；读
  `/srv/deploy/flock-voice-engine/logs/flock-voice-load.jsonl` 看 `renderMsP95/Max` 与 `underruns` 是否
  在爬。`renderMsMax` 在 GPU 空时约 20 ms、忙时冲到 60–90 ms，就是这个问题。
- **不要在生产上跑压测**：多开几条 WS 连接自己就会加重 GPU 负载，把正在听的
  真实用户搞卡（踩过）。要压测另起一个独立端口的 staging 容器，最好用
  `--device cpu` 完全不碰 GPU。

**（2）并发：新连接接入会冻住已有连接。** 每条新 WS 连接的 `backend.load()`
（建 CUDA stream、过 timbre.net、跑 gain 标定渲染）当前是**同步跑在事件循环上**
的。一条新连接的 load 会把整个 loop 冻住 2–10 秒，期间所有已连接的会话收不到
音频块 → 客户端 1.5 s stall-timeout 触发假断线（表现为「断开连接中」循环）。
实测：第二条连接接入时，第一条出现约 6.1 秒断流。

- 修复方案（已在 staging 验证，但**当前生产未上**）：把 `load()` 放线程池
  （不阻塞事件循环）+ 把每音色的确定性派生初始化（default_z / gain / map）
  缓存到进程级 `_SHARED_VOICE_SETUP`（第二条起的连接几乎零 GPU 工作）。
  staging 实测新连接接入时已有连接的最大间隔从 6100 ms 降到 94 ms，并发会话
  音频独立无污染。这版改动因排查另一路问题时回退了，代码在 worktree 里未提交。
- **单独说明并发上限**：即便修好接入冻结，两个用户**同时演奏**仍会因两条会话
  的同步渲染在单事件循环上串行 + 共享 GPU 而互相加重，实测会卡。这是「单进程
  单事件循环 + 一块共享 GPU + 每会话同步渲染」这个架构的固有上限，不是调参能
  根治的——真要多用户稳定，得给音频服务独占 GPU（或 MIG 切片）。
