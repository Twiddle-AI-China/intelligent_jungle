# Master agent 集成契约

Master 是全局季节、色彩档、黄昏色彩变化与张力预算的唯一决策者；flock 计划不得写入这个决策域。模块只接收集成方注入的菜单和观测量，不读取 `config.js`。

## 时序与回落

在第 N 天评估第 N−1 天数据时异步调用 `MasterLlmClient.requestDecision(input)`，并保存最后一个已就绪决定。第 N+1 天黎明读取该决定；若尚未就绪、返回 `null` 或已失效，立即同步调用 `decideMaster(input)`。应用方据此构建当日 harmonic frame；季末决定的 `nextSeason` 与 `seasonLength` 在下一次黎明生效。本目录不引用 world。

LLM 的网络错误、非 2xx、MiniMax `base_resp.status_code` 业务错误、不可解析 JSON、菜单外色彩或季长、非季末换季都统一返回 `null`。调用方不重试当前黎明，而是采用纯规则结果，保证掉线不影响日界节拍。

## 输入

```js
{
  menu: {
    seasons: ['spring', 'summer', 'autumn', 'winter'],
    colorsBySeason: {
      spring: ['本色', '挂四', '六度', '九度'],
      summer: ['挂四', '大调', '挂二', '六九']
    },
    seasonLengthRange: [8, 16],
    tensionRange: [0.2, 0.6]
  },
  state: {
    currentSeason: 'spring', // 也接受 season
    seasonDay: 3,            // 0-based
    seasonLength: 12,
    currentColorId: '挂四'
  },
  observations: {
    treeScores: [0.7, 0.5, 0.8, 0.6],
    harmonyScores: [0.9, 0.7, 1.0, 0.5],
    patternSimilarity: 0.76
  }
}
```

兼容接线可继续提供 `seasonPalettes`（集成方当前即此形态），模块会将其归一为 `colorsBySeason`；`progressions` 兼容位现为中性季节 id（防音乐泄漏，和弦名不进菜单）。`treeScores` 是各树生态得分；`harmonyScores` 是各树昨日对骨架/色彩枝的贴合度（和谐分 H，只观测），用于调节次日张力预算。

## 外部 master 接口位

`createExternalMaster({ endpoint, headers, timeoutMs })` 向玮圣服务 POST 与 MiniMax 相同的白名单化 `masterInput` 聚合，凭据仅通过 `headers` 注入。服务返回 `{ colorId, tension, duskColorShift, reason }`；仅在季末可额外返回 `{ nextSeason, seasonLength }`。适配器复用菜单、张力、布尔决策、季末日与季长范围校验，任何错误均返回 `null`。

`resolveMasterDecision({ external, llm, policy }, masterInput)` 固定按 external → llm → policy 求值。它只是后续接线用的薄组合器，不改变现有流水线或同步 policy 菜单逻辑。

## 输出

- 普通日：`{ colorId, tension, duskColorShift, reason }`
- 季末日：`{ colorId, tension, duskColorShift, nextSeason, seasonLength, reason }`

`colorId` 必须属于当前季的色彩菜单，`tension` 必须落在 `tensionRange`（旧菜单缺省兼容 0..1），`duskColorShift` 必须是布尔值；旧外部来源缺该字段时兼容为不触发。`nextSeason` 必须属于季节菜单，`seasonLength` 必须落在 `seasonLengthRange`，且两者只允许在季末日出现；LLM 与外部服务都不能发明菜单外选项。两种异步来源最终都实现 `requestDecision(input) -> Promise<decision|null>`，黎明应用逻辑无需了解网络来源。
