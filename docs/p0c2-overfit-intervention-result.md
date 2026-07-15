# P0-C2：受控 overfit 与 pitch intervention 结果

## 结论

P0-C2 管线已经跑通，但显式 pitch 控制闸门未通过。2,000-step 小样本训练后，
decoder 学会了使用新增条件路径的一部分信息，却仍然主要从 `z_timbre` 读取音高。
固定同一个 latent、只替换目标 `f0` 时，输出基本停留在参考音高。

这不是数据量不足的结论，也不应通过直接延长同一种 reconstruction 训练来处理。
当前训练目标允许 encoder 把 pitch 留在 latent，decoder 完全可以忽略显式 `f0`；
继续训练只会进一步强化这条捷径。

## 本轮训练结构

数据使用 P0-C1b 验证通过的 8 个 Dexed preset，共 48 条受控 render：

```text
16 kHz render
  → 一次性重采样到 44.1 kHz
  → 128-sample 对齐裁切
  → audio [1, 131072]
  → renderer truth conditioning [3, 1024]
       f0       = commanded MIDI × preset octave offset
       loudness = 当前裁切 waveform 的逐帧 RMS
       gate     = renderer note-on/off event
```

训练不再使用 NCCF/RMS gate 猜标签，也关闭了会破坏标签对齐的随机 phase mangle。
48 条通过 16 个确定性裁切重复形成 768 个 overfit examples；98/2 split 得到
752 train / 16 validation examples。

为避免从随机权重重新学习音色，conditioned model 从已完成 1,000,000-step phase-1
的 BRAVE baseline 初始化：

- 165/166 个 shape-compatible tensors 成功迁移；
- decoder 迁移 78 个 tensors；
- 新增 FiLM 与 condition downsampler 等 11 个 tensors 保持新初始化；
- qgpu job 88 完成 2-step paired-label smoke；
- qgpu job 89 完成 2,000-step overfit，耗时 1 分 58 秒；
- best checkpoint SHA-256：
  `b9b877383609072989fc5fba7d0b4b7750ce29e74c21cefdc0896cfe8dd31252`。

## Intervention 协议

对每个 preset：

1. 编码 MIDI 56 / velocity 75 的参考音频，取 posterior mean 作为固定 latent；
2. loudness 及 gate 保持不变；
3. 仅将显式 `f0` 分别替换成 MIDI 41 / 48 / 56 / 63 对应频率；
4. 解码四次，用 pYIN 测输出中央稳定段音高；
5. 同时记录 pitch-response slope、输出差异和 harmonic-envelope similarity。

因此 intervention 直接回答的是因果问题，而不是同条件 reconstruction 是否好听。

## 实测结果

qgpu job 91 在 32 次干预上得到：

| 指标 | 结果 | 判读 |
|---|---:|---|
| voiced interventions | 32 / 32 | 输出都有可测音高 |
| median absolute pitch error | 805 cents | 失败 |
| P95 absolute pitch error | 2670 cents | 失败 |
| median pitch-response slope | 约 0.000 | **显式 f0 基本不改变输出音高** |
| median pairwise waveform RMS difference | 0.00118 | 四个条件的输出几乎相同 |
| median harmonic-envelope cosine | 0.99987 | 因输出没真正换音高，不能算成功的音色保持 |

多数 preset 的四个输出都停留在参考 MIDI 56 附近。例如 `BrightPad6` 四个目标
音高的输出都约 207.65 Hz；`Perky 04` 都约 830.61 Hz。FiLM projection weight
norm 已从 smoke 的约 `0.046–0.132` 增长至 `0.434–3.488`，说明条件支路确实收到
梯度，但 reconstruction loss 没有要求它必须承担 pitch。

## Residual latent probe

32 个 pitch clips 上做了 leave-one-preset-out ridge probe，目标是 commanded MIDI。
同时报告 raw pooled latent 和每个 preset 内去中心后的 latent：

| 表示 | baseline median error | conditioned median error |
|---|---:|---:|
| raw | 570 cents | 616 cents |
| within-preset centered | 564 cents | 634 cents |

这批 8-preset/32-sample 数据上的线性 probe 跨音色泛化很差，不能据此声称 latent
已去除 pitch。更强的事实证据来自 intervention：固定 latent 后输出牢牢保持参考
音高，证明 decoder 仍有一条不依赖显式条件的 pitch 路径。probe 在这里保留为诊断，
不作为单独通过条件。

## 下一步：P0-C3 paired pitch-swap

下一轮不扩大 corpus，先改变训练问题：

```text
同一 preset 的 source note A ─→ Encoder ─→ z_source ─────────┐
                                                               ├→ Decoder → target audio B
target note B 的 f0/loudness/gate ─→ excitation + multi-FiLM ──┘
```

即 encoder 看 A，reconstruction target 是同 preset 的 B。由于目标音高与 source
latent 中的音高不一致，decoder 只有使用 target condition 才能降低损失。建议：

1. 先以 pitch-pair swap 为主、identity reconstruction 为辅；
2. 先冻结已训练 encoder，避免整个表示在极小 pilot 上漂移；
3. 继续使用多尺度频谱损失，不追求逐样本相位完全一致；
4. 重跑完全相同的 32 次 intervention；
5. 只有 pitch slope 接近 1 且误差下降后，再考虑 gradient reversal / pitch
   adversarial classifier 来进一步清理 residual latent。

当前 checkpoint 的正确结论是“显式结构和真值数据管线已成立，但普通同条件
reconstruction 不会自动产生 pitch disentanglement”。
