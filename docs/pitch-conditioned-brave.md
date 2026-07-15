# Pitch-conditioned BRAVE 研究契约

## 当前基线

本分支基于 `experiment/xy-latent-engine` 的单群 neural timbre engine，不基于 `main` 的 PULSE / Dorian / note-group 音序链。当前音高由 decoder 后的 dual-read-head pitch shifter 实现，它是 A/B baseline，不是模型原生能力。

## 条件协议 v1

Decoder 条件张量固定为 `[batch, 3, latent_frames]`：

| 通道 | 单位 | 语义 |
|---|---|---|
| `f0_hz` | Hz | 可连续的基频，支持 pitch bend；`0` 保留为 unvoiced/noise |
| `loudness` | target RMS | 声学幅度目标；MIDI velocity 只是其一种演奏意图来源 |
| `gate` | 0–1 | 音符是否打开；不用 `f0=0` 代替 |

Schema ID 为 `pitch-conditioning-v1:f0_hz,loudness,gate`。浏览器、训练管线、TorchScript 和评测报告必须使用同一 ID，不允许按位置猜测条件含义。

## 与 P-RAVE 的对齐

P-RAVE 不是把离散 MIDI note 直接拼到 latent。本项目复现的核心是：

1. 由连续 `f0` 生成 harmonic excitation，unvoiced 区域使用 noise excitation；
2. 按目标 RMS 将 loudness 注入 excitation；
3. 将 excitation 经 BRAVE 的 16-band PQMF 变换；
4. 按 generator 各层速率下采样，生成 `gamma/beta` 对 upsampling layers 做 FiLM；
5. 保持 BRAVE 的 causal buffering 与导出边界可测。

论文中的 phonetic encoder 是歌声转换增强，不属于本乐器 MVP。

## 实验顺序

### P0-A：可执行条件契约

- MIDI note/bend 生成连续 `f0_hz`；
- velocity 映射成有界 target RMS；
- gate 独立于 voiced/unvoiced；
- reference excitation 逐帧匹配目标 RMS，跨 block 保持 phase。

### P0-B：BRAVE FiLM generator

- 使用锁定的 BRAVE commit `4a5f290f` 和 `acids-rave 2.3.x`；
- FiLM 初始化为 pass-through，先证明未训练扩展不改变 baseline 尺寸和因果延迟；
- smoke run 只验证梯度、checkpoint 和 export，不声称音高可控。

当前实现进度：已建立 BRAVE `[2,2,2,1]` generator 的四个 FiLM site，
excitation 层速率为 `[2×,4×,8×,8×]`。Streaming cached-conv 模式下的
stage cumulative delay 为 `[1,3,7,7]`，条件支路按这些数值对齐。FiLM
为初始 pass-through 时，在拷贝同一 BRAVE 权重后与 baseline 逐样本相等。
这只证明结构不破坏 baseline，尚未证明训练、导出或 pitch control 成功。

### P0-C：训练与 A/B

- 同一 corpus、seed、batch 和 step budget 对比 BRAVE baseline；
- native-conditioned 与 post-shifter 使用同一 MIDI 序列；
- 测 pitch error/cents、octave errors、攻击保留、音质、render p95/jitter 和 audio block deadline misses。

### P1：descriptor disentanglement

只在 pitch-conditioned BRAVE 通过后加入 brightness/energy。Articulation 暂不用单一 gate 伪装，需单独定义 attack/release/legato 表示和评测。

## 硬闸门

- 只给 decoder 增加 pitch input 不等于 disentanglement 成功。
- 必须用 latent probe 测试 residual latent 的 F0 可预测性，并做 pitch-shuffling intervention。
- 任何条件模型若没有导出成功并在 M4 实测，不得更改当前延迟事实边界。
