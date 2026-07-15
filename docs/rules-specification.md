# Boids 三规则与声音映射规格

> 本文规定目标因果关系，不表示每条声音投影已经实现。当前可听矩阵以 [当前声音链事实边界](audio-fact-boundary.md) 为准。

## 1. 唯一关系

```text
Species（神经声源身份）
  └─ Flock（一个音频 Voice）
       └─ Boids（多个行为粒子）
```

Boids 只与附近对象互动。同群邻居参与 Cohesion 和 Alignment；所有近距离对象参与 Separation。Flock 群心 XY 控制 Species chart 的两个主要方向，群体运动状态控制次级 latent；单鸟穿过 PULSE 波产生节奏事件，纵向区域选择 Dorian 音级。

## 2. Cohesion

每只鸟朝同群邻居的局部中心转向。它解决“这一群是否仍然是一个可追踪整体”。

声音结果：Cohesion 改变群心的主要音色轨迹和群体 spread；紧密群体穿过 PULSE 时触发集中，散开群体形成 flam。

## 3. Alignment

每只鸟逐渐靠近同群邻居的平均速度方向。它解决“动作能否在群体里传播”。

声音结果：引导先改变局部速度，Alignment 把方向传给伙伴，进而改变群心音色轨迹和下一次穿越 PULSE 的时间。

## 4. Separation

任意两只鸟距离过近时互相避让，包括不同声音群之间的鸟。它解决“对象是否重叠、Voices 是否糊在一起”。

声音结果：Separation 改变群心轨迹、音高带位置和单鸟触发间距；群心 X 另外用于声像，不增加隐藏的频谱规则。

## 5. 障碍

障碍产生局部排斥场，但不被称为第四条 Boids 规则。绕行只通过改变鸟的运动路径影响音色曲面、音高带和 PULSE 触发时间。

## 6. 数量与实时预算

- 一个 Boid 只做控制计算，不实例化 decoder；
- 一个 Flock 对应一个声音 Voice；当前是纹理播放 Voice，目标才是 decoder Voice；
- 初始 3 Flocks / Voices；
- MVP 硬上限 6 Voices；
- 每群 2–32 Boids；
- 达到上限后拒绝新增 Voice，不使用隐形 voice stealing。

## 7. 固定时间层级

```text
200 Hz    Boids 世界更新
20–60 Hz  Flock 统计与声音控制平滑
音频块     当前纹理播放与混音 / 目标 decoder
```

浏览器刷新率不改变世界结果。相同 seed、编辑事件和固定步长必须得到相同结果。

## 8. 当前自动验收

- 初始 3 Species / 3 Voices / 21 Boids；
- 加鸟改变密度但不增加 Voice；
- 障碍产生可测绕行压力并改变声音控制；
- 引导改变局部方向；
- 擦除能删除鸟或障碍，并保护每群最后两只鸟；
- 新增声源最多到 6 Voices；
- 编辑会话可确定性重放；
- 所有状态在长时间运行中保持有限和有界。

自动测试证明因果链存在，不证明听感已经通过。真实 decoder 的可听差异和演奏性仍需人工测试。
