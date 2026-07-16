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
