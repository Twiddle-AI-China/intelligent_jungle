# 三条 Boids 规则：技术规格

> 本文解释产品定义如何落到世界引擎。正式名称固定为 Cohesion / Alignment / Separation；旧称 Context Coupling、Common Motion、Niche Formation 只描述过往实现，不再作为产品或架构名称。

## 1. 共同底座

每个声音对象都有：

```text
qᵢ  可感知音乐空间中的位置
vᵢ  位置的变化速度
Nᵢ  当前局部邻居
hᵢ  对象自己的身份锚点
```

每一步只计算三种邻居力，再加用户外力与回家力：

```text
aᵢ = kc·Cohesionᵢ
   + ka·Alignmentᵢ
   + ks·Separationᵢ
   + Fuser
   + Fhome
```

节拍、调性、角色、速度上限和 latent 安全区只约束结果，不增加第四条群体规则。所有对象必须读取同一份上一时刻快照，不能边更新边影响同一帧后面的对象。

## 2. Cohesion / 聚合

```text
Cᵢ = mean(qⱼ + Δᵢⱼ) - qᵢ,  j ∈ Nᵢ
```

`Δᵢⱼ` 是稳定的声部编队偏移：bass、support、ornament 可以属于同一群体，但不需要落在同一音区、相位或音色位置。

音乐投影：

- 让节奏靠近共同 pulse，但保留切分和固定相位差；
- 让音高受同一 harmonic field 吸引，但保留声部角色；
- 不直接平均全部 latent position；
- 不强制同音、同拍或同音色。

## 3. Alignment / 对齐

```text
Aᵢ = mean(vⱼ) - vᵢ,  j ∈ Nᵢ
```

只在邻居存在可感知运动时生效：

```text
collectiveSpeed <= deadband  → 不传播，速度自然衰减
collectiveSpeed > deadband   → 对齐变化方向
```

音乐投影：

- 传播 brightness、roughness、energy 等连续变化趋势；
- 不复制绝对状态；
- 不改变 pitch/register 和节奏位置；
- 角色可有固定的幅度与 0–180 ms 响应差；
- 禁止每帧加入无状态随机噪声。

遥测必须同时记录 `collectiveSpeed` 和运动中的方向一致度。所有对象都静止时，不能报告为“高度对齐”。

## 4. Separation / 分离

先计算听觉冲突：

```text
Mᵢⱼ = wr·registerOverlap
     + ws·spectralOverlap
     + wt·onsetOverlap
     + wp·panOverlap
```

连续层按冲突梯度产生排斥：

```text
Sᵢ = -∇q Σ softBarrier(Mᵢⱼ)
```

执行纪律：

- 优先用小幅 pan、频谱和 onset 调整；
- 方向由双方位置和身份成本决定，不由当前时间或随机数决定；
- 调整方向要有迟滞，不能来回翻转；
- 只有冲突持续超过规定时间，才在拍点或小节边界改变 register；
- 离散决定保持 1–2 小节，再允许重新评估；
- 不靠整体降音量或静音解决冲突。

## 5. 用户外力

| 用户动作 | 技术作用 |
|---|---|
| 聚拢 | 在指针邻域临时提高 `kc` |
| 推开 | 在指针邻域临时提高 `ks` |
| 引导 | 向局部对象加入有界 `Fuser`，再由 Alignment 传播 |
| 扰动 | 暂时扩大自然频率和响应差，不能重定义三条规则 |
| 注入能量 | 提高能量、密度和速度预算 |
| 释放 | 将 `Fuser` 归零，保留阻尼、惯性和 `Fhome` |

## 6. 时间层级

```text
200 Hz      连续世界动力学
20–60 Hz    平滑控制帧
1/8–1/16    onset / density 决策
每拍        pitch 与节奏车道调整
每小节      register 等离散重排
```

计算可以持续，音乐决定不能每帧重做。

## 7. 当前实现差距（2026-07-14）

- JavaScript 与 C++ 已有固定步长、局部邻居、相位聚合、速度对齐、冲突检测、身份恢复和遥测。
- 当前 Cohesion 主要是相位耦合，还没有完整的带角色偏移编队。
- 当前 Alignment 会把共同静止误算为高度一致，尚缺 active-motion gate。
- 当前 Separation 仍以离散动作优先，并使用随时间变化的方向；尚未改为连续排斥加小节级决策。
- JavaScript 世界循环尚需改成统一 previous-state snapshot，与 C++ 语义对齐。

因此当前代码是规则原型，不应宣称已经完整实现本规格。

## 8. 验收条件

- Cohesion 增强共同语境，同时保留至少 60% 的初始身份距离；
- Alignment 只在真实运动中提高方向一致度，静止时单独报告 inactive；
- Separation 使 masking cost 降低至少 20%，整体 RMS 下降不超过 3 dB；
- 无输入运行时不会持续产生无原因的离散重排；
- 相同 seed、输入和时间步得到相同结果；
- 用户释放后 30 秒内回到可辨认的稳定编队。
