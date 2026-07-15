# 当前声音链事实边界

> 更新于 2026-07-15。代码与实测的 truth source，不代表听感已经通过。

## 已经成立

- 默认模型是自训练 BRAVE 16D streaming TorchScript，SHA-256 为 `80e18cfbf90eed95fd7b4472c0bfcef1f5997e2eb48dd6ab2cb1b4c28545e287`。
- 旧服务只读取每个一小时文件开头 2 秒。现在每种 Species 均匀读取 24 个 2 秒片段，总构图材料从 6 秒增至 144 秒，并覆盖完整三小时 corpus。
- XY 已从 neural latent 协议中移除。每个 Flock 固定汇总紧密、对齐、扩张、运动能量、环流、湍流、群间压力、障碍压力八种关系，再映射到语料 SVD 方向，并通过块间 ramp 保持连续。
- 同一 checkpoint 已实际导出并读取验证为 8D、16D、32D；默认采用 16D，不再把文件名或预估 fidelity 当成模型事实。
- 三套 decoder 同时驻留，每个 Voice 独立选择 BRAVE 16D、FSL10K 16D（MIT）或 MRP 8D（CC-BY-NC-4.0）。MRP 文件名含 z16，但 TorchScript metadata 实际为 8D。
- 服务从每个模型的 `decode_params` 读取压缩比。BRAVE 每 latent frame 输出 128 samples；两个外部 RAVE 均输出 2048 samples。
- 纵向 Dorian 音级带产生 `−6…+6` 半音目标；PULSE 扫描线产生 trigger。两者仍是 decoder 后的移调与包络，不是假称模型原生能力。
- PCM 通过 WebSocket 和 AudioWorklet ring buffer 实时播放；decoder 失败时静音，没有振荡器或预渲染 WAV fallback。
- latent 目标采用每公共 block 最大步长限速；BRAVE 在 ensemble 内拆成两个子块时各走一半 step，因此不会因压缩比不同而移动两倍快。
- 每个 Flock 一次 neural decode；空间连通分组产生最多四个独立 pitch/envelope/pan 分支。它增加后处理，不按 note 数增加 neural decoder 调用。

## 2026-07-15 实测

当前三模型 ensemble smoke 已确认：切换 8D 关系状态会改变 latent、PCM 与频谱，输出非静音。XY 不在测试控制帧中。

三 decoder 同时运行、三个 Voice 分别路由且每 Voice 四个 note groups 时，当前关系版 ensemble 单块约 10.54 ms，音频块为 46.44 ms；latent 平均移动 0.52，PCM 差异 0.0201 RMS，频谱 log 差异 1.099，全部自动检查通过。

| 模型 | latent | 1 Voice p95 | 3 Voices p95 | 6 Voices p95 | 音频块 |
|---|---:|---:|---:|---:|---:|
| 自训练 BRAVE | 16D | 2.40 ms | 4.89 ms | 6.56 ms | 23.22 ms |
| FSL10K RAVE | 16D | 1.36 ms | 2.70 ms | 4.10 ms | 46.44 ms |
| MRP RAVE | 8D | 4.46 ms | 5.92 ms | 10.55 ms | 46.44 ms |

这是裸 decoder 的 100 次本机基准，不等于 30 分钟 Web 长稳态测试。BRAVE smoke test 中三 Voice 电平差约 2.46 dB，已无单个 Voice 压倒全部输出的测量证据，但仍需人耳检查固定音问题。

## 尚未成立

- 当前 SVD 方向与尺度来自数据，不是经过坏点筛选和人耳命名的 perceptual atlas。
- BRAVE 训练材料仍只有三个程序化家族。完整取样与 16D 控制扩大了可走范围，但不会凭空增加训练集不存在的乐器类别。
- 外部模型音色更宽不等于更 musical 或更可预测；MRP 的许可也不允许商业发布。
- Web 6-Voice、30 分钟、0 underrun 的最终闸门尚未重跑；JUCE 也尚未接入这套新链路。
- 没有人工 A/B，不能宣布三者中哪一个是最终产品模型。

## 当前控制链

```text
群内 / 群间 / 障碍的 8D 关系状态
  → 完整语料分层取样的 SVD 方向与安全尺度
  → 每 Voice 路由到 BRAVE / FSL10K / MRP（可同时运行）
  → 1024/2048 block 对齐与 ensemble mix
  → pitch shift、PULSE envelope、Voice 校准、energy、pan、limiter
  → WebSocket Float32 PCM
  → AudioWorklet ring buffer
```

音符走另一条链：note group 的 X 位置由 PULSE 扫描触发，Y 位置选择 Dorian 音高，横向宽度产生时值。XY 不进入 decoder latent。

只有 Voice 行显示实际 decoder 路由，且 ensemble realtime smoke 同时返回三个 `decoderIds`，才算三模型链路接通。
