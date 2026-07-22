# Serum 批量渲染数据需求（简版）

本文档用于生成方案 A 双分支训练所需的 Serum 单音数据。当前模型的 MIDI 条件仅包含 `note + velocity`，不训练 gate、pitch bend、ADSR、onset/offset、legato 或 release。

Decoder 内部会由 note 确定性生成谐波 excitation 作为连续相位时钟；它不增加渲染字段。首版数据因此聚焦基频清晰的 harmonic preset，noise/atonal/强 inharmonic 音色不混入首轮规模化训练。

## 1. 数据单位

每个 WAV 只包含：

- 一个 Serum preset；
- 一个 MIDI note；
- 一个 velocity；
- 一次完整单音，包括前置静音、note-on、有效发声、note-off、自然 release 和尾部静音；
- 不包含和弦、旋律、琶音或第二个音符。

同一个 preset 必须渲染完整的 note × velocity 网格，供训练时构造：

```text
A_hat = Decoder(z_timbre_A, z_midi_A)
B_hat = Decoder(z_timbre_A, z_midi_B)
```

## 2. Serum preset 筛选

### 2.1 可用 preset

- 有明确、可跟踪的单一基频；
- 有明确的单音发声过程；持续型音色按住 MIDI note 时可以持续发声；
- 持续型或自然衰减型均可，但必须能在3–5秒内完整渲染；
- MIDI note 改变时，输出基频能够正确跟随；
- MIDI velocity 对整体响度或频谱有可检测影响；
- Serum 内部 FX 可以保留，作为 preset 音色的一部分；
- preset 依赖的自定义 wavetable、noise 和资源必须可追踪并保存 hash。

### 2.2 排除 preset

- arp、sequence、chord、节奏门控或 tempo-sync rhythmic preset；
- 长 attack、长时间演化、随机跳变或强周期性宏观变化的 preset；
- FX、noise、drum、atonal 或 F0 无法可靠检测的 preset；
- 内置音高偏移、自动和声、固定五度或导致 octave 判定不稳定的 preset；
- velocity 基本无效，且不满足第7节 velocity 验收门槛的 preset。
- 在保持原始包络的前提下，无法于5秒内录完有效发声和自然 release 的 preset。

## 3. 渲染网格与规模

### 3.1 固定网格

```text
MIDI note：36–71，逐半音，共36个音高
velocity：50、127，共2档
take：不渲染重复 take
```

每个 preset：

```text
36 notes × 2 velocities = 72 WAV
72 WAV × 3–5秒 = 216–360秒，即3.6–6分钟音频
```

推荐批次：

|批次|preset 数|文件数|音频时长|用途|
|---|---:|---:|---:|---|
|试渲染|2|144|7.2–12分钟|验证脚本、格式和质检流程|
|架构验证|50|3,600|3–5小时|验证双分支、音高和力度解耦|
|最低正式规模|200|14,400|12–20小时|可训练第一版多音色模型|
|推荐正式规模|300|21,600|18–30小时|当前架构的首选数据规模|
|增强规模|500|36,000|30–50小时|提高音色覆盖和潜空间连续性|

所有组合必须渲染；失败组合写入缺失清单，禁止静默跳过。首版建议以300个通过质检的 preset 为目标，而不是把被排除的 preset 计入数量。

### 3.2 Preset 数量依据

当前模型使用 `z_timbre=128D`、`z_midi=32D` 和 `capacity=64` 的多层 BRAVE Decoder。单个 preset 的72个文件主要提供同一音色内的音高和力度覆盖，不能替代新的音色身份。对该架构而言，preset 数量比相同 preset 的重复 take 更重要：

- 50个 preset 约3–5小时，可验证模型和训练流程，但音色空间过于稀疏；
- 200个 preset 约12–20小时，是训练多音色模型的最低建议规模；
- 300个 preset 约18–30小时，按平均4秒估算约24小时，能为128D音色表示提供更合理的多样性，是首版推荐值；
- 500个 preset 约30–50小时，可进一步改善陌生音色、类别边界和潜空间插值。

数据量不能只按模型参数量估算。同一单音文件内部的相关性较高，有效数据多样性主要来自不同 preset，而不是继续增加单个文件时长。

velocity 只覆盖50和127，因此模型只对这个区间内的插值有监督。推理时应将 velocity 1–49 clamp/map 到50，除非后续补充更低 velocity 数据。两档 velocity 能学习高低力度差异，但不能证明中间动态曲线是非线性的。

## 4. 音频渲染规格

|项目|要求|
|---|---|
|采样率|44,100 Hz|
|交付声道|mono|
|交付格式|WAV float32，范围 `[-1, 1]`|
|总长度|3–5秒，不要求所有文件完全一致|
|调律|A4 = 440 Hz|
|外部效果|全部关闭，包括母带、EQ、压缩、限幅、混响和响度标准化|
|Serum 内部 FX|按 preset 原样保留|
|归一化|禁止逐文件 peak/RMS normalization|
|dither|关闭|
|峰值|不高于 −3 dBFS，绝不允许削波|

Serum 通常输出立体声。批量渲染器应先保留原始立体声计算结果，再按固定公式生成训练 mono：

```text
mono = 0.5 × (left + right)
```

如需保存 stereo master，可放入独立目录；训练清单只能引用 mono 文件。

### 4.1 完整单音渲染时序

时长不需要完全一致，但所有合成器渲染音频必须满足：

- 总长度控制在3–5秒；
- 渲染前去除 preset 的音高偏移设置，无法安全去除时排除该 preset；
- 前置静音建议50–200 ms；
- 持续型音色的有效发声段不少于2秒；
- note-off 后必须录到自然 release 结束或接近静音；
- 自然衰减型音色保留完整衰减，不得强行循环；
- 不得在 release 尚未结束时截断文件；
- 文件尾保留50–200 ms静音，用于判断发声是否结束。

推荐渲染顺序：

```text
1. 加载并重置 preset
2. 录制50–200 ms前置静音
3. 发送指定 note + velocity
4. 持续型音色保持至少2秒；自然衰减型等待完整衰减
5. 发送 note-off
6. 等待自然 release 结束或接近静音
7. 再录制50–200 ms尾部静音，总长度保持在3–5秒
8. 清空 voice，开始下一个组合
```

原始 WAV 保留完整单音，用于 CLAP embedding、数据质检和未来扩展，不删除 attack 或 release。当前 Decoder 不接收 gate、ADSR 或时间位置，且宿主负责实时 note-on/note-off 包络，因此训练预处理通过能量与离线 CREPE 自动确定稳定 sustain，只从该区间裁取 Decoder loss 窗口；attack/release 不参与当前 Decoder 重建损失。

### 4.2 增益规则

- 允许为每个 preset 设置一个固定 `render_gain_db`，避免 velocity=127 时削波；
- 同一 preset 的所有 note、velocity 和 take 必须使用完全相同的增益；
- 禁止按音高、velocity 或单个文件分别调增益；
- `render_gain_db` 必须写入 preset 元数据。

## 5. 文件命名与目录

文件名：

```text
{preset_id}_n{note:03d}_v{velocity:03d}.wav
```

示例：

```text
serum_p0012_n060_v127.wav
```

目录：

```text
serum_dataset/
├── audio_mono_44k1/
├── metadata/
│   ├── samples.jsonl
│   ├── presets.jsonl
│   └── missing_combinations.csv
└── reports/
    ├── coverage.csv
    └── qa_summary.json
```

## 6. 必需元数据

`samples.jsonl` 每个 WAV 一条记录：

```json
{
  "sample_id": "serum_p0012_n060_v127",
  "audio_path": "audio_mono_44k1/serum_p0012_n060_v127.wav",
  "source_id": "serum",
  "preset_id": "serum_p0012",
  "articulation_id": "steady",
  "midi_note": 60,
  "velocity": 127,
  "sample_rate": 44100,
  "num_samples": 176400,
  "duration_seconds": 4.0,
  "a4_tuning_hz": 440.0,
  "render_or_recording": "rendered"
}
```

`presets.jsonl` 每个 preset 一条记录，至少包含：

```text
preset_id
preset_name
preset_path
preset_file_hash
serum_version
bank/category
render_gain_db
macro_1..4 固定值
master_tune
internal_fx_enabled
dependent_asset_hashes
license/source
```

当前训练不需要单独 MIDI 文件，也不需要 gate、pitch bend、ADSR、onset/offset 或 release 标签。CLAP embedding、F0、voiced confidence 和窗口级 RMS 在后续预处理阶段生成，不属于 Serum 渲染器交付物。

## 7. 自动质检与验收

### 7.1 文件级

- WAV 可读取，无 NaN、Inf、空文件或损坏帧；
- 实际为44.1 kHz、mono，总长度在132,300–220,500 samples之间；
- peak ≤ −3 dBFS，无削波和数字爆音；
- 无外部效果、背景声、节拍器或相邻 note 残留；
- 前置和尾部静音各为50–200 ms；
- 持续型音色有效发声段不少于2秒；自然衰减型保留完整衰减；
- release 未被截断，文件尾回到接近静音；
- 无非预期的节奏变化或相邻 note 残留。

### 7.2 音高

在整段音频上估计 F0：

- median cents error ≤20 cents；
- 不允许 octave error；
- voiced/F0 confidence 低于阈值的文件进入人工复核；
- 同一 preset 若超过5%的组合音高不合格，整个 preset 暂停入库。

### 7.3 Velocity

对同一 preset、同一 note 的 velocity 50和127：

- 至少95%的音高满足 `RMS(v127) > RMS(v50)`；
- velocity 50到127的 median RMS 增幅至少3 dB；
- 若响度差异不足3 dB，必须存在明确、可重复的频谱差异，否则判定该 preset 的 velocity 无效；
- 不得通过逐文件归一化人为消除或制造 velocity 差异。

## 8. 批次交付报告

每批必须输出：

- preset 数、文件数和总时长；
- note × velocity 覆盖矩阵；
- 缺失与失败组合；
- peak、RMS、F0 confidence、median/P95 cents；
- velocity 排序通过率与50→127端点 RMS 差；
- 被排除 preset 及原因；
- Serum 版本、preset/asset hash 和授权来源。

正式入库前，先提交2个 preset的144文件试渲染批次；格式、完整发声过程、音高和 velocity 质检全部通过后，再扩大到50个 preset 验证批次，最终以300个合格 preset 为首版目标。
