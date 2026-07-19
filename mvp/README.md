# Phase 1.9 · 双树同屏和声化日循环 MVP

pad 树（斑鸠）+ melody 树（百灵）等大并排同屏：两群鸟各归各树、各自独立音色
（pad 慢起音持续铺底、melody 拨弦短衰减单音线），和声每日推进、家枝按最近音级迁移，
评估流水线在日界运行，LLM 个性层可经 key 接入。规格：`../docs/rebuild-plan.md` §3.5.3。

## 怎么跑

```bash
python3 -m http.server 8000   # 仓库根目录
# 打开 http://localhost:8000/mvp/
```

点「▶ 进入（启用音频）」。控件与读数：

- **双树同屏**：左 pad 树（5 鸟，复音持续）、右 melody 树（3 鸟，镜像贴图）。
- **melody 单音性**：独占枝头——第二只落 melody 树 0.9 被弹开继续飞，0.1 装饰双音；
  音频侧 melody voice 单音优先（新音顶旧音）双保险。
- **乐句保持期**：melody pattern 连续 H 个昼夜（默认 4，agent 在 2–8 自选）不做日界变异，
  期满小变（≤2 处、邻枝优先、禁整句重掷）；日志可见「乐句保持中/期满小变」。
- **tempo 滑条**（50–140 BPM）：昼夜时长 = 4 小节 × 4 拍 × 60/BPM 派生，即时生效；
  world/agent 内部时长全部拍/小节化（驻留=拍、活跃窗=小节），变速不改音乐行为。
- **transport 行**：第 N 天 · 第 X 小节.第 Y 拍 · 当日和弦（季节）· BPM。
- **key 自动加载**：`local-config.js`（`window.LCS_KEYS.minimax`，gitignored）→
  localStorage → 输入框；输入框输入后写 localStorage。状态行标注 规则层/LLM+规则兜底。
- 侧栏：枝位面板按树分组；决策日志按天分组，flock/master 决策带来源标签。

## 怎么测

```bash
node --test mvp/test/*.test.js   # 87 个测试
```

Phase 1.9 新增/变更：

- 双树世界形状（两树物种/鸟群/几何、treeId、xOffset 布局约束）。
- 单音性弹开概率（rng 注入：恒 0.5 全弹开 ≤1 只、恒 0.95 允许装饰双音 ≤2 只）。
- holdLoops：保持期内 melody 零变异、期满小变 ≤2 且邻枝优先、holdLoops 由计划采纳。
- 拍→秒换算（beatsToSeconds + 驻留拍数不随 tempo 变）。
- 双 voice 参数分离（describeVoices：pad 复音持续 vs melody 单音拨弦）。
- 计划契约对齐 §3.5.3：`{dwellBeats, activeBars, holdLoops, mutations[]}`
  （与 llm/integration.js 的 mapFlockPlan 收敛一致；pipeline mock 同步更新）。

## 分层（硬边界）

```
world.js    生态内核：双树双 flock、家枝/归巢/驻留预算/换枝配额/单音弹开（全天本能）。
            时长全部拍/小节（按 BPM 换算秒执行）；emit 事件带 treeId。
harmony.js  和声层（纯函数）：chordForDay/seasonForDay/migrateAssignments/transportFromPhase。
agent.js    evaluateDay（规则层）+ planFromLlm + attachPipelineConductor：
            双 flock 计划、holdLoops 保持期状态机、master 和声游标。
llm/ master/ 另一 worker 交付（本 Phase 不动）：MiniMax 客户端/调度/集成契约/master 决策。
mapping.js  唯一翻译点（纯函数）：枝+和弦+音区偏移→音高、力度三档、驻留→时值。
audio.js    双音色：pad 复音持续（saw 慢起音长释放）/ melody 单音拨弦（新音顶旧音）。
renderer.js duotone-riso 贴图渲染（双树镜像/缩放）：{render, flash, resize}。
config.js   全部参数唯一住所：trees/物种矩阵/progression/tempo/llm/visual 三 token。
```

## 已知边界（留给后续 Phase）

- 音频需用户手势启动；未启动前事件静默丢弃。
- 双树贴图中部枝梢自然交叠（grove 构图）；Phase 3 四树时需重新排布。
- master 的 seasonPalettes 每季当前仅 'base' 一条路径。

