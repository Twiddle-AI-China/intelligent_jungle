# 当前真实事实与下一步

> 快照：2026-07-14 16:12 CST。本文只写已经测到的事实。

## 已完成

### 玩法

- 世界关系已改为：Species 是神经声源身份，Flock 是一个音频 Voice，Boid 是 Voice 内的行为粒子。
- 初始 3 Species / 3 Voices / 21 Boids；最多 6 Voices，每群 2–32 Boids。
- 已实现加鸟、障碍、引导、擦除、新增声源。
- 群心、方向、速度、散布、数量和障碍压力都已形成控制状态；当前只有其中一部分真正进入 Web 声音引擎。
- 浏览器 12 项玩法测试通过；真实浏览器从 3 增到 6 Voices 时，世界与音频引擎同步为 6，控制台 0 错误。

### BRAVE Phase 1

- qgpu job 73 完成，退出码 0，耗时 9:46:47。
- 最终 checkpoint：`epoch_1000000.ckpt`，global step 1,000,000，SHA-256 `bf010bed68a5998968a6fb31151f89c6eaea36300c6926f3b20eb1979b5148fb`。
- validation 最低值 4.396111（step 639359）；最终最近值 4.419022（step 998999）。最低 validation 只用于本次 run 内选择 best，不代表听感。
- best 与 final 的 offline/streaming TorchScript 已由 qgpu job 75 成功导出。
- best offline SHA-256：`1364498ce8941d6096ecceb2ac8d90fa5cd2cb96d5ba30ff8e30549643b02978`。
- best streaming SHA-256：`36ca2bd1f3b3af1606bae36aa8889ee9c0964b11542a5e233297c584ae16d659`。

### 模型与声音材料

- 模型在 M4 成功加载：44.1 kHz、4 维 latent；固定 seed 重复解码最大误差为 0。
- 3 个 8 秒重建和 4 维 traversal 已生成。
- raw 模型部分输出峰值超过 1.0，因此 raw render safety 没通过。
- 6 组 Voice 轨迹使用“同一轨迹对统一安全增益”，12 个端点自动安全检查通过；没有用逐文件归一化破坏轨迹相对关系。
- Web MVP 已加载这 12 个真实 BRAVE 音频端点，页面显示 `BRAVE 离线纹理播放器 · 非实时 · 1364498c`。
- 浏览器循环播放并交叉淡化 WAV；不是浏览器内实时 decoder，也不是 latent 的连续在线解码。
- 素材加载失败时明确静音并显示原因，不再回退到固定 Web Audio 振荡器。
- 每个 Voice 已有实时输出 dB、mute 和 solo；端点使用 RMS 校准与等功率交叉淡化，降低原始响度差异造成的遮蔽。

### M4 性能

目标机：Apple M4、16 GB。

| 配置 | p95 解码 | 估算控制到声音 | RTF | 压力测试 |
|---|---:|---:|---:|---|
| 1 Voice，4 帧 | 1.34 ms | 12.95 ms | 0.102 | 10 秒，0 miss |
| 6 Voices，4 帧 | 4.31 ms | 15.92 ms | 0.317 | 10 秒，3 miss |
| 6 Voices，8 帧 | 3.94 ms | 27.16 ms | 0.166 | 60 秒，3 miss |

结论：平均性能和延迟预算足够，但裸 TorchScript 6-Voice 调用仍有稀有尖峰，未通过“30 分钟 0 deadline miss”原生硬实时闸门。

## 尚未成立

- 没有人工盲听，因此不能宣称模型音质、Species 区分度或 latent 方向语义通过。
- 原生 JUCE App 尚未接入新 Flock=Voice 世界；当前原生核心仍是上一版对象级参考。
- 6-Voice 原生硬实时闸门未通过。
- Web MVP 使用真实模型离线生成的安全神经纹理，不是浏览器内实时运行 TorchScript decoder。
- XY 不是 BRAVE latent 的二维降维映射；群心 X 当前控制声像，群心 Y 尚未进入声音引擎。
- 和声中心与 MIDI Note 尚未改变 BRAVE 纹理的实际音高。
- 世界会计算六维感知状态，但 roughness、noisiness、harmonicity、transientness、density 尚未完整进入 Web 音频处理。

## 下一步

1. 使用已加入的 Voice mute/solo 与输出 dB，补充基频/动态范围分析，找出并抑制固定调性成分。
2. 对 3 个 Species 和轨迹两端做盲听；不可区分的方向不命名、不进入正式 atlas。
3. 建立经过听测的 `Flock control frame → 4D latent trajectory` 映射。
4. 原生侧使用后台 decoder worker 与音频 ring buffer 接入正式模型，再重新跑 30 分钟闸门。
4. 只有完成听测后，才决定是否训练更大数据集或进入 BRAVE 后续阶段。
