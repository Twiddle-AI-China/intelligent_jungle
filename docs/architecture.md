# MVP 技术架构

## 世界到声音

```text
加鸟 / 障碍 / 引导 / 擦除 / 新增声源
                    ↓
       200 Hz Boids 世界（多只 Boids）
                    ↓
      按 Flock 汇总群心、方向、速度、散布、压力
                    ↓
       每个 Flock 产生一个 Voice control frame
                    ↓
     经过安全增益的 BRAVE latent 轨迹纹理 / decoder
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

best offline BRAVE 模型先在 M4 离线编码/解码，围绕三类输入锚点生成 6 组 latent 轨迹。每组轨迹的两端使用同一个安全增益，保证峰值不超过 0.9，同时保留两端相对响度。

浏览器为每个 Flock 播放一组双端循环纹理，并按群体统计连续交叉淡化、滤波、增益和声像。它是真实模型声音材料，但不是浏览器内实时神经推理。

## 当前原生路径

best streaming TorchScript 在 M4 上平均性能足够，但 6 Voices 仍出现稀有 deadline miss。JUCE 已有后台 worker、SPSC control queue 和 audio ring 基础设施，但尚未接入新 Flock 世界与正式 decoder。原生 App 继续明确静音，直到 30 分钟 0 miss 闸门通过。

## 验证边界

- 自动测试：状态有界、编辑因果、数量预算、确定性和浏览器接入。
- 模型探针：可加载、可重复、峰值、重建与 traversal。
- 人工听测：Species 是否可区分、映射是否听得懂、动作是否可复现。

自动测试不能替代人工听测，平均延迟也不能替代硬实时稳定性。
