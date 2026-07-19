# P0-C3：paired pitch-swap 结果

## 结论

paired pitch-swap 证明了当前 BRAVE + multi-FiLM 结构可以学习显式音高控制，但
尚未对全部 pilot 音色通过。最终 6/8 preset 的四音高 intervention 全通过；总体
median error 为 10 cents，median pitch-response slope 为 0.992。P0-C2 的对应结果
是 805 cents 和约 0。

剩余两个失败音色是 `PERC BELL` 和 `PRIML WOOD`。继续训练已进入收益很低的阶段，
不能把 6/8 写成完整成功，也不应直接扩大 corpus。

## 训练目标

P0-C2 使用 identity reconstruction：

```text
audio A → Encoder → z_A + condition A → reconstruct A
```

decoder 可以从 `z_A` 读取音高，忽略 condition。P0-C3 改为：

```text
同 preset 的 audio A → frozen Encoder → z_A ───────────┐
                                                         ├→ Decoder → audio B
不同 note 的 target condition B → excitation + FiLM ───┘
```

实现约束：

- 只使用 velocity 75 的 32 条 pitch renders；
- source/target 来自同一 preset，MIDI note 必不相同；
- source/target 使用相同的 128-sample 对齐裁切起点；
- target 的 f0、loudness、gate 均来自 target render；
- encoder 从 P0-C2 best 初始化后冻结；
- train 与 validation 都使用 swap reconstruction，没有 validation identity shortcut；
- 本阶段只运行 RAVE phase 1 的多尺度 fullband/multiband spectral losses。

## 训练记录

| qgpu job | 作用 | steps | 结果 |
|---:|---|---:|---|
| 93 | paired dataset + frozen encoder smoke | 2 | 训练、validation、checkpoint 全通 |
| 94 | 首轮 pitch-swap | 2,000 | 5/8 presets 通过；median 10 cents；slope 0.993 |
| 97 | 从 job 94 best 继续 | 3,000 | 6/8 通过；gross error ratio 21.9% |
| 99 | 从 job 97 best 继续 | 5,000 | 仍为 6/8；gross error ratio 18.8% |
| 100 | 最终 intervention | — | 32 次固定-latent 四音高评测 |

三个训练 job 每次重置 optimizer；累计约 10k pitch-swap steps。最终选择 job 99
global step 4216 的 best checkpoint，而不是该 job step 4960 的 last checkpoint。
checkpoint SHA-256：

`cd3bb6369e500d61ce4395dfe33caa3904a608cd599ea776a145bd7b9f1d0be9`

## 最终 intervention

| 指标 | P0-C2 identity | P0-C3 paired swap |
|---|---:|---:|
| presets fully passed | 0 / 8 | **6 / 8** |
| median absolute pitch error | 805 cents | **10 cents** |
| P95 absolute pitch error | 2670 cents | 2670 cents |
| gross error ratio >100 cents | — | 18.75% |
| median pitch-response slope | 约 0.000 | **0.992** |
| median harmonic-envelope cosine | 0.9999（条件未生效） | 0.9680 |
| pairwise waveform RMS difference | 0.00103 | 0.03462 |

P95 仍很差，因为失败集中在两个 preset，而不是所有音色都有中等误差。

### 通过的 6 个 preset

| preset | median error | max error | slope |
|---|---:|---:|---:|
| `brassy:1` | 20 | 30 | 0.989 |
| `Perky 04` | 0 | 20 | 0.992 |
| `SynLead.02` | 10 | 10 | 0.996 |
| `SteelDrm.A` | 5 | 10 | 0.995 |
| `Vibe.06` | 10 | 20 | 0.992 |
| `BrightPad6` | 0 | 10 | 0.996 |

单位均为 cents；通过要求四个目标音高全部 ≤50 cents、输出 voiced ratio ≥0.60、
且 per-preset slope 在 `[0.90, 1.10]`。

### 未通过的 2 个 preset

- `PERC BELL`：median 130 cents，max 1910 cents，slope 0.776。追加训练曾让
  它部分跟随目标，但仍有 gross error。
- `PRIML WOOD`：median 2710 cents，max 3810 cents，slope 约 0。输出 pYIN
  voiced probability 约 0.01，实际更接近无稳定音高，而不是可信的 68.9 Hz。

这两个音色同时具有较低 harmonic energy 和较强 noise/inharmonic 成分；其中
`PRIML WOOD` 的 inharmonicity 在 pilot 中最高。它们说明“源 render 能跟踪 MIDI”
并不等于“纯 harmonic excitation + spectral reconstruction 容易学会该音色”。

## Residual latent 的事实边界

本轮 encoder 是冻结的，因此 paired swap 证明的是 decoder 学会忽略 source pitch
并服从 target condition，而不是 latent 已经删除 pitch。小样本 ridge probe 仍然
跨音色不稳定，不作解耦声明。

下一阶段需拆成两个问题：

1. 对稳定 harmonic 音色，解冻 encoder 的高层并加入 gradient reversal / pitch
   adversarial probe，验证 residual latent 的 pitch 可预测性是否下降；
2. 对低 harmonic-energy、噪声或强 inharmonic 音色，评估显式 periodic/noise mix
   descriptor 或可微 pitch-consistency loss，不能只继续堆 pitch-swap steps。

在这两个问题解决前，当前 checkpoint 是“显式 pitch 因果路径的有效研究原型”，
不是全音色、可发布的乐器模型。
