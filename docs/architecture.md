# MVP 技术架构

## 世界到声音

```text
加鸟 / 障碍 / 引导 / 擦除 / 新增声源
                    ↓
       200 Hz Boids 世界（多只 Boids）
                    ↓
      按 Flock 汇总 8D 关系；建立空间连通 note groups
                    ↓
  XY→时间/音高/时值；8D 关系→SVD latent（两条独立链）
                    ↓
   每 Voice 选择 BRAVE / FSL10K / MRP → block 对齐 → ensemble mix
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

本地 Python 服务同时加载三套 streaming TorchScript。三类语料各取 24 个分层片段，经 encoder 得到轨迹并做 SVD。每个 Flock 的八种关系进入前八个 SVD 方向；16D 模型的后八维接收较弱的确定性交互项。目标 latent 不直接跳转，而按每个公共 block 的最大 step 追赶。每个 Voice 独立选择 decoder；BRAVE 的两个 1024-sample 子块与 RAVE 的一个 2048-sample 块对齐后统一混音。

浏览器以约 30 Hz 发送控制帧，服务端返回实时生成的 stereo Float32 PCM。AudioWorklet ring buffer 播放 PCM，并把 buffer 水位与 underrun 反馈给服务端调整生成节拍。没有读取 `mvp-assets`，也没有振荡器 fallback。

XY 是时间—音高演奏坐标，不是 raw Z0/Z1，也不进入 decoder。音色仅由紧密、对齐、扩张、运动能量、环流、湍流、群间压力、障碍压力驱动。映射已接入 decoder，但区域是否都 musical 仍需听测。

同一 Flock 内按空间连通距离形成 1–4 个 note groups。PULSE 扫到 group 的 X 位置时独立触发，纵向位置给出 Dorian 音级，横向宽度给出时值。复音由一次 neural decode 后的独立 pitch/envelope 分支产生，不按鸟数增加 decoder 调用。

## 当前原生路径

best streaming TorchScript 在 M4 上平均性能足够，但 6 Voices 仍出现稀有 deadline miss。JUCE 已有后台 worker、SPSC control queue 和 audio ring 基础设施，但尚未接入新 Flock 世界与正式 decoder。原生 App 继续明确静音，直到 30 分钟 0 miss 闸门通过。

## 验证边界

- 自动测试：状态有界、编辑因果、数量预算、确定性和浏览器接入。
- 模型探针：可加载、可重复、峰值、重建与 traversal。
- 人工听测：Species 是否可区分、映射是否听得懂、动作是否可复现。

自动测试不能替代人工听测，平均延迟也不能替代硬实时稳定性。
