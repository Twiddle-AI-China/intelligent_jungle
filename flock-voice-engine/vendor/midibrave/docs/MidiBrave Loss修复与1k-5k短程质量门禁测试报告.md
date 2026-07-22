# MidiBrave Loss 修复与 1k/5k 短程质量门禁测试报告

> 状态：本轮执行完成；Pitch 修复通过，Velocity 原门禁被证明对当前输入合同不可达  
> 日期：2026-07-18  
> 范围：仅 Phase 1；未运行 Phase 2、q300 或完整 eligible 训练  
> 固定合同：44.1 kHz、49,152 samples（约 1.115 秒）、32D `note + velocity` MIDI 条件

## 1. 最终结论

本轮没有把一个失败候选包装成“通过”。实际结论分为两部分：

1. **Pitch loss 已修复并通过 1k/5k 验证。** 旧 q300 的低 periodicity 漏洞被 5k 同规模 B0 复现；加入绝对 target-bin activation、hard negative 与目标 MIDI 周期自相关后，C9/C12/C15 的 Self/Cross F0 中位误差稳定在约 7.2–7.3 cents，periodicity 约 0.89，MIDI swap following 为 100%，旧模型约 3,900 cents 的坍塌已消失。
2. **Velocity 的“未见 preset、完整 render RMS 方向准确率 ≥80%”不是当前 loss 权重问题，而是输入不可辨识问题。** 当前 Decoder 只接收单个源音频的 CLAP/timbre 表示与目标 MIDI。数据又明确允许 v127 比 v50 更响或更轻，且这种方向会随 preset、note 改变。冻结表示的隔离增益头在训练 preset 上达到 96.8%–97.5%，在固定未见 preset 门禁上只有 60.9%–65.6%；绕过 128D adapter、直接使用 raw 512D CLAP 和 132,609 参数头，未见 preset 仍只有 59.4%–62.5%。因此继续调大 loss、增加 velocity pair 比例或扩大增益头，只会提高训练集拟合并增加伪影，不能使原门禁达到 80%。

本轮按预定的不可达性终止条件停止：**没有晋升任何完整候选，没有修改门禁阈值来制造通过，也没有启动 q300。** 下一步必须先选择 Velocity 语义：要么给模型增加可观察的 preset 级多条件上下文，以复现 Serum 的任意非单调响应；要么把 MIDI velocity 定义成统一的可控力度语义，并改用与该语义一致的训练目标和门禁。

## 2. 修复内容

### 2.1 Pitch objective

旧实现主要监督冻结 CREPE activation 归一化后的相对分布。极低置信或宽带输出仍可能在 softmax 后形成可优化的相对峰，导致 surrogate 下降而波形没有稳定目标基频。

修复后的目标为：

$$
L_{pitch}=L_{cents}+\lambda_{KL}L_{KL}+\lambda_{act}L_{act}
+\lambda_{neg}L_{hardneg}+\lambda_{ac}L_{autocorr}.
$$

- `cents`：目标 MIDI 对应 CREPE soft-bin 的音分误差；
- `KL`：低权重相对分布项，最终候选关闭，避免重新主导；
- `activation`：目标 bin 绝对 activation 与真实 target periodicity 匹配；
- `hard_negative`：目标峰必须高于目标区间外最强错误峰；
- `autocorrelation`：匹配目标 MIDI 周期处的真实/生成归一化自相关。

数值边界包括：波形帧标准差在反向中 `detach` 且下限为 `1e-2`；自相关分母在开方前设下限；periodicity 只在已有可靠 F0 mask 中使用，不新增 gate、ADSR、onset/offset 或 pitch-bend 标签。

最终已验证的 Pitch 组合是：

```yaml
pitch_kl: 0.0
pitch_activation: 1.0
pitch_hard_negative: 0.25
pitch_autocorrelation: 20.0
self_pitch: 0.5
cross_pitch: 1.0
cross_stft: 0.5
```

### 2.2 Velocity 公式修复

方向由真实数据决定，不假设 v127 必然更响：

$$
\Delta r_t=RMS_{dB}(B)-RMS_{dB}(A),\qquad
\Delta r_p=RMS_{dB}(\hat B)-RMS_{dB}(\hat A).
$$

有效 mask：

$$
I=[n_A=n_B][v_A\ne v_B][|\Delta r_t|\ge1\,dB].
$$

方向与差值项：

$$
L_{rank}=\operatorname{mean}_{I=1}\max(0,1-\operatorname{sign}(\Delta r_t)\Delta r_p),
$$

$$
L_{delta}=\operatorname{SmoothL1}(\Delta r_p/6,\Delta r_t/6).
$$

当 `v_A == v_B` 时，mask 严格为 0，两个 loss 都返回 0；已经消除旧公式在 `sign(0)=0` 时仍恒等于 margin 的矛盾。

### 2.3 独立 crop 合同修复

旧实现用 A/B 两个独立随机 crop 的 RMS 差监督一个不接收 crop offset 的确定性 Decoder。job 728 的目标侧 oracle 已证明：

| 目标构造 | Direction 上限 | Margin 上限 | Delta median | 方向翻转 |
|---|---:|---:|---:|---:|
| A/B 独立随机 crop | 68.47% | 68.47% | 3.154 dB | 95.31% 条件对会翻转 |
| A/B 对齐相同 offset | 79.59% | 79.59% | 0.519 dB | 仍低于固定 80% 门禁 |

因此 C12 之后将相对 Velocity 标签改为每个 WAV 的完整 render 固定 RMS；Self/Cross 的 STFT、包络、Pitch 和绝对 RMS 仍使用随机训练窗口。这个修改解决了“同一条件标签随 crop 随机翻转”的错误，但没有解决“未见 preset 的任意非单调响应无法从单个源观察推断”的更深层问题。

### 2.4 最小架构消融

C14/C15 增加可选 `ConditionalOutputGain`：

```text
[z_timbre(128), z_midi(32)] -> Linear(160,32) -> SiLU -> Linear(32,1)
gain_db = 12 * tanh(output)
waveform *= 10 ** (gain_db / 20)
```

- 最后一层零初始化，启用瞬间严格等价于 identity；
- 只增加 5,185 参数，占 Generator 的 0.0649%；
- 输出限制为 ±12 dB；
- 不改变 Pitch、相位或频谱结构，只提供短路径幅度控制。

真实 batch 梯度审计中，增益头的 `velocity_rank`/`velocity_delta` 梯度均有限且非零，所以失败不是断梯度。C15 仍在未见 preset 上接近随机，并在 5k 增加 crest/ripple 退化，因此该模块保留为默认关闭的研究开关，不进入正式配置。

## 3. 候选与门禁结果

### 3.1 全部候选

| 候选 | 核心变化 | 1k | 5k | 决策 |
|---|---|---:|---:|---|
| B0 | 稳定化后的旧 Pitch surrogate | 失败 9 项 | 失败 19 项 | 复现 Pitch 坍塌，仅作基线 |
| C5–C8 | 逐步加入 activation/negative/autocorrelation，调 Cross 权重 | 均有 1–2 项重建失败 | — | 用于确定 C9 |
| C9 | Pitch 修复 + Cross STFT 0.5 | 通过 | 失败 3 项 Velocity | Pitch 修复基线 |
| C10/C11 | 独立 crop 下增强 RMS/rank/delta | 通过 | 均失败 6 项 | 错误标签合同，不晋升 |
| C12 | 完整 render 参考，rank/delta 各 1 | 通过 | 失败 3 项 | 最佳无增益头候选；Velocity 原门禁不可达 |
| C13 | 完整 render 参考，较强 RMS/rank/delta | 失败 1 项 | — | 1k Cross LSD 超线 0.541 dB |
| C14 | C12 + 5,185 参数增益头 | 通过 | — | 1k Velocity margin 无改善，不续跑 |
| C15 | C13 权重 + 增益头 | 通过 | 失败 4 项 | 增益头消融失败，不晋升 |

### 3.2 C12 与 C15 关键数值

| 指标 | C12 1k | C12 5k | C15 1k | C15 5k |
|---|---:|---:|---:|---:|
| Self/Cross F0 median（cents） | 7.224 / 7.232 | 7.269 / 7.302 | 7.236 / 7.211 | 7.254 / 7.282 |
| Self/Cross MR-STFT median | 4.245 / 3.793 | 2.890 / 2.734 | 3.244 / 3.151 | 2.729 / 2.644 |
| Self/Cross LSD median（dB） | 25.365 / 26.518 | 22.691 / 21.174 | 22.711 / 22.590 | 22.791 / 21.100 |
| Velocity direction | 48.44% | 43.75% | 45.31% | 46.88% |
| Velocity 1 dB margin | 0% | 3.13% | 23.44% | 9.38% |
| Velocity delta median | 1.638 dB | 1.755 dB | 1.571 dB | 1.802 dB |
| Cross crest P90 | 2.2943 | 2.1225 | 2.1426 | 2.1763 |
| Cross ripple P90 | 0.06797 | 0.07354 | 0.07942 | 0.08144 |

C12 5k 的三个失败项：

- Cross crest P90 `2.12255 > 2.10836`，仅超线 0.67%；
- Velocity direction `43.75% < 80%`；
- Velocity margin `3.125% < 60%`。

C15 5k 的四个失败项：

- Cross crest P90 `2.17629 > 2.10836`；
- Cross ripple P90 `0.08144 > 0.07541`；
- Velocity direction `46.875% < 80%`；
- Velocity margin `9.375% < 60%`。

两者的 Pitch、periodicity、MIDI following、MR-STFT、LSD、RMS、upper-band、click 和有效 update 合同均通过。C15 相比 C12 没有解决方向问题，反而扩大两个伪影指标，因此不能继续加权。

## 4. Velocity 不可辨识性证据

### 4.1 目标分布与模型响应

固定 64 对门禁只覆盖 6 个 validation preset。目标中“高 velocity 更响”的比例恰好为 50%，完整 render 的有序差值中位为 0.0397 dB，P10/P90 为 −1.8866/2.4763 dB；同一个 preset 内方向还会随 note 翻转。

| Checkpoint | 预测高 velocity 更响 | Direction | Margin | Delta error | Pearson(target, prediction) |
|---|---:|---:|---:|---:|---:|
| C12 5k | 93.75% | 43.75% | 3.13% | 1.755 dB | 0.0306 |
| C15 5k | 78.13% | 46.88% | 9.38% | 1.802 dB | 0.0987 |

C15 只是减弱了全局“v127 更响”偏置，没有学到真实的 preset+note 非单调函数。

### 4.2 冻结表示的同构头上限

job 748/749 排除 Decoder、波形 loss 和联合优化干扰，冻结 C15 5k 的 `z_timbre/z_midi`，只训练与生产模块相同的 5,185 参数增益头。16,384 个训练 pair 中有 5,134 个满足 1 dB mask。

| Seed | Train direction | Validation direction | Validation margin | Validation delta | Validation Pearson |
|---:|---:|---:|---:|---:|---:|
| 20270716 | 97.00% | 60.94% | 45.31% | 2.516 dB | 0.214 |
| 20270717 | 97.55% | 65.63% | 50.00% | 1.791 dB | 0.231 |
| 20270718 | 96.83% | 60.94% | 57.81% | 3.055 dB | 0.303 |

头有足够容量记住训练 preset，却不能泛化到未见 preset；训练步数、梯度和头大小均不是瓶颈。

### 4.3 Raw CLAP 强上限

job 749 进一步绕过 128D Timbre Adapter，直接输入 raw 512D source CLAP、归一化/周期 note 特征和 velocity，使用 132,609 参数的 `516→256→1` 增益头：

| Seed | Train direction | Validation direction | Validation margin | Validation delta | Validation Pearson |
|---:|---:|---:|---:|---:|---:|
| 20280716 | 95.31% | 59.38% | 40.63% | 2.262 dB | 0.275 |
| 20280717 | 96.32% | 59.38% | 40.63% | 1.850 dB | 0.215 |
| 20280718 | 97.08% | 62.50% | 39.06% | 1.760 dB | 0.196 |

更大的输入和 25.6 倍参数没有提高未见 preset 的方向准确率，反而进一步确认目标响应不是单个源音频中稳定可推断的属性。原 80% 门禁不能靠 loss 调优达到。

## 5. 回归、规模与耗时

### 5.1 测试

最终实验镜像：`midibrave:v0.7.0-condition-gain`。

- CPU：41 passed、2 skipped；
- CUDA：2 passed；
- 完整 render 参考真实 batch 梯度审计：通过；
- Condition gain 模块梯度审计：rank/delta 均有限非零；
- C12/C15 训练均精确到 5,000 个有效 generator updates，0 次 AMP skip；
- DDP、原子更新和 format-3 精确 resume 合同保持不变。

### 5.2 参数量

| 结构 | 参数量 |
|---|---:|
| 正式 Generator（默认无增益头） | 7,995,584 |
| 实验 Generator（C14/C15） | 8,000,769 |
| Condition gain 增量 | 5,185（+0.0649%） |
| BRAVE discriminator | 1,940,451 |
| 正式 Phase 2 合计 | 9,936,035 |
| 实验 Phase 2 合计 | 9,941,220 |

### 5.3 短程耗时

- C15 冷启动到 1k：300.81 秒；
- C15 1k→5k 精确续跑：829.44 秒；
- 完整 C15 5k 训练约 18.84 分钟，平均约 6.03 updates/s；
- 峰值 CUDA allocated 约 11.36 GiB/卡；
- 0 次无效更新，最终 GradScaler=8。

5,185 参数头对吞吐没有可观测影响。完整集容量仍沿用既有 16+2 epoch 估算；本轮没有授权长程训练。

## 6. 代码、配置与作业追溯

代码 SHA-256：

```text
C12/C13 training:
231c3116f2bcf518833ac1bd130bca0968ed0727bab427ca5415aa4c3fbbaaed

C14/C15 training:
cbcf8983b35a67e7029a704d7df4f987309a095bc3f34acaabe0c46a437c03c8

evaluation/gate:
70b4d718232d96e8d8e761569bfd8a65ff19c0b3c0b1dabe4c4363cd4565a410
```

配置 SHA-256：

```text
C12 90945aca4c8f335dbde63fcf17b77615ecbeda2b86f38c6a2b2dd069cc50e0dd
C13 125745b10f4aea628faaa50441647c2bb76cbc4fe3d58d0016af72b52411ca99
C14 bc63ab1a7aaaa3382304c37311f14eb962d5498daf774323d053aaf4255ed524
C15 2db5932afbae9bbb111c7639411123a2759d1ea79eff12edcb83f1af90b254d0
```

| Job | 内容 | 结果 |
|---:|---|---|
| 728 | 独立/对齐 crop 目标 oracle | 证明旧 crop 目标不可达 |
| 729 | 完整 render 参考镜像回归 | CPU 40 pass/2 skip；CUDA 2 pass |
| 730 | C12/C13 配置、数据合同与梯度准备 | 通过 |
| 731/733 | C12 1k 训练/评估 | 0 项失败 |
| 732/734 | C13 1k 训练/评估 | Cross LSD 1 项失败 |
| 735 | 完整 render Velocity 梯度审计 | 通过 |
| 736/737 | C12 1k→5k/评估 | 3 项失败 |
| 738 | C12 checkpoint 响应审计 | 发现全局高力度偏置 |
| 739 | Condition gain 镜像回归 | 通过 |
| 740 | C14/C15 配置与增益头梯度审计 | 通过 |
| 741/743 | C14 1k 训练/评估 | 0 项失败 |
| 742/744 | C15 1k 训练/评估 | 0 项失败 |
| 745/746 | C15 1k→5k/评估 | 4 项失败 |
| 747 | C15 checkpoint 响应审计 | Pearson 0.0987，仍接近 chance |
| 748 | 冻结表示同构头上限 | Validation 60.9%–65.6% |
| 749 | Raw CLAP 强上限 | Validation 59.4%–62.5% |

远端产物：

```text
/data/midibrave/loss_tuning/
/home/jyhu/MidiBrave/artifacts/
```

## 7. 下一步决策边界

### 路径 A：精确复现 Serum 的 Velocity 响应

需要扩大模型可观察信息，而不是继续调 loss。可行方向是给 Timbre Encoder 输入同一 preset 的多 note/多 velocity 上下文，显式编码 velocity response curve；或提供 Serum preset 参数/调制矩阵等能够决定响应的元数据。完成后可保留非单调真实 delta 与 80% 方向门禁，并重新从 1k 开始测试。

### 路径 B：定义统一的实时 MIDI Velocity 语义

如果产品目标是“velocity 可预测地控制力度”，而不是复刻每个 Serum preset 的任意调制路由，应定义统一的单调响度/亮度响应曲线。原始 WAV 仍用于音色与频谱重建，但不能同时要求输出复现与统一语义相反的任意 RMS 方向。门禁应改为条件交换后目标重建改善、感知差异与规定控制曲线，而不是拟合不可推断的完整 render RMS 符号。

在路径 A/B 明确前：

- 不晋升 C12、C14 或 C15；
- 不启用 `condition_gain_hidden`；
- 不运行 Phase 2、q300 或完整 eligible；
- 不继续增加 Velocity loss 权重；
- Pitch 修复代码与评估器保留，作为下一轮共同起点。
