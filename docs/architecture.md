# 单群关系音色引擎架构

```text
Pointer guide ─→ separation / alignment / cohesion ─→ one XYZ Boids flock
                                                          ↓
                                      8D whole-flock relation state
                                                          ↓
                           real corpus latent atlas → local interpolation
                                                          ↓
FSL10K RAVE 16D decoder ─→ eternal C4 carrier ─→ post pitch / velocity → PCM
MIDI / computer keyboard ────────────────────────────────↗
```

- 浏览器以固定 120 Hz 推进 18 只鸟的 XYZ Boids；Z 用大小和不透明度投影到二维画布。
- 每帧提取三维紧密、对齐、扩张、能量、XY 环流、三维湍流、边界压力和群中心深度。
- 服务端按 decoder latent frame rate，用 `latentStep` 追赶关系产生的 latent 目标。
- 每个模型从完整语料编码轨迹分层抽取最多 2048 个真实 latent 节点；8 个关系在归一化 PCA/SVD 特征中寻找四个局部邻居并插值。目标保持在真实语料节点附近，再由 `latentStep` 连续追赶，避免大倍率 SVD 外推产生离流形坏点。
- 群中心 XY 不进入声音协议，只用于画面定位和指针引导。
- 键号不进入 neural latent。decoder 输出之后按相对 C4 的半音数移调；最多三个分支共享一次 neural decode。
- 只加载 FSL10K 16D。carrier 永久打开；无按键时为 C4，松开全部按键后也回到 C4。
- Boids、关系轨迹和 neural carrier 没有生命周期，不因 note-off 重置或归位。
- 浏览器输出端提供 310 ms feedback delay 和 850 ms 短卷积混响；默认 wet mix 较低。

## 用户控制分层

```text
WORLD（间接）: 三原则 / 速度 / 空间 / 深度
                         ↓
                    XYZ 鸟群运动
                         ↓
                    8D 群体关系
                         ↓
LATENT MAP（直接作用于映射）: 探索范围 / 运动响应
                         ↓
                   Atlas → z16 → FSL10K
                         ↓
POST（不进入 latent）: Pitch Shift / Delay / Reverb
```

用户当前没有直接改变 `z₀…z₁₅` 中某个数值。世界旋钮通过鸟群关系间接改变 latent；探索范围和运动响应直接改变 latent 映射行为，但保持 Atlas 结构；键盘 pitch 与空间效果完全位于 decoder 之后。
