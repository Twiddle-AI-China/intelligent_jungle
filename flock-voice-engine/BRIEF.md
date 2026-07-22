# flock-voice-engine 共享施工简报

黑客松「生态/鸟群音序器」的音源后端。本文件是所有并行 agent 的共享上下文，动手前先读完。

> **交接入口：[`docs/HANDOFF.md`](docs/HANDOFF.md)—— 现在在哪、下一步做什么、哪里有坑，先读它。**
> 本文件是施工期实测事实清单，与 HANDOFF 互补；两处说法冲突时以 HANDOFF（更新更勤）为准。

> **状态（2026-07-21）：V1 单声部已交付；v2 四音色（`brave-voices`）+ 每轨漫游地图已切生产。**
> 下文「V1 范围」等早期范围描述已成历史，事实性内容（服务器/模型/协议/契约）仍然有效，
> v2 特有的事实见「模型」一节末尾与 HANDOFF。

## 目标

把 MVP 前端现在的 WebAudio 裸合成，换成 midiBrave 神经音源。~~V1 范围：单声部（pad），四声部是 V2~~
**已完成并超出**：v2 直接上了四音色专用 checkpoint（256D z_timbre，每轨带独立漫游地图），
bass/lead/pluck 各占一行、pad 占 4 行（同一模型实例）做真和弦（2026-07-21，细节见 HANDOFF）。

## 已确认的事实（实测，不要重新推测）

### 服务器
- DGX Spark，`yfhuang@192.168.9.140`。**公钥认证已通，直接 ssh；不要用 `expect` 强制密码**
  （会触发 sshd 限速：连上、提示输密码、然后无限挂起）。
- **所有工作限制在 `/srv/deploy/flock-voice-engine/` 内**，不碰别人的目录，不动别人的进程。
- 20 核 ARM，torch 2.12.1+cu130 在系统 `python3` 里可用。
- **可用内存只有约 12 GB**（8081 的 vLLM 预分配了约 97 GiB 统一内存）。服务内存预算 ≤4 GB。
- 已占端口：22 / 4173(jyhu dashboard) / 7890 / 8081(vLLM 生产，勿动) / 8083(同事，勿动) / 8086 / 8766 / 8888 / 9090 / 9418。**本项目用 8090**。
- 本机（Mac）有 `HTTP_PROXY=127.0.0.1:7897`，直连局域网会 502，curl 要加 `--noproxy '*'`。

### 模型（v2，生产）

- 四个音色专用 checkpoint：`/data/model_weights/midiBrave/{bass,pad,lead,pluck}_latest.pt`
  （各 ~98 MB，只读）。`timbre.net.3.weight` 为 `(256,256)` → **z_timbre 256D**（v1 是 128D）。
  每个 checkpoint 训练集是各自 top50 preset 子集（`/data/midibrave-v2/manifests/top50/{voice}.jsonl`，
  Octopus）。**仍是 Phase 1**（`discriminator_updates=0`）。
- 加载校验靠 checkpoint 自报 `config_hash` 与训练配置 sha256 **精确匹配**
  （四个全部匹配 `configs/v2/generated_clap_recon_top50_100k/*_safe_fallback.yaml`；
  v2 源码在 Octopus `/home/jyhu/MidiBrave-v2`），**不靠文件名猜**。
- v2 ModelConfig 比 v1 多 11 个字段；用 v1 代码加载 v2 权重会静默丢字段 —— 能出声但行为错。
- 接入验收全记录在 HANDOFF「v2 接入的坑」。

### 模型（v1，回归基线）

- 权重：`/data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt`（96 MB，**主线**）
  和 `...-q150-c9-phase1-step-000023162.pt`（对照，暂不用）。**只读，不要写这个目录。**
- **是 state_dict，不是 TorchScript。** 没有模型类就加载不了。源码 `/workspace/MidiBrave` 在 Octopus，不在 Spark。
- checkpoint 顶层键：`format=3, phase=1, step=75364, generator_updates=75365,
  discriminator_updates=0, world_size=8, epoch=5, model, optimizer, scaler, rng_by_rank`。
  → **Phase 1 only，没跑对抗微调**，音质是 Phase 1 水平。
- `model` 里 141 个 tensor / 8.00M 参数，模块前缀：
  `timbre(6) / midi(11) / decoder(119) / excitation(1) / pitch_adversary(4)`。

实测到的形状（反推模型类时以这些为准）：

```
timbre.net.0.{weight,bias}          (512,)              LayerNorm 或 BN(512)
timbre.net.1.weight                 (256, 512)          Linear 512→256
timbre.net.3.weight                 (128, 256)          Linear 256→128   → z_timbre 128D
midi.note.weight                    (128, 16)           note embedding 128 音 → 16D
midi.continuous.0.weight            (32, 2)             Linear 2→32
midi.continuous.2.weight            (16, 32)            Linear 32→16
midi.tcn.{0,2,4}.weight             (32, 32, 3)         Conv1d k=3 ×3，因果 TCN → z_midi 32D
decoder.fusion.net.0.weight         (1024, 160, 1)      Conv1x1 160→1024   (160 = 128 + 32)
decoder.fusion.net.2.weight         (1024, 1024, 1)     Conv1x1 1024→1024
decoder.blocks.{i}.{j}.conv1.weight (C, C, 3)
decoder.blocks.{i}.{j}.conv2.weight (C, C, 1)
decoder.blocks.{i}.{j}.film.affine.weight            (2C, 32, 1)   ← z_midi 32D 条件
decoder.blocks.{i}.{j}.excitation_film.affine.weight (2C, 16, 1)   ← excitation 条件 16D
   blocks.0 → C=512，blocks.1 → C=256，blocks.2 → C=256/…（逐层递减，需实测确认）
   每组 3 个子 block（.0 .1 .2）
```

参考设计文档（架构与这份 state_dict 高度吻合，可作反推依据）：
飞书《方案A双分支MIDI条件音频重构训练方案》`D4VwdGUNpoQOMGxcqs0cYlZ2nRf`。要点：
- 44.1 kHz mono，PQMF 16 bands，decoder ratios `[2,2,2,1]`，128 samples/latent frame（约 2.902 ms）
- FiLM 零初始化、逐 block 独立、`z_midi` 因果最近邻展开到各 block 时间分辨率
- 逐帧 MIDI 条件字段：`note_id / target_pitch / velocity / gate / onset_pulse / offset_pulse / pitch_bend / legato`
- 注意：文档说 `z_midi` 是 64D，**实际 checkpoint 是 32D**（fusion 输入 160 = 128+32）。以 checkpoint 为准。

### 训练数据边界（硬约束，越界即分布外）
- Serum 预设，1,402 preset / 75,362 train 样本（v1；v2 是每音色 top50 精选集，边界一致）。
- **协议层 note 范围 31–95**（`server/config.py` 与客户端同步夹紧；checkpoint 真实训练域
  更宽，是 21–109，协议层不放开），超出即分布外。
- **velocity 只有 {50, 127} 两档**（v1/v2 manifest 逐条核实）。前端三档（0.42/0.68/1.0）映射：0.42→v50 样本，0.68 与 1.0→v127 + 增益差分，**禁止插值**。
- 输出 44.1 kHz mono float。评测样本约 1.1 s 短音。

### CLAP（z_timbre 的来源）
- `/data/model_weights/clap/models--laion--clap-htsat-fused`（HF 缓存格式，只读）。
- 流程：目标音色音频 → CLAP audio encoder → 512D embedding → 归一化 → `timbre.net` → z_timbre 128D。
- 每条完整单音生成一个固定 CLAP embedding，**不要**把 attack/sustain/release 的随机窗口分别送进 CLAP。

### 前端消费侧契约（已知，前端新版尚未 push，按此对齐）
- `mapping.js`：`perchToNote → {midi, velocity}`；`unperchToRelease → {midi, durationSeconds}`（0.25–6 s）。
- 实际发声音高 = 枝音 + `registerOffset`（pad 0 / melody +12 / bass −12 / texture +7）+ engine 音区偏移。
- `audio.js`：事件 → 四 engine → 声部总线（gain / 三段 EQ / reverbSend / zoom）→ 昼夜宏低通 → master。
  **总线、混响、昼夜宏都在前端且与音源解耦——服务端只替换 engine 这一层，不要在服务端再做 master/混响/EQ。**
- 事件稀疏（每声部秒级事件率）。单音延迟预算 **100–300 ms 可接受**。
- texture 声部不接神经音源，保留 WebAudio granular。

### 基线协议（若做流式服务，保持线兼容，前端零改动即可接）
来自 `Latent-Cosmos-Synth` 仓库 `codex/pitch-conditioned-brave` 分支：
- `GET /api/decoder-status` → `{models:[...], defaultModel, sampleRate, ...}`
- `WS /decoder?model=<id>`，`binaryType=arraybuffer`
- 上行 `{type:'control', voices:[...]}`（约 60 Hz）、`{type:'buffer', bufferedFrames, underruns}`
- 下行：**二进制交错立体声 float32 PCM**；`{type:'ready', modelSha256, modelId, latentSize, samplesPerFrame}`；
  `{type:'telemetry', voices:[...]}`
- 客户端 worklet：1.5 s 环形缓冲，攒够 4096 帧才起播，每 32 块回报一次 stats。

## 架构决定（已拍，不要推翻）

1. **共享核心 + 两个出口**。流式服务与离线预渲染共用 80% 代码（模型加载、CLAP→z_timbre、
   MIDI 条件构造、note→音频）。先建共享核心，最外层再分 WS 服务 / 批量落盘两个出口。
   路线之争（交接文档拍板预渲染 vs 现在要流式）因此不阻塞任何人。
2. **voice 池固定长度、行绑定**。batch 维就是声部维；batch 尺寸变化会重建条件缓冲、
   使所有声部的相位状态归零（一起爆音）。所以池子常驻固定长度，不发声的声部带 `gate=0`
   继续跟着跑，**绝不做「有音就 append、没音就 remove」的动态列表**。V1 长度取 1，V2 取 4。
3. **服务端不做 master/混响/EQ/昼夜宏**——前端已有且与音源解耦。
4. **单音 last-note-priority**：每个声部同一时刻只有一个音，新音直接抢占。

## 目录纪律（严格遵守）

```
/srv/deploy/flock-voice-engine/          代码
./logs/                                  运行日志（生产挂载到 /app/logs）
./staging/                               临时产物
```
不要在项目根目录散落临时文件。GPU 任务原则上必须走 `qgpu`——**本项目是例外**：
2026-07-21 起容器切到 GPU（`--device cuda`，见 `docs/deploy.md`），但这是常驻服务不是
批处理任务，`qgpu` 那套是给训练/批推理设计的，跟常驻进程的资源模型不匹配，走
`docker-run.sh --gpus all` 直接常驻，不进 SLURM 队列。
权重、语料、渲染产物一律不进 Git。

## 代码风格
Python 3.12+、类型注解、中文注释。依赖尽量少（numpy / torch / aiohttp / soundfile）。
每个模块自带 `if __name__ == "__main__"` 的自测入口。
