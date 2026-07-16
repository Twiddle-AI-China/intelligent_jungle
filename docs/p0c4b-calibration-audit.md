# P0-C4B 首轮校准审计与重跑计划

日期：2026-07-16。审计对象：schema-v2 commits `0fbc9d0..040295d`、qgpu
job 134–136、step-500 checkpoint
`36946254cde90f755d44b4566ea4aff7078b9e74a88f817cc4db218b7943c614`。

## 决策

**首轮 C4B 校准拒绝，不能升到 ≤5k。**代码中的主训练传播路径成立，候选也没有
损伤 6 个谐波 preset；但非谐波谱控制没有出现改善，且“冻结 encoder”与“P0-C3
best 参照”两项实验事实不符合预注册描述。先修复过程，再做一次可复现重跑。

## 训练与传播审计

实际训练链为：

```text
target [f0, loudness, gate, periodicity]
  → harmonic/noise excitation（无可训练参数，no_grad 合理）
  → PQMF
  → condition downsampling pyramid
  → 4 个 decoder FiLM sites
  → waveform
  → target multi/full-band spectral losses
  → decoder / FiLM 更新

source audio → encoder posterior mean → decoder 主干
```

核验结果：

- target 条件和 target audio 帧数一致，source/target 同 preset、异 note、共享
  128-sample 对齐 crop；损失明确对 target 而不是 source 计算；
- excitation 的 `no_grad` 不会截断 decoder 梯度，它只把无参数的声源视作输入；
  FiLM projection 首步获得非零有限梯度；
- FiLM 以严格旁路初始化，因此首步 condition downsampler 梯度按数学应为零；
  FiLM 第一次更新后梯度才进入 pyramid。两步 Trainer 回归测试确认 3 个
  downsampler 均开始变化；远端 step-500 的 4 个 FiLM 和 3 个 downsampler
  tensor 也全部相对起点变化；
- step-500 checkpoint 的 `global_step=500, epoch=8`，不是较早的 epoch 快照；
- encoder 可训练参数相对 P0-C3 best 完全相等，但 8 个 BatchNorm running mean /
  variance buffer 发生漂移，最大绝对差 206.25。这违反了“冻结 encoder”的实验
  合同，已改为参数冻结后强制 `encoder.eval()`，并在每次根模型 `train()` 后重置；
- pYIN 使用 128 hop，裁切索引正确。它的 centered analysis grid 与 block-RMS
  中心相差半帧（64 samples，约 1.45 ms），远小于 5 帧 onset 容差；当前不为此
  改写已经生成的标签，但保留为后续 descriptor 精标风险；
- periodicity 是 pYIN pitch confidence 的工程代理，不应解释成物理周期度真值。

## 首轮数字

候选的谐波侧：intervention 6/6，median 5 cents，P95 10 cents；output
invariance spread median 0、P95 10 cents，控制行 24/24、gated paths 10/10。

非谐波侧：

| preset | onset | 谱识别 | periodicity median / max | envelope median | 判定 |
|---|---:|---:|---:|---:|---|
| PERC BELL 21385 | 3 帧 | 1/4 | 0.223 / 0.320 | 0.985 | 失败 |
| PRIML WOOD 36905 | 2 帧 | 1/4 | 0.006 / 0.137 | 0.986 | 失败 |

两个 preset 的四次输出都把 MIDI 63 render 判为最近邻；PRIML WOOD 四组 mel
distance 几乎不随命令变化，说明当前候选基本没有学会非谐波 note control。

旧 `p0c3ref` 报告实际指向 epoch-79 last，不是 best `cd3bb6…`，因此旧参照只可
作为排错材料，不用于趋势结论。评测现已要求显式 checkpoint，记录 SHA-256，并
为每个 intervention 派生固定 RNG seed，防止 noise excitation 让闸门漂移。

## 下一步及停止条件

1. 本地全套测试后同步修复；
2. qgpu 2-step smoke：检查冻结 encoder 的所有参数和 buffer 与 best 逐样本相等，
   同时确认 FiLM 已更新；
3. 从 P0-C3 best 精确重跑 500 steps，并重复同一状态差分；
4. 使用固定 seed、显式 checkpoint 和 SHA 分别评测候选与 P0-C3 best；
5. 只有谐波硬闸门全过，且两个非谐波 preset 各自谱识别 ≥2/4、目标 median
   rank ≤2，才允许进入 ≤5k；
6. 若仍是 1/4，则不再给相同配方堆步数。改跑两个非谐波 preset 的小型
   capacity diagnostic；若充分采样仍不能改变输出谱 rank，C4B 的下一步应是
   更直接的 descriptor 注入/损失，而不是继续调训练时长。

## 纠正后校准结果（qgpu 138–140）

- 2-step smoke 与 500-step checkpoint 的 encoder state 均为 27/27 tensors
  与 P0-C3 best bitwise 相等；step-500 的 decoder stage 80/80、condition
  downsampler 3/3 发生更新，训练/冻结证据链通过；
- 精确 step-500 SHA-256：
  `68328200408f6ae3815453a5d5980bf10b575929687dc3d36696f98fffbadc43`；
- 谐波 intervention 6/6（median 10、P95 20 cents），invariance 通过
  （spread median 0、P95 10 cents，24/24 rows，10/10 paths）；
- 固定 seed 的非谐波结果仍为 0/2：两个 preset 都只有 1/4 谱识别正确，
  ranks `[4,3,2,1]`、median rank 2.5，与精确 P0-C3 best 相同；PRIML WOOD
  另有一次 periodicity delta 0.926，超过 0.40 硬阈值。

**结论：不放行 ≤5k。**进入 capacity diagnostic：只采样 21385/36905，从同一
P0-C3 best 起跑 500 steps（约为首轮非谐波暴露量的 4 倍）。这是结构可学性测试，
不是发布候选。预注册续跑规则：两个 preset 任一个谱识别达到 ≥2/4 才允许延长到
最多 2k；若两者仍均为 1/4，立即停止。容量“存在”的最终标准仍为两者各 ≥3/4；
若达不到，下一轮改结构或加入显式谱/descriptor 目标，不继续堆相同 loss 的步数。

### Capacity diagnostic 结果与 mixed recovery 预注册

qgpu 141 完成训练；由于 max-step 落在 epoch 中间，最后一个可审计的 epoch
checkpoint 是 step 450（不是 500），SHA-256
`cffa07cf659a55812ab765244d0f20ed824c615a9d4bd40cfb3909c18885ff11`。
qgpu 143 固定 seed 评测得到两个 preset 均 4/4、median rank 1，onset、
periodicity、envelope 闸门也全部通过。**现有结构容量存在，首轮失败归因于混训
采样不足。**

下一步 mixed recovery 从 P0-C3 best 重新开始，不继承 dedicated checkpoint：
保留全部 8 preset，两个非谐波 preset 权重各 3，六个谐波权重各 1，使两类总
采样质量为 1:1。先跑 2-step smoke → 500-step calibration。500-step 放行到最多
2k 的条件预先固定为：谐波两套硬闸门仍全过，两个非谐波 preset 各自谱识别
≥2/4 且 median rank ≤2；否则停止。最多 2k 的最终标准仍是原始完整闸门（两者
各 ≥3/4，其他三项全过）与谐波不退步。

mixed recovery 的 500-step 结果（qgpu 145–146）保持谐波 6/6 与 invariance
全过；PERC BELL 改善到 2/4、median rank 1.5，但 PRIML WOOD 仍为 1/4、
median rank 2.5，未满足“两者都出现方向”的续跑条件，故不延长该 run。

随后补测 dedicated step-450 的谐波侧（qgpu 147）：intervention 仅 5/6，
Perky 04 slope 0.709；invariance 控制行 20/24，因此 dedicated checkpoint 也不是
候选。两组结果共同证明是双向遗忘/采样冲突，而非任一类不可学。

下一实验预注册为 curriculum recovery：从 dedicated step-450 `cffa07…` 出发，
encoder 继续严格冻结，用全部 8 preset **均匀** rehearsal 500 steps。500-step
必须恢复谐波 intervention 6/6 + invariance 全过，同时两个非谐波至少各 2/4，
才允许最多延长到 2k；最终候选仍需谐波全过且非谐波两者各 ≥3/4、其余闸门全过。

curriculum last step-500 恢复谐波但再次遗忘非谐波（Bell 2/4、Wood 1/4）。按
best/last 纪律补测的 `best.ckpt`（step 434，SHA `35680f…`）则显著更好：谐波
intervention 6/6、invariance 24/24；Wood 3/4 且全项通过；Bell 2/4、median
rank 1.5，periodicity max 0.402（只比 0.40 高 0.002）。它满足续跑条件但尚非
最终候选。

下一步预注册为 short balanced recovery：从 curriculum best 出发，两个非谐波
权重各 3、六个谐波各 1（类别总量 1:1），只跑 100 steps 后立即全评测。只有
谐波两闸门全过，且 Bell/Wood 均达到原始完整非谐波闸门，才宣告 C4B pilot
通过；否则不以 last 覆盖 best，并依据失败方向决定是否再做一个至多 100-step
窗口，不直接长跑。

## C4B 最终结果（qgpu 153–157）

short balanced recovery 实际跑满 100 steps，但最后持久化并被选中的 `best.ckpt`
位于 step 50（epoch 0），不把未保存的 step 100 冒充候选。checkpoint SHA-256：

`3932896e1285e0c7a81a9787587a468efafd3a45a3c232c90380de59f6540a49`

encoder 27/27 state tensors 仍与 P0-C3 best bitwise 相等。固定 seed 的完整闸门：

- harmonic intervention：6/6，median 近 0、P95 10 cents；
- output invariance：spread median 0、P95 10 cents，控制行 24/24，路径 10/10；
- PERC BELL：谱识别 3/4，ranks `[2,1,1,1]`，periodicity median/max
  0.055/0.313，envelope 0.993，onset max 2 帧；
- PRIML WOOD：谱识别 3/4，ranks `[3,1,1,1]`，periodicity median/max 0/0，
  envelope 0.994，onset max 3 帧。

**C4B pilot 全闸门通过。**这只证明 8-preset 小样本上的结构与训练策略成立，不是
24-preset 泛化或完整演奏音域证据。

候选经 qgpu 重新导出并在 Apple Silicon 本机加载验证：schema-v2 可读，offline /
streaming `decode_conditioned` 均输出有限的 `[1,1,2048]`，初始 phase 为 0 且连续
两 block 正确前进。最终 artifact SHA-256：

- offline：`30ef08ab239cd794f846b8b40bf8cbefe34fea5d6fc8dfacbd4c7426aa83f1b7`；
- streaming：`9988d7e20684d71643a615d2f2cf1ca8d9683961653c0b0a44c448275cb35847`。

导出复核还修复了一个真实问题：导出 probe 曾把非零 oscillator phase 写入 artifact；
现在 probe 后显式归零，并有 production-export 回归测试锁定。
