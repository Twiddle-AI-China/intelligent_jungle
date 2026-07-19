# midiBrave 模型接入笔记

本文记录**实测确认**的事实。凡与设计文档冲突处，以这里为准并已标注。

## 1. 权重与源码

| 项 | 值 |
|---|---|
| checkpoint | `/data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt`（Spark，**只读**） |
| 大小 | 96 MB，2026-07-20 00:01 由 jyhu 同步 |
| 格式 | **state_dict，不是 TorchScript** —— 必须配模型类才能加载 |
| 源码 | Octopus `/home/jyhu/MidiBrave/`，rolf 可直接读，**不需要 sudo、不需要 docker** |
| config | `configs/full_c9_optimized.yaml`（**不是**交接文档写的 quality150） |

`/home/jyhu` 本身不可列（`ls` 报权限不够），但有 traverse 权限——知道确切路径就能进。

Mac 直连 Octopus 超时，须经 Spark 跳：

```bash
ssh -o ProxyJump=rolf@192.168.9.140 -p 2222 rolf@58.216.118.227
```

> **连接踩坑：** Mac → Spark **公钥认证是通的**，直接 `ssh rolf@192.168.9.140` 即可。
> 不要用 `expect` 强制密码认证——频繁密码登录会触发 sshd 限速，表现为
> 连上了、提示输密码、然后无限挂起，很容易误判成服务器故障。

## 2. checkpoint 元数据

```
format=3  phase=1  step=75364  generator_updates=75365
discriminator_updates=0  world_size=8  epoch=5
config_hash=8f43c6ec…  manifest_hash=043d5f43…
model: 141 tensors / 8.00M 参数
```

**`discriminator_updates=0` → Phase 1 only，对抗微调一步没跑。**音质是 Phase 1 水平，
偏糊、高频欠缺。这不是 bug，是 checkpoint 本身的状态。

## 3. 架构

```
timbre.net       LayerNorm(512) → Linear(512,256) → SiLU → Linear(256,128) → Tanh
midi.note        (128,16)  note embedding
midi.continuous  2 → 32 → 16
midi.tcn         Conv1d(32,32,k=3) ×3   因果 TCN → z_midi 32D
decoder.fusion   Conv1x1(160 → 1024)    160 = 128 z_timbre + 32 z_midi
decoder.blocks   每 block 两路 FiLM: film(32→2C) + excitation_film(16→2C)
excitation / pqmf / pitch_adversary
```

**更正：**

* 方案A 文档写 `z_midi` 是 64D，**实际是 32D**（fusion 输入 160 = 128+32）。
* `timbre.net` 的 LayerNorm 在**输入端**，不在末端；末端是 Tanh。
* `.0` 是 **LayerNorm 不是 BatchNorm**（源码 + state_dict 无 running stats，双重确认）。

## 4. 条件接口 —— 比预想的简单得多

**模型的全部条件只有 `(z_timbre 128D, note, velocity)` 三项。**

没有 gate、onset_pulse、offset_pulse、pitch_bend、legato、ADSR、release。
上游 `IMPLEMENTATION.md` 原话："The neural decoder has no gate, pitch bend, ADSR,
onset/offset, legato, release" —— host 负责演奏包络。

**时长不是网络输入**，而是「跑多少个 latent frame」决定的。解码器是全卷积因果网络，
可以跑任意长度。

`static_condition_fast_path=True` 时 MIDI 条件在时间轴上恒定，FiLM 系数是常数。

> 这一条推翻了立项时的最大风险判断。原本担心「MIDI 事件 → 逐帧条件张量」的构造
> 有大量能悄悄写错的地方（onset pulse 占几帧、release 期间保不保留 note、
> velocity 归一化分母……），实际上这些字段根本不存在。

## 5. 时间轴几何

| 量 | 值 |
|---|---|
| 采样率 | 44 100 Hz mono |
| PQMF bands | 16 |
| ratios | 累积 8 |
| samples_per_latent | 16 × 8 = **128**（≈ 2.902 ms） |
| warmup_latent_frames | **64** |
| 解码器感受野 | 55 帧 |
| PQMF taps | 256（合成有 128 样本全局偏移） |

**`warmup(64) > 感受野(55)` 是流式成立的根本原因**：暖机之后逐块流式与离线
一次性渲染在数值上等价。详见 `streaming-design.md`。

## 6. 训练数据边界（硬约束）

| 项 | 值 |
|---|---|
| 语料 | Serum，1 402 preset / 75 362 train 样本 |
| **note 范围** | **21–109**（交接文档写的 31–95 是错的） |
| **velocity** | **只有 {50, 127} 两档** |
| 输出 | 44.1 kHz mono float |

velocity 中间值是分布外，**绝不插值**：落到最近的档，档内差异用 ≤±6 dB 增益补。
实现见 `server/backends/brave.py::_quantize_velocity`。

## 7. 实测性能（Spark，20 核 ARM，CPU）

| 指标 | 结果 |
|---|---|
| 块推理 p50 | **9.65 ms** |
| 块推理 p95 | **18.59 ms** |
| 预算（1024 样本 @44.1k） | 23.22 ms |
| 服务常驻内存 | 694 MiB（预算 4096 MiB） |

实时有余量。注意 8081 的 vLLM 也在同一台机器上，`torch.set_num_threads` 已限到 8。

## 8. 已知问题

* **直流偏置 +0.0011（约 −59 dBFS）。**端到端验收唯一未过项。听不见，但吃余量、
  音符边界可能有轻微咔哒。修法是加一级 ~20 Hz 高通 DC blocker；未做，因为它会改变
  与离线渲染的逐样本等价性，需要先想清楚放在哪一层。
* **音色变化是细的。**漫游起止频谱余弦 0.9793。与 atlas 测出的「z 有效维度仅
  2.6/128、PC1 独占 60.6%」一致——模型音色空间本身自由度就不多。
* Phase 1 音质上限（见 §2）。
