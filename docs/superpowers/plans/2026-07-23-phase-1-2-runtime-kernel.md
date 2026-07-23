# Phase 1–2 Runtime Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变生产 8090、浏览器 world/audio 所有权或 PCM 路径的前提下，建立只监听 localhost 的 Node 控制面、可靠的 runtime 状态协议、前端惰性客户端骨架和与现有浏览器内核确定性等价的 Phase 2 shadow runtime。

**Architecture:** 采用 strangler 迁移：`default` 世界的候选 Node runtime 通过单一 `WorldSession` mailbox 串行处理 bootstrap、attach、command 与 fixed-step tick，并以有界 journal 提供 replay 或 snapshot barrier；生产仍由浏览器推进。现有确定性 domain 先抽出 conductor/checkpoint seam，再复制为带迁移台账的 shadow candidate；可选 `SimulationCheckpoint` 完整保存 world、conductor、sequence、control 与 RNG 状态，用真实 kernel 证明兼容恢复连续演进及不兼容重建。shadow 用同 seed、同 tick、同命令逐批比较；候选页面只读临时端口 snapshot，且生产入口模块图机械证明不可达 RuntimeClient、候选 fixture 或 server-owner 实现。

**Tech Stack:** Node.js 20 与 24、ES modules、原生 `node:test`、`ws@8.21.1`、Web Crypto/`node:crypto`、浏览器 ES modules、`@playwright/test@1.61.1`、Python 3 静态测试服务器、现有 JavaScript/Python Phase 0 门禁。

## Global Constraints

- 开始实施前，`4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9` 必须是当前分支祖先；`docs/production-manifests/2026-07-22-production.json` 的 SHA-256 必须精确为 `1ebd697b2e0d0cec8b0cbec008fc884179c6273b97952837f661c2c39f6065ec`；metadata 中 vendor tree SHA 必须精确为 `21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049`。
- 每个任务开始前运行 `npm run verify:phase0`；任何失败先停止并诊断，不能用新测试替代或跳过 Phase 0 门禁。
- Phase 1–2 全局固定 `runtimeOwner="browser"`、`audioOwner="legacy"`、候选协议 `protocolFamily="flock-runtime"`、`protocolVersion=1`。
- Phase 1–4 shadow candidate 的 `releaseRevision/sourceManifestSha256` 必须成对为
  `unknown/unknown`；只有未来从同一不可变 candidate release 取得的完整 40/64 位成对值才可替代。
  禁止把当前 Git HEAD 与 Phase 0 production manifest SHA 混成一个候选身份；Phase 5 才强制
  使用已知且不可变的 candidate identity。
- 候选 Node 进程只允许绑定 `127.0.0.1:18090`；配置为其它 host、其它 port 或生产 8090 必须 fail closed。
- Phase 1–2 的 `/healthz` 可返回 200；由于没有 audio worker，`/readyz` 必须返回 503、`workerReady=false`、`phaseGate="shadow-no-audio"`。
- Node 不访问 `/decoder`、8081 或任何 LLM，不创建 audio worker，不发布 PCM；`PcmPlayer` 只冻结接口和 frame parser，`start()` 必须 fail closed。
- 不修改或调用 `flock-voice-engine/deploy/docker-run.sh`，不修改 `flock-voice-engine/server/release_info.py`，不连接远程主机，不启动、停止、重启或同步生产服务。
- 不修改 `flock-voice-engine/web/`；它仍是由 `mvp/` 生成的 release 输出。
- 当前 `mvp/index.html` 与 `mvp/src/main.js` 仍是唯一生产入口；候选页面是测试专用入口，不能通过 query、localStorage 或每客户端 flag 选择 owner。
- Phase 2 复制 domain 期间，行为 owner 仍是 `mvp/src`；所有重复文件登记到机器可检验的迁移台账，Phase 5 原子切换时删除浏览器业务实现。两份代码不得独立演进。
- checkpoint seam 是 Phase 1–2 的可选确定性测试/恢复接口：默认
  `restoredSnapshot=null`，现有 `mvp/src/main.js` 不创建、不导入、不持久化 checkpoint，
  默认 world/conductor 初始化、事件顺序和 RNG 消耗不得变化。只有显式使用
  `createDeterministicRng()` 且没有 provider/pipeline/evaluator 在途的 provider-free owner
  或 shadow runtime 才允许 `exportCheckpoint()`。
- `SimulationCheckpoint` 固定
  `worldId="default"`、`protocolVersion=1`、`snapshotSchemaVersion=1`、
  `schemaVersion=1`、`configRevision="phase2-domain-config-v1"`、
  `rng.algorithm="mulberry32-v1"`；字段缺失、非 JSON-safe 值、半恢复状态、seed/config
  不匹配或 RNG 游标非法全部视为不兼容，必须整世重建，禁止部分 hydration。
- 每个行为变更严格执行 RED → GREEN → 相关回归 → `npm run verify:phase0` → 单独提交；不得夹带其它修改。
- 所有依赖使用精确版本和 lockfile：runtime dependency 固定 `ws@8.21.1`，E2E dev dependency 固定 `@playwright/test@1.61.1`；禁止动态 `latest`。
- runtime 单元/协议测试必须在 Node 20 和本机 Node 24 都通过；Chromium 安装命令固定为 `npx playwright install chromium`。
- 文档、测试说明和代码注释使用中文；协议字段和公开函数名使用本计划冻结的英文名称。

---

## Scope Check

本计划只实现设计的 Phase 1 与 Phase 2：Node runtime 骨架、WorldSession、runtime 状态协议、前端客户端骨架、确定性内核下沉、shadow replay 和测试专用候选 UI。以下能力属于后续独立计划，本计划不得顺手实现：

- species/master provider、8081/DeepSeek 调度、重试、熔断与凭证；
- 潜空间 XY/PCA/kNN、preview 租约和后端行解析；
- Python audio worker、IPC、AudioPlanner、MixState、PCM fan-out；
- legacy `/decoder` adapter、维护租约、worker identity handshake；
- 生产 bundle 清理、runtime/audio owner 切换、8090 原子发布。

## Execution Entry Gate

- [ ] **在 Task 1 前验证固定 Phase 0 基线**

```powershell
$requiredBase = '4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9'
git merge-base --is-ancestor $requiredBase HEAD
if ($LASTEXITCODE -ne 0) { throw "required Phase 0 releaseRevision is not an ancestor: $requiredBase" }

$manifestPath = 'docs/production-manifests/2026-07-22-production.json'
$manifestSha = (Get-FileHash $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($manifestSha -ne '1ebd697b2e0d0cec8b0cbec008fc884179c6273b97952837f661c2c39f6065ec') {
  throw "source manifest changed: $manifestSha"
}

$metadata = Get-Content 'docs/production-manifests/2026-07-22-metadata.json' -Raw -Encoding utf8 |
  ConvertFrom-Json
$vendorSha = $metadata.externalRuntimeInputs.vendor.treeSha256
if ($vendorSha -ne '21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049') {
  throw "vendor fingerprint changed: $vendorSha"
}

npm run verify:phase0
if ($LASTEXITCODE -ne 0) { throw 'Phase 0 verification failed' }
```

Expected: ancestor check succeeds, both SHA checks succeed, and `verify:phase0` exits 0.

## Frozen Interfaces

These names and shapes are shared across tasks and must not be renamed locally:

```js
// A committed logical batch. One eventSeq identifies the whole atomic record.
// state.patch arrives first; domain.event frames share the same eventSeq.
{
  eventSeq: 12,
  baseRevision: 4,
  resultRevision: 5,
  patch: [{ op: 'replace', path: '', value: snapshot }],
  domainEvents: [{ name: 'perch', payload: {} }]
}

// Phase 1–2 intentionally supports only an RFC 6902 root replacement.
// A different op/path is a protocol error and forces snapshot resynchronization.

// Public WorldSession methods. worldGeneration is an opaque, unguessable generation ID.
session.runExclusive(kind, operation)              // Promise<T>
session.readBootstrap({ clientId })                // Promise<BootstrapResponse>
session.attach({ clientId, token, worldGeneration, lastRevision, lastEventSeq, egress, generation })
                                                     // Promise<AttachPlan>
session.commit(kind, mutate)                       // Promise<CommitRecord|null>
session.executeCommand({ clientId, generation, command })
                                                     // Promise<CommandResult>
session.requestSnapshot({ clientId, generation })  // Promise<SnapshotBarrier>
session.resetWorld({ kernel, reason })              // Promise<WorldResetResult>, rotates worldGeneration

// WorldResetResult:
// { reason, worldGeneration, revision: 0, eventSeq: 0 }
// A command from a non-active socket generation returns:
// { type:'command.result', commandId, accepted:false, code:'STALE_CONNECTION_GENERATION' }
// before idempotency lookup, kernel execution, or cursor mutation.

// Per-connection synchronous memory egress. enqueue never awaits socket I/O.
egress.enqueue(frame)                              // boolean; false means bounded queue overflow
egress.close(code, reason)                         // void

// RuntimeClient public surface.
client.connect()
client.disconnect()
client.command(name, payload, { commandId, baseRevision })
client.requestSnapshot()
client.getSnapshot()
client.getStatus()
client.subscribe(listener)

// Deterministic kernel public surface.
kernel.tick(dt)                                    // CommitDraft
kernel.applyCommand(command)                       // CommitDraft
kernel.getSnapshot()                               // current domain snapshot
kernel.exportCheckpoint({ worldGeneration, revision, eventSeq })
                                                     // SimulationCheckpoint
kernel.dispose()

// CommitDraft: { changed, snapshot, domainEvents, audioCommands, commandResult? }.
// audioCommands are accepted only by NullAudioSink in this plan and never become PCM.

// Optional deterministic checkpoint. No callback, listener, provider object, Promise or undefined
// value is serialised. All nested objects are strict JSON data and recursively cloned/frozen.
{
  worldId: 'default',
  protocolVersion: 1,
  snapshotSchemaVersion: 1,
  schemaVersion: 1,
  configRevision: 'phase2-domain-config-v1',
  worldGeneration: 'opaque-generation',
  seed: 7,
  revision: 41,
  eventSeq: 87,
  world: {
    clock: {},                 // complete simTime/day/phase/bpm/dayLength/daylight state
    trees: [],                 // complete mutable tree and bird records, including hidden timers/stats
    branchPreference: {},
    vocalizeBias: {},
  },
  conductor: {
    cursor: {},
    treeScoreHistory: {},
    harmonyScoreHistory: {},
    pendingNext: null,
    currentFrame: {},
    currentChord: {},
    pendingPlan: null,
    pendingSource: null,
    pendingReviewedDay: null,
    duskColorShiftPlanned: false,
    patternHistory: [],
    holdState: {},
    harmonyCounts: {},
    harmonyPerchStart: [],
  },
  sequence: {
    worldPatterns: {},
    jungleEditPlans: {},
    lastSequenceStep: {},
    bridgeCurrent: {},
    bridgePrevious: null,
    reviewedPattern: null,
    plannedPatterns: {},
  },
  control: {
    paused: false,
    treeControl: {},
    agentResumeAt: {},
    masterControl: 'AGENT',
    pendingUserSeasonLength: null,
    tempo: { bpm: 60, beatsPerBar: 4, barsPerDay: 4 },
  },
  rng: {
    algorithm: 'mulberry32-v1',
    world: { state: 0, drawCount: 0 },
    conductor: { state: 0, drawCount: 0 },
  },
}
```

Bootstrap snapshot is renderer-compatible and contains domain fields plus
`worldId/worldGeneration/seed/day/phase/revision/eventSeq/protocolVersion/snapshotSchemaVersion`.
Bootstrap and `ready`
also carry the same `worldGeneration`; commands carry it into their server-side command context.
A journal record is applied atomically:
the client buffers its root patch and all `domain.event` frames, publishes the snapshot only after the
declared `domainEventCount` is complete, then advances both cursors.

## File Responsibility Map

```text
flock-voice-engine/runtime/
  package.json                         isolated Node package and exact dependencies
  package-lock.json                    reproducible dependency graph
  domain-migration.json                temporary-copy owner/deletion ledger
  domain-test-migration.json           byte-identical replacement-test and adapter ledger
  playwright.config.js                 real Chromium E2E on localhost
  src/config.js                        localhost and phase-owner fail-closed config
  src/release-info.js                  validated candidate identity
  src/server.js                        health/ready HTTP server and API hooks
  src/index.js                         sole process/listen entry
  src/protocol/v1.js                   constants and frame validators
  src/protocol/token-store.js          opaque one-use bootstrap/resume tokens
  src/world-session/mailbox.js         explicit FIFO actor
  src/world-session/journal.js         bounded atomic commit records
  src/world-session/world-session.js   revision/eventSeq/idempotency aggregate root
  src/world-session/session-registry.js single `default` registry
  src/api/bootstrap.js                 atomic HTTP bootstrap
  src/api/runtime-ws.js                hello/replay/snapshot/ready/live gateway
  src/domain/**                        closed Phase 2 shadow candidate domain
  src/domain/deterministic-rng.js      exact-copy stateful RNG checkpoint seam
  src/domain/simulation-checkpoint.js  exact-copy checkpoint schema/validator
  src/audio/null-audio-sink.js         proves that no audio side effect is possible
  src/simulation-runtime.js            deterministic fixed-step kernel
  src/shadow/*.js                      browser oracle comparison and diagnostics
  test/src/**                          test-only re-export adapters for unchanged MVP test imports

mvp/src/deterministic-conductor.js     provider-free deterministic conductor seam
mvp/src/deterministic-rng.js           optional stateful RNG; default owner remains unchanged
mvp/src/simulation-checkpoint.js       optional owner/runtime checkpoint schema
mvp/src/runtime-client.js              JSON protocol and immutable snapshot cache
mvp/src/pcm-protocol.js                FLK1 v1 parser only
mvp/src/pcm-player.js                  disabled Phase 1–2 playback facade
flock-voice-engine/runtime/test/fixtures/candidate-ui/
  index.html                            test-only candidate entry, outside every release mapping
  candidate-main.js                    test-only server-snapshot renderer adapter
```

### Task 1: Runtime package, release identity, and localhost phase gate

**Files:**

- Create: `flock-voice-engine/runtime/package.json`
- Create: `flock-voice-engine/runtime/package-lock.json`
- Create: `flock-voice-engine/runtime/src/config.js`
- Create: `flock-voice-engine/runtime/src/release-info.js`
- Create: `flock-voice-engine/runtime/src/server.js`
- Create: `flock-voice-engine/runtime/src/index.js`
- Create: `flock-voice-engine/runtime/test/config.test.js`
- Create: `flock-voice-engine/runtime/test/health.test.js`
- Modify: `package.json`
- Modify: `tools/check-js.mjs`
- Modify: `test/check-js.test.js`

**Interfaces:**

- Consumes: an explicit candidate identity from the execution environment. Every Phase 1–2 launch
  passes the honest pair `FLOCK_RELEASE_REVISION=unknown` and
  `FLOCK_SOURCE_MANIFEST_SHA256=unknown`. The fixed Phase 0 revision and manifest SHA are entry-gate
  evidence only and must never be passed to `loadReleaseInfo()` as candidate identity.
- Produces: `loadRuntimeConfig(env)`, `loadReleaseInfo(env)`,
  `createCandidateServer({ releaseInfo, apiHandler, upgradeHandler })`.

- [ ] **Step 1: Write failing config and health tests**

```js
// test/config.test.js — key assertions
assert.deepEqual(loadRuntimeConfig({}), {
  host: '127.0.0.1', port: 18090,
  runtimeOwner: 'browser', audioOwner: 'legacy',
  allowedOrigin: 'http://127.0.0.1:4193',
});
for (const env of [
  { FLOCK_RUNTIME_HOST: '0.0.0.0' },
  { FLOCK_RUNTIME_HOST: '192.168.9.140' },
  { FLOCK_RUNTIME_PORT: '8090' },
  { FLOCK_RUNTIME_OWNER: 'server' },
  { FLOCK_AUDIO_OWNER: 'server' },
]) assert.throws(() => loadRuntimeConfig(env), /PHASE_1_2_CONFIG_REJECTED/);

// test/health.test.js — use an ephemeral test listener around the unbound server
assert.equal(health.status, 200);
assert.equal(health.body.releaseRevision, 'unknown');
assert.equal(health.body.sourceManifestSha256, 'unknown');
assert.equal(health.body.runtimeOwner, 'browser');
assert.equal(health.body.audioOwner, 'legacy');
assert.equal(ready.status, 503);
assert.equal(ready.body.phaseGate, 'shadow-no-audio');
assert.equal(ready.body.workerReady, false);

assert.deepEqual(loadReleaseInfo({
  FLOCK_RELEASE_REVISION: 'unknown',
  FLOCK_SOURCE_MANIFEST_SHA256: 'unknown',
}).releaseRevision, 'unknown');
assert.doesNotThrow(() => loadReleaseInfo({
  FLOCK_RELEASE_REVISION: 'a'.repeat(40),
  FLOCK_SOURCE_MANIFEST_SHA256: 'b'.repeat(64),
}));
assert.throws(() => loadReleaseInfo({
  FLOCK_RELEASE_REVISION: 'a'.repeat(40),
  FLOCK_SOURCE_MANIFEST_SHA256: 'unknown',
}), /RELEASE_IDENTITY_PAIR_REQUIRED/);
```

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test flock-voice-engine/runtime/test/config.test.js flock-voice-engine/runtime/test/health.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/config.js` or `src/server.js`.

- [ ] **Step 3: Add the isolated package and minimal fail-closed server**

Create `runtime/package.json` with this exact dependency contract, then generate the lockfile with the
exact install command:

```json
{
  "name": "flock-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test test/*.test.js"
  },
  "dependencies": {
    "ws": "8.21.1"
  }
}
```

```powershell
npm install --prefix flock-voice-engine/runtime --save-exact ws@8.21.1
```

Implement these exact constants and guards:

```js
export const PHASE_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 18090,
  runtimeOwner: 'browser',
  audioOwner: 'legacy',
  allowedOrigin: 'http://127.0.0.1:4193',
});

export function loadRuntimeConfig(env = process.env) {
  const candidate = {
    host: env.FLOCK_RUNTIME_HOST ?? PHASE_CONFIG.host,
    port: Number(env.FLOCK_RUNTIME_PORT ?? PHASE_CONFIG.port),
    runtimeOwner: env.FLOCK_RUNTIME_OWNER ?? PHASE_CONFIG.runtimeOwner,
    audioOwner: env.FLOCK_AUDIO_OWNER ?? PHASE_CONFIG.audioOwner,
    allowedOrigin: env.FLOCK_ALLOWED_ORIGIN ?? PHASE_CONFIG.allowedOrigin,
  };
  if (JSON.stringify(candidate) !== JSON.stringify(PHASE_CONFIG)) {
    throw new Error('PHASE_1_2_CONFIG_REJECTED');
  }
  return candidate;
}
```

`loadReleaseInfo(env)` accepts exactly two identity modes: the honest Phase 1–4 pair
`unknown/unknown`, or a 40-hex `FLOCK_RELEASE_REVISION` paired with a 64-hex
`FLOCK_SOURCE_MANIFEST_SHA256`. Missing, malformed and half-known pairs throw
`RELEASE_IDENTITY_PAIR_REQUIRED`; its returned object adds
`protocolFamily: "flock-runtime"`, `protocolVersion: 1`, `runtimeOwner: "browser"`,
`audioOwner: "legacy"`. `createCandidateServer()` must not call `listen()`. `/healthz` returns
the release object plus `workerReady:false`; `/readyz` returns 503 plus
`phaseGate:"shadow-no-audio"`. Only `src/index.js` may call
`server.listen(18090, "127.0.0.1")`.

- [ ] **Step 4: Add root test/check integration**

Add the exact root script:

```json
"test:runtime": "npm --prefix flock-voice-engine/runtime test"
```

Add `flock-voice-engine/runtime/src` to the source roots used by the `check-js` CLI. Update
`test/check-js.test.js` so its expected plan includes `runtimeRoot`; assert each runtime JS file occurs
once instead of retaining the old hard-coded total of 46.

- [ ] **Step 5: Run GREEN and both Node versions**

```powershell
node --test flock-voice-engine/runtime/test/config.test.js flock-voice-engine/runtime/test/health.test.js
npm run check
npm run test:runtime
npm run verify:phase0
npx -y node@20 --test flock-voice-engine/runtime/test/*.test.js
node --version
```

Expected: all commands exit 0; the Node 20 run and local Node 24 run both pass. `node --version` on the
current workstation reports a 24.x runtime.

- [ ] **Step 6: Commit**

```powershell
git add package.json tools/check-js.mjs test/check-js.test.js flock-voice-engine/runtime
git commit -m "feat(runtime): add localhost phase gate"
```

### Task 2: Explicit FIFO mailbox and single-world registry

**Files:**

- Create: `flock-voice-engine/runtime/src/world-session/mailbox.js`
- Create: `flock-voice-engine/runtime/src/world-session/world-session.js`
- Create: `flock-voice-engine/runtime/src/world-session/session-registry.js`
- Create: `flock-voice-engine/runtime/test/mailbox.test.js`
- Create: `flock-voice-engine/runtime/test/world-session.test.js`
- Create: `flock-voice-engine/runtime/test/session-registry.test.js`

**Interfaces:**

- Consumes: injected clock, seed,
  `validateRestoredSnapshot(snapshot) -> boolean`,
  `createKernel({seed,restoredSnapshot}) -> kernel`, and `worldGenerationFactory`; the production
  generation default is `node:crypto.randomUUID`, while tests inject deterministic opaque values.
  `createKernel()` receives a snapshot only after the complete schema, protocol and cursor checks pass;
  every fresh or incompatible case receives `restoredSnapshot:null`.
- Produces: `createMailbox()`, `WorldSession`, `WorldSessionRegistry`; registry exposes only
  `get("default")`.
- Task 2 的小型 fake kernel 只验证 actor/factory 边界；它不是恢复功能的完成证据。Task 7
  必须把 exact-copy `validateSimulationCheckpoint()` 和真实
  `createSimulationRuntime({ restoredSnapshot })` 接到同一 factory，并以连续演进 parity
  与 clean rebuild 测试完成恢复门禁。

- [ ] **Step 1: Write failing concurrency tests**

```js
const mailbox = createMailbox();
const order = [];
await Promise.all([
  mailbox.post('slow', async () => { order.push('slow:start'); await gate; order.push('slow:end'); }),
  mailbox.post('fast', async () => { order.push('fast'); }),
]);
assert.deepEqual(order, ['slow:start', 'slow:end', 'fast']);

await assert.rejects(mailbox.post('broken', () => { throw new Error('boom'); }), /boom/);
assert.equal(await mailbox.post('after-error', () => 7), 7);

const registry = new WorldSessionRegistry({ createSession });
assert.equal(registry.get('default'), registry.get('default'));
assert.throws(() => registry.get('other'), /WORLD_NOT_SUPPORTED/);

const restoredSnapshot = {
  worldId: 'default',
  worldGeneration: 'generation-restored',
  seed: 7,
  protocolVersion: 1,
  snapshotSchemaVersion: 1,
  revision: 41,
  eventSeq: 87,
  day: 3,
  phase: 0.25,
  trees: [],
};
const validateRestoredSnapshot = (snapshot) => (
  snapshot.snapshotSchemaVersion === 1
  && Number.isInteger(snapshot.day)
  && Number.isFinite(snapshot.phase)
  && Array.isArray(snapshot.trees)
);
const createKernel = ({ restoredSnapshot: acceptedSnapshot }) => ({
  restoredFrom: acceptedSnapshot,
  dispose() {},
});
const restoredA = new WorldSession({
  seed: 7, createKernel, validateRestoredSnapshot, clock, restoredSnapshot,
  worldGenerationFactory: () => 'generation-after-reset',
});
const restoredB = new WorldSession({
  seed: 7, createKernel, validateRestoredSnapshot, clock, restoredSnapshot,
  worldGenerationFactory: () => 'also-not-used',
});
assert.equal(restoredA.worldGeneration, 'generation-restored');
assert.equal(restoredB.worldGeneration, 'generation-restored');
assert.equal(restoredA.revision, 41);
assert.equal(restoredA.eventSeq, 87);
assert.deepEqual(restoredA.kernel.restoredFrom, restoredSnapshot);
const badCursor = new WorldSession({
  seed: 7, createKernel, validateRestoredSnapshot, clock,
  restoredSnapshot: { ...restoredSnapshot, eventSeq: undefined },
  worldGenerationFactory: () => 'generation-after-bad-cursor',
});
assert.deepEqual(
  [badCursor.worldGeneration, badCursor.revision, badCursor.eventSeq],
  ['generation-after-bad-cursor', 0, 0],
);
assert.equal(badCursor.kernel.restoredFrom, null);
const badProtocol = new WorldSession({
  seed: 7, createKernel, validateRestoredSnapshot, clock,
  restoredSnapshot: { ...restoredSnapshot, protocolVersion: 2 },
  worldGenerationFactory: () => 'generation-after-bad-protocol',
});
assert.deepEqual(
  [badProtocol.worldGeneration, badProtocol.revision, badProtocol.eventSeq],
  ['generation-after-bad-protocol', 0, 0],
);
assert.equal(badProtocol.kernel.restoredFrom, null);
const badSchema = new WorldSession({
  seed: 7, createKernel, validateRestoredSnapshot, clock,
  restoredSnapshot: { ...restoredSnapshot, trees: undefined },
  worldGenerationFactory: () => 'generation-after-bad-schema',
});
assert.deepEqual(
  [badSchema.worldGeneration, badSchema.revision, badSchema.eventSeq],
  ['generation-after-bad-schema', 0, 0],
);
assert.equal(badSchema.kernel.restoredFrom, null);
await restoredA.resetWorld({ kernel: replacementKernel, reason: 'explicit-test-reset' });
assert.equal(restoredA.worldGeneration, 'generation-after-reset');
assert.equal(restoredA.revision, 0);
assert.equal(restoredA.eventSeq, 0);
```

- [ ] **Step 2: Run RED**

```powershell
node --test flock-voice-engine/runtime/test/mailbox.test.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/test/session-registry.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `world-session/mailbox.js`.

- [ ] **Step 3: Implement the minimal actor boundary**

```js
import { randomUUID } from 'node:crypto';

export function createMailbox() {
  let tail = Promise.resolve();
  return {
    post(label, operation) {
      const result = tail.then(() => operation());
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

export class WorldSession {
  constructor({
    worldId = 'default', seed, createKernel, validateRestoredSnapshot,
    clock, mailbox = createMailbox(), restoredSnapshot = null,
    worldGenerationFactory = randomUUID,
  }) {
    if (worldId !== 'default') throw new Error('WORLD_NOT_SUPPORTED');
    if (typeof createKernel !== 'function'
        || typeof validateRestoredSnapshot !== 'function') {
      throw new Error('WORLD_KERNEL_FACTORY_REQUIRED');
    }
    Object.assign(this, { worldId, seed, clock, mailbox, worldGenerationFactory });
    let validSchema = false;
    if (restoredSnapshot) {
      try {
        validSchema = validateRestoredSnapshot(restoredSnapshot) === true;
      } catch {
        validSchema = false;
      }
    }
    const compatibleEnvelope = restoredSnapshot !== null
      && restoredSnapshot.worldId === worldId
      && restoredSnapshot.seed === seed
      && restoredSnapshot.protocolVersion === 1
      && restoredSnapshot.snapshotSchemaVersion === 1;
    const validGeneration = typeof restoredSnapshot?.worldGeneration === 'string'
      && restoredSnapshot.worldGeneration.length > 0;
    const validRevision = Number.isSafeInteger(restoredSnapshot?.revision)
      && restoredSnapshot.revision >= 0;
    const validEventSeq = Number.isSafeInteger(restoredSnapshot?.eventSeq)
      && restoredSnapshot.eventSeq >= 0;
    const restoreAccepted = compatibleEnvelope && validSchema
      && validGeneration && validRevision && validEventSeq;
    this.kernel = createKernel({
      seed,
      restoredSnapshot: restoreAccepted ? structuredClone(restoredSnapshot) : null,
    });
    if (restoreAccepted) {
      this.worldGeneration = restoredSnapshot.worldGeneration;
      this.revision = restoredSnapshot.revision;
      this.eventSeq = restoredSnapshot.eventSeq;
      this.restoreDisposition = 'restored';
    } else {
      this.worldGeneration = worldGenerationFactory();
      this.revision = 0;
      this.eventSeq = 0;
      this.restoreDisposition = restoredSnapshot ? 'rebuilt-incompatible' : 'fresh';
    }
  }
  runExclusive(kind, operation) {
    return this.mailbox.post(kind, () => operation(this));
  }
  resetWorld({ kernel, reason }) {
    return this.runExclusive('world.reset', () => {
      this.kernel.dispose?.();
      this.kernel = kernel;
      this.worldGeneration = this.worldGenerationFactory();
      this.revision = 0;
      this.eventSeq = 0;
      return Object.freeze({
        reason, worldGeneration: this.worldGeneration,
        revision: this.revision, eventSeq: this.eventSeq,
      });
    });
  }
}
```

`WorldSessionRegistry` must memoize exactly one injected `createSession()` result and reject every
worldId other than `default`. A compatible restored snapshot preserves its
`worldGeneration/revision/eventSeq` tuple and is the only snapshot passed into `createKernel()`.
A snapshot rejected by the complete domain-schema validator, with a different schema/protocol,
worldId or seed, or with a missing, negative or non-safe-integer cursor is incompatible:
`WorldSession` passes `restoredSnapshot:null` to `createKernel()` so the old kernel snapshot cannot be
partially hydrated, and the session starts with a fresh kernel,
`restoreDisposition="rebuilt-incompatible"`, a newly generated worldGeneration and both cursors at
zero. Runtime incompatibility discovered after startup uses `resetWorld()`, which likewise rotates
worldGeneration and resets both cursors. Do not start a timer or tick in constructors.

- [ ] **Step 4: Run GREEN and regression**

```powershell
node --test flock-voice-engine/runtime/test/mailbox.test.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/test/session-registry.test.js
npm run test:runtime
npm run verify:phase0
```

Expected: all commands exit 0; tests prove no overlapping mailbox operation, no second world, exact
cursor preservation only for a complete compatible snapshot, and a fresh kernel/generation/zeroed
cursors for schema, protocol or cursor incompatibility.

- [ ] **Step 5: Commit**

```powershell
git add flock-voice-engine/runtime/src/world-session flock-voice-engine/runtime/test
git commit -m "feat(runtime): serialize the default world session"
```

### Task 3: Atomic journal, bootstrap, Runtime WS barrier, and idempotency

**Files:**

- Create: `flock-voice-engine/runtime/src/protocol/v1.js`
- Create: `flock-voice-engine/runtime/src/protocol/token-store.js`
- Create: `flock-voice-engine/runtime/src/world-session/journal.js`
- Create: `flock-voice-engine/runtime/src/api/bootstrap.js`
- Create: `flock-voice-engine/runtime/src/api/connection-egress.js`
- Create: `flock-voice-engine/runtime/src/api/runtime-ws.js`
- Modify: `flock-voice-engine/runtime/src/world-session/world-session.js`
- Modify: `flock-voice-engine/runtime/src/server.js`
- Create: `flock-voice-engine/runtime/test/journal.test.js`
- Create: `flock-voice-engine/runtime/test/bootstrap.test.js`
- Create: `flock-voice-engine/runtime/test/runtime-ws.test.js`
- Create: `flock-voice-engine/runtime/test/idempotency.test.js`

**Interfaces:**

- Consumes: `WorldSession.runExclusive()`, `ws@8.21.1`.
- Produces: `createJournal({ capacity })`, `createTokenStore({ clock, randomBytes, ttlMs })`,
  `createBootstrapHandler(dependencies)`, `createConnectionEgress({ socket, capacity })`,
  `createRuntimeWsGateway(dependencies) -> { handleUpgrade, routeCommand }`, and the frozen
  WorldSession protocol methods. `routeCommand()` reserves `snapshot.request` for
  `WorldSession.requestSnapshot()` and sends every other command to `executeCommand()`.

- [ ] **Step 1: Write failing journal and barrier tests**

```js
const bootstrap = await session.readBootstrap({ clientId: 'client-a' });
assert.equal(bootstrap.worldGeneration, 'generation-a');
assert.equal(bootstrap.snapshot.worldGeneration, 'generation-a');
await session.commit('test-mutation', () => ({
  changed: true,
  snapshot: { value: 2 },
  domainEvents: [{ name: 'changed', payload: { value: 2 } }],
  audioCommands: [],
}));
const attach = await session.attach({
  clientId: 'client-a',
  token: bootstrap.bootstrapToken,
  worldGeneration: bootstrap.worldGeneration,
  lastRevision: bootstrap.revision,
  lastEventSeq: bootstrap.eventSeq,
  egress,
  generation: 1,
});
assert.equal(attach.kind, 'replay');
assert.deepEqual(attach.records.map((record) => record.eventSeq), [1]);
assert.deepEqual(egress.frames.map((frame) => frame.type), [
  'state.patch', 'domain.event', 'ready',
]);
assert.equal(egress.frames.at(-1).worldGeneration, bootstrap.worldGeneration);

// Capacity gap must never return a partial replay.
assert.equal(gappedAttach.kind, 'snapshot');
assert.equal(gappedAttach.snapshot.revision, session.revision);

// Deterministic attach barrier race: the writer is deliberately not drained.
const attachPromise = session.attach({ ...resume, egress: heldEgress, generation: 2 });
const concurrentCommit = session.commit('after-attach', mutation);
await Promise.all([attachPromise, concurrentCommit]);
assert.deepEqual(heldEgress.frames.map((frame) => frame.type), [
  'state.patch', 'domain.event', 'ready',
  'state.patch', 'domain.event',
]);

// snapshot.request is the same mailbox barrier; the later commit is queued after ready.
const snapshotPromise = session.requestSnapshot({ clientId: 'client-a', generation: 2 });
const commitAfterSnapshot = session.commit('after-snapshot', secondMutation);
await Promise.all([snapshotPromise, commitAfterSnapshot]);
assert.deepEqual(heldEgress.frames.slice(-3).map((frame) => frame.type), [
  'snapshot', 'ready', 'state.patch',
]);

// The public command-shaped request is routed by the gateway to that same barrier.
// It must never enter kernel.applyCommand().
const commandCountBeforeSnapshot = kernel.commandCalls.length;
await gateway.routeCommand({
  session,
  clientId: 'client-a',
  generation: 2,
  command: {
    type: 'command', protocolVersion: 1, commandId: 'snapshot-command-a',
    worldGeneration: 'generation-a', baseRevision: session.revision,
    name: 'snapshot.request', payload: {},
  },
});
assert.equal(kernel.commandCalls.length, commandCountBeforeSnapshot);
assert.deepEqual(heldEgress.frames.slice(-2).map((frame) => frame.type), [
  'snapshot', 'ready',
]);

// A replaced socket generation cannot execute an ordinary command or poison idempotency.
const replacementEgress = createFakeEgress();
const replacementResumeToken = heldEgress.frames.at(-1).resumeToken;
await session.attach({
  clientId: 'client-a',
  token: replacementResumeToken,
  worldGeneration: 'generation-a',
  lastRevision: session.revision,
  lastEventSeq: session.eventSeq,
  egress: replacementEgress,
  generation: 3,
});
const staleCommand = {
  type: 'command', protocolVersion: 1, commandId: 'stale-command-a',
  worldGeneration: 'generation-a', baseRevision: session.revision,
  name: 'runtime.pause', payload: {},
};
const staleBefore = {
  revision: session.revision,
  eventSeq: session.eventSeq,
  kernelCalls: kernel.commandCalls.length,
};
const staleResult = await gateway.routeCommand({
  session, clientId: 'client-a', generation: 2, command: staleCommand,
});
assert.deepEqual(staleResult, {
  type: 'command.result',
  commandId: 'stale-command-a',
  accepted: false,
  code: 'STALE_CONNECTION_GENERATION',
});
assert.deepEqual({
  revision: session.revision,
  eventSeq: session.eventSeq,
  kernelCalls: kernel.commandCalls.length,
}, staleBefore);
const activeResult = await gateway.routeCommand({
  session, clientId: 'client-a', generation: 3, command: staleCommand,
});
assert.notEqual(activeResult.code, 'STALE_CONNECTION_GENERATION');
assert.equal(kernel.commandCalls.length, staleBefore.kernelCalls + 1);

const commandBaseRevision = session.revision;
await session.executeCommand({
  clientId: 'client-a', generation: 3,
  command: {
    type: 'command', protocolVersion: 1, commandId: 'command-a',
    worldGeneration: 'generation-a', baseRevision: commandBaseRevision,
    name: 'runtime.pause', payload: {},
  },
});
assert.deepEqual(kernel.lastCommandContext, {
  worldId: 'default', worldGeneration: 'generation-a',
  clientId: 'client-a', commandId: 'command-a', baseRevision: commandBaseRevision,
});
```

Also test expired/tampered/cross-client tokens, bootstrap mutation attach window, duplicate
`(clientId, commandId)`, reconnect generation replacement, bad hello order, revision gap,
the public command-shaped `snapshot.request` gateway route, a throwing mutation that changes neither
cursor, queue overflow close/resync, and worldGeneration mismatch. Add both replacement-race and
close-race ordinary-command cases: invoke the captured old message callback only after the replacement
attach or exact-generation close cleanup has committed, then require
`STALE_CONNECTION_GENERATION`, unchanged revision/eventSeq/kernel call count, and successful reuse of
the same commandId by the active generation. This proves stale requests never enter or populate the
idempotency map. The snapshot route test must prove that `kernel.applyCommand()` is not called. The
fake egress `enqueue()` is synchronous and never drains during the race tests, so their order does not
depend on network timing.

- [ ] **Step 2: Run RED**

```powershell
node --test flock-voice-engine/runtime/test/journal.test.js flock-voice-engine/runtime/test/bootstrap.test.js flock-voice-engine/runtime/test/runtime-ws.test.js flock-voice-engine/runtime/test/idempotency.test.js
```

Expected: FAIL because `protocol/v1.js`, `journal.js` and the session protocol methods do not exist.

- [ ] **Step 3: Implement journal and opaque token primitives**

```js
export const PROTOCOL_VERSION = 1;
export const ROOT_REPLACE_PATH = '';

export function rootReplacePatch(snapshot) {
  return [{ op: 'replace', path: ROOT_REPLACE_PATH, value: structuredClone(snapshot) }];
}

export function createJournal({ capacity = 256 } = {}) {
  const records = [];
  return {
    append(record) {
      records.push(structuredClone(record));
      if (records.length > capacity) records.splice(0, records.length - capacity);
    },
    replayAfter(lastEventSeq, lastRevision) {
      const replay = records.filter((record) => record.eventSeq > lastEventSeq);
      if (!replay.length) return [];
      if (replay[0].eventSeq !== lastEventSeq + 1
          || replay[0].baseRevision !== lastRevision) return null;
      for (let index = 1; index < replay.length; index += 1) {
        if (replay[index].eventSeq !== replay[index - 1].eventSeq + 1
            || replay[index].baseRevision !== replay[index - 1].resultRevision) return null;
      }
      return structuredClone(replay);
    },
  };
}
```

`createTokenStore()` must issue opaque `randomBytes(32).toString("base64url")` values, store only
`worldId/worldGeneration/clientId/revision/eventSeq/expiresAt/kind`, consume each token once, use an
injected clock, and never expose its internal map. A token from an older worldGeneration is invalid
even when revision/eventSeq happen to match.

- [ ] **Step 4: Implement atomic session methods and WS state machine**

`readBootstrap()`, `attach()`, `commit()`, `executeCommand()` and `requestSnapshot()` must each enter
the same mailbox. Each socket owns a bounded synchronous memory egress; mailbox code only calls
`egress.enqueue(frame)` and never awaits `socket.send()` or network backpressure.
`executeCommand({clientId,generation,command})` first reads the active subscription inside that
mailbox. If it is absent or its exact generation differs, return the frozen
`{type:"command.result",commandId,accepted:false,code:"STALE_CONNECTION_GENERATION"}` immediately.
This check is ordered before worldGeneration/baseRevision validation, idempotency lookup or insertion,
`kernel.applyCommand()` and cursor mutation; stale commands therefore cannot consume a commandId.
`commit()` increments revision and eventSeq once only when `changed=true`, stores one root-replace
record, and enqueues that record for every subscription whose in-mailbox state is `live`.
`readBootstrap()` returns exactly
`protocolVersion/releaseRevision/worldId/worldGeneration/revision/eventSeq/snapshot/capabilities/
clientId/bootstrapToken/bootstrapExpiresAt`; `capabilities.commands` lists only commands that do not
return `UNAVAILABLE_IN_PHASE_2`. It includes the gateway-owned `snapshot.request` alongside supported
kernel commands even though that name is intentionally absent from `SimulationRuntime.applyCommand()`.

`createConnectionEgress()` has a default capacity of 256 JSON frames. `enqueue()` synchronously
appends and returns `true`; at capacity it returns `false`, closes with
`4410/EGRESS_OVERFLOW`, and requires reconnect/snapshot resynchronization. Its writer drains FIFO
outside the mailbox and performs at most one `socket.send()` at a time.

```js
if (firstFrame.type !== 'hello') close(4400, 'HELLO_REQUIRED');
const egress = createConnectionEgress({ socket, capacity: 256 });
await session.attach({
  ...firstFrame,
  token: firstFrame.bootstrapToken ?? firstFrame.resumeToken,
  egress,
  generation: nextSocketGeneration(firstFrame.clientId),
});
egress.startWriter();
```

Inside the single `attach()` mailbox operation, validate the token and worldGeneration, atomically
replace the prior client generation, register `{ clientId, generation, egress, state:"syncing" }`,
enqueue every replay record or one full snapshot, enqueue `ready` with
`worldGeneration/revision/eventSeq/resumeToken`, and finally set the subscription state to `live`
before returning. `requestSnapshot()` performs the same sequence on the existing generation:
set `syncing`, enqueue snapshot, enqueue ready, set `live`. Because later commits enter the same
mailbox, their frames are necessarily queued after ready even when the socket writer is stalled.
There is no gateway-side `markReady()` step.

Every enqueue in an attach/snapshot barrier is checked. On `false`, delete that exact generation from
the subscription map, close it with 4410, and reject the barrier; never continue with a partial replay.
On ordinary live overflow, remove and close only the slow generation. Socket close cleanup must itself
enter the mailbox and remove a subscription only if its generation still matches, so an old close
callback cannot delete a replacement socket.

The gateway exposes an internal `routeCommand()` used by both the WebSocket handler and protocol
tests. It dispatches `snapshot.request` before the kernel command path:

```js
async function routeCommand({ session, clientId, generation, command }) {
  if (command.name === 'snapshot.request') {
    return session.requestSnapshot({ clientId, generation });
  }
  return session.executeCommand({ clientId, generation, command });
}
```

`clientId` and `generation` come from the attached socket context, never from command payload.
`session.requestSnapshot()` itself enters the same mailbox, validates that exact active generation,
sets it to `syncing`, enqueues full snapshot then `ready`, and restores `live`. The gateway must not
wrap this call in another `runExclusive()` and must not call `kernel.applyCommand()` for
`snapshot.request`, avoiding a nested-mailbox deadlock and guaranteeing the barrier ordering.
The ordinary-command branch passes the same captured generation into `executeCommand()`; neither the
gateway nor a socket-close callback may pre-validate it outside the mailbox. Replacement and close
races are resolved only by the active-subscription check at the start of that mailbox transaction.

Task 3 extends `resetWorld()` inside that mailbox transaction: rotate worldGeneration, replace the
kernel, clear the old journal/token/idempotency windows, reset revision/eventSeq, then enqueue a full
snapshot plus `world.reset` domain event and `ready` to every surviving egress before marking it live.
A reconstructed process supplied with a compatible persisted snapshot keeps that snapshot's
`worldGeneration/revision/eventSeq` tuple and does not execute this reset path.

`GET /api/v1/bootstrap` must return
`Access-Control-Allow-Origin: http://127.0.0.1:4193` and
`Vary: Origin`. Runtime WebSocket upgrades must require the exact same `Origin`; missing or different
origins close with 4403. Wildcard CORS is forbidden.

For each record, send one `state.patch` frame with
`eventSeq/baseRevision/resultRevision/domainEventCount/patch`, then ordered `domain.event` frames with
the same eventSeq and zero-based `eventIndex`. A new generation closes the prior socket for the same
clientId with code 4409. Every command carries the current `worldGeneration`; the session rejects an
older generation and passes
`{ worldId, worldGeneration, clientId, commandId, baseRevision }` as the immutable command context to
the kernel. Every rejected command returns `command.result`; only an active generation may reach the
idempotency lookup, and duplicate commandId then returns the cached
result without invoking the kernel.

- [ ] **Step 5: Run GREEN, protocol regression, and Phase 0**

```powershell
node --test flock-voice-engine/runtime/test/journal.test.js flock-voice-engine/runtime/test/bootstrap.test.js flock-voice-engine/runtime/test/runtime-ws.test.js flock-voice-engine/runtime/test/idempotency.test.js
npm run test:runtime
npm run verify:phase0
```

Expected: all commands exit 0; the attach-window test deterministically selects replay or full
snapshot, never a partial sequence; stale replacement/closed generations cannot execute ordinary
commands or populate idempotency.

- [ ] **Step 6: Commit**

```powershell
git add flock-voice-engine/runtime/src/protocol flock-voice-engine/runtime/src/api flock-voice-engine/runtime/src/world-session flock-voice-engine/runtime/src/server.js flock-voice-engine/runtime/test
git commit -m "feat(runtime): add atomic bootstrap and runtime websocket"
```

### Task 4: RuntimeClient immutable snapshot skeleton

**Files:**

- Create: `mvp/src/runtime-client.js`
- Create: `mvp/test/runtime-client.test.js`

**Interfaces:**

- Consumes: bootstrap and Runtime WS frames from Task 3.
- Produces: `createRuntimeClient()` with the exact public surface in Frozen Interfaces; it is not
  imported by `mvp/src/main.js`.

- [ ] **Step 1: Write failing client state-machine tests**

```js
const client = createRuntimeClient({ fetchImpl, webSocketFactory, baseUrl, protocolVersion: 1 });
assert.equal(fetchCalls.length, 0);
await client.connect();
assert.deepEqual(sent[0], {
  type: 'hello', protocolVersion: 1, clientId: 'client-a',
  bootstrapToken: 'bootstrap-token', worldGeneration: 'generation-a',
  lastRevision: 0, lastEventSeq: 0,
});
assert.equal(client.getStatus().phase, 'ready');

socket.emit(statePatch({ eventSeq: 2, baseRevision: 1, resultRevision: 2 }));
assert.equal(client.getStatus().phase, 'resyncing');
assert.equal(sent.at(-1).type, 'command');
assert.equal(sent.at(-1).name, 'snapshot.request');
assert.throws(() => { client.getSnapshot().day = 99; }, TypeError);
```

Test complete record buffering, late frames from a replaced socket, token rotation, reconnect,
commandId reuse on retry, a duplicate result, explicit disconnect, a ready/snapshot carrying a new
worldGeneration that discards all old buffered patches, and no fetch/socket during import or
construction.

- [ ] **Step 2: Run RED**

```powershell
node --test mvp/test/runtime-client.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `mvp/src/runtime-client.js`.

- [ ] **Step 3: Implement the state machine**

```js
export function createRuntimeClient({
  fetchImpl, webSocketFactory, baseUrl, protocolVersion = 1,
}) {
  // States: idle -> bootstrapping -> attaching -> ready -> resyncing/reconnecting -> closed.
  // Keep socketGeneration; every callback checks the captured generation.
  // Buffer a whole eventSeq record and publish only after domainEventCount frames arrive.
  // On any cursor/baseRevision mismatch discard the buffer and send snapshot.request.
  return { connect, disconnect, command, requestSnapshot, getSnapshot, getStatus, subscribe };
}
```

Use recursive freezing on every published snapshot. `command()` must default `baseRevision` to the
last applied revision, copy the current `worldGeneration`, and generate one UUID once per logical
call; reconnect retry reuses that ID only while worldGeneration is unchanged.
There is no local world, local reducer, fallback tick or direct mutation API.

- [ ] **Step 4: Run GREEN and full MVP regression**

```powershell
node --test mvp/test/runtime-client.test.js
npm run test:mvp
npm run verify:phase0
```

Expected: all commands exit 0; the pre-existing MVP total increases by the new RuntimeClient tests.

- [ ] **Step 5: Commit**

```powershell
git add mvp/src/runtime-client.js mvp/test/runtime-client.test.js
git commit -m "feat(mvp): add inert runtime client"
```

### Task 5: FLK1 parser and disabled PcmPlayer skeleton

**Files:**

- Create: `mvp/src/pcm-protocol.js`
- Create: `mvp/src/pcm-player.js`
- Create: `mvp/test/pcm-protocol.test.js`
- Create: `mvp/test/pcm-player.test.js`

**Interfaces:**

- Consumes: the design's 32-byte Audio WS v1 header only; it consumes no server route in Phase 1–2.
- Produces: `parseAudioFrameV1(buffer, expectedCursor)` and
  `createPcmPlayer({ runtimeOwner, audioOwner, audioContextFactory, webSocketFactory })`.

- [ ] **Step 1: Write failing golden-vector and no-side-effect tests**

```js
const parsed = parseAudioFrameV1(goldenFrame, {
  streamRevision: 7, blockSeq: 9, startFrame: 4096n,
});
assert.deepEqual(parsed.header, {
  headerVersion: 1, flags: 0, headerBytes: 32,
  streamRevision: 7, blockSeq: 9, startFrame: 4096n,
  frameCount: 2, channels: 2, format: 1,
});
assert.equal(parsed.samples.length, 4);
assert.throws(() => parseAudioFrameV1(badMagic), /AUDIO_BAD_MAGIC/);
assert.throws(() => parseAudioFrameV1(wrongPayloadLength), /AUDIO_LENGTH_MISMATCH/);

const player = createPcmPlayer({
  runtimeOwner: 'browser', audioOwner: 'legacy',
  audioContextFactory: () => { throw new Error('must not create AudioContext'); },
  webSocketFactory: () => { throw new Error('must not open Audio WS'); },
});
await assert.rejects(player.start(), /PCM_DISABLED_PHASE_1_2/);
```

- [ ] **Step 2: Run RED**

```powershell
node --test mvp/test/pcm-protocol.test.js mvp/test/pcm-player.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exact header validation and disabled lifecycle**

Use `DataView` little-endian reads at offsets `0/4/5/6/8/12/16/24/28/30`; require magic `FLK1`,
version 1, headerBytes 32, channels 2, format 1 and exact
`32 + frameCount * channels * 4` byte length. Cursor mismatch throws
`AUDIO_DISCONTINUITY`; it does not silently skip or concatenate.

```js
export function createPcmPlayer(dependencies) {
  let state = 'disabled';
  return {
    async start() { throw new Error('PCM_DISABLED_PHASE_1_2'); },
    stop() { state = 'disabled'; },
    reset() { state = 'disabled'; },
    getStatus() { return Object.freeze({ state, bufferedFrames: 0 }); },
  };
}
```

Do not import or modify `flock-voice-engine/client/voice-client.js`,
`flock-voice-engine/client/pcm-player-worklet.js` or `mvp/src/audio.js`.

- [ ] **Step 4: Run GREEN and MVP regression**

```powershell
node --test mvp/test/pcm-protocol.test.js mvp/test/pcm-player.test.js
npm run test:mvp
npm run verify:phase0
```

Expected: all commands exit 0; factories in the no-side-effect test are never invoked.

- [ ] **Step 5: Commit**

```powershell
git add mvp/src/pcm-protocol.js mvp/src/pcm-player.js mvp/test/pcm-protocol.test.js mvp/test/pcm-player.test.js
git commit -m "feat(mvp): freeze disabled PCM client interfaces"
```

### Task 6: Extract the provider-free deterministic conductor seam

**Files:**

- Create: `mvp/src/deterministic-conductor.js`
- Create: `mvp/src/deterministic-rng.js`
- Create: `mvp/src/simulation-checkpoint.js`
- Create: `mvp/test/fixtures/conductor-golden.js`
- Create: `mvp/test/conductor-characterization.test.js`
- Create: `mvp/test/deterministic-conductor.test.js`
- Create: `mvp/test/simulation-checkpoint.test.js`
- Modify: `mvp/src/agent.js`
- Modify: `mvp/src/sequence.js`
- Modify: `mvp/src/world.js`

**Interfaces:**

- Consumes: existing `world.on/set*`, `CONFIG`, injected RNG and optional injected review source.
- Produces: `createDeterministicConductor(world, options)`,
  `createDeterministicRng(seed, restoredState?)`,
  `createSimulationCheckpoint(parts)`, `validateSimulationCheckpoint(checkpoint, expected)`,
  `resolveBehaviorSuggestions()`, `evaluateDay()`, `filterMutationBounds()`, `ensurePatternMutation()`,
  `meanTreePatternSimilarity()`, `planFromLlm()`, `ruleSequencePlan()`,
  `padDiversityBranchWeights()`, `bassRootBranchWeights()`, `harmonyScoreFromCounts()` and
  `masterMenuFromConfig()`. `mvp/src/agent.js` re-exports all eleven pure helpers for compatibility.
  The conductor returns
  `getChord/getFrame/getHarmonyScores/getSequencePattern/getPlannedSequencePattern/
  getReviewedSequencePattern/getMasterState/setMasterControl/setUserSeasonLength/applyUserColor/
  hasPendingPlan/setReviewSource/getHoldState/exportDeterministicState/dispose`.
  `createWorld()` and `createSequencePatternBridge()` gain optional `restoredState=null` plus
  `exportDeterministicState()`; the null path preserves current initialization and RNG consumption.
  `reviewSource` exposes
  `dayReview(input)` and `dawnPlan(input)`; either method may return `null`. The fixture exports
  `runConductorScenario({ createConductor, worldSeed, conductorSeed, ticks, dt })`.

- [ ] **Step 1: Freeze and run a baseline GREEN characterization before importing the new core**

```js
// mvp/test/fixtures/conductor-golden.js — reviewed against current attachPipelineConductor
export const CONDUCTOR_GOLDEN = Object.freeze({
  snapshot: { simTime: 20, day: 2, phase: 0.33, bpm: 60, perchedTotal: 9 },
  frame: {
    season: 'spring', seasonDay: 1, seasonLength: 8,
    progressionStep: 1, progressionCycle: 0, progressionId: 'bloom',
    period: 'day', skeletonId: 'Gm', skeletonNotes: [55, 62, 67, 70, 74],
    colorId: '日光', colorNotes: [70, 74], tension: 0.26,
  },
  master: {
    control: 'AGENT', season: 'spring', seasonDay: 1, seasonLength: 8,
    colorId: '日光', period: 'day', progressionStep: 1,
    progressionCycle: 0, progressionId: 'bloom', pendingSeasonLength: null,
  },
  eventCounts: { perch: 37, unperch: 28, dawn: 1, dusk: 1, 'sequence-pattern': 4 },
  firstEvent: { name: 'perch', treeId: 'texture', birdId: 14, branchId: 4, day: 1 },
  branchPreferences: {
    pad: [1, 0.7375, 1, 0.48305, 0.57055],
    melody: [1, 1, 1, 0.258, 0.258],
    bass: [1, 0.89075, 0.6895, 0.370122, 0.260872],
    texture: [1, 1, 1, 0.258, 0.258],
  },
  holdCounters: { pad: 0, melody: 1, bass: 0, texture: 0 },
  occupiedSequenceCells: {
    pad: [[3, 3, 2], [4, 2, 1]],
    melody: [
      [0, 8, 1], [0, 14, 1], [1, 2, 1], [1, 9, 1],
      [1, 14, 1], [2, 7, 1], [2, 10, 1], [3, 2, 1],
    ],
    bass: [[1, 2, 1], [2, 2, 1], [4, 3, 1]],
    texture: [
      [0, 13, 1], [1, 0, 1], [1, 6, 1], [1, 10, 1],
      [2, 3, 1], [4, 2, 1], [4, 5, 1], [4, 9, 1],
    ],
  },
});

// conductor-characterization.test.js imports attachPipelineConductor only.
const actual = runConductorScenario({
  createConductor: attachPipelineConductor,
  worldSeed: 0x4c4353, conductorSeed: 0x4c4354, ticks: 600, dt: 1 / 30,
});
assert.ok(Math.abs(actual.snapshot.simTime - CONDUCTOR_GOLDEN.snapshot.simTime) <= 1e-12);
assert.ok(Math.abs(actual.snapshot.phase - CONDUCTOR_GOLDEN.snapshot.phase) <= 1e-12);
assert.deepEqual(
  { ...actual, snapshot: { ...actual.snapshot, simTime: 20, phase: 0.33 } },
  CONDUCTOR_GOLDEN,
);
```

`runConductorScenario()` imports no conductor implementation; the baseline test supplies the current
`attachPipelineConductor()`. It reduces the full sequence grid into ordered
`[pitchBranchId, stepIndex, eventCount]` tuples and rounds reported branch-preference floats to six
decimal places. Run it before adding any import of `deterministic-conductor.js`.

Run:

```powershell
node --test mvp/test/conductor-characterization.test.js
```

Expected: PASS against the current pre-extraction adapter. If these fixed literals do not pass, stop
and review the fixture rather than generating expected values from the refactored implementation.

- [ ] **Step 2: Add the new-core and optional checkpoint-seam tests, then run RED**

`mvp/test/deterministic-conductor.test.js` imports `createDeterministicConductor`, runs the same
scenario reducer, and asserts against `CONDUCTOR_GOLDEN` independently of the adapter.

`mvp/test/simulation-checkpoint.test.js` uses the real MVP world/conductor modules. It runs 300 ticks,
JSON-round-trips a checkpoint, restores new instances from it, runs the remaining 300 ticks, and
compares every checkpoint field plus ordered domain events with an uninterrupted 600-tick owner:

```js
const uninterrupted = createCheckpointableOwner({ seed: 7 });
runTicks(uninterrupted, 300);
const uninterruptedPrefixEvents = uninterrupted.drainDomainEvents();
runTicks(uninterrupted, 300);
const uninterruptedSecondHalfEvents = uninterrupted.drainDomainEvents();

const firstHalf = createCheckpointableOwner({ seed: 7 });
runTicks(firstHalf, 300);
const firstHalfPrefixEvents = firstHalf.drainDomainEvents();
assert.deepEqual(firstHalfPrefixEvents, uninterruptedPrefixEvents);
const checkpoint = JSON.parse(JSON.stringify(firstHalf.exportCheckpoint({
  worldGeneration: 'owner-generation', revision: 300, eventSeq: 300,
})));
assert.equal(validateSimulationCheckpoint(checkpoint, {
  seed: 7, configRevision: 'phase2-domain-config-v1',
}), true);

const resumed = createCheckpointableOwner({ seed: 7, restoredSnapshot: checkpoint });
runTicks(resumed, 300);
const resumedSecondHalfEvents = resumed.drainDomainEvents();
assert.deepEqual(resumed.exportCheckpoint({
  worldGeneration: 'owner-generation', revision: 600, eventSeq: 600,
}), uninterrupted.exportCheckpoint({
  worldGeneration: 'owner-generation', revision: 600, eventSeq: 600,
}));
assert.deepEqual(resumedSecondHalfEvents, uninterruptedSecondHalfEvents);
```

The test helper passes restored state explicitly. A separate assertion constructs the adapter without
checkpoint options and still requires `CONDUCTOR_GOLDEN`, proving that the optional seam changes no
default owner behavior.

```powershell
node --test mvp/test/deterministic-conductor.test.js mvp/test/simulation-checkpoint.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `deterministic-conductor.js`,
`deterministic-rng.js` or `simulation-checkpoint.js`; the baseline
`conductor-characterization.test.js` remains GREEN.

- [ ] **Step 3: Move deterministic state without changing behavior**

Move the deterministic closures currently created inside `attachPipelineConductor()`—season cursor,
harmony counters, branch preferences, sequence bridge/history, hold state, migration, dawn/dusk
transitions and rule fallback—into `createDeterministicConductor()`. Move the eleven pure helpers named
in Interfaces into the same module and re-export them from `agent.js`; this makes the future exact-copy
candidate self-contained instead of reaching back into the browser adapter. The core may import only
`config.js`, `harmony.js`, `jungle.js`, `sequence.js`, `master/policy.js` and
`survival-actions.js`. It may accept an injected `reviewSource`, but must not import `fetch`, LLM
clients, DOM or audio.

Add a stateful callable RNG without replacing any existing default `Math.random` or injected-function
path:

```js
export const DETERMINISTIC_RNG_ALGORITHM = 'mulberry32-v1';

export function createDeterministicRng(seed, restoredState = null) {
  let state = restoredState?.state ?? (seed >>> 0);
  let drawCount = restoredState?.drawCount ?? 0;
  if (!Number.isSafeInteger(state) || state < 0 || state > 0xffffffff
      || !Number.isSafeInteger(drawCount) || drawCount < 0) {
    throw new Error('INVALID_DETERMINISTIC_RNG_STATE');
  }
  const rng = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    drawCount += 1;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  rng.exportState = () => Object.freeze({ state, drawCount });
  return rng;
}
```

`mvp/src/simulation-checkpoint.js` owns the schema constants and aggregator:

```js
import { CONFIG } from './config.js';
import { DETERMINISTIC_RNG_ALGORITHM } from './deterministic-rng.js';

export const SIMULATION_CHECKPOINT_SCHEMA_VERSION = 1;
export const SIMULATION_CONFIG_REVISION = 'phase2-domain-config-v1';

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export function createSimulationCheckpoint({
  worldGeneration, seed, revision, eventSeq,
  worldState, conductorState, worldRng, conductorRng, paused,
}) {
  if (typeof worldRng?.exportState !== 'function'
      || typeof conductorRng?.exportState !== 'function') {
    throw new Error('CHECKPOINT_STATEFUL_RNG_REQUIRED');
  }
  const checkpoint = {
    worldId: 'default',
    protocolVersion: 1,
    snapshotSchemaVersion: 1,
    schemaVersion: SIMULATION_CHECKPOINT_SCHEMA_VERSION,
    configRevision: SIMULATION_CONFIG_REVISION,
    worldGeneration, seed, revision, eventSeq,
    world: worldState.world,
    conductor: conductorState.conductor,
    sequence: { ...worldState.sequence, ...conductorState.sequence },
    control: { paused, ...worldState.control, ...conductorState.control },
    rng: {
      algorithm: DETERMINISTIC_RNG_ALGORITHM,
      world: worldRng.exportState(),
      conductor: conductorRng.exportState(),
    },
  };
  if (!validateSimulationCheckpoint(checkpoint, {
    seed, configRevision: SIMULATION_CONFIG_REVISION,
  })) throw new Error('INVALID_SIMULATION_CHECKPOINT');
  return deepFreeze(structuredClone(checkpoint));
}
```

`validateSimulationCheckpoint()` is strict and non-throwing. It requires the exact
world/protocol/snapshot/checkpoint schema tuple, config/seed supplied by `expected`, a non-empty
worldGeneration, safe non-negative
revision/eventSeq, all required nested sections, complete configured tree-ID key sets, unique tree/bird
IDs, finite JSON-safe values and two valid RNG states. It rejects callbacks, promises, `undefined`,
`NaN`, infinities, missing nested fields and half-restored data.

`createWorld({ restoredState = null })` hydrates all mutable closure state before listeners are
observable. The null path executes the existing initialization and `onDawn()` exactly once; the
validated restore path skips initial dawn and restores complete clock, tree/bird records (including
hidden timers/stats), branch preferences, vocalize biases, world Sequence/Jungle state, last Sequence
steps, tree controls and agent resume timers. Its export is exactly:

```js
{
  world: { clock, trees, branchPreference, vocalizeBias },
  sequence: { worldPatterns, jungleEditPlans, lastSequenceStep },
  control: { treeControl, agentResumeAt, tempo },
}
```

`createSequencePatternBridge({ restoredState = null })` restores/exports both current and previous
grids. `createDeterministicConductor(world, { restoredState = null })` restores every mutable closure
listed in Frozen Interfaces, installs subscriptions only after hydration, and exports its
`conductor/sequence/control` sections. `exportDeterministicState()` throws
`CHECKPOINT_NONDETERMINISTIC_SOURCE_ACTIVE` while a pipeline/evaluator/reviewSource result is active or
pending; source objects, callbacks and listeners never enter checkpoint data.

Keep `attachPipelineConductor()` as the compatibility adapter:

```js
import { createDeterministicConductor } from './deterministic-conductor.js';

export {
  resolveBehaviorSuggestions,
  evaluateDay,
  filterMutationBounds,
  ensurePatternMutation,
  meanTreePatternSimilarity,
  planFromLlm,
  ruleSequencePlan,
  padDiversityBranchWeights,
  bassRootBranchWeights,
  harmonyScoreFromCounts,
  masterMenuFromConfig,
} from './deterministic-conductor.js';

function createExistingPipelineReviewSource({ evaluator = null, pipeline = null } = {}) {
  return {
    dayReview(input) {
      if (pipeline) return pipeline.dayReview(input);
      if (evaluator) return evaluator(input.stats, input.context);
      return null;
    },
    dawnPlan(input) {
      return pipeline ? pipeline.dawnPlan(input) : null;
    },
  };
}

export function attachPipelineConductor(world, options = {}) {
  const core = createDeterministicConductor(world, {
    ...options,
    reviewSource: createExistingPipelineReviewSource({
      evaluator: options.evaluator,
      pipeline: options.pipeline,
    }),
  });
  return {
    ...core,
    setPipeline(pipeline) {
      core.setReviewSource(createExistingPipelineReviewSource({ pipeline }));
    },
  };
}
```

Preserve the existing public return keys and callback payload/order. `dispose()` unregisters every
listener installed by the extracted core.

- [ ] **Step 4: Run both independent golden consumers and all 404+ MVP tests**

```powershell
node --test mvp/test/conductor-characterization.test.js mvp/test/deterministic-conductor.test.js mvp/test/simulation-checkpoint.test.js mvp/test/agent.test.js mvp/test/harmony-frame.test.js mvp/test/pipeline.test.js
npm run test:mvp
npm run verify:phase0
```

Expected: the unchanged adapter and the new core both match the separately frozen literal golden;
the optional owner checkpoint resumes with exact deterministic continuation; all commands exit 0 and
every pre-existing agent/conductor test remains unchanged and passes.

- [ ] **Step 5: Commit**

```powershell
git add mvp/src/deterministic-conductor.js mvp/src/deterministic-rng.js mvp/src/simulation-checkpoint.js mvp/src/agent.js mvp/src/sequence.js mvp/src/world.js mvp/test/fixtures/conductor-golden.js mvp/test/conductor-characterization.test.js mvp/test/deterministic-conductor.test.js mvp/test/simulation-checkpoint.test.js
git commit -m "refactor(mvp): extract deterministic conductor"
```

### Task 7: Migrate the deterministic kernel into the shadow runtime

**Files:**

- Create: `flock-voice-engine/runtime/domain-migration.json`
- Create: `flock-voice-engine/runtime/domain-test-migration.json`
- Create: `flock-voice-engine/runtime/src/domain/config.js`
- Create: `flock-voice-engine/runtime/src/domain/world.js`
- Create: `flock-voice-engine/runtime/src/domain/sequence.js`
- Create: `flock-voice-engine/runtime/src/domain/economy.js`
- Create: `flock-voice-engine/runtime/src/domain/harmony.js`
- Create: `flock-voice-engine/runtime/src/domain/mapping.js`
- Create: `flock-voice-engine/runtime/src/domain/jungle.js`
- Create: `flock-voice-engine/runtime/src/domain/deterministic-conductor.js`
- Create: `flock-voice-engine/runtime/src/domain/deterministic-rng.js`
- Create: `flock-voice-engine/runtime/src/domain/simulation-checkpoint.js`
- Create: `flock-voice-engine/runtime/src/domain/master/policy.js`
- Create: `flock-voice-engine/runtime/src/domain/survival-actions.js`
- Create: `flock-voice-engine/runtime/src/audio/null-audio-sink.js`
- Create: `flock-voice-engine/runtime/src/simulation-runtime.js`
- Create: `flock-voice-engine/runtime/test/domain-parity.test.js`
- Create: `flock-voice-engine/runtime/test/domain-import-closure.test.js`
- Create: `flock-voice-engine/runtime/test/domain/helpers.js`
- Create: `flock-voice-engine/runtime/test/domain/fixtures/conductor-golden.js`
- Create: `flock-voice-engine/runtime/test/domain/world.test.js`
- Create: `flock-voice-engine/runtime/test/domain/sequence.test.js`
- Create: `flock-voice-engine/runtime/test/domain/economy.test.js`
- Create: `flock-voice-engine/runtime/test/domain/harmony.test.js`
- Create: `flock-voice-engine/runtime/test/domain/harmony-frame.test.js`
- Create: `flock-voice-engine/runtime/test/domain/mapping.test.js`
- Create: `flock-voice-engine/runtime/test/domain/jungle.test.js`
- Create: `flock-voice-engine/runtime/test/domain/agent.test.js`
- Create: `flock-voice-engine/runtime/test/domain/daycycle.test.js`
- Create: `flock-voice-engine/runtime/test/domain/master-policy.test.js`
- Create: `flock-voice-engine/runtime/test/domain/survival-actions.test.js`
- Create: `flock-voice-engine/runtime/test/domain/conductor-characterization.test.js`
- Create: `flock-voice-engine/runtime/test/domain/deterministic-conductor.test.js`
- Create: `flock-voice-engine/runtime/test/domain/simulation-checkpoint.test.js`
- Create: `flock-voice-engine/runtime/test/domain/test-migration.test.js`
- Create: `flock-voice-engine/runtime/test/src/agent.js`
- Create: `flock-voice-engine/runtime/test/src/config.js`
- Create: `flock-voice-engine/runtime/test/src/deterministic-conductor.js`
- Create: `flock-voice-engine/runtime/test/src/deterministic-rng.js`
- Create: `flock-voice-engine/runtime/test/src/economy.js`
- Create: `flock-voice-engine/runtime/test/src/harmony.js`
- Create: `flock-voice-engine/runtime/test/src/jungle.js`
- Create: `flock-voice-engine/runtime/test/src/mapping.js`
- Create: `flock-voice-engine/runtime/test/src/master/policy.js`
- Create: `flock-voice-engine/runtime/test/src/sequence.js`
- Create: `flock-voice-engine/runtime/test/src/simulation-checkpoint.js`
- Create: `flock-voice-engine/runtime/test/src/survival-actions.js`
- Create: `flock-voice-engine/runtime/test/src/world.js`
- Create: `flock-voice-engine/runtime/test/simulation-runtime.test.js`
- Create: `flock-voice-engine/runtime/test/kernel-restore.test.js`
- Create: `flock-voice-engine/runtime/test/no-audio-side-effects.test.js`
- Modify: `flock-voice-engine/runtime/package.json`
- Modify: `flock-voice-engine/runtime/src/index.js`

**Interfaces:**

- Consumes: Task 2 WorldSession, Task 3 commit protocol, exact MVP sources after Task 6.
- Produces:
  `createSimulationRuntime({ seed, config, rngFactory, audioSink, restoredSnapshot=null })`,
  `createSimulationKernelFactory(dependencies)`,
  `runtime.exportCheckpoint({ worldGeneration, revision, eventSeq })`,
  `createNullAudioSink()`, a mechanically closed exact-copy domain graph, byte-identical replacement
  domain tests resolved through test-only adapters, and an opt-in candidate fixed-step loop started
  only by `src/index.js`.

- [ ] **Step 1: Write failing migration, import-closure, real-kernel restore, isolation, and null-audio tests**

```js
import { CONFIG as MVP_CONFIG } from '../../../mvp/src/config.js';

const ledger = JSON.parse(readFileSync('flock-voice-engine/runtime/domain-migration.json', 'utf8'));
assert.equal(ledger.behaviorOwner, 'mvp/src');
assert.equal(ledger.deleteByPhase, 5);
for (const item of ledger.files.filter(({ mode }) => mode === 'exact-copy')) {
  assert.equal(sha256(item.source), sha256(item.candidate), item.candidate);
}

const domainConfigModule = await import('../src/domain/config.js');
const { DOMAIN_CONFIG, createDomainConfigProjection } = domainConfigModule;
function walkConfig(value, visit) {
  if (value == null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    visit({ key, value: child });
    walkConfig(child, visit);
  }
}

assert.deepEqual(
  Object.keys(domainConfigModule).sort(),
  ['CONFIG', 'DOMAIN_CONFIG', 'createDomainConfigProjection'],
);
assert.deepEqual(DOMAIN_CONFIG, createDomainConfigProjection(MVP_CONFIG));
assert.equal('visual' in DOMAIN_CONFIG, false);
assert.equal('voiceEngine' in DOMAIN_CONFIG, false);
assert.equal('latentAgent' in DOMAIN_CONFIG, false);
assert.equal('log' in DOMAIN_CONFIG, false);
walkConfig(DOMAIN_CONFIG, ({ key, value }) => {
  assert.doesNotMatch(key, /(endpoint|url|api.?key|secret|stepfun|deepseek)/i);
  if (typeof value === 'string') {
    assert.doesNotMatch(value, /(https?:|8081|stepfun|deepseek)/i);
  }
});

const left = createSimulationRuntime({ seed: 7, audioSink: createNullAudioSink() });
const right = createSimulationRuntime({ seed: 7, audioSink: createNullAudioSink() });
assert.deepEqual(left.tick(1 / 30), right.tick(1 / 30));
left.tick(1 / 30);
assert.notDeepEqual(left.getSnapshot(), right.getSnapshot());

assert.equal(audioSink.getStatus().mode, 'null');
assert.equal(Number.isInteger(audioSink.getStatus().acceptedCommandCount), true);
assert.equal(audioSink.getStatus().pcmFrameCount, 0);
```

Also assert that importing/constructing/ticking the kernel never calls fetch, WebSocket,
AudioContext, files under `client/`, `/decoder`, `/api/v1/audio` or 8081.

`kernel-restore.test.js` must use the production-shaped `WorldSession` plus the real
`createSimulationKernelFactory()`; a fake kernel is forbidden. Run one session for 300 ticks and a
mixed command schedule, export inside `runExclusive()` so the session tuple and kernel state are one
mailbox observation, then compare uninterrupted continuation with a new session restored from the
JSON-round-tripped checkpoint:

```js
const checkpoint = await sourceSession.runExclusive('checkpoint.export', (session) => (
  session.kernel.exportCheckpoint({
    worldGeneration: session.worldGeneration,
    revision: session.revision,
    eventSeq: session.eventSeq,
  })
));
const restoredSession = new WorldSession({
  seed,
  createKernel: createSimulationKernelFactory({ audioSink: createNullAudioSink() }),
  validateRestoredSnapshot: (value) => validateSimulationCheckpoint(value, {
    seed, configRevision: 'phase2-domain-config-v1',
  }),
  restoredSnapshot: JSON.parse(JSON.stringify(checkpoint)),
  worldGenerationFactory: () => 'must-not-be-used-for-compatible-restore',
});
assert.deepEqual(
  [restoredSession.worldGeneration, restoredSession.revision, restoredSession.eventSeq],
  [checkpoint.worldGeneration, checkpoint.revision, checkpoint.eventSeq],
);
await advanceWithCommands(uninterruptedSession, remainingSchedule);
await advanceWithCommands(restoredSession, remainingSchedule);
assert.deepEqual(
  await exportSessionCheckpoint(restoredSession),
  await exportSessionCheckpoint(uninterruptedSession),
);
assert.deepEqual(restoredSecondHalfEvents, uninterruptedSecondHalfEvents);
```

Use a table of independently corrupted checkpoints: wrong `schemaVersion`, wrong `configRevision`,
wrong seed, missing `world.trees`, missing `sequence.bridgeCurrent`, missing
`control.treeControl`, invalid conductor pending state, and invalid RNG state/drawCount. For each,
record the argument received by the real factory and require `restoredSnapshot === null`, a fresh
opaque generation, `revision=eventSeq=0`, and a checkpoint exactly equal to a separately constructed
fresh real kernel. No old bird, control, sequence, conductor or RNG field may survive.

- [ ] **Step 2: Run RED**

```powershell
node --test flock-voice-engine/runtime/test/domain-parity.test.js flock-voice-engine/runtime/test/domain-import-closure.test.js flock-voice-engine/runtime/test/domain/test-migration.test.js flock-voice-engine/runtime/test/simulation-runtime.test.js flock-voice-engine/runtime/test/kernel-restore.test.js flock-voice-engine/runtime/test/no-audio-side-effects.test.js
```

Expected: FAIL because the migration ledger and domain candidate do not exist.

- [ ] **Step 3: Create the exact temporary-copy ledger and candidate files**

The ledger content is:

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

Add the eleven `exact-copy` candidates byte-for-byte. Do not copy `mvp/src/config.js`.
`runtime/src/domain/config.js` instead imports the MVP CONFIG during this shadow-only phase and exports
only a deeply cloned/frozen projection:

```js
import { CONFIG as MVP_CONFIG } from '../../../../mvp/src/config.js';

export function createDomainConfigProjection(source) {
  return deepFreeze(structuredClone({
    sim: source.sim,
    tempo: source.tempo,
    llm: {
      seasonLengthRange: source.llm.seasonLengthRange,
      masterCooldownDays: source.llm.masterCooldownDays,
    },
    harmony: source.harmony,
    tree: source.tree,
    trees: source.trees,
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
        texture: {
          mode: source.audio.timbres.texture.mode,
          jungleTempoMultiplier: source.audio.timbres.texture.jungleTempoMultiplier,
        },
      },
    },
  }));
}

export const DOMAIN_CONFIG = createDomainConfigProjection(MVP_CONFIG);
export { DOMAIN_CONFIG as CONFIG };
```

`deepFreeze()` recursively freezes arrays and objects. The projection test is the enforced update rule
for config; hash equality remains the paired-update rule for the eleven pure domain copies. Runtime
consumers may import only the projected `CONFIG` export.

`domain-import-closure.test.js` mechanically proves that every relative static import, relative
re-export and literal dynamic import from an exact-copy candidate resolves to an existing path listed
in `domain-migration.json`; no candidate may reach back into `mvp/`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ledger = JSON.parse(readFileSync(
  'flock-voice-engine/runtime/domain-migration.json', 'utf8',
));
const candidates = new Set(ledger.files.map(({ candidate }) => resolve(candidate)));
const relativeSpecifiers = (source) => {
  const values = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('.')) values.push(match[1]);
    }
  }
  return [...new Set(values)];
};

test('exact-copy domain import graph is closed by the migration ledger', () => {
  for (const item of ledger.files.filter(({ mode }) => mode === 'exact-copy')) {
    const source = readFileSync(item.candidate, 'utf8');
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolve(dirname(item.candidate), specifier);
      assert.equal(existsSync(target), true, `${item.candidate} -> ${specifier}`);
      assert.equal(candidates.has(target), true, `unledgered domain import: ${target}`);
    }
  }
});
```

Create `domain-test-migration.json` with this machine-readable coverage map:

```json
{
  "schemaVersion": 2,
  "sourceOwner": "mvp/test",
  "replacementOwner": "flock-voice-engine/runtime/test/domain",
  "requiredBeforeBrowserTestRemovalPhase": 6,
  "normalization": "none-byte-for-byte",
  "testImportResolution": "static-and-literal-dynamic",
  "suites": [
    { "domain": "world", "source": "mvp/test/world.test.js", "candidate": "flock-voice-engine/runtime/test/domain/world.test.js" },
    { "domain": "sequence", "source": "mvp/test/sequence.test.js", "candidate": "flock-voice-engine/runtime/test/domain/sequence.test.js" },
    { "domain": "economy", "source": "mvp/test/economy.test.js", "candidate": "flock-voice-engine/runtime/test/domain/economy.test.js" },
    { "domain": "harmony", "source": "mvp/test/harmony.test.js", "candidate": "flock-voice-engine/runtime/test/domain/harmony.test.js" },
    { "domain": "harmony-frame", "source": "mvp/test/harmony-frame.test.js", "candidate": "flock-voice-engine/runtime/test/domain/harmony-frame.test.js" },
    { "domain": "mapping", "source": "mvp/test/mapping.test.js", "candidate": "flock-voice-engine/runtime/test/domain/mapping.test.js" },
    { "domain": "jungle", "source": "mvp/test/jungle.test.js", "candidate": "flock-voice-engine/runtime/test/domain/jungle.test.js" },
    { "domain": "agent", "source": "mvp/test/agent.test.js", "candidate": "flock-voice-engine/runtime/test/domain/agent.test.js" },
    { "domain": "daycycle", "source": "mvp/test/daycycle.test.js", "candidate": "flock-voice-engine/runtime/test/domain/daycycle.test.js" },
    { "domain": "master-policy", "source": "mvp/test/master-policy.test.js", "candidate": "flock-voice-engine/runtime/test/domain/master-policy.test.js" },
    { "domain": "survival-actions", "source": "mvp/test/survival-actions.test.js", "candidate": "flock-voice-engine/runtime/test/domain/survival-actions.test.js" },
    { "domain": "conductor-characterization", "source": "mvp/test/conductor-characterization.test.js", "candidate": "flock-voice-engine/runtime/test/domain/conductor-characterization.test.js" },
    { "domain": "deterministic-conductor", "source": "mvp/test/deterministic-conductor.test.js", "candidate": "flock-voice-engine/runtime/test/domain/deterministic-conductor.test.js" },
    { "domain": "simulation-checkpoint", "source": "mvp/test/simulation-checkpoint.test.js", "candidate": "flock-voice-engine/runtime/test/domain/simulation-checkpoint.test.js" }
  ],
  "supportFiles": [
    { "source": "mvp/test/helpers.js", "candidate": "flock-voice-engine/runtime/test/domain/helpers.js" },
    { "source": "mvp/test/fixtures/conductor-golden.js", "candidate": "flock-voice-engine/runtime/test/domain/fixtures/conductor-golden.js" }
  ],
  "adapters": [
    { "candidate": "flock-voice-engine/runtime/test/src/agent.js", "target": "flock-voice-engine/runtime/src/domain/deterministic-conductor.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/config.js", "target": "flock-voice-engine/runtime/src/domain/config.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/deterministic-conductor.js", "target": "flock-voice-engine/runtime/src/domain/deterministic-conductor.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/deterministic-rng.js", "target": "flock-voice-engine/runtime/src/domain/deterministic-rng.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/economy.js", "target": "flock-voice-engine/runtime/src/domain/economy.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/harmony.js", "target": "flock-voice-engine/runtime/src/domain/harmony.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/jungle.js", "target": "flock-voice-engine/runtime/src/domain/jungle.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/mapping.js", "target": "flock-voice-engine/runtime/src/domain/mapping.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/master/policy.js", "target": "flock-voice-engine/runtime/src/domain/master/policy.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/sequence.js", "target": "flock-voice-engine/runtime/src/domain/sequence.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/simulation-checkpoint.js", "target": "flock-voice-engine/runtime/src/domain/simulation-checkpoint.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/survival-actions.js", "target": "flock-voice-engine/runtime/src/domain/survival-actions.js" },
    { "candidate": "flock-voice-engine/runtime/test/src/world.js", "target": "flock-voice-engine/runtime/src/domain/world.js" }
  ]
}
```

Copy every listed suite and support file byte-for-byte; do not edit static imports, dynamic imports,
test names or bodies. From `runtime/test/domain/*.test.js`, the unchanged `../src/*` specifiers resolve
to `runtime/test/src/*`, while unchanged `./helpers.js` and `./fixtures/*` specifiers stay inside the
domain test tree. This preserves all source bytes and makes dynamic imports mechanically verifiable.
After committing both ledger JSON files, use the ledger paths themselves as the copy source of truth:

```powershell
$domainLedger = Get-Content 'flock-voice-engine/runtime/domain-migration.json' -Raw -Encoding utf8 |
  ConvertFrom-Json
$testLedger = Get-Content 'flock-voice-engine/runtime/domain-test-migration.json' -Raw -Encoding utf8 |
  ConvertFrom-Json
$copies = @(
  $domainLedger.files | Where-Object mode -eq 'exact-copy'
  $testLedger.suites
  $testLedger.supportFiles
)
foreach ($copy in $copies) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy.candidate) | Out-Null
  Copy-Item -LiteralPath $copy.source -Destination $copy.candidate
}
```

Every simple test adapter is a one-line re-export. Use these exact contents:

```text
runtime/test/src/config.js                    export * from '../../src/domain/config.js';
runtime/test/src/deterministic-conductor.js   export * from '../../src/domain/deterministic-conductor.js';
runtime/test/src/deterministic-rng.js         export * from '../../src/domain/deterministic-rng.js';
runtime/test/src/economy.js                   export * from '../../src/domain/economy.js';
runtime/test/src/harmony.js                   export * from '../../src/domain/harmony.js';
runtime/test/src/jungle.js                    export * from '../../src/domain/jungle.js';
runtime/test/src/mapping.js                   export * from '../../src/domain/mapping.js';
runtime/test/src/sequence.js                  export * from '../../src/domain/sequence.js';
runtime/test/src/simulation-checkpoint.js     export * from '../../src/domain/simulation-checkpoint.js';
runtime/test/src/survival-actions.js          export * from '../../src/domain/survival-actions.js';
runtime/test/src/world.js                     export * from '../../src/domain/world.js';
runtime/test/src/master/policy.js             export * from '../../../src/domain/master/policy.js';
```

`runtime/test/src/agent.js` is the only behavioral test adapter. It re-exports all public pure helpers
from the candidate and supplies the legacy `attachPipelineConductor` name without importing browser
code:

```js
import { createDeterministicConductor } from '../../src/domain/deterministic-conductor.js';
export * from '../../src/domain/deterministic-conductor.js';

function reviewSourceFrom({ evaluator = null, pipeline = null } = {}) {
  return {
    dayReview(input) {
      if (pipeline) return pipeline.dayReview(input);
      if (evaluator) return evaluator(input.stats, input.context);
      return null;
    },
    dawnPlan(input) {
      return pipeline ? pipeline.dawnPlan(input) : null;
    },
  };
}

export function attachPipelineConductor(world, options = {}) {
  const core = createDeterministicConductor(world, {
    ...options,
    reviewSource: reviewSourceFrom({
      evaluator: options.evaluator,
      pipeline: options.pipeline,
    }),
  });
  return {
    ...core,
    setPipeline(pipeline) {
      core.setReviewSource(reviewSourceFrom({ pipeline }));
    },
  };
}
```

`domain/test-migration.test.js` reads the ledger and performs four mechanical checks:

1. the exact required suite/support/adapter path sets equal the JSON above;
2. every suite and support candidate has byte-for-byte SHA-256 equality with its source;
3. every relative static import, relative re-export and literal dynamic import found in each copied
   candidate resolves to an existing file under `runtime/test/domain` or `runtime/test/src`;
4. every adapter exists, imports only its declared runtime-domain target, and never imports `mvp/`.

The scanner uses the same two `relativeSpecifiers()` patterns from
`domain-import-closure.test.js`; it does not strip or rewrite source text. This makes the existing
dynamic imports in `economy.test.js` resolve through `runtime/test/src/world.js` and
`runtime/test/src/economy.js` while retaining exact file hashes. Phase 6 may remove a browser suite
only while its byte-identical ledger entry and passing runtime replacement remain.

Update the runtime package unit script when these nested suites exist:

```json
"test": "node --test test/*.test.js test/domain/*.test.js"
```

- [ ] **Step 4: Implement SimulationRuntime and NullAudioSink**

```js
export function createNullAudioSink() {
  let acceptedCommandCount = 0;
  return {
    accept(commands) { acceptedCommandCount += commands.length; },
    getStatus: () => Object.freeze({
      mode: 'null', acceptedCommandCount, pcmFrameCount: 0,
    }),
  };
}

export function createSimulationRuntime({
  seed,
  config = CONFIG,
  rngFactory = createDeterministicRng,
  audioSink = createNullAudioSink(),
  restoredSnapshot = null,
}) {
  if (restoredSnapshot !== null && !validateSimulationCheckpoint(restoredSnapshot, {
    seed, configRevision: SIMULATION_CONFIG_REVISION,
  })) throw new Error('INCOMPATIBLE_SIMULATION_CHECKPOINT');
  const restored = restoredSnapshot === null ? null : structuredClone(restoredSnapshot);
  const worldRng = rngFactory(seed, restored?.rng.world ?? null);
  const conductorSeed = (seed ^ 0x9e3779b9) >>> 0;
  const conductorRng = rngFactory(conductorSeed, restored?.rng.conductor ?? null);
  // Own one world and one deterministic conductor, capture ordered domain events,
  // map perch/unperch only into diagnostic audioCommands, and send them to NullAudioSink.
  // Pass restored world/sequence/control and conductor sections only when the whole
  // checkpoint has validated. Restore paused from control.paused.
  // tick(dt) and applyCommand(command) return CommitDraft; neither starts a timer.
  function exportCheckpoint({ worldGeneration, revision, eventSeq }) {
    return createSimulationCheckpoint({
      worldGeneration, seed, revision, eventSeq,
      worldState: world.exportDeterministicState(),
      conductorState: conductor.exportDeterministicState(),
      worldRng, conductorRng, paused,
    });
  }
  return { tick, applyCommand, getSnapshot, exportCheckpoint, dispose };
}

export function createSimulationKernelFactory(dependencies = {}) {
  return ({ seed, restoredSnapshot }) => createSimulationRuntime({
    ...dependencies, seed, restoredSnapshot,
  });
}
```

`simulation-runtime.js` imports `createDeterministicRng`,
`createSimulationCheckpoint`, `validateSimulationCheckpoint` and
`SIMULATION_CONFIG_REVISION` only from the exact-copy runtime domain. The XOR constant above is shared
by the Task 6 owner checkpoint harness and Task 8 MVP oracle. A non-null invalid checkpoint throws
before creating world, conductor, listeners or RNGs; `WorldSession` supplies `null` after validator
rejection, so incompatible persisted input produces a wholly fresh real kernel rather than partial
hydration.

Implement kernel commands `runtime.pause`, `runtime.resume`, `sequence.toggle`, `sequence.place`,
`bird.shoo`, `transport.setTempo` and `transport.setMeter`. `snapshot.request` is reserved for the
Task 3 gateway-to-WorldSession barrier and must not appear in `SimulationRuntime.applyCommand()`.
Recognized later-phase commands return
`{ accepted:false, code:"UNAVAILABLE_IN_PHASE_2" }`; unknown names return
`{ accepted:false, code:"UNKNOWN_COMMAND" }`.

`src/index.js` may start the candidate fixed-step loop only after a successful localhost listen.
Use `CONFIG.sim.tickHz`, enqueue each tick through `WorldSession.commit()`, and stop the timer on
SIGINT/SIGTERM. No timer is started by imports or constructors.
The kernel must preserve the existing `perch`, `unperch`, `dawn`, `dusk` and `sequence-pattern`
names and payloads in ordered `domainEvents`.

- [ ] **Step 5: Run GREEN, source parity, session isolation, and both Node versions**

```powershell
node --test flock-voice-engine/runtime/test/domain-parity.test.js flock-voice-engine/runtime/test/domain-import-closure.test.js flock-voice-engine/runtime/test/domain/*.test.js flock-voice-engine/runtime/test/simulation-runtime.test.js flock-voice-engine/runtime/test/kernel-restore.test.js flock-voice-engine/runtime/test/no-audio-side-effects.test.js
npm run test:runtime
npx -y node@20 --test flock-voice-engine/runtime/test/*.test.js flock-voice-engine/runtime/test/domain/*.test.js
npm run verify:phase0
```

Expected: all commands exit 0; every exact-copy implementation and test/support SHA pair matches,
both implementation and test import graphs are closed, every ledgered MVP domain case runs against
the runtime candidate, compatible real-kernel restore continues exactly, every incompatible variant
is a clean rebuild, and `pcmFrameCount` remains zero.

- [ ] **Step 6: Commit**

```powershell
git add flock-voice-engine/runtime/package.json flock-voice-engine/runtime/domain-migration.json flock-voice-engine/runtime/domain-test-migration.json flock-voice-engine/runtime/src/domain flock-voice-engine/runtime/src/audio/null-audio-sink.js flock-voice-engine/runtime/src/simulation-runtime.js flock-voice-engine/runtime/src/index.js flock-voice-engine/runtime/test
git commit -m "feat(runtime): add deterministic shadow kernel"
```

### Task 8: Deterministic shadow replay and first-divergence diagnostics

**Files:**

- Create: `mvp/eval/shadow-oracle.js`
- Create: `flock-voice-engine/runtime/src/shadow/canonicalize.js`
- Create: `flock-voice-engine/runtime/src/shadow/compare.js`
- Create: `flock-voice-engine/runtime/src/shadow/shadow-runner.js`
- Create: `flock-voice-engine/runtime/test/fixtures/phase2-shadow-cases.json`
- Create: `flock-voice-engine/runtime/test/shadow-replay.test.js`

**Interfaces:**

- Consumes: current MVP oracle and Task 7 SimulationRuntime.
- Produces: `runShadowCase(testCase) -> { matched, comparedTicks, firstDifference }` and
  `assertShadowMatch(result)`.

- [ ] **Step 1: Write failing replay tests and fixed tolerance contract**

```js
for (const testCase of cases) {
  const result = runShadowCase(testCase);
  assert.equal(result.matched, true, JSON.stringify(result.firstDifference, null, 2));
  assert.equal(result.comparedTicks, testCase.ticks);
}

const mismatch = compareSnapshots({ phase: 0.1 }, { phase: 0.2 });
assert.deepEqual(mismatch, {
  path: '$.phase', expected: 0.1, actual: 0.2, tolerance: 1e-12,
});
```

The fixture contains four named cases: 600 fixed ticks; tick partitioning with equal elapsed time;
sequence toggle/place and bird shoo interleaving; and a complete dawn/dusk/day transition. Tests derive
valid treeId/birdId/sequence addresses from the initial snapshot, so fixtures contain no unstable IDs.
Every case fixes `worldGeneration:"shadow-generation"`; both the oracle envelope and candidate
WorldSession receive that injected value so generation is compared rather than omitted.

Use these exact tolerances:

```js
export const SHADOW_TOLERANCES = Object.freeze({
  '$.simTime': 1e-12,
  '$.phase': 1e-12,
  '$.daylight': 1e-12,
  '$.trees[*].meanEnergy': 1e-12,
  '$.trees[*].birds[*].energy': 1e-12,
  '$.trees[*].birds[*].dwellTime': 1e-12,
  '$.trees[*].birds[*].dwellBeatTime': 1e-12,
  '$.trees[*].birds[*].flightTime': 1e-12,
  '$.trees[*].birds[*].plannedDwell': 1e-12,
  '$.trees[*].birds[*].plannedFlight': 1e-12,
  '$.trees[*].birds[*].pos.x': 1e-12,
  '$.trees[*].birds[*].pos.y': 1e-12,
  '$.mapping.frequency': 1e-9
});
```

Every unlisted field compares exactly. Arrays retain order; only object keys are sorted.

- [ ] **Step 2: Run RED**

```powershell
node --test flock-voice-engine/runtime/test/shadow-replay.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `shadow/shadow-runner.js`.

- [ ] **Step 3: Implement an independent browser oracle and comparator**

`mvp/eval/shadow-oracle.js` imports the MVP world and deterministic conductor directly and exposes
`createShadowOracle({ seed })` with `tick/applyCommand/getSnapshot/drainDomainEvents/dispose`.
It imports the MVP-owned `createDeterministicRng()` seam, using `seed` for world and
`(seed ^ 0x9e3779b9) >>> 0` for conductor, and must not import runtime candidate files. No checkpoint
is created unless a test explicitly calls the optional oracle export seam.

`shadow-runner.js` imports the candidate only from `runtime/src`. At every logical tick it applies the
same commands, advances both sides with the same dt sequence, and compares snapshot plus ordered
domain-event payloads. On the first difference it returns:

```js
{
  tick,
  path,
  expected,
  actual,
  tolerance,
  recentExpectedEvents,
  recentActualEvents
}
```

Do not remove fields from either side to make a test pass. Protocol envelope fields are compared
separately from the domain snapshot, including exact `worldGeneration`.

- [ ] **Step 4: Run GREEN and deterministic repetition**

```powershell
node --test flock-voice-engine/runtime/test/shadow-replay.test.js
node --test flock-voice-engine/runtime/test/shadow-replay.test.js
npm run test:runtime
npm run test:mvp
npm run verify:phase0
```

Expected: both consecutive shadow runs pass with identical tick counts and no first difference.

- [ ] **Step 5: Commit**

```powershell
git add mvp/eval/shadow-oracle.js flock-voice-engine/runtime/src/shadow flock-voice-engine/runtime/test/fixtures flock-voice-engine/runtime/test/shadow-replay.test.js
git commit -m "test(runtime): prove deterministic shadow parity"
```

### Task 9: Test-only candidate UI E2E and aggregate Phase 1–2 gate

**Files:**

- Create: `flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html`
- Create: `flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js`
- Create: `flock-voice-engine/runtime/playwright.config.js`
- Create: `flock-voice-engine/runtime/test/e2e/candidate-ui.spec.js`
- Create: `flock-voice-engine/runtime/test/e2e/reconnect.spec.js`
- Create: `flock-voice-engine/runtime/test/e2e/no-audio.spec.js`
- Create: `flock-voice-engine/runtime/test/candidate-surface.test.js`
- Modify: `flock-voice-engine/runtime/package.json`
- Modify: `flock-voice-engine/runtime/package-lock.json`
- Modify: `package.json`

**Interfaces:**

- Consumes: RuntimeClient, existing `createRenderer(canvas)`, candidate Node server and fixed-step
  shadow kernel.
- Produces: a test-only candidate page, a static + literal-dynamic production-entry reachability
  gate, and `npm run verify:phase12`; no production active reference.

- [ ] **Step 1: Write failing surface and Chromium E2E tests**

```js
// candidate-surface.test.js
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const productionHtml = readFileSync('mvp/index.html', 'utf8');
const moduleEntries = [...productionHtml.matchAll(/<script\b[^>]*>/gi)]
  .map(([tag]) => ({
    tag,
    type: tag.match(/\btype\s*=\s*['"]([^'"]+)['"]/i)?.[1] ?? '',
    src: tag.match(/\bsrc\s*=\s*['"]([^'"]+)['"]/i)?.[1] ?? '',
  }))
  .filter(({ type }) => type === 'module')
  .map(({ src }) => src.split(/[?#]/, 1)[0]);
assert.deepEqual(moduleEntries, ['./src/main.js']);

const moduleSpecifiers = (source) => {
  const values = [];
  for (const pattern of [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) values.push(match[1]);
  }
  return [...new Set(values)];
};
const repoRoot = resolve('.');
const resolveLocalModule = (fromFile, specifier) => {
  const clean = specifier.split(/[?#]/, 1)[0];
  if (clean.startsWith('.')) return resolve(dirname(fromFile), clean);
  if (clean.startsWith('/')) return resolve(repoRoot, clean.slice(1));
  return null;
};
const productionReachable = new Set();
const pending = [resolve('mvp/src/main.js')];
while (pending.length) {
  const current = pending.pop();
  if (productionReachable.has(current)) continue;
  productionReachable.add(current);
  const source = readFileSync(current, 'utf8');
  for (const specifier of moduleSpecifiers(source)) {
    const target = resolveLocalModule(current, specifier);
    if (target === null) continue;
    assert.equal(existsSync(target), true, `${current} -> ${specifier}`);
    pending.push(target);
  }
}
const under = (file, root) => {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
assert.equal(productionReachable.has(resolve('mvp/src/runtime-client.js')), false);
for (const forbiddenRoot of [
  resolve('flock-voice-engine/runtime/src'),
  resolve('flock-voice-engine/runtime/test/fixtures/candidate-ui'),
]) {
  assert.equal([...productionReachable].some((file) => under(file, forbiddenRoot)), false);
}

const candidatePath = 'flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js';
const candidateSource = readFileSync(candidatePath, 'utf8');
for (const forbidden of ['world.js', 'agent.js', 'audio.js', 'ecological-latent.js']) {
  assert.equal(candidateSource.includes(forbidden), false);
}
const productionManifest = JSON.parse(
  readFileSync('docs/production-manifests/2026-07-22-production.json', 'utf8'),
);
const manifestText = JSON.stringify(productionManifest);
for (const forbidden of [
  'candidate-ui',
  'flock-voice-engine/runtime/src',
  'mvp/src/runtime-client.js',
]) assert.equal(manifestText.includes(forbidden), false);
assert.equal(existsSync('flock-voice-engine/web/test/fixtures/candidate-ui'), false);
assert.equal(existsSync('flock-voice-engine/web/src/runtime-client.js'), false);

// candidate-ui.spec.js
await page.goto(
  'http://127.0.0.1:4193/flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html',
);
await expect(page.locator('[data-runtime-status]')).toHaveText('ready');
await expect(page.locator('[data-world-generation]')).not.toHaveText('');
const firstRevision = Number(await page.locator('[data-revision]').textContent());
await expect.poll(async () => Number(await page.locator('[data-revision]').textContent()))
  .toBeGreaterThan(firstRevision);
```

Reconnect tests must cover replay and forced journal-gap snapshot. No-audio tests record all requests
and browser constructor calls, then assert zero `/decoder`, `/api/v1/audio`, 8081, AudioContext and
AudioWorklet activity. The E2E health assertion requires the exact paired candidate identity
`releaseRevision:"unknown"` and `sourceManifestSha256:"unknown"`; it fails on a half-known or
HEAD-plus-Phase-0-manifest combination.

The reachability walk starts only from the module scripts in `mvp/index.html`, requires the sole
production module entry to resolve to `mvp/src/main.js`, and recursively follows both static imports/
re-exports and literal dynamic imports. A source file may exist without being production-active, but
`mvp/src/runtime-client.js`, every file under candidate fixtures and every server-owner implementation
under `flock-voice-engine/runtime/src` must remain unreachable. Non-literal dynamic imports are not
used to select runtime ownership; adding one to the production graph is a review failure rather than
a scanner bypass.

- [ ] **Step 2: Run RED before adding Playwright**

```powershell
node --test flock-voice-engine/runtime/test/candidate-surface.test.js
```

Expected: FAIL because the test-only `candidate-ui/index.html` and `candidate-main.js` do not exist.

- [ ] **Step 3: Add the exact E2E dependency and config**

```powershell
npm install --prefix flock-voice-engine/runtime --save-dev --save-exact @playwright/test@1.61.1
Push-Location flock-voice-engine/runtime
npx playwright install chromium
Pop-Location
```

Add these scripts:

```json
"test:e2e": "playwright test",
"start:e2e": "node src/index.js"
```

`playwright.config.js` starts:

1. runtime with `FLOCK_RUNTIME_HOST=127.0.0.1`,
   `FLOCK_RUNTIME_PORT=18090`, `FLOCK_RUNTIME_OWNER=browser`,
   `FLOCK_AUDIO_OWNER=legacy`, `FLOCK_RELEASE_REVISION=unknown`, and
   `FLOCK_SOURCE_MANIFEST_SHA256=unknown`;
2. `python -m http.server 4193 --bind 127.0.0.1 --directory ../..`.

Use Chromium only, one worker, no server reuse in CI, base URL
`http://127.0.0.1:4193/flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html`.

- [ ] **Step 4: Implement the candidate-only page**

The fixture `candidate-main.js` imports `/mvp/src/runtime-client.js` and
`/mvp/src/renderer.js`, creates `RuntimeClient`, subscribes to immutable snapshots, calls
`renderer.render(snapshot)` inside a visual RAF, and dispatches UI intent through `client.command()`.
It must not create a world, conductor, latent controller or audio object. Add stable test markers:

```html
<span data-runtime-status>connecting</span>
<span data-world-generation></span>
<span data-revision>0</span>
<canvas id="world"></canvas>
<script type="module" src="./candidate-main.js"></script>
```

Visual RAF is allowed only to repaint the latest snapshot; it must not mutate state or advance a tick.
Because both fixture files live below `flock-voice-engine/runtime/test/fixtures`, they are outside the
`mvp → web` release copy and production manifest mappings. The executable surface test must fail if
either file appears under `flock-voice-engine/web`, in the committed production manifest, or becomes
reachable from the `mvp/index.html` → `mvp/src/main.js` static/literal-dynamic module graph. It also
fails if that graph reaches `mvp/src/runtime-client.js` or any `flock-voice-engine/runtime/src` module.

- [ ] **Step 5: Add the aggregate gate and run GREEN**

Add exact root scripts:

```json
"test:runtime:e2e": "npm --prefix flock-voice-engine/runtime run test:e2e",
"verify:phase12": "npm run verify:phase0 && npm run test:runtime && npm run test:runtime:e2e"
```

Run:

```powershell
node --test flock-voice-engine/runtime/test/candidate-surface.test.js
npm run test:runtime:e2e
npm run verify:phase12
npx -y node@20 --test flock-voice-engine/runtime/test/*.test.js flock-voice-engine/runtime/test/domain/*.test.js
git diff --exit-code -- flock-voice-engine/server/release_info.py flock-voice-engine/deploy/docker-run.sh flock-voice-engine/web
```

Expected: surface test and all Chromium scenarios pass; aggregate gate exits 0; Node 20 unit/protocol
tests pass; frozen production paths have no diff; `/readyz` remains 503 and PCM activity remains zero.

- [ ] **Step 6: Commit**

```powershell
git add package.json flock-voice-engine/runtime/package.json flock-voice-engine/runtime/package-lock.json flock-voice-engine/runtime/playwright.config.js flock-voice-engine/runtime/test/fixtures/candidate-ui flock-voice-engine/runtime/test/e2e flock-voice-engine/runtime/test/candidate-surface.test.js
git commit -m "test(runtime): add Phase 1 and 2 candidate E2E gate"
```

## Completion Gate

- [ ] **Run the complete local evidence set without starting any production action**

```powershell
$requiredBase = '4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9'
git merge-base --is-ancestor $requiredBase HEAD
if ($LASTEXITCODE -ne 0) { throw 'Phase 0 release revision is no longer an ancestor' }

if ((Get-FileHash 'docs/production-manifests/2026-07-22-production.json' -Algorithm SHA256).Hash.ToLowerInvariant() `
  -ne '1ebd697b2e0d0cec8b0cbec008fc884179c6273b97952837f661c2c39f6065ec') {
  throw 'source manifest changed'
}

$metadata = Get-Content 'docs/production-manifests/2026-07-22-metadata.json' -Raw -Encoding utf8 |
  ConvertFrom-Json
if ($metadata.externalRuntimeInputs.vendor.treeSha256 `
  -ne '21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049') {
  throw 'vendor fingerprint changed'
}

npm run verify:phase12
npx -y node@20 --test flock-voice-engine/runtime/test/*.test.js flock-voice-engine/runtime/test/domain/*.test.js
git diff --exit-code $requiredBase -- flock-voice-engine/server/release_info.py flock-voice-engine/deploy/docker-run.sh flock-voice-engine/web
```

Expected: every command exits 0. The deliverable may be described only as “Phase 1–2 localhost
candidate and shadow verification complete”; it must not be described as backend takeover, audio
cutover, production-ready release or 8090 deployment.

## Rollback

Every task is an isolated Git commit. A failed task is rolled back by reverting only that task's commit;
the localhost candidate process, if manually started for E2E, is stopped normally. Because this plan
never changes production files, runtime owner, audio owner, 8090, Python service or PCM path, rollback
never requires a production command and the browser-owned product remains unchanged.
