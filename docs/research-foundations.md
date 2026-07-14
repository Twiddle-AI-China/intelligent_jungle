# Latent Cosmos Synth：研究基础与设计推论

本文把可验证的研究命题转换成产品约束。原始产品哲学保留在 `product-philosophy.md`。

## 1. 世界是闭合的感知—动作系统

生态与具身的数字乐器研究强调：乐器更适合被理解为过程，演奏者不是操作设备的 user，而是音乐生态中的 agent。音乐经验由动作、听觉反馈、身体、技术与情境共同形成。Latent Cosmos 因而不能把视觉中的星球当作 preset；对象必须是可听见、可追踪、可影响又会反馈的持续声源。

设计推论：

- 关闭视觉后，核心行为仍应可辨认。
- 动作需要稳定方向性，具体结果由当前状态决定。
- 视觉只显示真实的节奏、身份、能量、冲突和邻域关系。
- 用户停止施力后，世界保留 15–30 秒惯性并回到可辨认吸引子。

来源：Adam Parkinson 与 Thor Magnusson, *Enacting Musical Worlds*；Rodger 等, *Ecological Perspectives in ADMI Design and Evaluation*。

## 2. 限制是乐器的形状

受约束的数字乐器实验显示，一个极简界面仍可能形成多种个人技巧；演奏者长期学习的是乐器限制所定义的可能性。Wessel、Wright 与 Schott 对 intimate musical control 的要求也同时包含初次易用、长期 virtuosity、低且稳定的延迟、清楚的动作—声音映射。

- MVP 固定为一个世界、6 个首发对象、三条规则、五种行为。
- 不提供 latent 维度、规则强度和随机度的工程滑杆。
- 同一手势必须可练习；上下文可以改变细节，不能改变行为方向。
- 增加功能前必须证明它提高组合深度、可学习性或身份表达。

来源：Gurevich 等关于 one-button instrument 的研究；Morreale 等, *Exploring the Effect of Interface Constraints*；Wessel 等, *Intimate Musical Control of Computers*。

## 3. 自组织不是随机生成

生态式作曲和 swarm music 把创作从逐事件指定转向条件设置：局部规则、吸引子、能量与环境反馈共同产生形态。复杂性来自少数规则长期作用，而不是持续注入随机事件。

- 所有自治行为必须能由确定性 seed 与事件日志重放。
- 扰动只临时提高温度；身份弹簧、节奏吸引子和资源预算负责恢复。
- 随机性只能改变细节，不得改变用户行为语义。
- 系统不生成完整段落或替用户安排宏观结构。

来源：Blackwell 与 Young, *Self-organised Music*；Reynolds, *Flocks, Herds and Schools*；NIME 2026 *Sound Swarm*。

## 4. 三条规则对应三类音乐问题

| 几何启发 | 音乐问题 | 正确类比 | 错误类比 |
|---|---|---|---|
| Cohesion | 是否属于共同语境 | 合奏中的共同拍感与调性场 | latent 坐标求平均 |
| Alignment | 是否共享表达趋势 | 不同声部共同渐强、变亮、收紧 | 所有对象变成同一音色 |
| Separation | 是否形成可追踪声部 | 编曲让位与听觉流分离 | 画面节点互相弹开 |

听觉场景分析表明，音高、频谱、起音和空间线索共同决定声音是被整合为一个流，还是被听成多个流。Separation 必须最小化掩蔽与冲突，而不是最小化二维距离。

来源：Bregman, *Auditory Scene Analysis*；Grossberg 等, *ARTSTREAM*；Goebl 与 Bishop 关于 ensemble coordination 的研究。

## 5. Neural model 的角色边界

RAVE/BRAVE 暴露连续低速 latent，并将其解码为波形，符合“decoder 是新型 oscillator”的命题。Magenta RealTime 2 生成完整的自回归音乐 token 流，适合高层共创，但会把核心因果关系从对象与规则移向模型先验。

- BRAVE 是低延迟主候选；RAVE 是质量、工具生态和 latent 操作基线。
- Magenta RT 2 只做对照与未来高层实验，不进入 MVP 发声链。
- raw latent 永不直接充当世界距离；世界只运行在经过听觉验证的 perceptual atlas 上。
- decoder 失效时明确静音，不使用传统振荡器伪装 neural audio 已接通。

来源：Caillon 与 Esling, *RAVE*；Caspe 等, *Designing Neural Synthesizers for Low-Latency Interaction*；Google DeepMind, *Magenta RealTime 2 Model Card*。

## 6. 可证伪条件

- 关闭视觉后无法分辨三条规则。
- 使用时间增加不能提高状态复现能力。
- latent 小步移动产生不可预测的身份跳变或坏点。
- 用户大部分时间等待系统生成，而不是持续施力、判断和修正。
- “分离”只能通过降低总响度或静音实现。
- 视觉关系与实际音频状态不一致。

## 参考链接

- https://arxiv.org/abs/2012.00927
- https://www.nime.org/proceedings/2020/nime2020_paper79.pdf
- https://www.nime.org/proceedings/2017/nime2017_paper0065.pdf
- https://www.nime.org/proc/nime2002_wessel/index.html
- https://www.cambridge.org/core/journals/organised-sound/article/abs/selforganisedmusic/0C90BAFB1507CF96DFC28ADC1ACF6E53
- https://pubmed.ncbi.nlm.nih.gov/15109681/
- https://arxiv.org/abs/2111.05011
- https://fcaspe.github.io/brave/
- https://huggingface.co/google/magenta-realtime-2
