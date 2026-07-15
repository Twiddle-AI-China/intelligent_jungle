# 单群关系 Latent Engine 开发定义

## 1. 当前声音契约

```text
18 只鸟的单群生态
        ↓
r(t) = [紧密, 对齐, 扩张, 能量, XY环流, 湍流, 边界压力, 深度Z] ∈ [-1,1]⁸
        ↓
z(t) = F(r(t)) ∈ Rᴰ，D 由 decoder 决定
        ↓
FSL10K RAVE 16D decoder
        ↓
永恒 C4 carrier + 键盘半音 pitch / velocity
        ↓
PCM
```

单群的整体状态控制 neural timbre；群中心 XY 只用于显示和引导，不进入声音协议。PULSE、Dorian 场、note groups 与群分裂复音不属于本实验。

## 2. 8D 关系如何控制真实语料 Atlas

离线把完整语料编码成 latent 云，计算：

- `anchor`：语料云中心；
- `basis`：SVD 得到的完整正交基底；
- `scale`：各方向在真实语料中的安全尺度。

SVD 外推仍作为诊断 baseline 保留，但不再是默认声音链。原因是多个关系同时取极值时，线性组合很容易落到训练数据从未出现的区域；这会产生错误 repitch、过短事件和噪声坏点，而不是有价值的“神经新声音”。

默认链从完整语料轨迹分层抽取最多 2048 个 encoder 真实 latent 节点，并记录每个节点的前 8 个归一化 SVD 特征。当前关系状态形成查询点：

```text
query = tanh(1.35 × relations) × atlasExplorationRange
```

查询最近的四个真实节点，用距离倒数平方做局部插值：

```text
neighbors = kNN(atlasFeatures, query, k=4)
z = weightedMean(atlasLatents[neighbors])
```

因此 decoder 每帧仍收到完整 16D，但目标位于真实 encoder 节点的局部邻域。系统仍只有 8 个生态描述自由度；“输出 16D”不等于拥有 16 个独立生态控制量。

`Atlas 探索半径` 默认 `1.25×`、范围 `0.25×–6×`。现在它扩大的是 Atlas 查询范围，而不是把 latent 数值无限外推；更大的值会选择真实语料中更极端的节点，但不会凭空创造训练集没有的声音类别。

真正的运动速度由 `生态时间倍率` 控制，默认 `1.5×`、范围 `0.25×–4×`：它加快 Boids、关系状态和 latent 目标随时间的演化。`latentStep` 默认 `0.2`，只是 decoder 每 latent frame 追赶目标的最大距离。三者必须分开理解：

```text
生态时间倍率 = 世界与关系变化多快
timbreRange   = 离 anchor 能走多远
latentStep    = decoder 追赶目标多快/是否被限速
```

相较“群中心 XY → 二维 SVD 平面”，这条链保留了更多群体信息。同一个群中心下，只要紧密度、朝向、扩张、旋转等不同，声音仍可不同。

## 3. XYZ 空间与八种整体关系

Boids 的邻居距离、三原则、速度、扩张和湍流均在 XYZ 三维计算，不是单纯视觉假深度。画布显示 XY 投影，Z 越接近观察者，鸟越大、越不透明。界面只保留六个运动控制：聚合、对齐、分离、速度、空间（邻域尺度）与深度（Z 航程）。

| 关系 | 来源 | 含义 |
|---|---|---|
| 紧密 | 鸟到群中心的平均距离 | 聚拢或松散 |
| 对齐 | 平均速度方向一致度 | 是否共同朝向 |
| 扩张 | 径向速度 | 向外分裂或向内收缩 |
| 能量 | 平均速度 | 整体运动强度 |
| 环流 | 径向向量与速度叉积 | 围绕中心旋转 |
| 湍流 | 个体速度相对群平均速度的偏差 | 局部不一致性 |
| 边界压力 | 靠近画布边界的比例 | 生态受空间约束程度 |
| 深度 Z | 三维群中心 Z | 鸟群整体远近位置 |

这些是可测生态量，不宣称等于 brightness、roughness 等固定声学轴。它们只是进入语料 latent 基底的控制源，仍需人工听测命名。

## 4. 音高为什么独立

RAVE/BRAVE latent 为了重建波形，本身隐式包含基频、谐波、谱色、包络、响度和纹理；当前自训练语料中的 `pulse`、`resonance` 也覆盖连续基频。因此只移动 latent 很可能同时改变音高和音色，而且没有某一维被证明稳定等于 F0。

为了把实验重点放在“鸟群关系是否形成有趣且连续的音色引擎”，当前采用独立音高链，并支持三音复音：

- 电脑键盘 `A W S E D F T G Y H U J K` = MIDI 60–72 / C4–C5；
- MIDI note 相对 C4 转成 `[-12,+12]` 半音；
- 半音值不进入 neural latent；
- decoder 后使用低延迟双读头 pitch shifter；
- velocity 控制强弱；note-on/off 只加入或移除 pitch 分支，不关闭 neural carrier；
- 最多三个 held notes 共享同一次 neural decode，各自进入独立 pitch-shifter 与 envelope，因此是同一 neural timbre 的三音和弦；
- 无按键时 carrier 为 C4；全部松键后平滑回到 C4。

这条 pitch 链容易控制，但可能产生 pitch-shift 伪影。它是实验隔离手段，不代表最终模型不需要 pitch conditioning。

## 5. 永恒 carrier 与 Boids

```text
start engine → attack → eternal FSL10K carrier + eternal Boids exploration
                              ↕
                    temporary keyboard pitches
```

当前没有鸟或 Voice 的自动 birth/death，也没有 `maxDurationSeconds`。启动后，FSL10K decoder、C4 carrier、18 只鸟及其关系轨迹持续运行；note-off 不静音、不重置 seed、不把鸟群送回起点。固定 seed 只保证页面初次载入的起点一致，之后生态连续演化。

浏览器输出链增加两个低成本空间效果：固定 310 ms、28% feedback 的 delay，以及 850 ms 的短卷积 reverb。界面只控制各自 wet mix；二者默认保持较低比例，不参与 latent，也不用于掩盖 decoder 原声质量问题。

Decoder 在连接期间一直计算连续 PCM，carrier gate 始终打开。仍可能听到的事件式起止来自 FSL10K 训练语料内含的包络、latent 区域切换，以及 pitch-shifter 对瞬态时间结构的改变，不是生命周期自动重触发。

### M4 复音预算

2026-07-15 对 BRAVE 16D streaming、8 latent frames、120 次裸 decoder 测量：

| Neural Voices | p95 | 23.22 ms block 占比 |
|---:|---:|---:|
| 3 | 2.56 ms | 11% |
| 6 | 4.60 ms | 20% |
| 8 | 5.16 ms | 22% |
| 12 | 9.25 ms | 40% |
| 16 | 80.56 ms | 347%，失败 |

12 是本次短测仍低于 deadline 的最高点，不等于长稳态承诺；16 已明确失败。当前三音方案只做一次 neural decode 加三个便宜的后处理分支，余量远大于三个独立 neural Voices。产品默认 3 音，未来要承诺 8–12 neural Voices 仍需 30 分钟压力测试。

## 6. 当前边界与验收

已实现：单群 Boids 三原则、8D 整体关系、真实语料 Atlas 到 FSL10K 16D、latent step、独立键盘/MIDI pitch、velocity、永恒 carrier、实时 PCM 与诊断。

明确没有：多 flock、PULSE、Dorian 音高场、note groups、按群分裂的复音、关系名称到感知音色的未经听测宣称。

验收重点：

- 三原则改变关系状态，关系状态改变完整 latent 与 PCM；
- 同群中心不同群形仍产生不同关系与声音；
- 同一关系状态下换键只改变后解码 pitch，不改变 latent；
- note-off 后正确回到持续 C4，Boids 与 latent 轨迹不中断；
- FSL10K 实时渲染小于 audio block 时长；
- 人工听测关系变化是否连续、丰富、可记忆。
