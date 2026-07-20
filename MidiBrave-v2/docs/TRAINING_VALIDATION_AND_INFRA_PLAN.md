# MidiBrave 训练框架测试分析与 Octopus 容量规划

> 报告版本：v3.1（q300 最终实测版）  
> 更新时间：2026-07-18  
> 代码目录：`/home/jyhu/MidiBrave`  
> 基线 commit：`6f2d0bc0362be21a69dd3a5551d5a07191733522`，其上为本轮未提交实现  
> 最终镜像：`midibrave:v0.3.0-optimized`  
> image ID：`sha256:3ee7dbea6b70c329d7d3aa976b4641ef8c8a0adee1ef6cbbe9f2286e2ad1d774`  
> 注意：第 2–12 节保留了优化前 profiling/容量推导的历史证据；当前执行状态、最终数据和质量结论以第 13 节及本节为准。

## 1. 当前结论

MidiBrave 的数据接入、双分支训练、1.940M BRAVE 判别器、AMP/DDP 原子更新、精确恢复和耗时优化已经落地。609/610、q300 16+2 epoch、两阶段最终校准评估和链尾审计均已完成。

已确认的核心结论如下：

1. Serum 当前交付不能按 2,000 preset × 72 格完整网格读取。训练以 `samples.jsonl` 为唯一事实源，以最终审计 `midi_note` 为条件，缺格不作为负样本。
2. 严格同 profile 视图为 1,822 preset、110,409 WAV；49,152-sample/75% 可靠 F0 合同下，完整 eligible 为 1,550 preset/83,438 WAV，q300 为 258 preset/14,043 WAV。
3. Decoder 重建完整 49,152-sample 窗口；不可靠帧只从 pitch loss mask，整段仍进入 STFT、包络、RMS 和对抗目标。
4. Generator 为 7,995,584 参数；新 BRAVE 判别器为 1,940,451 参数；Phase 2 总可训练参数为 9,936,035。判别器相对旧版减少 94.21%。
5. 最终镜像为 36 passed、1 skipped；真实 pipeline、8 卡原子溢出、逐 loss 梯度、连续/恢复等价性和组合门禁均通过。
6. 正式 `batch_per_gpu=10, global pair batch=80`；Phase 1/2 门禁中位 188.421/229.369 ms，q300 实测训练内总时长 2.457 h。
7. 完整 eligible 16+2 epoch 预计 median 14.54 h，P90+20% 约 21.95 h；36 小时性能目标通过。
8. q300 质量门禁失败：生成 F0 中位约 3,900 cents、periodicity 中位约 0.0002；目标对照为 7.8 cents/0.877。Phase 2 同时恶化 MR-STFT、LSD 和 RMS。当前 checkpoint 不可部署，完整集不得启动。

下一阶段不是继续扩大数据或压缩耗时，而是修复 differentiable CREPE 对绝对 activation/periodicity 缺乏监督的问题；具体门禁见第 13 节。

## 2. 实际数据合同

### 2.1 发布集与严格训练视图

源数据：

```text
/data/datasets/latent-cosmos-synth/serum-dataset
```

训练程序只读取：

```text
metadata/samples.jsonl
metadata/presets.jsonl
reports/qa_summary.json
reports/FORMAL2000_COMPLETE
```

实际规模：

| 视图 | Preset | WAV | 说明 |
|---|---:|---:|---|
| 当前完整发布集 | 2,000 | 123,225 | 含 178 个旧 profile preset |
| 严格视图 | 1,822 | 110,409 | 恰好 5 秒且发送音高 36–71 |
| q300 原始视图 | 300 | 18,604 | 六类别各选 50 preset |
| q300 eligible | 280 | 15,658 | 缓存、F0 窗口和三类 pair 均可用 |

严格 manifest：

```text
/data/midibrave/manifests/serum_strict_1822.jsonl
```

q300 eligible manifest：

```text
/data/midibrave/manifests/serum_quality300_eligible.jsonl
/data/midibrave/manifests/serum_quality300_eligible.meta.json
```

q300 eligible 的固定结果：

| 项目 | 数值 |
|---|---:|
| 源样本 | 18,604 |
| 具备单文件可用窗口 | 15,694 |
| 最终保留样本 | 15,658 |
| 最终保留 preset | 280 |
| Train | 252 preset / 14,086 WAV |
| Validation | 10 preset / 635 WAV |
| Test | 18 preset / 937 WAV |
| 最终训练音高范围 | MIDI 31–95 |
| 发送音高范围 | MIDI 36–71 |
| Velocity | 50、127 |

15,694 到 15,658 的差额来自 preset 级最小音高覆盖或三类稀疏 pair 覆盖约束，不是文件损坏。

### 2.2 标签语义

- 条件音高使用检测并审计后的 `midi_note`。
- `midi_note_sent` 和 `transpose_semitones` 仅用于来源审计，不能代替最终训练标签。
- 支持最终 MIDI 0–127 的 embedding/head；正式配置将数据范围限制为 21–109。
- 同一 preset 下相同最终 `(midi_note, velocity)` 的重复有效观察允许保留。
- Train/validation/test 按 preset 划分，避免同音色泄漏。

### 2.3 稀疏 pair 构造

每个训练样本只在同 preset、同 articulation 内选 A/B，并严格按以下循环采样：

| Pair 模式 | 比例 | 条件 |
|---|---:|---|
| Pitch-only | 50% | note 不同、velocity 相同 |
| Velocity-only | 25% | note 相同、velocity 不同 |
| Pitch+velocity | 25% | note 和 velocity 都不同 |

不存在找不到目标后随意退化到其它模式的 fallback；不具备全部三种模式的 preset 在 eligible 固化阶段被排除。

### 2.4 Decoder 窗口与 F0 mask

| 项目 | 配置 |
|---|---:|
| 采样率 | 44,100 Hz mono |
| 窗口 | 65,536 samples，约 1.486 秒 |
| Pitch hop | 128 samples |
| 窗口 pitch 帧 | 512 |
| 最低可靠帧比例 | 15%，即至少 77 帧 |
| CREPE periodicity | ≥ 0.5 |
| 相对最终 MIDI 音高误差 | ≤ 50 cents |
| 绝对能量下限 | −60 dB |
| 相对峰值动态范围 | 40 dB |

关键行为是：可靠帧条件只决定“这个窗口能否提供足够 MIDI/F0 监督”，并只 mask differentiable CREPE pitch loss。整段 waveform 仍进入 fullband/PQMF MR-STFT、envelope/delta、RMS 和 Phase 2 对抗训练，因此非周期瞬态、调制段和 release 片段不会因 F0 不可靠而自动从重建目标中删除。

但模型没有 gate、onset/offset、ADSR 或裁剪位置条件，因此不能把该行为解释为模型已经学会可独立控制的 note-on/note-off 包络；实时发声包络仍由宿主负责。

## 3. 模型与训练架构

### 3.1 双分支

一次 pair 同时重建：

```text
A_hat = Decoder(z_timbre_A, z_midi_A)
B_hat = Decoder(z_timbre_A, z_midi_B)
```

- `z_timbre_A` 来自冻结 CLAP embedding 经 Timbre Adapter。
- `z_timbre_B` 只用于同 preset 音色一致性和潜空间正则。
- `z_midi` 为逐 latent frame 的 32D `note + velocity` 条件。
- A/B 沿 batch 维合并，一次共享 Decoder forward 后拆分，避免重复 launch。
- Boids Engine 不参与训练，只在推理阶段替换音色潜变量来源。

### 3.2 MIDI 重复注入

MIDI 不只在入口融合：

1. 32D MIDI 条件与 128D timbre 合并，经 `160 → 1024 → 1024` fusion。
2. 每个 Decoder block 都有独立、零初始化的 temporal FiLM，重复注入逐帧 MIDI。
3. MIDI note 生成固定 RMS、连续相位、128 谐波的显式 excitation。
4. excitation 经同一 16-band PQMF 和因果下采样形成 `[2×, 4×, 8×, 8×]` 金字塔，再注入各 BRAVE stage。
5. velocity 不进入 excitation 固定增益，仍由模型从 v50/v127 数据中学习。

不构造 gate、pitch bend、ADSR、onset/offset、legato、release 或 take 字段。

### 3.3 参数量

| 模块 | 参数量 |
|---|---:|
| Timbre Adapter | 165,248 |
| MIDI Conditioner | 11,984 |
| Fusion | 1,214,464 |
| Decoder residual blocks | 4,471,680 |
| Decoder projections | 2,089,920 |
| Excitation pyramid | 2,080 |
| Output | 7,184 |
| Pitch adversary | 33,024 |
| **Generator 合计** | **7,995,584** |
| **BRAVE discriminator** | **1,940,451** |
| **Phase 2 可训练参数合计** | **9,936,035** |

Pitch adversary 使用完整 128-class MIDI head；不再假定原始 36 音发送网格就是最终标签空间。

## 4. 判别器替换结果

新判别器严格固定为三尺度 BRAVE Conv1d：每尺度通道为 `1 → 32 → 64 → 128 → 256`，四层 kernel 15 / stride 4 / padding 7 的 weight-norm Conv1d，最后接 1×1 输出层。三个尺度之间使用平均池化。

job 602，batch 2、65,536 samples、5 warm-up + 20 iterations：

| 架构 | 参数 | 中位 | P90 | 峰值 CUDA |
|---|---:|---:|---:|---:|
| 旧 scale+period | 33,529,288 | 155.834 ms | 162.185 ms | 1.576 GiB |
| 新 BRAVE 3-scale | 1,940,451 | 64.134 ms | 71.216 ms | 0.097 GiB |

结果：

- 参数减少 94.21%；
- 隔离判别器 workload 提速 2.43×；
- 隔离峰值显存减少约 93.8%；
- Phase 2 仍保留 hinge adversarial loss 和逐层纹理统计 feature matching。

Feature matching 比较时间维均值、log 标准差和 log 差分能量，不做逐位置 feature L1，避免把未知载波相位重新变成隐式 waveform loss。

## 5. Loss 设计与梯度审计

### 5.1 当前损失

| Loss | Self | Cross/共享 | 作用 |
|---|---:|---:|---|
| Fullband + 16-band PQMF MR-STFT | 1.0 | 0.25 | 谐波、频谱包络、低能高频细节 |
| Multi-scale envelope + delta | 0.05 | 0.0125 | 能量轮廓、局部变化、波纹 |
| Differentiable CREPE | 0.5 | 2.0 | 自重建音高与 MIDI-B 强控制 |
| Waveform RMS dB | 0.25 | 0.5 | 目标响度和 velocity 响应 |
| Velocity ranking | — | 0.5 | 同 note 两档 velocity 的真实响度方向 |
| Timbre pair cosine | — | 0.1 | 同 preset 跨 MIDI 音色一致性 |
| Latent variance/covariance | — | 0.01 | 防止音色潜空间坍缩 |
| Pitch adversary | — | 0.1 | 从 `z_timbre` 移除源 note 信息 |
| Generator adversarial | — | 1.0 | Phase 2 波形真实性 |
| Texture-stat feature matching | — | 2.0 | Phase 2 纹理、波纹和局部动态 |

不使用 sample-wise waveform L1/L2。独立裁剪的真实音频没有可预测的采样级初相位，直接 waveform loss 会惩罚感知等价但相位不同的结果。采样级 click/伪影由短窗和多带 STFT、包络差分、BRAVE 判别器及专项指标共同约束。

### 5.2 Velocity ranking 的自洽公式

实现先从真实音频计算：

$$
\Delta r_{target}=RMS_{dB}(B)-RMS_{dB}(A),\qquad s=\operatorname{sign}(\Delta r_{target})
$$

有效 mask：

$$
I=[n_A=n_B]\,[v_A\ne v_B]\,[|\Delta r_{target}|\ge 1\,dB]
$$

最终损失：

$$
L_{rank}=\operatorname{mean}_{I=1}\max(0,1-s[RMS_{dB}(\hat B)-RMS_{dB}(\hat A)])
$$

因此 `v_A = v_B` 时 mask 为 0，loss 严格为 0；方向来自真实音频，而不是错误假设 v127 必然比 v50 响。

### 5.3 job 607 逐项梯度结果

所有项均为有限值且路由到预期参数：

- self/cross STFT、envelope、pitch、RMS、velocity ranking：均更新约 7.96M 个生成参数；
- timbre pair、distribution：只更新 165,248 个 Timbre Adapter 参数；
- pitch adversary：更新 198,272 个 adapter + head 参数；
- discriminator hinge：更新恰好 1,940,451 个判别器参数；
- generator adversarial 与 feature matching：均能回传到生成器。

随机初始化时 cross pitch 的梯度显著大于 envelope/RMS，并在加权总 loss 中占主导；这符合“交叉分支首先服从注入 MIDI”的目标，但长训练仍需观察 pitch、STFT 与伪影指标是否失衡。当前没有仅凭一次随机梯度快照修改权重。

## 6. 训练正确性测试

| 测试 | 证据 | 结果 |
|---|---|---|
| 镜像内 CPU 回归 | 最终镜像 | 27/27 passed |
| CUDA CREPE 可微 | job 596 | passed |
| 真实 CLAP/CREPE 双阶段 pipeline | job 597 | Phase 1/2 各 3 个有效更新 |
| BRAVE 判别器基准 | job 602 | passed |
| 8 卡连续/恢复等价 | job 605 | Phase 1/2 passed |
| 8 卡 rank-local overflow | job 606 | 全局同时 skip，恢复后同步 step |
| 逐 loss 梯度审计 | job 607 | 全部有限且有梯度 |
| 固定 global batch 扫描 | job 608 | batch 1/2/4/8 全部通过 |

job 606 人工只在 rank 0 注入非有限梯度，结果 8 个 rank 同时跳过 G/D；下一次有限更新时 8 卡参数一致。跳过 loop 不消耗有效 update、学习率、adversary ramp 或 checkpoint 预算。

Checkpoint format 3 保存：

- loop/G/D 有效更新计数；
- G/D optimizer、共享 GradScaler；
- 每 rank RNG；
- sampler epoch 和 microbatch offset；
- world size、manifest/config/metadata hash；
- 判别器 architecture ID。

Phase 1 连续与恢复比较 23,995,268 个 tensor value，最大绝对差 `5.82e-11`；Phase 2 比较 29,816,663 个 value，最大绝对差约 `5.00e-7`，在 V100 FP16 的 `atol=1e-6, rtol=1e-5` 下通过。

## 7. 8 卡 batch sweep

固定：8×V100、全局 pair batch 64、每档 Phase 1/2 各 5 warm-up + 20 计时更新。

| Batch/GPU | Accum | P1 median | P1 P90 | P1 pairs/s | P2 median | P2 P90 | P2 pairs/s | 峰值 allocated |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 8 | 2.075 s | 2.260 s | 30.85 | 3.223 s | 3.399 s | 19.86 | 9.41 GiB |
| 2 | 4 | 1.014 s | 1.106 s | 63.14 | 1.598 s | 1.670 s | 40.04 | 10.19 GiB |
| 4 | 2 | 0.520 s | 0.547 s | 123.06 | 0.953 s | 1.130 s | 67.17 | 10.52 GiB |
| **8** | **1** | **0.360 s** | **0.403 s** | **177.62** | **0.514 s** | **0.549 s** | **124.49** | **12.72 GiB** |

batch 8 的补充观测：

- CUDA reserved 峰值约 13.568 GiB；
- Phase 1 data wait 中位 1.33 ms；
- Phase 2 data wait 中位 1.63 ms；
- 两阶段 GradScaler 均稳定为 2；
- G/D skip 均为 0；
- G/D 参数 delta 均非零。

因此正式配置为：

```yaml
batch_per_gpu: 8
grad_accum: 1
```

当前瓶颈是模型计算，不是 DataLoader；继续增加 worker 或引入 ZeRO 不会直接提高吞吐。

## 8. Checkpoint 与磁盘

batch 8 实际文件：

| 阶段 | 大小 |
|---|---:|
| Phase 1 | 96,273,568 bytes，约 91.81 MiB |
| Phase 2 | 119,610,024 bytes，约 114.07 MiB |

旧报告按 33.5M 判别器估算的约 498 MB Phase 2 checkpoint 已失效。新判别器下即使保留 125 个约 114 MiB 的里程碑，也约 14 GiB；实际建议保留 last 2、best、每 epoch 里程碑和最终模型。

q300 缓存约数百 MiB；完整严格集三类缓存预计为数 GiB，远小于 Octopus 当前数据盘余量。源 99 GB WAV 不复制，manifest 只引用原始路径。

## 9. 训练时长与五天结论

### 9.1 q300

q300 eligible Train 为 14,086 WAV，`repeats=16`，global pair batch 64：

$$
updates/epoch=14086\times16/64=3521.5
$$

正式取整：

- Phase 1：20 epochs，70,430 updates；
- Phase 2：5 epochs，17,608 updates。

按 batch 8 sweep：

| 口径 | Phase 1 | Phase 2 | 合计 |
|---|---:|---:|---:|
| Median 纯计算 | 7.05 h | 2.51 h | 9.56 h |
| P90 纯计算 | 7.88 h | 2.69 h | 10.57 h |
| 加 10% 工程余量 | — | — | 约 10.5–11.6 h |

### 9.2 1,000,000 + 250,000 updates

中位口径：

$$
T=1{,}000{,}000\times0.360317+250{,}000\times0.514097
=488{,}841\,s
=135.79\,h
=5.66\,days
$$

P90 口径：

$$
T_{P90}=150.03\,h=6.25\,days
$$

五天要求的加权平均必须不超过：

$$
432{,}000/1{,}250{,}000=0.3456\,s/update
$$

当前实测加权平均为 0.3911 s/update，差距为 1.1316×。因此：

> 在当前最终架构、全局 batch 64 和单台 Octopus 上，100 万 + 25 万 update 不能在五天内完成。该结论来自隔离的 8 卡有效 update 实测，不再是旧报告中受渲染干扰的单步外推。

可选策略是按数据 epoch 定义训练长度并由 validation 曲线 early-stop。完整严格集 eligible 数量固化后，报告将补充其精确 `updates/epoch` 以及 20+5 epoch ETA。

## 10. Octopus Infra 方案

正式任务保持 DDP，不启用 ZeRO：

- Phase 2 总可训练参数不足 10M；
- batch 8 已满足 global batch 64，无梯度累积；
- 显存主要来自 65,536-sample activation、CREPE 和频谱 loss，不是 optimizer state；
- ZeRO 不能显著降低主要 activation，占用通信和恢复复杂度没有收益依据。

推荐资源：

```text
partition=gpu8
gres=gpu:8
cpus-per-task=96
mem=110G
Docker --gpus "device=${CUDA_VISIBLE_DEVICES}"
Docker --shm-size=16g
```

推荐环境：

```text
OMP_NUM_THREADS=1
MKL_NUM_THREADS=1
NCCL_P2P_LEVEL=NVL
NCCL_IB_DISABLE=1
TORCH_NCCL_ASYNC_ERROR_HANDLING=1
```

运行规则：

1. GPU 作业全部经 SLURM + Docker。
2. 8 卡训练期间不运行 Serum 批量渲染，也不并发创建多个训练容器。
3. 每个 Phase 使用一个全新容器；同一 Phase 内保持长生命周期。Octopus 实测同一容器经历多小时 Phase 1 后再次启动 `torchrun` 可能看不到 CUDA。
4. 缓存写入使用临时文件 + atomic replace；重复预处理自动跳过有效文件。
5. 训练日志以有效 G/D update 计数，并记录 scale、finite、参数 delta、pairs/s、data wait、allocated/reserved 显存和原始/加权 loss。
6. Checkpoint resume 必须匹配 world size、数据 hash、配置 hash 和判别器 architecture ID。

完整 F0 预处理的 GPU 利用率仍偏低，后续可把多个 WAV 合并成批量 CREPE forward，或在单 GPU 内运行经过显存验证的多 worker 推理；这只影响一次性缓存时间，不改变训练 ETA。

## 11. 已完成的最终质量链

| Job | 内容 | 最终状态 |
|---:|---|---|
| 609 / 656 | 1,822-preset audio/CLAP/F0 完整缓存 | 110,409/110,409 完成 |
| 610 / 657 | 固化 full/q300 eligible manifest 和集合 hash | 完成 |
| 611 / 659 | q300 Phase 1 40,564 effective updates | 完成 |
| 611 / 665 | 修复后 q300 Phase 2 5,071 effective updates | 完成 |
| 612 / 684 | 同一 validation 集校准评估 Phase 1 | 完成 |
| 613 / 685 | 同一 validation 集校准评估 Phase 2 | 完成 |
| 686 | checkpoint、32 项指标和音频产物审计 | `status=pass` |

评估输出：

- median/P90 absolute F0 cents；
- octave error；
- MIDI swap following；
- velocity direction/margin accuracy 与 dB error；
- self/cross MR-STFT 和 LSD；
- 上 20% 频带能量误差代理；
- click rate、crest factor、envelope ripple；
- pitch adversary accuracy；
- same-preset timbre cosine 和 preset retrieval@1；
- 24 组 A/B/生成听音样例；
- 每阶段 6 preset × 36 notes × 2 velocities 的固定 MIDI 网格。

最终报告需要同时比较 Phase 1 和 Phase 2。只有 Phase 2 在不破坏 F0、MIDI swap、velocity 与音色解耦的前提下改善频谱/纹理/瞬态指标，才能判定 BRAVE 判别器有效；否则应回滚 Phase 2 权重或缩短对抗阶段，不能只凭 GAN loss 下降宣布成功。

## 12. 可追溯证据

关键 hash：

```text
source samples.jsonl:
d30a6d385adc941ab5dfce39c07094f12da25b58442759cd1ba5e512e0b321f3

source presets.jsonl:
629d90756a0b3453ef260a35303e73ffe7523f157254b3647b57462e5a273cbe

source qa_summary.json:
890815e0157954d632813160f4472116967237832a70dc1105c7991ab8c2f4d7

q300 eligible manifest:
32e136d21e774630f76b6749b4ee4f6504101cf4fac73008b344009da6ff3c6f

q300 retained sample IDs:
f55f79e478ad738f9d7627d65a81d7fe1fd57db86ddb8479562c7d72995b1870

q300 Phase 1 final checkpoint:
11497e6ad873022db95b9905ccde794744aad406c0b582354b1542d41f86e952

q300 Phase 2 final checkpoint:
7d4f4cd58e405bd013066d2da67ad40d8fe4a0b17dc0bdcb5203b0186de3f883

CLAP checkpoint:
fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd
```

正式配置：

```text
/home/jyhu/MidiBrave/configs/quality300_eligible.yaml
```

当前工程判定：

- 数据合同：通过；
- 模型/损失静态测试：通过；
- 真实 pipeline：通过；
- AMP/DDP 有效更新：通过；
- Checkpoint 精确恢复：通过；
- BRAVE 判别器规模与吞吐：通过；
- 8 卡容量：通过，正式 batch/GPU=10、global pair batch=80；
- 完整 eligible 16+2 epoch：median 14.54 h，P90+20% 约 21.95 h；
- q300 长程训练与产物完整性：通过，实测训练内计时 2.457 h；
- q300 音质/MIDI 控制：**失败**；
- 完整集启动：**禁止**，先修 differentiable CREPE pitch objective。

## 13. q300 最终质量判定

最终评估每阶段使用 256 对 validation pairs、96 个听音 WAV 和 432 个固定 MIDI-grid WAV。CREPE 按每条 waveform 独立调用官方 44.1 kHz resampy/Viterbi 路径，同时评估匹配目标音频作为校准对照。

| 指标 | Phase 1 | Phase 2 | 目标音频对照 |
|---|---:|---:|---:|
| F0 median | 3,903.76 cents | 3,895.17 cents | 7.84 / 7.82 cents |
| octave error | 100.00% | 92.58% | 约 0.49% |
| periodicity median | 0.00019 | 0.00021 | 0.877 |
| MIDI swap following | 41.67% | 45.31% | — |
| Cross MR-STFT median | 2.454 | 2.591 | — |
| Self MR-STFT median | 2.372 | 2.555 | — |
| Cross LSD median | 15.69 dB | 17.30 dB | — |
| Self LSD median | 16.10 dB | 18.10 dB | — |

目标对照正常、生成结果异常，已经排除评估器失准。训练末 25% 的 differentiable CREPE surrogate 却只有约 0.029，说明当前 softmax-relative pitch objective 可被低绝对 activation/低 periodicity 输出规避。扩大数据量不会自动修复该漏洞。下一轮须先加入 target-bin absolute activation/periodicity 或独立谐波 pitch 约束，并在 1k/5k update 门禁中达到 F0 median ≤50 cents、P90 ≤100 cents、octave error ≤1%、periodicity median ≥0.5、MIDI swap following ≥95%，再重跑 q300。
