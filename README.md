# Latent Cosmos Synth

一个把鸟群自组织变成可演奏声音控制的新乐器 MVP。仓库同时包含可快速试奏的浏览器实现、macOS JUCE 原生壳，以及 BRAVE/RAVE 模型研究流水线。

当前关系固定为：Species 是神经声源身份，Flock 是一个 neural decoder Voice，Boid 是 Voice 内的行为粒子。初始 3 Voices / 21 Boids，最多 6 Voices。二维地图只负责演奏：X 是循环时间位置，Y 是 Dorian 音高，群的横向宽度给出时值。音色只来自群内、群间和障碍关系汇总成的 8D 状态，XY 不再直接进入 latent。

## 运行

```bash
# 首次安装外部 A/B 权重（模型文件被 gitignore）
cd research && ./scripts/download_model_baselines.sh && cd ..
npm run dev
```

等待三行 `Decoder ready` 后打开 <http://localhost:4173>，点击“唤醒声音”。初始三个 Voice 分别路由到 BRAVE 16D、FSL10K RAVE 16D、MRP RAVE 8D；每个 Voice 可独立换 decoder。

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
- 空间参数：巡航速度、转向力、感知/贴身/分群距离、最小群规模、Boids 三力和低频游荡。音高和时值不设直接旋钮，而由群的位置与横向宽度产生。
- 和声按钮：改变 Dorian 音高场根音；纵向区域选择音级，并在 decoder 后对 Voice 实时移调。
- MIDI：授权后，Note On 会设置和声中心，Velocity 会注入能量。

## 项目状态

- 已实现：24 个分层片段/Species 覆盖整段三小时语料，不再只编码每个文件开头 2 秒。
- 自训练 checkpoint 已导出并验真 8D / 16D / 32D。三套 streaming decoder 可同时运行并逐 Voice 路由。
- 8D 关系状态是 latent 目标的唯一世界输入；实际坐标每个 ensemble block 最多走 `latentStep`，避免突然跳点。空间分裂最多产生四个独立 note groups。
- M4 六 Voice 裸 decoder p95：BRAVE 16D 6.56 ms / 23.22 ms 音频块；FSL10K 4.10 ms / 46.44 ms；MRP 10.55 ms / 46.44 ms。
- 当前 8D 关系版三 decoder ensemble smoke：10.54 ms / 46.44 ms 音频块，latent、PCM、频谱与四 note-group 检查全部通过。
- 已实现可听的后解码实时移调与脉冲触发；未实现 pitch-conditioned BRAVE、曲面人工听测命名和 JUCE 内嵌 TorchScript backend。
- decoder 或连接失败时明确静音，不使用振荡器或预渲染 WAV 冒充实时模型。
- 浏览器玩法已改为 Flock=Voice 的新模型；原生世界核心仍是上一版对象级参考实现，不把它误报为新玩法的完整原生移植。
- 当前硬闸门：Web 版补跑 6 Voices / 30 分钟稳定性和人工听测；原生程序接入并测量正式 checkpoint 前保持静音，不用占位声源伪装 neural decoder。

先读 [当前声音链事实边界](docs/audio-fact-boundary.md)和固定的 [空间控制与声音关系契约](docs/control-relation-contract.md)，再读大白话版 [产品定义与玩法](docs/product-philosophy.md)。直接试用时照着 [5 分钟体验指南](docs/mvp-test-guide.md)。技术细节见 [三条 Boids 规则](docs/rules-specification.md)，来源见 [研究依据](docs/research-foundations.md)，实现事实与训练进度见 [当前真实事实与计划](docs/current-facts-and-plan.md)。
