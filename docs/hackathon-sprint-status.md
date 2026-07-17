# 黑客松冲刺实现状态（D1–D2）

> 2026-07-17 · 分支 `feat/server-sequencer`（main worktree）。
> 架构/PRD/排期见 [双层架构](two-layer-architecture.md)、[PRD](prd-flock-sequencer.md)、[开发规划](dev-plan-spark.md)。

## 已完成（我方侧，玮圣的 StepFun agent 骨架除外）

### D1（7/16）
- **server 端 transport + pattern 调度**（`research/sequencer.py` + `realtime_server.py`）：触发与 PCM 生成采样级对齐，G1 稳态抖动 0.000–0.068ms（闸门 <5ms）。
- **编排层 anchor 弹簧力 + 微变化预算**（`src/score.js` + `src/world.js`）：anchor 定义音符格点，鸟群绕 anchor 飞，横向漂移→swing（±1/32 音符封顶），纵向漂移超阈值→借相邻和弦音。变化来自可见运动，不注入随机数。
- **M1 迁移**：xy-engine 的 boids/xy-engine/session 以 `src/instrument/` 模块并入 main。

### D2（7/17）
- **接管状态机**（`src/control.js`）：controller ∈ {AGENT, USER} × view ∈ {SCORE, INSTRUMENT}。声部条有控制方徽标（生态/由你/下潜）、接管/交还按钮、音域带选择。agent 命令排队到 bar 边界执行，用户接管的对象对 agent 静默。
- **双击下潜/返回（G4）**：双击鸟群进入单群全屏，同一 WebSocket/AudioContext 不断流；`LiveInstrumentSession` 的 8D 关系覆盖该群控制，键盘 `A W S E D F T G Y H U J K` 或 MIDI 接管音高（首次按键才清空上层 pattern，无演奏时沿用）。
- **Master 最小集**：生命节律（BPM 滑杆）、和声（根音按钮 + 性质下拉）、音域分配（声部条角色下拉）。有机词汇 HUD（苏醒/休眠、生命节律、和声色彩、主脉）。
- **录音环最简版（G5）**：loop 相对拍点记录，节奏量化到 1/16 网格，音高在 noteOn 时已量化到当前和弦。「保留乐句」把量化 note 写回该群 pattern，不回写音色基点。
- **M2 合入 + 后端 B**：pitch 分支 research 全量合并（pyproject/uv.lock 以 pitch 分支为准）；`PitchRealtimeDecoder` 装载 pitch-performance-v1 schema 校验过的 `decode_pitch` facade，f0/loudness/gate 进条件通道，post-decoder 移调链旁路。E2E 实测：pattern C4/G4 → 261.7/391.7 Hz（比值 1.497 vs 1.4983 目标），G1 稳态 0.000ms，研究套件 71/71。
- **PRD 模板对齐**：默认 4 声部（Bass/Chord-Pad/Lead/Texture），28 boids 起步。

## 验证基线
- 前端：`npm test` 52/52 · `npm run check` 语法 OK
- 研究：`uv run --extra rave python -m unittest discover -s tests` 71/71
- 端到端：`research/scripts/g1_trigger_jitter_smoke.py`（G1 复跑）、`backend_b_e2e.py`（后端 B 音高跟随）

## 未做 / 留给黑客松剩余天数
- **agent 服务骨架**（玮圣）：StepFun 接口 + 「每 8 bar 随机换 anchor」假策略 JSON 往返。
- **D3**：五步 demo 剧本完整走通 + 录屏保底；首轮 pitch 训练出结果后判断后端 A 是否替换。
- **D4–D5**：agent 幽灵轮廓动画、30 分钟压测（G6）、拔 agent 韧性（G7）、第二轮训练。
- 后端 A（新训练 pitch-conditioned riff 模型）到位后，`--pitch-model` 换路径即可，无需改 server 代码。
