# P0-C4 计划：先清理 residual pitch，再处理非谐波音色

## 阶段目标

P0-C3 已证明 decoder 可以服从显式 pitch condition，但 encoder 被冻结，不能据此
声称 residual latent 不再携带音高。P0-C4 不直接扩大 corpus，而是把两个不同问题
拆开验证：

```text
P0-C4A：6 个已通过 harmonic presets
paired pitch-swap + encoder tail 解冻 + pitch adversary
                    │
                    └→ residual latent 是否不再可预测 source pitch？

P0-C4B：2 个失败的 noise / inharmonic presets
periodic-noise descriptor 或 pitch-consistency objective
                    │
                    └→ 显式条件是否能表达无稳定基频的音色？

P0-C4C：重新合流 8 presets，复测控制、音色、导出与延迟
```

两条支线不能共用一个模糊的“总 loss 下降”作为成功标准。

## P0-C4A：residual pitch removal

### 数据

只使用 P0-C3 intervention 已完全通过的六个 preset：

`1580, 12816, 49633, 49984, 52404, 63836`

保持 velocity 75、四个 MIDI note、同 preset 异 note 配对和相同时间裁切。失败的
`PERC BELL`、`PRIML WOOD` 暂不进入本实验。

### 模型与训练

- 从 P0-C3 最终 best checkpoint 初始化；
- 保持 paired pitch-swap reconstruction；
- decoder 继续接收 target `f0/loudness/gate`；
- encoder 只解冻末端两个带参数模块，减少音色空间整体漂移；
- adversary 从 source latent 预测四档 source MIDI pitch；
- adversary 自身最小化交叉熵，gradient reversal 让 encoder 最大化同一预测误差；
- phase 1 only，不混入 RAVE waveform GAN。

### 三重闸门

1. **显式控制不退化**：六个 preset 仍全部通过 intervention；median pitch error
   ≤ 25 cents，median slope 在 `[0.95, 1.05]`。
2. **source pitch 变得不可读**：独立的 leave-one-preset-out 四分类 probe balanced
   accuracy ≤ 0.35（随机基线 0.25），并显著低于 P0-C3 checkpoint。
3. **音色不塌缩**：harmonic-envelope cosine 相对 P0-C3 下降不超过 0.02；同时检查
   preset identity probe，避免通过抹掉全部 latent 信息来消除 pitch。

训练顺序为 2-step qgpu smoke → 500-step calibration → 最多 3k-step pilot。若控制
闸门先退化，降低 adversary 权重或减少 encoder 解冻范围；若 probe 不降，不直接
增加步数，先确认 adversary 已达到高于随机的 detached-latent 分类能力。

## P0-C4B：noise / inharmonic tail

只在 P0-C4A 结论明确后开始。先比较两个最小候选：

1. 为 excitation 增加显式 `periodicity/noise_mix`，让无稳定 f0 的帧不被迫使用纯
   harmonic oscillator；
2. 保持当前 excitation，但增加只在高 periodicity 帧启用的可微 pitch-consistency
   loss。

优先选择能让 `PERC BELL`、`PRIML WOOD` intervention voiced/pitch 行为符合其声学
属性、且不损伤六个 harmonic presets 的方案。这里不要求所有声音都被 pYIN 判为
稳定有声；对无基频音色应改用 onset、谱包络和 periodicity 一致性，而不是伪造
一个 cents 成绩。

## P0-C4C 与进入大语料的条件

合流后重新跑 8-preset intervention、residual pitch probe、音色保持和 conditioned
TorchScript 导出。只有同时满足以下条件才进入更大 corpus：

- harmonic 子集显式 pitch 控制通过；
- residual pitch probe 接近随机且 preset identity 未塌缩；
- noise/inharmonic 子集使用适合其声学属性的指标通过；
- streaming export 和本机加载不改变既有延迟事实边界。

descriptor disentanglement（brightness/energy/articulation）仍在这些音高闸门之后。

## 首轮执行记录（2026-07-16）

实现已接入 harmonic preset 筛选、encoder tail 解冻、逐帧 pitch adversary、训练内
classifier 诊断，以及两个与训练 classifier 独立的 probe：

- source pitch：within-preset centering 后 leave-one-preset-out 四分类；
- preset identity：leave-one-pitch-out 六分类。

P0-C3 best 的新版基线（qgpu job 102）为：pitch balanced accuracy 0.6875，preset
identity 0.6979；同时 intervention 保持 6/6、median 10 cents、slope 0.993。
这确认 residual latent 中确实存在跨音色可读的 source pitch。

| qgpu job | 实验 | pitch accuracy | preset identity | intervention |
|---:|---|---:|---:|---|
| 101 | 双优化器 2-step smoke | — | — | checkpoint/validation 全通 |
| 103–104 | 整段均值 adversary，weight 0.05 | 0.6771 | 0.8073 | 6/6 |
| 105–106 | 逐帧 adversary，约 376 saved steps | 0.6406 | 0.8125 | 6/6 |
| 107–108 | 逐帧 adversary，weight 0.05，2k budget | **0.6354** | 0.7969 | 6/6 |
| 109–110 | 从上项继续，weight 0.20 短校准 | 0.7344 | 0.7552 | 6/6 |

当前最好结果仍远高于 0.35 闸门。增大 adversary 权重造成 probe 反弹，说明当前
联合一步 classifier / 一步 encoder 的博弈会振荡；不能继续把训练步数或权重加大
后称为“推进”。下一次最小实验应加入 classifier-only warm-up，并允许每次 encoder
更新前进行多次 detached-latent classifier 更新，然后重新做 500-step calibration。
P0-C4A 尚未通过，P0-C4B 暂不启动。

当前最好研究 checkpoint 是 job 107 的 global step 1504 best（不是 step 1880
last），SHA-256：

`3aee2014813d925bd27d5df37a8487be38e711fd17c99c9a14b46c650f5105d3`
