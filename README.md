# Latent Cosmos Synth

一个把声音对象群体自组织变成可演奏界面的新乐器 MVP。仓库同时包含可快速试奏的浏览器参考实现、macOS JUCE 原生壳，以及 BRAVE/RAVE 模型研究流水线。

当前版本优先验证三件事：用户能否听出聚合、对齐、分离；能否通过少数动作建立因果直觉；停止输入后世界能否继续自组织。Web Audio 声源是 neural decoder 接入前的可感知映射替身，不代表最终音质方案。

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

- 拖动：按当前行为对声音群体施加外力。
- `1–5`：切换聚拢、推开、引导、扰动、注入能量。
- `Space`：释放外力，让世界依靠惯性继续演化。
- 和声按钮：改变所有对象感受到的和声引力中心。
- MIDI：授权后，Note On 会设置和声中心，Velocity 会注入能量。

## 项目状态

- 已实现：6 个持续声音对象、200 Hz 确定性世界模拟、三条规则的固定职责、五类外力、会话记录/回放、Web Audio 感知替身、MIDI、JUCE/CoreAudio/CoreMIDI 原生壳、模型探针与硬闸门。
- 当前硬闸门：训练并测量真实 BRAVE/RAVE checkpoint。原生程序在模型通过之前明确静音，不用占位声源伪装 neural decoder。

上位约束见 [docs/product-philosophy.md](docs/product-philosophy.md)。经过考证的来源见 [docs/research-foundations.md](docs/research-foundations.md)，三条规则正式规格见 [docs/rules-specification.md](docs/rules-specification.md)，阶段闸门见 [docs/development-roadmap.md](docs/development-roadmap.md)，实现事实见 [docs/implementation-status.md](docs/implementation-status.md)，带时间戳的训练事实与下一阶段执行顺序见 [docs/current-facts-and-plan.md](docs/current-facts-and-plan.md)。
