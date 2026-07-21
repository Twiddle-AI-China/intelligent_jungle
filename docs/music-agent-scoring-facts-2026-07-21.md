# 乐理规则 × Agent 玩法 × 得分：当前事实基线

日期：2026-07-21

> 同步自飞书 `music-agent-scoring-facts-2026-07-21.md`（`DNwobKyQLo94bax2JfCcxwgonbf`），
> 2026-07-21 逐条核对 `mvp/src/config.js` / `harmony.js` / `agent.js` / `economy.js` /
> `master/policy.js` / `llm/client.js` / `llm/openai-client.js`，**实现与本文档所有可核实的
> 硬事实（BPM、季节骨架、四声部驻留/换枝表、economy 五维权重与偏好带、provider 链、
> USER 接管跳过、H 不进 economy）全部一致，无偏差**。

## 0. 读取优先级

当文档与旧设计稿冲突时，按以下顺序判定事实：

1. `mvp/test/*.test.js` 可执行契约；
2. `mvp/src/config.js` 与 `mvp/src/{harmony,agent,economy,world,sequence}.js`；
3. 本文档；
4. 其他带"设计"、"计划"、"目标态"字样的历史文档。

本文档是产品阅读版；数值调整仍应直接改 config 并由测试锁定。

## 1. 时间与 Sequence 坐标

- 默认 60 BPM，可调范围 50–140 BPM。
- 1 天 = 1 loop = 4 小节 × 4 拍 = 16 拍；日长由 BPM 派生，不写死秒数。
- Sequence v2 统一地址是 `{ treeId, pitchBranchId, stepIndex }`：5 条纵向音高枝 × 16 个根到梢的时间步。
- `pitchBranchId` 只决定音高，`stepIndex` 只决定时间，两者不能混用。
- 旧纵枝 `branchId 0–4` 映射同号音高枝；旧 Bass runner `5–9` 临时解释为同一根音高枝上的 5 个时间位。

## 2. 当前乐理规则

### 2.1 季节是和弦，单日是色彩

- 一季是一个固定骨架和弦，默认 12 天，master 可在 8–16 天菜单内定长。
- 季中不每日换根音；黎明只从当季菜单选色彩档 `colorId` 与张力 `tension`。
- 5 枝中低 3 枝是 skeleton，高 2 枝是 color。换季才做大迁移，日色彩变化不强制搬鸟。
- 四季骨架进行是春 F → 夏 C → 秋 Am → 冬 G；各季再有 4 个人工限定的色彩档。
- master 只能"点菜"，不能产生菜单外的季节、色彩或季长。

### 2.2 声部音级菜单

- 当日 skeleton + color 合成和弦 frame，再向上/下八度展开为声部可用池。
- Melody 使用当季调式密音格，取 5 个连续音级；低张力靠骨架，高张力窗口上移。
- Bass 只取和弦音的八度展开，不走过经音。
- Pad 有"同音级已拥挤则软推未占音级"的权重；Bass runner 对西端/根音位有软偏好。

## 3. Agent 玩法与决策权

### 3.1 分权

- master 是唯一和声作者：选季节、色彩档、张力与季长。
- flock agent 只改行为：`dwellBeats`、`activeBars`、`holdLoops`、密度档与小量变异。
- world 只执行鸟的生理与起落，不理解 MIDI、和弦或 Sequence 作曲语义。

### 3.2 时序与回落

1. 第 N 天累积完整观测。
2. 黎明前开始 dayReview，flock 与 master 请求并联，不阻塞 world。
3. 后续黎明只领取已就绪结果；未就绪、超时、越界或结构错误立即走规则层。
4. provider 链为 bird_agent → MiniMax → 规则兜底；master 为 external → LLM → policy。

USER 接管某树时，黎明跳过该树的 Agent plan、变异、密度和 flock plan 写入；其他树、master 和生态日结仍运行。交回 Agent 时不伪造黎明，world 在下一拍恢复既有当日计划。

### 3.3 四个声部的当前行为

| 声部 | 基准驻留 | 日内行为 | 特殊规则 |
|---|---:|---|---|
| Pad | 40 拍 | 全天，日内换枝配额 0 | 黎明返家率 0.9，同枝最多 3 鸟 |
| Melody | 1.2 拍 | 晨、中日段、前夜活跃，换枝配额 12 | 同枝 1 鸟，0.9 概率弹开第二鸟，0.7 偏好邻枝 |
| Bass | 4 拍 | runner 相邻节点迈步概率 0.62 | 日内不飞离换枝，家枝大迁移只换季 |
| Texture | 2.2 拍 | 全天，换枝配额 6 | 离枝后 0.72 概率优先回原枝 |

Melody 的家枝变异默认保持 4 loop，可选 2–8；保持期内如生态指标越界，允许 1 项软适应，期满最多 2 项小变。Bass 的家枝变异在非换季日始终被冻结。

## 4. 得分的真实公式

当前 economy 是五维加权分，不是旧文档所说的三维：

1. `branchChanges`：每 loop 换枝次数，权重 1。
2. `meanDwell`：平均驻留拍数，权重 1。
3. `cohortSize`：同枝峰值群聚数，权重 1。
4. `loudnessBalance`：相对当日最响声部的 dB，权重 0.5。
5. `crossVoice`：时间错峰 70% + 音区互补 30%，权重 0.75。

每维在偏好带 `[lo, hi]` 内得 1，越界后按 `1 - 距边界距离 × slope` 线性衰减并夹到 0。总分是有效维度的加权平均。相对响度或跨声部无观测时是 `null` 豁免，不当 0 分；削波 peak > 0.9 只告警，不扣分。

| 声部 | 换枝带 | 驻留带（拍） | 群聚带 |
|---|---:|---:|---:|
| Melody | 8–16 | 0.5–2 | 1 |
| Pad | 0–1 | ≥8 | 1–2 |
| Bass | 0 | ≥3 | 1–3 |
| Texture | 4–8 | 1–4 | 1 |

四声部的响度带均为 -24–-3 dB，跨声部带均为 0.05–1。

### 和谐分 H

H 按实际发音秒数加权：骨架 1.0，色彩 0.7，框架外 0；Bass runner 按骨架计。计算后以 0.7 为下沿做满量程重标，全日无发音则为 `null`。

H 目前只用于显示、flock 复盘与 master 观测，**不乘入 economy 总分**。"economy × H"或"超张力预算扣分"仍是需求池候选，不是当前玩法。

## 5. Master 规则兜底

- 树分或 H < 0.4 视为低分；单日低分只小幅上调 tension，连续 2 日才换色彩档。
- 同一色彩档连续 3 天触发新鲜度换档；pattern 相似度 0.82 只是辅助证据，不单独触发。
- 换季后 2 天冷却；张力等维持基线，色彩仍按日轮转解冻。
- 平稳时保持当前色彩，tension 按季内进度线性爬升；一次主动干预只改一维。

## 6. Sequence v2 迁移的当前边界

已完成：

- mapping/audio 优先消费 `pitchBranchId`，旧 `branchId` 逐事件兼容；`stepIndex` 不改音高。
- renderer 绘制 5 × 16 节点和播放头，命中返回三维地址。
- 当日实际 perch 事件已镜像成每声部 Sequence v2 网格，同格多鸟保留 count；dayReview 可读 `sequencePattern`。

尚未完成：

- Agent 输出仍是家枝 `mutations[{from,to}]`，尚不直接输出网格 cell 变异。
- USER 节点编辑迁移期仍回映到当前 world 纵枝，未作为独立的下一日 pattern 持久化。
- 旧 Bass runner 仍存在于 world/视图，recorder/evaluator 尚未全面改读统一网格。

因此本阶段是"Agent 先看见网格事实"，不是"删掉 world 后重写作曲器"。

## 7. 原文档索引与偏差

| 文档 | 用途 | 当前判定 |
|---|---|---|
| `harmony-season-redesign.md` | 季=和弦、日=色彩的决策来源 | 主结构有效；末尾"待拍板"已拍板，H 不进 economy |
| `agents-and-scoring.md` | 历史目标态整合 | 已加过时提示；三维计分、Bass 整循环长驻已失效 |
| `eco-incentive-design.md` | 偏好带的设计根源 | 保留演进价值；"三观测量"已被五维 economy 取代 |
| `eco-sequencer-design.md` | 生态序列器方向 | 需求池/概念稿，不是现行契约 |
| `musicality-depth-plan-2026-07-20.md` | 上一轮乐感加深计划 | Bass runner 是过渡实现，将被 Sequence v2 统一时间轴取代 |
| `sequence-v2-spec-2026-07-21.md` | Sequence 坐标与迁移边界 | 当前有效 |
| `mvp/src/llm/README.md` | flock provider 与输入输出 | 当前有效，示例已对齐根级生态投影与 Sequence v2 摘要 |
| `mvp/src/master/README.md` | master 菜单、校验、回落 | 当前有效 |
| `rebuild-plan.md` | 大型历史路线图 | 只作背景，文内多处已显式废弃 |

## 8. 本次事实对齐修正

- 将 economy 的独立默认值、LLM 声部偏好与 `config.economy.prefs` 统一：Bass 驻留下限 3 拍、群聚 1–3。
- 改正 Bass 注释中"跨循环长驻"的旧语义，当前为 runner 约 3–5 拍步进。
- 将 Agent 的日复盘输入补上白名单化 `sequencePattern`，但不扩大 world 写权。
- 补齐 flock LLM 白名单中的 `harmonyScore`，使原始 dayReview 与真实 provider 请求一致。
