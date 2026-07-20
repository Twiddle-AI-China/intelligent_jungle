# MidiBrave C9 质量优先、完整计算训练档案

此目录现在保存“质量优先版”，不是逐项关闭所有加速的旧代码复刻。原则是：恢复可能改变训练目标或训练暴露量的缩减，同时保留不改变目标的工程优化，供更强 GPU 云服务器训练。

## 文件

- `full_fixed_1m_250k.yaml`：推荐的云端完整训练配置。每个 update 都计算 Self + Cross，Phase 1/2 固定为 1,000,000 + 250,000 updates。
- `quality300_20plus5.yaml`：同一质量优先语义的长程 q300 对照。每步 Self + Cross，20 + 5 epochs，即 50,704 + 12,676 updates。

当前 Octopus 耗时优化版仍位于：

- `configs/full_c9_optimized.yaml`：Self 条件执行、16 + 2 epochs；
- `configs/quality300_c9_optimized.yaml`：相同优化语义的 q300，40,564 + 5,071 updates。

## 两个版本的边界

| 项目 | 当前 Octopus 优化版 | 质量优先云端版 |
|---|---:|---:|
| 数据窗口 | 49,152 | 49,152 |
| Pitch 有效帧比例 | 75% | 75% |
| 目标 global pair batch | 80 | 80 |
| Cross 计算 | 每个 update | 每个 update |
| Self 计算 | 前 10% 每步，之后约 50% updates | 每个 update |
| 正式预算 | 16 + 2 epochs | 1,000,000 + 250,000 updates |
| 静态 MIDI 快路 | 开 | 开 |
| Excitation band cache | 开 | 开 |
| Batched loss/discriminator forward | 开 | 开 |
| Hann/RMS 等确定性缓存 | 开 | 开 |
| Fused AdamW | 开 | 开 |
| DDP bucket view | 开，16 MiB | 开，16 MiB |

恢复的只有两类可能影响最终质量的缩减：Self 分支抽样和训练预算。49,152 没有恢复为 65,536，因为已有感受野分析表明它仍覆盖约 6.7 倍 Decoder 感受野、约 3 倍最长 loss 尺度；目前也没有证据证明 65,536 会更好。更重要的是，C9 短程门禁与正式 eligible manifest 都锁定在 49,152/75% 合同。贸然改为 65,536 会同时改变数据覆盖和 loss 统计，必须另做 q300 消融，不能混入“完整预算”版本。

## Global pair batch 80

定义为：

```text
global pair batch = GPU 数 × 每卡 pair batch × 梯度累积次数
```

当前 8 卡参考配置为 `8 × 10 × 1 = 80`。一个 pair 是 `(audio_A, midi_A, audio_B, midi_B)` 条件对；Cross 每 pair 必算，Self 是否额外解码由 profile 决定。因此 global pair batch 不是“输出 WAV 数”：优化版一个 update 平均约 1.5 个分支/对，质量优先版固定 2 个分支/对。

迁移到云服务器时应优先保持 global pair batch 80，以维持 C9 已验证的梯度统计：

| GPU 数 | 每卡 batch | grad accumulation | Global batch |
|---:|---:|---:|---:|
| 2 | 20 | 2 | 80 |
| 4 | 20 | 1 | 80 |
| 8 | 10 | 1 | 80 |
| 16 | 5 | 1 | 80 |

具体每卡 batch 需要按云端 GPU 显存 profiling 决定。即使 H100 能装下更大 batch，也不建议未经 scaling gate 直接把 global batch 提高到 160/320；那会改变梯度噪声、每个 update 的样本暴露量和学习率语义，不属于严格“无损加速”。

## C9 loss

质量优先版与当前优化版使用完全相同的原始 C9：

- `cross_stft=0.5`、`cross_pitch=1.0`；
- `pitch_kl=0`；
- `pitch_activation=1.0`；
- `pitch_hard_negative=0.25`；
- `pitch_autocorrelation=20.0`；
- `velocity_rank=0.5`、`velocity_delta=0`；
- `condition_gain_hidden=0`。

这样 A/B 结果只反映 Self 计算频率和训练预算，而不会重新引入旧 pitch objective 的失效。进一步降低 Velocity 权重将不再是原始 C9，需要另立候选门禁。

## 当前 C9 是否还要跑 q300

需要。C9 目前只完成 Phase 1 的 1k/5k 门禁；它证明短程 Pitch 修复有效，但尚未证明：

- 40k 级 Phase 1 不会再次坍塌或过拟合；
- BRAVE discriminator 加入后的 Phase 2 不会破坏 F0/MIDI following；
- 对抗训练不会增加 click、crest、ripple、LSD 和高频伪影；
- Self 抽样与 16 + 2 epoch 预算在长程中仍足够。

当前优化 q300 为 40,564 + 5,071 updates。C9 5k Phase 1 实测为 826.51 秒，即约 0.1653 秒/update；历史 q300 Phase 2 相对 Phase 1 的耗时倍率约 1.303。按此估算：

- Phase 1 约 1.86 小时；
- Phase 2 约 0.30 小时；
- 纯训练约 2.17 小时；
- 加 checkpoint、容器启动、两阶段评估与 10%–20% 波动，建议预留 2.5–3.0 小时，不含 SLURM 排队。

新的 q300 门禁应把 Velocity 指标降为观察项，不能因为已证明不可辨识的 Velocity direction/margin 未达标而否决 C9；Pitch、MIDI following、重建、瞬态与伪影指标仍必须作为硬门禁。

## 训练暴露量与使用约束

全量训练 split 为 75,362 WAV、`repeats=16`、global batch 80，因此每 epoch 约 15,072.4 updates：

- Phase 1 的 1,000,000 updates 约为 66.34 epochs；
- Phase 2 的 250,000 updates 约为 16.59 epochs。

这远高于当前 16 + 2 epoch 配置，不能假设更多 updates 必然持续改善；云端正式训练仍应保存每 epoch checkpoint，并用非 Velocity 的 Pitch、MIDI following、STFT/LSD、瞬态、纹波和伪影指标选择 best checkpoint。固定大预算表示“允许训练到这里”，不表示只能使用最后一个 checkpoint。

该配置直接引用当前冻结的 49,152/75% 全量 eligible manifest。同步到云端时必须连同 dataset、CLAP/pitch cache、manifest 和 metadata 一起传输，并保持 hash 不变。
