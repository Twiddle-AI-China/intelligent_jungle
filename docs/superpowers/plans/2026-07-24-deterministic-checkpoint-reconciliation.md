# Phase 1–2 Deterministic Checkpoint Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking. Only one implementation agent may edit or stage at a time; each
> review is independent and read-only.

**Goal:** 在不改变生产 owner 或 8090 的前提下，提取零漂移 deterministic conductor，
建立严格 JSON checkpoint/原子恢复，再把同一 domain 以 exact-copy 方式迁入 Node shadow
runtime，并用独立 browser oracle 证明 snapshot、事件与 RNG 游标一致。

**Architecture:** Phase Task 6 在 canonical `mvp/` 内先锁住旧 adapter 行为，再依次实现
stateful RNG、checkpoint schema、sequence/world/conductor hydration 和 300+300 continuation。
Phase Task 7 把经过验证的 domain 文件与替换测试逐字节复制到 localhost-only runtime，
Phase Task 8 用独立 MVP oracle 对 candidate 做逐 tick first-divergence 比较。Legacy
provider/audio/pipeline/evaluator 只保留在 browser adapter；任何外部 source 已安装时
checkpoint fail closed。

**Tech Stack:** Node.js 20 与 24、ES modules、原生 `node:test`、`node:crypto`、
PowerShell、现有 `npm run verify:phase0`、runtime `ws@8.21.1`。

## Global Constraints

- 权威设计是
  `docs/superpowers/specs/2026-07-24-deterministic-checkpoint-contract-design.md`；本计划完整
  替代 `2026-07-23-phase-1-2-runtime-kernel.md` 中历史 Task 6–8 草稿。
- 开始每个 Task 前运行 `npm run verify:phase0`；失败时停止并按
  superpowers:systematic-debugging 查根因。
- 生产仍固定 `runtimeOwner="browser"`、`audioOwner="legacy"`；`mvp/src/main.js` 不导入、
  创建、导出或持久化 checkpoint。
- 不修改 `flock-voice-engine/web/`、legacy voice client/worklet、`mvp/src/audio.js`、
  production deploy 脚本或 8090。
- 不连接远程主机，不执行 SSH/SCP/远程 Docker，不同步、启动、停止或重启生产。
- provider-free checkpoint mode 必须同时满足
  `reviewSource/ecologyProvider/getPercussionMode === null` 且 `sequenceEnabled === true`；
  任一 source 已安装即抛 `CHECKPOINT_NONDETERMINISTIC_SOURCE_ACTIVE`。Legacy/eval 仍可用
  `sequenceEnabled=false` 执行，但该配置导出必须抛
  `CHECKPOINT_UNSUPPORTED_CONFIGURATION`。
- root seed 必须为 canonical uint32；world seed 等于 root seed，conductor seed 固定为
  `(seed ^ 0x9e3779b9) >>> 0`。
- checkpoint 固定
  `worldId="default"`、`protocolVersion=1`、`snapshotSchemaVersion=1`、
  `schemaVersion=1`、`configRevision="phase2-domain-config-v1"`、
  `rng.algorithm="mulberry32-v1"`。
- wire 只允许
  `plannedDwell/plannedFlight/lastDuskShiftDay` 三个字段使用冻结的 `null` sentinel；
  其它非有限值、非 JSON-safe 值、缺键、额外键、坏 ID/引用或坏 RNG 游标一律拒绝。
- 完整 checkpoint 必须先验证，之后才可创建 RNG、world、conductor 或 listeners；不兼容
  输入只能整世重建，不允许部分 hydration。
- 默认 `restoredState=null` 必须保持当前初始化、事件顺序和 RNG 消耗；restore 必须零
  draw、零初始化事件并跳过初始 `onDawn()`。
- Task 1 的六个子提交由同一个实现者串行完成，避免反复搬运 1400 行 conductor 上下文；
  每个子提交完成后生成独立 review package，并由只读 reviewer 关闭
  Critical/Important 后再继续。
- 所有行为变更严格执行 RED → 验证失败原因 → 最小 GREEN → 相关回归 →
  `npm run verify:phase0` → 单独提交。
- runtime/domain 和 replacement tests 的 `exact-copy` 条目必须字节级 SHA-256 相等；
  config 只允许受测 projection，不把 visual、endpoint、secret 或 LLM 配置带入 Node。
- Node 单元/协议测试在本机 Node 24 与 `npx -y node@20 --test` 下都必须通过。
- 文档、测试说明和代码注释使用中文；公开函数名与协议字段保持本计划冻结的英文名。

---

## File Responsibility Map

```text
mvp/src/deterministic-rng.js
    唯一 stateful mulberry32-v1 实现；严格 seed/cursor 校验
mvp/src/simulation-checkpoint.js
    唯一 checkpoint schema、strict validator、clone/freeze aggregator
mvp/src/sequence.js
    canonical Sequence 行为；增加 current/previous restore/export
mvp/src/world.js
    canonical world 行为；增加完整 hidden-state restore/export
mvp/src/deterministic-conductor.js
    provider-free core、11 个 pure helper、legacy source 判别与 lifecycle
mvp/src/agent.js
    browser compatibility adapter 与 helper re-export
mvp/test/fixtures/conductor-golden.js
    人工冻结的旧 adapter literals，不 import 新 core
mvp/test/fixtures/conductor-scenario.js
    两个 conductor 共用的 scenario/reducer，不选择实现
mvp/test/fixtures/checkpoint-owner.js
    测试专用完整验证、切片、owner 构造与事件收集

flock-voice-engine/runtime/src/domain/*
    Task 1 canonical domain 的 temporary exact-copy candidate
flock-voice-engine/runtime/src/simulation-runtime.js
    provider-free fixed-step owner、命令映射、checkpoint seam
flock-voice-engine/runtime/src/audio/null-audio-sink.js
    Phase 2 只计数、不产生 PCM 的 sink
mvp/eval/shadow-oracle.js
    只 import MVP canonical domain 的独立 oracle
flock-voice-engine/runtime/src/shadow/*
    canonicalizer、first-difference comparator 与 replay runner
```

---

### Task 1: Reconcile Phase Task 6 — canonical checkpointable MVP domain

**Files:**

- Create: `mvp/src/deterministic-rng.js`
- Create: `mvp/src/simulation-checkpoint.js`
- Create: `mvp/src/deterministic-conductor.js`
- Modify: `mvp/src/sequence.js`
- Modify: `mvp/src/world.js`
- Modify: `mvp/src/agent.js`
- Create: `mvp/test/fixtures/conductor-golden.js`
- Create: `mvp/test/fixtures/conductor-scenario.js`
- Create: `mvp/test/fixtures/checkpoint-owner.js`
- Create: `mvp/test/conductor-characterization.test.js`
- Create: `mvp/test/deterministic-rng.test.js`
- Create: `mvp/test/simulation-checkpoint-schema.test.js`
- Create: `mvp/test/sequence-checkpoint.test.js`
- Create: `mvp/test/world-checkpoint.test.js`
- Create: `mvp/test/deterministic-conductor.test.js`
- Create: `mvp/test/simulation-checkpoint.test.js`

**Interfaces:**

- Produces `assertCanonicalSeed(seed)`,
  `deriveConductorSeed(seed)`,
  `createDeterministicRng(seed, restoredState=null)` and
  `DETERMINISTIC_RNG_ALGORITHM`.
- Produces `createSimulationCheckpoint(parts)`,
  `validateSimulationCheckpoint(checkpoint, expected)`,
  `SIMULATION_CHECKPOINT_SCHEMA_VERSION=1` and
  `SIMULATION_CONFIG_REVISION="phase2-domain-config-v1"`.
- `createWorld({ config=CONFIG, rng=Math.random, restoredState=null })` returns the current API plus
  `exportDeterministicState()`.
- `createSequencePatternBridge({ config=CONFIG, restoredState=null })` returns the current API plus
  `exportDeterministicState()`.
- Produces `createDeterministicConductor(world, options)` with
  `getChord/getFrame/getHarmonyScores/getSequencePattern/getPlannedSequencePattern/
  getReviewedSequencePattern/getMasterState/setMasterControl/setUserSeasonLength/applyUserColor/
  hasPendingPlan/setReviewSource/getHoldState/exportDeterministicState/dispose`.
- `mvp/src/agent.js` re-exports
  `resolveBehaviorSuggestions/evaluateDay/filterMutationBounds/ensurePatternMutation/
  meanTreePatternSimilarity/planFromLlm/ruleSequencePlan/padDiversityBranchWeights/
  bassRootBranchWeights/harmonyScoreFromCounts/masterMenuFromConfig`.

#### Subcommit A: Freeze the pre-extraction adapter

- [ ] **Step A1: Add a scenario reducer that does not select a conductor implementation**

`mvp/test/fixtures/conductor-scenario.js` exports exactly:

```js
export function runConductorScenario({
  createConductor,
  worldSeed,
  conductorSeed,
  ticks,
  dt,
}) {
  // Create independent counting RNG functions, create the real MVP world,
  // pass createConductor from the caller, capture ordered domain events and
  // onPlan/onApply/onChord/onMaster callbacks, then return one normalized
  // JSON-safe projection. This module must not import agent.js or
  // any future extracted core module.
}
```

Both old-adapter and new-core characterization invoke it with this exact frozen scenario:

```js
{
  worldSeed: 0x4c4353,
  conductorSeed: 0x4c4354,
  ticks: 600,
  dt: 1 / 30,
}
```

The reducer canonicalizes every captured record by recursively sorting object keys, preserving array
order, rounding finite floats to 12 decimal places for traces and branch-preference values to six
decimal places. It hashes canonical JSON with `node:crypto.createHash('sha256')`. It reads sequence
cells only through `getPlannedSequencePattern(treeId)` for each configured tree.

- [ ] **Step A2: Capture the old adapter once and commit only fixed literals**

Before any new core import exists, temporarily print the full reducer result from
`attachPipelineConductor` using:

```powershell
node --test mvp/test/conductor-characterization.test.js
```

Copy the old-adapter result into `CONDUCTOR_GOLDEN`, remove the print, and require these already
reviewed literals:

```js
worldRngDrawCount: 264,
conductorRngDrawCount: 9,
snapshot: { simTime: 20, day: 2, phase: 0.33, bpm: 60, perchedTotal: 9 },
eventCounts: { perch: 37, unperch: 28, dawn: 1, dusk: 1, 'sequence-pattern': 4 },
firstEvent: { name: 'perch', treeId: 'texture', birdId: 14, branchId: 4, day: 1 },
```

`eventTraceSha256` and `callbackTraceSha256` must each be a committed lowercase 64-hex literal from
that old adapter run. The test rejects missing/dynamic values:

```js
assert.match(CONDUCTOR_GOLDEN.eventTraceSha256, /^[0-9a-f]{64}$/);
assert.match(CONDUCTOR_GOLDEN.callbackTraceSha256, /^[0-9a-f]{64}$/);
assert.equal(actual.worldRngDrawCount, 264);
assert.equal(actual.conductorRngDrawCount, 9);
assert.deepEqual(actual, CONDUCTOR_GOLDEN);
```

Deep-freeze every nested golden value. The fixture may not call `runConductorScenario()` while
constructing `CONDUCTOR_GOLDEN`.

- [ ] **Step A3: Run the baseline GREEN before creating/importing the core**

```powershell
node --test mvp/test/conductor-characterization.test.js
$forbidden = @(rg -n "deterministic-conductor" mvp/test/conductor-characterization.test.js mvp/test/fixtures/conductor-golden.js mvp/test/fixtures/conductor-scenario.js)
if ($LASTEXITCODE -gt 1) { throw "rg failed with exit $LASTEXITCODE" }
if ($forbidden.Count -ne 0) {
  $forbidden
  throw 'characterization imported the future core'
}
```

Expected: the test passes and the forbidden-reference array is empty. If a reviewed literal differs,
fix the reducer against current `attachPipelineConductor`; never regenerate expected from the future
core.

- [ ] **Step A4: Commit characterization only**

```powershell
git add mvp/test/fixtures/conductor-golden.js mvp/test/fixtures/conductor-scenario.js mvp/test/conductor-characterization.test.js
git commit -m "test(mvp): freeze conductor behavior trace"
```

#### Subcommit B: Stateful RNG and strict checkpoint schema

- [ ] **Step B1: Write RNG RED tests**

`mvp/test/deterministic-rng.test.js` fixes this vector:

```js
const rng = createDeterministicRng(7);
assert.deepEqual(
  [rng(), rng(), rng(), rng()],
  [
    0.011704753153026104,
    0.06195825757458806,
    0.97690763277933,
    0.6990287057124078,
  ],
);
assert.deepEqual(rng.exportState(), { state: 3031295963, drawCount: 4 });
```

Also assert:

- root seed rejects `-0`, negatives, fractions, strings and `0x1_0000_0000`;
- `assertCanonicalSeed(seed)` returns the accepted uint32 or throws
  `INVALID_DETERMINISTIC_RNG_SEED`, and `deriveConductorSeed(seed)` returns
  `(seed ^ 0x9e3779b9) >>> 0`;
- restore requires exactly both `state/drawCount`, with no extra key;
- `{ state:3663131633, drawCount:2 }` resumes seed 7 at the third vector value;
- the same state with drawCount 1 or seed 8 rejects;
- a safe-integer draw count near `Number.MAX_SAFE_INTEGER` is checked with the BigInt formula without
  precision loss;
- exported state is frozen and cannot mutate the RNG.

- [ ] **Step B2: Write checkpoint schema RED tests**

`mvp/test/simulation-checkpoint-schema.test.js` builds one complete minimal configured state and
asserts:

```js
const checkpoint = createSimulationCheckpoint(parts);
assert.deepEqual(JSON.parse(JSON.stringify(checkpoint)), checkpoint);
assert.equal(validateSimulationCheckpoint(checkpoint, {
  seed: 7,
  configRevision: 'phase2-domain-config-v1',
}), true);
```

Corrupt one field at a time and require `false` without throw:

```text
top-level missing/extra key
wrong world/protocol/snapshot/checkpoint/config identity
empty generation; negative/unsafe revision or eventSeq
raw NaN/+Infinity/-Infinity/undefined/function/Promise/BigInt/symbol/cycle
accessor, non-plain prototype, symbol key or repeated object identity/shared alias
root/nested checkpoint Proxy 或 expected Proxy（get trap 必须保持 0）
tree key-set mismatch
duplicate, gapped or wrong-tree bird ID
bad branch/sequence/control reference
wrong RNG algorithm/range/drawCount/seed-derived state
null in a schema-required non-nullable field such as clock.simTime, bird.energy or cursor.seasonIdx
finite or null-invalid sentinel field shapes
```

- [ ] **Step B3: Run RED**

```powershell
node --test mvp/test/deterministic-rng.test.js mvp/test/simulation-checkpoint-schema.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` for `deterministic-rng.js` or
`simulation-checkpoint.js`; the characterization test remains GREEN.

- [ ] **Step B4: Implement the exact RNG state relation**

Use this seed/cursor predicate:

```js
const UINT32_MAX = 0xffff_ffff;
const UINT32_MODULUS = 1n << 32n;
const MULBERRY_INCREMENT = 0x6D2B79F5;

function expectedState(seed, drawCount) {
  return Number(
    (BigInt(seed) + BigInt(drawCount) * BigInt(MULBERRY_INCREMENT))
      % UINT32_MODULUS,
  );
}
```

`assertCanonicalSeed()` is the one shared non-constructing seed gate. `deriveConductorSeed()` calls it
before applying the frozen XOR. `createDeterministicRng()` also validates seed before restored state,
validates exact own keys, and rejects a restored state unless
`state === expectedState(seed, drawCount)`. Its draw function uses the frozen mulberry32-v1 algorithm
and increments drawCount once per call.

- [ ] **Step B5: Implement a strict checkpoint validator and aggregator**

`simulation-checkpoint.js` must:

- walk only plain objects/arrays and reject accessors, symbol keys and cycles;
- reject repeated object identity/shared aliases so the accepted input is a strict JSON tree;
- check exact keys at every frozen section;
- validate configured tree and bird invariants against `CONFIG`;
- accept ordinary `null` only at fields explicitly nullable in the frozen schema, including pending
  state, optional branch/address and previous/reviewed pattern fields; only
  `plannedDwell/plannedFlight/lastDuskShiftDay` give `null` the special
  `Infinity/Infinity/-Infinity` sentinel meaning;
- verify world RNG from root seed and conductor RNG from
  `(seed ^ 0x9e3779b9) >>> 0`;
- require `clock.bpm === control.tempo.bpm`, require dayLength to match
  `barsPerDay * beatsPerBar * 60 / bpm`, and validate phase/daylight/tempo ranges;
- require provider-free checkpoint pending fields
  `pendingPlan/pendingSource/pendingReviewedDay` to be `null`;
- after descriptor-first normalization and semantic validation succeed, run discarded native
  `structuredClone(checkpoint)` and `structuredClone(expected)` preflights on the original inputs;
  any clone failure returns `false` without invoking a Proxy `get` trap;
- write `paused` after all explicit world/conductor control keys;
- have the aggregator return `deepFreeze(structuredClone(canonicalCheckpoint))`;
- keep `validateSimulationCheckpoint()` non-throwing.

Do not use object spreads that can overwrite `paused`, inject extra keys or invoke untrusted
accessors.

- [ ] **Step B6: Run GREEN and commit**

```powershell
node --test mvp/test/deterministic-rng.test.js mvp/test/simulation-checkpoint-schema.test.js mvp/test/conductor-characterization.test.js
git diff --check
git add mvp/src/deterministic-rng.js mvp/src/simulation-checkpoint.js mvp/test/deterministic-rng.test.js mvp/test/simulation-checkpoint-schema.test.js
git commit -m "feat(mvp): define deterministic checkpoint schema"
```

Expected: all focused tests pass with no new warning.

#### Subcommit C: Sequence bridge state

- [ ] **Step C1: Write RED for current/previous restore**

`mvp/test/sequence-checkpoint.test.js` must feed real perch events into a bridge, call `finishDay()`,
feed a second day, export, JSON round-trip, restore, and assert:

```js
assert.deepEqual(restored.getCurrent(), original.getCurrent());
assert.deepEqual(restored.getPrevious(), original.getPrevious());
assert.deepEqual(restored.exportDeterministicState(), exported);
assert.notStrictEqual(restored.getCurrent(), exported.current);
```

Missing/extra keys, malformed grids, wrong tree key sets, out-of-range coordinates and
`restoredState={current}` without previous must reject atomically.

- [ ] **Step C2: Run RED**

```powershell
node --test mvp/test/sequence-checkpoint.test.js
```

Expected: failure because the current bridge has no `restoredState` or export method.

- [ ] **Step C3: Implement clone-before-publish restore/export**

Freeze this shape:

```js
{ current: SequenceGridV2, previous: SequenceGridV2 | null }
```

Validate and clone the entire pair before assigning either closure variable. The null path continues
to create one fresh current grid and `previous=null`.

- [ ] **Step C4: Run GREEN and commit**

```powershell
node --test mvp/test/sequence-checkpoint.test.js mvp/test/sequence.test.js mvp/test/conductor-characterization.test.js
git add mvp/src/sequence.js mvp/test/sequence-checkpoint.test.js
git commit -m "feat(mvp): restore sequence bridge state"
```

#### Subcommit D: Complete world hydration

- [ ] **Step D1: Write RED for hidden world state and zero-side-effect restore**

`mvp/test/world-checkpoint.test.js` uses one named world RNG and an independent
`structuredClone(CONFIG)` per owner. It records RNG draw counts, drives real ticks plus
`setTempo/setBeatsPerBar/sequence/user` operations, then asserts:

```js
const worldRng = createDeterministicRng(7);
const world = createWorld({
  config: structuredClone(CONFIG),
  rng: worldRng,
});
// Drive the real operations listed above.
const state = JSON.parse(JSON.stringify(world.exportDeterministicState()));
const rngState = worldRng.exportState();
const restoreRng = createDeterministicRng(7, rngState);
const restored = createWorld({
  config: structuredClone(CONFIG),
  rng: restoreRng,
  restoredState: state,
});
assert.equal(restoreRng.exportState().drawCount, rngState.drawCount);
assert.deepEqual(restored.exportDeterministicState(), state);
```

Exact restored-state equality proves no initial `onDawn()` transition occurred: day, phase, open
stats, sequence step and bird timers would otherwise change. Because `createWorld()` exposes no
listener registration until after it returns, no caller can observe an initialization event before
that equality check. Do not add a test-only event hook to production code.

The test explicitly mutates/checks fields absent from renderer snapshots:

```text
targetBranch, settleAt, returnCause, returnSequence, visitCounts,
orbitRadius, orbitAngle, orbitSpeed, bobPhase, tree.stats,
lastSeasonMigrationDay, worldPatterns, jungleEditPlans, lastSequenceStep,
treeControl, agentResumeAt, tempo
```

The exported wire maps only `plannedDwell/plannedFlight === Infinity` to `null`; a finite value stays
finite.

- [ ] **Step D2: Run RED**

```powershell
node --test mvp/test/world-checkpoint.test.js
```

Expected: failure because `createWorld()` lacks restore/export.

- [ ] **Step D3: Implement the pre-RNG restore branch**

Structure construction in this order:

```text
1. validate/clone restoredState or choose null path
2. construct deterministic geometry and empty containers
3a. null path: randomly create birds, run onDawn once, reset day to 1
3b. restore path: hydrate all tree/bird/clock/sequence/control fields,
    map plannedDwell/plannedFlight null back to Infinity,
    consume no RNG and do not call onDawn
4. expose listeners and public methods
```

Never hydrate from `getSnapshot()`. Require bird IDs to be contiguous before any use of
`birds[birdId]`.

- [ ] **Step D4: Run GREEN and commit**

```powershell
node --test mvp/test/world-checkpoint.test.js mvp/test/world.test.js mvp/test/daycycle.test.js mvp/test/sequence-checkpoint.test.js mvp/test/conductor-characterization.test.js
git add mvp/src/world.js mvp/test/world-checkpoint.test.js
git commit -m "feat(mvp): restore complete world state"
```

#### Subcommit E: Extract conductor core and lifecycle

- [ ] **Step E1: Write new-core and legacy-source RED tests**

`mvp/test/deterministic-conductor.test.js` supplies
`createDeterministicConductor` to the same scenario reducer and requires exact
`CONDUCTOR_GOLDEN`.

Add source/lifecycle tests for:

```text
pipeline-v1 dayReview exact payload and zero-argument synchronous dawnPlan
evaluator-v1 exact (stats, {season,colorId}) payload and Promise plan result
combined-v1 current priority
setReviewSource generation invalidating late Promise results
any installed reviewSource/ecologyProvider/getPercussionMode blocking export
sequenceEnabled=false retaining legacy execution but blocking export with CHECKPOINT_UNSUPPORTED_CONFIGURATION
null sources allowing export
invalid restoredState rejected before any review source getter, subscription, RNG, world setter or callback
five unsubscribe callbacks called exactly once across double-dispose
no callback or pending state mutation after dispose
```

The legacy adapter test calls `setPipeline(null)` after construction with evaluator and proves the
captured evaluator remains available.

- [ ] **Step E2: Run RED**

```powershell
node --test mvp/test/deterministic-conductor.test.js mvp/test/conductor-characterization.test.js mvp/test/agent.test.js mvp/test/harmony-frame.test.js mvp/test/pipeline.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` for `deterministic-conductor.js`; old characterization remains
GREEN.

- [ ] **Step E3: Move the eleven helpers and their private dependencies**

Move the exact helper bodies plus `clamp`, `TIER_ORDER`, active-bar constants and `tierStep` into
`deterministic-conductor.js`. The new file may import only:

```text
./config.js
./harmony.js
./jungle.js
./sequence.js
./master/policy.js
./survival-actions.js
```

It must not import `agent.js`, `world.js`, DOM, audio, fetch or LLM modules. `agent.js` re-exports all
eleven names without wrappers, preserving
`bassRootBranchWeights(branchCount, cfg=CONFIG, baseWeights=[], treeWeights=[])`.

- [ ] **Step E4: Move closure state with hydration before subscriptions**

`createDeterministicConductor()` accepts:

```js
{
  config = CONFIG,
  rng = Math.random,
  restoredState = null,
  reviewSource = null,
  ecologyProvider = null,
  getPercussionMode = null,
  onPlan = null,
  onApply = null,
  onChord = null,
  onMaster = null,
  onTempoIntent = null,
  sequenceEnabled = true,
}
```

Validate/clone restored state before `readReviewSource()` or any other option inspection; an invalid
restore throws `INVALID_DETERMINISTIC_CONDUCTOR_STATE` with zero source getter, subscription, RNG,
world setter and callback calls. Then map `cursor.lastDuskShiftDay:null` to `-Infinity`, create the
sequence bridge with its restored pair, and only then install and retain the five unsubscribe
functions. `dispose()` is idempotent and invalidates the source generation.

Use these exact source discriminants:

```js
{ kind: 'pipeline-v1', pipeline }
{ kind: 'evaluator-v1', evaluator }
{ kind: 'combined-v1', pipeline, evaluator }
```

Preserve the current combined behavior literally:

```text
dawn: if pipeline exists, call pipeline.dawnPlan() with zero arguments
day end: if pipeline exists, call pipeline.dayReview(payload);
         otherwise, if evaluator exists, start evaluator(stats, context)
flock apply: if evaluator exists, consume evaluator pendingPlan or rule fallback;
             otherwise consume pipeline dawnResult or rule fallback
```

This intentionally retains the existing combined edge case during extraction; behavioral cleanup is
outside Task 1.

The browser adapter builds `null` when both are absent, captures evaluator across `setPipeline()`,
and passes legacy ecology/percussion hooks through unchanged.

`setReviewSource(null)` increments generation and clears
`pendingPlan/pendingSource/pendingReviewedDay`; otherwise externally derived pending state could be
exported after the source object disappeared. A late Promise from an older generation cannot restore
those fields.

- [ ] **Step E5: Preserve the old public surface**

The adapter and core must retain all current getters, callback payloads/order and
`setPipeline()` compatibility. New methods are additive:

```js
setReviewSource(source)
exportDeterministicState()
dispose()
```

`exportDeterministicState()` never serializes source objects, callbacks or listeners and rejects if
any external source/hook is installed. It also rejects `sequenceEnabled !== true` with
`CHECKPOINT_UNSUPPORTED_CONFIGURATION`; this does not remove legacy/eval execution support for
`sequenceEnabled=false`.

- [ ] **Step E6: Run GREEN and commit**

```powershell
node --test mvp/test/conductor-characterization.test.js mvp/test/deterministic-conductor.test.js mvp/test/agent.test.js mvp/test/harmony-frame.test.js mvp/test/pipeline.test.js mvp/test/world-checkpoint.test.js mvp/test/sequence-checkpoint.test.js
git add mvp/src/deterministic-conductor.js mvp/src/agent.js mvp/test/deterministic-conductor.test.js
git commit -m "refactor(mvp): extract deterministic conductor"
```

Expected: old adapter and new core match the same state, trace hashes and RNG counts.

#### Subcommit F: Atomic owner checkpoint continuation

- [ ] **Step F1: Write 300+300 RED integration and corruption matrix**

`mvp/test/simulation-checkpoint.test.js` compares:

```text
uninterrupted owner: 600 ticks
first owner: 300 ticks -> JSON checkpoint
restored owner: validated checkpoint -> remaining 300 ticks
```

Require equality of:

- prefix and second-half ordered domain events;
- every final checkpoint field;
- world/conductor RNG states;
- branch preferences, hidden bird timers/stats, sequence current/previous and controls.

Add incompatible variants for every schema group. Each invalid variant must be rejected before owner
construction; a caller choosing rebuild must pass `null` and obtain the same checkpoint as a
separately built fresh owner.

Root/nested checkpoint Proxy and expected Proxy must all validate `false` after descriptor/semantic
checks, without invoking a `get` trap. An owner receiving a proxied checkpoint must reject with
`INVALID_SIMULATION_CHECKPOINT` at the validation gate, before its accepted-checkpoint clone, RNG,
world, conductor or subscription construction.

- [ ] **Step F2: Run RED before the owner helper exists**

```powershell
node --test mvp/test/simulation-checkpoint.test.js
```

Expected: fail because `checkpoint-owner.js` or its required constructor/export behavior does not yet
exist. Confirm that reason before implementation.

- [ ] **Step F3: Implement the test-only owner constructor**

`mvp/test/fixtures/checkpoint-owner.js` exports
`createCheckpointableOwner({ seed, restoredSnapshot=null })`. It must:

1. validate a non-null full checkpoint before creating RNG/world/conductor; the validator's
   cloneability preflight clones are discarded;
2. after acceptance, defensive clone the checkpoint exactly once;
3. use root world seed and shared `deriveConductorSeed(seed)` for conductor;
4. create independent `structuredClone(CONFIG)`;
5. pass the exact world/conductor slices frozen in the design;
6. pass `reviewSource/ecologyProvider/getPercussionMode:null`;
7. collect ordered domain events;
8. export with `createSimulationCheckpoint()`.

- [ ] **Step F4: Run focused GREEN**

After the minimal helper wiring:

```powershell
node --test mvp/test/simulation-checkpoint.test.js mvp/test/simulation-checkpoint-schema.test.js mvp/test/deterministic-rng.test.js mvp/test/world-checkpoint.test.js mvp/test/deterministic-conductor.test.js mvp/test/conductor-characterization.test.js
```

Expected: all pass; JSON round-trip is exact.

- [ ] **Step F5: Run both Node versions and full gates**

```powershell
$focused = @(
  'mvp/test/conductor-characterization.test.js',
  'mvp/test/deterministic-rng.test.js',
  'mvp/test/simulation-checkpoint-schema.test.js',
  'mvp/test/sequence-checkpoint.test.js',
  'mvp/test/world-checkpoint.test.js',
  'mvp/test/deterministic-conductor.test.js',
  'mvp/test/simulation-checkpoint.test.js'
)
node --test @focused
npx -y node@20 --test @focused
npm run test:mvp
npm run verify:phase0
git diff --check
```

Expected: Node 24/20 focused tests, all MVP tests and Phase 0 exit 0. The only allowed output noise is
the already recorded external `pytest_asyncio` deprecation warning; no new warning is accepted.

- [ ] **Step F6: Commit and task review**

```powershell
git add mvp/test/fixtures/checkpoint-owner.js mvp/test/simulation-checkpoint.test.js
git commit -m "test(mvp): prove deterministic checkpoint continuation"
```

Generate the Task 1 review package from the pre-A base through F head. The reviewer must verify both
spec compliance and code quality; all Critical/Important findings are fixed under new RED tests
before Task 2.

---

### Task 2: Reconcile Phase Task 7 — exact-copy Node shadow runtime

**Files:**

- Create/modify: `flock-voice-engine/runtime/domain-migration.json`
- Create/modify: `flock-voice-engine/runtime/domain-test-migration.json`
- Create: `flock-voice-engine/runtime/src/domain/config.js`
- Create exact copies under: `flock-voice-engine/runtime/src/domain/`
- Create: `flock-voice-engine/runtime/src/audio/null-audio-sink.js`
- Create: `flock-voice-engine/runtime/src/simulation-runtime.js`
- Create: `flock-voice-engine/runtime/src/runtime-app.js`
- Modify: `flock-voice-engine/runtime/src/world-session/world-session.js`
- Modify: `flock-voice-engine/runtime/src/index.js`
- Modify: `flock-voice-engine/runtime/package.json`
- Create: `flock-voice-engine/runtime/test/domain-parity.test.js`
- Create: `flock-voice-engine/runtime/test/domain-import-closure.test.js`
- Create: `flock-voice-engine/runtime/test/domain/test-migration.test.js`
- Create exact replacement suites under: `flock-voice-engine/runtime/test/domain/`
- Create test adapters under: `flock-voice-engine/runtime/test/src/`
- Create: `flock-voice-engine/runtime/test/simulation-runtime.test.js`
- Create: `flock-voice-engine/runtime/test/kernel-restore.test.js`
- Create: `flock-voice-engine/runtime/test/no-audio-side-effects.test.js`
- Create: `flock-voice-engine/runtime/test/runtime-app.test.js`
- Modify: `flock-voice-engine/runtime/test/world-session.test.js`

**Interfaces:**

- Consumes Task 1 canonical sources/tests and prior `WorldSession`.
- Produces
  `createSimulationRuntime({ seed, config=DOMAIN_CONFIG, audioSink, restoredSnapshot=null })`,
  `createSimulationKernelFactory(dependencies={})`, `createNullAudioSink()` and
  `runtime.exportCheckpoint({ worldGeneration, revision, eventSeq })`.
- Freezes the kernel draft as
  `{ changed, snapshot, domainEvents, audioCommands, commandResult? }`. `tick()` omits
  `commandResult`; `applyCommand()` always includes it. Every field is recursively immutable;
  `domainEvents`, `audioCommands` and `commandResult` are JSON-safe, while the in-memory snapshot
  deliberately preserves canonical runtime `Infinity` timer values for shadow comparison.
  `snapshot` is always the current
  `{ ...world.getSnapshot(), paused, season: conductor.getChord().season }`, including for rejected,
  paused or otherwise unchanged operations.
- `dependencies` has the exact optional shape
  `{ configTemplate=DOMAIN_CONFIG, createAudioSink=createNullAudioSink }`.
- Produces `createRuntimeApp(dependencies) -> { server, registry, start, stop }`; it composes the real
  `WorldSessionRegistry`, `WorldSession`, bootstrap handler, WS gateway and kernel factory.
- Imports/constructors start no timer; only successful localhost `src/index.js` startup may enqueue
  fixed ticks.

- [ ] **Step 1: Run the entry gate and record the Task 1 source set**

```powershell
npm run verify:phase0
git status --short
```

Expected: exit 0 and clean tracked tree.

- [ ] **Step 2: Write migration, import-closure and replacement-test RED gates**

`domain-migration.json` must list config as `projection` and these canonical files as
`exact-copy`:

```text
world.js
sequence.js
economy.js
harmony.js
mapping.js
jungle.js
deterministic-conductor.js
deterministic-rng.js
simulation-checkpoint.js
master/policy.js
survival-actions.js
```

`domain-test-migration.json` must copy byte-for-byte all canonical behavior tests plus every Task 1
checkpoint test/support fixture. Tests mechanically require:

```js
assert.equal(sha256(item.source), sha256(item.candidate));
if (item.mode === 'exact-copy') {
  assert.equal(candidateDirectlyImportsMvp, false);
} else {
  assert.equal(item.mode, 'projection');
  assert.deepEqual(candidateDirectMvpImports, ['mvp/src/config.js']);
}
assert.equal(unledgeredRelativeImportCount, 0);
```

Only `mode:"projection"` config may import MVP `CONFIG`; every `mode:"exact-copy"` candidate must
have zero direct import/re-export/dynamic-import edges into `mvp/`. Transitive closure may cross only
the single declared `runtime/src/domain/config.js -> mvp/src/config.js` projection edge during shadow
Phase 2; any other route into `mvp/` fails.

Starting from `runtime/src/simulation-runtime.js`, the production implementation graph must also be
unable to reach `agent.js`, any test adapter, LLM/provider module, DOM/browser global, fetch,
WebSocket, AudioContext, legacy voice client/worklet, decoder, 8081 or an audio endpoint. Aside from
the one declared CONFIG projection edge, the graph may reach only declared domain copies and
NullAudioSink until a later audio phase explicitly changes that boundary.

The replacement list includes:

```text
conductor-characterization.test.js
deterministic-rng.test.js
simulation-checkpoint-schema.test.js
sequence-checkpoint.test.js
world-checkpoint.test.js
deterministic-conductor.test.js
simulation-checkpoint.test.js
fixtures/conductor-golden.js
fixtures/conductor-scenario.js
fixtures/checkpoint-owner.js
```

The complete suite set is:

```text
mvp/test/world.test.js
mvp/test/sequence.test.js
mvp/test/economy.test.js
mvp/test/harmony.test.js
mvp/test/harmony-frame.test.js
mvp/test/mapping.test.js
mvp/test/jungle.test.js
mvp/test/agent.test.js
mvp/test/daycycle.test.js
mvp/test/master-policy.test.js
mvp/test/survival-actions.test.js
mvp/test/conductor-characterization.test.js
mvp/test/deterministic-rng.test.js
mvp/test/simulation-checkpoint-schema.test.js
mvp/test/sequence-checkpoint.test.js
mvp/test/world-checkpoint.test.js
mvp/test/deterministic-conductor.test.js
mvp/test/simulation-checkpoint.test.js
```

Support files are exactly:

```text
mvp/test/helpers.js
mvp/test/fixtures/conductor-golden.js
mvp/test/fixtures/conductor-scenario.js
mvp/test/fixtures/checkpoint-owner.js
```

The one test-only exact-copy source is:

```text
agent.js
```

Adapters are exactly the runtime equivalents of:

```text
config.js
deterministic-conductor.js
deterministic-rng.js
economy.js
harmony.js
jungle.js
mapping.js
master/policy.js
sequence.js
simulation-checkpoint.js
survival-actions.js
world.js
```

The copied `agent.js` uses the three exact source discriminants and retains evaluator when
`setPipeline()` changes pipeline. Its transitive test graph may reach only the declared adapters and
runtime domain modules. All listed adapters are one-line re-exports except `config.js`, whose exact
test-only body is frozen below.

- [ ] **Step 3: Write real-runtime restore and side-effect RED tests**

`simulation-runtime.test.js` first freezes behavior that Task 3 will independently reproduce. It must
not derive expected results by importing the candidate's dispatcher, collector or audio mapper.
Cover:

```text
tick(dt) accepts only 0 < dt <= 1/config.sim.tickHz; DT + Number.EPSILON, DT*2 and giant dt are
  rejected before world/events/RNG even while paused; paused valid ticks return changed:false and no events/audio
an unpaused tick returns changed:true and the exact current runtime snapshot
every operation owns a fresh event/audio buffer; the previous operation cannot leak into the next
all nine world events retain synchronous emission order and exact payload:
  perch, unperch, dawn, dusk, sequence-pattern, sequence-step,
  agent-resume, season-migration, meter-change
only perch/unperch produce audio diagnostics, in the same relative order as those domain events
audioSink.accept(fullBatch) is called exactly once after a non-empty batch is complete and before
  the CommitDraft is returned; it is not called for an empty batch
dispose is idempotent and removes the nine collector subscriptions plus conductor subscriptions
```

The runtime collector is installed only after validated hydration and after the conductor installs
its five subscriptions. Constructor/dawn hydration events are therefore never smuggled into the
first operation. During an operation it immediately clones each callback payload into:

```js
{ name, payload }
```

For the matching `perch`/`unperch` callback, find the configured tree's `registerOffset`, read
`conductor.getChord()` at that callback, and call the exact-copy mapping helpers. The only Phase 2
audio diagnostic shapes are:

```js
({
  type: 'note.on',
  treeId: event.treeId,
  birdId: event.birdId,
  ...perchToNote(event, conductor.getChord(), runtimeConfig, registerOffset),
})

({
  type: 'note.release',
  treeId: event.treeId,
  birdId: event.birdId,
  ...unperchToRelease(event, conductor.getChord(), runtimeConfig, registerOffset),
})
```

No other event creates an audio command. The audio array is consequently an order-preserving
subsequence of the domain-event batch. Tests use hand-written expected objects for an eviction
(`unperch` then `perch`) and a later `bird.shoo`; an injected recording sink must receive the same
complete frozen array object returned in the draft. A separate real `NullAudioSink` assertion checks
the exact accepted-command count and `pcmFrameCount:0`.

The same test freezes exact payload, mutation and raw kernel `commandResult` semantics. A payload
must be a plain object with exactly the listed keys; missing/extra keys, wrong scalar types or
out-of-range indices return
`{ accepted:false, code:'INVALID_COMMAND_PAYLOAD' }` with `changed:false`. A valid payload rejected
by the canonical world method returns
`{ accepted:false, code:'DOMAIN_REJECTED' }` with `changed:false`.

| Name | Exact payload | Canonical call and successful raw `commandResult` |
|---|---|---|
| `runtime.pause` | `{}` | Set `paused=true`; `{accepted:true,code:changed?'OK':'NO_CHANGE',paused:true}` |
| `runtime.resume` | `{}` | Set `paused=false`; `{accepted:true,code:changed?'OK':'NO_CHANGE',paused:false}` |
| `sequence.toggle` | `{treeId,pitchBranchId,stepIndex}` | `world.toggleSequenceCell(...)`; `{accepted:true,code:'OK',treeId,pitchBranchId,stepIndex,active}` |
| `sequence.place` | `{treeId,pitchBranchId,stepIndex,stepCount}` | `world.userPlaceOnBranch(treeId,pitchBranchId,{pitchBranchId,stepIndex,stepCount})`; `{accepted:true,code:placement.same?'NO_CHANGE':'OK',placement}` |
| `bird.shoo` | `{birdId}` | `world.userShooBird(birdId)`; `{accepted:true,code:'OK',birdId}` |
| `transport.setTempo` | `{bpm}` | `world.setTempo(bpm)`; `{accepted:true,code:changed?'OK':'NO_CHANGE',bpm:after.bpm}` |
| `transport.setMeter` | `{beatsPerBar}` | `world.setBeatsPerBar(beatsPerBar)`; `{accepted:true,code:changed?'OK':'NO_CHANGE',beatsPerBar,barsPerDay:runtimeConfig.tempo.barsPerDay}` |

`treeId` must name a configured tree; `pitchBranchId`, `stepIndex`, `stepCount` and `birdId` are
non-negative integers, `pitchBranchId < config.tree.branches.length`, `bpm` is finite, and
`beatsPerBar` is exactly `2`, `4` or `8`. Only `sequence.place` carries `stepCount`, and its address
must satisfy `0 <= stepIndex < stepCount <= 64`. `sequence.toggle` carries no `stepCount`; after the
scalar/key checks, the canonical `world.toggleSequenceCell()` alone checks `stepIndex` against the
tree's current pattern or its canonical default grid and returns `DOMAIN_REJECTED` when out of range.
For `sequence.place`, `changed` is `placement.same !== true`; the exact canonical placement object
remains nested under `placement`. For tempo/meter, compare the before/after runtime snapshots/config
rather than treating the world method's boolean as proof of mutation.

Fresh Phase 2 worlds intentionally keep every tree under `AGENT` control and Phase 2 does not
implement `control.take`; therefore a valid fresh `sequence.toggle` is expected to return
`DOMAIN_REJECTED`. Its successful RED/GREEN case restores a fully validated Task 1 checkpoint whose
selected tree already has `control.treeControl[treeId] === 'USER'`. Neither candidate nor oracle may
set USER control as a hidden side effect of `sequence.toggle`.

`snapshot.request` returns `{accepted:false,code:'GATEWAY_ONLY_COMMAND'}`. The frozen later-phase set
`control.take/control.release/control.heartbeat/master.setSeasonLength/master.setColor/mix.setParam/
mix.setMute/mix.setSolo/voice.setMode/latent.setCursor/latent.setMode/preview.start/preview.stop`
returns `{accepted:false,code:'UNAVAILABLE_IN_PHASE_2'}`. Any other name returns
`{accepted:false,code:'UNKNOWN_COMMAND'}`. All three categories are unchanged drafts with empty event
and audio arrays. `WorldSession` alone adds `type`, `commandId` and delivery metadata; those fields
must not appear in the raw kernel result.

`kernel-restore.test.js` uses real `WorldSession` plus real
`createSimulationKernelFactory()`. Cover:

- compatible 300+300 mailbox checkpoint continuation;
- every checkpoint capture occurring atomically inside the same mailbox:

  ```js
  const checkpoint = await session.runExclusive(
    'checkpoint.export',
    (owner) => owner.kernel.exportCheckpoint({
      worldGeneration: owner.worldGeneration,
      revision: owner.revision,
      eventSeq: owner.eventSeq,
    }),
  );
  ```

  Reading the cursor tuple and exporting the kernel outside this callback is forbidden because a fixed
  tick could interleave;
- exact generation/revision/eventSeq restore;
- the full byte-copied Task 1 corruption matrix becoming a wholly fresh real kernel with
  `restoredSnapshot:null`;
- validation occurring before RNG/world/conductor construction;
- separate config clone per runtime;
- provider-free construction with all legacy sources null.

For every invalid matrix row, independently mutate a valid in-memory checkpoint before any
`JSON.stringify()`, then prove all of:

```text
validateSimulationCheckpoint() returns false without throwing
direct createSimulationRuntime() rejects before RNG/world/conductor/listener construction
WorldSession passes restoredSnapshot:null to the real factory
the rebuilt session gets a new opaque generation and revision=eventSeq=0
its domain and RNG state equals an independently created fresh real kernel
no poisoned world/conductor/sequence/control/RNG field survives
```

Harden `WorldSession` restore admission as part of this RED/GREEN step. It may examine checkpoint
envelope fields only after `validateRestoredSnapshot()` returned true and one full clone succeeded.
All later compatibility checks, kernel input and restored cursors use that accepted clone—not the
caller object. A validator throw, clone failure, accessor/proxy trap or failed invariant yields
`acceptedSnapshot=null`; the session must neither re-read poisoned fields nor throw, and must create
one wholly fresh kernel. Add the generic accessor/throwing-validator cases to
`world-session.test.js`, then exercise the canonical validator via `kernel-restore.test.js`.

The canonical matrix covers fixed identity/version/config/seed/generation/cursors; exact section and
tree-key sets; contiguous bird IDs and all tree/branch/sequence/control references; conductor
cursor/pending/frame/chord/hold/history/harmony state; both RNG half-state/extra-key/range/
safe-drawCount/seed-cursor relations; the three allowed wire sentinels and all schema-defined ordinary
nullable fields; and raw `undefined`, NaN, true ±Infinity, BigInt, function, Promise, symbol, cycle,
shared alias, accessor and non-plain prototype values. Installed legacy sources/hooks are a separate
export-fail-closed matrix: they are not corrupt restore input.

`no-audio-side-effects.test.js` replaces globals with throwing sentinels and proves import,
construction and ticks never touch fetch/WebSocket/AudioContext, client files, `/decoder`,
`/api/v1/audio` or 8081.

`runtime-app.test.js` uses real registry/session/kernel plus injected server, gateway and scheduler
spies. It proves:

```text
module import and createRuntimeApp() schedule zero timers and do not listen
start() wires a non-null bootstrap apiHandler and WS upgradeHandler
an allowed-origin /api/v1/bootstrap call returns 200 rather than the server's 404 fallback
no fixed tick is scheduled until the localhost listen callback succeeds
exactly one 1 / DOMAIN_CONFIG.sim.tickHz loop is scheduled after listen
each callback enqueues session.commit('fixed.tick', ...) and advances the real kernel/revision once
stop() clears the timer, disposes the kernel inside the mailbox and closes the server once
stop() closes/terminates an active upgraded WS, lets its detach cross the shutdown barrier, then
disposes the kernel; no live subscription/socket remains
a concurrent upgrade after shutdown begins is rejected before gateway attach and cannot touch the
disposed kernel
production index passes only loadRuntimeConfig() host/port/origin and fixed shadow seed
```

- [ ] **Step 4: Run RED**

```powershell
node --test flock-voice-engine/runtime/test/domain-parity.test.js flock-voice-engine/runtime/test/domain-import-closure.test.js flock-voice-engine/runtime/test/domain/test-migration.test.js flock-voice-engine/runtime/test/simulation-runtime.test.js flock-voice-engine/runtime/test/kernel-restore.test.js flock-voice-engine/runtime/test/no-audio-side-effects.test.js flock-voice-engine/runtime/test/runtime-app.test.js flock-voice-engine/runtime/test/world-session.test.js
```

Expected: failure because the reconciled candidate/ledgers/runtime do not yet exist.

- [ ] **Step 5: Create the projection and exact-copy graph**

`runtime/src/domain/config.js` imports MVP `CONFIG` only during shadow Phase 2 and exports a
deep-cloned/frozen `DOMAIN_CONFIG` containing domain-only sim/tempo/llm range/harmony, explicit
world geometry/tree identity fields, birds/species/dayCycle/agent/economy/mapping and only the audio
mapping values consumed by domain code. Tests reject `visual`, voiceEngine, latentAgent, log,
treeAsset, birdAsset, birdFrames, branchAnchors, layout, endpoint/url/key/secret, 8081, StepFun and
DeepSeek fields.

Use this projection body:

```js
import { CONFIG as MVP_CONFIG } from '../../../../mvp/src/config.js';

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export function createDomainConfigProjection(source) {
  return deepFreeze(structuredClone({
    sim: source.sim,
    tempo: source.tempo,
    llm: {
      seasonLengthRange: source.llm.seasonLengthRange,
      masterCooldownDays: source.llm.masterCooldownDays,
    },
    harmony: source.harmony,
    tree: {
      trunkHeight: source.tree.trunkHeight,
      branches: source.tree.branches,
      perchSlotsPerBranch: source.tree.perchSlotsPerBranch,
      slotSpacing: source.tree.slotSpacing,
      slotStart: source.tree.slotStart,
    },
    trees: source.trees.map((tree) => ({
      id: tree.id,
      species: tree.species,
      xOffset: tree.xOffset,
      birdCount: tree.birdCount,
      mirror: tree.mirror,
      drawScale: tree.drawScale,
      registerOffset: tree.registerOffset,
      ...(Array.isArray(tree.pitchBranchWeights)
        ? { pitchBranchWeights: tree.pitchBranchWeights }
        : {}),
    })),
    birds: source.birds,
    species: source.species,
    dayCycle: source.dayCycle,
    agent: source.agent,
    economy: source.economy,
    mapping: source.mapping,
    audio: {
      filterBaseHz: source.audio.filterBaseHz,
      filterDaylightSpan: source.audio.filterDaylightSpan,
      nightGainScale: source.audio.nightGainScale,
      timbres: {
        pad: {
          voicingRange: source.audio.timbres.pad.voicingRange,
        },
        texture: {
          mode: source.audio.timbres.texture.mode,
          jungleTempoMultiplier: source.audio.timbres.texture.jungleTempoMultiplier,
        },
      },
    },
  }));
}

export const DOMAIN_CONFIG = createDomainConfigProjection(MVP_CONFIG);
// Exact-copy production modules retain their canonical import name.
export const CONFIG = DOMAIN_CONFIG;
```

`DOMAIN_CONFIG`/production `CONFIG` are the same recursively frozen template.
`simulation-runtime.js` must clone `DOMAIN_CONFIG` per owner and pass that clone explicitly to every
domain constructor. Import-closure/runtime tests reject any production constructor path that falls
back to the frozen singleton.

Byte-identical source tests exercise the browser's current shallow-frozen CONFIG mutation semantics,
so the declared test adapter is the sole compatibility exception:

```js
import { DOMAIN_CONFIG } from '../../src/domain/config.js';
export {
  createDomainConfigProjection,
  DOMAIN_CONFIG,
} from '../../src/domain/config.js';
export const CONFIG = Object.freeze(structuredClone(DOMAIN_CONFIG));
```

Every imported test module receives that test-only mutable-nested clone explicitly; production code
cannot reach `runtime/test/src/config.js`.

Use this exact domain-ledger envelope:

```json
{
  "schemaVersion": 1,
  "behaviorOwner": "mvp/src",
  "candidateMode": "shadow-only",
  "deleteByPhase": 5,
  "files": [
    { "mode": "projection", "source": "mvp/src/config.js", "candidate": "flock-voice-engine/runtime/src/domain/config.js" },
    { "mode": "exact-copy", "source": "mvp/src/world.js", "candidate": "flock-voice-engine/runtime/src/domain/world.js" },
    { "mode": "exact-copy", "source": "mvp/src/sequence.js", "candidate": "flock-voice-engine/runtime/src/domain/sequence.js" },
    { "mode": "exact-copy", "source": "mvp/src/economy.js", "candidate": "flock-voice-engine/runtime/src/domain/economy.js" },
    { "mode": "exact-copy", "source": "mvp/src/harmony.js", "candidate": "flock-voice-engine/runtime/src/domain/harmony.js" },
    { "mode": "exact-copy", "source": "mvp/src/mapping.js", "candidate": "flock-voice-engine/runtime/src/domain/mapping.js" },
    { "mode": "exact-copy", "source": "mvp/src/jungle.js", "candidate": "flock-voice-engine/runtime/src/domain/jungle.js" },
    { "mode": "exact-copy", "source": "mvp/src/deterministic-conductor.js", "candidate": "flock-voice-engine/runtime/src/domain/deterministic-conductor.js" },
    { "mode": "exact-copy", "source": "mvp/src/deterministic-rng.js", "candidate": "flock-voice-engine/runtime/src/domain/deterministic-rng.js" },
    { "mode": "exact-copy", "source": "mvp/src/simulation-checkpoint.js", "candidate": "flock-voice-engine/runtime/src/domain/simulation-checkpoint.js" },
    { "mode": "exact-copy", "source": "mvp/src/master/policy.js", "candidate": "flock-voice-engine/runtime/src/domain/master/policy.js" },
    { "mode": "exact-copy", "source": "mvp/src/survival-actions.js", "candidate": "flock-voice-engine/runtime/src/domain/survival-actions.js" }
  ]
}
```

The test ledger uses `schemaVersion:2`, `normalization:"none-byte-for-byte"` and four explicit
arrays:

```text
suites       every canonical behavior/checkpoint *.test.js path
supportFiles helpers.js plus every Task 1 fixture path
testSources  mvp/src/agent.js -> runtime/test/src/agent.js as an exact-copy pair
adapters     every other runtime/test/src target, with kind one-line-reexport or test-config-clone
```

The test itself asserts the exact required path sets, adapter kinds, no duplicates and no undeclared
copies, and checks SHA-256 equality for every suite, support file and test source. The exact-copy
`runtime/test/src/agent.js` resolves its relative imports only through declared adapters; it is not
replaced by a handwritten behavioral wrapper.
Materialize copies only from the ledgers:

```powershell
$domainLedger = Get-Content 'flock-voice-engine/runtime/domain-migration.json' -Raw -Encoding utf8 |
  ConvertFrom-Json
$testLedger = Get-Content 'flock-voice-engine/runtime/domain-test-migration.json' -Raw -Encoding utf8 |
  ConvertFrom-Json
$copies = @(
  $domainLedger.files | Where-Object mode -eq 'exact-copy'
  $testLedger.suites
  $testLedger.supportFiles
  $testLedger.testSources
)
foreach ($copy in $copies) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy.candidate) | Out-Null
  Copy-Item -LiteralPath $copy.source -Destination $copy.candidate
}
```

Copy every exact-copy source and replacement test/support/test-source file from ledger paths. Do not
hand-edit a candidate. Adapters use their ledgered exact bodies: config is the test-only clone above
and every other adapter is a one-line re-export into runtime domain. The copied browser adapter
therefore exercises the exact
`pipeline-v1/evaluator-v1/combined-v1` construction and `setPipeline()` behavior against candidate
domain code without importing browser-owned implementation files.

- [ ] **Step 6: Implement provider-free SimulationRuntime**

The constructor order is:

```js
function deepFreezeJson(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

export function createSimulationRuntime({
  seed,
  config = DOMAIN_CONFIG,
  audioSink = createNullAudioSink(),
  restoredSnapshot = null,
}) {
  assertCanonicalSeed(seed);
  if (restoredSnapshot !== null && !validateSimulationCheckpoint(restoredSnapshot, {
    seed,
    configRevision: SIMULATION_CONFIG_REVISION,
  })) {
    throw new Error('INCOMPATIBLE_SIMULATION_CHECKPOINT');
  }
  const restored = restoredSnapshot === null
    ? null
    : structuredClone(restoredSnapshot);
  const runtimeConfig = structuredClone(config);
  const worldRng = createDeterministicRng(seed, restored?.rng.world ?? null);
  const conductorSeed = deriveConductorSeed(seed);
  const conductorRng = createDeterministicRng(
    conductorSeed,
    restored?.rng.conductor ?? null,
  );
  const worldState = restored === null ? null : {
    world: restored.world,
    sequence: {
      worldPatterns: restored.sequence.worldPatterns,
      jungleEditPlans: restored.sequence.jungleEditPlans,
      lastSequenceStep: restored.sequence.lastSequenceStep,
    },
    control: {
      treeControl: restored.control.treeControl,
      agentResumeAt: restored.control.agentResumeAt,
      tempo: restored.control.tempo,
    },
  };
  const conductorState = restored === null ? null : {
    conductor: restored.conductor,
    sequence: {
      bridgeCurrent: restored.sequence.bridgeCurrent,
      bridgePrevious: restored.sequence.bridgePrevious,
      reviewedPattern: restored.sequence.reviewedPattern,
      plannedPatterns: restored.sequence.plannedPatterns,
    },
    control: {
      masterControl: restored.control.masterControl,
      pendingUserSeasonLength: restored.control.pendingUserSeasonLength,
    },
  };
  const world = createWorld({
    config: runtimeConfig,
    rng: worldRng,
    restoredState: worldState,
  });
  const conductor = createDeterministicConductor(world, {
    config: runtimeConfig,
    rng: conductorRng,
    restoredState: conductorState,
    reviewSource: null,
    ecologyProvider: null,
    getPercussionMode: null,
  });
  let paused = restored?.control.paused ?? false;

  function getSnapshot() {
    return deepFreezeJson(structuredClone({
      ...world.getSnapshot(),
      paused,
      season: conductor.getChord().season,
    }));
  }

  function exportCheckpoint({ worldGeneration, revision, eventSeq }) {
    return createSimulationCheckpoint({
      worldGeneration,
      seed,
      revision,
      eventSeq,
      worldState: world.exportDeterministicState(),
      conductorState: conductor.exportDeterministicState(),
      worldRng,
      conductorRng,
      paused,
    });
  }

  return Object.freeze({
    tick,
    applyCommand,
    getSnapshot,
    exportCheckpoint,
    dispose,
  });
}

export function createSimulationKernelFactory({
  configTemplate = DOMAIN_CONFIG,
  createAudioSink = createNullAudioSink,
} = {}) {
  return ({ seed, restoredSnapshot = null }) => createSimulationRuntime({
    seed,
    config: configTemplate,
    audioSink: createAudioSink(),
    restoredSnapshot,
  });
}
```

No invalid non-null checkpoint may be repaired inside this constructor. `WorldSession` performs the
policy decision to supply `null` for a clean rebuild. `createSimulationKernelFactory()` treats its
config as a template and calls `createAudioSink()` once per kernel creation; runtimes never share a
mutable config clone or NullAudioSink counter.

Implement each operation through one synchronous `runOperation()` guard. It creates fresh
`domainEvents`/`audioCommands` arrays, forbids nesting, runs the world mutation, clones/freezes the
complete batch, calls `audioSink.accept(audioCommands)` exactly once only when that array is
non-empty, then returns the frozen draft. The nine collector unsubscribe functions are retained
separately from the conductor's five subscriptions and all are released by idempotent `dispose()`.

`tick(dt)` validates `Number.isFinite(dt) && dt > 0 && dt <= 1 / config.sim.tickHz` before opening
the batch. `DT` and `DT/2` are valid; `DT + Number.EPSILON`, `DT*2` and giant dt fail before
world/events/RNG. If paused, a valid tick returns a complete unchanged draft without calling
`world.tick()`; otherwise it calls `world.tick(dt)` and
returns `changed:true`. `applyCommand()` implements the exact payload/result table and validation
codes frozen in Step 3; no candidate-specific normalization or inferred default payload is allowed.

```text
runtime.pause
runtime.resume
sequence.toggle
sequence.place
bird.shoo
transport.setTempo
transport.setMeter
```

`snapshot.request` remains a gateway-only barrier, later-phase names return
`UNAVAILABLE_IN_PHASE_2`, and unknown names return `UNKNOWN_COMMAND`, all with the exact raw result
shapes frozen in Step 3.

- [ ] **Step 7: Keep audio inert and compose the localhost runtime app**

`createNullAudioSink()` uses:

```js
export function createNullAudioSink() {
  let acceptedCommandCount = 0;
  return Object.freeze({
    accept(commands) {
      acceptedCommandCount += Array.isArray(commands) ? commands.length : 0;
    },
    getStatus() {
      return Object.freeze({
        mode: 'null',
        acceptedCommandCount,
        pcmFrameCount: 0,
      });
    },
  });
}
```

Freeze `PHASE_2_SHADOW_SEED = 0x4c4353`. `createRuntimeApp()` defaults to the real components and
permits constructor/scheduler/server factories only as test dependencies. It must compose in this
order:

```text
createSimulationKernelFactory()
WorldSession({ seed, createKernel, validateRestoredSnapshot, restoredSnapshot, releaseRevision })
WorldSessionRegistry({ createSession }) with exactly one lazy default session
createBootstrapHandler({ getSession: id => registry.get(id), allowedOrigin })
owned WebSocketServer({ noServer:true, clientTracking:true })
createRuntimeWsGateway({ getSession: id => registry.get(id), allowedOrigin, webSocketServer })
createCandidateServer({ releaseInfo, apiHandler, upgradeHandler })
```

`validateRestoredSnapshot` calls the canonical validator with the fixed seed/config revision.
Production Phase 2 passes `restoredSnapshot:null`; tests may inject a checkpoint. `start()` listens on
its supplied host/port and creates exactly one fixed-step timer only from the successful listen
callback. Every callback enqueues
`session.commit('fixed.tick', owner => owner.kernel.tick(1 / DOMAIN_CONFIG.sim.tickHz))`; it never
ticks the kernel outside the mailbox. Rejected tick Promises fail closed and trigger app shutdown
rather than becoming unhandled rejections.

`stop()` is idempotent. First set `stopping=true`, clear the timer, reject any later upgrade in the
app-owned wrapper before it reaches the gateway, and initiate HTTP server close so no new connection
can enter. Then close/terminate every socket tracked by the app-owned WebSocketServer and await its
close; enqueue a session shutdown barrier, dispose an already-created kernel inside its mailbox, close
the WebSocketServer, and await both server closures. A concurrent-upgrade RED must prove this order.
This uses the existing frozen gateway surface `{ handleUpgrade, routeCommand }`—no invented gateway
close method. It must not instantiate the lazy session merely to stop an app that never ticked or
served a client. Double `start()` rejects.

Runtime imports and constructors start no timer or network listener. `src/index.js` is the only executable
composition root: it reads `loadRuntimeConfig()` and `loadReleaseInfo()`, constructs the app with the
fixed seed, awaits `start()` using exactly the validated `127.0.0.1:18090` host/port/origin, and
installs SIGINT/SIGTERM handlers that await `stop()`. It passes the real bootstrap and upgrade handlers
to `createCandidateServer`; `/api/v1/bootstrap` must not fall through to 404.

- [ ] **Step 8: Run GREEN, parity and both Node versions**

```powershell
$nodeMajor = node -p "process.versions.node.split('.')[0]"
if ($nodeMajor -ne '24') { throw "Node 24 required, got $nodeMajor" }
node --test flock-voice-engine/runtime/test/domain-parity.test.js flock-voice-engine/runtime/test/domain-import-closure.test.js flock-voice-engine/runtime/test/domain/test-migration.test.js flock-voice-engine/runtime/test/simulation-runtime.test.js flock-voice-engine/runtime/test/kernel-restore.test.js flock-voice-engine/runtime/test/no-audio-side-effects.test.js flock-voice-engine/runtime/test/runtime-app.test.js flock-voice-engine/runtime/test/world-session.test.js
npm run test:runtime
$node20Tests = Get-ChildItem 'flock-voice-engine/runtime/test' -Recurse -Filter '*.test.js' -File |
  Sort-Object FullName |
  ForEach-Object { $_.FullName }
npx -y node@20 --test @node20Tests
npm run verify:phase0
git diff --check
```

Expected: every exact-copy source/test pair matches SHA-256, import graphs close, compatible restore
continues exactly, all incompatible variants rebuild cleanly, no external side effect occurs, and
PCM count stays zero.

- [ ] **Step 9: Commit**

```powershell
git add flock-voice-engine/runtime/package.json flock-voice-engine/runtime/domain-migration.json flock-voice-engine/runtime/domain-test-migration.json flock-voice-engine/runtime/src/domain flock-voice-engine/runtime/src/audio/null-audio-sink.js flock-voice-engine/runtime/src/simulation-runtime.js flock-voice-engine/runtime/src/runtime-app.js flock-voice-engine/runtime/src/world-session/world-session.js flock-voice-engine/runtime/src/index.js flock-voice-engine/runtime/test
git commit -m "feat(runtime): add checkpointable shadow kernel"
```

Generate an exact Task 2 review package. Fix every Critical/Important before Task 3.

---

### Task 3: Reconcile Phase Task 8 — deterministic shadow replay

**Files:**

- Create: `mvp/eval/shadow-oracle.js`
- Create: `flock-voice-engine/runtime/src/shadow/canonicalize.js`
- Create: `flock-voice-engine/runtime/src/shadow/compare.js`
- Create: `flock-voice-engine/runtime/src/shadow/shadow-runner.js`
- Create: `flock-voice-engine/runtime/test/fixtures/phase2-shadow-cases.json`
- Create: `flock-voice-engine/runtime/test/shadow-oracle-import-closure.test.js`
- Create: `flock-voice-engine/runtime/test/shadow-replay.test.js`

**Interfaces:**

- Produces
  `createShadowOracle({ seed, config=CONFIG, restoredSnapshot=null })` with
  `tick/applyCommand/getSnapshot/exportCheckpoint/dispose`; `tick()` and `applyCommand()` each return
  the Task 2 complete `CommitDraft`, including that operation's ordered `domainEvents` and diagnostic
  `audioCommands`.
- Produces `createShadowRunner({ createOracle })`; its required injected oracle factory has no default,
  and its
  `runShadowCase(testCase) -> Promise<{
    matched,
    comparedTicks,
    comparedBatches,
    firstDifference,
  }>`.
- Produces `assertShadowMatch(result)`.
- Does not change interfaces consumed by Phase Task 9 candidate UI.

- [ ] **Step 1: Re-run migration/restore front doors, then write replay RED tests**

Before authoring shadow code, run Task 2's `domain-migration.json`,
`domain-test-migration.json`, SHA parity, implementation import closure and replacement-test
migration tests. The same gates run again at Task 3 completion; Task 3 may not create a third domain
copy or modify a ledgered exact-copy file.

```powershell
npm run verify:phase0
node --test flock-voice-engine/runtime/test/domain-parity.test.js flock-voice-engine/runtime/test/domain-import-closure.test.js flock-voice-engine/runtime/test/domain/test-migration.test.js flock-voice-engine/runtime/test/domain/simulation-checkpoint-schema.test.js flock-voice-engine/runtime/test/domain/simulation-checkpoint.test.js
```

The fixture contains five named cases:

```text
600 fixed 1/30 ticks
equal elapsed time under deterministic tick partitioning using only legal partitions no larger than 1/30
sequence toggle/place plus bird shoo interleaving
complete dawn/dusk/day transition
300 ticks -> JSON checkpoint -> reconstruct both owners -> 300 ticks
```

Each case fixes `seed`, `worldGeneration:"shadow-generation"`, command schedule and whether to compare
the final explicit checkpoint. IDs/addresses are derived from the initial snapshot, not hard-coded.
Every command and every tick is a separate logical batch; commands due at the same tick remain
individually ordered operations.

Tests compare bootstrap state, then `changed`, exact `commandResult`, exact ordered diagnostic
`audioCommands`, snapshot, ordered domain events, envelope and RNG states after every command/tick
batch, followed by any explicit final checkpoint. `audioCommands` are comparison-only diagnostics
consumed by NullAudioSink; this does not authorize PCM or a real audio worker:

```js
const { runShadowCase } = createShadowRunner({
  createOracle: createShadowOracle,
});
for (const testCase of cases) {
  const result = await runShadowCase(testCase);
  assert.equal(result.matched, true, JSON.stringify(result.firstDifference, null, 2));
  assert.equal(result.comparedTicks, testCase.ticks);
  assert.equal(result.comparedBatches, testCase.expectedBatches);
}
```

Deliberately corrupt one envelope cursor, one command result, one audio command/order, one snapshot
field, one domain-event payload/order and one RNG cursor/draw. A separate RED passes NaN on both
snapshot sides and requires a mismatch rather than equality. Require the first difference to identify:

```js
({
  /** @type {'envelope' | 'commandResult' | 'audioCommands' | 'snapshot' | 'events' | 'rng' | 'checkpoint'} */
  kind: 'snapshot',
  tick,
  operationIndex,
  eventIndex,
  path,
  expected,
  actual,
  tolerance,
  recentExpectedEvents,
  recentActualEvents,
  expectedRng,
  actualRng,
});
```

The 300+300 case compares complete checkpoints at initial bootstrap, before restore, immediately after
restore and final. Restore must consume zero RNG draws, publish zero initialization events, skip the
initial dawn and reproduce the pre-restore checkpoint byte-for-byte. Two consecutive explicit exports
must be equal and must not change events or RNG.

Task 3 consumes—rather than redefines—the byte-copied Task 1 checkpoint schema/restore suites and
canonical corruption matrix. Its focused front door explicitly runs both schema and restore suites so
shadow parity cannot pass after those contracts regress.

- [ ] **Step 2: Freeze comparison rules**

Arrays retain order; object keys sort recursively; unlisted values compare exactly. These tolerances
apply only to snapshot paths:

```js
export const SHADOW_TOLERANCES = Object.freeze({
  '$.simTime': 1e-12,
  '$.phase': 1e-12,
  '$.daylight': 1e-12,
  '$.meanEnergy': 1e-12,
  '$.birds[*].energy': 1e-12,
  '$.birds[*].dwellTime': 1e-12,
  '$.birds[*].dwellBeatTime': 1e-12,
  '$.birds[*].flightTime': 1e-12,
  '$.birds[*].plannedDwell': 1e-12,
  '$.birds[*].plannedFlight': 1e-12,
  '$.birds[*].pos.x': 1e-12,
  '$.birds[*].pos.y': 1e-12,
  '$.trees[*].meanEnergy': 1e-12,
  '$.trees[*].birds[*].energy': 1e-12,
  '$.trees[*].birds[*].dwellTime': 1e-12,
  '$.trees[*].birds[*].dwellBeatTime': 1e-12,
  '$.trees[*].birds[*].flightTime': 1e-12,
  '$.trees[*].birds[*].plannedDwell': 1e-12,
  '$.trees[*].birds[*].plannedFlight': 1e-12,
  '$.trees[*].birds[*].pos.x': 1e-12,
  '$.trees[*].birds[*].pos.y': 1e-12,
});
```

Checkpoint wire, IDs, enums, booleans, strings and RNG state/drawCount compare exactly; `null`
sentinels are never coerced. Numeric comparison first rejects when
`Number.isNaN(expected) || Number.isNaN(actual)`, then uses `Object.is(expected, actual)` so matching
runtime `Infinity` and `-0` values do not fall through to subtraction, and only then applies a
whitelisted tolerance. Envelope fields, command results, ordered audio diagnostics and complete
ordered domain-event names/payloads also compare exactly. Every tolerance pattern must match at least
one committed fixture path so stale or misspelled patterns fail the test.

- [ ] **Step 3: Run RED**

```powershell
node --test flock-voice-engine/runtime/test/domain-parity.test.js flock-voice-engine/runtime/test/domain-import-closure.test.js flock-voice-engine/runtime/test/domain/test-migration.test.js flock-voice-engine/runtime/test/domain/simulation-checkpoint-schema.test.js flock-voice-engine/runtime/test/domain/simulation-checkpoint.test.js flock-voice-engine/runtime/test/shadow-oracle-import-closure.test.js flock-voice-engine/runtime/test/shadow-replay.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` for a shadow module or oracle.

- [ ] **Step 4: Implement an independent MVP oracle**

`mvp/eval/shadow-oracle.js` imports only MVP canonical domain files. It:

- takes `CONFIG` only as a template and creates an independent `structuredClone(config)` per oracle;
- validates any full non-null checkpoint before seed/world/conductor/listener construction, then uses
  the same frozen world/conductor slices and paused field as Task 1;
- uses root seed for world and the shared `deriveConductorSeed(seed)` helper for conductor;
- passes literal `reviewSource:null`, `ecologyProvider:null`, `getPercussionMode:null`; an object whose
  methods merely return null is forbidden;
- independently implements Task 2's exact nine-event collector, two diagnostic mapping shapes,
  operation-local drain, sink timing, snapshot projection and seven-command payload/result table;
  it may import MVP canonical mapping/world/conductor helpers, but may not import the candidate
  dispatcher, collector, command table or any runtime helper that encodes expected behavior;
- returns each operation's raw complete `CommitDraft`; the runner owns a separate oracle envelope
  cursor rather than reading candidate cursors;
- creates no checkpoint unless `exportCheckpoint()` is explicitly called by the test;
- never imports runtime candidate files.

Its mechanical import-closure test starts at `mvp/eval/shadow-oracle.js` and rejects reachability to
`agent.js`, `attachPipelineConductor`, `main.js`, audio/voice/worklet, LLM/provider/fetch or any
runtime candidate file. A separate check proves the production graph rooted at
`runtime/src/simulation-runtime.js`/`runtime/src/index.js` and the candidate UI graph cannot reach the
oracle or `runtime/src/shadow`; `shadow-runner.js` receives the oracle factory only by test injection
and does not statically import MVP. Every explicit per-batch checkpoint export succeeding is itself a
provider-free assertion; any installed legacy hook must fail closed even if its Promise resolved and
no pending plan remains.

- [ ] **Step 5: Implement candidate-only runner and comparator**

`shadow-runner.js` statically imports candidate code only from runtime `src`, requires its
`createOracle` dependency from the caller, and drives the candidate through a real `WorldSession`
mailbox with an injected constant `worldGenerationFactory`. For every logical operation—each command
and each tick separately:

1. invoke the same operation on oracle and candidate in fixture order;
2. call `session.commit('shadow.command', owner => owner.kernel.applyCommand(command))` for commands
   and `session.commit('shadow.tick', owner => owner.kernel.tick(dt))` for ticks—never
   `executeCommand()`—then await and compare `changed`, `commandResult` and `audioCommands`;
3. advance the independent oracle envelope cursor only if its draft changed, then compare protocol
   envelope, domain snapshot and the complete, uncropped ordered event batch;
4. export candidate state with the exact `checkpoint.export` mailbox callback frozen in Task 2,
   export oracle state with its independent cursor, and compare
   `rng.world/rng.conductor` `{state,drawCount}`;
5. stop at the first difference.

For a changed batch, both `revision` and `eventSeq` increment exactly once. The entire batch shares
that `eventSeq`; zero-based `eventIndex` records event order. They never increment by event count. An
unchanged batch increments neither cursor. The oracle cursor initializes from its own restored
checkpoint or zero and is never copied from candidate output.

At a case's explicit final checkpoint marker, export both sides using the same
worldGeneration/revision/eventSeq and compare the entire JSON wire, including both RNG states.
In the restore case, JSON-round-trip both sides, dispose both owners, rebuild oracle and real
`WorldSession`, and continue only after immediate checkpoint equality proves the restoration seam.
Never drop or rewrite a field, sort events, or derive an expected value from candidate output merely
to obtain parity.

- [ ] **Step 6: Run GREEN twice, then all gates**

```powershell
$focused = @(
  'flock-voice-engine/runtime/test/domain-parity.test.js',
  'flock-voice-engine/runtime/test/domain-import-closure.test.js',
  'flock-voice-engine/runtime/test/domain/test-migration.test.js',
  'flock-voice-engine/runtime/test/domain/simulation-checkpoint-schema.test.js',
  'flock-voice-engine/runtime/test/domain/simulation-checkpoint.test.js',
  'flock-voice-engine/runtime/test/shadow-oracle-import-closure.test.js',
  'flock-voice-engine/runtime/test/shadow-replay.test.js'
)
$nodeMajor = node -p "process.versions.node.split('.')[0]"
if ($nodeMajor -ne '24') { throw "Node 24 required, got $nodeMajor" }
node --test @focused
node --test @focused
npm run test:runtime
npm run test:mvp
$node20Tests = Get-ChildItem 'flock-voice-engine/runtime/test' -Recurse -Filter '*.test.js' -File |
  Sort-Object FullName |
  ForEach-Object { $_.FullName }
npx -y node@20 --test @node20Tests
npm run verify:phase0
git diff --check
```

Expected: both Node 24 repetitions and Node 20 pass with identical compared tick counts and no first
difference. Task 9's existing RuntimeClient/candidate UI interfaces remain unchanged.

- [ ] **Step 7: Commit**

```powershell
git add mvp/eval/shadow-oracle.js flock-voice-engine/runtime/src/shadow flock-voice-engine/runtime/test/fixtures/phase2-shadow-cases.json flock-voice-engine/runtime/test/shadow-oracle-import-closure.test.js flock-voice-engine/runtime/test/shadow-replay.test.js
git commit -m "test(runtime): prove checkpoint-aware shadow parity"
```

Generate an exact Task 3 review package. After it is clean, resume Phase Task 9 from the original
Phase 1–2 plan. Task 9 must not change the frozen kernel/RuntimeClient surfaces. Its candidate UI and
the production `mvp/index.html -> mvp/src/main.js` graph must not reach `mvp/eval/shadow-oracle.js` or
`runtime/src/shadow/`; `verify:phase12` continues to include shadow replay through recursive runtime
test discovery.

---

## Plan Completion Gate

Before describing Tasks 6–8 as complete:

```powershell
git status --short
npm run verify:phase0
$nodeMajor = node -p "process.versions.node.split('.')[0]"
if ($nodeMajor -ne '24') { throw "Node 24 required, got $nodeMajor" }
npm run test:runtime
npm run test:mvp
$runtimeTests = Get-ChildItem 'flock-voice-engine/runtime/test' -Recurse -Filter '*.test.js' -File |
  Sort-Object FullName |
  ForEach-Object { $_.FullName }
npx -y node@20 --test @runtimeTests
git diff --check
```

Require a clean tracked tree, all commands exit 0, independent per-task reviews have
`0 Critical / 0 Important`, and no production/remote action appears in the reports.

## Execution Handoff

The user already selected Subagent-Driven execution. Use:

1. one Task 1 implementer retained across subcommits A–F;
2. one fresh read-only reviewer after each Task 1 subcommit;
3. a fresh Task 2 implementer and reviewer;
4. a fresh Task 3 implementer and reviewer;
5. one broad Tasks 1–3 branch review before continuing Phase Task 9.
