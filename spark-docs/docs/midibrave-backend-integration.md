# midiBrave 音源后端接入（交接文档）

> **交接状态（2026-07-19，江南拍板）**：本需求的 checkpoint 接入实施**对接给外部实施者**，
> 非本仓 worker 池。本文档是交接件——设计、接口契约、阻塞项与推荐路径已备齐，实施者据此推进。
> 调查由 coordinator 派单产出，未写实现代码；仓库消费侧（mapping.js/audio.js/config.js）只读分析。
>
> **拍板结论**：① 路线 = C 分阶段、**一期只做 B（预渲染音符库）**；② checkpoint 主线 = **FULL·75,365**
> （允许按声部混用，亮部盲听后定）；③ **首要阻塞 = 在 Spark 本机取用两个 .pt
> `/data/model_weights/midiBrave/`**（见 §5 Q1，未同步则 B 的离线渲染无法开跑）。
> ④ texture 声部暂不接入（保留 WebAudio granular）；⑤ melody 接入时 `outputOctave` 归 0（避免超训练音域 95）。
>
> 交接下一步顺序见 §5：Q1 同步 → Q2 确认架构/流式 → Q3 bench → B 形态 PoC（pad 单声部）→ 盲听定案 → 排实施单。

需求登记：docs/three-new-requirements.md 需求池首条。目标：以 midiBrave checkpoint 为音源后端，替代 MVP 现 WebAudio 裸合成。本单只出设计，不写实现代码。

## TL;DR

- **推荐形态 C（混合）分阶段落地：先 B（预渲染音符库），A（实时推理服务）作二期**。MVP 是事件稀疏的生态声景而非演奏乐器，预渲染覆盖度足够；实时路径的延迟与常驻成本不划算，且模型是否流式尚未确证。
- **checkpoint 建议 FULL·75,365 为主线**（谱重建明显更好），texture/亮部声部留意其高频带能量误差退步，盲听后决定。
- **发布缺口（需协同）**：两个 .pt 就在 Spark `/data/model_weights/midiBrave`；训练/评测产物也在本机。
- **声部范围警示**：melody 现发声音区（枝音 +24）最高约 MIDI 102，超出训练音域上限 95，接入前需定夺（降 outputOctave 或扩展网格）。

## 1. 调查结论

### 1.1 checkpoint 现状（Spark 实测）

- `/data/model_weights/midiBrave/` **目前为空**（root 于 7-19 22:07 建目录）；`/data/midibrave` 不存在。dashboard README 记录的发布文件名：
  - `midibrave-q150-c9-phase1-step-000023162.pt`（**Q150 · 23,162**，quality-150 子集 7,189 样本）
  - `midibrave-full-c9-phase1-step-000075365.pt`（**FULL · 75,365**，全量 75,362 train 样本）
- 两者同 config：`/home/jyhu/MidiBrave/configs/quality150_c9_optimized.yaml`，同 Phase 1；训练/评测在 Spark（qgpu 作业，等效换算见 00-equivalent-compute-basis.md），产物就在本机（finalize 脚本产出 dashboard 数据与 .pt）。
- **模型类型/大小未能实测**（文件不在手）→ 开放问题 Q1。训练 telemetry 以 generator updates 计数、含判别器系指标，指向 GAN/RAVE 系生成器（与本仓 research 的 RAVE 训练链同家族命名「Brave」）。

### 1.2 模型条件接口（dashboard 元数据确证）

- 项目自我描述「MIDI CONDITIONED AUDIO」。数据 manifest：`serum_strict_1822`（Serum 合成器预设，1,402 preset、75,362 train 样本），**note 范围 31–95**，**velocity 仅 {50, 127} 两档**。
- 条件三路（文件名与 analysis.json 互证）：
  - **音色**：归一化 512-D CLAP 嵌入 → checkpoint 内 TimbreAdapter → 128-D `z_timbre`；
  - **音高**：MIDI note（评测为单音 one-shot，含 midi_swap 跟随测试，跟随率 1.0）；
  - **力度**：velocity（训练两档）。
- **输出：44.1kHz mono float WAV**（评测样本约 1.1s 短音）。文件名语法：`serum_s067180_n072_s060_v127` = preset / 目标 note / 源 note / velocity。
- 是否支持音符序列输入、是否流式（causal）未知（config 在 Spark）→ 开放问题 Q2。

### 1.3 质量指标（256 对 evaluator，同 seed 同 split）

| 指标 | Q150 · 23,162 | FULL · 75,365 | 解读 |
|---|---|---|---|
| midi_swap_following | 1.0 | 1.0 | MIDI 跟随完美 |
| f0_absolute_cents（median / p90） | 7.37 / 17.4 | 7.21 / 17.1 | 音高误差远低于可闻阈（~10 cents） |
| f0_octave_error | 0 | 0 | 无八度错 |
| f0_periodicity（low 区） | 0.893 | 0.892 | 低音区周期性相当 |
| same_preset_timbre_cosine | 0.989 | 0.984 | 音色一致性好 |
| pitch_adversary_accuracy | 0.035 | 0.051 | 音高↔音色解耦，FULL 略降 |
| lsd_db（越低越好） | 29.7 | **24.5** | FULL 谱重建显著好 |
| mr_stft（越低越好） | 3.65 | **3.11** | FULL 更好 |
| rms_error_db（median） | 2.0 | **1.25** | FULL 动态跟随更好 |
| upper_band_energy_error_db（median / p90） | **5.1 / 22.8** | 10.0 / 34.9 | **FULL 高频带能量误差退步** |

gate.json（Q150）：f0 median ≤50 cents、p90 ≤100 cents、octave ≤1% 全部通过。

### 1.4 dashboard 4173 形态（无推理服务）

- 部署：docker `python:3.12-slim` 容器 `midibrave-dashboard`，0.0.0.0:4173（办公网直达；本机需绕过本地 http_proxy）。纯静态试听 lab：
  - `GET /api/health`、`GET /api/bootstrap`（datasets + reviews）、静态 JSON/WAV（byte-range 流式播放）、`POST` 保存 reviews。
  - **没有任何推理端点**——不能复用为推理后端，只能作为试听/定案工具。
- 24 组试听 × 6 个 serum 预设；`reviews.json` 目前为空（尚无人工定案，选型可抢首评）。
- 我对 24 组 target-a 的谱质心/包络画像（供 §4 映射用）：

| preset | 质心 | 起音 | 800ms 留存 | 性格速写 |
|---|---|---|---|---|
| s001434 | ~500Hz | 485ms | 0.50 | 暗、慢起、垫类 |
| s012942 | ~500Hz | 56ms | 0.34 | 暗、快起快收、拨/键 |
| s048091 | ~3.9kHz | 313ms | 0.73 | 亮、持续、垫 |
| s067180 | ~2.0kHz | 132ms | 0.33 | 中频、短句感 |
| s088037 | ~1.1kHz | 186ms | 0.37 | 中低、中庸 |
| s106460 | ~4.1kHz | 420ms | 0.79 | 亮、慢起、长持续 |

### 1.5 消费侧契约（我方 MVP，只读结论）

- `mapping.js`：`perchToNote → {midi, velocity}`（velocity 三档 0.42/0.68/1.0，≈MIDI 53/87/127）；`unperchToRelease → {midi, durationSeconds}`（0.25–6s，clamp 自驻留时长）。
- 实际发声音高 = 枝音 + `registerOffset`（pad 0 / melody +12 / bass −12 / texture +7）+ engine 音区偏移（melody 另有 `outputOctave` +12）。
- `audio.js` 接入面：perch/unperch/dawn 事件 → 四 engine（sustained/sineWhistle/triangleArp/granular）→ 声部总线（gain/EQ 三段/reverbSend/zoom 缩放）→ 昼夜宏低通 + master。**总线/混响/昼夜宏与音源解耦，换音源不丢这些层**。
- 事件稀疏（每声部秒级事件率），单音延迟预算：栖落发声 ~100–300ms 可接受，texture 敲击感知最敏感。

## 2. 三种接入形态

### A 实时推理服务（事件 → MIDI → 音频流）

- **架构**：Spark 起常驻推理容器（HTTP/WebSocket，PCM/Opus 流）；浏览器 AudioWorklet 收流播放；CLAP/z_timbre 按预设预缓存，事件只发 {presetId, midi, velocity, duration}。
- **延迟模型**：内网 RTT ~1–5ms + 首包生成（RAVE 系流式估计几十 ms/帧；扩散类秒级——直接出局）+ jitter buffer 50–200ms → **单音可闻延迟约 100–300ms（若流式成立）**。 melody 短句与 texture 敲击有感知但可用；pitch 中途不可改（滑音需重触发或序列输入，Q2）。
- **Spark 服务形态**：qgpu 队列常驻 job（遵守全局规范：CUDA_VISIBLE_DEVICES 由分配注入，参照 research/scripts/train_rave.sh 的拒绝裸跑约定）；前提 = Q1 同步 checkpoint + Q2 确认可流式。
- **mapping 契约改动量**：mapping 不动；audio.js 每 engine 换异步触发 + 流调度，约等于重写引擎层发声函数（总线保留）。
- **故障回退**：健康检查/首包超时 → 落回 WebAudio 合成（现状代码全保留）。
- **风险**：Q2 未定；常驻占 qgpu 资源；长尾音持续流成本高；内网可用性成为发声依赖。

### B 预渲染音符库（离线批量 → 前端采样播放）

- **架构**：离线 qgpu 批量渲染四声部音色网格，前端 `AudioBufferSource` 采样播放；WebAudio 退为纯播放总线（混响/EQ/昼夜宏原样复用）。
- **网格估算**：实际发声 midi 有限（4 季骨架+色彩档 ≈ 每声部 8–16 个音）× velocity 3 档（建议只渲 v127+v50 两档，中档用 v127+增益缩放，避开训练外插值）× 时值（长音渲满 6s 上限 + 释放段，短音 1–2s）→ **每声部约 30–50 个 WAV**，44.1k mono 全量 <100MB（Opus 后 ~10–15MB），首屏按需加载单声部即可。
- **延迟模型**：零推理延迟；加载延迟内网秒级（可预载当前季）。
- **服务形态**：一次性 qgpu 离线任务，产物落静态目录（现有 mvp 静态服务即可托管）；**非常驻、无在线依赖**。
- **mapping 契约改动量**：mapping 不动；audio.js 增加一个 `samplePlayer` engine（选样本 + 包络裁切 + 小范围 playbackRate 变调补齐色彩档微音差，±1 半音内音色漂移可忽略）。
- **故障回退**：样本缺失/加载失败 → WebAudio 合成。
- **风险**：音色静态无呼吸演化（现 T43 音色本身也是静态预设，无退步）；pad 超长按 dwellMaxDuration 6s 渲满可免 loop；**melody 音区超界（见 §4 警示）**。

### C 混合（常用音预渲染 + 长音/特殊实时）

- **架构**：B 覆盖 ~95% 事件；实时服务仅用于（a）未来音符序列/滑奏、（b）在线换音色预设、（c）B 网格外临时音高。
- **延迟模型**：常态 = B 的零延迟；实时路径低频触发，抖动不可闻。
- **服务形态**：B 的离线任务 + A 的按需常驻（二期再建，可先不建）。
- **mapping 契约改动量** = B + 可选 A；回退链三级：实时失败 → 样本 → WebAudio。
- **风险**：两层维护面，但 A 可裁剪；B 先行不阻塞。

## 3. 推荐与理由

**推荐 C 分阶段：一期只做 B，A 视 Q2/Q3 结果再立项。** 理由：

1. 事件稀疏 + 音高集合有限（生态和声框架只有几十个离散音），预渲染覆盖率接近 100%，实时推理的边际价值低。
2. B 的故障面最小（非常驻、无网络依赖），与「零延迟」同时成立；A 的两个前提（流式架构、首包延迟）目前都是未知数。
3. 与「audio engine 远期服务后端」登记同向但分步：B 先把音源换成 midiBrave 音色，A 把渲染挪到服务侧——两步互不阻塞。
4. texture 声部建议**暂不接入**：midiBrave 是 tonal 模型（MIDI+音高条件），而 T43 刚定案 texture=A granular 噪声簇，噪声打击类音色不在 serum tonal 数据分布内；保留 WebAudio granular 最省事且听感一致。接入面收敛到 pad/melody/bass 三个 tonal 声部。

## 4. checkpoint 选型建议（两版对比）

- **主线建议 FULL·75,365**：LSD −5.2dB、mr_stft −0.53、RMS error −0.75dB（median）——整体保真与动态明显更好；音高/跟随/解耦与 Q150 同档优秀。更多数据（75,362 vs 7,189）符合预期地赢了。
- **保留 Q150 作对照的场景**：FULL 的 upper_band_energy_error 明显退步（median 10.0 vs 5.1dB，p90 34.9 vs 22.8）——亮部/高频带失真或噪声偏多。melody 亮部与任何拟接入的高频素材，在 dashboard 盲听两边同 preset 后再定；**允许按声部混用 checkpoint**（每声部独立选源，grid 互不影响）。
- **声部 → 预设初映射**（基于 §1.4 谱画像 + 四声部性格，正式定案需从 1,402 preset 全集用 CLAP 检索扩展）：
  - **pad**（持续、慢起、可暗可亮）：亮选 `s106460` / `s048091`（慢起长持续），暗选 `s001434`。
  - **melody**（短句、1–4kHz 存在感）：`s067180`（2kHz 质心、起音 132ms、中等衰减）。
  - **bass**（低稳、少谐波污染）：`s012942` 暗色快起音可作起点，但其衰减快（800ms 留存 0.34）——bass 要持续感，需实测长音渲染或换更持续的暗 preset；两侧 f0_low 周期性都好（0.89+），低音区音高可信。
  - **texture**：暂不接入（见 §3）。
- **力度档**：训练仅 {50,127}；velocity 三档映射建议 0.42→v50 样本、0.68/1.0→v127 样本 + 增益差分，避免离线插值出伪影。
- **音区警示（必须处理）**：melody 现发声 = 枝音 + registerOffset(+12) + outputOctave(+12)，四季枝音上限 ~78 → 实际最高约 **MIDI 102，超出训练音域 31–95**。选项：(a) 接入时 outputOctave 归 0（发声 60–90，全在域内，最省）；(b) 网格外音用 playbackRate 变调（>±3 半音漂移明显，不推荐）；(c) 扩展训练。倾向 (a)，听感差异仅为八度位移。

## 5. 开放问题与下一步

- **Q1（阻塞）** checkpoint 实体未发布：请 jyhu 将两个 .pt 同步到 `/data/model_weights/midiBrave/` 并记录大小/格式（pt 是否需先导出 ONNX/TorchScript 供推理容器）。
- **Q2** 架构与流式能力：`/home/jyhu/MidiBrave` config 在 Spark——RAVE 系 or 扩散？单音 or 音符序列？决定 A 是否可行（问 jyhu 最快）。
- **Q3** 单音首包延迟与 RTF 实测：Q1 后在 qgpu 上跑 bench（单音渲染耗时 / 流式帧延迟）。
- **Q4** 四声部目标音色的 CLAP 来源：从 serum 全集检索 vs 目标音频反推 embedding。
- **Q5** 输出上限：单次渲染最长时长（pad 需 6s）；44.1k mono 是否唯一格式。
- **下一步顺序**：Q1 同步 → Q2 确认 → Q3 bench → **B 形态 PoC**（pad 一声部 3 音 × 2 力度验证网格与加载链路）→ dashboard 盲听定 checkpoint/预设 → 排实施单。

## 附：调查方法留痕

- Spark：`ss -tlnp`/`docker ps` 确认 4173 容器；`/home/jyhu/midibrave-dashboard/README.md`、`public/data/q150_full75365/{analysis,metrics,gate}.json`、`scripts/finalize-spark-q150-full.sh`；numpy 谱分析 24 组 target-a。
- dashboard：`GET /api/health` / `/api/bootstrap`（经 spark-local 与办公网 --noproxy 两路验证 200；本机代理会 502，注意）。
- 我方消费侧：`mvp/src/mapping.js`（perchToNote/unperchToRelease）、`mvp/src/audio.js`（engine 路由与声部总线）、`mvp/src/config.js`（registerOffset/velocity/时值数值）。
