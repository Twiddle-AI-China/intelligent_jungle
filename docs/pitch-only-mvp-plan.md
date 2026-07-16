# Pitch-only neural instrument MVP

日期：2026-07-16。本文档取代 P0-C6 tail/descriptor 路线，作为当前执行计划。

## 产品合同

```text
MIDI note / bend -------------------+
velocity / gate --------------------+--> BRAVE decoder --> waveform
timbre latent ----------------------+
```

当前只验证：MIDI 决定音高，timbre latent 可连续漫游，二者尽量
不互相改写。velocity 和 gate 是演奏信号，不是 disentanglement 研究维度。

periodicity 保留为 schema-v2 模型内部的 excitation 实现细节：对当前稳定
有声/谐波音色，演奏 API 根据 gate 自动产生 periodicity，不暴露给用户。

## 范围

- 从 verified24 中预先固定的 16 个 harmonic-like preset 做全量资格
  审计，产品只暴露通过者；
- 不对 bell/chime/steel-drum 等非谐波 tail 声称单一 f0 控制；
- 不增加 brightness、articulation 或 descriptor discriminator；
- 不解冻 encoder，不扩到 1,778 段真实语料，不处理复音；
- 保留 BRAVE causal/streaming 与 batch=1 低延迟边界。

16 个 preset 固定为：
`63836,1580,49633,12816,21594,74388,51848,22568,81278,46193,54079,21556,55528,21381,104204,18618`。

## P1：复用现有 checkpoint 做候选闸门

先不重训。审计 P0-C5 step-500 checkpoint：

- exact SHA-256：`e655a53daff1bd4e205e2381e62cd4e3c947906c0f2a70c501de15cdb5e92e39`；
- 已知 pitch intervention 16/16，64/64 voiced interventions，median cents 近 0，
  P95 18.5 cents，gross error 0；
- 已知 encoder 27/27 state tensors 与起点 bitwise 一致；
- 尚需对全部 16 preset 运行 output pitch-invariance，要求所有 control rows
  和所有 gated interpolation paths 通过。

该 checkpoint 训练时尚未显式固定 trainer RNG，因此即使通过也只能作为
artifact-locked MVP 候选，不宣称训练过程 bitwise 可重现。在候选闸门通过前
不重训，避免重新引入已经消失的极端 f0 错误。

## P2：收口推理 API

P1 通过后：

1. 保留底层 `decode_conditioned(latent + f0/loudness/gate/periodicity)` 用于兼容和审计；
2. 新增对产品的 `decode_pitch(latent + f0/loudness/gate)`，内部令
   `periodicity = gate`；
3. 导出后在 Apple Silicon 验证 schema、finite output、跨 block phase 连续和
   offline/streaming 可加载；
4. 前端/音频引擎只呈现 pitch、velocity、gate 和 timbre XY，不呈现
   periodicity/descriptor 控件。

## MVP 通过定义

- 最终支持库每个 preset 的 pitch intervention 通过；
- 最终支持库的 output pitch-invariance 全过；
- `decode_pitch` 与底层 `periodicity=gate` 逐样本一致；
- TorchScript offline/streaming 导出、本机加载、phase continuity 全过；
- 只声称小型、单音、谐波音色集上的 pitch-controlled MVP。

## P1 结果（qgpu 168）

16-preset 全量评测没有通过：grid spread 本身通过，但 control rows 为
61/64。失败仅集中在 KINKLY BIT (21594) 的 source note 41，以及
ToyOrkstra (54079) 的 source note 48/63。所有 69 条 gated interpolation paths
均通过。完整报告 SHA-256：
`57841aa38a0a8d1bf850b33e6cb04f214906aa31c5226d10ec6857c645b37752`。

pitch-only MVP 不重训去迁就这两个不稳定音色，而是将它们从支持库
剔除。从同一份全量报告严格过滤后，最终 14-preset 支持库为：

`63836,1580,49633,12816,74388,51848,22568,81278,46193,21556,55528,21381,104204,18618`。

其派生结果为 grid cells 56，spread median 0 cents、P95 6.26 cents，
control rows 56/56；91 条 latent paths 中 56 条 gated，56/56 通过，最差
20 cents。因此 P1 以“14 个已审计支持音色 + 2 个明确不支持音色”通过。

## P2 结果（qgpu 169–170）

job 169 因 `RUN_DIR` 误指向 version 上级目录而在 checkpoint 检查阶段失败，
未生成模型。job 170 按正确 `version_0` 导出成功：

- offline SHA-256：`6eca67bb2cc0e1e83d521d622bfdbd578997ac6e78334e373186a80617f67fa9`；
- streaming SHA-256：`5cce82465495c8eb33c259a1c44dc6505d2a7169edd0dbda68b684c4f0c0a0b5`。

两个模型已拉回 Apple Silicon 本机验证：`decode_pitch` 可调用，
performance schema 正确，输出 `(1,1,1024)` 且 finite；initial phase 为 0，
连续两块从 0 前进到 0.681 再到 1.362。单测确认 `decode_pitch` 与底层
`decode_conditioned(periodicity=gate)` 逐样本一致。
