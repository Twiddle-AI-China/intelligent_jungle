# melody 音格致密化（option-1）—— 交接设计简报

> 交接状态（2026-07-20，江南拍板走 option-1 后收尾）：本项为「让 melody 像一条能哼的旋律线」的
> **根治方向**，尚未实施，作为下一个工作单交接。前置调查、A/B 证据与失败的浅层尝试都已备齐。
> 本文是设计简报，实施者据此推进；实施前建议先对齐音格方案再动 harmony/mapping 核心。

## 1. 问题与已证结论（别重复踩）

- 评测器（`docs/mechanism-frontend-roadmap.md §1`、`mvp/eval/`）实测：决策层在「音高运动」维**倒挂**，
  F 跳进 80.6% / 级进 11.4%——melody 听起来是「大跳点彩、哼不出句」。
- **浅层尝试已失败（勿重做）**：给 melody 加「选枝级进偏好」（`species.melody.stepPreference`，
  world 按邻枝 id 距离加权，工作树中已实现未提交），把相邻枝占比从 37%→57%，但：
  - 评测器级进几乎没动（11.36%→11.40%）；
  - **前后四季录音人耳无区别**（/tmp/fourseasons-before.webm vs after.webm，同 seed 4997971 逐秒对齐）。
- **根因 = 音格天花板**：现设计「枝=和弦音」，5 枝就是当日和弦的 5 个音，**相邻枝之间本就隔 5–7 半音**。
  所以「落相邻枝」在耳朵里仍是跳进——**任何选枝层偏好都破不了这个天花板**，必须动音格。

## 2. option-1 目标

给 melody 一套**比和弦音更密的音格**，使它能走 1–2 半音的小步（真正的级进），从而听感成为一条旋律线，
而非和弦音点彩。约束：**只动 melody 声部**，不破坏 pad/bass/texture 的「枝=和弦音」具身性与和声框架。

## 3. 候选方案（供实施者对齐时评估）

- **A. melody 专属细分音格**：在 melody 树的相邻和弦音之间插经过音（如自当日调式/音阶取 1–2 个过路音），
  melody 的「枝→音」映射改用这套密音格，其余三树不变。改动集中在 mapping/harmony 的 melody 分支。
- **B. 半音阶/音阶量化层**：melody 落枝先得到和弦音，再按当日调式在其邻域做「音阶吸附」，允许 ±1–2 半音
  的过路音落点，受 tension 约束（低张力更守骨架、高张力可用更多过路音）。
- **C. 旋律短句规划器扩展**：melody 已有 `melodyPhrasePlan`（audio 层短句级进至目标枝音，见
  `config.audio.timbres.melody`）——把「句内级进」从纯音频表现提升为**真实音高事件**，让评测器与和声框架也看得到。

推荐先评估 A 或 C：A 最直接（改音格），C 复用已有短句机制、改动面更可控。**与工作树里已实现的 stepPreference
互补**——音格变密后，邻枝≈邻音，那个选枝级进偏好会真正生效，别删。

## 4. 硬约束与验收

- 分层：world 仍不懂音高；密音格属 harmony/mapping 的翻译层职责。
- 只影响 melody；pad/bass/texture 的和声/具身性零改动（录音已证它们本轮无变化，作回归基线）。
- 验收 = **评测器音高运动分显著上升**（级进占比从 11% 往 40–55% 走）**且四季录音人耳明显更连贯**
  （复用 /tmp/fourseasons-before-meta.json 的 seed/参数录「后」版 A/B）。
- 和声不能被破坏：H′ 均值/稳定度不得明显下降（过路音受 tension 约束）。

## 5. 交接引用

- 评测器与口径：`mvp/eval/` 与临时评测器复核报告（临时产物不纳入仓库）。
- 浅层尝试与天花板证据：旋律步进与四季 guide 复核报告（临时产物不纳入仓库）。
- 音格现状：`mvp/src/harmony.js`（chordFromFrame 枝→音）、`mvp/src/mapping.js`（noteFromBranch）、
  `mvp/src/config.js`（harmony.bySeason 骨架/色彩音、audio.timbres.melody.melodyPhrasePlan）。
- 全局方向：`docs/mechanism-frontend-roadmap.md`（评测器驱动、架构不重写、其余倒挂维=密度互补待攻）。
