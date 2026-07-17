# MIDI + Timbre 训练/推理架构评审

当前显式方案的完整张量路径、训练图与推理图见
[`explicit-pitch-conditioning-architecture.md`](explicit-pitch-conditioning-architecture.md)。

## 结论

**可以继续执行 [`p0b-training-and-export-plan.md`](p0b-training-and-export-plan.md)，不需要停掉已经进行了一段时间的 P0-B 工作。**

原因是 Claude 的 P0-B 计划并没有实现讨论图中的「黑盒 `z_midi` + `z_timbre` 直接拼接」，而是延续当前已确立的 P-RAVE 路线：

```text
MIDI / 训练音频
  → [f0_hz, target_rms_loudness, gate]
  → harmonic/noise excitation
  → 16-band PQMF
  → BRAVE decoder 多层 FiLM

z_timbre
  → 同一 BRAVE decoder
  → waveform
```

这与本次架构评审的推荐方向一致，而且 P0-B 只承诺验证「梯度、checkpoint、export 和 streaming 接口能否跑通」，并不承诺音高已经解耦或可控。这个范围设定是正确的。

## 对两张图的理解

### 训练图

训练图描述的是一个 conditional VAE/RAVE：

```text
对齐 MIDI → MIDI Encoder → z_midi ────┐
                                         ├→ 融合层 → Decoder → x_hat
真实音频 → Timbre Encoder → z_timbre ──┘
```

图中还用了：

- 多尺度频谱重建损失；
- 输出音高与 MIDI 目标的 pitch/voicing 损失；
- `z_timbre` 的 KL 约束；
- 对 `z_timbre` 的音高对抗分类器；
- RAVE 第二阶段的 GAN + feature matching。

如果融合层和 decoder 从训练开始就共同学习，拼接本身不再是绝对错误。但它仍然比显式条件路线更难验证：`z_midi` 可能变成一个不透明的另一套 latent，decoder 也可能只在入口使用它，深层逐渐忽略音高。

### 推理图

推理图将训练时的 `z_timbre = TimbreEncoder(x)` 替换为：

```text
Boids b(t) → G → z_boids
```

再与 MIDI 分支融合。这里最大的风险不是维度，而是分布：

```text
训练：decoder 看到 encoder 产生的真实 z_timbre
推理：decoder 看到 G 产生的 z_boids
```

如果 `G` 只是一个未受约束的映射，即使输出尺寸相同，也可能将 decoder 推到训练分布之外。

当前项目已有的 real-corpus latent atlas 更适合解决这个问题：

```text
Boids
  → 8D 可测群体关系
  → 真实 encoder latent 节点的局部选择/插值
  → latentStep 连续限速
  → z_timbre(t)
```

因此推理时不应声称「用 `z_boids` 替换 `z_timbre`」，而应表述为「Boids 在训练形成的 timbre manifold 上产生随时间变化的 `z_timbre(t)`」。

## 讨论图与 P0-B 计划对比

| 问题 | 讨论图 | Claude P0-B 计划 | 评审 |
|---|---|---|---|
| MIDI 表示 | 学习得到的 `z_midi` | 显式 `[f0_hz, loudness, gate]` | **P0-B 更可解释，保留** |
| pitch bend | 取决于 MIDI Encoder | 直接进入连续 `f0_hz` | **P0-B 更稳妥** |
| MIDI 注入 | 拼接后过 MLP/TCN | excitation + 四个 FiLM site | **P0-B 更接近 P-RAVE** |
| timbre latent | 音频 encoder 的 `z_timbre` | 保留 BRAVE latent | 一致 |
| Boids | `G` 任意输出 `z_boids` | P0-B 不改 realtime/Boids 链 | **P0-B 暂不引入分布风险** |
| pitch 解耦 | adversarial pitch classifier | P0-B 暂不声称解耦 | **适合分阶段处理** |
| 重建/GAN | 明确列出 | 复用 RAVE 原训练损失 | 一致 |
| 导出 | 未展开 | conditioned TorchScript + schema | **P0-B 覆盖更完整** |
| 当前目标 | 似乎直接完成解耦 | 只证明训练/导出链路通 | **P0-B 事实边界更严谨** |

## 是否继续原计划

### 可继续，且不应中断的部分

- `ConditionedGeneratorAdapter` 的训练接入；
- 显式条件提取与 schema 验证；
- conditioned checkpoint 存取；
- offline/streaming TorchScript 导出；
- 本地 tiny-model 前后向和 export 测试；
- qgpu `SMOKE_TEST=1` 的 2-step 训练；
- 拉回 `.ts` 后的最小加载/解码验证。

这些都属于 P0-B 管线证明，不依赖「已完成音高解耦」这个尚未证明的前提。

### 现在必须修正，但不阻断 smoke 的事项

1. **不应将 `torchaudio.functional.detect_pitch_frequency` 称为 YIN。**  
   当前锁定的 torchaudio 实现是 normalized cross-correlation function
   (NCCF) + median smoothing。它支持 CPU/CUDA/TorchScript，因此仍然适合
   P0-B smoke，但文档和报告必须写成 NCCF pitch estimate。

2. **需对条件提取结果做最低限度的诊断。**  
   Smoke 报告至少记录 voiced ratio、f0 范围、静音段误检比例、
   conditioning 帧数与 latent 帧数是否一致。不需因此停止 2-step
   smoke，但不应只看「没有报错」。

3. **Adapter 的 excitation 状态必须每 batch 覆盖或清理。**  
   `set_excitation()` 是为兼容官方单参 `decoder(z)` 的工程过渡，
   不得因 validation、receptive-field probe 或异常路径复用上一个
   batch 的 excitation。

4. **TorchScript phase state 必须明确 batch 语义。**  
   P0-B 可以只验证 batch=1 的单音 streaming；不得把它扩大解读为
   已支持三音原生 conditioned polyphony。

### P0-C 长训练前必须通过的闸门

P0-B smoke 通过后，**不应直接启动长训练**，需先完成：

1. **Pitch 标注策略**  
   用带有真值 MIDI/f0 的合成小集合测量 NCCF 的 cents error、
   octave error 和 voiced/unvoiced error；根据结果决定预计算标注、
   pYIN/CREPE/PESTO 或继续 NCCF。

2. **Pitch intervention，而不只是 reconstruction**  
   固定 `z_timbre` 交换 pitch condition，测试输出音高是否改变而音色
   是否保持。如果只用同一音频提取的 latent 和 pitch 做重建，
   decoder 可能完全忽略条件，继续从 latent 读音高。

3. **Residual latent pitch probe**  
   训练线性/轻量 probe 从 `z_timbre` 预测 f0，并与 BRAVE baseline 比较。
   必要时再加 gradient reversal / pitch adversarial classifier。

4. **Timbre manifold 推理契约**  
   Boids 只能通过真实 encoder atlas/局部插值/有界增量产生
   `z_timbre(t)`，不允许无约束 `G(b(t))` 直接替换训练 latent。

5. **音色-音高组合覆盖**  
   语料需要在同一音色下覆盖多个音高，并且同一音高覆盖多种音色；
   否则模型可以靠语料偏差将 pitch 重新写入 timbre latent。

6. **单音/复音范围显式化**  
   P0-B/P0-C 首先按 batch=1 单音条件验证。当前 Web 三音链仍是一次 neural
   decode + 三个后处理 pitch branch。原生复音需之后在「多次 conditioned
   decode」与「multi-f0 excitation」之间单独决策。

## 对讨论图的建议改名

为了使图与实际研究线一致，建议将：

```text
z_midi             → c_perf(t) = [f0_hz, loudness, gate]
拼接/融合层         → excitation + decoder multi-scale FiLM
z_boids            → z_timbre(t) on encoder manifold
MIDI Encoder       → deterministic performance encoder
```

训练图中的 pitch classifier、pitch swap 和更强音高损失可以作为
P0-C 项目，不必塞进 P0-B 的管线 smoke checkpoint。

## 最终决策

```text
P0-B：继续当前计划
  ✓ 训练接入
  ✓ conditioned checkpoint
  ✓ conditioned TorchScript
  ✓ local + qgpu smoke
  ✗ 不声称 pitch disentanglement
  ✗ 不开始正式长训练

P0-C：加入评测与解耦闸门后再决定长训练
```

只有当当前实现被改成不透明 `z_midi` 拼接、无约束 `z_boids`、
或在无 pitch intervention/probe 的情况下直接启动长训练，才需要中断并重新评审。
