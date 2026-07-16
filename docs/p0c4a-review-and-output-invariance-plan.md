# P0-C4A 评审与 output-invariance 重定闸门计划

日期：2026-07-16。评审对象：`a502486..10e177d` 六个 checkpoint（P0-C1 →
P0-C4 scale-readiness decision）。

## 评审结论

**实验过程可信，负结果成立，"不放行 scale-up"的决策正确。**但 P0-C4A 使用的
residual pitch probe ≤0.35 闸门存在方法学问题：它把"合法的音高相关音色信息"
与"音高泄漏"混为一谈，可能在原理上不可达。下一步不应继续攻这个闸门，而应
先用一次纯评测回答产品真正依赖的问题：**固定显式条件时，latent 里残留的
source pitch 是否会泄漏到输出音高**。

## 已核实的过程质量

抽查了评测代码、数据集实现与服务器原始产物，与文档记录逐项一致：

- 干预协议正确回答因果问题：固定 MIDI 56 参考音频的 posterior mean latent，
  只替换 `f0`，log2 域拟合 pitch-response slope，通过标准在运行前显式固定
  （`pitch_intervention.py`）；
- swap 数据集 source/target 同 preset、异 note、同 128-sample 裁切起点，
  条件来自 renderer 真值而非估计器（`pitch_pilot_dataset.py`）；
- P0-C3 头条数字与服务器 `p0c3-plus5k-pitch-intervention.json` 一致
  （6/8、median 10 cents、slope 0.992）；P0-C4A 最好 probe 0.5365 与
  `p0c4a-cons10-last.json` 一致，且该 checkpoint 控制仍 6/6；
- qgpu job 78–120 的 sacct 历史与各文档记录的 job 编号完全吻合；
- 负结果复核纪律良好：区分 best/last checkpoint、修复 pairwise-difference
  汇总 bug 并补回归测试、拒绝把 6/8 写成完整成功；
- HEAD 处 44 项研究测试全绿。

## 对 P0-C4A 闸门的方法学异议

probe 以 within-preset centering 后的 latent 窗口做 leave-one-preset-out 四分类，
目标 balanced accuracy ≤0.35。问题在于：

1. **同一 preset 弹不同键，音色本身合法地不同**（keyboard tracking：谱心、
   包络、亮度随键位变化）。encoder 为了重建**必须**编码这些差异，而线性
   probe 无法区分"latent 记住了 f0"与"latent 记住了随音高变化的合法音色"。
   因此 probe 存在一个由数据本身决定的下界，0.35 可能在原理上不可达。
2. weight 10 的 latent consistency 已经在直接对抗重建目标（把异 note latent
   拉近 = 抹掉合法的 note 相关音色），0.5365 平台 + 追加训练反弹 + 一度 5/6
   控制，与"可移除部分已移除、剩余部分与功能性音色纠缠"的解释一致。
3. 192 个窗口、6 preset 的样本量下，±0.05 的 accuracy 差异接近噪声；各方案
   排序可信（全部 ≫0.35），但不宜再用它做精细调参依据。

**产品真正需要的性质是输出级的**：演奏时 `z_timbre` 来自 atlas/Boids，音高
来自 MIDI。latent 里残留 pitch 信息只有在**改变输出音高**时才是问题。这个
性质至今没有被直接测量——P0-C3 干预始终用同一个 note-56 参考 latent。

## 下一步计划

### N1（先做，纯评测，不训练）：output-level pitch invariance

扩展 `pitch_intervention.py`，对当前候选 checkpoint（job 117 cons10-470 last，
`7eacd0…`）和 P0-C3 best（`cd3bb6…`）各跑一次：

1. **source×target 全网格**：对 6 个 harmonic preset，分别用 MIDI 41/48/56/63
   四条 source 音频编码得到 4 个 latent，各在 4 个 target `f0` 下解码
   （6×4×4=96 次），测输出音高。
   - 指标 A（不变性）：固定 (preset, target) 时，输出音高跨 4 个 source latent
     的极差与中位差；
   - 指标 B（控制保持）：全部 96 次对 target 的误差。
2. **atlas 路径稳定性**：固定 `f0`，在两个 preset 的 latent 间线性插值
   （模拟音色漫游），沿路径测输出音高漂移。

**闸门（运行前固定）**：指标 A 的 median ≤25 cents 且 P95 ≤50 cents；指标 B
仍满足 P0-C3 的 per-preset 标准；插值路径音高偏离 conditioned `f0` ≤50 cents。

- 通过 → P0-C4A 以 output invariance 为准宣告通过，probe 降级为趋势诊断，
  进入 N3；
- 不通过 → 证明 latent pitch 真的泄漏到输出，此时才轮到 scale-decision 文档
  里的结构性方案（显式分区/投影 latent bottleneck），且 N1 的网格评测直接
  成为该方案的验收标准。

### N2：改写 P0-C4 闸门定义

在 `p0c4-next-stage-plan.md` 与 `p0c4-scale-readiness-decision.md` 补记：
放行条件第 2 项由"probe ≤0.35"改为"N1 output invariance 闸门"，并写明
方法学理由（keyboard tracking 混淆）。probe 保留为诊断项。

### N3（P0-C4B）：非谐波尾部

对 `PERC BELL`、`PRIML WOOD` 优先做显式 `periodicity/noise_mix` 条件通道
（schema 升级为 `pitch-conditioning-v2:f0_hz,loudness,gate,periodicity`，
版本号必须变更，加载端按 ID 校验）；训练标签用 pYIN voiced probability 从
target render 测得。评估用与其声学属性相符的指标（onset、谱包络、
periodicity 一致性），不伪造 cents 成绩。不损伤 6 个 harmonic preset 为硬
约束。

### N4：候选 checkpoint 的导出与 latent 统计核查

scale-decision 已标记"当前候选 streaming export 未验证"。另有一个新风险：
swap 训练只用 phase-1 谱损失、**没有 KL 项**，encoder tail 解冻后 latent
分布可能偏离 VAE prior——而 atlas、PCA fidelity 和 export 宽度机制都假设
该先验。需要：

1. 对候选 checkpoint 跑 `export_pitch_checkpoints.sh`（offline+streaming +
   SHA-256），拉回 M4 加载冒烟，确认延迟事实边界不变；
2. 对比候选与 P0-C3/baseline 的 latent 统计（均值/方差 vs prior、PCA
   fidelity 曲线），判断 atlas 兼容性；漂移过大则后续训练需恢复低权重 KL。

### N5：只有 N1–N4 全过 → 24-preset generalization pilot

沿用已验证的 manifest 选择器扩到 24 个通过 intervention 检查的 preset，重跑
全套闸门；该层通过后才重新审议 1,778 段真实语料的大规模训练（维持
scale-decision 的现行否决）。

## N1 首轮结果（2026-07-16，qgpu job 121/122）

评测入口 `lcs-pitch-invariance`（`pitch_invariance.py`，闸门在代码与本文档中
预注册一致）。两个 checkpoint 都在 6 harmonic preset 上通过全部闸门：

| checkpoint | grid spread median / P95 | 控制行 | gated 路径 | overall |
|---|---:|---:|---:|---|
| cons10-470 last（`7eacd0…`） | 0.0 / 10.0 cents | 24/24 | 10/10（最差 20 cents） | **通过** |
| P0-C3 best（`cd3bb6…`） | 0.0 / 18.5 cents | 24/24 | 10/10（最差 20 cents） | **通过** |

最差 grid cell 为 preset 1580 target MIDI 41：spread 40 cents（cons10）/
45 cents（P0-C3 best），仍低于 50 cents P95 闸门对应的单元级别水平。

**判定：P0-C4A 按 output-invariance 闸门通过。**且 P0-C3 best（未加任何
consistency/GRL）已经通过——说明 paired swap 训练本身就已给出产品需要的
输出级不变性，此前整条 GRL/consistency 支线追逐的 probe 数字与输出行为
脱钩。consistency 训练的增益只体现为 P95 从 18.5 收紧到 10.0 cents。
GRL/结构 bottleneck 线关闭，probe 永久降级为趋势诊断。

两个附带事实：

1. **跨八度参考路径全部失败（未纳闸门，信息项）**：Perky 04（+2 八度组）
   与 207 Hz 组之间的 5 条插值路径在 conditioned f0=415.3 Hz 下最差
   1910–3110 cents。原因是 415.3 Hz 超出 207 Hz 组 preset 的训练音域
   （87–311 Hz）——**f0 超出该音色训练范围时条件失效**。这不是 latent
   泄漏（同 preset 网格已证明不变性），而是给 P0-C5 语料的硬要求：每个
   音色区域必须覆盖完整目标演奏音域。
2. **C3 报告出处更正**：`p0c3-plus5k-pitch-intervention.json`（6/8、
   median 10 cents 的头条来源）实际评测的是 last checkpoint
   `epoch-epoch=0079.ckpt`（`934c9f…`），而 C3 文档宣称选用 best
   `cd3bb6…`（step 4216）。job 102 对 best 的 6-preset 复测（6/6、
   median 10）与本轮 job 122 均确认 best 行为一致，结论不受影响，但
   后续文档引用 checkpoint 时应同时给出报告的 `conditioned_checkpoint`
   字段。

## N4 结果（2026-07-16，qgpu job 123/125）

**导出验证通过**：cons10-470 last 经 `export_pitch_conditioned.py` 导出
offline 与 streaming `.ts`（SHA-256 记录于 `reports/p0c4a-export.txt`，
`5a9f8a…` / `2fce44…`），拉回 Apple Silicon 后加载、`decode_conditioned`
解码、streaming 相位跨 block 前进均正常，schema ID 可读。未重新测量
延迟，延迟事实边界维持既有声明。

**latent 统计（48 条 pilot 音频，同批对比）**：

| 指标 | BRAVE baseline | P0-C3 best | cons10 last |
|---|---:|---:|---:|
| posterior std 均值 | 0.987 | 0.990 | 0.993 |
| KL/dim 均值 | 0.018 | 0.016 | 0.019 |
| posterior mean 绝对值均值 | 0.025 | 0.029 | 0.096 |
| PCA fidelity @8D | 0.997 | 0.992 | 0.956 |

无 KL 项的 swap 训练**没有**破坏先验尺度（std≈1、KL 不变）。cons10 的
consistency loss 带来轻微均值漂移与 fidelity 摊开；P0-C3 best 几乎与
baseline 同构。

**候选选择**：consistency 支线的唯一动机是已废弃的 probe 闸门，且
P0-C3 best 同样通过 output-invariance（仅 P95 18.5 vs 10.0 cents 之差）、
latent 几何更接近 baseline。**P0-C4B 从 P0-C3 best（`cd3bb6…`）出发**，
cons10 checkpoint 保留为诊断对照。

## 边界不变

- 单音 batch=1 事实边界、`[1,3,7,7]` streaming delay、conditioning schema
  版本纪律照旧；
- descriptor disentanglement（brightness/energy/articulation）仍排在全部
  音高闸门之后。
