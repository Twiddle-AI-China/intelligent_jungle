# 三条基础规则：可执行规格

## 公共状态

```text
identityAnchor       身份锚点（感知空间）
perceptualPosition   [brightness, roughness, noisiness, harmonicity, transientness, density]
perceptualVelocity   上述状态的变化趋势
rhythmPhase          [0, 1)
naturalRate          对象固有节奏倍率
tonalRole            bass / support / ornament
pitchClass, register 当前调性位置
energy, pan          活跃度与声像
decisionHold         让位迟滞与 cooldown
```

世界包含 `tempo`、`harmonicField[12]`、`temperature`、`ruleConfig`、`seed` 和单调模拟时间。固定步长为 1/200 秒；UI 帧率不得改变模拟结果。

## R1：语境耦合 Context Coupling

节奏使用受限 Kuramoto 型耦合：

```text
dθᵢ/dt = ωᵢ + Kθ Σⱼ wᵢⱼ sin(2π(θⱼ - θᵢ)) + Km sin(2π(θmeter - θᵢ))
```

- `wᵢⱼ` 由感知邻域和身份亲和度决定，不只由屏幕距离决定。
- 单步修正有上限；`naturalRate` 不被覆盖，允许切分、相位差和分群。
- MIDI Note On 累积为带衰减的 `harmonicField[12]`。
- bass 偏根音/五度，support 偏和弦音，ornament 可使用经过音。
- 仅在对象节奏边界重新评估音级。
- 禁止修改 perceptual position、平均 register 或强制同音。

## R2：共同趋势 Common Motion

```text
dvᵢ/dt = Ka Σⱼ wᵢⱼ (Rᵢⱼvⱼ(t - τᵢⱼ) - vᵢ) + Fuser - Ks(qᵢ - anchorᵢ)
```

- 对齐 `perceptualVelocity`，不对齐位置。
- `Rᵢⱼ` 由对象角色定义，使同一趋势产生互补结果。
- `τᵢⱼ` 为 0–180 ms 固定响应差。
- identity spring 始终存在，负责释放后 15–30 秒恢复。
- 感知维度具有速度、加速度和位置上限。
- 禁止改变 rhythm phase、pitch/register 或每帧加入无状态随机噪声。

## R3：生态位让位 Niche Formation

```text
Cᵢⱼ = wr·registerOverlap + ws·spectralOverlap + wt·onsetOverlap + wp·panOverlap
```

超过阈值且不在 cooldown 时，只选择一个最低破坏成本动作：

```text
octaveUp / octaveDown / darken / brighten / delayPhase / reduceDensity / panLeft / panRight
```

- 成本包含身份偏移、角色适配、最近移动次数和动作幅度。
- 平局按稳定 seed 排序，不按对象编号固定方向。
- 决策保持 250–800 ms，随后 cooldown 300–1200 ms。
- 一次只改变一个主要维度；能量不得低于 0.12。
- 冲突解除后缓慢返回 anchor，不立即回弹。

## 用户行为映射

| 行为 | 临时作用 |
|---|---|
| 聚拢 | 提高局部相位耦合、meter attraction 与和声保持时间 |
| 推开 | 降低冲突阈值、扩大 register/pan 动作集合 |
| 引导 | 向 Common Motion 添加有界外力 |
| 扰动 | 临时提高 temperature、自然频率偏差与响应延迟 |
| 注入能量 | 提高 energy、density 与感知速度预算 |
| 释放 | 移除用户外力，保留规则、迟滞和身份恢复 |

## 通过条件

- 聚拢提高 `phaseCoherence`，但不得长期达到 1。
- 共同趋势提高 `trendAgreement`，`identitySpread` 不低于初值 60%。
- 推开令 `maskingCost` 降低至少 20%，整体 RMS 下降不超过 3 dB。
- 释放 30 秒后 `identityDrift` 回到扰动前基线 20% 范围。
- 让位决策低于每对象每秒 2 次。
