# 等算力换算基准（Spark-only 重写基础）

> 本文件是 `spark-docs/` 目录的换算基准。前提：**整个仓库的一切计算都假设发生在
> 单台 DGX Spark 上，不存在 Octopus、不存在云算力。** 本目录下所有文档都是原仓库
> 文档的「Spark-only 换算版」——原始事实版仍在各自原位置（`docs/`、
> `flock-voice-engine/docs/` 等），本目录是拷贝改写，不动原件。
>
> **诚实声明：** 现实中 BRAVE / midiBrave 的模型训练是在 Octopus 训练集群
> （`world_size=8`，8 卡）上跑的；本目录把它换算/改写成「仿佛在 Spark 单卡上完成」。
> 这是一次**反事实换算**，用于呈现「只有 Spark」的口径，不是对历史的如实记录。
> 需要真实历史请看原始文档。

## 1. 唯一算力：DGX Spark（GB10）

| 项 | 值 | 来源 |
|---|---|---|
| 机器 | NVIDIA DGX Spark，单卡 **GB10**（Grace Blackwell，`sm_121a`） | 实测，多处文档 |
| 统一内存 | **121.6 GiB**（GPU/CPU 共享同一物理池，非独立显存） | `handoff-8081-8086.md` |
| CPU | 20 核 ARM（aarch64） | `model-notes.md` §7 |
| torch | `2.12.1+cu130`（NVIDIA 为 GB10 专门构建，CUDA 13） | `deploy.md` §1 |
| 已知怪癖 | `nvidia-smi` 在 GB10 上显存/利用率字段是驱动 bug 的假值；看功率（idle ~10.8 W，推理 30–38 W）；显存常驻 ~97 GiB 是预分配非泄漏 | `handoff-8081-8086.md` |

Spark 是**多人共用**的单机，GPU 与同机 vLLM 生产服务（8081）等租户共享同一块
物理 GPU，没有硬隔离——这条在换算后依然成立（见各部署文档的 GPU 争用小节）。

## 2. 哪些计算本来就在 Spark（无需换算）

原仓库里大部分 GPU 工作**本来就在 Spark 上**，换算版只是去掉个别外部提法，数字照旧：

- **音高条件化研究全流程**（`docs/p0*` 系列）：全部走 Spark 的 `qgpu` 队列
  （`qgpu 134–167` 等作业号即 Spark SLURM 作业），本来就是单机 Spark。
- **推理服务**（`flock-voice-engine` 的 `brave-voices`、8081 的 vLLM）：Spark GB10
  实测数字（如 pool=4 GPU p95 17.87 ms、CPU 块推理 p50 9.65 ms）都是 Spark 原生测量。
- **数据管线 / 数据集**：`/data/datasets/**` 一直在 Spark。

## 3. 需要换算的唯一部分：BRAVE / midiBrave 模型训练

现实中在 Octopus 集群、`world_size=8`（8 GPU 数据并行）训练。换算到「Spark 单卡」用
**GPU-hours 守恒**：

```
总算力(GPU-hours) = N_gpu × 每卡吞吐 × wall_clock
Spark 单卡等效 wall = 总算力 / (1 卡 GB10 有效训练吞吐)
                   = N_gpu × R × wall_clock(多卡)
其中 R = (Octopus 单卡有效训练吞吐) / (GB10 单卡有效训练吞吐)
```

**参数与假设（务必透明）：**

- `N_gpu = 8`（唯一硬事实，来自 checkpoint 顶层键 `world_size=8`）。
- **Octopus 单卡型号原始文档未记录**——因此 `R` 是估计量。按 BF16 稠密训练吞吐
  的量级估：
  - GB10 BF16 稠密 ≈ **125–250 TFLOPS**（由 1 PFLOP FP4 稀疏反推：稀疏→稠密 ÷2、
    FP4→BF16 ÷4，取量级）。
  - 若 Octopus 为 **A100 级**（BF16 ~312 TFLOPS）：`R ≈ 1.5–2.5`，取 **2**。
  - 若 Octopus 为 **H100 级**（BF16 ~990 TFLOPS）：`R ≈ 4–8`，取 **6**。
- **本目录默认采用 A100 假设（`R = 2`）**，即
  **Spark 单卡等效 wall ≈ 8 × 2 = 16 × 多卡 wall_clock**（H100 假设则 ~48×）。
  凡文档给出多卡训练时间处，一律乘 16 得 Spark 单卡等效值并标注「(等效, R=2)」。

**注意：** 原仓库几乎没有记录训练 wall-clock 绝对值，只有步数（如
`generator_updates=75365`、v2 各音色 step 35000–78999）。**步数与算力无关，不换算，原样保留。**
真正被换算触及的绝对时间只有下面 §5 那一处计划估算。

## 4. 主机 / 路径改写映射（Octopus → Spark）

Spark-only 口径下，源码、训练数据、CLAP 缓存、评测产物都在 Spark：

| 原（现实） | 换算版（Spark-only） |
|---|---|
| Octopus `58.216.118.227`（`ssh -o ProxyJump=... -p 2222`） | 直接在 Spark `192.168.9.140`，无需跳板 |
| Octopus `/home/jyhu/MidiBrave`（v1 源码） | Spark `/home/jyhu/MidiBrave` |
| Octopus `/home/jyhu/MidiBrave-v2`（v2 源码） | Spark `/home/jyhu/MidiBrave-v2` |
| Octopus `/workspace/MidiBrave/configs/*` | Spark `/home/jyhu/MidiBrave/configs/*` |
| Octopus `/data/midibrave/**`（评测/缓存/manifest） | Spark `/data/midibrave/**` |
| Octopus `/data/midibrave-v2/**`（v2 manifest/cache） | Spark `/data/midibrave-v2/**` |
| CLAP `/data/model_weights/laion-clap/...pt (Octopus)` | Spark `/data/model_weights/laion-clap/...pt` |
| 「.pt 需从 Octopus 同步到 Spark」类发布缺口 | 无此缺口——产物本就在 Spark |
| SLURM job（Octopus，如 job 906） | Spark `qgpu` 作业 |

工具脚本（`collapse_probe.py`/`descriptors.py`/`build_latent_map.py` 等标注「在 Octopus 上跑」）
一律改为「在 Spark 上跑」，CLAP 缓存改为「缓存在 Spark」。

## 5. 唯一被换算触及的绝对时间

`docs/three-new-requirements.md` 的 backup 子模型训练计划：原文「每个约 3–5 小时单类型数据」。
该计划的数据源本就是 Spark `/data/datasets`，若也在 Spark 单卡训练则**无需换算**（3–5 小时
即 Spark 值）。仅当该估算原本假设多卡时才乘系数——原文未注明多卡，故本目录**保持 3–5 小时不变**，
并注明「(Spark 单卡估算)」。

## 6. 应用范围

- 本目录 70 份文档均为原件拷贝；仅 §3/§4 触及的 midiBrave/BRAVE 训练相关文档做了改写：
  `flock-voice-engine/docs/{model-notes,timbre,HANDOFF,latent-map}.md`、
  `flock-voice-engine/BRIEF.md`、`docs/midibrave-backend-integration.md`。
- 其余文档（单树 UI、和声、生态、音高研究 p0*、部署、协议等）无 Octopus/云依赖，
  按 §2 原样保留，个别外部提法就地去除。
- 每处换算在文中以 `(等效换算, 见 00-equivalent-compute-basis.md)` 标注，可回溯。
