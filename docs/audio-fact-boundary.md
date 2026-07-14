# 当前声音链事实边界

> 更新于 2026-07-14。本文件是当前声音实现的 truth source；产品哲学描述目标，不能替代这里的实现事实。

## 一句话结论

当前 Web MVP 是“Boids 控制的 BRAVE 离线神经纹理播放器”，不是 BRAVE 实时 decoder 乐器，也没有把画面 XY 作为 latent space 的二维投影。

## 已经成立

- BRAVE Phase-1 模型真实完成训练和 TorchScript 导出；模型为 44.1 kHz、4 维 latent。
- 12 个 8 秒 WAV 来自真实 BRAVE 编码、latent traversal 和离线解码，不是传统振荡器伪造。
- 浏览器按 Flock 播放一对 low/high WAV，并控制交叉淡化、滤波、增益、播放速率和声像。
- 鸟群群心 X 会改变声像；平均水平方向会改变 brightness；速度、数量和 pulse 会影响增益与节奏。
- 素材加载失败时现在明确静音并显示错误，不再偷偷回退到固定音振荡器。
- 每个 Voice 现在提供真实输出 dB、mute 和 solo；纹理端点使用有上限的 RMS 校准与等功率交叉淡化，先解决端点响度差异造成的遮蔽。

## 尚未成立

- 浏览器或 JUCE 内没有正式连接正在运行的 BRAVE decoder。
- `DecoderAdapter` 仍是空接口，原生生产 App 仍使用 `SilentDecoder`。
- XY 不是从 BRAVE latent 学出的 UMAP、PCA、VAE 子空间或感知流形。
- 群心 Y 当前没有直接进入 Web 声音引擎。
- roughness、noisiness、harmonicity、transientness、density 虽在世界状态中计算，但没有完整映射到 Web 音频处理。
- 和声中心与 MIDI Note 没有改变 BRAVE 纹理的实际音高；它们目前只改变世界状态。
- low/high 之间是两个解码 WAV 的波形交叉淡化，不是逐帧 latent 插值后实时解码。
- 没有通过人工听测，不能宣称三种 Species、latent 方向或动作—声音关系已经可辨识。
- BRAVE 离线纹理自身仍含稳定调性成分；删除 fallback 不等于这些素材已经去调性或完成频谱编排。

## 当前可听控制矩阵

| 世界信号 | 当前 Web 声音作用 | 状态 |
|---|---|---|
| 群心 X | stereo pan | 已接入 |
| 群心 Y | 无 | 未接入 |
| 平均水平运动方向 | brightness 目标，进而控制纹理交叉淡化与低通 | 部分接入 |
| brightness 变化速度 | 小范围 playbackRate | 部分接入 |
| 平均速度、鸟数、pulse | 增益、脉冲速率 | 部分接入 |
| 障碍压力 | 先改变运动与 pulse 衰减，再间接影响声音 | 间接接入 |
| roughness / noisiness / harmonicity / transientness / density | 当前只存在于控制状态 | 未完整接入 |
| 和声中心 / MIDI Note | BRAVE 纹理音高无变化 | 未接入 |

## 下一阶段通过条件

1. 已完成 Voice mute/solo 与实时输出 RMS；下一步补充稳健基频和动态范围报告。
2. 根据独奏测量移除或抑制支配混音的固定调性成分，三种 Species 在盲听中可区分。
3. 建立经过听测的 `Flock control frame → 4D latent trajectory` 映射。
4. BRAVE decoder 只在后台 worker 运行，通过 ring buffer 向音频线程供给声音。
5. UI 必须显示 `离线纹理`、`实时 decoder`、`加载失败静音` 三种互斥状态。
6. 重新通过 6 Voices、30 分钟、0 deadline miss 硬闸门后，才可以把引擎标为“实时”。
