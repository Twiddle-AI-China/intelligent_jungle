# P0-C4B：periodicity 条件通道与非谐波尾部

日期：2026-07-16。前置：P0-C4A 已按 output-invariance 闸门收口
（[`p0c4a-review-and-output-invariance-plan.md`](p0c4a-review-and-output-invariance-plan.md)），
起点 checkpoint 为 P0-C3 best（`cd3bb6…`）。

## 通俗版：要解决什么问题

八个 pilot 音色里有两个（`PERC BELL` 21385、`PRIML WOOD` 36905）在 P0-C3
一直不及格。原因不是训练不够，而是给 decoder 的"哼唱骨架"不对：现在的
excitation 只有两档——有音高就给纯谐波振荡器，没音高就给纯噪声。钟和木鱼
这类打击音色介于两者之间（敲击瞬间是噪声、余振有部分周期性），被迫二选一
后 decoder 只能学出折衷的错误声音。

解法：给条件加第 4 个通道 `periodicity`（0–1），直接控制"骨架里谐波成分
和噪声成分的混合比"。训练时这个值不是拍脑袋给的，而是用 pYIN 从目标渲染
音频里逐帧实测——音色实际有多周期，excitation 就有多周期。演奏谐波音色时
MIDI 端恒给 1，行为与升级前完全一致。

## Schema v2（已实现，commit `0fbc9d0`）

`pitch-conditioning-v2:f0_hz,loudness,gate,periodicity`。要点：

- excitation = `p · harmonic + (1-p) · noise`，随后照旧做逐帧 RMS 归一到
  `loudness × gate`；`p=1`(voiced)/`0`(unvoiced) 与 v1 逐样本一致（单测
  锁定），因此 **P0-C3 best 可直接加载且 6 个 harmonic preset 行为不变**；
- 版本号强制变更，加载端按 ID 校验，v1 宿主必须显式失败；
- 训练标签：pilot 数据集加载时对每个 clip 跑一次 pYIN（hop=128 对齐
  conditioning 帧），voiced probability × gate 即 periodicity 通道，
  结果缓存为 manifest 旁的 `.npz`；
- 通用语料的 NCCF 自监督路径暂用二值 voiced 指示（=v1 行为），不冒充
  校准的周期性度量。

## 预注册闸门（运行任何训练前固定）

### 非谐波 preset（21385、36905）——`lcs-pitch-inharmonic`

对每个 preset：encode note-56 render 的 posterior mean latent，分别用
4 个目标 note 的 renderer-truth 条件（名义 f0、目标 render 实测
loudness/gate/periodicity）解码，与目标 render 对比。**不使用 cents。**

| 闸门 | 阈值 | 回答的问题 |
|---|---|---|
| onset | 每次干预 onset 帧差 ≤5 帧（≈14.5 ms） | 该响的时候响了吗 |
| 谱识别 | 输出的 log-mel 最近邻是其目标 note 的 render，每 preset ≥3/4 | 条件真的把输出推向目标音了吗 |
| periodicity 一致性 | 输出与目标 render 的 pYIN voiced ratio 差：median ≤0.25 且 max ≤0.40 | 没有幻听出稳定音高、也没塌成纯噪声吗 |
| 包络 | 输出与目标 log-RMS 包络相关系数 median ≥0.80 | 打击衰减形状对吗 |

四项全过该 preset 才算过；两个 preset 都过，C4B 的非谐波侧才通过。

### 谐波 preset（6 个）——硬约束，不得损伤

复用既有工具、既有阈值，不重新定义：

1. `lcs-pitch-intervention`：6/6 通过（per-preset ≤50 cents、voiced
   ≥0.60、slope ∈ [0.90, 1.10]）；
2. `lcs-pitch-invariance`：grid spread median ≤25 / P95 ≤50 cents、
   控制行 24/24、gated 路径全过——即不得比 P0-C3 best 的 N1 结果退步。

任何一项退步即判失败，回退方案（降低非谐波 preset 采样权重或冻结更多
encoder）后重试；不允许以"非谐波变好了"抵扣谐波退步。

## 训练方案

- 起点：P0-C3 best（`cd3bb6…`，N4 已确认其 latent 几何最接近 baseline）；
- 数据：8 preset 的 paired pitch-swap（v2 条件），不加 adversary、不加
  consistency（两者已随 probe 闸门废弃）；encoder 冻结（P0-C3 配置）——
  先验证纯 decoder/FiLM 能否学会 periodicity 混合，不夹带 encoder 变量；
- 分级纪律照旧：2-step qgpu smoke → 500-step calibration（谐波闸门不退步
  + 非谐波指标方向正确）→ ≤5k-step pilot → 全套闸门评测；
- 评测顺序：先谐波硬约束，后非谐波闸门；报告存 `reports/p0c4b-*.json`。

## 边界

- 单音 batch=1、`[1,3,7,7]` streaming delay 事实不变；导出后需按 N4 流程
  重验 conditioned TorchScript（schema ID 变为 v2）；
- 每音色全音域 f0 覆盖是 P0-C5 语料要求，本阶段不解决；
- scale-up 维持否决：C4B 全过后仅解锁 24-preset 泛化 pilot（N5）。

## 首轮 500-step 校准复核（qgpu 134–136）

首轮候选的谐波硬约束通过（intervention 6/6；invariance spread median 0、
P95 10 cents、控制行 24/24、路径 10/10），但两个非谐波 preset 都只有
1/4 谱识别正确，输出一律最接近 MIDI 63。故 **不得进入 ≤5k pilot**。

进一步复核发现两处过程缺陷，使这轮不能用于判断“相对 P0-C3 best 的改善方向”：

1. `FREEZE_ENCODER=1` 只关闭了参数梯度，Lightning 仍把 encoder 置于 train
   mode，8 个 BatchNorm running-stat buffer 相对起点发生变化（最大绝对差
   206.25）。参数本身确实逐样本未变，但实验不再是预注册的“纯 decoder/FiLM”；
2. 名为 `p0c4b-p0c3ref-inharmonic.json` 的参照实际选中了 epoch-79 last
   checkpoint，而不是指定的 P0-C3 best `cd3bb6…`。同时非谐波 excitation
   含随机噪声，旧评测没有固定并记录 seed。

修复后先从 `cd3bb6…` 重跑 2-step smoke 和 500-step calibration。放行条件仍是
谐波两套硬闸门全过；“非谐波方向正确”在重跑前进一步量化为：两个 preset
各自谱识别至少 2/4，且目标 note 的 median rank 从旧基线的 2.5 改善到 ≤2。
达不到就停止同配方加步数，改做仅含两个非谐波 preset 的容量诊断；它不是候选
模型，只回答现有 excitation→FiLM 结构在充分采样下能否学会命令差异。

纠正后 qgpu 138–140 已确认：冻结与传播正确，谐波硬闸门全过，但两个非谐波
preset 仍均为 1/4、median rank 2.5，与精确 P0-C3 best 无差异；PRIML WOOD
另有 periodicity max delta 0.926。故 ≤5k 被拒绝，后续按
[`p0c4b-calibration-audit.md`](p0c4b-calibration-audit.md) 的 capacity diagnostic
停止规则执行。

最终通过状态：capacity → curriculum → short balanced recovery 后，step-50
checkpoint `393289…` 同时通过 6 个 harmonic preset 的两套硬闸门与 2 个
inharmonic preset 的全部闸门；schema-v2 offline/streaming 导出及本机 phase-zero
加载验证也通过。完整数字与 artifact SHA 见 calibration audit。C4B 收口，下一步
只解锁 N5 24-preset generalization pilot，不解锁大语料训练。
