# P0-C1b：真实语料审计与最小 pitch×timbre pilot

## 结论

当前验证不需要重新渲染大 corpus。5080 已经有完整的 Dexed 多音高受控渲染，
Spark 已有带音符标签的 NSynth、TinySOL 和 UIowa。P0-C2 应使用一个小型、受控、
可过拟合的 Dexed pilot 来验证 decoder 是否真正使用 pitch condition；这和追求
泛化音质的正式训练集是两个阶段。

## 数据盘点

### 5080

| 数据 | 规模 | pitch 情况 | 用途 |
|---|---:|---|---|
| `data/corpus/v1` | 3 × 3600 秒 | 程序音频，无同音色多 pitch 配对 | 原 BRAVE baseline |
| `dexed_renders/48k_mono` | 9,761 × 5 秒 | 全部 MIDI 60 / velocity 108 | timbre 特征与初筛 |
| `dexed_renders/spinvae_16k` | 58,566 WAV，15 GB | 每 preset 6 条受控条件 | **P0-C2 pilot 来源** |

`spinvae_16k` 已完整覆盖 9,761 个 preset：

```text
pitch：   note 41 / 48 / 56 / 63，velocity 75
velocity：note 56，velocity 25 / 75 / 127
时序：    0–3 秒 note-on，3–4 秒 release
格式：    16 kHz mono float32，4 秒
```

因此无需重新调用 Dexed renderer，只需选择、验证并在预处理时重采样到 44.1 kHz。

### Spark

Spark 的 `/data/datasets/d-pretrain` 约 759 GB，其中适合本阶段的带 pitch 真值数据：

| 数据集 | 文件数 | 规模 | 标签特点 |
|---|---:|---:|---|
| NSynth | 305,983 | 38 GB | 文件名含 instrument / MIDI note / velocity |
| TinySOL | 2,914 | 1.7 GB | 文件名含乐器、奏法、音名、力度 |
| UIowa MIS | 2,373 | 2.2 GB | 文件名含乐器、力度和音名 |
| Philharmonia | 14,374 | 335 MB | 文件名含乐器、音名、时值和力度 |

本 checkpoint 只抽 NSynth 12 条和 TinySOL 12 条，覆盖协议音域 MIDI 36–84，
不复制源数据。

## 真实样本 pYIN 审计

工具对每条音频重采样到 44.1 kHz，只评估中央 50% 的稳定段，并同时记录
128-sample RMS gate 和 2048-sample RMS gate。抽样按 dataset → family → register
轮转，seed 固定为 `20260716`。

### TinySOL

- 12/12 条中央段有 pitch；
- clip median absolute cents 的中位数为约 5 cents；
- clip P95 的跨样本 P95 约 15 cents；
- 当前样本上未观察到 gross/octave error。

这证明 pYIN 对干净、持续、声学单音是可用候选。

### NSynth

- 12 条中 10 条中央段检出 pitch；
- 多数稳定样本约 5–25 cents；
- flute/organ/部分 synthetic bass 出现整八度或更大错误，另有两条几乎无可靠 pitch；
- 跨 clip 的尾部误差仍超过 2000 cents。

所以 pYIN 不能无筛选地给混合真实 corpus 自动贴标签。未来无标签语料必须结合
voiced probability、跨帧稳定性、音域约束和人工抽查；必要时比较 PESTO/CREPE。

### Gate

固定 `RMS > 0.02` 在 TinySOL 大量失效，部分干净有声音的样本仍因原始电平较低而
整段 gate 关闭。把窗口从 128 samples 放大到 2048 samples 只能缓解低频相位波动，
不能解决绝对电平差异。

同时，RAVE 当前 dataset 配置默认 `normalize=False`，且 batch transform 包含随机
phase mangle。正式预计算标签不能继续在 transform 后临时估计：要么关闭会破坏
label alignment 的 augmentation，要么让 dataset 同时读取并同步裁切预计算标签。

## Dexed pilot 标签策略

Dexed pilot 不使用 pYIN/RMS 猜 `f0` 和 gate，因为渲染事件本身就是真值：

```text
f0       = MIDI note 对应频率 × 已验证的 preset 整数八度偏移
gate     = 1 on [0s, 3s), 0 on [3s, 4s]
loudness = 从实际波形测量，保留不同 preset/velocity 的真实响应
```

单点 MIDI 60 音高稳定不等于 preset 会正常跟踪键盘。选择器先从 9,761 个 preset 中
按 QC、f0 stability、noisiness 和 10 维 timbre feature 筛出 6,457 个候选，再用
farthest-point sampling 选 24 个。随后必须用四个 pitch render 检查音程跟踪，剔除
固定频率 operator、效果音和异常转调 preset。

5080 qgpu job 84 已完成 24 × 6 = 144 条全量审计。硬门槛为四个 pitch condition
全部存在、中央段 voiced ratio ≥0.80、median error ≤50 cents、P95 ≤75 cents。
最终 8/24 个 preset 通过：

| preset index | name | MIDI 60 observed f0 |
|---:|---|---:|
| 63836 | BrightPad6 | 261.62 Hz |
| 1580 | brassy:1` | 262.45 Hz |
| 49633 | SynLead.02 | 261.65 Hz |
| 21385 | PERC BELL | 261.79 Hz |
| 49984 | SteelDrm.A | 261.83 Hz |
| 12816 | Perky 04 | 1044.81 Hz |
| 36905 | PRIML WOOD | 523.30 Hz |
| 52404 | Vibe.06 | 262.30 Hz |

这 8 个 preset 的 32 个 pitch clips 中，最差 clip median 为 35.00 cents，最差
clip P95 为 75.00 cents，最低 voiced ratio 为 0.809。另 16 个被剔除，证明单点
特征初筛不能替代多音高 intervention 检查。

## 数据量决策

```text
标注器真实审计：24 clips（NSynth 12 + TinySOL 12）
Dexed 候选审计：24 presets × 6 = 144 clips = 9.6 分钟
P0-C2 overfit pilot：已验证 8 presets × 6 = 48 clips = 3.2 分钟
```

48 条不够证明音质或跨音色泛化，但足够回答下一道二元问题：

> 固定同一个 timbre latent，只改变显式 f0，decoder 是否会按条件改变输出音高？

只有这个 overfit intervention 成立，才扩大到约 64–128 个验证通过的 preset 做
小规模 generalization pilot；仍不会直接使用全部 58,566 条。

## 复现入口

```bash
cd research

# Spark/本地挂载的真实乐器标签审计
uv run --extra analysis lcs-real-pitch-audit \
  --nsynth-root /path/to/nsynth-valid/audio \
  --tinysol-root /path/to/tinysol/audio \
  --limit-per-source 12 \
  --output ../reports/p0c1b-real-pitch-audit.json

# 从现有 5080 Dexed renders 生成引用型 manifest，不复制 WAV
uv run --extra analysis lcs-dexed-pilot-manifest \
  --database /path/to/dexed_corpus_export.db \
  --render-manifest /path/to/spinvae_16k/manifest.jsonl \
  --count 24 \
  --output ../reports/p0c1b-dexed-pilot.json \
  --audit ../reports/p0c1b-dexed-real-pitch-audit.json \
  --verified-output ../reports/p0c1b-dexed-pilot-verified.json
```

生成的 JSON/JSONL 仍属于 ignored experiment artifacts；本文件只记录可复现的
选择规则、汇总指标和实验边界。
