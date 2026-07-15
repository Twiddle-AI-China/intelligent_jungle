# Boids 三规则与声音映射规格

> 本文规定目标因果关系，不表示每条声音投影已经实现。当前可听矩阵以 [当前声音链事实边界](audio-fact-boundary.md) 为准。

## 1. 唯一关系

```text
Species（神经声源身份）
  └─ Flock（一个音频 Voice）
       └─ Boids（多个行为粒子）
```

Boids 只与附近对象互动。同群邻居参与 Cohesion 和 Alignment；所有近距离对象参与 Separation。Flock 只汇总群心 XY 和平均速度 VX/VY，四个数直接控制 BRAVE 4D latent。

## 2. Cohesion

每只鸟朝同群邻居的局部中心转向。它解决“这一群是否仍然是一个可追踪整体”。

声音结果：Cohesion 改变群心轨迹，因此直接改变 Z0/Z1；不额外添加“聚合度→音色参数”的规则。

## 3. Alignment

每只鸟逐渐靠近同群邻居的平均速度方向。它解决“动作能否在群体里传播”。

声音结果：平均 VX/VY 直接控制 Z2/Z3。引导动作先改变局部速度，Alignment 再把该变化传给同群伙伴。

## 4. Separation

任意两只鸟距离过近时互相避让，包括不同声音群之间的鸟。它解决“对象是否重叠、Voices 是否糊在一起”。

声音结果：Separation 改变鸟的位置与速度，并通过同一个 XY/VX/VY 映射进入 decoder；群心 X 另外用于声像，不增加隐藏的频谱规则。

## 5. 障碍

障碍产生局部排斥场，但不被称为第四条 Boids 规则。绕行只通过改变鸟的 XY/VX/VY 影响 latent，不额外映射粗糙度或瞬态。

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
