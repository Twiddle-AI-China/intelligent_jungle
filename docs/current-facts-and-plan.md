# 当前真实事实与下一步

> 快照：2026-07-15。只写已经检查或测到的事实。

## 已完成

### 世界与控制

- Species 是神经声源身份，Flock 是一个 decoder Voice，Boid 是 Voice 内的行为粒子。
- 初始 3 Voices / 21 Boids；最多 6 Voices，每群 2–32 Boids。
- 加鸟、障碍、引导、擦除、新增声源、Dorian 音高场、PULSE trigger、mute/solo 均已实现。
- XY 控制 SVD 前两个主要音色方向。平均速度、聚散、对齐、避障和能量轻量驱动其余 latent 方向。
- 映射坐标是目标，不再在相邻块直接跳转。实际 latent 每个公共 ensemble block 按可调 `latentStep` 限速追赶，并在块内插值。
- 同群鸟按空间连通距离形成 1–4 个 note groups。位置/纵向趋势决定 pitch，宽度/对齐决定 duration；面板只暴露运动和空间参数。

### 自训练 BRAVE

- qgpu job 73 完成 1,000,000 step 训练。最终 checkpoint SHA-256：`bf010bed68a5998968a6fb31151f89c6eaea36300c6926f3b20eb1979b5148fb`。
- checkpoint 已从 5080 恢复。qgpu job 76/77 完成多维导出，输出已读取验证为实际 8D / 16D / 32D。
- 默认 16D streaming 模型 SHA-256：`80e18cfbf90eed95fd7b4472c0bfcef1f5997e2eb48dd6ab2cb1b4c28545e287`。
- 训练 corpus 共三小时，但只包含 pulse、resonance、texture 三个程序化声音家族。时长不等于音色类别丰富。

### 地图与外部基线

- 已删除“每种只读开头 2 秒”的旧实现。现在每种读取 24 个均匀分布的 2 秒片段，覆盖完整文件。
- FSL10K 16D 权重已下载校验，SHA-256 `3ec093e132ce75d7fee3b8b734c739ebf8711a57ee332a60bce4359e2e34073e`，MIT。
- MRP 权重已下载校验，SHA-256 `28cb170630b6675bc7b0ef94e42bf6c11f2db08c0805d2a91576d140a83063ff`，CC-BY-NC-4.0。其文件名含 z16，但内部 metadata 为 8D。
- 三套 streaming decoder 同时驻留。每个 Voice 独立路由到其中一套；初始三个 Voice 分别使用 BRAVE、FSL10K、MRP。
- ensemble 把 BRAVE 的两个 1024-sample 子块与 RAVE 的一个 2048-sample 块对齐，保持同一个 44.1 kHz PCM 时钟。

### M4 实测

| 模型 | 1 Voice p95 | 3 Voices p95 | 6 Voices p95 | 音频块 |
|---|---:|---:|---:|---:|
| BRAVE 16D | 2.40 ms | 4.89 ms | 6.56 ms | 23.22 ms |
| FSL10K 16D | 1.36 ms | 2.70 ms | 4.10 ms | 46.44 ms |
| MRP 8D | 4.46 ms | 5.92 ms | 10.55 ms | 46.44 ms |

- 三套 realtime smoke test 均确认：控制移动 latent，PCM 与频谱发生变化，输出非静音。
- ensemble smoke test 同时路由三套 decoder、每 Voice 四个 note groups：渲染约 8.4 ms / 46.44 ms 音频块，检查全部通过。
- BRAVE smoke test 的三 Voice 电平差约 2.46 dB。自动测量未复现“单个 C 音完全压住其他声部”，但这不代替人耳检查。

## 尚未成立

- 没有人耳 A/B，不能宣布哪个模型最 musical、最可玩或可作为产品模型。
- 当前 SVD chart 不是人工听测后的 perceptual atlas。
- 外部通用模型的音色更宽，但可能把内容、音高和音色缠在一起；MRP 不能商业使用。
- 6-Voice Web 30 分钟长稳态与 JUCE/LibTorch 接入尚未完成。
- 当前三家族 corpus 无法承担最终产品所需的音色广度。

## 下一步

1. 用同一录制 session 对三模型做人耳 A/B，比较范围、可预测性、伪影与动作复现，而不只比较“变化大不大”。
2. 在自训练 BRAVE 8D / 16D / 32D 间听测；16D 只是当前默认，不是提前宣布的最终答案。
3. 建立包含真实乐器、多奏法与声学纹理的受控新 corpus，再进行 transfer learning 或新一轮 BRAVE 训练。
4. 对选定模型运行 6 Voices、30 分钟 Web ring-buffer 闸门。
5. 听测与稳定性通过后，再把同一模型和映射移入 JUCE/LibTorch。
