# Latent Cosmos Synth

一个把声音对象群体自组织变成可演奏界面的新乐器 MVP。仓库同时包含可快速试奏的浏览器参考实现、macOS JUCE 原生壳，以及 BRAVE/RAVE 模型研究流水线。

产品定义已经冻结：一个声音世界、持续存在的声音对象、Boids 的 Cohesion / Alignment / Separation 三条规则，以及五种用户外力。当前版本优先验证用户能否听出三条规则、能否通过少数动作建立因果直觉、能否练习并复现结果。Web Audio 声源只是 neural decoder 接入前的可听替身，不代表最终音质。

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

- 拖动：按当前动作对声音群体施加外力。
- `1–5`：切换聚拢、推开、引导、扰动、注入能量。
- `Space`：释放外力，让世界依靠惯性继续演化。
- 和声按钮：改变所有对象感受到的和声引力中心。
- MIDI：授权后，Note On 会设置和声中心，Velocity 会注入能量。

## 项目状态

- 已实现：6 个持续声音对象、200 Hz 确定性世界模拟、三规则原型、五类外力、会话记录/回放、Web Audio 替身、MIDI、JUCE/CoreAudio/CoreMIDI 原生壳、模型探针与硬闸门。
- 待对齐：当前三规则原型还不是冻结规格的完整实现，具体差距写在规则文档中。
- 当前硬闸门：训练并测量真实 BRAVE/RAVE checkpoint。原生程序在模型通过之前明确静音，不用占位声源伪装 neural decoder。

先读大白话版 [产品定义与玩法](docs/product-philosophy.md)。技术细节见 [三条 Boids 规则](docs/rules-specification.md)，来源见 [研究依据](docs/research-foundations.md)，实现事实与训练进度见 [当前真实事实与计划](docs/current-facts-and-plan.md)。
