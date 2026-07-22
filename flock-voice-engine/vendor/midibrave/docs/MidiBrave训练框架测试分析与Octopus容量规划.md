# MidiBrave 训练框架测试分析与 Octopus 容量规划

> 报告版本：v4.0（q300 历史实测 + Loss 修复短程门禁终版）  
> 更新时间：2026-07-18  
> 代码目录：`/home/jyhu/MidiBrave`  
> 基线 commit：`6f2d0bc0362be21a69dd3a5551d5a07191733522`，其上为本轮未提交实现  
> q300 历史镜像：`midibrave:v0.3.0-optimized`，image ID `sha256:3ee7dbea6b70c329d7d3aa976b4641ef8c8a0adee1ef6cbbe9f2286e2ad1d774`  
> 当前短程验证镜像：`midibrave:v0.7.0-condition-gain`（增益头仅为默认关闭的消融开关）  
> 36 小时优化执行依据：[MidiBrave训练耗时优化实施方案-v2-36小时.md](./MidiBrave训练耗时优化实施方案-v2-36小时.md)

## 1. 当前结论

MidiBrave 的数据接入、双分支训练、1.940M BRAVE 判别器、AMP/DDP 原子更新、精确恢复和耗时优化已经落地。完整缓存、严格 eligible 固化、优化组合门禁和 q300 自动训练/评估链也已执行。

已确认的核心结论如下：

1. Serum 当前交付不能按 2,000 preset × 72 格完整网格读取。训练以 `samples.jsonl` 为唯一事实源，以最终审计 `midi_note` 为条件，缺格不作为负样本。
2. 严格同 profile 视图为 1,822 preset、110,409 WAV；按 49,152-sample/75% 可靠 F0 合同固化后，完整 eligible 保留 1,550 preset、83,438 WAV，q300 保留 258 preset、14,043 WAV。
3. Decoder 重建完整的 49,152-sample 窗口。不可靠帧只从 pitch loss 中 mask；整段 waveform 仍进入 STFT、包络、RMS 和 Phase 2 对抗目标。
4. Generator 为 7,995,584 参数；新 BRAVE 判别器为 1,940,451 参数；Phase 2 总可训练参数为 9,936,035。判别器相对旧版减少 94.21%。
5. q300 历史镜像回归为 36 passed、1 skipped；当前 Loss 修复镜像回归为 41 passed、2 skipped，CUDA 2 passed。真实 pipeline、8 卡原子溢出、逐 loss 梯度、连续/恢复等价性和 44.1 kHz CREPE 评估合同均通过。
6. 正式配置为 `batch_per_gpu=10, grad_accum=1, global pair batch=80`。job 658 的 Phase 1/2 中位数为 188.421/229.369 ms，P90 为 235.506/300.088 ms。
7. q300 使用 16+2 epoch，即 40,564 + 5,071 个有效 updates。实测 Phase 1/2 训练内计时为 7,606.32 s + 1,239.23 s，合计 2.457 小时，与门禁预测 2.45 小时一致。
8. 完整严格 eligible 的训练 split 为 75,362 WAV；相同 16+2 epoch 约 241,159 + 30,145 updates，中位纯计算约 14.54 小时，P90 约 18.29 小时，已满足 36 小时目标。
9. `1,000,000 + 250,000` 只是旧的 update-count 方案；优化后的同样固定 update 数按新门禁中位数仍需约 68.28 小时。当前正式容量口径改为数据 epoch，不再把 125 万 updates 当作默认训练预算。
10. q300 的工程与性能门禁通过，但质量门禁失败：目标音频 F0 中位 7.84 cents、periodicity 中位 0.877；Phase 1 生成音频 F0 中位却为 3,903.76 cents，100% 帧发生 octave error，periodicity 中位仅 0.00019。Phase 2 仍为 3,895.17 cents/92.58% octave error，并同时恶化 MR-STFT、LSD 和 RMS 中位数。
11. differentiable CREPE 的低 periodicity 漏洞已在后续 1k/5k 短程实验中修复：Self/Cross F0 中位约 7.2–7.3 cents、periodicity 约 0.89、MIDI following 100%，旧 q300 的约 3,900 cents 坍塌不再出现。
12. Velocity 公式的同 velocity mask、真实 dB delta 和完整 render 固定参考均已实现；但固定 64 对未见 preset 的方向门禁仍只有 43.75%–46.88%。冻结表示同构头上限只有 60.9%–65.6%，raw 512D CLAP 强上限只有 59.4%–62.5%，证明原 80% 门禁对当前单源音频输入合同不可达。
13. 5,185 参数条件增益头只增加 0.0649% Generator 参数，但 C15 5k 没有改善跨 preset 方向，并使 Cross crest/ripple 退化；该消融不进入正式模型。正式 Generator/Phase 2 参数仍为 7,995,584/9,936,035。
14. 因此仍**不得启动完整 eligible 训练**。本次没有重跑 q300；下一轮必须先明确 Velocity 是“精确复现 Serum 任意非单调响应”，还是“统一、可预测的实时 MIDI 力度语义”。

这一区分很关键：训练框架、容量与 Pitch 控制现在都有正向证据，但完整产品训练仍被 Velocity 语义/信息合同阻塞。扩大数据量或继续提高同一组 loss 权重，不会让单个源音频自动包含未见 Serum preset 的任意 velocity 调制曲线。

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
| 完整 strict eligible | 1,550 | 83,438 | 49,152 窗口、75% 可靠 F0 与三类 pair 均可用 |
| q300 eligible optimized | 258 | 14,043 | q300 在同一正式合同下的子集 |

严格 manifest：

```text
/data/midibrave/manifests/serum_strict_1822_eligible.jsonl
```

q300 eligible manifest：

```text
/data/midibrave/manifests/serum_quality300_eligible_optimized.jsonl
/data/midibrave/manifests/serum_quality300_eligible_optimized.meta.json
```

q300 eligible 的固定结果：

| 项目 | 数值 |
|---|---:|
| 源样本 | 18,604 |
| 具备单文件可用窗口 | 14,098 |
| 最终保留样本 | 14,043 |
| 最终保留 preset | 258 |
| Train | 233 preset / 12,676 WAV |
| Validation | 9 preset / 560 WAV |
| Test | 16 preset / 807 WAV |
| 最终训练音高范围 | MIDI 31–95 |
| 发送音高范围 | MIDI 36–71 |
| Velocity | 50、127 |

14,098 到 14,043 的差额来自 preset 级最小音高覆盖或三类稀疏 pair 覆盖约束，不是文件损坏。完整 strict eligible 的 split 为 train 1,402 preset/75,362 WAV、validation 63/3,493、test 85/4,583。

job 609 的续跑作业 656 对 110,409 个严格源样本完成全量检查：audio 与 CLAP 全部复用，F0 新增 10,837、复用 99,572，最终缺失/损坏均为 0。按新 49,152/75% 合同，有 26,520 个完整集样本和 4,506 个 q300 样本因不存在足够可靠的 pitch window 被排除；它们不是缓存失败。

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
| 窗口 | 49,152 samples，约 1.115 秒 |
| Pitch hop | 128 samples |
| 窗口 pitch 帧 | 384 |
| 最低可靠帧比例 | 75%，即至少 288 帧 |
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
| 镜像内 CPU 回归 | job 683 最终镜像 | 36 passed、1 skipped |
| CUDA CREPE 可微 | job 596 | passed |
| 真实 CLAP/CREPE 双阶段 pipeline | job 597 | Phase 1/2 各 3 个有效更新 |
| BRAVE 判别器基准 | job 602 | passed |
| 8 卡连续/恢复等价 | job 605 | Phase 1/2 passed |
| 8 卡 rank-local overflow | job 606 | 全局同时 skip，恢复后同步 step |
| 逐 loss 梯度审计 | job 607 | 全部有限且有梯度 |
| 固定 global batch 扫描 | job 608 | batch 1/2/4/8 全部通过 |
| 优化后 8 卡原子溢出 | job 655 | 全 rank 同步 skip/recover，passed |
| 优化后 8 卡组合门禁 | job 658 | 性能、显存、finite、scale 全部 passed |

job 606 人工只在 rank 0 注入非有限梯度，结果 8 个 rank 同时跳过 G/D；下一次有限更新时 8 卡参数一致。跳过 loop 不消耗有效 update、学习率、adversary ramp 或 checkpoint 预算。

Checkpoint format 3 保存：

- loop/G/D 有效更新计数；
- G/D optimizer、共享 GradScaler；
- 每 rank RNG；
- sampler epoch 和 microbatch offset；
- world size、manifest/config/metadata hash；
- 判别器 architecture ID。

优化后 Phase 1 连续与恢复比较 23,995,268 个 tensor value，最大绝对差 `2.3283064365386963e-10`；Phase 2 比较 29,816,663 个 value，最大绝对差 `7.511116564273834e-7`，在 V100 FP16 的 `atol=1e-6, rtol=1e-5` 下通过。

调试期间发现 `DDP static_graph=true` 与条件 Self 分支不兼容：首个 update 后 `timbre.net.0.bias` 已跨 rank 分叉。正式配置固定为 `false` 并增加配置保护。关闭后各 rank 参数 hash 完全一致，因此不能为少量通信收益重新启用该选项。

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

该 sweep 是 65,536 窗口、全双分支的旧基线。优化后的正式配置由 job 658 重新验证为：

```yaml
window_samples: 49152
batch_per_gpu: 10
grad_accum: 1
self_full_fraction: 0.1
self_probability: 0.5
```

job 658（8×V100、global pair batch 80、去除冷启动后 20 个有效 update）：

| 阶段 | Median | P90 | Pairs/s | Data median | Peak allocated |
|---|---:|---:|---:|---:|---:|
| Phase 1 | 188.421 ms | 235.506 ms | 424.58 | 0.411 ms | 11.293 GiB |
| Phase 2 | 229.369 ms | 300.088 ms | 348.78 | 0.376 ms | 12.545 GiB |

两阶段 GradScaler 均保持 2，梯度有限，生成器和判别器参数均发生实际更新。当前瓶颈仍是模型与 loss 计算，不是 DataLoader；继续增加 worker 或引入 ZeRO 不会直接提高吞吐。

### 7.1 job 615/619 profiler 结论

单卡 job 615：

| 阶段 | Median | P90 | Data median | Peak allocated |
|---|---:|---:|---:|---:|
| Phase 1 | 518.727 ms | 535.225 ms | 3.079 ms | 12.669 GiB |
| Phase 2 | 876.608 ms | 891.510 ms | 3.359 ms | 12.679 GiB |

8 卡 job 619：

| 阶段 | Profiler median | P90 | Data median | Peak allocated | 对无 profiler 基线 |
|---|---:|---:|---:|---:|---:|
| Phase 1 | 728.116 ms | 825.754 ms | 3.827 ms | 12.699 GiB | 2.02× |
| Phase 2 | 959.808 ms | 981.529 ms | 3.348 ms | 12.716 GiB | 1.87× |

8 卡 CUDA range 的主要累计量（每 update）为：

| Range | Phase 1 | Phase 2 |
|---|---:|---:|
| MR-STFT | 98.527 ms | 75.852 ms |
| Differentiable CREPE | 76.175 ms | 73.120 ms |
| BRAVE Decoder | 75.635 ms | 58.173 ms |
| Optimizer/clip/scaler | 39.773 ms | 43.776 ms |
| Discriminator 所有调用 | — | 30.170 ms |
| Envelope | 19.600 ms | 17.036 ms |
| Harmonic excitation | 11.161 ms | 9.576 ms |

通信 range 为：Phase 1 每 update 约 `79.680 ms all-reduce + 27.277 ms all-gather + 20.481 ms reduce-scatter`；Phase 2 约 `104.500 + 47.431 + 62.964 ms`。这些 range 会嵌套、并行，并包含等待最慢 rank 的时间，不能相加为 wall time。代码审计确认，固定每步执行的 `latent_distribution_loss` 使用可求导 all-gather，反向对应 reduce-scatter；Phase 2 还增加 G/D 两套梯度同步。

最终已采用：batch/cache 音频 loss、固定 excitation band bank、静态 MIDI/timbre fast path、Phase 2 8B→6B、fused AdamW、DDP gradient bucket view/bucket 16，以及 Cross-always/Self-sampled 调度。`static_graph` 因 rank 参数分叉被否决；latent moments 在 B=10、dim=128 时通信量高于 gather；局部 compile 未覆盖主要端到端热点且门禁已通过，三者均不进入正式配置。完整公式和风险边界见 v3 优化实施方案。

## 8. Checkpoint 与磁盘

batch 8 实际文件：

| 阶段 | 大小 |
|---|---:|
| Phase 1 | 96,273,568 bytes，约 91.81 MiB |
| Phase 2 | 119,610,024 bytes，约 114.07 MiB |

旧报告按 33.5M 判别器估算的约 498 MB Phase 2 checkpoint 已失效。新判别器下即使保留 125 个约 114 MiB 的里程碑，也约 14 GiB；实际建议保留 last 2、best、每 epoch 里程碑和最终模型。

q300 缓存约数百 MiB；完整严格集三类缓存预计为数 GiB，远小于 Octopus 当前数据盘余量。源 99 GB WAV 不复制，manifest 只引用原始路径。

## 9. 训练时长与 36 小时结论

### 9.1 q300

q300 optimized Train 为 12,676 WAV，`repeats=16`，global pair batch 80：

$$
updates/epoch=12676\times16/80=2535.2
$$

正式取整：

- Phase 1：16 epochs，40,564 updates；
- Phase 2：2 epochs，5,071 updates。

按 job 658 门禁：

| 口径 | Phase 1 | Phase 2 | 合计 |
|---|---:|---:|---:|
| Median 纯计算 | 2.12 h | 0.32 h | 2.45 h |
| P90 纯计算 | 2.65 h | 0.42 h | 3.08 h |

实际训练内计时：

| 实测 | Phase 1 | Phase 2 | 合计 |
|---|---:|---:|---:|
| 有效训练时间 | 7,606.32 s / 2.113 h | 1,239.23 s / 0.344 h | 8,845.55 s / **2.457 h** |
| 有效 updates | 40,564 | 5,071 | 45,635 |
| AMP 原子 skip | 18 | 1 | 19 |

skip 不计入有效 update；最终计数和学习率调度均精确到目标步数。Phase 1 最终 checkpoint 在 job 659 完整写入，随后同一长生命周期容器内第二次 `torchrun` 无法看到 CUDA；Phase 2 改由 fresh-container job 665 从 Phase 1 checkpoint 启动并完成。该事件没有重算或污染 Phase 1 权重，且训练脚本现已固定为“每个 Phase 一个全新容器”。

### 9.2 q300 最终质量评估

最终可信评估使用 job 684/685：每阶段固定 256 对 validation pairs，并为生成音频和匹配目标音频分别调用 `torchcrepe 0.0.24` 的 singleton 44.1 kHz 官方 resampy/Viterbi 路径。目标音频对照证明评估器本身有效：

| 校准指标 | Phase 1 评估集 | Phase 2 评估集 |
|---|---:|---:|
| target F0 median / P90 | 7.84 / 19.08 cents | 7.82 / 19.16 cents |
| target periodicity median | 0.877 | 0.877 |
| target low-periodicity rate | 2.39% | 2.39% |
| target octave-error rate | 0.49% | 0.49% |

生成结果：

| 指标 | Phase 1 | Phase 2 | 判定 |
|---|---:|---:|---|
| F0 absolute median / P90 | 3,903.76 / 5,505.66 cents | 3,895.17 / 5,505.44 cents | 两阶段均失败 |
| F0 signed mean | +3,888.10 cents | +3,637.94 cents | 系统性高频偏置，不是零均值抖动 |
| octave-error rate | 100.00% | 92.58% | Phase 2 仍不可用 |
| periodicity mean / median | 0.00253 / 0.00019 | 0.03946 / 0.00021 | 几乎没有稳定基频 |
| low-periodicity rate | 100.00% | 95.40% | 失败 |
| MIDI swap following | 41.67% | 45.31% | 未证明 MIDI 独立控制 |
| Cross MR-STFT median | 2.454 | 2.591 | Phase 2 恶化 5.6% |
| Self MR-STFT median | 2.372 | 2.555 | Phase 2 恶化 7.7% |
| Cross LSD median | 15.69 dB | 17.30 dB | Phase 2 恶化 10.2% |
| Self LSD median | 16.10 dB | 18.10 dB | Phase 2 恶化 12.4% |
| Cross/Self RMS error median | 2.20 / 2.00 dB | 2.83 / 2.72 dB | Phase 2 恶化 28.5% / 36.2% |
| Cross/Self upper-band error median | 3.44 / 2.84 dB | 2.54 / 2.31 dB | Phase 2 改善 26.3% / 18.6% |
| Velocity direction / margin | 43.48% / 21.74% | 43.48% / 26.09% | 仅 23 个有效 pair，仍不合格 |
| Velocity delta median | 3.13 dB | 3.34 dB | Phase 2 略恶化 |
| Timbre cosine / retrieval@1 | 0.9966 / 76.95% | 0.9966 / 76.95% | latent 一致，但不能抵消波形失败 |
| Pitch adversary accuracy | 2.73% | 3.13% | chance 为 0.78%；Phase 2 未改善 |

Phase 2 的 crest/ripple 和上频带能量误差有局部改善，但 generated-click 分布从 Phase 1 的高 median 变为 Phase 2 的近零 median + 更高 P90，呈明显两极化；结合更差的 STFT/LSD/RMS，不能解释为稳定消除了瞬态伪影。BRAVE 对抗阶段没有通过“保持 MIDI 控制并改善纹理”的验收条件。

训练末 25% 日志中的 differentiable CREPE surrogate 已经很低：Phase 1 Cross/Self 为 0.0287/0.0285，Phase 2 为 0.0980/0.0911；但官方 CREPE 校准仍显示上述灾难性 F0。后续短程工作已按该根因完成 absolute activation、hard negative 与目标 MIDI 周期自相关修复。5k 结果达到 Self/Cross F0 约 7.2–7.3 cents、periodicity 约 0.89、MIDI following 100%，因此本节只保留为旧 q300 的历史故障证据，不再代表当前 Pitch loss 状态。

新的启动前置条件已经转为 Velocity 语义与信息合同：在精确 Serum 响应和统一实时 MIDI 力度语义之间做出选择，并针对所选语义重新设计可观察输入与门禁；选择完成前不运行 Phase 2 或长程训练。

### 9.3 完整严格 eligible 与旧 125 万 updates 口径

完整严格 eligible 的 Train 为 75,362 WAV。同一正式配置下：

- Phase 1 16 epochs：241,159 updates；
- Phase 2 2 epochs：30,145 updates；
- Median 纯计算：14.54 h；
- P90 纯计算：18.29 h；
- P90 再加 20% 工程余量：约 21.95 h。

因此完整集 16+2 epoch 在单台 Octopus 上已具备明确的 36 小时**性能容量**余量，但当前 q300 质量门禁失败，所以这里只是容量结论，不构成启动授权。旧 `1,000,000 + 250,000` 固定 update 方案若机械套用新门禁仍约需：

$$
T=1{,}000{,}000\times0.188421+250{,}000\times0.229369
\approx68.27\,h
$$

它已不是正式训练建议。用数据 epoch 固定每条观察的暴露量更可解释，也避免在数据规模变化后仍维持任意的百万步预算。

### 9.4 Loss 修复短程实测

Pitch/Velocity 修复使用相同 8×V100、global pair batch 80 和 49,152-sample 窗口。C15 冷启动到 1k 用时 300.81 秒，从同一 config 的 1k checkpoint 精确续跑到 5k 用时 829.44 秒；总计约 18.84 分钟，平均约 6.03 updates/s，峰值 allocated 11.36 GiB/卡，0 次 AMP skip。

| 候选 | Generator 参数 | 1k | 5k | 关键结果 |
|---|---:|---:|---:|---|
| C12 | 7,995,584 | 0 项失败 | 3 项失败 | Pitch/重建通过；Velocity direction 43.75% |
| C15 | 8,000,769 | 0 项失败 | 4 项失败 | Velocity direction 46.88%；crest/ripple 退化 |

条件增益头的 5,185 参数不会改变训练 ETA；完整 eligible 的 14.54 h median / 18.29 h P90 容量结论仍成立。但这是纯性能容量，不是当前启动授权。

短程失败不是算力不足：冻结 C15 表示并脱离 Decoder 单独训练同构头，训练 preset direction 为 96.8%–97.5%，固定未见 preset 只有 60.9%–65.6%；raw CLAP 强上限也只有 59.4%–62.5%。这把问题定位为跨 preset 信息不可辨识，而不是 5k 训练时长不足。

## 10. Octopus Infra 方案

正式任务保持 DDP，不启用 ZeRO：

- Phase 2 总可训练参数不足 10M；
- batch 10 已满足 global batch 80，无梯度累积；
- 显存主要来自 49,152-sample activation、CREPE 和频谱 loss，不是 optimizer state；
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
3. 每个 Phase 使用一个全新容器；禁止在经历多小时训练的同一容器里启动第二次 `torchrun`。同一 Phase 内保持容器长生命周期，减少 snapshotter 抖动。
4. 缓存写入使用临时文件 + atomic replace；重复预处理自动跳过有效文件。
5. 训练日志以有效 G/D update 计数，并记录 scale、finite、参数 delta、pairs/s、data wait、allocated/reserved 显存和原始/加权 loss。
6. Checkpoint resume 必须匹配 world size、数据 hash、配置 hash 和判别器 architecture ID。

q300 长程抽查时 8 张 V100 的利用率为 87–95%，显存约 10.6 GiB/卡，温度 52–70°C；所有 GPU 的 active throttle reason 为 0，volatile uncorrected ECC 为 0。门禁与正式运行都没有显示硬件降频或 ECC 风险。

q300 固化配置的 `log_every=20` 与确定性 Self 两步周期同相，warm-up 后日志只观察一个奇偶位；发生 AMP skip 时该奇偶位还会翻转。它不影响实际训练，但不能用 `metrics.jsonl` 中的 `self_branch_executed` 行均值估计真实执行率。job 658 的逐步日志和 q300 的 Self 行均已验证交替与 `1/p=2` 缩放。为保持已完成 checkpoint 的 config hash，`quality300_eligible.yaml` 保留 20；未来配置模板 `base.yaml`/`quality300.yaml` 已改为奇数周期 21。

完整 F0 预处理的 GPU 利用率仍偏低，后续可把多个 WAV 合并成批量 CREPE forward，或在单 GPU 内运行经过显存验证的多 worker 推理；这只影响一次性缓存时间，不改变训练 ETA。

## 11. 自动作业链

| Job | 内容 | 当前状态 |
|---:|---|---|
| 609 / 656 | 1,822-preset audio/CLAP/F0 完整缓存 | 已完成；110,409/110,409，有效旧缓存自动复用 |
| 610 / 657 | 固化 full/q300 eligible manifest、集合 hash 和 q300 config | 已完成 |
| 658 | 优化后 8 卡 Phase 1/2 门禁 | 已完成，status=pass |
| 611 / 659 | q300 Phase 1 | 已完成 40,564 updates；最终 checkpoint 完整，阶段切换时旧容器 CUDA 失效 |
| 611 / 662 | 首次 Phase 2 | 发现跨 Phase GRL 仍按 Phase 1 计数，主动终止并归档，未产生正式 checkpoint |
| 611 / 665 | 修复后 Phase 2 | 已完成 5,071 updates；GRL 从首步启用，fresh container |
| 612 / 684 | Phase 1 最终校准评估 | 已完成；256 pairs、96 listening WAV、432 MIDI-grid WAV |
| 613 / 685 | Phase 2 最终校准评估 | 已完成；256 pairs、96 listening WAV、432 MIDI-grid WAV |
| 686 | 链尾完整性审计 | `status=pass`；checkpoint、步数、32 项指标、文件数和 hash 全通过 |
| 683 | 最终镜像与回归 | 已完成；36 passed、1 skipped |
| 615 | 单卡 Phase 1/2 profiler | 已完成 |
| 616 | 原 8 卡 profiler | Docker 多 GPU 引号错误，容器启动前失败 |
| 619 | 固化脚本后的 8 卡 Phase 1/2 profiler | 已完成；trace 已落盘，用于热点归因，不用于 wall-time 容量外推 |
| 728 | Velocity 独立/对齐 crop oracle | 已完成；证明旧相对标签不可达 |
| 729/730/735 | 完整 render 参考镜像、配置与梯度审计 | 已完成；CPU/CUDA/真实 batch 均通过 |
| 731–737 | C12/C13 1k 与 C12 5k | C12 1k 通过；5k 仅 Velocity 与轻微 crest 失败 |
| 738 | C12 checkpoint 响应审计 | 发现 93.75% 全局“高 velocity 更响”偏置 |
| 739/740 | Condition gain 镜像与梯度审计 | 已完成；5,185 参数，梯度有限非零 |
| 741–746 | C14/C15 1k 与 C15 5k | 1k 通过；C15 5k Velocity、crest、ripple 失败 |
| 747 | C15 checkpoint 响应审计 | Target/Predict Pearson 0.0987 |
| 748/749 | 冻结表示与 raw CLAP 上限审计 | 未见 preset 最高 65.6%/62.5%，原门禁不可达 |

历史 q300 成功链为 `665 → 683 → 684 → 685 → 686`，其中训练结果不因评估器修复而变化。短程 Loss 修复链最终收口为 `745 → 746 → 747 → 748/749`，结论是 Pitch 修复有效、Velocity 原门禁不可辨识，没有向 q300 继续提交。任何上游非零退出都会阻止下游使用不完整 checkpoint；训练脚本会自动发现各 Phase 最新 `step-*.pt` 并续跑。q300 首个正式断点为 `phase1/step-000002536.pt`，96,275,040 bytes，SHA-256 为 `7d902417a93c3f5ae6886c947f13a6e5a66d160241b4d44e36398dd5cd7de74e`。

评估输出：

- generated/target median/P90 absolute F0 cents、signed bias、periodicity 与 low-periodicity rate；
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

上述比较描述的是历史 q300 checkpoint，因此两阶段仍不能部署。后续短程 Phase 1 已建立有效 MIDI Pitch 控制，但尚未产生通过完整 Velocity 门禁的新 Phase 1 checkpoint，也没有运行新的 Phase 2。BRAVE 判别器是否能在已修复 Pitch 的输入上改善纹理仍未验证，不能沿用旧 q300 的 GAN 结果，也不能在 Velocity 语义未决时直接启动。

## 12. 可追溯证据

关键 hash：

```text
source samples.jsonl:
d30a6d385adc941ab5dfce39c07094f12da25b58442759cd1ba5e512e0b321f3

source presets.jsonl:
629d90756a0b3453ef260a35303e73ffe7523f157254b3647b57462e5a273cbe

source qa_summary.json:
890815e0157954d632813160f4472116967237832a70dc1105c7991ab8c2f4d7

full eligible manifest:
043d5f434dc41537cc31dfbe7d103e7db3b7a367198ff126a3e7639b66d4df49

full retained sample IDs:
0a2a3210fe888324cb46865d102a231661d9c19a7491144392d4e437019a02e5

full pitch cache collection:
a3a41610f938d50361cbf3179bfb24d1d0997a0e3c30b59b976e27d60b688b04

full CLAP cache collection:
b95f426ab64c8db26adb42ac470788910e8db0b71d267c6f6ae5c35840082a78

q300 optimized eligible manifest:
32e136d21e774630f76b6749b4ee4f6504101cf4fac73008b344009da6ff3c6f

q300 optimized retained sample IDs:
f55f79e478ad738f9d7627d65a81d7fe1fd57db86ddb8479562c7d72995b1870

q300 pitch cache collection:
0ef5137f73eaada2cd85ec376c40fb845524cd1f2031e4dbfd36d3585abc5f00

q300 CLAP cache collection:
226f135e72d6bdbd9bf4bfa3764cfd65196e531f4c55a1fa8c79fe8c5dcb8b62

q300 Phase 1 final checkpoint:
11497e6ad873022db95b9905ccde794744aad406c0b582354b1542d41f86e952

q300 Phase 2 final checkpoint:
7d4f4cd58e405bd013066d2da67ad40d8fe4a0b17dc0bdcb5203b0186de3f883

Loss repair C12/C13 training code:
231c3116f2bcf518833ac1bd130bca0968ed0727bab427ca5415aa4c3fbbaaed

Condition-gain C14/C15 training code:
cbcf8983b35a67e7029a704d7df4f987309a095bc3f34acaabe0c46a437c03c8

Short quality evaluator/gate:
70b4d718232d96e8d8e761569bfd8a65ff19c0b3c0b1dabe4c4363cd4565a410

CLAP checkpoint:
fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd
```

历史 q300 固化配置（仅用于复现，不代表当前可启动配置）：

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
- 8 卡容量：通过，正式 batch=10/global batch 80；
- 36 小时完整集容量：通过，组合门禁中位纯计算约 14.54 h；
- q300 长程训练：通过，Phase 1/2 有效步数与 checkpoint 审计完成；
- q300 评估产物完整性：通过，job 686 `status=pass`；
- q300 音质/MIDI 控制：**失败**，生成 F0、periodicity、MIDI following、velocity 和重建指标未达门禁；
- 修复后短程 Pitch/MIDI 控制：**通过**，F0、periodicity、MIDI following 和重建主指标均达标；
- 修复后 Velocity 原门禁：**不可达**，已由冻结表示与 raw CLAP 两层上限审计证实；
- 条件增益头：消融失败，默认关闭，不进入正式模型；
- 未来完整集是否启动：**否**。先明确 Velocity 产品语义并修改可观察输入或监督合同，再重新通过 1k/5k；之后才允许新的 q300。
