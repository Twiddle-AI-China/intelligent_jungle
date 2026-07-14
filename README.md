# Latent Cosmos Synth

一个把鸟群自组织变成可演奏声音控制的新乐器 MVP。仓库同时包含可快速试奏的浏览器实现、macOS JUCE 原生壳，以及 BRAVE/RAVE 模型研究流水线。

当前关系固定为：Species 是神经声源身份，Flock 是一个 BRAVE decoder Voice，Boid 是 Voice 内的行为粒子。初始 3 Voices / 21 Boids，最多 6 Voices。Web 世界状态通过 WebSocket 连续控制 4D latent，本机 BRAVE streaming decoder 实时生成 PCM，再由 AudioWorklet ring buffer 播放。

## 运行

```bash
npm run dev
```

等待终端显示 `BRAVE ready` 后打开 <http://localhost:4173>，点击“唤醒声音”。浏览器要求用户手势后才能启动音频。

```bash
npm test
npm run check
npm run verify
```

## 交互

- `1`：加鸟；`2`：放障碍；`3`：拖动引导；`4`：擦除。
- 声音群按钮：选择加鸟或新增 Voice 使用的 Species。
- “新增声源”：增加一整个 Flock 和音频 Voice，最多 6 个。
- Voice 诊断：每个 Voice 显示实时输出 dB；`M` 静音，`S` 独奏，用来定位支配混音的固定声音。
- 和声按钮：目前改变世界的和声状态，尚未成为独立的 decoder pitch control。
- MIDI：授权后，Note On 会设置和声中心，Velocity 会注入能量。

## 项目状态

- 已实现：3 种 Species、3–6 实时 BRAVE Voices、Flock→4D latent 连续控制、WebSocket PCM、AudioWorklet ring buffer、buffer feedback pacing、Voice mute/solo 与模型输出电平 telemetry。
- 实时 smoke test 已证明控制改变 latent（平均 Δ=1.43）并改变新生成 PCM（RMS Δ=0.0467）；6 Voices 浏览器解码约 5.17 ms，underrun 为 0。
- 未实现：经过人工听测命名的 latent 语义、独立 decoder pitch control，以及 JUCE 内嵌 TorchScript backend。
- decoder 或连接失败时明确静音，不使用振荡器或预渲染 WAV 冒充实时模型。
- 浏览器玩法已改为 Flock=Voice 的新模型；原生世界核心仍是上一版对象级参考实现，不把它误报为新玩法的完整原生移植。
- 当前硬闸门：Web 版补跑 6 Voices / 30 分钟稳定性和人工听测；原生程序接入并测量正式 checkpoint 前保持静音，不用占位声源伪装 neural decoder。

先读 [当前声音链事实边界](docs/audio-fact-boundary.md)，再读大白话版 [产品定义与玩法](docs/product-philosophy.md)。直接试用时照着 [5 分钟体验指南](docs/mvp-test-guide.md)。技术细节见 [三条 Boids 规则](docs/rules-specification.md)，来源见 [研究依据](docs/research-foundations.md)，实现事实与训练进度见 [当前真实事实与计划](docs/current-facts-and-plan.md)。
