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
| 10 | Master USER 调 BPM/拍号/季长/进行/色彩 | 旧版已完成，新契约待重构 | 季长已固定 8 天；新需求要求 HUD 只显示定性时间流速，移除“年度骨架走向”，每季 progression 改由 Master Agent 从菜单决定。见 §9。 |

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
| 和弦色彩 | 已完成，只从当日色彩菜单选；黄昏是否换色由 Master 的 `duskColorShift` 决定 | USER 指令的下一安全边界 |
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
- 声部只提供 `TEXTURE / JUNGLE` 两模式，默认 JUNGLE；Texture 沿用原 granular 发声与 Agent 性格，Jungle 每个 Sequence cell 从 dnber 的真实 Amen WAV 触发一枚 32-step slice。Hybrid 已删除，避免两套瞬态叠加后既小声又失焦。
- JUNGLE 的时间格决定 Amen slice offset，五根枝只表示 `−7/−3/0/+3/+7st` 移调。Master BPM 限 50–90，Jungle transport 固定 ×2 为 100–180；16-step pattern 每项目日循环两次。每片由 Amen 原生 8 拍长度与当前 Jungle BPM 求源时间轴推进率，枝 pitch rate 只用于 100ms/50% 交叉颗粒内移调。所有音高都读取同样的 Amen 拍长，输出严格铺满到下一 Jungle step，不再因移调变速/变短。同拍多音高只发一片，Agent 会逐日把重叠格搬到空的强拍/偶数拍。
- Jungle 的目标占空比由每 16 步 2–4 次提高到 8–12 次；低于下限时规则 Agent 每日最多补 2 个 break 骨架点，避免 move-only 变异让稀疏 pattern 永久固化。
- 提炼 `dnber` 的 Amen / Think / Apache 骨架、ghost note、swing 与 phrase-end fill，不直接播放或随机覆盖整段 break。
- Agent 适配目标：守住二四拍 snare、控制起音密度与切分复杂度、两小节内保留 motif、句末才允许 fill；跨声部冲突时优先减 hats/ghost，不删除 kick/snare 骨架。
- 评分按模式切换：JUNGLE 使用 onset 密度、间隔规律和移调枝覆盖（字段名 `roleDiversity` 暂为存档兼容）；TEXTURE 保留旧换枝/驻留/群聚口径。鼓模式不参与和谐 H 的音高归属。

### 8.2 每日和弦 + 4日进行 × 2 = 8日季节

本项明确取代 2026-07-19 的“季=单和弦 8–16 天、每日只换色彩”契约：

- 每个季节固定一条四和弦 progression；每个昼夜走一步，四天一轮，八天重复两轮后换季。
- 不同季节使用不同 progression/调式身份；季节长度固定 8 天，不再由 Master 在 8–16 范围内随机决定。
- 黎明切换当日和弦；Master 每日显式决定 `duskColorShift`，为真时黄昏才在同一根音上切换色彩，次日黎明再进入下一个和弦。
- Master 仍只从菜单选择：可调整当季 progression 预设/和弦色彩与张力，不能发明音名；安全生效点分别为下一日/下一事件边界。
- 每日根音变化必须触发 pad 重配、bass 重排与最近音级家枝迁移；季节迁移保留为更强的生态事件，但不再是唯一音高迁移时机。

## 9. 新需求池：塔罗背景 / Master 乐理权限 / Jungle 编辑语汇（2026-07-22）

### 9.1 P1 塔罗牌式季节背景

实现状态（2026-07-22）：已按人工选定的 Midjourney V8.1 botanical 03 母版落地。四季共享同一构图，通过低饱和、低色度单色滤镜建立季节差异：夏季偏白、冬季偏黑，春秋保持中间明度；运行时统一以 50% 不透明度、1.6px 轻微模糊铺底。此前未通过观感验收的项目自有塔罗 SVG 已移除。renderer 的季节交叉淡化、全日线性明暗、Linux Antiquity 日月与正拍脉冲保持原逻辑。

现状：日月使用 Linux Antiquity SVG；背景已从写实环境图替换为同一 botanical 母版的四季低色度变体，以透明度和模糊退到前景之后。

目标：

- 四季背景沿用人工选定的 botanical 03 构图，不再分别生成不同画面，避免季节切换时构图跳变。
- 季节差异只用低色度调色和明度控制完成；夏季高调、冬季低调，春秋为中间态。
- 保留现有四季交叉淡化和全日线性明度变化；统一 50% 不透明度和轻微模糊，不抢树、鸟、Sequence 节点。
- 后续季节迭代优先调整滤镜参数，不重新生成母版。

验收：与日月并置时像同一套卡牌；昼/夜、季节过渡、正拍脉冲仍可读；1280×720 与 390px 不降低 Sequence 命中可见性。

### 9.2 P0 Master 和声契约重构

实现状态（2026-07-22）：首批已落地。运行时每季已有 3 条受限 `progressionId`，色彩菜单扩为 6 档，年度排序控件已从 HUD 移除；Agent 黄昏换色有“至少间隔 2 天 / 每 4 日循环最多一次”硬门禁。旧 `setUserProgression()` 仅暂留为无 UI 的兼容 API，待外部调用确认后删除。

#### A. 色彩菜单从 2 个扩到 4–6 个

现状：`bySeason.colors` 历史配置实际每季有 4 档，但日和弦新路径在 `colorOptions()` 中只临时生成“日光/开放”两个白天选项和“月影/暗潮”两个夜间选项，因此 USER 菜单只看到 2 个。

新契约：

- 每个当日和弦从它的 quality + 当季调式生成 4–6 个受限色彩，例如本色、sus2、sus4、6/6-9、7/maj7、add9；只输出两根高枝音，不允许 Master 发明菜单外音。
- 默认每日从黎明到次日保持同一色彩。同日变化仍由 Master 显式输出 `duskColorShift`，不恢复 RNG 概率。
- 为实现“低频率”，增加硬约束：黄昏换色至少间隔 2 天，每个 4 日 progression 最多 1 次；只有失衡连续、新鲜度到期或形态转折证据才允许。
- USER 仍可从当日菜单直接选色；Agent 的低频率限制不拦截显式 USER 操作。

#### B. 移除“年度骨架走向”，改为每季 Agent 选 progression

- 删除 HUD 的 `master-progression` 控件、四季排列和 `setUserProgression()`；用户不再编辑年度季节顺序。
- 每季提供 3–4 条经乐理审核的四和弦 `progressionId` 菜单；Master Agent 在进入新季前选一条，连续 4 天走完后原样重复第二圈。
- Agent 只选 `progressionId`，不直接生成 root/MIDI/和弦名；如 LLM 失败，policy 按季节和上季最后一和弦的 voice-leading 距离选默认条目。
- progression 只在季节边界生效，不允许季中突然换进行；当季 `progressionId` 可在信息栏作只读说明，不作用户控件。

### 9.3 P0 HUD 改为定性“时间流速”

实现状态（2026-07-22）：已落地。HUD 与 USER 控件只显示 5 档定性流速；Master schema 已加入 `tempoIntent`，规则层仅在季节形态转折提出单档变化，执行端用一小节四段 slew，底层 50–90 / Jungle ×2 契约不变。

现状：HUD 直接显示 `60 BPM · Jungle 120 · 16.0s/昼夜`。Master Agent **目前不会修改 tempo**；Master 决策 schema 只含色彩、张力、黄昏换色、换季和季长。BPM 只能由 Master USER 滑条立即修改。

新契约：

- 常驻 HUD 不显示 BPM、Jungle 双倍数字或“多少秒/昼夜”，只显示定性文案：例如 `时光·缓慢 / 流动 / 轻快 / 急驰`。
- 底层仍保留 Master 50–90 / Jungle 100–180 硬范围，定性文案只是 UI 投影，不改变音频契约。
- Master USER 不再暴露精确数字滑条，改为 4–5 档“时间流速”意图；内部映射到受限 BPM 目标并用至少 1 小节平滑过渡。
- Master Agent 应获得 tempo 权限，但只输出 `tempoIntent: hold | slower | faster`，不输出具体 BPM。默认 `hold`，每日最多移动一档，换季冷却期内不加速，并且不得因单日低分来回抽动。
- Agent tempo 只在黎明生效并平滑至目标；USER 可显式覆盖，释放后 Agent 从当前档继续，不跳回默认。

### 9.4 P1/P2 Jungle 多样化：结构编辑优先，效果其次

`dnber/services/jungleGenerator.ts` 可迁移的不是整个 MIDI 应用，而是以下形态规则：32-step Amen/Think/Apache 模板、ghost hit 概率、奇数格 swing，只在 15/31 句尾做 2/4 次 retrigger，8/16 小节抽空 break，以及句末 fill。

外部技术参考：Ableton Simpler 的 Slicing 模式明确支持 transient / beat / region / manual 切片，Warp 则用于让带自身节奏的样本在不同音高下仍跟随工程 tempo；Beat Repeat 把 interval、grid、gate、chance、filter 和 mix mode 分开，说明“结构触发”与“声音着色”应是两层契约：

- <https://www.ableton.com/en/live-manual/11/live-instrument-reference/#simpler>
- <https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/#beat-repeat>

建议分层：

1. **P1 节奏结构**：从均分 32 切片升级为预分析/人工校准的 transient 切片表；强拍 onset 不动，保留 Amen 内部 ghost/swing。这是下一个最值得先做的音色质量项。
2. **P1 句尾 retrigger**：只在第 15/31 格或 4 小节结尾，把当前片以 2 或 4 次重触发铺满原有一拍；不改 Master/Jungle tempo，不越过下一步。
3. **P1 抽空 / drop edit**：在 4 日 progression 结尾或换季前留一拍/半小节空白，不把密度评分误判为故障。
4. **P2 dub send throw**：句尾 slice 低概率进 band-pass delay/reverb send，干声瞬态仍居中；不在每个强拍涂满混响。
5. **P2 filter / crush 颜色**：可选电话带通、低通开合和轻量 bit/sample-rate reduction；只是句尾或 breakdown 色彩，不改 slice 时值。
6. **P2 reverse / pitch-decay repeat**：只用预生成反转 buffer 或粒内 pitch envelope，限定在 phrase end；位于 limiter 前，且不允许输出越过下一 Jungle step。
7. **P2 多 break 资产**：Amen 稳定后再增加 Think/Apache，以季节或 Agent 形态切换，不在单拍内随机换源。

Agent 不直控连续效果参数，只从小菜单选择：

```text
breakEdit: hold | repeat2 | repeat4 | dropout | reverse
breakTone: clean | dub | filtered | crushed
```

每个 4 小节日最多一个结构 edit + 一个 tone edit，默认 `hold + clean`。触发必须读句尾、连续相似度、Jungle 自身密度与 crossVoice 冲突；不得用无证据 RNG 把效果叠成“随机 glitch”。

### 9.5 建议开发顺序

1. P0：移除错误的年度走向 UI，扩展色彩菜单，加 progressionId / tempoIntent / 黄昏换色频率硬约束。
2. P0：HUD 换成定性时间流速，并为 tempo 变化加小节级 slew，不直接跳 BPM。
3. P1：季节 botanical 背景（已完成），保持现有日夜与换季过渡。
4. P1：Jungle transient 切片表 + phrase-end retrigger + dropout，每次只上一种编辑并听感验收。
5. P2：dub/filter/crush/reverse 和 Think/Apache 资产，最后才开放给 Agent 组合。

## 10. 新需求池：Intelligent Jungle / 进入页 / 生产配置 / 行为稳定性（2026-07-22）

### 10.1 P0 收拢生产 LLM 配置与诊断信息

现状：页面仍暴露“设置 / 诊断”“第 N 天 · 昼夜阶段 · 当日和弦”“LLM+规则兜底”和 MiniMax API Key 输入；浏览器还能从 `localStorage` 读取用户 key，并在 `bird_agent → MiniMax → policy` 间切换。这些是开发期诊断能力，不应进入当前产品表面。

目标契约：

- 从产品 UI 移除设置/诊断区、精确日序/昼夜/和弦诊断串、provider 状态和 MiniMax API Key 输入；需要保留的运行诊断只进开发控制台或受控 debug 开关。
- 生产环境只配置 Spark 上的 StepFun 服务，密钥和 endpoint 只在服务端/部署环境注入，浏览器不保存、不输入、不透传第三方 API Key。
- 默认本地与无服务环境不接入任何 LLM API Key，直接运行确定性规则层；StepFun 不可达时静默回落规则层，不再串行尝试 MiniMax。
- 删除前先盘点 `bird_agent`、MiniMax、external master 和 smoke tool 的真实调用方；历史客户端可保留为非默认开发模块，但不得进入生产 bundle 的启动路径。

验收：无配置首次进入时不出现 key/provider/诊断文案且音乐可运行；Spark 生产部署只观察到 StepFun 一种远端 provider；断网不会卡住黎明或改变 transport。

### 10.2 P1 用世界画面构成音频进入页

- 进入页背景复用已选 botanical 季节背景与树/树干合成画面，明确不绘制鸟、Sequence 节点、年轮或调试 HUD。
- 背景比主场景更模糊、更弱；基于当前 50% / 1.6px 参数单独调低进入页不透明度并增加模糊，不反向修改主场景已验收参数。
- 唯一主操作文案统一为“进入（启用音频）”；保持真实用户手势启动 AudioContext，不能自动播放绕过浏览器策略。
- 进入后释放该背景层，避免长期保留第二套 Canvas 动画或大图合成造成帧率/显存负担。

验收：进入页与主世界一眼同源、无鸟、按钮含义明确；桌面和 390px 均不裁掉树的主体；点击一次后音频正常启动且遮罩不拦截交互。

### 10.3 P1 全局文案转向 “Intelligent Jungle”

定位：`Intelligent Jungle` 同时指 Jungle 音乐类型、人工智能构成的丛林，以及鸟群/季节/树与声音互相塑形的产品世界观。

- 先建立文案清单，再修改标题、进入页、HUD、信息栏、空状态、接管/交回、决策历史与 tooltip；保留 BPM、Mute/Solo、Sequence、和弦等不可替代的专业术语。
- 对用户隐藏实现词：LLM、API Key、规则兜底、provider、debug、policy；面向用户改写为“林群意图、季节走向、声部接管、生态回应”等可感知概念。
- 不把每个控件都强行 jungle 化；音乐制作常用词保持准确，世界观只负责解释关系和行为。
- 中英文命名先统一层级：产品名使用 `Intelligent Jungle`，中文说明使用短句，不混用“智能丛林 / AI Jungle / Latent Cosmos”三个品牌名。

验收：新用户无需理解模型架构即可知道如何进入、选声部、接管、退出和读懂变化；专业用户仍能准确识别音乐控制含义。

### 10.4 P0 Master / Bird 长期行为稳定性审查；虫 Agent 暂不直接立项

审查状态：**已完成**。通过 Orca orchestration 派发 Claude 只读审查（task `task_5d541144fb2b` / dispatch `ctx_5da8a12aa5d2`）；仓库零改动。实跑 346 项 MVP 测试、16 天 eval 与固定 seed `20260721` 的 64 天探针。

核心结论：当前不是“稳定收敛”，而是 **Sequence 模式下反馈闭环断路后冻结**。

- 四树第 1 天后都有 `sequencePattern`；`world.js` 在 `onDawn()` 与 `behaviorStep()` 对这类树提前 `continue`，导致 `dwellBeats`、`activeBars`、密度档、`vocalizeBias`、hop 和家枝变异没有执行机会。
- 64 天中四树起音格数恒为 Pad 3 / Melody 8 / Bass 3 / Texture 9；Melody 分数长期 0.60–0.633，但仍高于 Master 的绝对低分阈值 0.4，所以均衡通道 0 次触发。
- Master 剩余可见变化主要来自三天换色、冷却和换季日历；`patternSimilarity` 只进入 reason，不独立触发。当前 Master 更像开环日历发生器。
- `world` 与 `economy` 对 `meanDwell` 是否计入 `cause:sequence` 使用不同口径，造成“扣分依据”和“规则纠偏依据”互相矛盾。
- 现有测试证明纯函数、校验、确定性和不崩，但没有证明 setter 在 Sequence 模式下真正改变声音，也没有每树最低分、长期变化率或“带外观测经过 N 天向带内移动”的方向性测试。

#### P0：先接通反馈

1. Sequence 只接管起音时刻，不整树跳过行为层；在 `sequenceStep` 触发前保留 `activeBars` 活跃窗、`densityTier` 参与鸟数与 `vocalizeBias` 发声概率过滤。
2. 统一 `world` / `economy` 的 `meanDwell` 口径，并用同一事件流断言两者相等。
3. 为非 Jungle 声部增加最小 `gridDrift` 执行器：当 `onsetCount` 偏低/偏高时每天最多增/删 1 格；仍保留最多 2 次搬移，总预算 ≤3，硬夹偏好带，USER 树跳过，前后日 Jaccard 过低则放弃整包。

#### P1：让“稳”可被证伪

1. eval 增加每树下限和变化率闸门，避免 Bass 1.0 把 Melody 0.60 平均掉；候选为 `min(perTreeScore) ≥ 0.55` 与 32 天网格 Jaccard 距离落在 `[0.05, 0.5]`。
2. 增加反馈方向性回归：构造起音格数带外树，跑 16 天，断言逐步进入偏好带且不越界。
3. 将 `evaluateDay` 改为 suggestion → resolver，避免多个指标按代码顺序重复同向压到下限。
4. 重标 Master 低分判据；当前绝对 0.4 不可达，优先评估相对四树中位数的落差，再决定是否采用约 0.65 的绝对下限。
5. 重标或删除 crossVoice 的死路径：实测冲突 ≤0.07，而 suppress 阈值为 0.8；`encourageBias=1` 与 hold 完全相同。

#### P2：结构卫生

- 修正 `ruleSequencePlan(day=0)` 的负索引；eval 增加 `F-noSequence` 隔离混杂因子；外部/LLM Master 统一输出 evidence schema；事实文档明确 Sequence 模式下暂时失效的行为参数。

虫 Agent 结论：**现在不立项**。系统已有约 90 次/64 天的规则家枝扰动，但都落入同一执行黑洞；新增对抗 Agent 只会污染归因。待上述 P0 接通且长期测试仍证明系统落入高分静态吸引子，再考虑最小虫机制：全世界每日最多删除 1 个最规律网格，任一树分数 <0.4 或空白率 >0.45 时全局禁用，连续三天无改善则休眠 8 天；绝不允许碰和声、张力或自由调用 LLM。
