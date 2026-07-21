# LLM 个性层集成契约

本目录是 Phase 2 的独立边界：`client.js` 一次向 MiniMax 提交整个世界的聚合生态状态，`scheduler.js` 只在集成方主动调用 `requestDayPlan(snapshot)` 时工作。模块不订阅 world、不写 world、不读取 DOM，也不拥有纯规则 `evaluateDay`；因此离线、超时、输出异常时不会阻断昼夜循环。

## 接入点

在白天日评估路径调用 `createAgentPipeline().dayReview(...)`，并在下一次黎明用 `dawnPlan()` 同步领取已就绪结果。返回非 `null` 时应用对应 flock 的音乐单位计划；未就绪或失败时保留规则层标记并原样执行纯规则路径（G7），不得等待重试或停住 world。超时属于外部注入的 scheduler 职责，integration 不另设计时器。

```js
const llmClient = createMinimaxClient({ apiKey });
const llm = createDayPlanScheduler({ client: llmClient });
const pipeline = createAgentPipeline({ flockScheduler: llm, masterDecide, masterFallback });
pipeline.dayReview({ day, flockSnapshot, masterInput }); // 不 await，不阻塞 world
// ...下一次黎明：
const plan = pipeline.dawnPlan();
if (plan.flock.fallback) return evaluateDay(stats, assignments, cfg, rng);
return applyBeatPlan(plan.flock.plan.flocks[0]);
```

接线者只需让白天复盘发起一次 `dayReview`，让黎明前置钩子调用一次 `dawnPlan`；不要同时运行两个会写回 world 的日评估处理器。

## 输入数据形状

集成层只提交聚合值，不提交渲染、音频或 UI 状态。`dayPhase` 可用 `dawn/day/dusk/night`
或 `0..1`；`season` 为当前季节 id（spring/summer/autumn/winter，T6 起已接线）。
master → sub 的生态投影在快照根级平铺：枝 id 集合 + 张力 +
色彩档 id，不带任何 MIDI 音高。

```js
{
  day: 12,
  dayPhase: 'dawn',
  season: 'spring',
  tension: 0.35,
  skeletonBranchIds: [0, 1, 2],
  colorBranchIds: [3, 4],
  colorId: '挂四',
  decisionMenu: {
    dwellBeats: [0.5, 16],    // 驻留拍数候选范围
    activeBars: [0, 4],       // 活跃窗小节数范围
    holdLoops: [2, 8],        // 乐句保持的昼夜循环数范围
    maxMutations: 2
  },
  flocks: [{
    species: 'pad',
    energy: 0.62,             // 0..1，群体均值
    perchFlyRatio: 0.75,      // 0..1，栖枝数 / 总数
    homeBranches: [0, 0, 1, 2, 4], // 每只鸟当前家枝（mutations.from 只能取自此）
    sequencePattern: {        // 刚结束 loop 的 5×16 起音占位摘要
      version: 2,
      pitchBranchCount: 5,
      stepCount: 16,
      occupiedCells: [{ pitchBranchId: 2, stepIndex: 7, count: 2 }]
    },
    treeCondition: { health: 0.9 },
    harmonyScore: 0.92,       // T6：和谐分观测（骨架 1.0/色彩 0.7/框架外 0 的发音秒加权）
    dailyStats: {
      branchLoads: [2, 1, 2, 1, 2],
      meanDwellBeats: 8,      // 拍（主字段）
      switches: 1,
      silentRatio: 0.08,
      densityTier: 'normal'
    },
    ecology: {                 // 可选；缺省时整段省略
      branchChangesPerLoop: 1,
      sequenceOnsetCount: 3,
      intervalRegularity: 0.75,
      meanDwellBeats: 8,
      clusterSize: 2,          // 全天同枝负载的时间加权 P90
      clusterPeak: 3,          // 瞬时峰值，只作告警
      score: 0.86,
      harmonyScore: 0.92,      // T6 起随 latestEcology 携带
      deviation: { branchChanges: { direction: 'low', amount: 0.5 } }
    }
  }]
}
```

菜单也可放在单个 flock 的 `decisionMenu` / `menu` 上覆盖世界默认值。可选 `ecology` 只接受示例中的日评估摘要字段，未提供时不会在模型输入里制造空段。客户端会白名单化常见标量和短数组、忽略旧秒制驻留字段、夹紧 `energy` / `perchFlyRatio`，并在一个请求里按输入顺序评估全部 flock。Bass 的节奏偏离读 `sequenceOnsetCount` 与 `intervalRegularity`，不再用换枝次数代理。system prompt 只包含生态与节拍词汇，明确要求单行 JSON；请求体不能添加 MiniMax 不支持的 `response_format`。

## 输出与失败语义

```js
{
  flocks: [{
    dwellBeats: 8,            // 驻留拍数，越界时夹到菜单
    activeBars: 2,            // 活跃窗小节数，越界时夹到菜单
    holdLoops: 4,             // 必须是菜单内 2–8 的整数，否则整份计划失败
    mutations: [{ from: 3, to: 1 }],
    cellMutations: [{
      from: { pitchBranchId: 2, stepIndex: 7 },
      to: { pitchBranchId: 3, stepIndex: 9 }
    }]
  }]
}
```

`cellMutations` 是严格原子编辑：来源必须属于输入 `sequencePattern.occupiedCells`，目标必须是同一网格内空格；坐标越界、空来源、目标冲突、链/交换或超过 `menu.maxMutations` 会使整包返回 `null`。迁移期旧 provider 可省略该字段，但 bird_agent 结构化 schema 已将其列为必填。

- `flocks` 数量与输入不一致、新 schema 的五个计划字段缺失、`holdLoops` 在菜单外、HTTP 非成功、200 内 `base_resp.status_code !== 0`、响应 JSON 无法提取、网络错误或超时，统一视为失败。旧 provider 只兼容省略 `cellMutations`；旧 `dwellSeconds` / `meanDwell` 等字段不会被转换或透传。
- 调度器对任意失败返回 `null`。第 1/2 次连续失败按 1/2 个昼夜指数退避；第 3 次连续失败打开断路器，5 个昼夜内不再发请求。冷却结束后的首次成功会清零状态。
- 同一时刻只允许一个请求；黄昏处理器重入会复用同一个 Promise，不会再发第二次请求。
- 默认超时 3000ms；main.js 接线时按半个昼夜派生覆盖（`config.llm.timeoutDayFraction`，随 BPM 同步）。客户端额外校验 MiniMax 的 `base_resp.status_code`，因为 HTTP 200 不等于业务成功。

## provider 链：bird_agent → MiniMax → 规则兜底

`openai-client.js` 的 `createBirdAgentClient` 接入本地 bird_agent 推理后端
（OpenAI 兼容，`../../../docs/api-8081-bird-agent.md`）：json_schema 结构化输出、
reason 自由文本放 properties 首位（mini-CoT）、`<think>` 前缀剥离、单次超时 60s、
失败退避重试一次并沿用上次决策。页面装配（main.js 的 `pickFlockProvider`）按
`window.LCS_KEYS.birdAgentBase` 配置 + `GET /v1/models` 健康检查决定是否入链：
未配置或非 200 时落 MiniMax（只打一行回落日志）；master 侧同理按
external → llm → policy 顺序求值。

## Master 决策契约

旧命令协议（`set_population` / `set_daynight` / `set_scale` / `spawn_pest_wave` 与
`master.ops`）**已全部废弃**。master 现为菜单式和声决策（契约详见
`../master/README.md`）：

- 普通日：`{ colorId, tension, duskColorShift, reason }`（`duskColorShift` 显式决定黄昏是否换同根色彩）
- 季末日：可加 `{ nextSeason, seasonLength }`（seasonLength 限 8–16 范围）

LLM 输出经 `normalizeMasterDecision` 白名单校验，任何越菜单/越界/非季末日换季
整单作废（返回 `null`）回退规则层；flock 计划永远不写入这个决策域。
