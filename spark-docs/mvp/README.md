# Intelligent Jungle MVP（原「四树生态音序器」）

**单棵纵向树**：四声部 pad（斑鸠）、melody（百灵）、bass（鹈鹕）、texture（啄木鸟）
沿树身纵向分区，相机纵向滚动浏览，各声部独立音色。**视觉是一棵树，世界模型仍是
四逻辑树**（`world.getSnapshot().trees` 不变；单树 UI 设计见
`../docs/single-tree-ui-design-2026-07-21.md`）。HUD 品牌显示 `Intelligent Jungle`。
和声按「**季 = 单和弦骨架（8–16 天）、昼夜 = 色彩档明暗**」演进
（`../docs/harmony-season-redesign.md`），换季日才做家枝最近音级大迁移，
评估流水线在日界运行，LLM 个性层（bird_agent → StepFun/规则兜底）可经
`runtime-config.js` 接入。规格：`../docs/rebuild-plan.md` +
`../docs/harmony-season-redesign.md` + `../docs/audio-voices-v3.md` +
`../docs/single-tree-ui-design-2026-07-21.md`。

## 生存经济（生命 / 体力 / 食物）

2026-07-22（PR #7）把三条并行影子分换成一个闭环资源循环
（`src/survival-shadow.js`、`src/survival-actions.js`）：

- **闭环 ledger**：树枝活动 `生命 → 体力`、音色探索 `体力 → 食物`、夜间进食
  `食物 → 生命`。**音乐事实只影响转换效率，不能凭空生成第三方分数**；每种资源
  留有不可侵犯的安全储备（`SURVIVAL_RESERVE`），硬储备优先于情绪。USER 日整日冻结。
- **Master 只选方向、不写数值**：策略菜单四选一——`休整 / 栖枝 / 探索 / 平衡`
  （`SURVIVAL_ACTION_IDS`），只调整资源转换预算与音色探索驱动力，**不直接改写
  音乐密度、驻留或 `activeBars`**——生存行动始终待在确定性音乐安全层之下。
- Agent / USER / 神经 XY·PCA / 本地 Jungle 探索四路证据分开计量。
- 附带：修掉 Melody 主题可能无限冻结的问题（保留 hold-loop 连续性）；新增确定性
  64 天门槛 + 四种子 × 256 天数值演化回归覆盖。

## Agent 音色漫游

Bass、pad、melody 的 Agent 通过生态行为间接控制神经音色：world 的栖驻、能量、
枝展开、驻留、换枝和邻近神经声部活动被固定映射为各自音色地图上的安全 XY 坐标，
以 10 Hz 更新并做慢速平滑。Agent 不直接写 latent；后端使用 kNN 混合真实训练 anchor。
进入某树 USER 特写时暂停该树自动漫游，退出后恢复。Texture/drums 不属于此功能，
也不会影响其他声部的映射。完整契约见 [`../docs/ecological-latent-control.md`](../docs/ecological-latent-control.md)。

后端行绑定（`config.js` 的 `voiceEngine.species`）：bass=行 0、melody=行 2（后端叫
`lead`）、pad=**行 `[1,4]`**（2026-07-22 起 2 行，之前 4 行；pad 真和弦最多 2 音）。
`pad.rows` 必须与后端 `poolSize=5` 的 `rowsBySpecies.pad` 一致，否则往不存在的行发音
静默丢弃——见 `../flock-voice-engine/docs/deploy.md` §9（收窄行数是为缓解共享 GPU 争用）。

## 怎么跑

```bash
npm run serve:mvp        # 无缓存 dev server（端口 4193，仓库根目录）
# 打开 http://localhost:4193/mvp/
```

点「▶ 进入（启用音频）」。控件与读数：

- **四树四音色**（audio v3，发声原理分家）：pad = 减法持续铺底（双 saw 失谐+sub）、
  bass = Karplus-Strong 拨弦琶音（节拍同步、密度随张力）、melody = FM 哨笛短句、
  texture = granular 噪声簇。频段占位 bass 50–300 / pad 180–2k / melody 800–4k /
  texture 2.5–6k，混响干湿分离按声部发送。
- **melody 单音性**：独占枝头——第二只落 melody 树 0.9 被弹开继续飞，0.1 装饰双音。
- **乐句保持期**：melody pattern 连续 H 个昼夜（默认 4，agent 在 2–8 自选）不做日界变异，
  期满小变（≤2 处、邻枝优先、禁整句重掷）；“林群回应”可见保持与变奏原因。
- **时间流速**（底层 50–90 BPM，Jungle 双速 100–180）：昼夜时长 = 4 小节 × 4 拍 × 60/BPM 派生；
  world/agent 内部时长全部拍/小节化（驻留=拍、活跃窗=小节），变速不改音乐行为。
- **产品 HUD**：仅显示 `Intelligent Jungle`、定性时间流速与必要演奏控制；精确日序、昼夜、和弦诊断不进入产品表面。
- **四季**：每季从受限菜单选择独立四和弦 progression，四天走完后重复第二圈；
  Master 每日决定是否在黄昏切色彩，换季日触发迁移。
- **生产 Agent 接线**：可选的 `runtime-config.js` 只配置
  `window.LCS_RUNTIME.stepfunBase`（参考 `runtime-config.example.js`），不含 API key。
  未配置或 Spark StepFun 不可达时静默使用确定性规则；浏览器不读写第三方 key，
  也不再串联 MiniMax。
- 侧栏：当前声部、四轨响度和生态计分；“林群回应”展示可感知的变奏与季节意图，
  不显示 provider、policy 或原始逐鸟诊断。

## 怎么测

```bash
node --test mvp/test/*.test.js   # 376 个测试（2026-07-22，含 PR #7 生存经济回归）
```

当前 376/376 绿（含 `survival-shadow.test.js` / `survival-actions.test.js` /
`long-horizon-evolution.test.js`：四种子 × 256 天数值演化 + 确定性 64 天门槛）。

## 本轮（T2–T20）要点

- **T6 和声内核**（`../docs/harmony-season-redesign.md`）：季 = 单骨架 8–16 天、
  昼夜 = 色彩档（只动高 2 枝）、换季日才 voice-leading 大迁移、季末日 bass 聚集预告；
  harmonicFrame 每黎明广播（对 LLM 只发**无音高生态投影**
  `{tension, skeletonBranchIds, colorBranchIds, colorId}`，MIDI 收敛在
  conductor→chordFromFrame→mapping/audio 链）；和谐分 H（发音秒按骨架 1.0/色彩 0.7/
  框架外 0 加权）只观测不进分，挂 dayReview/masterInput/latestEcology 三通道。
- **T2 晨鸣彻底摘除**（dawn 只剩昼夜宏切换）+ 音色 v2 EQ 分家 → **audio v3**
  发声原理分家（见上「四树四音色」）。
- **bird_agent provider 链**（见上「bird_agent 本地推理后端」）。

T6 测试变更（详见各测试文件头注）：

- 换季才迁移 / 色彩档只动色彩枝 / H 权重与 bass 全骨架 = 1 / bass 预告 /
  frame 输入位（上游优先、规则兜底）/ flock 快照无音高泄漏守卫（harmony-frame.test.js）。
- 删除 chordForDay 每日步进与 seasonDays 固定季长；pipeline/daycycle 断言按新语义更新
  （色彩档断言风盘成员而非固定序号；循环继承阈值含 1e-9 浮点容差）。

Phase 1.9 新增/变更（历史）：

- 双树世界形状（两树物种/鸟群/几何、treeId、xOffset 布局约束）。
- 单音性弹开概率（rng 注入：恒 0.5 全弹开 ≤1 只、恒 0.95 允许装饰双音 ≤2 只）。
- holdLoops：保持期内 melody 零变异、期满小变 ≤2 且邻枝优先、holdLoops 由计划采纳。
- 拍→秒换算（beatsToSeconds + 驻留拍数不随 tempo 变）。
- 计划契约对齐 §3.5.3：`{dwellBeats, activeBars, holdLoops, mutations[]}`
  （与 llm/integration.js 的 mapFlockPlan 收敛一致；pipeline mock 同步更新）。

## 分层（硬边界）

```
world.js    生态内核：四树四 flock、家枝/归巢/驻留预算/换枝配额/单音弹开（全天本能）。
            时长全部拍/小节（按 BPM 换算秒执行）；emit 事件带 treeId。
harmony.js  和声层（纯函数，季=单骨架/昼夜=色彩档）：skeletonForSeason/colorOptions/
            chordFromFrame/migrateAssignments（仅换季调用）/transportFromPhase。
agent.js    evaluateDay（规则层）+ planFromLlm + attachPipelineConductor：
            四 flock 计划、holdLoops 保持期状态机、harmonicFrame 构建
            （master 给 colorId/tension/nextSeason/seasonLength，否则规则兜底）、
            换季日大迁移 + 季末日 bass 聚集预告、和谐分 H 观测（骨架1.0/色彩0.7/框架外0）。
survival-shadow.js   生命/体力/食物闭环 ledger：树枝活动→体力、音色探索→食物、
            夜间进食→生命；音乐只调转换效率，安全储备不可侵犯（详见上「生存经济」）。
survival-actions.js  Master 生存策略菜单（休整/栖枝/探索/平衡）：只调转换预算与探索
            驱动力，待在音乐安全层之下，不直接改密度/驻留/activeBars。
llm/ master/ LLM 个性层与 master 决策（各自 README 为契约）：bird_agent/StepFun 客户端、
            调度器（单飞/退避/断路器）、policy 兜底、external 组合器。
mapping.js  唯一翻译点（纯函数）：枝+和弦+音区偏移→音高、力度三档、驻留→时值。
audio.js    四声部 v3：pad 减法持续 / bass KS 琶音 / melody FM 短句 / texture granular；
            独立 EQ + 混响发送（干湿分离）+ 全局昼夜宏。
renderer.js duotone-riso 贴图渲染（N 树数据驱动排布）：{render, flash, resize}。
config.js   全部参数唯一住所：trees/物种矩阵/harmony.bySeason/tempo/llm/visual 三 token。
```

## 已知边界（留给后续 Phase）

- 音频需用户手势启动；未启动前事件静默丢弃。
- Phase 4 演奏交互（zoom 写谱、指针引导、控制权交接）需先设计对齐。
- 玮圣外部 master 真实服务待对接（external-master.js 接口位已留）。
