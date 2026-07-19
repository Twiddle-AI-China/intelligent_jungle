# z_timbre 音色漫游

V1 MVP 没有乐器分轨，只有一个声部在音色空间里漫游。所以这条路径交付的不是一个固定向量，
而是**一组锚点 + 一套怎么在锚点之间走的约束**。

结论先行：

1. **没有 tanh 塌陷。** 漫游成立，V1 成立。
2. `timbre.net` 的 `LayerNorm` 在**输入端**，不在末端——原假设的结构描述是错的。
3. 归一化是 **L2**（`F.normalize(clap, dim=-1)`），已从源码核实。
4. **Spark 上的 CLAP 权重是错的那个**，不能用于这条链路。见下。
5. 漫游速率上限：**每个音符事件 ≤0.8 个 z 欧氏距离**（硬顶 1.5）。

---

## 一、塌陷判定：证伪

### 判据

评测报告里**同一个 preset** 的音色余弦是 **0.984**。若不同 preset 之间也在 0.98 上下，
就是真塌陷，漫游等于原地打转。

### 实测

全语料 1822 个 Serum preset，每个取最多 6 条单音的 CLAP embedding 求均值再 L2，
过 `timbre.net`，量两两余弦（`tools/collapse_probe.py`，在 Octopus 上跑）：

| 空间 | mean | p5 | p50 | p95 |
|---|---|---|---|---|
| 输入 CLAP-512（参照系） | 0.5165 | 0.1838 | 0.5083 | 0.9162 |
| tanh 之前 pre-tanh-128 | 0.5447 | 0.1699 | 0.5455 | 0.9705 |
| **tanh 之后 z_timbre-128** | **0.5229** | **0.1567** | **0.5194** | **0.9729** |
| 同一 preset 内不同单音 | 0.9508 | 0.8481 | 0.9654 | — |

**不同 preset 中位数 0.519，同 preset 0.951（评测报告 0.984）。差了 0.43，
不是 0.98 上下。判定：不塌陷。**

而且 tanh 前后的分布几乎一样（0.5447 → 0.5229），说明 tanh 根本没有压缩可分性——
它保留了输入空间本来就有的结构。

饱和度确实存在但无害：`|z|>0.99` 的维度占比平均 0.168、最高 0.703。
但饱和度高的 preset 依旧和别人分得开。**饱和 ≠ 塌陷**，这两件事被前一版代码混为一谈了
（旧的 `collapsed_cluster` 判据 + 「与约 22% 的 preset 几乎不可分」的说法是错的，已在
`tools/make_timbre.py` 里改掉，指标降级为 `high_saturation` 仅供参考）。

### 但有两件事值得记一笔

**（a）语料里约 1/3 是重复 preset。**
所有空间里都有恒定的 4.9% 的 preset 对余弦 >0.98，**包括输入 CLAP 空间**——
所以这是数据侧的重复导入，不是模型行为。按 CLAP 余弦 >0.995 去重：**1822 → 1241**，
丢掉 581 个。选锚点前必须去重，否则会挑到同一个音色的两份拷贝。

**（b）有效维度只有约 2.6 / 128。**
把 z 中心化后做 PCA：PC1 单独占 60.6% 能量，前 3 个占 76.0%，前 10 个占 89.9%，
participation ratio = **2.6**。

这不影响 V1（三条听感轴够用，而且正好和这个低维结构对得上），但意味着
**不要指望在 z_timbre 里做超过一把手指数量的独立音色维度**。真要更细的控制得回到
pre-tanh 或 fusion 之前——不过 V1 不需要。

---

## 二、`timbre.net` 确切结构

源码 `/home/jyhu/MidiBrave/src/midibrave/model.py:212`（Octopus，只读）：

```python
class TimbreAdapter(nn.Module):
    def __init__(self, input_dim, output_dim):
        self.net = nn.Sequential(
            nn.LayerNorm(input_dim), nn.Linear(input_dim, 256), nn.SiLU(),
            nn.Linear(256, output_dim), nn.Tanh(),
        )
    def forward(self, clap):
        return self.net(F.normalize(clap, dim=-1))
```

即 `L2 → LayerNorm(512) → Linear(512,256) → SiLU → Linear(256,128) → Tanh`。

**`LayerNorm` 在 index 0，也就是输入端；`Tanh` 才在末端。** 原本「末端 LayerNorm → tanh」
的描述与实际不符。

### `.0` 是 LayerNorm 不是 BatchNorm——两处独立确认

这是原先判断「最可能的坑」，已排除：

1. 源码写的就是 `nn.LayerNorm`。
2. checkpoint 里 `timbre.*` 只有 6 个 tensor
   （`0.weight/0.bias/1.weight/1.bias/3.weight/3.bias`），
   **没有 `running_mean` / `running_var` / `num_batches_tracked`**。BatchNorm 必然带这三个。

所以不存在「用错 running stats 伪造出塌陷假象」的问题。`tools/make_timbre.py:load_adapter`
里已有一条断言，一旦 `timbre.*` 出现预期外的键就直接报错。

---

## 三、归一化与音频预处理（以源码为准）

`/home/jyhu/MidiBrave/src/midibrave/data.py:503-528`：

```python
model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base", device=device)
model.load_ckpt(str(checkpoint))
...
audio = load_audio((root / record.audio_path).resolve(), record.sample_rate)
if record.sample_rate != 48000:
    audio = resample_poly(audio, 160, 147).astype(np.float32)
tensor = torch.from_numpy(audio).unsqueeze(0).to(device)
embedding = model.get_audio_embedding_from_data(tensor, use_tensor=True)
embedding = torch.nn.functional.normalize(embedding.float(), dim=-1)
```

- **归一化：L2**，`F.normalize(..., dim=-1)`。两处：缓存时一次，`TimbreAdapter.forward` 里又一次
  （幂等，无害）。实测缓存 `.npy` 的 L2 范数就是 1.0000。
- **整段送入**，一条完整单音 → 一个 embedding。不切 attack/sustain/release 窗口。与方案A 一致。
- **44.1 kHz mono → 48 kHz**，`resample_poly(160, 147)`。
- 训练样本 5 s / 220500 samples。

### ⚠️ Spark 上的 CLAP 权重不能用

```
训练用的： laion-clap 1.1.7 / HTSAT-base / enable_fusion=False
           /data/model_weights/laion-clap/music_audioset_epoch_15_esc_90.14.pt   (Octopus)
BRIEF 指向： /data/model_weights/clap/models--laion--clap-htsat-fused            (Spark)
                                                          ^^^^^ 带 fusion，是另一个模型
```

用错会让 embedding 落在完全不同的空间，出来的 z_timbre 是垃圾——而且不会报错，只会难听。
`make_timbre.py` 的 `--audio` 分支已经加了 sha256 校验来挡这件事。

**但 V1 根本不需要跑 CLAP。** 训练期已经把 1822 个 preset、110,409 条单音的 embedding
缓存在 Octopus `/data/midibrave/cache/serum_strict_1822/clap/`。直接用缓存 = 零重算、零漂移，
逐比特就是训练时喂给 `timbre.net` 的那个向量。atlas 就是这么建的。

---

## 四、漫游速率上限（实测，非估算）

`tools/roam_probe.py`：在 Spark 上加载完整 `MidiBrave`（CPU），沿锚点对线性插值 33 个点逐个渲染，
量相邻两次渲染的**对数梅尔距离**。模型 `load_state_dict` 的 missing / unexpected 都是空，
配置确认无误（`capacity=64, pqmf_bands=16, ratios=[2,2,2,1], static_condition_fast_path=True`）。

### 参照尺度

**同一个 preset 相邻半音**的对数梅尔距离中位数 = **0.7484**。
这是一个「明显听得出但仍是同一个乐器」的变化量，拿它当标尺。

### 灵敏度

| 锚点对 | \|Δz\| | 端到端 logmel | 每步 logmel | 灵敏度 (logmel/单位z) |
|---|---|---|---|---|
| dark_slow_thin → bright_fast_full | 9.74 | 3.203 | 0.114 | 0.375 |
| dark_slow_full → bright_fast_thin | 5.07 | 1.527 | 0.051 | 0.323 |
| dark_fast_thin → bright_slow_thin | 8.03 | 2.226 | 0.124 | 0.496 |
| dark_fast_full → bright_slow_full | 6.73 | 0.483 | 0.034 | 0.163 |
| neutral_center → dark_slow_thin | 4.67 | 0.555 | 0.033 | 0.228 |
| neutral_center → bright_fast_full | 9.65 | 3.631 | 0.128 | 0.426 |

**灵敏度中位数 = 0.3493 logmel / 单位 z。**
反推：1 个半音的听感差 ≡ **2.143 个 z 欧氏距离**。

### 建议上限

| 参数 | 值 | 理由 |
|---|---|---|
| **每音符事件 ≤ 0.8** | 推荐 | ≈0.28 logmel ≈ 0.37 个半音的变化量，读起来是「同一个音色在变」 |
| **硬顶 1.5** | 不要超 | ≈0.52 logmel ≈ 0.7 个半音，再大就从「渐变」变成「换音色」 |
| 锚点间距参考 | 4.12 ~ 10.09 | 所以跨越一对锚点需要 5~13 个音符事件 |

已渲染三档供试听（`staging/timbre/`，44.1 kHz mono，9 个锚点巡回）：

| 文件 | 每音 Δz | 时长 |
|---|---|---|
| `roam_slow_8.wav` | 0.758 | 81.4 s |
| `roam_med_3.wav` | 1.704 | 36.8 s |
| `roam_jump_0.wav` | 6.818 | 10.0 s |

`slow_8` 就是推荐速率，`jump_0` 是直接在锚点之间跳（对照组）。
上面的数字是从渲染结果客观量出来的；**耳朵确认请听这三个文件**——如果 `med_3` 听着也还行，
上限可以放宽到 1.5，我给的 0.8 是偏保守的一档。

### 两条硬约束

**（1）按音符走，不要在单音内部逐帧改 z。**
`MidiBrave.decode()` 里：

```python
z_timbre_frames = z_timbre.unsqueeze(-1).expand(-1, -1, self.total_latent_frames)
```

z_timbre 在整段上被广播成常量，训练时每个音就是一个固定 z。所以漫游应当**按音符事件推进**，
每个音一个 z。好在前端事件本来就稀疏（每声部秒级事件率），这天然对得上。

（架构上 fusion 是 Conv1x1、在 z 通路上没有时间感受野，所以缓慢变化的 z 不会炸；
但那是分布外，V1 没必要冒这个险。）

**（2）线性插值会有响度塌陷。**
锚点之间线性插值，中点 RMS 实测掉到端点均值的 **0.37 ~ 0.63**。
必须二选一：

- 按音符做 RMS 归一化；或
- 改用 `atlas_latent_point` 的**邻域加权混合**（对真实锚点做距离加权），而不是两点线性插值。

推荐后者，顺带也满足「不做无约束 latent 生成」的要求。

---

## 五、交付物

| 路径 | 说明 |
|---|---|
| `assets/timbre/atlas.json` | 9 个锚点，带完整溯源 |
| `tools/make_timbre.py` | 单向量生成 + `--build-atlas` 建图谱 |
| `tools/collapse_probe.py` | 塌陷判定（Octopus，纯 numpy） |
| `tools/descriptors.py` | 1822 preset 的 DSP 画像（Octopus，纯 numpy） |
| `tools/roam_probe.py` | 漫游速率实测（Spark，需 torch） |
| `staging/timbre/*.wav` | 三档速率试听 |

### atlas.json 里的锚点

三条听感轴（中位数/IQR 稳健标准化后过 tanh，落在 [-1,1]）：
`brightness` ← log10(谱质心)、`attack_fastness` ← -log10(起音 ms)、`fullness` ← 800 ms RMS 留存。
取三轴 8 个角 + 中心，每个目标点找**最近的真实 preset**（不是合成向量）。

| id | preset | 类别 | 名字 | 谱质心 | 起音 | 800ms 留存 |
|---|---|---|---|---|---|---|
| dark_slow_thin | serum_s023466 | Bass | BS Engine | 275 Hz | 540 ms | 0.002 |
| dark_slow_full | serum_s043574 | Pad | PD Anibus | 276 Hz | 730 ms | 0.970 |
| dark_fast_thin | serum_s013339 | Synth | Deep Shake | 201 Hz | 0 ms | 0.438 |
| dark_fast_full | serum_s003698 | Bass | BS_12 | 263 Hz | 10 ms | 0.984 |
| bright_slow_thin | serum_s019475 | Bass | Medusa 6 | 4914 Hz | 330 ms | 0.051 |
| bright_slow_full | serum_s018357 | Lead | LD Frantic Seas | 2520 Hz | 490 ms | 1.000 |
| bright_fast_thin | serum_s050091 | Pluck | Bank_PLUCK (5131) | 1569 Hz | 0 ms | 0.043 |
| bright_fast_full | serum_s089546 | Bass | Fatalist | 4672 Hz | 10 ms | 0.987 |
| neutral_center | serum_s067366 | Lead | LD Massive Nature | 726 Hz | 10 ms | 0.538 |

锚点两两 z 余弦 min=-0.036 / mean=0.412 / max=0.826，欧氏距离 4.12 ~ 10.09——**确实互相分得开**。
类别分布（Pad / Pluck / Lead / Bass / Synth）与轴的语义也对得上，是 z_timbre 有效的旁证。

### 消费方怎么用

按 Latent-Cosmos 基线（`origin/codex/pitch-conditioned-brave` 的
`research/src/latent_cosmos_research/realtime_server.py`）：

- `atlas_latent_point(atlas_latents, atlas_features, relations, exploration_range, neighbors=4)`
  —— 邻域加权混合真实锚点。`atlas_latents` 形状 `(128, 9)`，`atlas_features` 形状 `(3, 9)`
  （注意基线里这两个都是**列**为节点）。
- `limited_step(previous, target, maximum_step)` —— 限速步进，`maximum_step` 传 **0.8**。

**不要做无约束 latent 生成**，会跑到分布外产生坏点。

---

## 附：核实过的事实

- checkpoint sha256 `f6a37061e1883dd44d7c3462c240f92eb8510db893779e2d8d201e8999111508`
  （`/data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt`，Spark 与 Octopus 同名同物）
- 训练配置 `/home/jyhu/MidiBrave/training_profiles/pre_time_optimization_c9/full_fixed_1m_250k.yaml`：
  `clap_dim=512, timbre_dim=128, midi_dim=32, capacity=64, pqmf_bands=16, ratios=[2,2,2,1],
  warmup_latent_frames=64, static_condition_fast_path=true, cache_excitation_bands=true,
  condition_gain_hidden=0`；`sample_rate=44100, window_samples=49152, velocities=[50,127]`
- 语料 `serum_strict_1822`：1822 preset / 110,409 样本，
  音频 `/data/datasets/latent-cosmos-synth/serum-dataset/audio_mono_44k1/*.wav`（44.1k mono 5 s）
- CLAP 缓存 `/data/midibrave/cache/serum_strict_1822/clap/*.npy`（512D，已 L2，范数实测 1.0000）
  —— 注意同目录下的 `audio/*.npz` 只存切片索引（`start/end/peak`），不是音频
