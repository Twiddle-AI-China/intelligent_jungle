# P0-C4 大规模训练放行审计

日期：2026-07-16

> **2026-07-16 更新**：放行条件第 2 项（residual pitch 不可读，probe
> ≤0.35）经方法学评审被重新定义为 output-level pitch invariance，并已由
> qgpu job 121/122 **通过**（grid spread median 0.0 cents、10/10 插值路径；
> 见 [`p0c4a-review-and-output-invariance-plan.md`](p0c4a-review-and-output-invariance-plan.md)）。
> probe 降级为趋势诊断。P0-C4B noise/inharmonic 闸门与候选 streaming export
> 已由 step-50 short-balanced checkpoint `393289…` **通过**（详见
> [`p0c4b-calibration-audit.md`](p0c4b-calibration-audit.md)）。剩余拦截项为跨规模
> 证据，以及新增的
> **每音色全音域 f0 覆盖**语料要求（跨八度路径在超出训练音域的 f0 下
> 实测失效）。**总决策不变：继续研究，暂不放行大规模训练。**

## 决策

**当前不放行大规模 pitch-conditioned BRAVE 训练。**

可以继续使用 5080/qgpu 做小规模、可证伪的结构实验，但不应把当前配置扩到 1,778
段真实语料。8-preset 结构闸门现已通过；否决继续成立的原因变为尚无 24-preset
泛化证据，且每音色完整演奏音域的 f0 覆盖仍未建立。

## 放行条件逐项审计

| 条件 | 证据 | 状态 |
|---|---|---|
| harmonic 显式音高控制 | 6 presets，24 interventions；median 10 cents，slope 0.996，6/6 passed | 通过 |
| output-level pitch invariance | source×target grid spread median 0 / P95 18.5 cents，控制行 24/24，路径 10/10 | **通过** |
| residual pitch probe（诊断） | 最好 balanced accuracy 0.5365；受 keyboard tracking 混淆，不再作为闸门 | 仅诊断 |
| latent 未整体塌缩 | 当前最好 preset identity 0.8125，随机为 0.1667 | 通过 |
| harmonic 音色保持 | cosine 0.9802；P0-C3 基线 0.9726 | 通过 |
| noise/inharmonic 音色 | C4B：Bell/Wood 均 3/4 谱识别，onset/periodicity/envelope 全过 | **通过（8-preset）** |
| 当前候选 streaming export | schema-v2 offline/streaming 本机加载、解码、phase-zero/连续性通过 | **通过** |
| 跨音色规模外推 | 当前因果试验仅 6 harmonic presets | 证据不足 |

8-preset 上游性质现已通过，但它不能代替跨规模验证；在 24-preset 与完整 f0
覆盖证据出现前，仍没有理由支付 1,778 段真实语料的训练成本。

## 已排除的简单修复

P0-C3 harmonic 基线的外置 source-pitch balanced accuracy 为 0.6875。所有 probe 都
使用 within-preset centering、leave-one-preset-out 四分类，共 192 个 window 样本；
preset identity 使用 leave-one-pitch-out 六分类。

| 方案 | checkpoint | pitch accuracy | preset identity | 控制 |
|---|---|---:|---:|---|
| P0-C3 frozen encoder | baseline | 0.6875 | 0.6979 | 6/6 |
| frame GRL，weight 0.05 | job 107 best | 0.6354 | 0.7969 | 6/6 |
| GRL classifier warm-up + 3:1 更新 | job 112 best / last | 0.6563 / 0.7292 | 0.8281 / 0.7865 | 6/6 |
| paired latent consistency，weight 1 | job 115 last | 0.5573 | 0.7917 | 6/6 |
| paired latent consistency，weight 10 | job 117 last | **0.5365** | **0.8125** | **6/6** |
| weight 10 再追加 1,880 batch | job 119 best / last | 0.5573 / 0.6042 | 0.8125 / 0.8177 | 5/6 / 6/6 |

GRL 在 classifier 变强后反而让外置 probe 恶化，说明简单对抗博弈会重排 pitch
信息而非移除。直接 latent consistency 明显更有效，但约 470 batch 后最好仍离
0.35 很远；继续 1,880 batch 出现平台和反弹，并一度损伤控制闸门。因此“再多跑
一些相同训练”已经被实测否定。

当前最好的诊断 checkpoint 是 job 117 step 470 last，SHA-256：

`7eacd03c4c86314ff8b646f9e1191cbe8c6c4a42cc421390d437bf105fe00451`

它不是大规模训练种子，也不是发布候选。

## 下一次允许做的工作（当前）

1. 冻结 C4B step-50 候选，不再围绕 8 presets 调权重或步数；
2. 扩到预注册的 24-preset render generalization pilot，保持 harmonic 与
   inharmonic 分型闸门和每 preset 失败明细；
3. 同时补每音色目标演奏音域的 f0 coverage audit；只有 24-preset 与 coverage
   同时通过，才重新审议 1,778 段真实 corpus 的大规模训练。

因此当前项目决策是：**继续研究，停止 scale-up。**
