# 流式设计

逐块实时推理的设计与验证。实现在 `server/backends/streaming.py`。

## 1. 为什么这个模型可以流式

上游仓库**没有** `cached_conv` / RAVE 运行时（`IMPLEMENTATION.md`：
"The decoder remains self-contained to avoid the incompatible RAVE runtime
dependency set"），所以流式包装是自己实现的。

逐模块因果性审计：

| 模块 | 时间依赖 | 流式处理 |
|------|----------|----------|
| `fusion`（静态快路径） | 与时间无关 | 每音算一次 |
| `midi.tcn`（静态快路径） | 长度 1 序列 | 每音算一次 |
| `FiLM`(z_midi, static) | 常数 gamma/beta | 无状态 |
| `excitation_film` | Conv1d k=1 逐点 | 无状态 |
| `F.interpolate(nearest, r)` | 整数倍、块对齐 | 无状态 |
| `FixedAntiAlias` | 左 pad 30 (replicate) | 缓存左 30 |
| `projections` CausalConv1d k=3 | 左 pad 2 | 缓存左 2 |
| `ResidualBlock.conv1` k=3, d∈{1,3,9} | 左 pad 2/6/18 | 缓存左 2/6/18 |
| `ResidualBlock.conv2` k=1 | 逐点 | 无状态 |
| `output` CausalConv1d k=7 | 左 pad 6 | 缓存左 6 |
| `ExcitationDownsample` stride=r, k=2r | 左 pad 2r−1 (replicate) | 缓存左 2r−1 |
| `PQMF.synthesis` conv_transpose stride=16, 257 taps | 右溢出 241 样本 | overlap-add 尾缓冲 |
| `HarmonicExcitation` | 绝对时间相位 | 记录绝对样本偏移 |
| `PQMF.analysis`（激励） | 两侧各 128（**非因果**） | 激励可解析生成，多算 128 前瞻即可 |

整条链**全部因果**。唯一的非因果点在激励的 PQMF 分析上，但激励完全由
`(note, 绝对时间)` 解析决定，可以任意提前生成——不构成流式障碍。

**根本原因：`warmup_latent_frames = 64 > 解码器感受野 55 帧。**
暖机跑满 64 帧之后，所有卷积的左侧上下文都已被真实数据填满，
此后逐块推理与整段推理在数学上等价。

## 2. 三个必须踩准的坑

### 2.1 PQMF 的 128 样本全局偏移

离线路径是 `tanh(16 * wide[128 : 128+total])`，再取 `[warmup*128 : ...]`——
也就是说从 `wide` 的第 `(warmup*128 + 128)` 个样本开始才是正式输出。
流式的 emit 流就是 `wide` 本身，所以 **warmup 必须多丢 128 个样本**：

```python
warm = (geom.warmup_latent_frames + 1) * geom.samples_per_latent
```

128 恰好是一个 latent frame，丢弃长度仍是 128 的整数倍。

> 这是流式对齐唯一的常数误差来源。漏了它，流式与离线会整体错位 128 样本——
> 波形看着都对，逐样本比对直接失败。

### 2.2 激励 RMS 归一化必须用固定标量

`HarmonicExcitation.forward` 是按**当前生成长度**算 RMS 的。逐块各算各的
会让每块增益不同 → 块边界爆音。统一复用按训练规范长度算出的
`excitation_scale`（每个 note 缓存一次）。

### 2.3 note 频率必须用 float32 的 `torch.pow`

改用 Python float64 计算的话，~1e-8 的相对差会随相位斜坡累积
（57k 样本时可达 2.7e5 rad）放大到 ~2.6e-3 rad，输出出现 1e-3 量级偏差。
**这不是「更准」，而是与 checkpoint 不一致。**

## 3. 跨块状态清单

一个声部要保持的全部状态（`_VoiceState`）：

```
midi_frame            [1,32,1]   逐音恒定，每音算一次
z_current / z_target  [1,128,1]  音色漫游的当前点与目标点
sample_pos            绝对样本位置 → 激励相位连续
frame_pos             绝对帧位置
anti_alias_cache      每 stage 一个
projection_cache      每 stage 一个
block_cache           每 stage 每 block 一个
excitation_ds_cache   每 downsampler 一个
output_cache          输出卷积左侧
ola_tail              PQMF 合成的右溢出，overlap-add 到下一块
```

**batch 尺寸不能变。**跨块状态都按 batch 尺寸分配，尺寸一变就重新分配并清零，
结果是所有声部同时被打断、一起爆一下。所以 voice 池常驻固定长度、行绑定，
不发声的声部带 `gate=0` 继续跟着跑。V1 池长 1，V2 池长 4。

## 4. 验收结果（Spark 实测）

```
[固定音色] 流式 vs 离线 max abs diff = 6.855e-07   (峰值 0.1787)
[块长  128] vs 离线 = 7.451e-07
[块长  512] vs 离线 = 6.855e-07
[块长 4096] vs 离线 = 5.811e-07
[漫游] 块边界最大跳变 0.01082 / 全局最大 0.01676 → 无台阶
块推理 p50 9.65 ms   p95 18.59 ms   预算 23.22 ms
```

* **逐样本一致性**：6.9e-07 在峰值 0.18 上 = float32 舍入量级，等价于逐比特一致。
* **块长无关性**：128/512/1024/4096 结果相同 → 跨块状态管理正确，
  不是「碰巧这个块长能对上」。这条是最能抓住状态管理错误的判据。
* **实时性**：p95 18.59 ms < 23.22 ms 预算。

复现：`.venv/bin/python -m server.backends.streaming`

## 5. 音色漫游

`decode()` 把 z_timbre 广播成常量，训练时每条音频一个固定 z。因此漫游
**按音符事件推进**，而不是单音内逐帧改。

限速取自 `assets/timbre/atlas.json` 的 `roaming.max_step_per_note`（实测标定 0.8），
在 `brave.py` 里按名义音符时长 0.5 s 换算成 `StreamingVoice` 吃的「每秒」单位。
方向保持不变、只截断步长，思路同 Latent-Cosmos 基线的 `limited_step`。

实测：锚点 0 → 4 的 z 距离 6.579，限速 1.6/秒 → **4.11 秒走完，残差精确到 0.00000**，
起止频谱余弦 0.9793（音色确实改变）。

> **自测踩坑：**第一版漫游自测只跑 1.39 秒就断言「音色几乎没变」，
> 实际连三分之一路程都没走完。任何漫游相关的测试**必须跑够走完锚点间距的时间**
> （最长约 6 秒），否则会得到假警报。自测已改为跑满 12 秒并打印残差。

## 6. 已知限制

* 池长 >1 时当前是**逐行串行前向**，CPU 开销线性增长。V2 要把 batch 维和
  声部维合并成一次前向（模型本身支持）。
* 模型没有 release 分支，松键淡出由 `brave.py` 补线性 release。
* 直流偏置 +0.0011，见 `model-notes.md` §8。
