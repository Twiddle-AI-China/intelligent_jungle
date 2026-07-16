# P0-C6：非谐波/瞬态音色的重建路径

日期：2026-07-16。起点：P0-C5 拒绝的 24-preset 扩展，保留 P0-C4B
8-preset checkpoint 作为唯一当前候选。

## 判断

P0-C5 已排除两个简单解释：增加 tail sampling 不能避免回归，而
target-latent oracle 也不能救回主要失败 preset。问题不应再表述为
“多训一会儿”或“再把 pitch 拆得干净一点”，而是：当同一个轻量
BRAVE decoder 同时承担稳定谐波音高与强瞬态/非谐波音色时，当前
excitation 和全局重建目标产生了可测的任务冲突。

## N0：先做 loss / gradient attribution，不训候选

在 C4B checkpoint 上对 verified24 固定 batch 记录：

1. harmonic-like 与 descriptor-tail 分别的 multiscale spectral、loudness/
   envelope、adversarial/feature-matching 损失；
2. 各损失对 condition downsamplers、FiLM 和 decoder synth 的 gradient norm；
3. harmonic-like 与 tail 对同一参数块的 gradient cosine。

必须使用同一组预注册 preset、crop 和 seed，报告原始数字而不只给均值。
若 tail/harmonic 在共享 synth 或 FiLM 上持续负 cosine，才允许进入分路实验。

## N1：最小可证伪结构

不引入离散的“音色类别开关”，而使用连续描述符：

- 保留 schema-v2 `f0 / loudness / gate / periodicity`；
- 新增 `brightness` 与 `articulation/transientness` 两个可测的时变条件；
- 谐波主干从 C4B 冻结，只新增一个由 periodicity/transientness 连续门控
  的轻量 residual excitation/decoder adapter；
- 先只在 8 个 tail preset 上做 2-step 传播验证和最多 100-step 容量实验，
  每次同时回放 C4B 的 6 个 harmonic 硬闸门。

这一步是 FaderRAVE descriptor disentanglement 之前的解码能力闸门。若 oracle
重建仍无法达到 tail 7/8，不得加 discriminator 声称“解耦”。

## 边界

- 不改 BRAVE 因果/低延迟边界；
- 不解冻 encoder，不引入复音、Boids 或大规模真实语料；
- 不把 target-latent oracle 当成推理方案；
- 新 descriptor 必须有独立测量误差和 intervention 闸门，不只看重建损失。
