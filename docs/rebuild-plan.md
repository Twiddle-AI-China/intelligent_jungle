# 树-鸟生态音序器：重构分期计划

> 2026-07-18 起草。背景：`feat/four-trees` 的四树版完成度粗糙，决定从单树 MVP 重新细做，
> 一期一期往上加。本文是重构的总规格书；美术方向另行由示意图比稿决定（见 §7）。

## 1. 现状 review 结论（为什么要重来）

**架构问题**

- `src/app.js` 是上帝文件：摄像机、和声、触发、agent 循环、HUD、输入全部内联，
  大量单行压缩式代码，魔法数散落（0.15/0.8 去抖、1.8s agent tick、镜头 scale 2.6…），
  没有统一 config 层。
- 号称「鸟落枝即鸣」事件驱动，实际是每帧轮询全体 boids + 字符串 key 的去抖 hack
  （`dwell < 0.15` 判「新落」，0.8s 冷却），会漏触发/重触发，不是真正的事件模型。
- 映射层号称「固定单向翻译」，但 `ROLE_BANDS`、和弦重建逻辑一半住在 app.js 里，分层是漏的。
- `storybook-renderer.js` 1244 行过程式 canvas 绘画，美术风格焊死在代码里——这就是
  美术难看又难改的根源。渲染器没有接口抽象，无法换皮。

**Agent 问题**

- LLM 层每 flock 每 ~1.8s 一个 HTTP 请求，for 循环里顺序 await（4 群 × 2s 超时最坏 8s），
  `runAgents` async 但无并发保护，可能重入竞态。无批量、无退避。
- Master agent 的 LLM 侧（玮圣服务）实际不存在，只有代码兜底。
- Agent 决策不可观测：没有决策日志面板，reason 字段拿到了也没展示。

**工程问题**

- README/package.json 仍描述旧的 boids-BRAVE 乐器（XY 地图、neural decoder），
  `npm run dev` 起的是 research 服务器，而 eco 版靠 `python3 -m http.server`——
  两个产品缠在一个仓库里，入口混乱。
- 34 个测试全过但偏浅：触发去抖、音频映射契约、agent 循环时序都没有测试。

**结论**：生态→映射→音乐的三层理念是对的，保留；实现全部推倒，按接口边界重写。

## 2. 重构原则

1. 新代码全部住 `mvp/`，自包含（`mvp/index.html` + ES modules，无构建，
   `python3 -m http.server` 即跑）；旧 `src/` 冻结不动，只作参考，跑通后再替换。
2. **事件驱动**：world 内核产生显式事件（`perch` / `unperch` / `dawn` / `season`…），
   音频、渲染、HUD 都是事件订阅者。禁止每帧轮询推断状态变化。
3. **分层硬边界**：`world`（生态，无音乐词汇）→ `mapping`（唯一翻译点，纯函数）→
   `audio`（只认音乐参数）→ `renderer`（只认 world 快照，接口化，可整体换皮）。
4. 所有调参数进 `config.js`，禁止代码里裸魔法数。
5. 每期有明确验收标准，验收过了才开下一期。

## 3. Phase 1 —— 单树 MVP（✅ 2026-07-18 完成）

> 状态注：本节「夜里归栖、黎明晨鸣」的作息设定已被 §3.5.1.3 **废除**
> （夜晚不静默）；晨鸣保留为换和弦标记音。其余按原样交付。

**目标：一棵树把「生态→事件→声音」和「agent→行为」两条链跑通。**

范围：

- 一棵树（和鸣树/斑鸠即可）、一群鸟（6–10 只）、枝干 = 和弦内音（5 枝，A 小调）。
- 鸟的栖/飞两态 + 简单绕树飞行；**栖落/离枝作为事件**由 world 内核发出。
- 音频：每树一个简单 Web Audio voice；`perch` 事件 → 触发该枝音符，
  力度=同枝鸟数三档，时值=驻留时长（离枝时收尾）。
- 昼夜循环（唯一大循环）：夜里归栖、黎明晨鸣。
- 确定性 agent（规则版 flockPolicy）按 tick 输出 `dwellUrge`，tick 与渲染帧解耦，
  决策带 reason 并写入可见的决策日志。
- 占位美术：干净的极简形状（圆点鸟、线条树），**不做风格化**——风格等比稿结果。
- 测试：事件发射正确性（落枝恰好一个 perch 事件）、mapping 纯函数、agent 规则边界。

验收：静态服务器打开页面 → 能听到鸟落枝发声、昼夜节律可见可听、
决策日志滚动显示 agent 每次 tick 的 dwellUrge 与理由、`node --test` 全绿。

## 3.5 Phase 1.5 —— 日循环重设计（✅ 已实现；后续小节持续演进）

> 状态注：矩阵中「活动时段窗口」一行随 §3.5.1.3 废除作息后**弱化为可选参数**；
> 「黄昏评估」时序已被 §3.5.1.4 流水线（今天复盘昨天、明天生效）取代。

**核心修正：一个昼夜 = 一个 loop/sequence。** 白天栖枝的模式就是这一遍乐句；
agent 不再持续干预鸟的起落（每 1.8s 改 dwellUrge 是错的），而是**在日界做变奏决策**，
让编曲在一天天的循环上发展——像 generative sequencer 的迭代变奏。

机制：

1. **家枝（homeBranch）**：每只鸟记住自己的栖枝，黎明按「恋枝性」概率返回家枝
   → 今天的 pattern ≈ 昨天的 pattern，循环因此成立。
2. **日界变奏**：agent 在黄昏评估一整天（而不是每 tick），输出明日变奏：
   变异少数几只鸟的家枝、调整密度档位、调 dwell 基线。日内只剩本能物理（飞行、体力）。
3. **换枝配额**：日内换枝受物种配额限制，防止 pattern 内碎变。
4. 宏观形式：季节（跨多日）= 和弦色彩变化，构成大结构。

**物种行为矩阵（生态词汇 → 乐器角色）**：

| 生态参数 | 斑鸠/pad | 百灵/melody | 鹈鹕/bass | 啄木鸟/texture |
|-|-|-|-|-|
| 恋枝性（黎明返家枝概率） | 0.9 | 0.4 | 0.95 | 0.6 |
| 驻留时长尺度 | 很长（整段日相） | 短（数秒跳枝） | 极长且低枝 | 中短、高频微动 |
| 日内换枝配额 | ≈0（只在日界变） | 高 | 0（只随换和弦/换季） | 中 |
| 同枝/多枝群聚 | 多枝同时栖 = 和弦 | 单鸟单枝 = 单音线 | 1–2 只低枝 | 散点 |
| 活动时段窗口 | 全日稳定 | 晨昏最活跃 | 稳定 | 午后为主 |

→ pad 长驻少变、和弦式群栖；melody 短驻多变、单线跳跃；bass 几乎不动、只随
大结构换音；texture 中等驻留高频微动。**每种乐器行为都必须能还原成生态性格，
不允许在映射层硬编码音乐行为。**

**行为的驱动机制补充生态计分（2026-07-18）**：每棵树偏好一种起落节奏
（换枝频率/平均驻留/群聚三个观测量的偏好带），树得分 = 行为与偏好的匹配度，
agent 日评估据此修正偏离。一个机制、四种参数化，
见 **docs/eco-incentive-design.md**（Phase 1.7 单树先验证）。

### 3.5.1 日循环模型 v2（✅ 1.6R 已实现，2026-07-18 江南修正）

1. **昼夜交替 = 和弦进行走一步**。每个昼夜是 loop 的一步和声脚步：
   config 里一条 progression（如 Am→F→C→G 循环），黎明换到当日和弦、
   枝干重构为该和弦音，家枝按最近音级迁移（voice-leading，pad 的
   「一起换」由此自然发生，无需额外机制）。
2. **季节交替 = 和弦色彩/调式**。若干昼夜为一季（config），季节切换
   progression 的色彩变体（如春 major/lydian、夏 sus/mixolydian、
   秋 dorian/m7、冬 aeolian/minor），构成大结构转调。
3. **删除作息不对称**。「白天活动夜里休息」在音乐上不成立——夜晚不静默，
   鸟全天演奏；昼夜只保留视觉（纸底反转）与和声节点（黎明换和弦）双重意义。
   agent 规则中的作息项、dwellUrge 的昼夜项删除。晨鸣可保留为换和弦的标记音。
4. **评估流水线**：第 N 天全天，agent 复盘第 N−1 天的完整数据，
   当天内返回计划，**第 N+1 天黎明与换和弦一起生效**。
   这同时给 LLM 留了一整个 loop 的时延预算（掉线即回落规则层，节拍不乱）。

### 3.5.2 音乐时间显示（✅ 1.8 已实现；v1 的空间网格方案被江南否决）

> 否决记录：曾设计「树冠 16 步量化 + 天体光柱扫步触发」——过度设计。
> 发声保持栖落事件驱动不变；sequencer 感只需要把时间**显示**出来。

1. **一个昼夜 = 4 小节 4/4 是时间换算概念**（不是空间网格）：
   **tempo（BPM）是主控旋钮**，昼夜时长 = 4×4×60/BPM 派生，取代裸秒数控件。
2. **transport 显示**：状态区显示 当前第几天 · 第几小节.第几拍 · 当日和弦 ·
   季节 · BPM。太阳/月亮弧线本身就是世界观时钟，不加扫描类视觉。
3. 休止与间隙由鸟的行为产生（起飞离枝、短驻、活跃窗），不靠网格。

### 3.5.3 音乐单位化 + 双树（🔨 实施中：Kimi 双树整包 ∥ codex schema 单位化）

> 对齐结论：双树**等大**并排；melody 留 **0.1** 装饰性双音概率；乐句保持期
> **H 由 flock agent 在 config 范围（2–8 循环）内自选**，默认 4。
> 计划字段统一契约：`{dwellBeats, activeBars, holdLoops, mutations[]}`。

1. **决策一律用音乐单位**：agent/LLM 计划的字段从秒改为**拍/小节/循环数**
   （驻留=拍、活跃窗=小节、保持期=循环数），world 按 BPM 换算成秒执行。
   好处：变速不改变音乐行为，LLM 的输出天然对齐节拍语汇。
2. **melody 单音性**：独占枝头习性——第二只鸟想落 melody 树时大概率被弹开
   继续飞（默认 0.9），小概率短暂双音作装饰。音频侧 melody voice 单音优先
   （新音顶掉旧音）双保险。
3. **melody 乐句保持期（记忆点）**：melody 的 pattern 连续保持 H 个昼夜
   （**默认 4 遍**）不做日界变异，第 H 天才小变异（≤2 处、邻枝优先）。
   和弦每日照常推进，pattern 按音级平移（voice-leading 已有）→
   **同一 motif 走过 F→C→G→Am = 重复中带和声色彩变化**，记忆点由此建立。
   变异幅度上限收紧：禁止整句重掷。
4. **双树同屏**：melody（百灵）+ pad（斑鸠）两棵树并存，替代 profile 切换。
   各自独立音色：pad = 柔和持续（慢起音 saw+滤波），melody = 拨弦/短衰减。
   树贴图复用现有资产（镜像/缩放做差异）。这是 Phase 3 四树的前两棵。
5. **MiniMax key 本地持久化**：gitignore 的 `mvp/local-config.js`
   （`window.LCS_KEYS`）+ localStorage 双通道，页面自动读取；
   状态行显示「LLM+规则兜底 / 规则层」。key 仍不进 git。

## 4. Phase 2 —— Agent 模式跑通（✅ 主体完成 2026-07-19）

- ✅ LLM 个性层（MiniMax）：批量客户端 + 调度器（单飞/退避/断路器），
  真实 API 冒烟通过（flock/master 各 3/3，延迟 2.5–3.6s）。
- ✅ Master agent：**命令协议改版**——旧的 set_population/set_daynight 等
  废除，改为菜单式和声决策（advanceStep / jumpToStep / changeSeason /
  nextPalette，见 eco-incentive-design.md §6）。三规则代码兜底 + LLM 个性层。
- ✅ 流水线接线（1.8）：白天 dayReview 并联 flock+master、黎明领取、
  未就绪规则兜底；决策来源标注（规则层/LLM）。
- 剩余：决策时间线面板（完整历史视图）；LLM prompt 打磨 + 玮圣外部 master
  接口位（🔨 已派 codex：prompt 措辞音乐单位化、预留 ecology/treeScores
  可选字段位；external-master.js HTTP 决策源适配器，来源顺序
  external → llm → policy 兜底）。

## 5. Phase 3 —— 四棵树 + 生态计分全量

> 修订：原「五流量经济（foliage/pest 等）」已被**偏好带计分**
> （eco-incentive-design.md v2）取代——概念更少。虫害等外生扰动是否加回，
> 等四树落地后按「概念要少」原则再评估。

- 前两棵（melody+pad）已提前在 §3.5.3 实施中；剩 bass（鹈鹕）/
  texture（啄木鸟）两树两音色 + 四树偏好带 + master 均衡项吃四树得分。
- richness/impurity 映射、跨树交互（传粉/应答）待四树后评估。

## 6. Phase 4 —— 演奏交互

- 镜头 zoom 贴近写谱（A–K 落鸟）、指针引导、控制权交接（AGENT/USER）、录制导出。

## 7. Phase 5 —— 美术定稿 + 打磨（视觉方案已定并落地）

> 实现方式修订（2026-07-19 江南定）：程序化 riso 绘制被
> **生成图抠 alpha 贴图**方案取代（codex gpt-image 生成同风格素材 →
> 硬分割抠图 → `mvp/assets/`），效果更好。三 token 色彩系统继续约束
> UI 与新增视觉元素（日月、光效）。
- 剩余：四树场景构图、音色打磨；远期接 BRAVE neural decoder（映射契约不变）。

**美术比稿结论（2026-07-18 定稿）**：三轮比稿后江南选定
**duotone-riso 双色版画**（`studies/art-directions/round-3/duotone-riso/render.png`
为视觉基准图；paper-silhouette 为备选参考）。视觉规格：

- **三个设计 token 管全部颜色**：`paper`（纸底，米白 ≈#F2EAD8）、`ink`（靛蓝
  ≈#2E3E8F，树/远景/UI 文字/线条）、`accent`（橙红 ≈#E75C26，只给鸟）。
  禁止出现第四个色相。
- **颜色只在鸟上**：鸟 = 音符 = 唯一彩色；树干枝干用 ink 带网点/颗粒质感
  （riso 版画肌理，可加极轻套印错位）；地面一条 ink 细线，无花草杂物。
- **昼夜只动纸底**：白昼 paper 暖亮，夜晚 paper 转深靛蓝、ink 线条转浅纸色
  （双色反转），accent 不变色。发声瞬间鸟体微亮/微放大作为触发反馈。
- **UI 同语言**：侧栏/按钮/日志同用三 token，纸底靛字橙强调，无边框阴影渐变。

## 8. 进度快照（2026-07-19）

- ✅ 已交付并验收：Phase 1（单树内核）/ 1.5（日循环）/ riso→贴图视觉 /
  1.6R（和声化：昼夜=进行走一步、季节=色彩、流水线、月亮）/
  1.7 计分核心模块（economy.js，待接线）/ 1.8（BPM 主控 + transport +
  LLM 真实接线，key 本地化 `mvp/local-config.js`）。测试 62/62。
- ✅ 新增：LLM/master 决策 schema 音乐单位化（codex，23/23 专项测试绿）；
  Phase 2 收尾包（codex：prompt 音乐单位化 + ecology/treeScores 字段位 +
  external-master.js 玮圣接口位 + resolveMasterDecision 组合器，验收通过，
  组合器接线待 coordinator）。
- ✅ 新增（2026-07-19）：双树整包 1.9（Kimi #1，87/87）；timeline.js（Kimi #2）；
  recorder.js（codex）；coordinator 集成（economy 计分→侧栏长势+LLM ecology
  字段、timeline/recorder 挂载、external→llm→policy 组合器）；三修复
  （fetch this-绑定、驻留基线 NaN、秒/拍口径）+ no-store 开发服务器
  `mvp/tools/serve-nocache.py`（浏览器模块缓存曾致 LLM 零请求假象）。
- 🔍 cursor-agent（Grok 4.5 high）全量 review：报告
  `/tmp/task_95ef49ecdf9d_mvp_review.md`——2 P0（holdLoops 续期 off-by-one；
  越界变异日志与世界状态分裂）+ 10 P1（要点：activeBars=0 被吞、activeBars
  语义与 prompt 不符、mapFlockPlan 缺 flock 数校验、external 决策误标 llm、
  master 均衡吃体力而非生态得分、audio 硬编码 melody/pad = 四树最大阻塞、
  变速不重算在途驻留）。修复已排进四树逻辑包与 llm 修复包。
- ✅ Phase 3 主体（2026-07-19）：四树四物种四音色（codex 逻辑 ∥ Kimi#1 前端，
  契约先行前后端并行）；review 全部修复经 cursor-agent 复核 11 FIXED；
  llm 修复包（prompt 语义、flock 数量校验、决策三源标签穿透、clamp 遥测，
  Kimi#2）；economy 接线（含 event 字段 bug 修复）。全量测试 111/111。
  worker 池：codex ∥ Kimi×2 ∥ cursor-agent(Grok, review/验证)，
  coordinator 纯派单。
- 🔨 四树最终浏览器验收（Kimi#2）进行中。
- 📋 待办：Phase 4 交互剩余（zoom 写谱、指针引导、控制权交接——需先设计
  对齐）→ 音色打磨/场景构图；玮圣端服务真实对接（接口位已留）。
  **全部产出尚未 commit**。
- 工作流：docs/ 为唯一事实源；派工按全局 skill `design-dispatch`
  （想法→设计→对齐→派工→验收）。
