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

集成层只提交聚合值，不提交渲染、音频或 UI 状态。`dayPhase` 可用 `dawn/day/dusk/night` 或 `0..1`；`season` 是 Phase 3 占位，未接入时用 `null`。

```js
{
  day: 12,
  dayPhase: 'dusk',
  season: null,
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
    treeCondition: { foliage: 0.8, pest: 0.2, health: 0.9 },
    dailyStats: {
      branchLoads: [2, 1, 2, 1, 2],
      avgDwellBeats: 8,
      switches: 1,
      silentRatio: 0.08,
      densityTier: 'normal'
    },
    ecology: {                 // 可选；缺省时整段省略
      branchChangesPerLoop: 1,
      meanDwellBeats: 8,
      clusterSize: 2,
      score: 0.86,
      deviation: { branchChanges: { direction: 'low', amount: 0.5 } }
    }
  }]
}
```

菜单也可放在单个 flock 的 `decisionMenu` / `menu` 上覆盖世界默认值。可选 `ecology` 只接受示例中的五项日评估摘要，未提供时不会在模型输入里制造空段。客户端会白名单化常见标量和短数组、忽略旧秒制驻留字段、夹紧 `energy` / `perchFlyRatio`，并在一个请求里按输入顺序评估全部 flock。system prompt 只包含生态与节拍词汇，明确要求单行 JSON；请求体不能添加 MiniMax 不支持的 `response_format`。

## 输出与失败语义

```js
{
  flocks: [{
    dwellBeats: 8,            // 驻留拍数，越界时夹到菜单
    activeBars: 2,            // 活跃窗小节数，越界时夹到菜单
    holdLoops: 4,             // 必须是菜单内 2–8 的整数，否则整份计划失败
    mutations: [{ from: 3, to: 1 }]
  }],
  master: { ops: [] }
}
```

- `flocks` 数量与输入不一致、四个计划字段缺失、`holdLoops` 在菜单外、HTTP 非成功、200 内 `base_resp.status_code !== 0`、响应 JSON 无法提取、网络错误或超时，统一视为失败。旧 `dwellSeconds` / `meanDwell` 等字段不会被转换或透传。
- 调度器对任意失败返回 `null`。第 1/2 次连续失败按 1/2 个昼夜指数退避；第 3 次连续失败打开断路器，5 个昼夜内不再发请求。冷却结束后的首次成功会清零状态。
- 同一时刻只允许一个请求；黄昏处理器重入会复用同一个 Promise，不会再发第二次请求。
- 默认超时 3000ms。客户端额外校验 MiniMax 的 `base_resp.status_code`，因为 HTTP 200 不等于业务成功。

## Master 接口保留位

Phase 2 当前强制返回 `master.ops: []`，外部模型不能直接改 world。后续 Master 服务接入时，操作只允许通过独立校验层映射到 `set_population`、`set_daynight`、`set_scale`、`spawn_pest_wave`，每项都需范围校验、授权和决策日志；不要在 `client.js` 内直接执行操作。
