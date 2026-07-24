# 确定性 Conductor 与 Checkpoint 契约设计补充

**日期：** 2026-07-24
**状态：** 待书面复核
**适用范围：** Phase 1–2 Task 6–8
**关联设计：** `2026-07-22-backend-owned-runtime-design.md`
**关联计划：** `2026-07-23-phase-1-2-runtime-kernel.md`

## 1. 目的

本补充解决 Task 6 实施前审计发现的四个冲突：

1. 现有 world/conductor 合法使用 `Infinity` 与 `-Infinity`，直接 JSON round-trip 会把它们
   静默改成 `null`；
2. 现有 conductor 为保持生产行为仍接受 `ecologyProvider`、`getPercussionMode`、
   pipeline 与 evaluator，不能把这些含隐藏状态的对象描述成 provider-free；
3. pipeline 与 evaluator 的调用形状、异步结果和隐藏状态不同，不能用一个无类型 wrapper
   合并；
4. 原 characterization 只比较最终投影、事件计数和首事件，不能证明事件顺序与 RNG
   消耗零漂移。

目标仍是 strangler 迁移：Phase 1–2 只建立可验证的 provider-free checkpoint seam 和
shadow candidate；生产入口仍由浏览器拥有 world/audio，不启用 checkpoint，也不改变 8090。

## 2. 模式边界

### 2.1 Provider-free deterministic mode

只有同时满足以下条件的 owner 才可导出 checkpoint：

- world 与 conductor 都显式使用 `createDeterministicRng()`；
- `reviewSource === null`；
- `ecologyProvider === null`；
- `getPercussionMode === null`；
- 没有半完成 hydration；
- owner 未 dispose。

该模式用于 Task 6 checkpoint harness、Task 7 Node shadow runtime 和 Task 8 browser oracle。

### 2.2 Legacy compatibility mode

`attachPipelineConductor()` 为保持当前浏览器行为，可继续注入：

- `ecologyProvider`；
- `getPercussionMode`；
- evaluator；
- pipeline。

新 core 不得 import DOM、audio、fetch、LLM client 或 provider 模块；这些依赖只能作为
adapter 注入。只要上述任一外部 source 已安装，无论 Promise 当前是否 pending，
`exportDeterministicState()` 都必须抛出
`CHECKPOINT_NONDETERMINISTIC_SOURCE_ACTIVE`。原因是 source 即使已经 resolve，也可能保留
未序列化隐藏状态。

这一定义把“provider-free”限定为可 checkpoint 的运行模式，而不是错误宣称现有生产
adapter 已经没有外部依赖。

## 3. Legacy review source 契约

`reviewSource` 只能是 `null` 或以下三个判别式之一：

```js
{ kind: 'pipeline-v1', pipeline }
{ kind: 'evaluator-v1', evaluator }
{ kind: 'combined-v1', pipeline, evaluator }
```

约束如下：

- `pipeline.dayReview(input)` 保留当前
  `{ day, flockSnapshot, masterInput }` payload；
- `pipeline.dawnPlan()` 必须保持同步、零参数调用；
- `evaluator(stats, { season, colorId })` 保留当前参数形状，允许返回 Promise；
- `combined-v1` 精确保留现有同时提供 pipeline/evaluator 时的优先级，不在提取过程中
  顺手修正旧语义；
- adapter 捕获初始 evaluator；`setPipeline(next)` 每次根据 `next` 与捕获的 evaluator
  重新构造对应判别式，不能丢失 evaluator；
- pipeline 与 evaluator 均为空时必须传 `null`，不能安装一个“方法只返回 null”的伪
  source。

`setReviewSource()` 每次切换都递增 generation。source 被替换或 conductor dispose 后，
旧 Promise 的迟到 resolve/reject 不得写回 pending state，也不得触发 callback。

## 4. Deterministic RNG

### 4.1 Seed

- root `seed` 必须是 canonical uint32：整数、非 `-0`、范围 `0..0xffffffff`；
- world RNG seed 等于 root `seed`；
- conductor RNG seed 固定为 `(seed ^ 0x9e3779b9) >>> 0`；
- Task 6 owner harness、Task 7 runtime 与 Task 8 oracle 必须使用同一派生规则。

### 4.2 Restore state

`createDeterministicRng(seed, restoredState)` 只接受：

- `restoredState === null`；或
- 精确同时包含 `{ state, drawCount }` 的对象。

半状态、额外键、负数、非安全整数和越界值全部抛出
`INVALID_DETERMINISTIC_RNG_STATE`。恢复游标必须与 seed 一致：

```text
state = (seed + drawCount × 0x6D2B79F5) mod 2^32
```

实现必须用无精度损失的 uint32/BigInt 算法验证该关系。`exportState()` 返回递归不可变的
`{ state, drawCount }`。

默认 `restoredState=null` 的函数序列和 draw 次数不得变化。

## 5. Checkpoint JSON wire

### 5.1 固定身份

`SimulationCheckpoint` 继续使用以下固定 tuple：

```text
worldId = "default"
protocolVersion = 1
snapshotSchemaVersion = 1
schemaVersion = 1
configRevision = "phase2-domain-config-v1"
rng.algorithm = "mulberry32-v1"
```

`worldGeneration` 必须为非空 opaque string；`revision` 与 `eventSeq` 必须为安全非负整数。

### 5.2 非有限运行时值

wire 只在三个明确字段允许 `null` sentinel：

| Wire 字段 | `null` 的内存语义 |
|---|---|
| `world.trees[].birds[].plannedDwell` | `Infinity` |
| `world.trees[].birds[].plannedFlight` | `Infinity` |
| `conductor.cursor.lastDuskShiftDay` | `-Infinity`，表示从未发生 dusk shift |

导出时只转换这三个字段；hydrate 时只在这三个字段反向还原。除此之外，任何
`NaN`、`Infinity`、`-Infinity`、`undefined`、BigInt、function、Promise、symbol、循环
引用或非 JSON-safe prototype 都必须拒绝。合法 checkpoint 必须满足：

```js
assert.deepEqual(
  JSON.parse(JSON.stringify(checkpoint)),
  checkpoint,
);
```

真实非有限值作为 checkpoint 输入时仍然非法，不能依靠 `JSON.stringify()` 静默修复。

### 5.3 严格结构与不变量

validator 必须 non-throwing、拒绝缺键和额外键，并至少验证：

- 固定身份 tuple、expected seed/config、generation/revision/eventSeq；
- configured tree ID 精确全集，所有 tree-keyed map 的 key set 精确一致；
- bird ID 全局精确连续为 `0..N-1`，不可只检查“无重复”；
- 每只 bird 所属 tree、配置数量、branch 引用、sequence address、枚举与 timer 合法；
- 完整 mutable tree/bird state，包括隐藏 timer、stats、迁移状态与几何运动状态；
- Sequence grid 的 current/previous、坐标范围、cell 内容与 tree key set；
- control 的 tree owner、agent resume timer、tempo、master owner；
- 两个 RNG state 的范围，以及各自与 root/派生 seed 的游标一致性。

`control.paused` 必须由 aggregator 最后显式写入；world/conductor 子 section 不得携带同名
字段或覆盖它。

## 6. 完整状态所有权

### 6.1 World

`world.exportDeterministicState()` 不能复用 renderer 的 `getSnapshot()`。它必须导出：

- 完整 clock；
- 完整 tree mutable fields，包括 `stats`、`lastSeasonMigrationDay`；
- 完整 bird mutable fields，包括
  `targetBranch/settleAt/returnCause/returnSequence/visitCounts/orbitRadius/orbitAngle/
  orbitSpeed/bobPhase` 及所有现有 timer；
- branch preference、vocalize bias；
- world-owned sequence patterns、Jungle edit plans、last sequence step；
- tree control、agent resume timer 与 tempo。

### 6.2 Sequence bridge

`createSequencePatternBridge()` 恢复和导出 `current` 与 `previous` 两个 grid。输入和输出均为
独立 clone，不能暴露可变内部引用。

### 6.3 Conductor

`createDeterministicConductor()` 导出全部 mutable closure，包括：

- season/progression cursor；
- tree/harmony score history；
- pending season、frame、chord、hold state；
- pattern history、reviewed/planned pattern；
- harmony counters 与在鸣记录；
- master control 与 pending user season length。

core 安装的五个订阅必须全部保存 unsubscribe：

1. sequence bridge perch；
2. harmony perch；
3. harmony unperch；
4. before-dawn；
5. dusk。

`dispose()` 幂等，注销五个订阅、递增 source generation，并使迟到 async 结果失效。

## 7. 原子恢复

完整 checkpoint 必须在创建 RNG、world、conductor 或 listener 之前验证。无效 checkpoint
只能触发整世重建，不允许部分 hydration。

验证通过后，owner clone checkpoint，并明确切成：

```js
const worldState = {
  world: checkpoint.world,
  sequence: {
    worldPatterns: checkpoint.sequence.worldPatterns,
    jungleEditPlans: checkpoint.sequence.jungleEditPlans,
    lastSequenceStep: checkpoint.sequence.lastSequenceStep,
  },
  control: {
    treeControl: checkpoint.control.treeControl,
    agentResumeAt: checkpoint.control.agentResumeAt,
    tempo: checkpoint.control.tempo,
  },
};

const conductorState = {
  conductor: checkpoint.conductor,
  sequence: {
    bridgeCurrent: checkpoint.sequence.bridgeCurrent,
    bridgePrevious: checkpoint.sequence.bridgePrevious,
    reviewedPattern: checkpoint.sequence.reviewedPattern,
    plannedPatterns: checkpoint.sequence.plannedPatterns,
  },
  control: {
    masterControl: checkpoint.control.masterControl,
    pendingUserSeasonLength: checkpoint.control.pendingUserSeasonLength,
  },
};
```

`paused` 单独从 `checkpoint.control.paused` 恢复。

restore path 必须：

- 在随机创建 birds 和初始 `onDawn()` 之前分叉；
- 消耗 0 次 RNG；
- 在 caller 可观察前发出 0 个事件；
- 跳过初始 dawn；
- hydrate 完整状态后才安装 conductor listener。

默认 `restoredState=null` 路径必须继续执行当前随机初始化与一次初始 `onDawn()`，并保持
事件顺序和 RNG 消耗完全不变。并行构造 uninterrupted/resumed owner 时，每个 owner 使用
独立 config clone，避免 `setBeatsPerBar()` 的 config mutation 串扰。

## 8. Characterization 门禁

在新 core 被任何测试 import 前，先由当前 `attachPipelineConductor()` 单独生成并人工固定
旧行为 literals。fixture 不得 import 新 core，也不得从新实现动态生成 expected。

固定门禁至少包括：

- 原有 snapshot/frame/master/branch preference/hold state；
- 每棵树明确读取 `getPlannedSequencePattern(treeId)` 后得到的 occupied cells；
- 完整有序 domain-event trace 的 canonical SHA-256；
- 完整有序 callback trace 的 canonical SHA-256；
- world RNG draw count 精确为 `264`；
- conductor RNG draw count 精确为 `9`。

trace 只保留稳定协议字段，数值按固定规则归一化后 canonical JSON 编码。golden 使用递归
deep-freeze。旧 adapter 与新 core 必须分别消费同一组固定 literals；checkpoint 的
uninterrupted/resumed 对比不能替代这条旧行为 characterization。

## 9. 串行实施与测试

Task 6 仍由一个实现者串行完成，禁止多个实现者共享 index。内部按以下可独立复审的
TDD 子提交推进：

1. 旧 adapter characterization；
2. deterministic RNG 与 checkpoint validator；
3. sequence bridge restore/export；
4. world 完整 hydrate/export；
5. helper 搬迁与 conductor core/adapter；
6. owner checkpoint 300+300 continuation 与生命周期测试。

每个子提交先 RED、再 GREEN，并保持 characterization 通过。最终测试矩阵覆盖：

- Node 20/24 下旧 adapter 与新 core 的 state、trace、RNG draw parity；
- RNG known vector、半状态、错误 seed/cursor；
- 300+300 JSON round-trip 与 uninterrupted 600 tick 完全一致；
- dawn/dusk/sequence 边界、USER control、tempo、agent resume timer；
- 错误 identity/version/config/seed、坏 key set、ID、引用、JSON 值、RNG cursor；
- restore 零 draw/零事件；
- 五个 unsubscribe、double-dispose、source swap 与迟到 Promise；
- 任一 legacy source/hook 已安装时 checkpoint fail closed。

## 10. 非目标与生产边界

本补充不授权：

- 修改 `mvp/src/main.js` 使其创建、导入或持久化 checkpoint；
- 删除现有 legacy ecology/percussion/pipeline/evaluator 行为；
- 创建 audio worker、访问 8081/LLM 或发布 PCM；
- 修改 `flock-voice-engine/web/`；
- SSH、SCP、远程 Docker、同步、启动、停止、重启或改变生产 8090；
- Phase 5 owner 切换。

Phase 1–2 的交付物仍只能描述为 localhost shadow candidate，不能描述为线上已生效。

## 11. 被否决方案

### 11.1 立即把 ecology/percussion 改成可 checkpoint 状态输入

该方案边界更纯，但会改变逐 perch 读取时机、扩大 main/audio 接口和迁移范围，无法在
Task 6 内同时证明生产行为零漂移，因此本阶段不采用。

### 11.2 推迟 checkpoint，只提取 helper/core

该方案实现风险较低，但会移除 Task 7 restore 与 Task 8 oracle 的关键可验证 seam，不能
满足已批准的 Phase 1–2 shadow 目标，因此不采用。
