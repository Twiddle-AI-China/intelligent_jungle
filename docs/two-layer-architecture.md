# 双层架构：编排层 × 声音引擎层

> 配套文档：[产品 PRD](prd-flock-sequencer.md)、[开发规划](dev-plan-spark.md)。  
> 本文定义两层的职责边界和层间契约。

## 0. 一句话

上层是一个「类 Boids 鸟群音序器」：地图 XY = 钢琴卷帘（X=循环时间，Y=音高），每个鸟群是一个声部，由 agent 或人控制；双击任一鸟群下潜到「声音引擎层」，群内相对运动漫游 timbre latent，MIDI 键盘显式接管音高。

```text
┌─────────────────────── 编排层（Score View）────────────────────────┐
│  扫描线 → 节拍网格；多鸟群 = 多声部；每群一个 StepFun agent             │
│  master agent：BPM / 拍号 / 调式 / 音域分配                          │
│  人可随时接管任一鸟群或 master                                       │
└──────────────┬──────────────────────────────▲─────────────────────┘
        双击下潜 / 缩放                  返回 / 录音回灌
┌──────────────▼──────────────────────────────┴─────────────────────┐
│  声音引擎层（Instrument View，单鸟群全屏）                             │
│  群内相对运动(8D 关系) → timbre latent；MIDI 键盘 → 显式音高            │
│  jam / record 的乐句量化后回写为上层该群的 pattern                      │
└──────────────┬─────────────────────────────────────────────────────┘
┌──────────────▼─────────────────────────────────────────────────────┐
│  Voice Engine（进程级共享）：transport 时钟 + decoder 池 + 混音         │
│  实现可替换：pitch-conditioned decoder / post-decoder pitch shifter   │
└─────────────────────────────────────────────────────────────────────┘
```

## 1. 三个 worktree 的现状与归宿

| worktree / 分支 | 现状 | 在新架构中的归宿 |
|---|---|---|
| `main` | 多鸟群世界 + PULSE 扫描线 + Dorian 音高带 + 8D 关系→SVD latent + 三 decoder ensemble + Python realtime server | **编排层宿主**。XY→时间/音高、扫描线触发、note groups 已经就是音序器雏形；需要补：网格量化、pattern anchor、agent 接入、接管状态机 |
| `experiment/xy-latent-engine` | 单群 18 鸟、8D 关系→语料 Atlas kNN 插值→latent、独立键盘/MIDI pitch（decoder 后移调）、三音复音、M4 复音预算实测 | **声音引擎层（Instrument View）的直接原型**。整体迁入 `src/instrument/`，pitch 链换成 Voice Engine API |
| `codex/pitch-conditioned-brave` | pitch-only MVP 已锁定：`decode_pitch([z_timbre, f0, loudness, gate])`，14 个合格音色，offline/streaming TorchScript 导出 + lock 文件，60 项测试全绿 | **Voice Engine 的 pitch 后端之一**。接入 realtime server；同时其 P0 系列闸门方法论直接复用到黑客松新训练 |

三个分支都从 `a13483e` 附近分叉，代码可合。合并顺序见 [开发规划](dev-plan-spark.md)。

## 2. 层间契约（冻结项）

### 2.1 Transport：时钟只有一个

- BPM、拍号、循环小节数、bar/beat 相位由 **Voice Engine 进程持有**（当前即 Python realtime server），因为触发必须与 PCM 生成采样级对齐；UI 的扫描线只是相位的可视化，不反向驱动触发。
- 这是对 main 现状的一个明确改造：现在 PULSE 扫描在客户端世界里，改为 server-side sequencer clock，客户端 30 Hz 控制帧只同步 pattern 与参数，不承担节拍精度。
- 编排层、声音引擎层、agent 三方都订阅同一 transport 事件流（bar 边界、beat 边界）。

### 2.2 Voice Engine API（每个 Flock 一个 Voice）

```text
# 音色（连续，≤30 Hz 更新）
set_timbre(flock, relations8)            # 8D 关系向量，引擎内部换算成 latent
set_timbre_latent(flock, z)              # instrument view 直控（可选）

# 音高（事件，样本时间戳）
note_on(flock, midi_note, velocity, t)
note_off(flock, midi_note, t)
pitch_bend(flock, semitones)

# 乐谱（server 端调度）
set_pattern(flock, [{beat, midi_note, dur_beats, vel}], loop_bars)
clear_pattern(flock)

# 全局
set_bpm(v) / set_scale(root, mode) / set_band(flock, lo_midi, hi_midi)
set_backend(flock, "pitch_conditioned" | "pitch_shift")
```

关键点：**音高走事件、音色走连续流，两条链永不混用**——这继承了 main 的 仓库 `docs/control-relation-contract.md` 已冻结的因果契约。

### 2.3 Pitch 后端可替换

同一 API 下三档实现，按可用性逐级降级，demo 永远有声音：

| 档 | 实现 | 状态 | 限制 |
|---|---|---|---|
| A | 黑客松新训 pitch-conditioned decoder | 待训练，2 天/轮 × 2 轮余量 | 风险最高 |
| B | pitch 分支已锁定的 pitch-only MVP（`decode_pitch`） | **今天就能用**，artifact 已锁 | 单音、14 音色白名单 |
| C | decoder 后双读头 pitch shifter（xy-engine 链） | **今天就能用** | 有移调伪影，三音复音 |

pitch 分支的 P0-C2 实验证明，普通同条件重建下 decoder 会**无视 pitch 条件、继续从 latent 读音高**（详见 pitch 分支 `docs/pitch-research-handoff.md`）；起作用的是 paired pitch-swap 训练（source/target 同音色不同音高，强迫 decoder 用条件）。新训练无论内部结构选拼接还是 FiLM，**必须带 pitch-swap 因果闸门**，且这不影响 2.2 的 API——编排层不感知内部结构。

### 2.4 控制权状态机

```text
每个 flock:  controller ∈ { AGENT, USER }
master:      controller ∈ { MASTER_AGENT, USER }
全局视图:    view ∈ { SCORE, INSTRUMENT(flock_id) }
```

- 接管（takeover）：用户点击接管某群 → 该群 agent 暂停接收执行权（仍可观察）；其余群继续自动运行。会议已定：用户一次只深度接管一个群。
- 双击下潜 = `view → INSTRUMENT(f)` 且隐含 `controller(f) → USER`。
- 返回上层：用户选择「保留我的乐句」（录音回写 pattern，agent 恢复但以新 pattern 为基础）或「交还」（agent 完全恢复）。
- master 接管：用户直接改 BPM/调式/结构，master agent 暂停全局决策。
- UI 原则（会议共识）：**用户能控制什么才展示什么**，agent 内部状态不铺陈在界面上。

### 2.5 Agent Control API（StepFun）

Agent 只做**宏观、低频、结构化**控制（不做高频精细操作），命令在 bar/phrase 边界生效：

```json
// 声部 agent（每群一个）
{"flock": 2, "at_bar": 17, "cmds": [
  {"type": "set_anchor",  "x": 0.25, "y": 0.62},     // 大位置迁移＝乐句改变
  {"type": "set_density", "value": 0.4},              // 音符密度
  {"type": "set_register","lo": 48, "hi": 60},        // 音域（须在 master 分配带内）
  {"type": "set_motion",  "wander": 0.2, "spread": 0.3} // 漫游/松散度 → 微变化幅度
]}

// master agent
{"cmds": [
  {"type": "set_bpm",   "value": 96},
  {"type": "set_scale", "root": "D", "mode": "dorian"},
  {"type": "set_band",  "flock": 1, "lo": 36, "hi": 52},  // 频段/音域分配
  {"type": "set_section", "name": "build", "bars": 8}
]}
```

- 群间协同**不建 agent 互通层**（会议共识）：物理上由 Boids 群间压力实现，音乐上由 master 的音域分配与调式约束兜底。
- 调式安全：所有 Y→pitch 量化经过 master 当前 scale，agent 与用户都不能产生调外音（除非 master 显式放开）。
- agent 服务是独立进程（StepFun 接口），通过 WebSocket/HTTP 与编排层交换上述 JSON；掉线时系统按最后 pattern 继续循环，**演奏不依赖 agent 存活**。

## 3. 编排层内部设计

### 3.1 从「自由地图」到「乐谱地图」

main 现状 XY 已经是时间—音高平面，需要三步收紧：

1. **网格化**：X 轴划分为 `loop_bars × steps_per_bar` 网格（默认 4 小节 × 16 步），Y 轴划分为 master 调式内的音级行（钢琴卷帘），每群限定在自己的音域带内。
2. **Pattern anchor 场**：每个 flock 的乐谱 = 一组 anchor（格点上的吸引子）。鸟群受 anchor 弹簧力约束绕其飞行；note group 的量化位置就是 pattern。**鸟群运动范围显著缩小**由弹簧刚度和 wander 上限实现。
3. **微变化预算**：循环内的自由度被显式限定——

   - X 漂移 ≤ ±1/32 音符时值 → swing/humanize；
   - Y 漂移在 anchor 音的相邻调内音之间低概率替换 → 和弦色彩变化；
   - 只有 `set_anchor`（agent 大改）或用户拖拽才发生大位置迁移，迁移过程做成可见的飞行动画（结构变化可听可视）。

这样「鸟群是活的」与「音序器是准的」不再冲突：**乐谱是 anchor 集合，鸟群是它的活体渲染**。

### 3.2 声部与容量

- 4–6 个 flock（M4 实测 BRAVE 16D 6 voices p95 6.56 ms / 23.22 ms 块，余量充足；xy-engine 短测 12 neural voices 仍达标）。
- 每群一个 neural decode；复音沿用「一次 decode + 多 pitch/envelope 分支」（后端 C）或单音（后端 B），新模型复音能力另行实测后再放开。

## 4. 声音引擎层内部设计

以 xy-engine 实验为基座，改动两点：

1. **音高链替换**：`键盘半音 → decoder 后移调` 改为 `MIDI note/bend → Voice Engine note_on/bend`，由后端 A/B 走真 pitch conditioning；后端 C 保留原移调链。音色链（8D 关系 → Atlas kNN → latent）整体保留，它已被验证连续且不出分布外坏点。
2. **录音回灌**：instrument view 内持续录制最近 N 小节的 note 事件 + 8D 关系轨迹；用户按「保留」返回时，note 事件量化为 pattern anchor 写回编排层，关系轨迹的均值成为该群新的 timbre 基点。这就是「下层 jam 反映到上层」的具体机制。

注意 pitch 分支已验证的工程细节直接沿用：streaming 导出的 oscillator phase 保存在 TorchScript buffer 中（batch=1 跨块连续）、`periodicity=gate` 由产品接口内部处理、timbre 输入必须取 Atlas 节点邻域而非无约束生成。

## 5. 进程拓扑（黑客松版）

```text
浏览器 UI（编排层 + 声音引擎层，同一 SPA 两个 view）
   │  30 Hz 控制帧 + pattern/事件（WebSocket）
   ▼
Python realtime server（Voice Engine：transport、sequencer、decoder 池、混音、PCM 流）
   ▲
   │  bar 边界快照 / JSON 命令
Agent service（StepFun 声部 agents + master agent）
```

原生 JUCE/LibTorch 路径保持既有闸门（30 分钟 0 underrun）不变，黑客松不碰。

## 6. 已知风险与对策

| 风险 | 证据 | 对策 |
|---|---|---|
| 新训练 pitch 条件被 decoder 无视 | pitch 分支 P0-C2 失败记录 | 训练脚本内置 pitch-swap 闸门，500 step 即可判定；失败立即切后端 B/C |
| riff 语料的 tail/非谐波成分重建差 | pitch 分支 P0-C5：tail 回归是 decoder/loss 上限 | 语料筛选偏谐波持续音；tail 问题显式 deferred，不在黑客松解决 |
| agent 命令延迟/失联 | 会议已预判 | 命令只在 bar 边界生效天然容忍秒级延迟；失联按最后 pattern 循环 |
| server 端 sequencer 改造引入回归 | main 现有 PULSE 在客户端 | 迁移时保留客户端触发作为 fallback flag，A/B 验证节拍稳定后删除 |
| 6 voices 长稳态未测 | main 文档明示只测过短程 | demo 配置锁 4 flocks；6 voices 需 30 分钟压测通过才放开 |
