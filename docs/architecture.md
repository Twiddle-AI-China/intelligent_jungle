# MVP 技术架构与验证闸门

## 双参考实现

```text
Trackpad / MIDI
        ↓
世界行为（聚拢、推开、引导、扰动、注入能量）
        ↓
6 个持续身份 + 200 Hz 固定步长世界
        ↓
Perceptual Control Frame（20–60 Hz）
        ↓
受验证的映射 / BRAVE 或 RAVE decoder
        ↓
CoreAudio 输出
```

`src/world.js` 是便于快速实验与浏览器回放的规范参考；`native/src/WorldEngine.cpp` 是原生实时实现。二者均不依赖 decoder。`src/audio-engine.js` 是可听的感知映射替身；原生 `SilentDecoder` 在真实模型通过闸门前只输出静音，并显式报告离线状态。

## 状态与规则职责

| 层 | 状态 | 可修改它的核心规则 |
|---|---|---|
| 音乐语境 | `phase`, `harmonicCenter`, `pitchClass` | Context Coupling |
| 变化趋势 | perceptual velocity、energy velocity | Common Motion |
| 编曲让位 | register、brightness、pan | Niche Formation |
| 用户外力 | 屏幕位置、拖动向量、速度、MIDI note/velocity | 五种世界行为 |

屏幕位置在当前 MVP 中兼任二维感知音色位置；它不是 neural decoder 的原始 latent。视觉节点、声像、明亮度、音高与能量均来自真实世界状态，不存在独立的装饰性星系模拟。

## DecoderAdapter 接入闸门

在接入模型前，先用离线探针回答：

1. 固定锚点周围的小步移动是否连续；
2. 同一路径重复渲染是否稳定；
3. 路径上是否有静音、爆音、失真或身份突变坏点；
4. brightness / roughness / harmonicity 等方向能否由听者一致辨认；
5. 在目标设备上，单对象与 6 对象渲染的延迟预算是多少。

只有通过探针的区域才能进入可演奏地图。建议 `DecoderAdapter` 接收 20–60 Hz 的可解释 control frame，由 mapping network 转换到经过约束的 raw latent，再以分块、交叠和限幅方式产生音频。浏览器实时模型不是默认前提；准实时预渲染纹理池也可用于第一轮听测。

## 第一轮实验

每位测试者进行 10–15 分钟、无需说明书的任务：

- 让世界“更整齐”；
- 让声部“更分开”；
- 制造一次变化后让它恢复；
- 两次复现接近的状态；
- 自由演奏两段明显不同的 30 秒结果。

记录：完成率、第一次正确动作所需时间、复现状态的指标距离、持续主动操作占比，以及主观的因果清晰度（1–7）。世界信号只用于研发记录，不应演变成演出界面的工程参数面板。

可执行协议与记录表位于 `studies/`。任何规则方向在开发者知情条件下的主观判断，都不能替代随机化的隔离 A/B 与复现任务。

## 下一步优先级

1. 录制三条规则的隔离 A/B 音频，确认方向可听；
2. 在 RTX 5080 上训练同语料 BRAVE/RAVE 基线并运行硬闸门；
3. 用安全图谱限制可演奏区域，测量坏点与方向一致性；
4. 依据真实推理延迟选择实时、准实时或纹理池策略；
5. 完成首轮 5 人可用性听测后再讨论硬件与完整视觉。
