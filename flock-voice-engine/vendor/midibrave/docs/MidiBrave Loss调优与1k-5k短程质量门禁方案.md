# MidiBrave Loss 调优与 1k/5k 短程质量门禁方案

> 状态：已执行完成；Pitch 修复通过，Velocity 原门禁因输入不可辨识而终止  
> 执行日期：2026-07-18  
> 范围：仅 Phase 1；未运行 Phase 2、q300 或完整 eligible

## 1. 固定约束

- 44.1 kHz、49,152-sample 窗口、32D `note + velocity` MIDI 条件保持不变；
- 不加入 gate、pitch-bend、ADSR、onset/offset 或 take；
- Generated periodicity 只在现有可靠 F0 mask 内约束；
- 候选使用相同 seed、manifest、cache、validation pair 顺序和 evaluator；
- 1k 通过者才能从原 checkpoint 精确续跑到 5k；
- 本轮不得启动 q300。

## 2. 已实现修复

### 2.1 Pitch

最终组合：

```yaml
pitch_kl: 0.0
pitch_activation: 1.0
pitch_hard_negative: 0.25
pitch_autocorrelation: 20.0
cross_pitch: 1.0
cross_stft: 0.5
```

修复目标是堵住“低绝对 activation、低 periodicity 波形仍可通过归一化 CREPE 分布”的漏洞。5k 实测 Self/Cross F0 中位约 7.2–7.3 cents、periodicity 约 0.89、MIDI following 100%，该部分完成。

### 2.2 Velocity

已完成三层修复/消融：

1. `v_A == v_B` 时显式 mask，修复 ranking 公式的常数 margin 矛盾；
2. 增加真实 dB 差值 SmoothL1，并把相对标签从独立随机 crop 改为完整 render 固定 RMS；
3. 增加默认关闭、零初始化的 5,185 参数条件增益头，验证是否只是 Decoder 缺少幅度短路径。

## 3. 固定短程配置

```text
phase1_steps           5000
warmup_steps            500
pitch_adversary_start   500
pitch_adversary_ramp    100
checkpoint_every       1000
log_every                21
self_full_fraction       0.1
self_probability         0.5
global pair batch         80
```

1k checkpoint 用同一份 5k config 通过 `--max-effective-updates 1000` 生成；后续从该 checkpoint 精确续跑，保持 scheduler、optimizer、RNG、manifest hash 和 config hash 不变。

## 4. 门禁

### 4.1 1k 渐进门禁

- Self/Cross F0 median ≤100 cents、P90 ≤200 cents、octave error ≤5%；
- periodicity median ≥0.35、low-periodicity ≤50%；
- MIDI swap following ≥85%；
- MR-STFT、LSD、RMS 不超过同 step B0 的固定相对阈值；
- target control F0/periodicity 校准通过；
- AMP skip <1%，全部 loss、梯度与参数增量有限。

### 4.2 5k 严格门禁

- Self/Cross F0 median ≤50 cents、P90 ≤100 cents、octave error ≤1%；
- periodicity median ≥0.5、MIDI swap following ≥95%；
- Velocity direction ≥80%、1 dB margin ≥60%、delta median ≤2 dB；
- MR-STFT、LSD、RMS、upper-band、crest、ripple、click 不超过固定 B0 阈值；
- 相对同候选 1k 不发生显著退化；
- 精确达到 5,000 个有限、实际生效的 generator updates。

## 5. 执行结果

| 候选 | 1k | 5k | 结论 |
|---|---:|---:|---|
| B0 | 失败 9 项 | 失败 19 项 | 复现旧 Pitch 坍塌 |
| C5–C8 | 各失败 1–2 项 | — | 确定 C9 权重 |
| C9 | 通过 | 失败 3 项 | Pitch 全部通过，仅 Velocity 失败 |
| C10/C11 | 通过 | 各失败 6 项 | 独立 crop 标签错误；加权无效且增加伪影 |
| C12 | 通过 | 失败 3 项 | 完整 render 标签；最佳无增益头候选 |
| C13 | 失败 1 项 | — | Cross LSD 超线 |
| C14 | 通过 | — | 增益头弱权重，Velocity margin 无改善 |
| C15 | 通过 | 失败 4 项 | 增益头未解决泛化，crest/ripple 退化 |

C12 5k：F0 7.269/7.302 cents，Velocity direction/margin/delta 为 43.75%/3.125%/1.755 dB；Cross crest 仅超线 0.67%。

C15 5k：F0 7.254/7.282 cents，Velocity direction/margin/delta 为 46.875%/9.375%/1.802 dB；Cross crest 与 ripple 同时超线。

## 6. 终止判据与证据

原方案规定：Velocity 长期停在 chance 时先审计标签可辨识性，禁止盲目继续加权。本轮已满足并执行该终止判据。

### 6.1 Crop oracle

- 独立 crop direction oracle：68.47%；
- 对齐 crop direction oracle：79.59%；
- 两者都低于 80% 门禁，因此相对标签改为完整 render 固定值。

### 6.2 完整 render 的跨 preset 上限

固定 64 对目标中，高 velocity 更响/更轻各占 50%，同一 preset 内方向随 note 翻转。

- 冻结 C15 表示、只训练同构 5,185 参数头：Train 96.8%–97.5%，Validation 60.9%–65.6%；
- 绕过 Timbre Adapter，raw 512D CLAP + 132,609 参数头：Train 95.3%–97.1%，Validation 59.4%–62.5%。

这证明当前单源音频输入无法泛化推断未见 preset 的任意非单调 Velocity 响应。继续提高 loss 权重、Velocity pair 比例或头容量不再是合理动作。

## 7. 最终决策

- Pitch 修复：接受，作为后续共同基线；
- 完整 render Velocity rank/delta：公式正确，但当前信息合同下不能作为 80% 跨 preset 硬门禁；
- 条件增益头：消融拒绝，默认关闭；
- C12/C15：都不晋升为正式完整训练配置；
- q300：未运行；
- 进一步 loss-only 迭代：停止。

下一轮必须先选择：

1. **精确 Serum 响应**：给模型加入 preset 级多 note/多 velocity 上下文或可决定调制响应的元数据，再保留真实非单调方向门禁；
2. **统一实时 MIDI Velocity**：规定单调响度/亮度控制曲线，重写与产品语义一致的监督和条件交换门禁。

详细数值、作业、参数和 SHA-256 见《MidiBrave Loss修复与1k-5k短程质量门禁测试报告.md》。
