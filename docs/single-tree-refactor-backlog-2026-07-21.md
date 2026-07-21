# 单树体验重构需求池

更新：2026-07-21

分支：`feat/single-tree-ui`（持续推送；实时 tip 以 `git rev-parse --short HEAD` 为准）

原则：先修事实错误与可解释性，再完成 Sequence / Master；不重写四树 world。

规则评审：[`music-agent-scoring-review-2026-07-21.md`](music-agent-scoring-review-2026-07-21.md)

当前事实：[`music-agent-scoring-facts-2026-07-21.md`](music-agent-scoring-facts-2026-07-21.md)

## 1. 原始 10 项需求审计

| # | 需求 | 状态 | 证据 / 剩余工作 |
|---|---|---|---|
| 1 | 鸟抽搐、反复翻转 | 已完成 | 朝向死区 + 连续两帧确认，栖鸟始终朝树干；有回归测试。 |
| 2 | 枝根连接点错 | 已完成 | 枝根接对应侧树干边缘，绘制/鸟/编号/命中共用锚点。 |
| 3 | USER 清空后交回 Agent 要等日结 | 已完成 | 交回后下一拍恢复既有当日 plan，不伪造黎明。 |
| 4 | 树干上下拼贴接缝 | 已完成 | 单张主树皮纵向映射整个 world。原生长比例树干仍可作素材升级。 |
| 5 | 四声部大小/位置，改为两屏 | 已完成 | 当前每屏两声部，桌面与 390px 均验证。新的 overview 需求另见 Epic C。 |
| 6 | 四声部统一 Sequence，枝向外是时间 | 已完成 | 规则/LLM/USER→world/audio→渲染/录音/评估已闭环；crossVoice 已迁起音/gate，Bass 5–9 runner 已删除。 |
| 7 | 年轮沿树干竖排 | 已完成 | EQ / FX / Volume 竖排，EQ 保留三层同心。 |
| 8 | 日月改塔罗/中世纪天文风 | 已完成 | 直接使用 Linux Antiquity MIT SVG，已缩小与降透明度。 |
| 9 | 背景全日线性变化 + 正拍亮闪 | 已完成 | 四象限分段线性色变；每拍轻脉冲，小节第一拍更强。 |
| 10 | Master USER 调 BPM/拍号/季长/进行/色彩 | 已完成 | Master 独立 AGENT/USER；BPM 立即，2/4/8 拍号与色彩下一小节，8–16 天季长与四季预排下一日生效。 |

## 2. P0：规则正确性与 Sequence 闭环

### P0-A 修正评分反馈倒置（已完成）

1. H 已保留原始加权平均：纯骨架=1、纯色彩=0.7、框架外=0、无音=null。
2. 相对响度上限已改为 0dB；削波继续由 peak 独立告警。
3. Master menu 已加入 `tensionRange=[0.2,0.6]`，policy / LLM / external / frame 共用；旧菜单兼容 0..1。

验证：MVP 321/321；固定 seed `20260721` × 16 天，F 档 H 均值 0.9323。评估暴露的四轨长期同时发音问题归入 crossVoice 重构，不回滚本项。

详细选项和验收见规则评审文档。

### P0-B Agent 从“看见网格”迁到“操作网格”

1. **契约层已完成**：新增受限 cell 变异 `{ from:{pitchBranchId,stepIndex}, to:{...} }`；移动保留 count，输入不可变。
2. **LLM 校验已完成**：只能把昨日已占格移到同一 5×16 菜单内的空格；越界、空来源、目标冲突、链/交换、超上限均整包回落。bird_agent schema 强制新字段；旧 provider 缺字段仍兼容。
3. **可听执行已完成**：规则层和 LLM 计划写入 world，播放头逐格生成真实 perch/audio；USER 可直接切换并持久保存格位，renderer 高亮占用格。
4. **相似度已完成**：Master pattern similarity 改读每树起音格的 count 加权 Jaccard；共同空格不参与。
5. recorder 直接录最终 MediaStream，无地址迁移；evaluator 的 rhythm/pitch 已读原生坐标，crossVoice 也已迁到 Sequence 起音/gate。

当前 Sequence v2 无未完成迁移项。Sequence / overview / Master 互动已做真浏览器验收。

## 3. P1：新 UI 需求

### C1 信息栏四轨响度总览

状态：**已完成**。信息页常驻四轨 -60..0dB meter：RMS 为填充、peak 为刻线，并显示数值、CLIP、MUTE、SOLO 与被其他 solo 抑制状态；读取 live analyser 且 `reset:false`，不清空 economy 日累计。

当前只有“当前声部”单轨 meter。改为信息栏常驻四条紧凑 meter：Pad / Melody / Bass / Texture，保留当前声部的 Mute/Solo/年轮精确值。

验收：

- 四轨同时采样，不因当前 viewport 而遗漏其他声部。
- 同时显示 live peak 与 RMS 的可辨层次，削波可见；静音/solo 状态可见。
- meter 是观测层，不修改 economy 累计器。

### C2 决策历史追随最新项

状态：**已完成**。时间线按旧→新渲染；接近底部时追加后自动跟随，用户上滚时保留阅读位置并显示“新决策”回底按钮；展开长 reason 同样遵循近底判断。

本项目是 Vanilla JS，不引入 React / `useEffect`。在 `timeline.js` 每次 render 后实现等价的自动滚动。

先将时间线改为旧→新顺序，最新决策在底部；只在用户本来接近底部时自动跟随。用户上滚阅读旧记录时不抢滚动位置，可显示“有新决策”回底按钮。

验收：连续追加、跨日裁剪、展开长 reason 后都不跳错位。

### C3 分数 tooltip / 计算解释

状态：**已完成**。总分、五个分项与 H 均有可点击/可聚焦触发器，内容直接来自 `scoreBreakdown()`：实测、偏好带、偏离、slope、单项分、权重与重归一公式齐全；`null` 豁免及 H 不进 economy 已明示，Escape 可关闭。

总分和每个分项增加可聚焦的说明触发器，共用 `scoreBreakdown()` 的真实输出，不在 UI 复制公式。

内容至少包含：

- 实测值、偏好带、偏离方向/距离、slope、单项分、权重。
- 总分公式 `Σ(单项分×权重) / Σ有效权重`，明确 `null` 豁免。
- H 单独显示，明确“不进 economy 总分”。

tooltip 不能只支持 hover；桌面端支持聚焦/点击，移动端使用 popover 或小 sheet，Escape 可关闭。

### C4 Overview → Voice view 双层相机

状态：**已完成**。启动默认将两屏世界等比收进全树 overview；点 Canvas 声部或左侧轨道只进入两声部 voice view，不写 USER/混音。voice view 再点枝/鸟或“接管”才进入 USER；Esc 先释放 USER、再回 overview，左侧“全树”提供显式返回。resize 会按所选声部重新吸附，避免桌面→390px 漂移。

启动先显示整棵树和四声部 overview；用户选中某轨后放大到当前“一屏两声部”的 voice view。

状态必须分开：

```text
OVERVIEW  --选轨-->  BROWSE/VOICE VIEW  --显式接管-->  USER
```

- 选轨/放大只是浏览，**不自动 USER，不改混音**。
- 在 voice view 再点枝/鸟或“接管”才切 USER。
- Esc/返回先从 USER 释放到 BROWSE，再回 OVERVIEW；需明确两层返回语义。
- 实现使用独立 camera mode 与 0.5 overview projection，不把 `viewportY=0`冒充 overview。
- overview 只可简化鸟和节点细节，但四声部、当前发音与树干连续性必须可读。

## 4. P2：Master USER（已完成）

Master 控制权独立于四个 voice：

```text
Master: AGENT / USER
```

| 参数 | 现状 | USER 修改后的安全生效点 |
|---|---|---|
| BPM | 已完成，仅 Master USER 可调 | 立即，保持 phase 连续 |
| 每小节拍数 | 已完成，限 2/4/8，一日仍固定 16 拍 | 下一小节，日长/phase 连续 |
| 季节天数 | 固定 8 天（4 日进行×2），USER 只读 | 下一日 |
| 和弦色彩 | 已完成，只从当日昼夜色彩菜单选 | 黎明/黄昏 |
| 和弦走向 | 已完成，产品语义定为“预排四季骨架” | 下一日，当前季身份不突变 |

进入 Master USER 后暂停新的 Master 自动决策，flock Agent 继续运行；释放后恢复自动 Master，并取消尚未到安全边界的 USER 待生效指令。已通过 1280×720 / 390×844 真浏览器布局、控件和输入竞争验收。

## 5. P2：素材与工程收尾

- ~~Bass / Pad 枝群素材复核为五条清晰音高枝；不再制作 runner 承托。~~ 已完成并重标 5×16 锚点。
- ~~Alpha 毛边、Bass 鹈鹕栖姿烘焙小枝。~~ v2 素材经 chroma soft matte / despill；左右栖姿均已去掉烘焙小枝。
- ~~树顶 / 树根 cap 尚未生成接入。~~ 已完成；cap 置于后景、连续主树皮覆盖接缝，并限制在首尾声部带 30%。
- 如单图纵向拉伸的树皮质感不足，再制作原生长比例树干/无缝遮罩。
- ~~重做后跑 1280×720、390px 与 overview/voice view 真浏览器验收。~~ 已完成；五枝、鸟姿、cap 与年轮在两档视口均可读。
- ~~开 PR。~~ 已完成：草稿 PR #1（`feat/single-tree-ui` → `main`）。
- ~~Spark 重部署。~~ 已完成：2026-07-22 从 `8ea14c8` 同步 `mvp/` 到 `/home/jnzhang/deploy/latent-cosmos-synth/`；排除 `local-config.js`、`assets/generated/` 和 `.libtv/`，8099 桌面/390px 冒烟通过。

## 6. 已确认的规则优化（2026-07-22）

以下三项已经产品确认，统一纳入本需求池：

1. **Bass Sequence 节奏评分**：Bass 不再以 `branchChanges=0` 作为第一行为维；改为每 loop 有效起音步数与循环间隔规律度，并让规则 Agent 消费对应偏离。
2. **群聚稳健统计**：保留同枝瞬时峰值作安全告警；习性得分改用时间加权 P90，避免一次短暂扎堆定义全天。
3. **Evaluator 机制闸门**：取消所有指标机械要求 `F≥C≥R`；R 只作诊断基线，C→F 只对 Agent 能控制的机制设专项改善/不退化阈值。
4. **计分解释持久态修复**：真实浏览器验收发现生态区实时重绘会让 tooltip 只闪现一帧；展开态现按 `treeId + metric` 保存在 DOM 外并在重绘后恢复，日结更新内容时仍可持续阅读。

## 7. 建议开发顺序

1. P0-A：先修 H / loudness / tension 的事实冲突，用固定样本重算分布。
2. P0-B：Agent 输出迁到 Sequence cell，再迁 pattern similarity / recorder / evaluator，删旧 runner。（已完成）
3. C2 + C3：自动滚动与计分解释，小改动但能立即提高可调试性。
4. C1：四轨 meter，为响度规则校准提供实时观测。
5. C4：实现 overview/voice view 相机状态，保持浏览与 USER 分离。
6. Master USER；和弦走向产品契约单独拍板。
7. 素材和工程收尾。

## 8. Jungle 鼓声部与新季节和声（2026-07-22，已完成）

### 8.1 Texture → Percussion Habitat（三模式，不删除原 Texture）

来源：复用个人项目 `dnber` 的 Jungle 生成思想与 break 数据，但不移植 React/MIDI 导出应用。

- 保留第四棵逻辑树、原 granular 引擎与 5×16 Sequence 地址，不增加第五棵树，守住两屏/每屏两声部的信息密度。
- 声部提供 `TEXTURE / HYBRID / JUNGLE` 三模式，默认 HYBRID；纯 Texture 沿用原发声与 Agent 性格，Hybrid 将较轻 granular 木屑细节叠在鼓骨架上，Jungle 只出鼓。
- HYBRID/JUNGLE 下五根枝解释为 foundation / backbeat / roller / dub-space / fill 五种 break 角色；16 步仍是一昼夜 16 拍。单个格触发一小节 cue，音频层再展开十六分子步。
- 提炼 `dnber` 的 Amen / Think / Apache 骨架、ghost note、swing 与 phrase-end fill，不直接播放或随机覆盖整段 break。
- Agent 适配目标：守住二四拍 snare、控制起音密度与切分复杂度、两小节内保留 motif、句末才允许 fill；跨声部冲突时优先减 hats/ghost，不删除 kick/snare 骨架。
- 评分按模式切换：HYBRID/JUNGLE 使用 cue 密度、间隔规律和角色多样性；TEXTURE 保留旧换枝/驻留/群聚口径。鼓模式不参与和谐 H 的音高归属。

### 8.2 每日和弦 + 4日进行 × 2 = 8日季节

本项明确取代 2026-07-19 的“季=单和弦 8–16 天、每日只换色彩”契约：

- 每个季节固定一条四和弦 progression；每个昼夜走一步，四天一轮，八天重复两轮后换季。
- 不同季节使用不同 progression/调式身份；季节长度固定 8 天，不再由 Master 在 8–16 范围内随机决定。
- 黎明切换当日和弦；黄昏在同一和弦上切到夜间色彩，次日黎明再进入下一个和弦的日间色彩。
- Master 仍只从菜单选择：可调整当季 progression 预设/昼夜色彩与张力，不能发明音名；安全生效点分别为下一日/下一黄昏或黎明。
- 每日根音变化必须触发 pad 重配、bass 重排与最近音级家枝迁移；季节迁移保留为更强的生态事件，但不再是唯一音高迁移时机。
