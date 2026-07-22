# 乐理规则 × Agent 玩法 × 得分：当前事实基线

日期：2026-07-21

## 0. 读取优先级

当文档与旧设计稿冲突时，按以下顺序判定事实：

1. `mvp/test/*.test.js` 可执行契约；
2. `mvp/src/config.js` 与 `mvp/src/{harmony,agent,economy,world,sequence}.js`；
3. 本文档；
4. 其他带“设计”、“计划”、“目标态”字样的历史文档。

本文档是产品阅读版；数值调整仍应直接改 config 并由测试锁定。
现行规则的合理性问题与优化候选见 `docs/music-agent-scoring-review-2026-07-21.md`。

## 1. 时间与 Sequence 坐标

- 默认 60 BPM，Master 可调范围 50–90 BPM；Jungle transport 固定为双倍 100–180 BPM。
- 1 天 = 1 loop = 4 小节 × 4 拍 = 16 拍；日长由 BPM 派生，不写死秒数。
- Sequence v2 统一地址是 `{ treeId, pitchBranchId, stepIndex }`：5 条纵向音高枝 × 16 个根到梢的时间步。
- `pitchBranchId` 只决定音高，`stepIndex` 只决定时间，两者不能混用。
- 四声部 `branchId 0–4` 均映射同号音高枝；旧 Bass `5–9` runner 已删除。

## 2. 当前乐理规则

### 2.1 季节是四和弦进行，黄昏色彩由 Master 决策

- 一季固定 8 天；每季有独立四和弦 progression，按日推进，第 5–8 天重复第二圈。
- 黎明进入当日和弦；Master 每日显式输出 `duskColorShift`，黄昏只有在它为 `true` 时才保持根音并切换色彩，不再使用固定概率。
- 5 枝中低 3 枝是 skeleton，高 2 枝是 color。每日和弦变化对有音高声部做最近音级迁移；鼓模式不迁移角色枝。
- 春/夏/秋/冬各有不同 progression 与调式身份，不再把四季本身当成一条四和弦进行。
- master 只能“点菜”，不能产生菜单外的季节、色彩或季长。

### 2.2 声部音级菜单

- 当日 skeleton + color 合成和弦 frame，再向上/下八度展开为声部可用池。
- Melody 使用当季调式密音格，取 5 个连续音级；低张力靠骨架，高张力窗口上移。
- Bass 只取和弦音的八度展开，不走过经音。
- Pad 有“同音级已拥挤则软推未占音级”的权重；Bass 在 0–4 音高枝中对低枝/根音有软偏好。

## 3. Agent 玩法与决策权

### 3.1 分权

- master 是唯一和声作者：选季节顺序、菜单内色彩档与张力；季长固定 8 天。
- flock agent 的计划接口会写 `dwellBeats`、`activeBars`、`holdLoops`、密度档与小量变异；但当前树一旦有 `sequencePattern`，world 会跳过这些本能执行器，因此除 Sequence cell mutation 外，多数写入尚不能影响实际发声。此处是已确认 P0，不应再把接口存在误写成闭环已生效。
- world 只执行鸟的生理与起落，不理解 MIDI、和弦或 Sequence 作曲语义。

### 3.2 时序与回落

1. 第 N 天累积完整观测。
2. 黎明前开始 dayReview，flock 与 master 请求并联，不阻塞 world。
3. 后续黎明只领取已就绪结果；未就绪、超时、越界或结构错误立即走规则层。
4. provider 链为 bird_agent → MiniMax → 规则兜底；master 为 external → LLM → policy。

USER 接管某树时，黎明跳过该树的 Agent plan、变异、密度和 flock plan 写入；其他树、master 和生态日结仍运行。交回 Agent 时不伪造黎明，world 在下一拍恢复既有当日计划。

### 3.3 四个声部的当前行为

下表是非 Sequence 本能模式的参数定义，不等于当前生产 Sequence 模式下均已生效。当前 `world.onDawn()` 与 `behaviorStep()` 对有 `sequencePattern` 的树提前跳过，故活跃窗、换枝配额、密度档、`vocalizeBias`、驻留计划和家枝变异大多空转；真正到达声音的主要是 5×16 网格。修复项见重构需求池 §10.4。

| 声部 | 基准驻留 | 日内行为 | 特殊规则 |
|---|---:|---|---|
| Pad | 40 拍 | 全天，日内换枝配额 0 | 黎明返家率 0.9，同枝最多 3 鸟 |
| Melody | 1.2 拍 | 晨、中日段、前夜活跃，换枝配额 12 | 同枝 1 鸟，0.9 概率弹开第二鸟，0.7 偏好邻枝 |
| Bass | 4 拍 | 自主本能不换音，起音/音高由 Sequence cell 驱动 | 家枝大迁移只换季，保留低枝/根音偏好 |
| Texture | 2.2 拍 | 全天，换枝配额 6 | 离枝后 0.72 概率优先回原枝 |

Melody 的家枝变异默认保持 4 loop，可选 2–8；保持期内如生态指标越界，允许 1 项软适应，期满最多 2 项小变。Bass 的家枝变异在非换季日始终被冻结。

## 4. 得分的真实公式

当前 economy 使用统一八指标框架；权重为 0 或 `null` 的指标不进该声部总分：

1. `branchChanges`：每 loop 换枝次数；Melody/Pad/Texture 权重 1，Bass 与 Jungle 权重 0（只诊断）。
2. `onsetCount`：每 loop 唯一 Sequence 起音步数；Bass 与 Jungle 入分。
3. `intervalRegularity`：循环相邻起音间隔的 `1/(1+CV)`；Bass 与 Jungle 入分。
4. `roleDiversity`：兼容字段名；实际表示 Amen slice 覆盖的移调枝比例，仅 Jungle 入分。
5. `meanDwell`：平均驻留拍数，权重 1。
6. `cohortSize`：同枝负载的时间加权 P90，权重 1；瞬时 peak 独立告警，不直接定义全天分数。
7. `loudnessBalance`：相对当日最响声部的 dB，权重 0.5。
8. `crossVoice`：Sequence 起音/gate 互补 70% + 音区互补 30%，权重 0.75；鼓模式只参与时间互补，不参与音高冲突。

每维在偏好带 `[lo, hi]` 内得 1，越界后按 `1 - 距边界距离 × slope` 线性衰减并夹到 0。总分是有效维度的加权平均。相对响度或跨声部无观测时是 `null` 豁免，不当 0 分；削波 peak > 0.9 只告警，不扣分。

| 声部 | 首要行为带 | 驻留带（拍） | 群聚 P90 带 |
|---|---:|---:|---:|
| Melody | 换枝 8–16 | 0.5–2 | 1 |
| Pad | 换枝 0–1 | ≥8 | 1–2 |
| Bass | 起音 2–5；规律度 0.55–1 | ≥3 | 1–3 |
| Texture | Texture：换枝 4–8；Jungle：起音 8–12、规律度 0.5–1、移调覆盖 ≥2/3 | 1–4 | 1 |

Jungle 的 16-step pattern 按 Master 双倍速度循环；每个 slice 按 Amen 原生两小节/8 拍与当前 Jungle BPM 计算源时间轴推进速率，再用交叉颗粒独立处理枝移调。因此五个音高读取同样的 Amen 拍长，且都严格铺满到下一 Jungle step，不再因移调变速/变短。同拍多音高只发一片。规则 Agent 会优先把重叠格拆到 `0/4/8/12` 强拍，其次偶数拍，再考虑其余拍。

四声部的相对响度带均为 -24–0 dB；0 dB 是当日最响轨的必然锚点，削波另由 peak 告警。跨声部带均为 0.05–1；UI 显示每轨仅在自己发音 gate 内的合奏质量，静音轨 `null` 豁免。

### 和谐分 H

H 按实际发音秒数直接加权平均：骨架枝 1.0，色彩枝 0.7，框架外 0。Jungle 是无音高打击，H 为 `null`；全日无发音也为 `null`。

H 目前只用于显示、flock 复盘与 master 观测，**不乘入 economy 总分**。“economy × H”或“超张力预算扣分”仍是需求池候选，不是当前玩法。

## 5. Master 规则兜底

- 树分或 H < 0.4 视为低分；单日低分只小幅上调 tension，连续 2 日才换色彩档。
- 同一色彩档连续 3 天触发新鲜度换档；pattern 相似度 0.82 只是辅助证据，不单独触发。
- 换季后 2 天冷却；张力等维持基线，色彩仍按日轮转解冻。
- 平稳时保持当前色彩，tension 在菜单 `tensionRange=[0.2,0.6]` 内按季内进度线性爬升；policy / LLM / external 共用范围校验；一次主动干预只改一维。

## 6. Sequence v2 迁移的当前边界

已完成：

- mapping/audio 优先消费 `pitchBranchId`，旧 `branchId` 逐事件兼容；`stepIndex` 不改音高。
- renderer 绘制 5 × 16 节点和播放头，命中返回三维地址。
- 当日实际 perch 事件已镜像成每声部 Sequence v2 网格，同格多鸟保留 count；dayReview 可读 `sequencePattern`。
- LLM `cellMutations` 已采用原子白名单契约：只允许从昨日已占格移动到同网格空格，任一非法项整包回落；旧家枝 `mutations` 继续兼容。
- 规则层和 LLM 计划均能把 cell mutation 应用为下一日网格；world 按播放头把格内起音落成真实 `perch`，mapping/audio 直接消费原生 `pitchBranchId + stepIndex`。
- USER 接管后可直接切换 5×16 起音格，编辑期间不旁路发音；格位持久保留，交回 AGENT 后从下一拍恢复网格播放。
- renderer 高亮占用格；Master 的 pattern similarity 已改读每树起音格的 count 加权 Jaccard，不计共同空格。
- recorder 录制的是最终 MediaStream，不依赖 branch/Sequence 地址，因此无需数据迁移。

evaluator 的节拍/音高/crossVoice 已读原生网格与起音 gate；旧 Bass runner 5–9 已从 config/world/mapping/renderer/agent 及测试删除。当前已是四声部统一的可听网格，但“评分 → 非网格行为计划 → world → 发声”的闭环尚未接通，不能再统称为完整闭环。

## 7. 原文档索引与偏差

| 文档 | 用途 | 当前判定 |
|---|---|---|
| `harmony-season-redesign.md` | 季=和弦、日=色彩的决策来源 | 主结构有效；末尾“待拍板”已拍板，H 不进 economy |
| `agents-and-scoring.md` | 历史目标态整合 | 已加过时提示；三维计分、Bass 整循环长驻已失效 |
| `eco-incentive-design.md` | 偏好带的设计根源 | 保留演进价值；“三观测量”已被按声部启用的统一指标框架取代 |
| `eco-sequencer-design.md` | 生态序列器方向 | 需求池/概念稿，不是现行契约 |
| `musicality-depth-plan-2026-07-20.md` | 上一轮乐感加深计划 | Bass runner 为已退役的历史实现，已被 Sequence v2 取代 |
| `sequence-v2-spec-2026-07-21.md` | Sequence 坐标与迁移边界 | 当前有效 |
| `mvp/src/llm/README.md` | flock provider 与输入输出 | 当前有效，示例已对齐根级生态投影与 Sequence v2 摘要 |
| `mvp/src/master/README.md` | master 菜单、校验、回落 | 当前有效 |
| `rebuild-plan.md` | 大型历史路线图 | 只作背景，文内多处已显式废弃 |

## 8. 本次事实对齐修正

- 将 economy 的独立默认值、LLM 声部偏好与 `config.economy.prefs` 统一：Bass 驻留下限 3 拍、群聚 1–3。
- Bass 保留 4 拍低音驻留性格，起音时间改由 Sequence 网格表达，不再由 runner 迈步表达。
- 将 Agent 的日复盘输入补上白名单化 `sequencePattern`，但不扩大 world 写权。
- 补齐 flock LLM 白名单中的 `harmonyScore`，使原始 dayReview 与真实 provider 请求一致。
