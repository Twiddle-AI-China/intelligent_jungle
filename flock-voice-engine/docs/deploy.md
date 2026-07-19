# flock-voice-engine Spark 部署

服务跑在 DGX Spark（`rolf@192.168.9.140`），监听 **8090**，局域网可直接访问。

- 健康检查：`http://192.168.9.140:8090/healthz`
- 后端自述：`http://192.168.9.140:8090/api/decoder-status`
- 音频流：`ws://192.168.9.140:8090/decoder`

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

## 1. 为什么不用容器（没有 Dockerfile）

评估后走 **venv + 系统 python3**，没写 Dockerfile。理由：

1. **torch 是白拿的。** Spark 系统 python3（3.12.3）里已经装好 `torch 2.12.1+cu130` 的
   aarch64 构建。venv 用 `--system-site-packages` 建，直接继承，**零下载零体积**。
   要是进容器，就得为 ARM64 重新拉一个几 GB 的 torch 基础镜像——为了容器而容器。
2. **本服务不需要 GPU，也就不需要 GPU-GUARD/qgpu 那套容器规范。** 纯 CPU 常驻进程，
   `nohup` 起就完事。容器只是多一层。
3. **依赖面极小。** 除 torch 外只有 `aiohttp` + `numpy` + `soundfile`，pip 装秒级完成。
4. **迭代快。** 改代码 `sync.sh` 一推、`run.sh restart` 一重启即可，不用 rebuild image。

代价是环境隔离弱于容器（依赖系统 python 的 torch 版本）。对黑客松阶段的单机常驻服务
这笔交易划算。将来若要跨机分发，再补 Dockerfile 不迟（基础镜像选 ARM64 的
`nvcr.io/nvidia/pytorch`，并且必须 `--user 1005:1005`）。

---

## 2. 首次安装（已完成，重装时照做）

```bash
ssh rolf@192.168.9.140          # 密码 shiyuxuan，sshpass 没装，脚本里用 expect
cd /home/rolf/projects/flock-voice-engine
python3 -m venv --system-site-packages .venv        # --system-site-packages 是关键，为了白拿 torch
.venv/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple aiohttp soundfile
```

校验：

```bash
.venv/bin/python -c "import aiohttp,soundfile,numpy,torch;print(aiohttp.__version__,torch.__version__)"
# 3.14.1 2.12.1+cu130
```

> 直连 pypi.org 很慢，用清华镜像 `-i https://pypi.tuna.tsinghua.edu.cn/simple`。

## 3. 同步代码（在 Mac 上跑）

```bash
cd ~/Desktop/twiddle-research/flock-voice-engine
bash deploy/sync.sh              # 只同步代码
bash deploy/sync.sh --restart    # 同步后顺带重启服务
```

排除 `.venv/`、`vendor/`、`staging/`、`*.pt`、各类音频和 `__pycache__`。

> **`sync.sh` 里绝对不要加 `--delete-excluded`。**
> `--delete` 配 `--exclude` 时被排除的路径在服务器端是受保护的；而 `--delete-excluded`
> 语义相反——它会把服务器上所有匹配排除规则的东西删掉，也就是**连 `.venv/` 和 `vendor/`
> 一起清空**。本项目已经踩过一次，`.venv` 和 `vendor/midibrave` 被抹掉过。

## 4. 启动 / 停止 / 查看

全部通过 `deploy/run.sh`，在 **Spark 上**执行：

```bash
cd /home/rolf/projects/flock-voice-engine
bash deploy/run.sh start --backend synth   # 启动（V1 用程序合成后端）
bash deploy/run.sh status                  # 存活 + pid + RSS + healthz
bash deploy/run.sh mem                     # 只看内存 RSS
bash deploy/run.sh logs 100                # 看日志尾部 100 行
bash deploy/run.sh restart --backend synth # 重启
bash deploy/run.sh stop                    # 停止
```

从 Mac 单行远程操作（`expect` 应答密码）：

```bash
expect -c 'spawn ssh -o StrictHostKeyChecking=no rolf@192.168.9.140 {bash /home/rolf/projects/flock-voice-engine/deploy/run.sh status}
expect { -re {assword:} { send "shiyuxuan\r"; exp_continue } eof }'
```

> **不要用 `ssh ... bash -s < script.sh`**——stdin 被脚本占住，密码提示无人应答，直接死锁。
> 要么命令内联，要么先 `scp` 再 `bash /path/x.sh`。

`--backend` 三档：`synth`（程序合成兜底，V1 验收用）/ `brave`（midiBrave 神经音源，
另一路 agent 负责；未落地时 app 会自动回落到 synth）/ `silent`（全零占位）。

**路径约定**：代码 `/home/rolf/projects/flock-voice-engine/`、
日志 `/home/rolf/logs/flock-voice-engine.log`、PID `/home/rolf/logs/flock-voice-engine.pid`、
临时产物 `/home/rolf/staging/`。不在 `/home/rolf/` 根目录建文件。

## 5. 内存实测

Spark 总内存 121 GB，但 8081 的 vLLM 生产服务预分配了约 97 GiB 统一内存，
**实际可用只有约 12 GB**。本服务预算 ≤4 GB。

| 场景 | RSS 实测 |
|------|---------|
| 空闲（synth 后端，pool_size=1） | **47 MiB** |
| 3 路并发 WS 连接 / 持续出流 20 s | **49 MiB**（峰值） |

远低于 4 GB 预算，宽裕度极大。每条 WS 连接各自一套 voice 池和后端实例，
但 synth 后端本身几乎无状态开销，连接数带来的增量约 1 MiB/连接量级。

> **注意**：以上是 `--backend synth` 的数字。换成 `brave` 后端后会加载 torch 和 96 MB
> 权重，内存会明显上升，**必须重新实测**（`bash deploy/run.sh mem`），确认仍在 4 GB 以内。
> 尤其注意 torch 默认线程数——20 核机器上 CPU 推理可能起 20 个线程，
> 需要时用 `OMP_NUM_THREADS` / `torch.set_num_threads()` 收敛。

## 6. 验收记录

从 Mac 实测（2026-07-20）：

```
curl --noproxy '*' http://192.168.9.140:8090/healthz
→ HTTP 200, {"ok": true, "backend": "synth-s"}, 0.018 s

GET /api/decoder-status → 44100 Hz / 1024 samples per block / pool 1 /
                          f32-interleaved-stereo / serverSideMastering:false

WS ws://192.168.9.140:8090/decoder → ready 帧 OK，发 note 后收到 40 块二进制音频，
                                     peak 0.082，左右声道一致（干声 mono 复制）
```

## 7. 常见故障排查

| 现象 | 原因 / 处理 |
|------|------------|
| Mac 上 curl 返回 **502** | **代理**。加 `--noproxy '*'`。见第 0 节。服务大概率是好的。 |
| `run.sh start` 报「端口 8090 已被占用」 | 8090 是硬约束，**不要改端口去试探**。先 `ss -ltnp \| grep 8090` 查是谁。若是本项目残留进程，`run.sh stop` 或 `kill` 掉；若是别人的进程，**不要动**，找人协调。 |
| 报「venv 不存在」 | `.venv` 被删了（多半是 rsync `--delete-excluded`，见第 3 节）。按第 2 节重建。 |
| 进程活着但 healthz 无响应 | `run.sh logs` 看栈。常见是端口绑定失败或后端 `load()` 抛异常。 |
| ssh 命令挂住不动 | 用了 `ssh ... bash -s < file`。改成内联或 scp + bash。 |
| 服务随 SSH 断开而死 | `run.sh start` 已用 `setsid nohup`，不该发生。若手动起过进程，注意加 `setsid`。 |
| 客户端有爆音 / underrun | 属音频层不是部署层。看 telemetry 的 `estimatedBufferedFrames` 和 `underruns`，参考 `app.py` 的 `pacing_factor`。 |
| 占用其它端口 | 已占用勿动：22 / 4173(jyhu dashboard) / 7890 / 8081(vLLM 生产) / 8083(同事) / 8086 / 8766 / 8888 / 9090 / 9418。 |

## 8. 硬约束速查

- 一切限制在 `/home/rolf/` 内；`/data` 只读；不碰别人的目录和进程。
- 端口只用 **8090**。
- 本服务走 **CPU，不申请 GPU**（GPU 任务才需要 `qgpu`）。
- Spark 是 **aarch64（ARM）**，选依赖和基础镜像时注意架构。
- 权重、语料、渲染产物一律不进 Git。
