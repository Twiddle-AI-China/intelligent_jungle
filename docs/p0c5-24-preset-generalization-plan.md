# P0-C5：24-preset generalization pilot

日期：2026-07-16。起点：P0-C4B short-balanced step-50 checkpoint `393289…`。

## 目标与边界

本阶段只回答：8-preset 上通过的 schema-v2 pitch/periodicity 结构，能否扩到
24 个经过验证的 Dexed timbre。它不是 1,778 段真实语料 scale-up，也不声称解决
atlas 全域或复音；encoder 继续严格冻结，单音 batch=1 与 BRAVE 延迟边界不变。

## D0：先建立可信 24-preset manifest

现有名为“24 preset”的产物只是 24 个候选的审计：16 个未通过四音高 renderer
truth，verified manifest 实际只有当前 8 个。禁止直接复用那 16 个失败候选。

数据流程预注册如下：

1. 从原 6,457 个候选按既有 10D acoustic feature farthest-point 顺序过选 72 个；
2. 对 72×6=432 条既有 render 跑同一 pYIN/gate audit；
3. 用原阈值验证四个 pitch conditions（voiced ≥0.80、median ≤50 cents、
   P95 ≤75 cents）；
4. 在通过者中保持原 farthest-point 顺序取前 24。通过者不足 24 则数据 gate
   失败，扩大候选池后重审，不放宽阈值；
5. 记录 24 个 preset 的 periodicity/noisiness 分布，并确认当前 8 个全部仍在集合。

### D0 结果（qgpu 158）

72 presets / 432 renders 全量审计完成，34 个 presets 通过原四音高阈值，足够按
原 farthest-point 顺序截取 24；当前 8 个全部保留，新增 16 个。产物 SHA-256：

- candidates72：`5245f72ef17c8d658bf6286c5dace1d07cd29789dc044ee9ce27d89a9a6ca61f`；
- audit72：`bdd7250765fd474bc97c26380164c560c2b48c5ae7bbad21d4d30823d35e881a`；
- verified24：`c5accb2768e9058c1b0e36ceca7c0b875b856543688c6dd16627a60a190ab2ab`。

D0 通过。训练前先跑 C4B checkpoint 的 zero-shot 基线，并固定声学分型：preset
满足 `harmonic_energy_mean < 100`、`noisiness_mean ≥ 0.10`、
`inharmonicity_mean ≥ 45` 任一条件即归 descriptor-tail，共 8 个：21385、49984、
36905、52404、27150、46586、21526、81145；其余 16 个归 harmonic-like。
descriptor-tail 走 onset/spectral-rank/periodicity/envelope；harmonic-like 走 pitch
intervention。旧 8 仍额外保留其 C4B 原闸门，分型不能取消回归约束。

### Zero-shot 基线（qgpu 159）

C4B step-50 原 checkpoint 不训练直接评估：harmonic-like 13/16 通过，
descriptor-tail 5/8 通过。这说明扩集后不是整体失效，而是局部边界样本：

- harmonic-like 失败：WHISTLE 1 (18618)、SPRNGCHIME (21381)、
  ToyOrkstra (54079)，都是少数 intervention 出现极端 f0 误判；
- descriptor-tail 失败：BELL (21526) 的高音 voiced-ratio，HRPSLUTE8c
  (27150) 的 spectral identity，Vibe.06 (52404) 的 onset/envelope。

两份报告均使用 checkpoint SHA
`3932896e1285e0c7a81a9787587a468efafd3a45a3c232c90380de59f6540a49`；
zero-shot 只是训练前基线，不改写下面的通过阈值。

## D1：训练与闸门（D0 通过后才执行）

- 起点固定为 C4B `393289…`，不从随机或失败的 mixed last 开始；
- descriptor-tail 8 个 preset 各使用 2× virtual sampling weight，与
  harmonic-like 16 个形成 16:16 的类别平衡。这一配方依据 C4B 已有的
  tail 恢复实验预注册，不根据 C5 训练输出调整；
- 2-step smoke → 500-step calibration → 最多 2k pilot；每级验证 encoder 全 state
  bitwise 冻结；
- harmonic-like preset 复用 intervention + output-invariance；inharmonic-like preset
  使用 onset / spectral rank / periodicity / envelope，不用伪造 cents；分型规则必须
  在训练前由 target render descriptor 固定；
- 500-step 只有在旧 8 preset 不退步、且新增 preset 至少 75% 通过各自分型闸门时
  才可延长；最终要求旧 8 全过、新增 16 至少 14/16 通过，失败逐 preset 报告；
- 无论结果如何，本阶段不自动解锁真实语料。还需单独完成每音色完整目标演奏音域
  的 f0 coverage audit。

### D1 结果（qgpu 160–162）

2-step smoke 确认 encoder 27/27 state tensors bitwise 不变；decoder stages
80/80、FiLM 8/8、condition downsamplers 3/3 与 synth 4/4 均更新。500-step
`best.ckpt` 确为 global step 500，SHA-256
`e655a53daff1bd4e205e2381e62cd4e3c947906c0f2a70c501de15cdb5e92e39`，
encoder 仍严格冻结。

评测结果：

- harmonic-like 16/16 通过，median cents 近 0、P95 18.5 cents、gross error 0；
- descriptor-tail 从 zero-shot 5/8 退化到 3/8；
- 新增 16 中合计 13/16 通过分型闸门，虽达到 75% 延长条件，但旧
  PERC BELL 从 3/4 降到 2/4，periodicity 与 spectral-ID 失败；
- 旧 harmonic intervention 6/6，output invariance 仍全过（grid 24/24、
  gated paths 10/10）。

因此 D1 **拒绝延长到 2k**：新增集的总通过率不能覆盖旧 8 回归。
本轮同时发现 trainer 之前没有显式固定 Python/NumPy/Torch/CUDA RNG；
训练数据索引虽是确定的，上述 checkpoint 仍只作为闸门证据，不宣称可逐
bit 重现。

## D2：单次、50-step 确定性短恢复

D1 显示 500 steps 主要是过度修正 harmonic-like，而 C4B 的最终候选本就
来自 step 50。因此在看到 D2 输出前预注册且只运行一次：

- 从原 C4B `393289…` 重新开始，不从 D1 step 500 续训；
- 保持 verified24、tail 2×、pitch-swap、frozen encoder 全部不变；
- 固定 `training_seed=20260716`，显式 seed Python、NumPy、Torch、CUDA，
  关闭 cuDNN benchmark 并启用 deterministic cuDNN；
- 固定 50 steps，不跑 25/50/100 sweep，不用多次随机候选挑最好；
- 通过要求仍是旧 8 全过且新增 16 至少 14/16。失败则停止 C5 参数
  恢复，转向分离 harmonic/tail objective 或架构路径，不再试随机 seed。

### D2 结果（qgpu 163–166）

job 163 在读取尚未解析的 Abseil flag 时启动失败，0 training steps；
修正为 flag 解析后 seed，job 164 的 2-step GPU smoke 通过。唯一有效的
50-step job 165 产出 SHA-256
`8bd99c635ee76591f65ace375202c58b8a1deba5b6a429b124605bdbbdb23dcb`；
encoder 27/27 bitwise 冻结，所有 decoder/conditioning 路径更新。

job 166 结果：harmonic-like 15/16，tail 3/8；新增 16 仍为 13/16，
而旧 PERC BELL 与 PRIML WOOD 都失败。旧 harmonic intervention 6/6 与
invariance 仍全过。D2 失败，**P0-C5 关闭且无 24-preset 候选模型**。

## D3：target-latent oracle（只诊断，不训练）

下一步在看到输出前固定为同时评估 C4B 原 checkpoint 和 D2 step-50：
对每个 tail 目标音高，改用该目标 render 自身的 encoder latent，其余条件、
seed 和闸门不变。这不是可演奏推理方案，仅用来定位：

- oracle 通过、reference-56 失败：主因是跨音高 latent 迁移/音高泄漏；
- oracle 也失败：主因是 decoder/loss 对瞬态或非谐波谱的重建上限；
- 两者分 preset 分化：P0-C6 必须分类处理，不再使用一个全局恢复配方。
