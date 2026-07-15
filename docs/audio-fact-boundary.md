# 当前声音链事实边界

> 更新于 2026-07-14。代码与测试的 truth source，不代表听感已经通过。

## 已经成立

- `npm run dev` 加载正式 BRAVE streaming TorchScript：SHA-256 `36ca2bd1f3b3af1606bae36aa8889ee9c0964b11542a5e233297c584ae16d659`。
- 模型为 44.1 kHz、4D latent；每次以 8 latent frames 解码 1024 samples，音频时长 23.22 ms。
- 三类语料只提供 Species 的安全 latent anchor 与各轴尺度；画布群体 XY 直接控制 Z0/Z1，群体平均速度直接控制 Z2/Z3，逐块送入 streaming decoder。
- 服务端实时返回 stereo Float32 PCM；浏览器 AudioWorklet ring buffer 播放，不读取预渲染 WAV。
- buffer 水位回传服务端形成 pacing 闭环。浏览器实测 3 Voices 连续约 30 秒 underrun=0；6 Voices 回归时 underrun=0。
- 6 Voices 浏览器实测单块 decode 约 6.12 ms，低于 23.22 ms 音频块时长，underrun=0。
- 直接映射 smoke test：latent control delta=3.04、PCM delta RMS=0.0556、频谱对数距离=2.38，非静音输出，三 Voice 校准后电平差小于 0.001 dB。
- decoder 失败时明确静音；没有振荡器 fallback，也没有离线纹理 fallback。

## 尚未成立

- XY 不是 PCA、UMAP 或学习出的可视化投影，而是直接指定 decoder latent 的前两维；运动向量直接指定后两维。
- 当前映射是最小的 `Boids (x,y,vx,vy) → BRAVE (z0,z1,z2,z3)`，不经过 brightness 等感知词中间层。
- 和声中心尚未成为独立的 decoder pitch control。
- Web 路径依赖本机 Python/Torch 服务；JUCE 尚未内嵌正式 LibTorch kernel。
- 30 分钟 6-Voice、0 underrun / 0 deadline miss 的最终长稳态闸门尚未重跑。
- BRAVE 语料仍可能带稳定调性；实时解码与电平校准不等于听感和编曲已经通过。

## 当前控制链

```text
Boids / Flock 的 x, y, vx, vy
  → 有界 4D latent + Species anchor
  → BRAVE streaming decoder（实时）
  → Voice 电平校准、energy、pan、tanh safety limiter
  → WebSocket Float32 PCM
  → AudioWorklet ring buffer
  → 声卡
```

## 成功判据

只有页面显示 `BRAVE 实时 decoder · 4D latent · 36ca2bd1` 且 `/api/decoder-status` 返回 `liveDecoder: true`，才算实时模型接通。`npm run test:realtime` 必须全部通过。
