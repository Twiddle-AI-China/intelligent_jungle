# Latent Cosmos Synth

一个把鸟群自组织变成可演奏声音控制的新乐器 MVP。仓库同时包含可快速试奏的浏览器实现、macOS JUCE 原生壳，以及 BRAVE/RAVE 模型研究流水线。

当前关系固定为：Species 是神经声源身份，Flock 是一个 BRAVE decoder Voice，Boid 是声音空间里的行为粒子。初始 3 Voices / 21 Boids，最多 6 Voices。每个 Species 从真实 checkpoint 编码轨迹计算一张 2D→4D latent 曲面；群心 XY 在曲面上控制音色。纵向 Dorian 音级带控制移调，可见 PULSE 扫描线穿过鸟时触发 Voice 包络。

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
- 和声按钮：改变 Dorian 音高场根音；纵向区域选择音级，并在 decoder 后对 Voice 实时移调。
- MIDI：授权后，Note On 会设置和声中心，Velocity 会注入能量。

## 项目状态

- 已实现：3 种 Species、3–6 实时 BRAVE Voices、Boids XY/速度→4D latent 直接控制、WebSocket PCM、AudioWorklet ring buffer、buffer feedback pacing、Voice mute/solo 与模型输出电平 telemetry。
- checkpoint 曲面 smoke test：latent 平均 Δ=3.71、PCM RMS Δ=0.0209、频谱对数距离=0.79；真实浏览器 6 Voices 完整渲染约 8.27 ms，underrun=0。
- 已实现可听的后解码实时移调与脉冲触发；未实现 pitch-conditioned BRAVE、曲面人工听测命名和 JUCE 内嵌 TorchScript backend。
- decoder 或连接失败时明确静音，不使用振荡器或预渲染 WAV 冒充实时模型。
- 浏览器玩法已改为 Flock=Voice 的新模型；原生世界核心仍是上一版对象级参考实现，不把它误报为新玩法的完整原生移植。
- 当前硬闸门：Web 版补跑 6 Voices / 30 分钟稳定性和人工听测；原生程序接入并测量正式 checkpoint 前保持静音，不用占位声源伪装 neural decoder。

先读 [当前声音链事实边界](docs/audio-fact-boundary.md)，再读大白话版 [产品定义与玩法](docs/product-philosophy.md)。直接试用时照着 [5 分钟体验指南](docs/mvp-test-guide.md)。技术细节见 [三条 Boids 规则](docs/rules-specification.md)，来源见 [研究依据](docs/research-foundations.md)，实现事实与训练进度见 [当前真实事实与计划](docs/current-facts-and-plan.md)。
