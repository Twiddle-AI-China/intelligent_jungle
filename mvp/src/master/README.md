# Master agent 集成契约

Master 是全局季节与路径的唯一决策者；flock 计划不得写入这个决策域。模块只接收集成方注入的菜单和观测量，不读取 `config.js`，因此 1.6R 的具体菜单结构落地后只需在接线处做一次映射。

## 时序与回落

在第 N 天评估第 N−1 天数据时异步调用 `MasterLlmClient.requestDecision(input)`，并保存最后一个已就绪决定。第 N+1 天黎明换步之前读取该决定；若尚未就绪、返回 `null` 或已失效，立即同步调用 `decideMaster(input)`。随后由应用方把步骤决定交给 `world.setChord(...)`，把季节决定交给 `world.setSeason(...)`；这两个 1.6R 接口落地后再接线，本目录不引用 world。

LLM 的网络错误、非 2xx、MiniMax `base_resp.status_code` 业务错误、不可解析 JSON、菜单外选择和同时改变两个维度都统一返回 `null`。调用方不重试当前黎明，而是采用纯规则结果，保证掉线不影响日界节拍。

## 输入

```js
{
  menu: {
    progressions: [[/* 每条人定路径的步骤 */]],
    seasonPalettes: { spring: ['major-a'], summer: ['sus-a'] },
    seasonLengthRange: [2, 8],
    cooldownDays: 2
  },
  state: {
    currentSeason: 'spring',
    currentProgression: 0, // 可选；缺省时按季节键顺序选择路径
    currentStep: 1,
    daysInSeason: 3,
    daysSinceChange: 2
  },
  observations: {
    treeScores: [0.7, 0.5, 0.8, 0.6],
    patternSimilarity: 0.76,
    avgDwellBeats: [2, 8], // 每群平均驻留拍数
    activeBars: [3, 4],    // 每群活跃小节数
    holdLoops: [4, 6]      // 每群当前习性保持循环数
  }
}
```

`seasonPalettes` 的值也可为单个字符串或以变体名为键的对象。健康带下沿可通过 `menu.healthBand[0]` 或 `menu.healthFloor` 注入；否则兜底策略使用 0.4。若 `treeScores` 是当日四树分数，策略用 `daysSinceChange` 判断低分是否持续；也接受每棵树的短历史数组并直接检查末尾连续低分。时间类聚合只接受拍、小节、昼夜循环字段，旧秒制字段会被忽略。

## 外部 master 接口位

`createExternalMaster({ endpoint, headers, timeoutMs })` 向玮圣服务 POST 与 MiniMax 相同的白名单化 `masterInput` 聚合，凭据仅通过 `headers` 注入。服务返回 `{ action, params, reason }`，其中 action 只能是 `advanceStep`、`jumpToStep`、`changeSeason` 或 `nextPalette`；适配器会将其映射回既有 master 决策并复用菜单、冷却期和单维变更校验，任何错误均返回 `null`。

`resolveMasterDecision({ external, llm, policy }, masterInput)` 固定按 external → llm → policy 求值。它只是后续接线用的薄组合器，不改变现有流水线或同步 policy 菜单逻辑。

## 输出

- 顺走：`{ advanceStep: true, reason }`
- 停步：`{ advanceStep: false, reason }`
- 跳步：`{ advanceStep: false, jumpToStep, reason }`
- 换季：`{ advanceStep: false, changeSeason, nextPalette, reason }`

换季与步骤变化互斥。`changeSeason` 必须是 `seasonPalettes` 的键，`nextPalette` 必须属于该季节的候选；LLM 与外部服务都不能发明菜单外选项。两种异步来源最终都实现 `requestDecision(input) -> Promise<decision|null>`，黎明应用逻辑无需了解网络来源。
