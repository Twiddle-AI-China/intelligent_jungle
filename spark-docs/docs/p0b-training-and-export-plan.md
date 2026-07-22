# P0-B 收尾计划：训练接入 + checkpoint + conditioned TorchScript 导出

## 通俗版：要干什么，pitch/MIDI 控制是怎么实现的

**问题**：现在的 BRAVE 是个自编码器（音频→latent→音频），音高和音色全部纠缠在
latent 里——你没法说"用这个音色弹一个 A4"。decoder 后置的 pitch shifter 只是
A/B 对照基线，不是模型原生能力。

**思路（P-RAVE 路线）**：把音高从 latent 里拆出来，变成 decoder 的显式输入。
演奏时的信号链是：

```
MIDI note/bend   → 连续 f0 (Hz)      ┐
MIDI velocity    → 目标响度 (RMS)     ├─ 三通道条件 [f0, loudness, gate]
MIDI note on/off → gate (0/1)        ┘
        │
        ▼
f0 驱动谐波振荡器，生成"哼唱骨架"激励信号（无音高段用噪声）
        │
        ▼
激励经 PQMF 分成 16 个频带，逐层降采样，
用 FiLM（逐通道缩放+偏移）注入 decoder 的每一个上采样层
—— 相当于在生成的每个时间尺度上都"提醒"网络当前该唱什么音高
        │
        ▼
音色漫游 latent ──→ BRAVE decoder ──→ 波形
```

**训练怎么学会听 MIDI 的话**：训练数据没有 MIDI。做法是自监督——用音高估计器（torchaudio NCCF）从训练
音频里自己提取 f0/响度/门控，喂给 decoder，网络学到"条件给什么音高，就唱什么
音高"。学成之后推理时把 MIDI 换算成同样的三通道条件，就实现了 MIDI 控音高、
latent 只管音色。

**安全网**：FiLM 层初始化为"直通"，没训练时模型逐样本等于原 BRAVE（这一点已在
上个 checkpoint 用测试证明），所以接入训练不会破坏基线和延迟事实。

**这个 checkpoint 具体干四件事**：

1. **训练接入**：官方 RAVE/Lightning 训练器只会调 `decoder(z)` 单参数，我们用
   一个"带激励口袋的 wrapper"把双输入 generator 塞进去，官方训练损失逻辑一行
   不改。
2. **条件自监督提取**：训练时逐 batch 用 torchaudio NCCF 音高估计（非 YIN）提 f0、逐帧算 RMS、
   门控。
3. **conditioned TorchScript 导出**：导出的 `.ts` 模型有 `decode(latent, 条件)`
   双输入，streaming 模式下振荡器相位跨 block 连续，并内嵌 schema ID 供加载端
   校验。
4. **冒烟验证**：本地 CPU 测试全套 + GPU 服务器 qgpu 跑 2 步 SMOKE_TEST 训练 +
   导出。

**明确不声称的**：这一步只证明"管线通了"（梯度能流、checkpoint 能存取、模型能
导出）。音高是否真的可控，要等 P0-C 的正式训练和 A/B 评测（pitch error/cents、
octave errors 等）才能下结论。

---

## Context

分支已完成两个 checkpoint：条件协议 v1（`f0_hz/loudness/gate`、reference
excitation、TorchScript 原语，`dc10cd7`）和 causal BRAVE FiLM generator
（streaming delay `[1,3,7,7]`，pass-through 与 baseline 逐样本一致，`416f865`）。
按 [pitch-conditioned-brave.md](pitch-conditioned-brave.md) 的 P0-B 定义，剩余
工作是把 `PitchConditionedGenerator` 接进 acids-rave 2.3.1 的 Lightning 训练
管线，验证梯度、checkpoint 和自定义 conditioned 导出——**不声称音高可控**
（那是 P0-C 的 A/B 实验）。

已确认的决策：本 checkpoint 包含实际 qgpu SMOKE_TEST=1 跑通；f0 训练条件用
torchaudio detect_pitch_frequency（NCCF + median smoothing，非 YIN）on-the-fly 提取（P0-C 前可换 CREPE）。

## 关键事实（已核实）

- 官方 CLI `scripts/train.py:159` 硬编码 `rave.RAVE(n_channels=...)`，模型类
  不可由 gin 替换 → 需要自定义训练入口换成子类。仓库已有包裹官方脚本的先例：
  `research/scripts/export_fixed_latent.py`。
- `rave/model.py` 中 `training_step`、`decode` 均以单参 `self.decoder(z)` 调用
  decoder；receptive-field 探测走 `forward→decode`。batch 就是原始音频
  `[B, n_channels, samples]`。
- `PitchConditionedGenerator.forward(latent, excitation)` 要求 excitation 为
  `[B, 16 PQMF bands, latent_frames × prod(ratios)]`。
- BRAVE 总降采样 128×（PQMF 16 × ratios [2,2,2,1] 即 8）→ 条件在 latent 帧率
  （128 samples/frame @44.1k），与 `HarmonicExcitation(samples_per_frame=128)`
  默认值一致。
- 导出侧 `scripts/export.py` 的 `ScriptedRAVE.decode(z)` 同样单参 → 需要新的
  conditioned scripted 类。
- `HarmonicExcitation` 的 phase 是显式输入/输出 state，可 script；streaming
  导出时包成 registered buffer。
- FiLM 初始为精确 pass-through → 零激励/未训练时行为等于 baseline，这是接入期
  的安全性质。

## 改动

### 1. 新模块 `research/src/latent_cosmos_research/pitch_rave.py`

- **`ConditionedGeneratorAdapter(nn.Module)`**：包裹 `PitchConditionedGenerator`，
  持有 `set_excitation()` 注入的当前 batch excitation；`forward(z)` 单参签名
  满足 `rave.RAVE` 的所有调用点。excitation 缺失或帧数不匹配时（如
  receptive-field 探测的随机长度输入）回退零激励——pass-through FiLM 下与
  baseline 等价。透传 `set_warmed_up` / `cumulative_delay`。
- **`extract_conditioning(audio, sample_rate, samples_per_frame)`**：自监督条件
  提取，全程 `detach`。f0 用 `torchaudio.functional.detect_pitch_frequency`
  （GPU、零新依赖）；loudness 为逐 latent 帧 RMS；gate = RMS 高于 floor；
  无声/不可靠区域 f0 置 0（协议保留值）。输出 `[B,3,latent_frames]`，遵守
  `CONDITIONING_SCHEMA`。标注为 smoke 质量，P0-C 前重估。
- **`PitchConditionedRAVE(rave.RAVE)`**：重载 `training_step` /
  `validation_step`——先从 batch 音频算 conditioning → `HarmonicExcitation`
  渲染 → 用模型自身 `self.pqmf` 变换成 16 band → `adapter.set_excitation(...)`
  → 调 `super()`，训练损失逻辑零改动。另提供带条件的 `decode(z, conditioning)`
  供导出与探针复用。

### 2. gin 配置 `research/configs/brave_pitch.gin`

叠加在 BRAVE 官方 `configs/brave.gin`（锁定 commit `4a5f290f`，见
`model-sources.lock.json`）之后解析：把 decoder 构造器绑定为 adapter 包裹的
`PitchConditionedGenerator`，参数与 brave.gin 的 Generator 绑定一一对应。
不改 `model-sources.lock.json`（外部源未变）。

### 3. 训练入口 `research/scripts/train_pitch.py` + `train_brave_pitch.sh`

- `train_pitch.py`：复用官方 `scripts.train.main`，仅把实例化的模型类换成
  `PitchConditionedRAVE`（版本已锁定，模式同 `export_fixed_latent.py`）。
- `train_brave_pitch.sh`：镜像 `train_brave.sh`——要求
  `DB_PATH/OUT_PATH/BRAVE_REPO`、拒绝无 `CUDA_VISIBLE_DEVICES`、`SMOKE_TEST=1`
  时 2 步 + `--smoke_test`；config 传 `$BRAVE_REPO/configs/brave.gin` +
  `configs/brave_pitch.gin`。

### 4. 导出 `research/scripts/export_pitch_conditioned.py`

沿 `export_fixed_latent.py` 模式，定义 conditioned scripted 类：

- `decode(z, conditioning)`：conditioning `[B,3,latent_frames]` → 内嵌 scripted
  `HarmonicExcitation`（streaming 模式 phase 存 registered buffer，跨 block
  连续）→ PQMF → generator → PQMF 逆变换。
- 元数据内嵌 schema ID `pitch-conditioning-v1:f0_hz,loudness,gate`，加载端按 ID
  校验而非位置猜测。
- offline + streaming（cached-conv）两种导出，写 SHA-256（checkpoint 存在 ≠
  已导出/已测量）。

### 5. 测试 `research/tests/test_pitch_training.py`

CPU、随机权重、无真实 checkpoint，风格同 `test_pitch_model.py` 的 skipUnless
守卫：

- tiny 配置下一次 `training_step` 前向+反向：损失有限，梯度到达 FiLM sites、
  condition_downsamplers、encoder/decoder。
- `extract_conditioning` 形状/schema/静音段 f0=0。
- checkpoint 保存→加载 roundtrip，FiLM 与 downsampler 权重完整恢复。
- tiny 模型走完整导出路径到临时 `.ts`：`torch.jit.load` 后
  `decode(z, conditioning)` 可跑；streaming 分块输出与 offline 在 cached-conv
  延迟容差内一致；schema 元数据可读。

### 6. qgpu SMOKE_TEST（实际 GPU 端到端）

按 `research/README.md` 的 qgpu 约定（上一轮 BRAVE job 73/76/77 在 RTX 5080
主机完成）：

1. 同步分支到 GPU 主机；必要时 `bootstrap_gpu.sh`；`BRAVE_REPO` 指向锁定 commit
   的 clone。
2. `qgpu -n lcs-brave-pitch-smoke ... SMOKE_TEST=1 ... bash
   scripts/train_brave_pitch.sh`（复用 job 73 的 DB_PATH，免重复预处理）。
3. 对产生的 ckpt 跑 `export_pitch_conditioned.py`，记录 SHA-256；把 `.ts` 拉回
   本地做加载冒烟（RTX 结果仅训练诊断，不改延迟事实边界）。

### 7. 文档

更新 `docs/pitch-conditioned-brave.md` P0-B 进度段与 `research/README.md`
pitch 分支节：训练接入方式、smoke 结论、明确「已证明的仅为梯度/ckpt/export，
音高可控性未验证」。

## 不做 / 边界

- 不动 `pitch_generator.py` 已验证的结构与延迟事实（`[1,3,7,7]`、
  cumulative_delay=7）。
- 不上 CREPE、不改 `rave preprocess` 的 h5 产物。
- 不启动长训练、不做 P0-C 的 A/B、不改 realtime_server 前端接口（conditioned
  `.ts` 接入播放链路是下一 checkpoint）。
- 硬闸门不变：未导出并在 M4 实测前不得更改延迟事实边界。

## 验证

1. 本地：`cd research && uv run --extra rave python -m unittest discover -s
   tests -v`（原 19 项 + 新增全部通过）；根目录 `npm run check` 确认前端 12 项
   不受影响。
2. 本地 tiny 导出产物用 `torch.jit.load` 实际调用 `decode(z, conditioning)`，
   检查 streaming/offline 一致性与 schema 元数据。
3. qgpu：SMOKE_TEST job 正常退出，`OUT_PATH` 出现 ckpt，导出脚本产出
   offline+streaming `.ts` 及 SHA-256 记录。
4. 拉回的 conditioned `.ts` 在本机 `lcs-model-probe` 或最小加载脚本中可加载、
   可解码一个 block。
