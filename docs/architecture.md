# MVP 技术架构

## 世界到声音

```text
加鸟 / 障碍 / 引导 / 擦除 / 新增声源
                    ↓
       200 Hz Boids 世界（多只 Boids）
                    ↓
      按 Flock 汇总群心；检测鸟与 PULSE 波的交点
                    ↓
   XY→SVD 主方向；群体运动→次级 latent；Y→Dorian 音级
                    ↓
   BRAVE streaming decoder → pitch shift → trigger envelope
                    ↓
                 音频混合
```

## 数量层级

| 层 | 含义 | MVP 上限 |
|---|---|---:|
| Species | 神经声源身份 | 3 种内置 |
| Flock | 独立音频 Voice | 6 |
| Boid | Voice 内部控制粒子 | 每群 32 |
| Obstacle | 产生绕行压力的环境对象 | 暂无独立音频 Voice |

Boid 数量可以增加而不增加 decoder 成本。只有新增 Flock 才新增 Voice。

## 当前 Web 音频路径

本地 Python 服务加载三套 streaming TorchScript。三类语料各取 24 个分层片段，经 encoder 得到轨迹并做 SVD。前两个方向由 XY 控制，其余方向由群体运动状态轻量驱动。服务读取模型实际压缩比：BRAVE 每块 1024 samples，外部 RAVE 每块 2048 samples。随后逐 Voice 执行流式移调、PULSE 包络、电平校准和混音。

浏览器以约 30 Hz 发送控制帧，服务端返回实时生成的 stereo Float32 PCM。AudioWorklet ring buffer 播放 PCM，并把 buffer 水位与 underrun 反馈给服务端调整生成节拍。没有读取 `mvp-assets`，也没有振荡器 fallback。

XY 是乐器控制坐标，不是简单选取 raw Z0/Z1；它控制语料轨迹的两个主成分。16D 中其余可控方向由速度、聚散、对齐、避障和能量以较小幅度驱动。映射已真实驱动 decoder，但区域是否都 musical 仍需听测。

## 当前原生路径

best streaming TorchScript 在 M4 上平均性能足够，但 6 Voices 仍出现稀有 deadline miss。JUCE 已有后台 worker、SPSC control queue 和 audio ring 基础设施，但尚未接入新 Flock 世界与正式 decoder。原生 App 继续明确静音，直到 30 分钟 0 miss 闸门通过。

## 验证边界

- 自动测试：状态有界、编辑因果、数量预算、确定性和浏览器接入。
- 模型探针：可加载、可重复、峰值、重建与 traversal。
- 人工听测：Species 是否可区分、映射是否听得懂、动作是否可复现。

自动测试不能替代人工听测，平均延迟也不能替代硬实时稳定性。
