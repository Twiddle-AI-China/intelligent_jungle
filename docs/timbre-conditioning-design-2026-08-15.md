# zrave flow 音色条件口设计（潜空间漫游适配）

> 2026-08-15 · 状态：待江南对齐后派工 · 未 commit
> 依据：`roam-probe` 实测（Spark job 662/663/664），不是推演

## 1. 为什么要改

serum128 tiny 的 11 个 10k 权重接不进潜空间漫游页。实测把原因定死了：

| 探针 | 结果 | 判定 |
|---|---|---|
| temperature 0.6→1.4 | drift 6.46→12.18、帧间步长 8.46→16.53、谱质心 1458→6002 Hz，**严格单调** | 行为层 ✅ |
| wander_delay 16→48 | drift 9.86→9.43 单调但仅 4.4% 幅度 | 弱轴 |
| context 线性插值 | 谱质心 3487→1283→**636**→709→880（中点低于两端）；RMS 摆动 5.6 倍 | 身份层 ❌ |
| 8 preset × 4 seed 组内/组间 | **separation_ratio = 0.512**（within 1.492 / between 0.764） | 身份层 ❌ |
| validation 曲线 | 最后 3000 步变化 0.2%（1.5152→1.5124） | 排除欠训 |

**机制**：每个 family 只在单一 category 上训练，且没有 preset 条件口 → 模型只学到「这一类的分布」，preset 差异被当噪声吸收。这是训练目标的必然结果，不是 bug。

结论：**行为层（怎么漂移）已经免费可用；身份层（是什么音色）必须新增 conditioning port。** 靠 context 检索或插值绕过去，已被数据否掉。

## 2. 目标与非目标

**目标**
- 给 zrave flow 加一个音色条件口，使「选中一个音色 / 在音色之间连续移动」成为模型的原生能力
- 产出能直接填进 `midibrave-roamer/config/models.json` 契约的模型包（checkpoint + config + latent map + calibration）
- 漫游语义比现有 t-SNE 双轴更干净：至少一个轴有明确物理语义和客观边界

**非目标**
- 不做第三套试听网页。复用现有「潜空间漫游合成器」
- 不改 sealed checkout `551f3bb`。所有训练侧改动开新分支
- 本轮不追求超过现有 midibrave-v2 的音质，只要求可漫游 + 可演奏

## 3. 架构改动

### 3.1 条件向量的来源

三个候选，推荐 **B+C 混合**：

| 方案 | 做法 | 优 | 劣 |
|---|---|---|---|
| A · CLAP 投影 | 抄旧设计，`timbre_from_clap` | 基建现成（laion-clap-1.1.7/HTSAT-base、`_valid_clap_cache`） | 外部代理，和模型音色空间隔一层——这正是旧版妥协的根源之一 |
| **B · 可学习 preset embedding** | `nn.Embedding(num_presets, timbre_dim)`，按 `canonical_preset_id` 索引 | 模型自己的音色空间，信号最强，天然给出漫游地图 | 只覆盖训练集见过的 preset，不泛化 |
| **C · context 编码头** | 一个小编码器把 32 帧 context 压成 timbre 向量，用回归/对比 loss 对齐到 B 的 embedding | 泛化到任意新音频 | 单独用会重蹈 context 覆辙 |

**推荐 B + C**：训练时条件取自 embedding table（保证信号强，直接治 separation_ratio），同时训一个 context→embedding 的编码头（用 B 的 embedding 当监督目标）。

这样两边都拿到：
- 推理时可以直接用 table 里的点、以及它们之间的插值 → 漫游
- 也可以从任意真实音频编码出条件 → 泛化到语料外音色
- `nn.Embedding` 的权重矩阵本身就是漫游地图的输入，**`build_voice_maps.py` 的 PCA/t-SNE 自适应布局 + 逐点响度标定可以整条照搬**，只把第 3 步的 `timbre_from_clap` 换成读 embedding table

### 3.2 注入方式

模型已有 `AdaLayerNorm`（`zrave_flow_model.py:51`）和 `MidiSequenceConditioner`（:67）。

- **timbre 是时间无关的全局条件** → 走 `AdaLayerNorm`，调制每层 norm 的 scale/shift
- **pitch 是时变的序列条件** → 保持现有路径不动

两者正交，互不干扰。这也是为什么 timbre 不该塞进 `MidiSequenceConditioner`。

### 3.3 config 新增字段

`FlowModelConfig`（`zrave_flow_config.py:216`）加：

```yaml
model:
  timbre_conditioning: true
  timbre_dim: 128            # 建议 128；256 是旧 decoder 的历史包袱，无需继承
  timbre_source: embedding   # embedding | context | both
  timbre_guidance: 2.0       # 类比现有 pitch_guidance: 3.0
  # condition_dropout: 0.10  已存在，timbre 复用同一个
```

复用现有 `condition_dropout` 做 classifier-free guidance：训练时按概率丢条件，推理时用 guidance scale 放大条件方向。

**这直接给漫游送来第三个轴：`timbre_guidance` = 音色贴合度**（低 = 更自由发挥，高 = 严格贴合选中音色）。零额外训练成本。

### 3.4 训练数据侧

不需要新采集。pack 的 `sequences.jsonl` 每行已经带齐（实测确认）：

```json
{"canonical_preset_id":"serum:000005","category":"Bass","midi_note":36,
 "velocity":54,"split":"train","shard":"shard-000000.npz","shard_row":0, ...}
```

`canonical_preset_id` 直接做 embedding table 的索引键。

### 3.5 训练矩阵

- **profile 直接用 `standard`**（d_model 384 / 4+8 层）。理由：既然要重训，就按出货规格训；顺便把「tiny 容量不够」这个唯一未排除的替代解释一并回答，不必单烧一轮对照
- **同时开 `pitch_conditioning` + `midi_sequence_conditioning`**（`note_min: 21 / note_max: 109`，对齐 roamer 后端的 `noteRange`）。音高和音色是两个正交的口，一起开一次训完
- **跨 category 训练**（不再每个 family 单训一个 category）。单类别训练是 separation_ratio 塌到 0.512 的机制成因；要让 preset 可分，模型必须在同一次训练里见到多样音色

## 4. 验收判据

复用本轮探针脚本（`/home/jnzhang/roam-probe-20260815/roam_probe{,2,3}.py`），门槛量化：

| 判据 | 当前值 | 门槛 |
|---|---|---|
| `separation_ratio`（8 preset × 4 seed） | 0.512 | **≥ 2.0** |
| 条件插值谱质心随 alpha 单调 | 否（中点塌陷） | **单调** |
| 条件插值 RMS 波动 | 5.6× | **< 1.5×** |
| latent norm 落在 p01..p99 | 0.73–0.88 | **≥ 0.90** |
| temperature 单调性 | ✅ 已成立 | 保持 |
| MIDI 音高准确度 | 无音高口 | 复用现成 G3 gate（`ZRAVE_MIDI_ADHERENCE_GATE.md`：p90 ≤ 100 cents、≥90% 窗口在 100 cents 内） |

**separation_ratio ≥ 2.0 是这轮的核心门禁**，不过不给做漫游地图。

## 5. 漫游页集成

训练达标后，roamer 侧的工作量很小：

1. **engine adapter** — 新增一条走冻结 RAVE TorchScript 解码的推理路径（现有两个 adapter 都是 BraveDecoder，不可复用）
2. **latent map** — 跑改造后的 `build_voice_maps.py`，输入换成 embedding table，其余（PCA top2 ≥60% 用 PCA 否则 t-SNE、逐点渲染标定）照搬
3. **models.json** — 按现有契约填 checkpoint sha / config sha / map / calibration
4. **解除硬约束** — 后端 `rowVoices` 是写死的 16 行 4 音色且已占满；`test/web-contract.test.js` 硬断言 `models.length === 4`。两处都要放开
5. **XY 语义重定义** — 建议 X = 音色（embedding 投影），Y = temperature（原生单调轴），`timbre_guidance` 做第三个滑杆

## 6. 分期

| 阶段 | 内容 | 门禁 |
|---|---|---|
| P0 | 新分支加 `timbre_conditioning` 到 config/model/trainer；单卡 smoke | 能跑通、loss 下降 |
| P1 | standard profile + 跨 category + pitch/timbre 双条件，正式训练 | validation 收敛 |
| P2 | 跑探针门禁 | `separation_ratio ≥ 2.0` 等表 4 全绿 |
| P3 | engine adapter + latent map + models.json | 漫游页出声、四复音门禁通过 |

**P2 是 go/no-go**。不达标就不要往 P3 投入，回到 P1 调条件强度或数据配比。

## 7. 风险与未决

- **跨 category 训练可能让每类音色都变糊**（现在每个 family 专精一类）。缓解：category 也作为条件的一部分，或按 category 分组做 curriculum
- **`timbre_dim` 取 128 还是 256** 没有实证依据，建议 P0 阶段小规模对比一次
- **`wander_delay` 是弱轴**（4.4%）。若想让它变成可用轴，需要缩短 rollout 或启用 `schedule_offset_frames`——但后者训练时恒为 0（`exploration.enabled=false`），要开就得连 exploration 一起训，成本另计
- **standard profile 在单张 GB10 上的训练时长未估**。P0 阶段要先出 throughput 数据再定 P1 的 max_updates
- 训练侧改动落在 `Latent-Cosmos-Synth` 仓库，不在本仓库；需要开新分支，不动 `551f3bb`

## 8. 附：本轮产物位置

- 探针脚本 + 日志：Spark `/home/jnzhang/roam-probe-20260815/`
- 试听 WAV（17 个）：江南桌面 `~/Desktop/roam-probe-20260815/pad/wavs/`
- 量化报告：同目录 `roam-probe2.json` / `roam-probe3.json`
- 漫游页（现有 4 模型，运行中）：<https://midibrave.twiddle-ai.com.cn> · SLURM job 661
