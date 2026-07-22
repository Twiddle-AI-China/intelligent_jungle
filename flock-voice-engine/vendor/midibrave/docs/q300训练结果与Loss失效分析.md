# q300 训练结果与 Loss 失效分析

> 分析日期：2026-07-18  
> 对象：`midibrave_quality300_optimized_v03` Phase 1 / Phase 2  
> 结论：工程与性能链通过，模型质量门禁失败；当前两个 checkpoint 均不可部署，也不可作为完整集训练起点。

## 1. 运行与产物

q300 使用正式 Serum eligible 子集中的 12,676 个训练 WAV、233 个训练 preset，global pair batch 为 80：

| 阶段 | Epoch | 有效 update | 训练内计时 | 最终 checkpoint SHA-256 |
|---|---:|---:|---:|---|
| Phase 1 | 16 | 40,564 | 7,606.32 s | `11497e6ad873022db95b9905ccde794744aad406c0b582354b1542d41f86e952` |
| Phase 2 | 2 | 5,071 | 1,239.23 s | `7d4f4cd58e405bd013066d2da67ad40d8fe4a0b17dc0bdcb5203b0186de3f883` |

远端产物：

```text
/data/midibrave/runs/midibrave_quality300_optimized_v03/phase1
/data/midibrave/runs/midibrave_quality300_optimized_v03/phase2
/data/midibrave/evaluation/quality300-optimized-phase1
/data/midibrave/evaluation/quality300-optimized-phase2
```

每阶段最终评估均包含 256 个 validation pair、96 个 A/B/生成试听 WAV，以及 6 preset × 36 notes × 2 velocities 的 432 个 MIDI grid WAV。目标音频和生成音频使用同一 singleton torchcrepe 44.1 kHz 官方重采样/Viterbi评估合同。

## 2. 训练 Loss 曲线

下表只统计成功执行 generator optimizer update 的行，使用前 10% 和后 25% 日志中位数，避免起始极端值与 AMP skip 干扰：

| 指标 | 前 10% | 后 25% | 变化 |
|---|---:|---:|---:|
| P1 Cross STFT | 5.6951 | 3.1488 | -44.7% |
| P1 Self STFT | 5.7114 | 3.1176 | -45.4% |
| P1 Cross Pitch surrogate | 0.302657 | 0.028031 | -90.7% |
| P1 Self Pitch surrogate | 0.301237 | 0.027835 | -90.8% |
| P1 Cross Envelope | 1.3350 | 0.594599 | -55.5% |
| P1 Cross RMS | 0.163848 | 0.026703 | -83.7% |
| P2 Cross STFT | 3.1558 | 3.1715 | +0.5% |
| P2 Cross Pitch surrogate | 0.033377 | 0.094437 | +183% |
| P2 Self Pitch surrogate | 0.032803 | 0.084836 | +159% |
| P2 Discriminator | 1.9297 | 0.497559 | -74.2% |

Phase 1 的代理目标在数值上明显下降，说明数据、反向传播和 optimizer 正常工作。但 Phase 2 中判别器迅速变强的同时，Cross/Self pitch 与 STFT 停滞或恶化，已经不是健康的质量精修。

`total` 不能跨行或跨阶段直接比较：

- Phase 1 前 10% 每步执行 Self，之后 Self 每两步执行一次并在执行时乘 `1/p=2`；
- `log_every=20` 与两步 Self 周期同相，日志会偏向某一奇偶位；
- Phase 2 新增 adversarial 和 feature matching，目标定义发生变化；
- Phase 2 最后一行 `total=2.174` 没有执行 Self，而 Phase 1 最后一行 `total=7.606` 执行了 Self。

因此本轮只能判断各同名分项的趋势，不能把较小的 Phase 2 `total` 解释为模型质量改善。

## 3. 官方校准质量结果

### 3.1 音高与 MIDI 控制

| 指标 | Phase 1 | Phase 2 | 目标音频对照 |
|---|---:|---:|---:|
| F0 absolute median | 3,903.76 cents | 3,895.17 cents | 7.84 / 7.82 cents |
| F0 absolute P90 | 5,505.66 cents | 5,505.44 cents | 19.08 / 19.16 cents |
| F0 signed mean | +3,888.10 cents | +3,637.94 cents | 接近 0 |
| Periodicity mean | 0.002532 | 0.039458 | 0.845777 |
| Periodicity median | 0.000190 | 0.000207 | 0.877012 |
| Low-periodicity rate | 100.00% | 95.40% | 2.39% |
| Octave error | 100.00% | 92.58% | 约 0.49% |
| MIDI swap following | 41.67% | 45.31% | 目标应接近 100% |

生成音频 periodicity 接近零，因此约 3,900 cents 的 CREPE 结果不能理解为一个稳定高四个八度的乐音；它更符合非周期、宽带或高频伪影让解码器选择高频 bin 的表现。关键失败是没有稳定基频，而不是一个简单的整体 transpose 偏差。

目标音频对照正常，证明 MIDI 标签、目标音频和官方评估路径本身有效。

### 3.2 重建与伪影

| 指标中位数 | Phase 1 | Phase 2 | Phase 2 变化 |
|---|---:|---:|---:|
| Cross MR-STFT | 2.4543 | 2.5910 | +5.6% |
| Self MR-STFT | 2.3725 | 2.5547 | +7.7% |
| Cross LSD | 15.69 dB | 17.30 dB | +10.2% |
| Self LSD | 16.10 dB | 18.10 dB | +12.4% |
| Cross RMS error | 2.20 dB | 2.83 dB | +28.5% |
| Self RMS error | 2.00 dB | 2.72 dB | +36.2% |
| Cross upper-band error | 3.44 dB | 2.54 dB | -26.3% |
| Self upper-band error | 2.84 dB | 2.31 dB | -18.6% |
| Cross envelope ripple | 0.01306 | 0.01188 | -9.1% |
| Self envelope ripple | 0.01309 | 0.01218 | -7.0% |

Phase 2 对上频带能量、crest factor 和 envelope ripple 的典型样本略有改善，证明 BRAVE 判别器确实改变了波形纹理；但主重建指标全部恶化。Click 指标的中位数大幅改善而 P90 继续恶化，呈现部分样本改善、部分样本严重失败的分化，而不是稳定的整体提升。

Velocity 校准只有 23 个满足真实响度差至少 1 dB 的有效 pair：direction accuracy 两阶段均为 43.48%，margin accuracy 为 21.74%/26.09%，delta error median 为 3.13/3.34 dB。该项未通过，但样本数也不足以支撑精细权重结论，下一轮需增加定向 velocity-only 评估。

## 4. 失效原因

### 4.1 直接原因：Pitch surrogate 丢失绝对置信度

当前实现先对 CREPE raw activation 做：

$$
p_k=\operatorname{softmax}\left(\frac{\operatorname{logit}(a_k)}{0.1}\right),
$$

再监督 soft-bin 期望 cents 与相对 KL 分布。这个归一化只关心 bin 之间的相对大小，不关心所有 activation 是否都很低。生成音频只需让目标附近的某个低置信 bin 略高，经低温 softmax 锐化后即可得到很小的 surrogate。

此外，当前权重来自目标音频的 `valid × confidence`，没有对生成音频自身的 target-bin absolute activation 或 periodicity 施加约束。实测 Phase 1 末 25% Cross/Self surrogate 已为 0.0287/0.0285，官方 periodicity median 却只有约 0.0002，构成直接的代码—实测对应证据。

### 4.2 幅度域重建无法单独保证周期相位

Phase 1 的主重建项为 fullband/PQMF magnitude MR-STFT、envelope 和 RMS，没有 raw waveform、complex phase、目标周期自相关或谐波栅格约束。许多相位不连贯甚至宽带化的波形仍可接近目标频谱包络和能量。

原设计依赖 pitch surrogate 补足周期性，但 surrogate 恰好存在低置信漏洞，因而形成“STFT 正常下降、输出仍近乎无周期”的假收敛。

### 4.3 Phase 2 判别器不感知目标 MIDI 且学习率占优

Phase 2 学习率为：

```text
synthesis generator  1e-5
condition modules     1e-6
discriminator         2e-4
```

判别器只接收波形，能判断“是否像真实 Serum 音频”，不能判断“是否符合注入 MIDI”。它比 generator/conditioner 使用高 20×/200× 的学习率，并从一个已经没有正确 F0 的 Phase 1 开始训练。因此 D loss 快速下降，而 pitch、MR-STFT、LSD 和 RMS 同时恶化。

### 4.4 Loss 比例与可绕过的 excitation

Phase 1 末 25% 的典型加权值中，Self STFT 在执行步约为 6.24，折算 50% 采样期望约为 3.12；Cross STFT 约为 0.79，Cross pitch 只有约 0.056。Loss 数值不等同于梯度，但它说明 pitch surrogate 一旦被做低，训练会主要继续优化 Self 频谱重建。

Harmonic excitation 当前只通过零初始化 FiLM 调制进入残差块，初始为严格 identity，也没有直接残差加到 PQMF 输出。Decoder 在函数上允许忽略 excitation/z_midi；当 pitch loss 有更容易的捷径时，这个架构自由度会加剧 MIDI bypass。该项属于强可疑因素，需要 loss 修复后的消融才能确定贡献。

### 4.5 训练/评估路径差异

训练使用 torchaudio differentiable resample 与自定义 soft-bin 解码，评估使用 torchcrepe 官方 resampy/Viterbi 路径。两者差异可能放大 surrogate gap，但目标对照正常且 periodicity 相差四个数量级，因此它是次要因素，不是唯一原因。

## 5. 已排除或非主要原因

- **数据/标签错误**：目标 F0 与 periodicity 对照正常。
- **评估器整体失准**：同一 evaluator 在目标音频上达到 7.8 cents/0.877。
- **AMP 损坏训练**：Phase 1/2 仅原子跳过 18/1 个非有限 update，比例低于 0.05%，checkpoint 最终状态有限。
- **单纯数据量不足**：数据量可能限制音色泛化，却不能解释 surrogate 约 0.029 与真实 periodicity 约 0.0002 的错配；扩大数据可能只让模型更充分利用漏洞。
- **Velocity ranking 等式问题**：当前实现已对 `velocity_a == velocity_b` 和真实响度差不足 1 dB 做 mask，不会造成 F0 崩溃。

## 6. 决策

1. Phase 1 是 pitch surrogate 假收敛；Phase 2 在错误起点上又引入了不感知 MIDI 的对抗目标，不能作为修复手段。
2. 当前两个 checkpoint 均不可部署、不可继续完整集训练，也不作为下一轮 warm-start。
3. 下一轮先增加 target-bin absolute activation、hard-negative 和独立目标周期自相关，在相同 seed/数据下执行 1k 渐进门禁和 5k 严格门禁。
4. Phase 1 通过前不运行 Phase 2；5k 通过后也不自动运行 q300，等待单独授权。

## 7. 后续短程修复结果（2026-07-18）

第 6 节第 3 项已经执行完成：absolute target-bin activation、hard negative 和目标 MIDI 周期自相关消除了旧 q300 的 Pitch 坍塌。5k 候选的 Self/Cross F0 中位约 7.2–7.3 cents、periodicity 约 0.89、MIDI swap following 100%，因此本文关于 Pitch surrogate 的根因判断得到实验证实。

新的阻塞项是 Velocity 信息合同，而不是 Pitch：数据允许 v127 相对 v50 的完整 render RMS 方向随 preset 和 note 非单调变化，但当前模型只接收单个源音频 timbre 表示。冻结表示同构头在训练 preset 上达到约 97%，未见 preset 只有 60.9%–65.6%；raw 512D CLAP 强上限也只有 59.4%–62.5%，低于原 80% 门禁。最小条件增益头没有解决该问题，并增加 Cross crest/ripple 退化。

因此后续没有重跑 q300。完整测试、公式、候选和作业证据见 [MidiBrave Loss修复与1k-5k短程质量门禁测试报告.md](./MidiBrave%20Loss修复与1k-5k短程质量门禁测试报告.md)。
