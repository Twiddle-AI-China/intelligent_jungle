# 跨声部生态位错峰（Track B）—— 交接设计简报

> 交接状态（2026-07-20，江南拍板：机制落 economy 跨声部 observer）：本项修复评测器
> 单项最烂维「密度互补 0.004」，同时是系统第一次装上「跨声部感知」。**串行在 Track A
> （option-1 melody 音格，docs/melody-lattice-handoff.md）之后**——两者共享 config.js/
> world.js/economy.js，单写者铁律，A 落地释放这些文件后再派本单。

## 1. 设计论点：生态位分化 = 音乐互补（同一件事）

真实黎明合唱里不同鸟种在**时间和频率上错峰**，彼此不遮蔽（Bernie Krause 声学生态位假说）。
评测器最烂维「密度互补 0.004」测的正是四声部有没有错峰留白。**所以生态深化和音乐修复是同一个
对象**——不是拿生态换音乐性，把生态模型做真（错峰、呼应、音区分工），对位/呼吸/留白免费长出。

**当前缺口**：四个 economy observer 各自独立打分，谁都不知道别的声部在干嘛 → 四声部要么一起挤
要么一起空。这是能力缺口不是架构缺陷（review P2-F），在现有 economy→conductor→world 环内补
一个跨声部观察者即可，不重构。

## 2. 机制（江南拍板：economy 跨声部 observer，涌现式）

在 economy 层新增一个**全局**观察者（看全部四树本窗口的发声时刻+音高），产出两分：
- **时间错峰分** = 1 − 同时发声重叠率（窗口内四声部 onset 越分散越高）。**直接奖励评测器在算的
  那个密度互补量**——这就是「把知觉维折进奖励」的元修复：系统优化的东西 = 耳朵在意的东西。
- **音区互补分** = 四声部音高/音区分散度（pad 低中、melody 高、bass 低、texture 稀疏高，撞在
  一起扣分）。

**入分**：作 economy 独立第 5 维（镜像未提交的 loudnessBalance 第 4 维口径：相对量、
warmup/null 豁免、独立权重、重归一）。跨声部量天然不能塞进单树 observer，所以观察者跑在
conductor/master 级。

**执行器（关键·别只加分不落地）**：复用已有的 conductor 接线（agent.js `pushBranchPreferences`
→ world `setBranchPreference` 这条 P0-A/P0-B 已建成的环）。跨声部观察者算出「本刻过挤/过空」
的缺口，转成对各树的**发声密度/时序偏置**：过挤时压某些声部留白，过空时鼓励填充。若现有
world API 不足以偏置发声时序，可新增一个 world 偏置 API（如 setVocalizeBias），保持 world 仍不
懂音乐、只收 0..1 纯数值的分层铁律。

## 3. 硬约束与验收

- 分层：world 仍不懂音高/声部语义；跨声部计分与偏置属 economy/conductor 翻译层。
- 复用 loudnessBalance 的 null 豁免口径——没发声的窗口不能被当成「错峰满分」或「零分」污染。
- 验收（评测器驱动，worker_done 必附数字）：
  1. **密度互补维从 0.004 显著上升**——先跑 C 档（仅约束）密度互补作参考天花板，把 F 推到
     C 附近或以上（评测器作者知道量纲，实施者据 C 基线设目标，别拍脑袋定绝对值）；
  2. **不回归**：H′ 均值/稳定度、行为带分、音高运动维（Track A 刚提上来的级进占比）都不明显下降；
  3. 全测试绿 `node --test mvp/test/`；
  4. 录同 seed=4997971 四季对比 before/after，四声部应更有呼吸/呼应（复用
     /tmp/fourseasons-before-meta.json 参数）。

## 4. 硬文件边界（派单时填「另一 worker 在改哪些文件」）

mvp/src/economy.js（新增跨声部观察者+第5维）、mvp/src/agent.js（conductor 消费缺口→偏置）、
mvp/src/config.js（**仅** economy.crossVoice 权重/阈值键）、可能 mvp/src/world.js（新增发声时序
偏置 API）。**这些文件与 Track A 有交集（config.js/world.js），必须等 Track A worker_done 后派。**

## 5. 元修复（第三步，B 之后单独 gate）

Track A（音高运动）+ Track B（密度互补）都落地后，两个知觉维都有了 live 机制，才谈把它们的
**耦合系数**调进 economy 聚合（连同 review P1-D 已备好的 economy×H′ 耦合）。改计分语义更重，
放最后、单独 gate、用评测器分布决定系数。别在 B 里顺手做。

## 6. 交接引用

- 论点与路线：`docs/mechanism-frontend-roadmap.md`（§2 P3 原压低、本文提为并列第一）、
  体系 review `/tmp/system-incentive-review.md`（P2-F 跨声部互补缺口）。
- 已建成的观察者→conductor→world 环（照抄接线模式）：`mvp/src/agent.js`
  （`pushBranchPreferences`、`evaluateDay` 消费 deviation）、`mvp/src/world.js`
  （`setBranchPreference`）、`mvp/src/economy.js`（loudnessBalance 第4维范式）。
- 评测器与密度互补口径：`mvp/eval/harness.js`、`mvp/eval/run.js`。
