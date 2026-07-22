# 优化方案（2026-07-20）——7 路独立评估后的减法改造

> 依据：7 路独立评估（6 worker 各专属 seed + coordinator live），汇总见 `/tmp/eval-SYNTHESIS-and-plan.md`
> 与 `/tmp/eval-{species-fidelity,agent-brain,ecosystem-emergence,overconstraint-audit,musicality-vs-random,degenerate-states}.md`。
> 量尺 = 北极星①音乐性>随机 ②生态/生命涌现 ③平衡 ④agent 是生物·音乐是副产品（eco-sequencer §0 原则1）。

## 江南拍板（2026-07-20）
1. **总方向 = 减法为主·拨回涌现**：walk back 2026-07-20 上午的 pad 强制三和弦（route A）+ 拆 bass 隐藏琶音器，恢复「枝=note」，接受偶尔不完整和弦=生态可变性。净机制数应下降，只加一条脉感本能。
2. **决策脑 = 先只拆确定性**：不重构 master/conductor 架构；把 master「日历化」拆掉（保持当前色/季长真随机/新鲜度复活），先看 F−C 是否出现可见增值再谈更大改动。
3. **范围 = 全部 T0–T4**。

## 核心诊断（统一）
> 「该约束的（拍感、错峰）没约束，不该约束的（pad/bass/master 逐日细节）约束死了。」
> 且近期改动（pad 三和弦、melody 密音格、cross-voice bias）都在往 mapping/config 塞音乐规则，离「生存副产品」越来越远。

## 明确不要做（全员反面清单，实施者必须遵守）
- 不 onset 硬量化到网格、不做旋律句法模板、不做声部轮值表/呼应规则书。
- 不给 economy 再加惩罚项/多目标耦合、不给 master 加新观测通道。
- 不动事件模型/分层铁律（world 永不懂音高）。
- **减机制优先于加机制**；任何"加生机"若能用已有旋钮的未用行程达成，就不许新增概念。

---

## 分层改造清单（T0–T4）

### T0 · 恢复「枝=note、音乐是副产品」
- **T0.1a 撤 pad 强制三和弦（removal 部分）**：`mapping.padVoicingAssignments`/`harmony.padTonesFromFrame` 不再按 birdId 强制指派 root/5th/color。**pad 每只鸟只发它本枝的和弦音**（回到 noteFromBranch），音色层保留八度叠加/微失谐/呼吸/chorus 做厚（config.audio.timbres.pad 的音色部分保留，仅去掉"和弦角色指派"逻辑）。接受同枝同音级塌成八度=诚实的生态结果。
- **T0.1b 和弦从生态涌现（addition 部分，属 T2 波·agent.js）**：pad 的和弦完整度改由**黎明家枝分布**涌现——conductor 在黎明给 pad 下发一个"音区/音级多样性"软枝偏好（复用已有 `pushBranchPreferences` 接线：world 只收 0..1 权重，语义在 conductor 侧），让活跃 pad 鸟倾向落到音级互异的枝。软偏好、非强制；偶尔不完整和弦允许。
- **T0.2 拆 bass 隐藏琶音器**：`audio` 的 bass `triangleArp` 固定 `[0,1,2,1]` 音池删除；**每只鹈鹕持续/轻脉冲它本低枝的音**（枝→音），保留滤波/饱和/包络/张力密度对"脉冲快慢"的影响（可保留 tension→每拍/半拍的重复速率，但音高来自各鸟栖枝，非独立音池）。config.audio.timbres.bass 相应调整。
- **T0.3 评测器加"可听分"列**：`eval/harness.js` 让 audio/mapping 的真实发声（pad voicing、bass 实际音）也能被 headless 采集；输出两列——物理枝分（现状 noteFromBranch）与可听分（真实 MIDI）。两列偏离=具身因果损失指标。pad/bass 回归后两列应趋同。不改玩法，只让记分牌测真系统。

### T1 · binary 执行器改梯度（改已有旋钮，不加概念）
- **T1.4 cross-voice 用满 vocalizeBias 0..1**：`config.economy.crossVoice` + `economy.createCrossVoiceObserver.biasHintsFrom` + `agent.pushVocalizeBiases`：suppress 的 bias 从 0 改 **0.4–0.6**（减弱发声而非整树掐灭）；`conflictThreshold` 0.9→**~0.8**（呼吸成日常非急救）；同日多树超占改**轮换单选**（suppressCount→1 + 记录"上次被压最久者"轮值），杜绝 pad+bass 同灭/隔日方波；**删除 `suppressExclude:['melody']` 白名单**（保护应来自物种偏好带，不是作曲豁免）。
- **T1.5 holdLoops 改软**：`agent.applyHoldLoops` 保持期内不再 `mutations:[]` 硬清空；改为**降低 roam 权重**（或仅"无拥挤且得分在带内"才冻结），让 melody 保持期内仍能因生态偏离适应。

### T2 · 拆大脑的确定性（不重构，master/policy.js）
- **T2.6 master 平稳默认"保持当前色"而非按日轮转**：`policy.js` 平稳分支不再 `colorId = colors[seasonDay % n]`；改为**保持 currentColorId**，只在 streak 低分/新鲜度腻值(BORED_DAYS)/季末日才换色 → 复活休眠的新鲜度三观。
- **T2.7 季长真随机**：季长在菜单 `[8,16]` 内用 rng 取一次（非恒中值 12）。
- **T2.8 色彩轮转起点带生态相位**：换色时下家不必固定顺挂，可按一个生态量（如上季最低分树索引）偏移起点——仍是"只点菜不发明菜"。

### T3 · 唯一的加法——拍感做成本能（world.js）
- **T3.9 驻留到期吸拍**：`world.behaviorStep` 里，鸟"驻留预算耗尽、决定起飞"的**那个时刻**吸附到最近拍点（±0.25 拍内）；飞行时长、落枝 onset 一概仍自由。一条本能规则（"按拍呼吸"），不是量化器。config 加一个"吸拍窗"参数。预期 rhythm 贴拍/IOI 脉冲上升，不碰其他维。

### T4 · 边界一行修
- **T4.10 sparse 灭族**：`world.densitySizeForTier` birdCount>0 时下限 1。
- **T4.11 换季边界色彩解冻**：季末日/冷却期色彩保持**轮转**而非保持 current（拆换季 4–5 天色彩冻结链）。
- **T4.12 holdLoops 期满真变**：期满小变若未改变 branch set，强制≥1 换到新枝（消灭"名义变异实际不变"）。

---

## 实施波次与文件边界（单写者铁律：同一文件绝不同时给两人）

### Wave 1（两单并行·文件不相交）
- **W1-A 声音回归+拍感+边界**（强开发）：`mvp/src/mapping.js`、`mvp/src/harmony.js`、`mvp/src/audio.js`、`mvp/src/config.js`、`mvp/src/world.js`。
  含 T0.1a（撤 pad 强制）、T0.2（拆 bass 琶音器）、T3.9（拍感吸拍）、T4.10（sparse 下限）。**独占 config.js 与 world.js 本波**。
- **W1-B 可听评测**（验证向）：`mvp/eval/harness.js`、`mvp/eval/run.js`。T0.3。与 W1-A 文件不相交，并行安全。

### Wave 2（W1 完成释放 config.js 后再派·touches agent/policy/economy + config.economy 段）
- **W2-A 大脑拆确定性**：`mvp/src/master/policy.js`（+ 必要时 `agent.js` 的 master 接线）。T2.6/2.7/2.8、T4.11。
- **W2-B 错峰梯度+holdLoops+pad 涌现+期满真变**：`mvp/src/agent.js`、`mvp/src/economy.js`、`mvp/src/config.js`(仅 economy.crossVoice 段)。T0.1b（pad 家枝多样性软偏好）、T1.4、T1.5、T4.12。
  - W2-A 与 W2-B：policy.js 与 agent.js/economy.js 不相交；**config.js 本波只给 W2-B**（W2-A 用既有 config 键，不写 config.js）。若 W2-A 必须改 config 先 ask。

## 验收（每波 worker_done 必附）
1. `node --test 'mvp/test/*.test.js'` 全绿；
2. `node mvp/eval/run.js --seed 4997971`（**空格形式！等号会回落默认**）+ 至少 2 个别 seed，六维对比 before/after：目标是 **F 不回归和声/行为/音高**，且 **密度互补↑、节奏贴拍↑（T3 后）、F−C 出现可见增值（T2 后）**；密度互补不再靠整树静音换取；
3. 具体现象证据（不是泛泛）：pad/bass 回归后可听分与物理分趋同；cross-voice 不再 binary；master 不再日历轮色；
4. 不 commit（江南统一验收后再提交）。分层铁律：world 永不懂音高。
