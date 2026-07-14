# Latent Cosmos Synth

一个把鸟群自组织变成可演奏声音控制的新乐器 MVP。仓库同时包含可快速试奏的浏览器实现、macOS JUCE 原生壳，以及 BRAVE/RAVE 模型研究流水线。

当前关系固定为：Species 是预期的神经声源身份，Flock 是一个音频 Voice，Boid 是 Voice 内的行为粒子。初始 3 Voices / 21 Boids，最多 6 Voices。当前 Web 声音是 BRAVE 离线生成的双端纹理播放器，不是实时 decoder；XY 也不是 latent space 的二维投影。

## 运行

```bash
npm run dev
```

打开 <http://localhost:4173>，点击“唤醒声音”。浏览器要求用户手势后才能启动音频。

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
- 和声按钮：目前只改变世界的和声状态，尚未改变 BRAVE 纹理的实际音高。
- MIDI：授权后，Note On 会设置和声中心，Velocity 会注入能量。

## 项目状态

- 已实现：3 种 Species、3–6 Voices、每群 2–32 Boids、障碍、引导、擦除、确定性回放、动态 BRAVE 离线纹理 Voice、MIDI 世界输入、原生壳、模型探针与硬闸门。
- 未实现：浏览器/原生实时 BRAVE decoder、经过验证的 XY→latent 投影、BRAVE 纹理音高控制，以及完整的六维感知映射。
- 素材加载失败时明确静音并显示原因；不再使用固定振荡器伪装模型声音。
- 当前纹理端点先做 RMS 校准和等功率交叉淡化，减少某个端点仅因原始响度更大而盖住其他 Voice；这不等于固定调性问题已经通过。
- 浏览器玩法已改为 Flock=Voice 的新模型；原生世界核心仍是上一版对象级参考实现，不把它误报为新玩法的完整原生移植。
- 当前硬闸门：训练并测量真实 BRAVE/RAVE checkpoint。原生程序在模型通过之前明确静音，不用占位声源伪装 neural decoder。

先读 [当前声音链事实边界](docs/audio-fact-boundary.md)，再读大白话版 [产品定义与玩法](docs/product-philosophy.md)。直接试用时照着 [5 分钟体验指南](docs/mvp-test-guide.md)。技术细节见 [三条 Boids 规则](docs/rules-specification.md)，来源见 [研究依据](docs/research-foundations.md)，实现事实与训练进度见 [当前真实事实与计划](docs/current-facts-and-plan.md)。
