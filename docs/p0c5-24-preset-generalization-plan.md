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

## D1：训练与闸门（D0 通过后才执行）

- 起点固定为 C4B `393289…`，不从随机或失败的 mixed last 开始；
- 2-step smoke → 500-step calibration → 最多 2k pilot；每级验证 encoder 全 state
  bitwise 冻结；
- harmonic-like preset 复用 intervention + output-invariance；inharmonic-like preset
  使用 onset / spectral rank / periodicity / envelope，不用伪造 cents；分型规则必须
  在训练前由 target render descriptor 固定；
- 500-step 只有在旧 8 preset 不退步、且新增 preset 至少 75% 通过各自分型闸门时
  才可延长；最终要求旧 8 全过、新增 16 至少 14/16 通过，失败逐 preset 报告；
- 无论结果如何，本阶段不自动解锁真实语料。还需单独完成每音色完整目标演奏音域
  的 f0 coverage audit。
