# Latent Cosmos Synth

一个把鸟群自组织变成可演奏声音控制的新乐器 MVP。仓库同时包含可快速试奏的浏览器实现、macOS JUCE 原生壳，以及 BRAVE/RAVE 模型研究流水线。

当前关系固定为：Species 是神经声源身份，Flock 是一个音频 Voice，Boid 是 Voice 内的行为粒子。初始 3 Voices / 21 Boids，最多 6 Voices。用户通过加鸟、放障碍、引导、擦除和新增声源改变世界；页面会明确标出使用 BRAVE 神经声音还是 Web Audio 替身声源。

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
- 和声按钮：改变所有对象感受到的和声引力中心。
- MIDI：授权后，Note On 会设置和声中心，Velocity 会注入能量。

## 项目状态

- 已实现：3 种 Species、3–6 Voices、每群 2–32 Boids、障碍、引导、擦除、确定性回放、动态音频 Voice、Web Audio/BRAVE 纹理双声源、MIDI、原生壳、模型探针与硬闸门。
- 浏览器玩法已改为 Flock=Voice 的新模型；原生世界核心仍是上一版对象级参考实现，不把它误报为新玩法的完整原生移植。
- 当前硬闸门：训练并测量真实 BRAVE/RAVE checkpoint。原生程序在模型通过之前明确静音，不用占位声源伪装 neural decoder。

先读大白话版 [产品定义与玩法](docs/product-philosophy.md)。直接试用时照着 [5 分钟体验指南](docs/mvp-test-guide.md)。技术细节见 [三条 Boids 规则](docs/rules-specification.md)，来源见 [研究依据](docs/research-foundations.md)，实现事实与训练进度见 [当前真实事实与计划](docs/current-facts-and-plan.md)。
