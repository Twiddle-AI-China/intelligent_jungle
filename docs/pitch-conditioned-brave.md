# Pitch-conditioned BRAVE 研究契约

## 当前基线

本分支基于 `experiment/xy-latent-engine` 的单群 neural timbre engine，不基于 `main` 的 PULSE / Dorian / note-group 音序链。当前音高由 decoder 后的 dual-read-head pitch shifter 实现，它是 A/B baseline，不是模型原生能力。

## 条件协议 v1

Decoder 条件张量固定为 `[batch, 3, latent_frames]`：

| 通道 | 单位 | 语义 |
|---|---|---|
| `f0_hz` | Hz | 可连续的基频，支持 pitch bend；`0` 保留为 unvoiced/noise |
| `loudness` | target RMS | 声学幅度目标；MIDI velocity 只是其一种演奏意图来源 |
| `gate` | 0–1 | 音符是否打开；不用 `f0=0` 代替 |

Schema ID 为 `pitch-conditioning-v1:f0_hz,loudness,gate`。浏览器、训练管线、TorchScript 和评测报告必须使用同一 ID，不允许按位置猜测条件含义。

## 与 P-RAVE 的对齐

P-RAVE 不是把离散 MIDI note 直接拼到 latent。本项目复现的核心是：

1. 由连续 `f0` 生成 harmonic excitation，unvoiced 区域使用 noise excitation；
2. 按目标 RMS 将 loudness 注入 excitation；
3. 将 excitation 经 BRAVE 的 16-band PQMF 变换；
4. 按 generator 各层速率下采样，生成 `gamma/beta` 对 upsampling layers 做 FiLM；
5. 保持 BRAVE 的 causal buffering 与导出边界可测。

论文中的 phonetic encoder 是歌声转换增强，不属于本乐器 MVP。

## 实验顺序

### P0-A：可执行条件契约

- MIDI note/bend 生成连续 `f0_hz`；
- velocity 映射成有界 target RMS；
- gate 独立于 voiced/unvoiced；
- reference excitation 逐帧匹配目标 RMS，跨 block 保持 phase。

### P0-B：BRAVE FiLM generator

- 使用锁定的 BRAVE commit `4a5f290f` 和 `acids-rave 2.3.x`；
- FiLM 初始化为 pass-through，先证明未训练扩展不改变 baseline 尺寸和因果延迟；
- smoke run 只验证梯度、checkpoint 和 export，不声称音高可控。

当前实现进度：已建立 BRAVE `[2,2,2,1]` generator 的四个 FiLM site，
excitation 层速率为 `[2×,4×,8×,8×]`。Streaming cached-conv 模式下的
stage cumulative delay 为 `[1,3,7,7]`，条件支路按这些数值对齐。FiLM
为初始 pass-through 时，在拷贝同一 BRAVE 权重后与 baseline 逐样本相等。

为满足 TorchScript 导出，generator 的存储结构改为逐 stage 子模块
（TorchScript 不支持 `zip(ModuleList)`、变量下标访问 ModuleList 和
`super()` 调用）；数学与延迟事实不变，pass-through 逐样本等价测试
在重构后依旧成立。

训练接入与 smoke 结论（2026-07）：

- `pitch_rave.PitchConditionedRAVE` 经 decoder adapter 接入官方
  acids-rave 2.3.1 Lightning 训练器，损失逻辑零改动；条件由训练音频
  自监督提取（torchaudio `detect_pitch_frequency` 即 NCCF + median
  smoothing——不是 YIN——加逐帧 RMS 与 gate；smoke 质量，P0-C 前按
  cents/octave/voicing error 重估标注策略）。adapter 的 excitation
  为逐 batch 瞬态：step 前覆盖、step 后强制清理，validation 与
  receptive-field probe 不可能复用上一 batch。
- qgpu job 80 在 1778 段真实语料上完成 SMOKE_TEST=1（2 步训练 + 逐步
  validation），产出 `best.ckpt`；conditioned 版全尺寸 BRAVE 的
  receptive field 实测 517.26ms ← x → 0.00ms，causal 保持。
- 条件提取诊断（qgpu job 82，16 段随机训练样本）：conditioning 帧数
  与 latent 帧数一致（1024=1024），voiced/gate ratio 0.767，voiced f0
  范围 [50.0, 918.8] Hz（下限即估计器 clamp 值，说明部分帧贴底，P0-C
  标注策略评估需覆盖），静音段 f0 按协议恒为 0。
- qgpu job 81 用 `export_pitch_conditioned.py` 导出 offline 与
  streaming 两个 `.ts`（`decode_conditioned` 输入
  `[batch, latent+3, frames]`，schema ID 内嵌，振荡器相位存 buffer 跨
  block 连续），SHA-256 记录于 `reports/pitch-checkpoint-export.txt`。
- 两个 `.ts` 已拉回 Apple Silicon 目标机加载冒烟：schema 可读、
  `decode_conditioned` 输出有限、相位逐 block 前进。phase state 目前
  只验证了 batch=1 的单音 streaming，不解读为已支持原生 conditioned
  polyphony。

以上证明梯度、checkpoint 与导出管线可用；**未证明 pitch control**：
2 步 smoke 模型的输出与音高无关，P0-C 的训练与 A/B 评测才能给出
音高可控性结论。

### P0-C：训练与 A/B

- **P0-C1 label benchmark 已完成**：当前 on-the-fly NCCF 在合成真值集上
  median error 1199.37 cents、gross pitch error 64.07%、unvoiced false
  positive 66.49%，正式淘汰出长训练标注候选。离线 pYIN 达到 median
  5.00 cents、P95 15.00 cents、零 gross/octave error，但 voicing false
  positive 5.47% 和当前短窗 RMS gate error 3.01% 尚未通过阈值。完整方法、
  分析与下一闸门见
  [`p0c1-pitch-label-benchmark.md`](p0c1-pitch-label-benchmark.md)。
- P0-C1b 先完成真实语料 pYIN voicing/gate 审计和预计算 label artifact，
  不直接启动长训练；
- **P0-C1b 数据盘点与首轮真实审计已完成**：5080 已存在 9,761 个 Dexed
  preset 的 58,566 条多音高/多 velocity 受控渲染，无需重新造 corpus；Spark
  用 NSynth 12 + TinySOL 12 做协议音域抽查。TinySOL 的 pYIN pitch 结果稳定，
  NSynth 混合音色仍有严重 octave/gross errors，固定 RMS gate 又受原始电平
  影响，因此 pYIN/RMS 不作为 Dexed pilot 标签；pilot 直接使用 renderer 的
  MIDI/gate 真值。详见
  [`p0c1b-real-corpus-pilot.md`](p0c1b-real-corpus-pilot.md)。
- 5080 qgpu job 84 对 24 个候选 preset 的 144 条受控 render 做完四音高审计，
  8 个 preset / 48 clips 通过（32 个 pitch clips 最差 median 35 cents、最差
  P95 75 cents、最低 voiced ratio 0.809），作为 P0-C2 overfit intervention
  pilot；其余 16 个不跟踪键盘或 pitch 不稳定，已剔除。
- P0-C2 已将 48 条 renderer-truth conditioning 接入官方训练器，并从 phase-1
  BRAVE baseline 迁移 165 个 tensor。qgpu job 89 完成 2,000-step overfit；job 91
  的固定-latent pitch intervention 得到 median error 805 cents、pitch-response
  slope 约 0，证明普通同条件 reconstruction 仍让 decoder 从 latent 读取音高。
  详见 [`p0c2-overfit-intervention-result.md`](p0c2-overfit-intervention-result.md)。
- 同一 corpus、seed、batch 和 step budget 对比 BRAVE baseline；
- native-conditioned 与 post-shifter 使用同一 MIDI 序列；
- 测 pitch error/cents、octave errors、攻击保留、音质、render p95/jitter 和 audio block deadline misses。

### P1：descriptor disentanglement

只在 pitch-conditioned BRAVE 通过后加入 brightness/energy。Articulation 暂不用单一 gate 伪装，需单独定义 attack/release/legato 表示和评测。

## 硬闸门

- 只给 decoder 增加 pitch input 不等于 disentanglement 成功。
- 下一步使用同 preset、不同 note 的 paired pitch-swap：encoder 看 source note，
  decoder 用 target condition 重建 target note；在 intervention 通过前不扩大语料。
- 任何条件模型若没有导出成功并在 M4 实测，不得更改当前延迟事实边界。
