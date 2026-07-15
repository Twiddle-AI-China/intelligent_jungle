# 当前声音链事实边界

> 更新于 2026-07-14。代码与测试的 truth source，不代表听感已经通过。

## 已经成立

- `npm run dev` 加载正式 BRAVE streaming TorchScript：SHA-256 `36ca2bd1f3b3af1606bae36aa8889ee9c0964b11542a5e233297c584ae16d659`。
- 模型为 44.1 kHz、4D latent；每次以 8 latent frames 解码 1024 samples，音频时长 23.22 ms。
- 三类语料经正式 offline encoder 得到 4D 轨迹；每个 Species 对中心化轨迹做 SVD，取前两个数据方向形成 2D→4D 曲面。群心 XY 在曲面上移动时会同时改变四个 latent 维度。
- 纵向 Dorian 音级带产生 `−6…+6` 半音目标，经向量化双读头流式移调器作用于每个 decoder Voice；PULSE 扫描线穿过鸟时触发 110 ms 衰减包络。
- 服务端实时返回 stereo Float32 PCM；浏览器 AudioWorklet ring buffer 播放，不读取预渲染 WAV。
- buffer 水位回传服务端形成 pacing 闭环。浏览器实测 3 Voices 连续约 30 秒 underrun=0；6 Voices 回归时 underrun=0。
- 6 Voices 浏览器实测完整单块渲染约 8.27 ms，低于 23.22 ms 音频块时长，连续 10 秒 underrun=0。
- 曲面 smoke test：latent control delta=3.71、PCM delta RMS=0.0209、频谱对数距离=0.79，非静音输出，移调后校准的三 Voice 电平差约 0.25 dB。
- decoder 失败时明确静音；没有振荡器 fallback，也没有离线纹理 fallback。

## 尚未成立

- 当前曲面来自 checkpoint 数据的线性 SVD chart，不等于经过人工听测建立的 perceptual atlas。
- 当前音高来自 decoder 后实时移调，并非 BRAVE 内部的 pitch conditioning；模型固有音高检测与音准仍需听测。
- Web 路径依赖本机 Python/Torch 服务；JUCE 尚未内嵌正式 LibTorch kernel。
- 30 分钟 6-Voice、0 underrun / 0 deadline miss 的最终长稳态闸门尚未重跑。
- BRAVE 语料仍可能带稳定调性；实时解码与电平校准不等于听感和编曲已经通过。

## 当前控制链

```text
Flock 群心 x, y
  → Species checkpoint SVD chart（2D→4D）
  → BRAVE streaming decoder（实时）
  → pitch shift、PULSE envelope、Voice 电平校准、energy、pan、limiter
  → WebSocket Float32 PCM
  → AudioWorklet ring buffer
  → 声卡
```

## 成功判据

只有页面显示 `BRAVE 实时 decoder · 4D latent · 36ca2bd1` 且 `/api/decoder-status` 返回 `liveDecoder: true`，才算实时模型接通。`npm run test:realtime` 必须全部通过。
