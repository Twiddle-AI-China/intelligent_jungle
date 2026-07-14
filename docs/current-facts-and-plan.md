# 当前真实事实与下一阶段计划

> 快照时间：2026-07-14 09:56 CST。训练状态会继续变化；动态事实以 Slurm、checkpoint 元数据和 TensorBoard event 为准。

## 1. 已经成立的事实

### 产品与交互

- 产品边界固定为一个世界、6 个持续声音对象、三条基础规则和五种用户行为。
- JavaScript 参考世界与 C++ 原生世界都使用 200 Hz 固定步长；浏览器帧率不决定世界结果。
- 浏览器声音是感知映射替身，不是 neural decoder。
- JUCE macOS Alpha 已接通 CoreAudio/CoreMIDI，但 `SilentDecoder` 仍明确输出静音。

### 数据与训练环境

- pilot corpus 为 3 个一小时程序化声音物种，总计 3 小时、48 kHz、mono、seed `20260714`；生成数据不进 Git。
- 官方 BRAVE 配置固定 44.1 kHz，因此模型数据库由 48 kHz corpus 重采样为 44.1 kHz。数据库元数据为 `sr=44100`、`n_seconds=10782.9754`。
- qgpu 环境为 Python 3.11.15、Torch 2.11.0+cu130；RTX 5080 CUDA 可用。
- BRAVE 和 RAVE causal 都已完成包含 sanity check、训练 batch、验证 batch 的 smoke test。这只证明工具链与显存可运行，不证明音质或实时性能。

### BRAVE job 73

- 目标：官方 `configs/brave.gin`，1,000,000 steps，batch 8，3 小时 pilot corpus。
- 2026-07-14 09:56 时状态为 `RUNNING`，已运行约 3 小时 50 分钟。
- TensorBoard 最近可读 step 为 `392299`；终端约为 epoch 1763，吞吐约 28.5 steps/s。
- `best.ckpt`：epoch 989、global step 219780、约 58.3 MB。
- 最近周期 checkpoint：epoch 1754、global step 389610、约 58.3 MB。
- validation 最低已观测值为 `4.6077804565`（step 219779）；step 389609 为 `4.6857032776`。该指标只用于同一训练内部比较，不可直接解释为听感质量。
- BRAVE 配置的 Phase 1 长度也是 1,000,000 steps；当前 checkpoint 尚处于非对抗训练阶段。不能称为完成模型。

## 2. 尚未成立的事实

- 没有 checkpoint 完成 1,000,000-step Phase 1。
- 没有将当前 checkpoint 导出为可部署 TorchScript/H5 模型。
- 没有完成重建音频、latent 连续性、坏点、身份保持或盲听评估。
- 没有在 Apple M4/16 GB 上测量 1/6 voices、采样率转换、p95 延迟、jitter 或 30 分钟 deadline miss。
- 没有神经 decoder 接入原生 App；原生程序仍应保持静音。
- 没有音乐人测试，因此不能宣称三条规则已经成为可学习的演奏技巧。

## 3. 下一阶段执行顺序

### A. Checkpoint completion and export

1. 让 job 73 完成或至少安全写出终止 checkpoint；不打断正在写入的 checkpoint。
2. 分别导出 validation 最优 checkpoint 与最终 Phase-1 checkpoint，保留训练配置和源 commit。
3. 对两者生成固定 seed 的重建与 latent traversal；结果写入忽略目录，报告记录 checkpoint SHA-256。

退出条件：至少一个真实导出模型可以重复解码，并有可追溯的报告和音频。

### B. Perceptual decoder gate

1. 运行描述符、局部连续性、路径重复性、静音/爆音/身份突变检查。
2. 建立 safe-node atlas；世界动力学只可访问通过检查的邻接边。
3. 执行 Study A 盲听，判断 brightness、roughness、harmonicity、transientness 等方向是否真的可听。

退出条件：至少 4 个方向达到预注册门槛，且不存在未隔离的灾难坏点。

### C. Target-Mac runtime gate

1. 在 M4/16 GB 上测量真实 decoder，不使用 GPU 训练速度代替。
2. 计入 44.1→48 kHz 重采样、control buffering 和音频 block 延迟。
3. 依次测 1 voice、6 voices、30 分钟连续运行；deadline miss 必须为 0。

退出条件：6 voices 的 p95 控制到声音延迟 ≤30 ms、jitter ≤5 ms、RTF <1。

### D. Native integration

1. 先实现无锁 control/audio 队列和后台 decoder worker，音频回调不得加载模型、分配内存或持锁。
2. 只有通过 C 阶段的模型才能替换 `SilentDecoder`。
3. decoder 故障、underrun 或 sample-rate mismatch 时回到明确静音并记录计数。

### E. Instrument validation

先做规则隔离 A/B，再做 5 人首轮演奏测试。若规则可测但不可听，回到映射层；若可听但不可复现，它仍是效果而不是乐器技巧。

## 4. 模型判断仍然不变

- BRAVE：低延迟主候选，但当前只有未完成的 Phase-1 checkpoint。
- RAVE causal：fallback 与质量/生态基线；目前只有 smoke test。
- Magenta RealTime 2：高层生成对照，不替代持续声音对象 decoder。

