# Phase 5–6 Audio Ownership and Atomic Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **2026-07-28 reconciliation:** Task 8–10 的授权 tuple、snapshot 传输、
> production activation、同源入口、active/current/previous 原子性与 rollback record
> 路径存在闭环缺口。继续实施前必须先执行
> `docs/superpowers/plans/2026-07-28-phase5-production-control-reconciliation.md`；与本文
> 冲突时，以该补充计划和配套设计为准。它不构成生产 8090 授权。

**Goal:** 建立同一 release 内唯一的 Python audio worker、后端最终混音与共享 PCM 流，在全部 localhost/staging 硬门禁通过后一次性把 world、audio、UI 和 8090 所有权切到 Node runtime，并在一个成功的新架构发布周期后安全清理 legacy 实现。

**Architecture:** Node `flock-runtime` 继续以 Phase 1–4 的单一 `WorldSession` mailbox 和 authoritative `SimulationRuntime` 为控制面，通过私有 Unix socket 驱动同 release 的单例 Python `flock-audio` worker；worker 是唯一模型、VoicePool、render state 和最终 44.1 kHz stereo master owner。worker 输出进入 Node 的单份 bounded PCM ring，再由每客户端独立 writer fan-out；legacy `/decoder` 只作为同一 worker 的协议 adapter，并受绑定 exact socket generation 的排他维护租约约束。Phase 5 之前所有实现与验收只运行在 localhost 或隔离等价 staging；生产写入只允许发生在 Task 10，并且必须另取用户明确授权。

**Tech Stack:** Node.js 20/24 ESM、`node:test`、`ws@8.21.1`、Playwright `1.61.1`、Python 3.12、pytest、aiohttp、NumPy、SciPy、soundfile、PyTorch/CUDA 13、Docker、Unix domain socket、Web Audio AudioWorklet、现有 Phase 0–4 门禁。

## Global Constraints

- 进入本计划时，`releaseRevision=4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9` 必须是当前 HEAD 的祖先；它只是 **entry gate**，不得写入未来 candidate 的 runtime/worker identity。
- `docs/production-manifests/2026-07-22-production.json` 的 SHA-256 必须精确为 `1ebd697b2e0d0cec8b0cbec008fc884179c6273b97952837f661c2c39f6065ec`。
- Phase 0 transitional vendor tree SHA-256 必须精确为 `21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049`；它只用于识别输入，不满足 Phase 5 provenance。
- 每个任务开始前必须通过 `npm run verify:phase0`、`npm run verify:phase12` 和 `npm run verify:phase34`；不得删减、替换或忽略其中任一门禁。Task 12 在删除 legacy source 前最后运行一次这三个历史门禁，删除后改用该任务定义的 `npm run verify:phase6`，不得让已退役入口重新进入日常 gate。
- Task 1–9 只允许本地或隔离等价 staging。直接运行的 Node profile 固定绑定
  `127.0.0.1:18090`；Docker profile 固定让容器内 Node 绑定 `0.0.0.0:8090`，并且只允许
  `127.0.0.1:18090:8090` 的 host publish。两种 profile 都禁止 LAN publish。禁止 SSH、scp、
  远端 Docker、生产文件写入、生产容器启停和生产 8090 变更。
- Task 10 是本计划唯一允许生产写入的任务。即使 Task 1–9 全绿，仍必须停止并另取用户对 exact candidate release 的明确授权。
- 首次 browser-owner→server-owner cutover 的 state policy 固定为
  `reset-new-world`：不得假称浏览器存在可用的全局 Node snapshot；用户授权 tuple 必须明确包含
  新 world identity 和 initial state digest。`worldGeneration` 必须来自实际 server-owned
  `WorldSession` 首次 initial commit 后读取的 snapshot，是按 UUID 语法验证但始终按 opaque string
  传递的值；任何 number、常量或重新生成值都拒绝。只有后续 server-owner N→N+1 才允许旧 world
  snapshot migration。
- 外部端口保持 8090；species endpoint 保持服务端 `http://127.0.0.1:8081/v1`，模型名保持 `bird_agent`；8083 不在任何任务的操作范围。
- Phase 5 最终 owner tuple 只有 `runtimeOwner="server"`、`audioOwner="world"`；legacy 维护期间只允许 `audioOwner="legacy"`，不得出现 browser/server 或 world/legacy 的部分切换。
- `flock-runtime` 不申请 GPU；`flock-audio` 是本 release 唯一直接使用 torch/CUDA 的进程；Phase 5 成功后不得并行运行旧 Python GPU 服务。
- worker identity 固定为 `protocolFamily="flock-audio-ipc"`、`protocolVersion=1`、`audioArtifactKind="release-artifact"`；runtime expected tuple 与 worker reported tuple 任一字段不等都必须隔离连接并保持 `/readyz=503`。
- worker identity、Audio WS v1 固定 golden vector、controlled release artifact、Docker `/readyz` identity check、真实 pool/block 的 30 分钟稳定性结果都是 8090 切换硬门禁。
- 模型加载失败、受控 artifact 缺失、外挂 digest 不符、UDS 权限不成立、maintenance secret 缺失、等价 staging 证据缺失均 fail closed；生产路径禁止自动退回 Synth backend。
- worker 每次进程启动产生新 `audioEpoch` 且 `renderFrame=0`；worker restart 只重建音频 epoch，不重建 authoritative world。
- `audio.state.replace` 应用确认前，runtime 不得恢复 incrementals 或向外发布 PCM；确认后还必须
  丢弃 `startFrame < audio.state.applied.renderFrame` 的已排队 master/split block，只能用首个
  post-applied block prime 新 stream。
- 最终音频固定 44,100 Hz、f32le、stereo。pool 5、block 4096、row voices `[bass,pad,lead,pluck,pad]` 是本 release manifest 的验收 geometry，不得散落成 runtime 常量；worker ready 必须回报 geometry，runtime 与 manifest 精确核对。
- 私有 JSON IPC 中所有 u64 frame 字段只允许 canonical 十进制字符串；`bigint` 只存在于 Node
  内存和 binary codec 中，不得直接交给 `JSON.stringify()`。
- 文档、测试说明和代码注释使用中文；协议字段、公开函数和错误码使用本计划冻结的英文名称。
- 每个行为变更严格执行 RED → GREEN → 相关回归 → 三个 entry gate → 单独 commit；Task 12 的删除提交在删除前运行三个 entry gate、删除后运行 `verify:phase6`。不得夹带其它任务。
- Task 12 的最终 `verify:phase6` 必须只生成一次 digest-attested fail-closed recursive active-test
  manifest，并用完全相同的 discovery/exclusion manifest 运行两遍：当前
  `process.execPath` Node（不限制 major）和显式 `npx -y node@20`。两遍都只能排除
  digest-validated retired tests，任一失败都不能签署 Phase 6 deletion gate。

---

## Scope Check

本计划的 worker、PCM、legacy adapter、release 和 cutover 共享同一 epoch、identity、owner 与 rollback
边界，不能拆成相互独立的生产切换。任务仍按 reviewer-sized seam 分开：artifact、worker、DSP、
supervisor、fan-out、legacy、UI、release、acceptance、cutover、Phase 6 gate 与清理。任何 reviewer
可以拒绝一个任务而不要求先接受后续任务。

## Execution Entry Gate

- [ ] **在 Task 1 前验证 Phase 0–4 完整入口**

从 repository root 运行：

```powershell
$requiredBase = '4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9'
$requiredManifestSha = '1ebd697b2e0d0cec8b0cbec008fc884179c6273b97952837f661c2c39f6065ec'
$requiredVendorSha = '21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049'

git merge-base --is-ancestor $requiredBase HEAD
if ($LASTEXITCODE -ne 0) { throw 'HEAD 不是冻结 Phase 0 releaseRevision 的后继' }

$actualManifestSha = (Get-FileHash -Algorithm SHA256 `
  'docs/production-manifests/2026-07-22-production.json').Hash.ToLowerInvariant()
if ($actualManifestSha -ne $requiredManifestSha) {
  throw "production manifest SHA 不匹配: $actualManifestSha"
}

$metadata = Get-Content -Raw -Encoding UTF8 `
  'docs/production-manifests/2026-07-22-metadata.json' | ConvertFrom-Json
if ($metadata.externalRuntimeInputs.vendor.treeSha256 -ne $requiredVendorSha) {
  throw 'Phase 0 vendor tree SHA 不匹配'
}

@(
  'flock-voice-engine/runtime/src/world-session/world-session.js',
  'flock-voice-engine/runtime/src/simulation-runtime.js',
  'flock-voice-engine/runtime/src/audio/null-audio-sink.js',
  'flock-voice-engine/runtime/src/latent/latent-runtime.js',
  'flock-voice-engine/runtime/src/latent/preview-lease.js',
  'flock-voice-engine/runtime/src/agents/gpu-admission.js',
  'flock-voice-engine/runtime/src/api/bootstrap.js',
  'flock-voice-engine/runtime/src/api/runtime-ws.js',
  'flock-voice-engine/runtime/src/protocol/v1.js',
  'flock-voice-engine/runtime/src/control/lease-manager.js',
  'mvp/src/runtime-client.js',
  'mvp/src/pcm-protocol.js',
  'mvp/src/pcm-player.js',
  'flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js'
) | ForEach-Object {
  if (-not (Test-Path -LiteralPath $_)) { throw "Phase 1–4 产物缺失: $_" }
}

npm run verify:phase0
if ($LASTEXITCODE -ne 0) { throw 'Phase 0 gate failed' }
npm run verify:phase12
if ($LASTEXITCODE -ne 0) { throw 'Phase 1–2 gate failed' }
npm run verify:phase34
if ($LASTEXITCODE -ne 0) { throw 'Phase 3–4 gate failed' }
```

Expected: 三个 verify 均 exit 0；Phase 3–4 candidate 仍为
`127.0.0.1:18090`、`runtimeOwner=browser`、`audioOwner=legacy`、
`/readyz=503`、`phaseGate=shadow-no-audio`。

未来 candidate identity 必须由 release builder 在 clean worktree 上读取当前完整
`git rev-parse HEAD`，并计算该 HEAD 的 staged source manifest SHA；任何测试发现
`4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9` 被写入 candidate identity 生成器都必须失败。

## Frozen Interfaces

### Immutable release and worker identity

```js
/**
 * @typedef {object} WorkerIdentity
 * @property {string} releaseRevision
 * @property {string} sourceManifestSha256
 * @property {'flock-audio-ipc'} protocolFamily
 * @property {1} protocolVersion
 * @property {'release-artifact'} audioArtifactKind
 * @property {string} audioArtifactSha256
 */
```

`releaseRevision` 和 `sourceManifestSha256` 来自当前 candidate source，不能来自 entry gate。
worker 从只读 `/release/audio-identity.json` 读取 tuple，并按
`/release/audio-artifact-manifest.json` 重算实际 code/vendor/weights/maps/calibration/audio
asset digest。runtime 必须通过 `readTrustedReleaseManifest()` 自己打开只读
`/release/release-manifest.json`：拒绝 symlink、非 regular file、schema/digest 不符和读取期间
inode/size/mtime 改变，并从这一次受信读取产生 expected tuple。expected identity 不得由 worker
hello、环境变量、CLI 参数或测试 half-pair 注入；测试只能注入 manifest reader。

### Private worker IPC v1

每个 UDS frame 为 `u32be bodyLength + u8 kind + body`。`kind=1` 的 body 是 UTF-8 JSON；
`kind=2` 是 master PCM；`kind=3` 是 legacy pre-mix split PCM。binary body 头固定为：

```text
MAX_JSON_BYTES = 1,048,576
MAX_PCM_BYTES  = 4,194,304
```

decoder 必须在分配 body buffer 前按 kind 检查上限；unknown kind、oversized、EOF partial header
或 EOF partial body 都是 fatal protocol error，并触发 supervisor rebuild。

```text
0  u64le renderFrame
8  u32le frameCount
12 u16le channels
14 u16le format=1
16 payload float32le interleaved
```

控制帧固定为：

```js
worker.hello              // { type, identity }
runtime.identity.accepted // { type, identity }
worker.ready              // { type, identity, audioEpoch, renderFrame:"<u64-decimal>",
                          //   geometry:{sampleRate,blockFrames,poolSize,rowVoices} }
audio.command.batch       // { type, audioEpoch, commandSeq, targetFrame:"<u64-decimal>", commands }
command.accepted          // { type, audioEpoch, commandSeq }
audio.state.applied       // { type, audioEpoch, stateRevision, appliedCommandSeq,
                          //   renderFrame:"<u64-decimal>" }
audio.telemetry           // { type, audioEpoch, appliedCommandSeq,
                          //   renderFrame:"<u64-decimal>", sampleSeq, workerReady, recovering,
                          //   pcmHeadroomBlocks, queueDepth, renderP50Ms, renderP95Ms,
                          //   renderP99Ms, blockDurationMs, recentUnderruns,
                          //   unifiedMemoryFreeBytes:"<u64-decimal>", lateFrames, degraded }
```

`worker.ready` 还必须带
`geometry:{sampleRate,blockFrames,poolSize,rowVoices}`；runtime 与 release manifest 的 geometry
精确比较后才接受。当前 release 的验收值在 manifest 中是
`44100/4096/5/[bass,pad,lead,pluck,pad]`，protocol/queue/player 必须支持测试用 alternate
geometry。

JSON u64 codec 冻结为：

```js
const U64_DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;

encodeU64Decimal(value) // bigint -> canonical decimal string
decodeU64Decimal(value) // canonical decimal string -> bigint
```

decoder 必须拒绝 JSON number、负数、`+1`、前导零、指数、小数、空白和大于 `2^64-1` 的值。
`worker-protocol-u64-golden.json` 是手写双向 golden，Node 与 Python codec 分别读取它；禁止任一
生产 encoder 生成 expected fixture。runtime 在收到 telemetry 时用自己的 monotonic clock 写
`receivedAtMs`，GPU admission 的 freshness 不信任 worker wall clock。

### Audio command ordering and replacement

```js
/**
 * @typedef {object} AudioCommandBatch
 * @property {string} audioEpoch
 * @property {number} commandSeq
 * @property {bigint} targetFrame 内存类型；wire codec 编码为 canonical 十进制字符串
 * @property {object[]} commands
 */

// Same-targetFrame priority:
// 0 state.replace
// 1 note.off / gate.off / preview.allOff
// 2 continuous.set / latent.set / mix.set
// 3 note.on / gate.on / preview.start
// then commandSeq ascending.
```

`state.replace` value 固定包含：

```js
{
  stateRevision,
  world: { worldId, worldGeneration, revision, worldTimeSeconds },
  frameMap: {
    audioEpoch, worldTimeSeconds,
    renderFrame: '<u64-decimal-on-wire>',
    sampleRate: 44100,
  },
  voices: { assignments, activeNotes, activeGates, releases },
  latent: { modes, targets },
  mix: { species, masterGain, mute, solo, eq, reverb },
  audioOwner: 'world',
  voiceMode: 'production',
  deterministicSeed,
  configRevision,
}
```

### Node audio control

```js
createAudioPlanner({ clock, frameClock, enqueueBatch, getAudioState })
// -> { accept(commands), pauseWorldWrites(reason), resumeWorldWrites(),
//      enqueueControl(commands), replace(state), getStatus() }

createWorkerSupervisor({
  connector, trustedReleaseManifest, planner, getAudioState,
  masterPcmPublisher, splitPcmSink, publicStatusStore, clock,
})
// -> { start(), stop(), restart(reason), waitForReady(),
//      rebuildStream(reason), replaceCurrentWorldState(),
//      publishStreamDiscontinuity(reason), getStatus() }

createPcmRing({ historyMs, sampleRate, blockFrames })
// -> { publish(block), liveCursor(), subscribe(), get(blockSeq) }
```

`AudioPlanner` 实现 Phase 1–4 `audioSink.accept(commands)`；`SimulationRuntime`、`LatentRuntime` 和
`PreviewLease` 继续使用同一个 sink，不另建音频状态源。

### Public runtime audio status

bootstrap 的 `audioStatus` 与 Runtime WS 的 `audio.status` frame 使用同一 frozen DTO：

```js
{
  type: 'audio.status',       // bootstrap.audioStatus 省略 type
  statusRevision,            // u32，严格递增
  runtimeOwner: 'browser' | 'server',
  audioOwner: 'legacy' | 'world',
  workerReady,               // identity + geometry + state applied + post-applied PCM prime 全成立
  recovering,
  degraded,
  degradedReason,
  audio: {
    audioEpoch,
    manifestGeometrySha256,
    sampleRate,
    blockFrames,
    channels: 2,
    format: 'f32le',
    binaryHeaderVersion: 1,
    headerBytes: 32,
  },
}
```

`WorldSession` 拥有唯一 `PublicAudioStatusStore`。supervisor/owner transition 只能通过
`WorldSession.runExclusive()` 更新它；bootstrap 在同一 mailbox 快照 world 与 audio status，
Runtime WS 按 `statusRevision` 广播。重连先取 bootstrap，随后只接受更大的 status revision；
旧 revision、未知 owner 或缺 geometry 一律 fail closed。浏览器不得从 query、localStorage 或
本地 owner flag 推断这些字段。

### Public Audio WS v1

固定 32-byte little-endian header：

```text
0 "FLK1"  4 u8 version=1  5 u8 flags=0  6 u16 headerBytes=32
8 u32 streamRevision      12 u32 blockSeq
16 u64 startFrame         24 u32 frameCount
28 u16 channels=2         30 u16 format=1
```

固定 48-byte golden hex：

```text
464c4b3101002000020000000300000008070605040302010200000002000100
000000000000003f000000bf0000803f
```

它表示 `streamRevision=2`、`blockSeq=3`、
`startFrame=0x0102030405060708`、`frameCount=2`、
samples `[0.0,0.5,-0.5,1.0]`。server encoder 与 browser parser 必须分别对同一文本 fixture
验证，禁止测试调用生产 encoder 生成 expected bytes。

Audio WS 第一帧固定为：

```js
{
  type: 'audio.ready',
  audioEpoch,
  manifestGeometrySha256,
  sampleRate,
  channels: 2,
  format: 'f32le',
  blockFrames,
  streamRevision,
  resumeBlockSeq,
  resumeStartFrame: '<u64-decimal>',
  binaryHeaderVersion: 1,
  headerBytes: 32,
}
```

下一 binary frame 必须精确匹配 `resumeBlockSeq/resumeStartFrame`。单客户端跳 live edge 发送
`{type:"audio.discontinuity",scope:"client",audioEpoch,streamRevision,resumeBlockSeq,resumeStartFrame:"<u64-decimal>"}`；
worker/global stream rebuild 发送同形的 `scope:"stream"` frame 并增加 `streamRevision`。

### Legacy ownership

```js
createLeaseManager({ clock, tokenFactory, defaultTtlMs, maxTtlMs })
// Phase 4 existing API:
// -> { take({resource,clientId,connectionGeneration,ttlMs}),
//      heartbeat({resource,clientId,connectionGeneration,leaseToken}),
//      release({resource,clientId,connectionGeneration,leaseToken}),
//      disconnect({clientId,connectionGeneration}), expire(nowMs),
//      get(resource), getPublicState(resource) }

createAudioOwnerController({
  controlBarrier, leaseManager, decoderSessions,
})
// -> { takeLegacy(request), heartbeat(request), releaseLegacy(request),
//      decoderDisconnected(decoderSessionId), getStatus() }

createAudioControlBarrier({
  session, planner, supervisor, publicStatusStore, ownerTransitionMutex,
  decoderSessions, getWorldAudioState,
})
// -> { enterLegacy({reason,decoderSessionId}), restoreWorld(reason) }
```

`audioOwner` 默认 world。decoder 首帧是只读
`{type:"legacy.session",decoderSessionId}`；只有 maintenance-authenticated Runtime client
可以 take `resource="legacy-audio"` 并把 lease 绑定该 exact decoder socket generation。

## File Responsibility Map

```text
flock-voice-engine/
  release/
    release-manifest.schema.json         双镜像和 expected worker identity
    audio-artifact-manifest.schema.json  worker 可重算内容 inventory
    audio-inputs.schema.json             外挂受控输入 fail-closed contract
    acceptance.schema.json               staging 性能/稳定性证据
    machine-attestation.schema.json      外部可验证 host identity
    phase6-policy.json                   Phase 6 最小观察窗和升级次数
    phase6-test-migration.schema.json    test→replacement machine contract
    phase6-test-migration.json           every retired test 的 coverage ledger
    phase6-source-retirement.schema.json exhaustive source retirement contract
    phase6-source-retirement.json        retired/retained exact-path ledger
  tools/
    build_release_artifact.py            clean HEAD source/artifact/release manifests
    stress_audio_worker.py               fake/real worker 压力
    capture_machine_attestation.py       直接采集 stable machine identity
    validate_phase5_acceptance.py        real acceptance artifact gate
    python_import_graph.py               Python AST import edge extractor
    render_cutover_docs.py               从 cutover record 更新受管文档块
  server/
    backend_factory.py                    永久 backend factory；legacy app 与 worker 共用
  server/audio_worker/
    identity.py                          自身 identity 与 artifact 重算
    framing.py                           私有 length-prefixed IPC
    command_queue.py                     continuous coalesce + reliable edges
    pcm_ring.py                          render 非阻塞写入的 bounded master/split rings
    telemetry_queue.py                   bounded/coalesced telemetry 与 latched degraded
    render_state.py                      render-thread-owned state/replace
    model_host.py                        唯一 backend/VoicePool/model load
    jungle.py                            deterministic Jungle 规划
    texture.py                           sample/granular fallback
    mixer.py                             species mix/EQ/reverb/master/ambience
    render_loop.py                       drain→forward→mix→publish 与 telemetry
    ipc_server.py                        单 runtime UDS server
    __main__.py                          worker process entry
  runtime/src/audio/
    release-manifest.js                  受信 expected identity/geometry reader
    worker-identity.js                   expected/reported exact comparison
    worker-protocol.js                   private IPC codec
    discarding-split-sink.js             Task 4 起持续 drain 的 pre-legacy sink
    frame-clock.js                       world time→targetFrame mapping
    audio-state-projector.js             complete state.replace DTO
    audio-planner.js                     intent batching and command order
    audio-control-barrier.js             pause-independent reliable owner barrier
    split-ring.js                        private bounded legacy pre-mix history
    worker-supervisor.js                 handshake/restart/replace barrier
    pcm-v1.js                            public FLK1 encoder
    pcm-ring.js                          one bounded live ring
    audio-client-writer.js               per-client egress and live-edge skip
    public-audio-status.js               mailbox-owned bootstrap/WS DTO
  runtime/src/legacy/
    decoder-session-registry.js          exact socket-generation identity
    decoder-adapter.js                   legacy command translation
    audio-owner.js                       world/legacy transition state machine
  runtime/src/control/
    lease-manager.js                     shared latent/preview/legacy lease core
    maintenance-auth.js                  secret-file authentication
  runtime/src/api/audio-ws.js             `/api/v1/audio`
  runtime/src/api/legacy-routes.js         `/decoder` and legacy HTTP
  runtime/tools/
    build-production-graph.mjs           HTML/Node/Python/asset 多根依赖图
    legacy-lease.mjs                     operator-side maintenance client
    soak-phase5.mjs                      four-client/slow-client acceptance
    verify-stability-window.mjs          Phase 6 release-cycle gate
    verify-phase6-migration.mjs          import graph + ledger deletion verifier
  runtime/tools/lib/
    production-graph.mjs                 strict multi-language graph implementation
  deploy/
    Dockerfile.runtime                   CPU-only gateway
    Dockerfile.audio                     sole GPU worker
    release.sh                           local build/stage and authorized cutover
    import-release.sh                    transferred digest-checked bootstrap
    verify-candidate.sh                  `/readyz` + exact identity
    requirements-audio.lock              pinned/hash-checked Python dependencies

mvp/
  src/view-app.js                         owner-neutral snapshot renderer seam
  src/server-main.js                      production pure-view composition
  src/view-config.js                      renderer-only config projection
  src/view-sequence.js                    renderer-only geometry helpers
  src/pcm-protocol.js                     independent FLK1 parser
  src/pcm-player.js                       Audio WS lifecycle/ring prime
  src/pcm-player-worklet.js               final stereo playback only
```

### Task 1: Controlled release artifact and immutable identity

**Files:**
- Create: `flock-voice-engine/release/release-manifest.schema.json`
- Create: `flock-voice-engine/release/audio-artifact-manifest.schema.json`
- Create: `flock-voice-engine/release/audio-inputs.schema.json`
- Create: `flock-voice-engine/tools/build_release_artifact.py`
- Create: `flock-voice-engine/tests/fixtures/release-inputs/audio-inputs.json`
- Create: `flock-voice-engine/tests/fixtures/release-inputs/vendor/file.py`
- Create: `flock-voice-engine/tests/fixtures/release-inputs/weights/model.bin`
- Create: `flock-voice-engine/tests/test_release_artifact.py`
- Create: `flock-voice-engine/runtime/src/audio/release-manifest.js`
- Create: `flock-voice-engine/runtime/src/audio/worker-identity.js`
- Create: `flock-voice-engine/runtime/test/audio/release-manifest.test.js`
- Create: `flock-voice-engine/runtime/test/audio/worker-identity.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: current clean Git HEAD; validated `audio-inputs.json`; actual worker code, controlled vendor,
  weights, voice maps, calibration and audio assets; controlled
  `baseImages.runtime={repository,digest}` and `baseImages.audio={repository,digest}`.
- Produces: `build_release(repo_root, inputs_path, output_dir) -> dict`;
  `verify_audio_artifact(identity_path, manifest_path) -> WorkerIdentity`;
  `readTrustedReleaseManifest({path,digestPath,fdReader}) -> Promise<TrustedReleaseManifest>`;
  `compareWorkerIdentity(expected, reported) -> {ok:boolean,reason:string|null}`;
  `assertExactWorkerIdentity(expected, reported)`.

- [ ] **Step 1: Write failing artifact and mismatch tests**

```python
def test_release_revision_comes_from_git_head(fake_repo, valid_inputs, out_dir):
    REQUIRED_PHASE0_ENTRY_REVISION = "4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9"
    head = commit_file(fake_repo, "candidate.txt", "phase5")
    result = build_release(fake_repo, valid_inputs, out_dir)
    assert result["releaseRevision"] == head
    assert result["releaseRevision"] != REQUIRED_PHASE0_ENTRY_REVISION

def test_uncontrolled_vendor_fails_closed(fake_repo, valid_inputs, out_dir):
    data = json.loads(valid_inputs.read_text("utf-8"))
    data["vendor"]["provenanceKind"] = "vendor-tree"
    valid_inputs.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ReleaseBuildError, match="UNCONTROLLED_VENDOR"):
        build_release(fake_repo, valid_inputs, out_dir)

def test_tampered_weight_rejects_worker_identity(release_dir):
    (release_dir / "mounts/weights/model.bin").write_bytes(b"tampered")
    with pytest.raises(IdentityError, match="AUDIO_ARTIFACT_DIGEST_MISMATCH"):
        verify_audio_artifact(
            release_dir / "audio-identity.json",
            release_dir / "audio-artifact-manifest.json",
        )

def test_base_images_require_exact_sha256_digests(fake_repo, valid_inputs, out_dir):
    data = json.loads(valid_inputs.read_text("utf-8"))
    data["baseImages"]["runtime"]["digest"] = "latest"
    valid_inputs.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ReleaseBuildError, match="BASE_IMAGE_DIGEST_INVALID"):
        build_release(fake_repo, valid_inputs, out_dir)
```

```js
test('expected worker identity comes only from one trusted manifest read', async () => {
  const trusted = await readTrustedReleaseManifest({
    path: fixturePath,
    digestPath: fixtureDigestPath,
  });
  assert.deepEqual(trusted.workerIdentity, EXPECTED);
  await assert.rejects(
    readTrustedReleaseManifest({ path: symlinkPath, digestPath: fixtureDigestPath }),
    /RELEASE_MANIFEST_UNTRUSTED_PATH/,
  );
});

test('one identity field mismatch is isolated with a stable reason', () => {
  const result = compareWorkerIdentity(expected, {
    ...expected, audioArtifactSha256: '0'.repeat(64),
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'WORKER_IDENTITY_AUDIO_ARTIFACT_MISMATCH',
  });
});
```

加入 source manifest 稳定排序、dirty tracked tree、缺 input、错误 byte count、symlink、重复 logical
path、OCI digest 缺失、voice map/calibration/Amen/forest ambience 未入 inventory，以及
expected/reported 每个字段的独立 mismatch。trusted reader 另覆盖非 regular file、schema 错、
digest 错、读取期间 inode/size/mtime 漂移，以及试图从 env/worker hello/CLI 覆盖 expected tuple；
这些输入全部返回稳定 fail-closed reason。

- [ ] **Step 2: Run RED**

```powershell
python -m pytest flock-voice-engine/tests/test_release_artifact.py -q
node --test flock-voice-engine/runtime/test/audio/worker-identity.test.js
```

Expected: Python FAIL with missing `build_release_artifact.py`；Node FAIL with
`ERR_MODULE_NOT_FOUND` for `worker-identity.js`。

- [ ] **Step 3: Implement canonical manifests and fail-closed input validation**

```python
@dataclass(frozen=True)
class ArtifactEntry:
    logical_path: str
    mount_path: str
    byte_count: int
    sha256: str
    kind: str

def canonical_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")

def manifest_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()

def candidate_revision(repo_root: Path) -> str:
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=repo_root, text=True
    ).strip()
    if re.fullmatch(r"[0-9a-f]{40}", revision) is None:
        raise ReleaseBuildError("CANDIDATE_REVISION_INVALID")
    return revision
```

`audio-inputs.schema.json` 只接受 `provenanceKind="controlled-artifact"`，并要求 vendor artifact
SHA、tree SHA、每个 weight/model/voice map/calibration/audio asset 的 absolute staging path、
byte count 和 SHA-256。它还把两个基础镜像作为受控输入：`baseImages.runtime` 与
`baseImages.audio` 均必须含不可变 repository 和 `sha256:<64 hex>` digest；缺字段、tag、
短 digest 或非 `sha256` 值一律 `BASE_IMAGE_DIGEST_INVALID`，不得联网解析 tag。真实输入固定放在
`.artifacts/phase5-inputs/audio-inputs.json`；文件缺失时 builder 返回
`AUDIO_INPUTS_MISSING`，不尝试访问生产或猜路径。

builder 生成：

```text
.artifacts/phase5-local/source-manifest.json
.artifacts/phase5-local/audio-artifact-manifest.json
.artifacts/phase5-local/audio-identity.json
.artifacts/phase5-local/release-manifest.json
```

`audioArtifactSha256` 是 canonical `audio-artifact-manifest.json` 的 SHA-256；
`sourceManifestSha256` 是当前 HEAD tracked source inventory 的 SHA-256。release manifest
另外记录受控基础镜像 digest 与构建所得 runtime/audio OCI image digest，避免把可变 tag 当 identity。
`manifestGeometrySha256=SHA256(canonical_json(releaseManifest.geometry))`，是 public status 与
Audio WS ready 使用的唯一 geometry identity。

`readTrustedReleaseManifest()` 在 Linux production 对 manifest 与其 `.sha256` sidecar 都使用
`O_RDONLY|O_NOFOLLOW` 各打开一次，open 前后均不按路径重读；对 fd 做 `fstat`，只接受 owner
UID 为 0 或 runtime effective UID、且非 group/world-writable 的 regular file，读完再次 `fstat`
并核对 inode/size/mtime 未变。
sidecar 必须引用 exact basename `release-manifest.json`。随后验证 schema、canonical SHA-256 和
`workerIdentity/geometry/imageIdentity`。单元测试通过注入只实现相同 fd 契约的 reader 覆盖 Windows，
但 production composition 不允许注入 reader 或 expected identity。

```js
export function compareWorkerIdentity(expected, reported) {
  const fields = [
    ['releaseRevision', 'WORKER_IDENTITY_RELEASE_MISMATCH'],
    ['sourceManifestSha256', 'WORKER_IDENTITY_SOURCE_MANIFEST_MISMATCH'],
    ['protocolFamily', 'WORKER_IDENTITY_PROTOCOL_FAMILY_MISMATCH'],
    ['protocolVersion', 'WORKER_IDENTITY_PROTOCOL_VERSION_MISMATCH'],
    ['audioArtifactKind', 'WORKER_IDENTITY_ARTIFACT_KIND_MISMATCH'],
    ['audioArtifactSha256', 'WORKER_IDENTITY_AUDIO_ARTIFACT_MISMATCH'],
  ];
  for (const [field, reason] of fields) {
    if (reported?.[field] !== expected?.[field]) return { ok: false, reason };
  }
  return { ok: true, reason: null };
}

export function assertExactWorkerIdentity(expected, reported) {
  const result = compareWorkerIdentity(expected, reported);
  if (!result.ok) throw new Error(result.reason);
}
```

- [ ] **Step 4: Run GREEN and entry regressions**

```powershell
python -m pytest flock-voice-engine/tests/test_release_artifact.py -q
node --test flock-voice-engine/runtime/test/audio/release-manifest.test.js flock-voice-engine/runtime/test/audio/worker-identity.test.js
npm run verify:phase0
npm run verify:phase12
npm run verify:phase34
```

Expected: all commands exit 0。真实 `.artifacts/phase5-inputs/audio-inputs.json` 不存在时，
`python flock-voice-engine/tools/build_release_artifact.py --inputs .artifacts/phase5-inputs/audio-inputs.json --output .artifacts/phase5-local`
必须 exit 2 并打印 `AUDIO_INPUTS_MISSING`；这是一项显式外部输入阻塞，不允许降低校验。

- [ ] **Step 5: Commit**

```powershell
git add flock-voice-engine/release flock-voice-engine/tools/build_release_artifact.py flock-voice-engine/tests/test_release_artifact.py flock-voice-engine/tests/fixtures/release-inputs flock-voice-engine/runtime/src/audio/release-manifest.js flock-voice-engine/runtime/src/audio/worker-identity.js flock-voice-engine/runtime/test/audio/release-manifest.test.js flock-voice-engine/runtime/test/audio/worker-identity.test.js package.json
git commit -m "feat(release): build controlled audio artifacts"
```

**Rollback:** revert 本提交；candidate 仍是 Phase 3–4 shadow，生产不变。

### Task 2: Singleton Python worker, UDS protocol, queues, and frame ordering

**Files:**
- Create: `flock-voice-engine/server/backend_factory.py`
- Create: `flock-voice-engine/server/audio_worker/__init__.py`
- Create: `flock-voice-engine/server/audio_worker/__main__.py`
- Create: `flock-voice-engine/server/audio_worker/identity.py`
- Create: `flock-voice-engine/server/audio_worker/framing.py`
- Create: `flock-voice-engine/server/audio_worker/command_queue.py`
- Create: `flock-voice-engine/server/audio_worker/pcm_ring.py`
- Create: `flock-voice-engine/server/audio_worker/telemetry_queue.py`
- Create: `flock-voice-engine/server/audio_worker/render_state.py`
- Create: `flock-voice-engine/server/audio_worker/model_host.py`
- Create: `flock-voice-engine/server/audio_worker/render_loop.py`
- Create: `flock-voice-engine/server/audio_worker/ipc_server.py`
- Create: `flock-voice-engine/tests/test_audio_worker_identity.py`
- Create: `flock-voice-engine/tests/test_audio_worker_framing.py`
- Create: `flock-voice-engine/tests/test_audio_worker_queue.py`
- Create: `flock-voice-engine/tests/test_audio_worker_pcm_ring.py`
- Create: `flock-voice-engine/tests/test_audio_worker_telemetry.py`
- Create: `flock-voice-engine/tests/test_audio_worker_lifecycle.py`
- Create: `flock-voice-engine/tests/test_audio_worker_render.py`
- Create: `flock-voice-engine/tests/test_audio_worker_import_graph.py`
- Create: `flock-voice-engine/tests/test_backend_factory.py`
- Create: `flock-voice-engine/tests/fixtures/worker-protocol-u64-golden.json`
- Create: `flock-voice-engine/tools/python_import_graph.py`
- Modify: `flock-voice-engine/server/app.py`

**Interfaces:**
- Consumes: Task 1 `audio-identity.json` and `audio-artifact-manifest.json`; existing
  backend selection semantics, `VoicePool`, `MultiVoiceBraveBackend`.
- Produces: `load_worker_identity(identity_path, artifact_manifest_path) -> WorkerIdentity`;
  `encode_frame(kind, body) -> bytes`; `FrameDecoder.feed(data) -> list[Frame]`;
  `encode_u64_decimal(value:int) -> str`; `decode_u64_decimal(value:object) -> int`;
  permanent `make_backend(config)` from `server.backend_factory`;
  atomic `CommandQueues.enqueue(batch) -> Accepted`; `RenderState.apply_due(render_frame)`;
  `WorkerPcmRings.try_publish(master,split,render_frame) -> PublishResult`;
  `TelemetryQueue.offer(sample)`; `ModelHost.load_once()`; `AudioWorker.run()`.

- [ ] **Step 1: Write failing identity, framing, singleton, queue, and render tests**

`worker-protocol-u64-golden.json` 必须手写为：

```json
[
  {"value":"0","wire":"0"},
  {"value":"1","wire":"1"},
  {"value":"4294967296","wire":"4294967296"},
  {"value":"72623859790382856","wire":"72623859790382856"},
  {"value":"18446744073709551615","wire":"18446744073709551615"}
]
```

```python
def test_reconnects_load_model_once(worker, connector, fake_backend_factory):
    for _ in range(20):
        with connector(worker.socket_path) as client:
            client.accept_identity(worker.identity)
            assert client.recv_json()["type"] == "worker.ready"
    assert fake_backend_factory.load_count == 1
    assert worker.model_host.voice_pool_count == 1

def test_same_frame_has_fixed_priority(queues, epoch):
    # Admission order remains strictly increasing; only command priority is reversed.
    queues.enqueue(batch(epoch, 6, 4096, [{"type": "note.on"}]))
    queues.enqueue(batch(epoch, 7, 4096, [{"type": "continuous.set"}]))
    queues.enqueue(batch(epoch, 8, 4096, [{"type": "note.off"}]))
    queues.enqueue(batch(epoch, 9, 4096, [{"type": "state.replace"}]))
    assert [item.command["type"] for item in queues.drain_due(4096)] == [
        "state.replace", "note.off", "continuous.set", "note.on",
    ]

def test_mixed_batch_reservation_is_all_or_none(queues, epoch):
    fill_reliable_queue(queues, remaining=1)
    before = queues.snapshot()
    result = queues.enqueue(batch(epoch, 10, 4096, [
        {"type": "continuous.set"}, {"type": "gate.on"}, {"type": "note.on"},
    ]))
    assert result.code == "RELIABLE_EDGE_OVERFLOW"
    assert queues.snapshot() == before

def test_reliable_edge_overflow_never_drops(queues, epoch):
    for seq in range(1, 258):
        result = queues.enqueue(batch(epoch, seq, 0, [{"type": "gate.on"}]))
    assert result.code == "RELIABLE_EDGE_OVERFLOW"
    assert queues.degraded is True
    assert queues.rebuild_required is True

def test_blocked_uds_writer_never_blocks_render(render_loop, blocked_writer):
    for _ in range(20):
        render_loop.render_one_block()
    assert render_loop.rendered_blocks == 20
    assert render_loop.status.degraded is True
    assert render_loop.status.degraded_reason == "WORKER_PCM_RING_OVERFLOW"

def test_oversized_length_is_rejected_before_allocation():
    decoder = FrameDecoder(max_json_bytes=1_048_576, max_pcm_bytes=4_194_304)
    with pytest.raises(FrameError, match="IPC_FRAME_TOO_LARGE"):
        decoder.feed(struct.pack(">I", 0xFFFFFFFF) + bytes([FrameKind.JSON]))

def test_python_u64_codec_matches_handwritten_golden():
    for case in load_json("worker-protocol-u64-golden.json"):
        assert encode_u64_decimal(int(case["value"])) == case["wire"]
        assert decode_u64_decimal(case["wire"]) == int(case["value"])

def test_worker_import_graph_never_depends_on_legacy_app():
    graph = python_import_graph("flock-voice-engine/server/audio_worker/__main__.py")
    assert "flock-voice-engine/server/app.py" not in graph
    assert "flock-voice-engine/server/backend_factory.py" in graph
```

加入旧 epoch、重复/倒序 `commandSeq`、continuous 按 `(worldId,voice,param)` coalesce、
accepted/applied 分离、late continuous、late note 的 `lateFrames`、expired preview、old
state.replace queue 清空、单 runtime connection、断线不重载模型、render thread 不执行 socket I/O；
framing 还覆盖 oversized JSON/PCM、逐 byte partial frame、EOF truncated header/body、连续多帧和
恶意 length 不触发按声明长度分配。u64 codec 逐项拒绝 JSON number、负数、前导零、指数、小数、
空白和 overflow；queue 对 mixed continuous/edge batch 必须先完成 schema、seq 和两类容量预留，
失败时两个 queue 与 coalesce map 均保持 byte-for-byte 不变。

- [ ] **Step 2: Run RED**

```powershell
python -m pytest `
  flock-voice-engine/tests/test_audio_worker_identity.py `
  flock-voice-engine/tests/test_audio_worker_framing.py `
  flock-voice-engine/tests/test_audio_worker_queue.py `
  flock-voice-engine/tests/test_audio_worker_pcm_ring.py `
  flock-voice-engine/tests/test_audio_worker_telemetry.py `
  flock-voice-engine/tests/test_audio_worker_lifecycle.py `
  flock-voice-engine/tests/test_audio_worker_render.py `
  flock-voice-engine/tests/test_audio_worker_import_graph.py `
  flock-voice-engine/tests/test_backend_factory.py -q
```

Expected: FAIL during collection because `server.audio_worker` does not exist。

- [ ] **Step 3: Implement exact UDS and queue contracts**

```python
class FrameKind(IntEnum):
    JSON = 1
    PCM_MASTER = 2
    PCM_SPLIT = 3

MAX_JSON_BYTES = 1_048_576
MAX_PCM_BYTES = 4_194_304

COMMAND_PRIORITY = {
    "state.replace": 0,
    "note.off": 1, "gate.off": 1, "preview.allOff": 1,
    "continuous.set": 2, "latent.set": 2, "mix.set": 2,
    "note.on": 3, "gate.on": 3, "preview.start": 3,
}

def command_sort_key(item: QueuedCommand) -> tuple[int, int]:
    return (COMMAND_PRIORITY[item.command["type"]], item.command_seq)
```

`CommandQueues.enqueue()` 先在临时 plan 中完成整批 schema/u64/epoch/严格递增 seq 校验、continuous
coalesce delta 和 reliable slot 计数；只有两类容量都足够时才一次性 commit plan。任何错误都不更新
last seq、queue、coalesce map 或 accepted telemetry。`targetFrame` 在 JSON boundary 由上述 codec
解为 Python `int`，发送 ACK/telemetry 时再编码为 canonical decimal string。

先把当前 `server/app.py` 的 `make_backend(config)` 与 backend 选择逻辑原样抽到永久模块
`server/backend_factory.py`，`app.py` 改为 import/re-export 它，worker 只 import 永久模块。
`test_backend_factory.py` 对 legacy app 与新 factory 的 backend id/config/error 做 characterization；
`test_audio_worker_import_graph.py` 用 Python `ast.Import/ImportFrom` 从
`server.audio_worker.__main__` 递归解析仓库内 imports，遇到 unresolved relative import、动态
production import 或 `server.app` 即 fail closed。这样 Phase 6 删除 `app.py` 不会切断 worker。

UDS 固定 `/run/flock-audio/audio.sock`，目录 mode `0770`、socket mode `0660`，runtime/audio
容器使用同一 numeric UID/GID。若目录不是 shared writable mount、owner/mode 不符或存在非 socket
文件，worker exit 2 并打印 `AUDIO_SOCKET_PREFLIGHT_FAILED`；禁止自动改用 TCP。

worker 启动顺序固定：

```python
identity = load_worker_identity(
    Path("/release/audio-identity.json"),
    Path("/release/audio-artifact-manifest.json"),
)
server = IpcServer("/run/flock-audio/audio.sock", identity)
server.listen_without_loading_model()
# send worker.hello; wait for exact runtime.identity.accepted
model_host.load_once()
render_loop.start(audio_epoch=str(uuid.uuid4()), render_frame=0)
server.send_worker_ready()
```

生产 `model_host.load_once()` 调 `make_backend()` 后必须断言 backend id 是 `brave-voices`，
并把实际 pool/block/rows 与 Task 1 release manifest 的 geometry 精确比较；当前 release
manifest 恰为 pool 5/block 4096，不能在 worker code 重复写死。任何 exception 直接
worker-not-ready，不调用 Synth。fake/synth 只通过测试构造参数显式注入。

continuous queue 最大 512 个 coalesced key；reliable edge queue 最大 256；overflow 设置
`degraded/rebuild_required` 并拒绝该 batch。render loop 每 block 固定执行
drain → apply → backend forward → server mix → master/split ring `try_publish` → telemetry
`offer`。master/split worker rings 各严格有界 8 blocks；render thread 的两个写入都是同步
nonblocking memory operations，不执行 UDS send。独立 I/O writer 从 rings 取块；connection lag
或 ring overflow 锁存 `WORKER_PCM_RING_OVERFLOW`、停止发布后续全局块并通过 bounded telemetry
queue 的 latched degraded frame 通知 supervisor 做 stream rebuild，不能覆盖或静默跳过全局块。
telemetry queue 容量 128，普通样本可 coalesce 为最新值，latched degraded 直到 writer 确认发送
才清除。每个 telemetry sample 必须包含 workerReady、recovering、PCM headroom、queue depth、
render p50/p95/p99、block duration、recent underruns、统一内存余量和 degraded；缺失/NaN 不得发送
“健康”样本。`FrameDecoder` 先按 kind 比对上述最大长度，再分配 body buffer。

- [ ] **Step 4: Run GREEN and legacy backend regression**

```powershell
python -m pytest flock-voice-engine/tests/test_audio_worker_*.py flock-voice-engine/tests/test_backend_factory.py -q
python -m pytest flock-voice-engine/tests/test_streaming_consistency.py flock-voice-engine/tests/test_smoke_contracts.py -q
npm run verify:phase0
npm run verify:phase12
npm run verify:phase34
```

Expected: all PASS；fake worker reconnect 20 次只 load 一次，现有 streaming consistency 无回归。

- [ ] **Step 5: Commit**

```powershell
git add flock-voice-engine/server/backend_factory.py flock-voice-engine/server/app.py flock-voice-engine/server/audio_worker flock-voice-engine/tests/test_audio_worker_identity.py flock-voice-engine/tests/test_audio_worker_framing.py flock-voice-engine/tests/test_audio_worker_queue.py flock-voice-engine/tests/test_audio_worker_pcm_ring.py flock-voice-engine/tests/test_audio_worker_telemetry.py flock-voice-engine/tests/test_audio_worker_lifecycle.py flock-voice-engine/tests/test_audio_worker_render.py flock-voice-engine/tests/test_audio_worker_import_graph.py flock-voice-engine/tests/test_backend_factory.py flock-voice-engine/tests/fixtures/worker-protocol-u64-golden.json flock-voice-engine/tools/python_import_graph.py
git commit -m "feat(audio): add singleton worker runtime"
```

**Rollback:** revert；Phase 3–4 继续使用 `NullAudioSink`，worker 未接生产。

### Task 3: Server-owned DSP, texture/Jungle, ambience, and split tap

**Files:**
- Create: `flock-voice-engine/server/audio_worker/jungle.py`
- Create: `flock-voice-engine/server/audio_worker/texture.py`
- Create: `flock-voice-engine/server/audio_worker/mixer.py`
- Create: `flock-voice-engine/tests/fixtures/jungle_v1.json`
- Create: `mvp/tools/export-jungle-fixture.mjs`
- Create: `flock-voice-engine/tests/test_audio_worker_jungle.py`
- Create: `flock-voice-engine/tests/test_audio_worker_texture.py`
- Create: `flock-voice-engine/tests/test_audio_worker_mixer.py`
- Create: `flock-voice-engine/tests/test_audio_worker_split.py`
- Modify: `flock-voice-engine/server/audio_worker/render_loop.py`
- Modify: `flock-voice-engine/server/audio_worker/render_state.py`
- Modify: `flock-voice-engine/server/audio_worker/model_host.py`

**Interfaces:**
- Consumes: current `mvp/src/jungle.js`, `mvp/src/audio.js`, `mvp/src/config.js`,
  `mvp/assets/audio/amen/cw_amen_jungle.wav`,
  `mvp/assets/audio/ambience/forest-soundreality-537925.mp3`, worker rows from Task 2.
- Produces: `jungle_edit_plan()`, `jungle_slice_for_cell()`, `jungle_grain_plan()`;
  `TextureRenderer.render(event, frames) -> np.ndarray`;
  `ServerMixer.process(stems, state) -> tuple[np.ndarray,np.ndarray]`;
  master `PCM_MASTER` and same-frame pre-mix `PCM_SPLIT`.

- [ ] **Step 1: Freeze cross-language fixtures and write failing DSP tests**

`mvp/tools/export-jungle-fixture.mjs` imports only the existing pure functions and writes a stable JSON
array for 16 steps × 5 pitch branches plus repeat/reverse/dropout/filter/crush/dub cases. The checked-in
fixture is generated once with:

```powershell
node mvp/tools/export-jungle-fixture.mjs > flock-voice-engine/tests/fixtures/jungle_v1.json
```

```python
@pytest.mark.parametrize("case", load_cases("jungle_v1.json"))
def test_python_jungle_matches_frozen_browser_case(case):
    assert jungle_slice_for_cell(**case["input"]) == case["slice"]
    assert jungle_grain_plan(case["slice"], **case["grainOptions"]) == case["grains"]

def test_master_is_interleaved_stereo_and_split_is_premix(mixer, five_stems):
    # current-release manifest fixture: blockFrames=4096, poolSize=5
    master, split = mixer.process(five_stems, MIX_STATE)
    assert master.shape == (4096, 2)
    assert master.dtype == np.float32
    assert split.shape == (4096, 5)
    assert not np.array_equal(master[:, 0], split[:, 0])

def test_mixer_uses_alternate_manifest_geometry(alternate_mixer, three_stems):
    master, split = alternate_mixer.process(three_stems, MIX_STATE)
    assert master.shape == (2048, 2)
    assert split.shape == (2048, 3)
```

加入相同 seed 可重复、Amen/forest decode preflight、pitch 只改颗粒内移调、输出占满双速 step、
四 species 非静音、mute/solo、三段 EQ、reverb send、master gain、peak limit、state.replace 后 DSP
state 重建、split 不含 master/EQ/reverb、最终 master 不携带 split channels。

- [ ] **Step 2: Run RED**

```powershell
python -m pytest `
  flock-voice-engine/tests/test_audio_worker_jungle.py `
  flock-voice-engine/tests/test_audio_worker_texture.py `
  flock-voice-engine/tests/test_audio_worker_mixer.py `
  flock-voice-engine/tests/test_audio_worker_split.py -q
```

Expected: FAIL with missing `jungle.py`、`texture.py` and `mixer.py`。

- [ ] **Step 3: Implement deterministic sample rendering and final server master**

```python
JUNGLE_PITCH_SEMITONES = (-7, -3, 0, 3, 7)
AMEN_TRANSIENT_STEPS = (0, 2, 4, 6, 7, 8, 10, 12, 14, 15, 16, 18, 20, 22, 24, 28)

def reverse_amen_offset(duration: float, forward_offset: float, source_duration: float) -> float:
    total = max(0.001, float(duration))
    end = (float(forward_offset) + max(0.0, float(source_duration))) % total
    return (total - end) % total
```

`TextureRenderer` 在 worker load 时用 soundfile 解码已校验 digest 的 Amen WAV 和 forest MP3；
decode 失败使 worker 不 ready。granular RNG 只来自 state.replace 的 deterministic seed 和
event identity。forest ambience 作为 server master 的循环底层，gain 固定沿用当前 0.11，
instrument pause 只淡出 instrument bus。

`ServerMixer` 使用每 species 持久 biquad state、deterministic impulse-response convolution、
species gain/mute/solo/reverb send 和 master limiter。数值验收固定：silence max abs
`<=1e-7`、master peak `<=1.0`、无 NaN/Infinity、同 state/seed 输入逐样本绝对误差
`<=1e-6`。WebAudio 与 Python 不宣称 bit-identical；听感签核记录在 Task 9 acceptance。

render loop 每 block 始终发布最终 stereo master；同时按 release manifest 的 `poolSize`
发布 pre-mix split frame（当前 release 为 5-channel），Node 只允许 legacy adapter 消费 kind 3，
`/api/v1/audio` 只接 kind 2。

- [ ] **Step 4: Run GREEN and browser-oracle regressions**

```powershell
python -m pytest flock-voice-engine/tests/test_audio_worker_*.py -q
node --test mvp/test/jungle.test.js mvp/test/audio.test.js
npm run verify:phase0
npm run verify:phase12
npm run verify:phase34
```

Expected: all PASS；fixture 重新导出后 `git diff --exit-code -- flock-voice-engine/tests/fixtures/jungle_v1.json`
exit 0。

- [ ] **Step 5: Commit**

```powershell
git add flock-voice-engine/server/audio_worker flock-voice-engine/tests/fixtures/jungle_v1.json flock-voice-engine/tests/test_audio_worker_jungle.py flock-voice-engine/tests/test_audio_worker_texture.py flock-voice-engine/tests/test_audio_worker_mixer.py flock-voice-engine/tests/test_audio_worker_split.py mvp/tools/export-jungle-fixture.mjs
git commit -m "feat(audio): own final mix and texture rendering"
```

**Rollback:** revert；browser audio 仍是 production owner，worker candidate 未发布。

### Task 4: AudioPlanner, frame clock, supervisor, and atomic state replacement

**Files:**
- Create: `flock-voice-engine/runtime/src/audio/worker-protocol.js`
- Create: `flock-voice-engine/runtime/src/audio/frame-clock.js`
- Create: `flock-voice-engine/runtime/src/audio/audio-state-projector.js`
- Create: `flock-voice-engine/runtime/src/audio/audio-planner.js`
- Create: `flock-voice-engine/runtime/src/audio/discarding-split-sink.js`
- Create: `flock-voice-engine/runtime/src/audio/public-audio-status.js`
- Create: `flock-voice-engine/runtime/src/audio/worker-supervisor.js`
- Create: `flock-voice-engine/runtime/test/audio/worker-protocol.test.js`
- Create: `flock-voice-engine/runtime/test/audio/frame-clock.test.js`
- Create: `flock-voice-engine/runtime/test/audio/audio-planner.test.js`
- Create: `flock-voice-engine/runtime/test/audio/state-replace.test.js`
- Create: `flock-voice-engine/runtime/test/audio/public-audio-status.test.js`
- Create: `flock-voice-engine/runtime/test/audio/worker-supervisor.integration.test.js`
- Modify: `flock-voice-engine/runtime/src/world-session/world-session.js`
- Modify: `flock-voice-engine/runtime/src/protocol/v1.js`
- Modify: `flock-voice-engine/runtime/src/api/bootstrap.js`
- Modify: `flock-voice-engine/runtime/src/api/runtime-ws.js`
- Modify: `flock-voice-engine/runtime/test/world-session.test.js`
- Modify: `flock-voice-engine/runtime/test/bootstrap.test.js`
- Modify: `flock-voice-engine/runtime/test/runtime-ws.test.js`
- Modify: `flock-voice-engine/runtime/src/audio/null-audio-sink.js`
- Modify: `flock-voice-engine/runtime/src/simulation-runtime.js`
- Modify: `flock-voice-engine/runtime/src/latent/latent-runtime.js`
- Modify: `flock-voice-engine/runtime/src/latent/preview-lease.js`
- Modify: `flock-voice-engine/runtime/src/agents/gpu-admission.js`
- Modify: `flock-voice-engine/runtime/src/config.js`
- Modify: `flock-voice-engine/runtime/src/server.js`
- Modify: `flock-voice-engine/runtime/src/index.js`

**Interfaces:**
- Consumes: Task 1 trusted release manifest/identity compare, Task 2 IPC, Phase 1–4
  `WorldSession.runExclusive/commit`,
  existing `SimulationRuntime`/`LatentRuntime`/`PreviewLease` constructors and their shared audio sink.
- Produces: frozen `createAudioPlanner`, `createWorkerSupervisor`,
  `createFrameClock({sampleRate,blockFrames,leadBlocks})`,
  `assertExactAudioGeometry(expected,reported)`,
  `createPublicAudioStatusStore({session,initialStatus})`,
  `createDiscardingSplitSink({telemetry})`,
  `projectAudioState({session,simulationRuntime,latentRuntime,audioOwner})`;
  `connectWorkerProtocol(socket)` returning
  `{readWorkerHello(),acceptIdentity(identity),readWorkerReady(),enqueueBatch(batch),replaceAndWait(state,timeoutMs),close()}`；
  `enqueueBatch(batch)` 是同步 bounded-memory enqueue，返回
  `{accepted:boolean,reason:string|null}`，不写 socket；`replaceAndWait()` 返回已解码的
  `{appliedCommandSeq:number,renderFrame:bigint}`。

- [ ] **Step 1: Write failing frame, barrier, restart, and admission tests**

```js
test('identity and state replacement gate every incremental and PCM block', async () => {
  await supervisor.start();
  fakeWorker.send(hello({ ...EXPECTED, audioArtifactSha256: '0'.repeat(64) }));
  assert.equal(supervisor.getStatus().workerReady, false);
  assert.equal(planner.getStatus().paused, true);
  assert.equal(pcmPublisher.blocks.length, 0);

  fakeWorker.reconnect();
  fakeWorker.send(hello(EXPECTED));
  fakeWorker.send(ready({ audioEpoch: 'epoch-2', renderFrame: '0' }));
  assert.equal(fakeWorker.sent.at(-1).commands[0].type, 'state.replace');
  fakeWorker.send(stateApplied({ audioEpoch: 'epoch-2', stateRevision: 17 }));
  assert.equal(supervisor.getStatus().workerReady, true);
  assert.equal(planner.getStatus().paused, false);
});

test('blocked worker socket never blocks mailbox or planner accept', async () => {
  fakeWorker.blockWrites();
  const commit = await session.commit('audio-test', () => ({
    changed: true, snapshot, domainEvents: [],
    audioCommands: [{ type: 'continuous.set', voice: 'pad', param: 'gain', value: 0.5 }],
  }));
  assert.equal(commit.resultRevision, 1);
  assert.equal(planner.getStatus().outboundQueueDepth, 1);
  assert.equal(fakeWorker.bytesWritten, 0);
});

test('ready geometry is release data, including alternate pool and rows', async () => {
  const expected = release({ geometry: {
    sampleRate: 48000, blockFrames: 2048, poolSize: 3,
    rowVoices: ['bass', 'lead', 'pluck'],
  }});
  const alternateSupervisor = supervisorFor(expected);
  await alternateSupervisor.acceptReady(ready({ geometry: expected.geometry }));
  assert.equal(alternateSupervisor.getStatus().workerReady, true);
});

test('private JSON u64 codec matches handwritten Python-shared golden', () => {
  for (const item of U64_GOLDEN) {
    assert.equal(encodeU64Decimal(BigInt(item.value)), item.wire);
    assert.equal(decodeU64Decimal(item.wire), BigInt(item.value));
  }
});

test('replacement discards queued pre-applied PCM before prime', async () => {
  fakeWorker.queueMaster({ startFrame: 0n });
  fakeWorker.queueMaster({ startFrame: 4096n });
  fakeWorker.send(stateApplied({ renderFrame: '8192' }));
  fakeWorker.queueMaster({ startFrame: 8192n });
  await supervisor.waitForReady();
  assert.deepEqual(masterPcmPublisher.blocks.map((x) => x.startFrame), [8192n]);
  assert.equal(publicStatus.get().workerReady, true);
});

test('split frames are continuously drained before legacy consumer exists', async () => {
  fakeWorker.sendSplitBlocks(16);
  assert.equal(discardingSplitSink.drainedBlocks, 16);
  assert.equal(fakeWorker.blockedWrites, 0);
});
```

加入 world time/frame rounding、2-block lead、same-frame ordering、old epoch ACK、replace timeout
5,000 ms、worker crash、edge overflow、restart backoff 1/2/4/8/10 秒、identity expected/reported
health projection、restart 不改 world revision、preview recovery exactly-once all-off。逐项把
`workerReady=false`、recovering、PCM headroom < 3、queueDepth > 1、render p95 > 0.70、p99 > 0.90、
recent underrun > 0、统一内存 < 12 GiB、NaN/缺字段和 runtime 接收时间超过 1,000 ms 注入
`gpu-admission.js`，每项都必须 fail closed 且不请求 8081。另验证 bootstrap 与 Runtime WS
`audio.status` 来自同一 mailbox snapshot，revision 严格递增，重连时旧 status 不回滚 owner。

- [ ] **Step 2: Run RED**

```powershell
node --test `
  flock-voice-engine/runtime/test/audio/worker-protocol.test.js `
  flock-voice-engine/runtime/test/audio/frame-clock.test.js `
  flock-voice-engine/runtime/test/audio/audio-planner.test.js `
  flock-voice-engine/runtime/test/audio/state-replace.test.js `
  flock-voice-engine/runtime/test/audio/public-audio-status.test.js `
  flock-voice-engine/runtime/test/audio/worker-supervisor.integration.test.js
```

Expected: FAIL with missing audio modules。

- [ ] **Step 3: Implement one audio sink and one recovery path**

```js
export function createFrameClock({
  sampleRate, blockFrames, leadBlocks = 2,
}) {
  if (!Number.isInteger(sampleRate) || !Number.isInteger(blockFrames)) {
    throw new Error('AUDIO_GEOMETRY_REQUIRED');
  }
  let map = null;
  return {
    replace(next) { map = Object.freeze({ ...next }); },
    targetFrame(worldTimeSeconds) {
      if (!map) throw new Error('AUDIO_FRAME_MAP_MISSING');
      const delta = Math.max(0, worldTimeSeconds - map.worldTimeSeconds);
      const projected = map.renderFrame + BigInt(Math.round(delta * sampleRate));
      const lead = map.renderFrame + BigInt(blockFrames * leadBlocks);
      return projected > lead ? projected : lead;
    },
  };
}
```

`AudioPlanner.accept(commands)` 是唯一 Phase 1–4 sink：note/gate/preview edge 进入 reliable
batch，continuous/latent/mix 以稳定 key coalesce。`WorldSession.commit()` 只同步调用
`enqueueBatch(batch)` 把序列化结果放入容量 256 的 Node outbound queue；mailbox、fixed-step tick
和 render 都不 await UDS I/O。独立 protocol writer drain queue；outbound overflow 锁存
`RUNTIME_AUDIO_OUTBOUND_OVERFLOW` 并触发 supervisor rebuild。worker 的 `command.accepted` 与
`appliedCommandSeq` 通过 reader 异步更新 planner status，不能作为 mailbox commit 的同步返回。
planner paused 时只积累最新 complete state，不发 world incrementals。

supervisor 只使用一条恢复函数：

```js
async function rebuild(reason) {
  planner.pauseWorldWrites(reason);
  publicStatusStore.update({ workerReady: false, recovering: true });
  masterPcmPublisher.hold();
  const connection = await connector.connect();
  const reported = await connection.readWorkerHello();
  const release = await readTrustedReleaseManifest();
  assertExactWorkerIdentity(release.workerIdentity, reported.identity);
  await connection.acceptIdentity(release.workerIdentity);
  const ready = await connection.readWorkerReady();
  assertExactAudioGeometry(release.geometry, ready.geometry);
  const replacement = getAudioState(ready);
  const applied = await connection.replaceAndWait(replacement, 5000);
  masterPcmPublisher.beginStream({
    audioEpoch: ready.audioEpoch,
    minStartFrame: applied.renderFrame,
  });
  await masterPcmPublisher.waitForPostAppliedPrime();
  publicStatusStore.update({
    workerReady: true, recovering: false, degraded: false,
    audio: publicGeometry(release.geometry, ready.audioEpoch),
  });
  planner.resumeWorldWrites();
}
```

`masterPcmPublisher` 与 `splitPcmSink` 由同一个 protocol reader 持续消费；Task 4 composition 把
kind 3 注入 `createDiscardingSplitSink()`，因此即使 legacy ring 尚未建立也不会让 worker split
writer 背压或溢出。Task 6 只把该 sink 替换为 bounded split ring，不改变 IPC reader。

Phase 5 direct-local profile 固定
`host=127.0.0.1,port=18090,runtimeOwner=server,audioOwner=world,phaseGate=phase5-local`；
Task 8 的 container-local profile 才固定容器内 `host=0.0.0.0,port=8090` 并只向 host loopback
publish 18090。两者是不同固定 entry/config，不允许用任意 host/port 环境变量互换。
production profile 在 Task 8 才定义、Task 10 才允许执行。`/healthz` 始终可返回进程/
expected/reported/mismatch；
`/readyz` 只有 identity、worker ready、replace ack、PCM prime 全部成立才 200。

`gpu-admission.js` 保持 Phase 3–4 的完整 contract，不缩短字段或阈值：从 supervisor public
telemetry 读取 `workerReady/recovering/pcmHeadroomBlocks/queueDepth/renderP95Ms/renderP99Ms/
blockDurationMs/recentUnderruns/unifiedMemoryFreeBytes/receivedAtMs/degraded`；runtime 自己计算
sample age。worker 非 ready、recovering、headroom < 3、queueDepth > 1、p95 ratio > 0.70、
p99 ratio > 0.90、recentUnderruns > 0、free memory < 12 GiB、age > 1,000 ms、NaN、缺字段或
degraded 都拒绝 species request。

`protocol/v1.js` 注册 `audio.status` validator；`bootstrap.js` 在 bootstrap response 加
`audioStatus`；`runtime-ws.js` 订阅同一个 `PublicAudioStatusStore`。supervisor 的 async 状态变化
必须通过 `WorldSession.runExclusive('audio-status', updateFn)` 更新 sidecar 与 revision，不改 world
revision；owner transition 也复用此入口，不允许另有可变 public status。

- [ ] **Step 4: Run GREEN and Phase 3–4 regressions**

```powershell
node --test flock-voice-engine/runtime/test/audio/*.test.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/test/bootstrap.test.js flock-voice-engine/runtime/test/runtime-ws.test.js
node --test flock-voice-engine/runtime/test/latent/*.test.js flock-voice-engine/runtime/test/agents/gpu-admission.test.js
npm run verify:phase0
npm run verify:phase12
npm run verify:phase34
```

Expected: PASS；candidate 仍只绑定 localhost，production 8090 无写入。

- [ ] **Step 5: Commit**

```powershell
git add flock-voice-engine/runtime/src/audio flock-voice-engine/runtime/test/audio flock-voice-engine/runtime/src/world-session/world-session.js flock-voice-engine/runtime/src/protocol/v1.js flock-voice-engine/runtime/src/api/bootstrap.js flock-voice-engine/runtime/src/api/runtime-ws.js flock-voice-engine/runtime/src/simulation-runtime.js flock-voice-engine/runtime/src/latent/latent-runtime.js flock-voice-engine/runtime/src/latent/preview-lease.js flock-voice-engine/runtime/src/agents/gpu-admission.js flock-voice-engine/runtime/src/config.js flock-voice-engine/runtime/src/server.js flock-voice-engine/runtime/src/index.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/test/bootstrap.test.js flock-voice-engine/runtime/test/runtime-ws.test.js
git commit -m "feat(runtime): supervise authoritative audio state"
```

**Rollback:** stop localhost candidate and revert；production browser/Python owner 未改变。

### Task 5: Shared PCM ring, fan-out, Audio WS v1, and browser player

**Files:**
- Create: `flock-voice-engine/runtime/src/audio/pcm-v1.js`
- Create: `flock-voice-engine/runtime/src/audio/pcm-ring.js`
- Create: `flock-voice-engine/runtime/src/audio/audio-client-writer.js`
- Create: `flock-voice-engine/runtime/src/api/audio-ws.js`
- Create: `flock-voice-engine/runtime/test/fixtures/audio-ws-v1-golden.hex`
- Create: `flock-voice-engine/runtime/test/audio/pcm-v1.test.js`
- Create: `flock-voice-engine/runtime/test/audio/pcm-ring.test.js`
- Create: `flock-voice-engine/runtime/test/audio/audio-fanout.integration.test.js`
- Create: `flock-voice-engine/runtime/test/audio/audio-discontinuity.test.js`
- Create: `mvp/src/pcm-player-worklet.js`
- Modify: `mvp/src/runtime-client.js`
- Modify: `mvp/src/pcm-protocol.js`
- Modify: `mvp/src/pcm-player.js`
- Modify: `mvp/test/runtime-client.test.js`
- Modify: `mvp/test/pcm-protocol.test.js`
- Modify: `mvp/test/pcm-player.test.js`
- Modify: `flock-voice-engine/runtime/src/server.js`
- Modify: `flock-voice-engine/runtime/src/index.js`

**Interfaces:**
- Consumes: Task 4 master PCM publisher, stream rebuild notification, bootstrap/Runtime WS
  `audio.status`, and mailbox-owned `PublicAudioStatusStore`; Phase 1–2
  `parseAudioFrameV1(buffer,expectedCursor)`；本任务把 Phase 1–2 disabled facade 演进为
  `createPcmPlayer({runtimeClient,audioContextFactory,webSocketFactory})`。
- Produces: `encodeAudioFrameV1(header,payload) -> Buffer`; frozen `createPcmRing`;
  `createAudioClientWriter({socket,ring,egressMs,clock})`; `/api/v1/audio`.
  RuntimeClient 新增 `subscribeStatus(listener) -> unsubscribe`，状态来自 bootstrap/Runtime WS
  health frames，不从 browser local flags 推断。

- [ ] **Step 1: Add the fixed golden and failing ring/fan-out tests**

`audio-ws-v1-golden.hex` 内容必须恰好为一行：

```text
464c4b3101002000020000000300000008070605040302010200000002000100000000000000003f000000bf0000803f
```

```js
test('server encoder matches the independent fixed golden', () => {
  const actual = encodeAudioFrameV1({
    streamRevision: 2, blockSeq: 3,
    startFrame: 0x0102030405060708n,
    frameCount: 2, channels: 2, format: 1,
  }, Float32Array.of(0, 0.5, -0.5, 1));
  assert.equal(actual.toString('hex'), GOLDEN_HEX);
});

test('one paused client jumps alone and never stalls a hot client', async () => {
  pausedSocket.blockWrites();
  await publishBlocks(ring, 80);
  assert.equal(hotSocket.binaryFrames.length, 80);
  assert.equal(streamTimeline.streamRevision, 4);
  assert.equal(pausedSocket.jsonFrames.at(-1).scope, 'client');
  assert.equal(pausedSocket.jsonFrames.at(-1).streamRevision, 4);
});

test('geometry comes from ready and supports a non-production block size', () => {
  runtimeClient.publishStatus(serverWorldReadyStatus({
    manifestGeometrySha256: ALT_GEOMETRY_SHA,
    sampleRate: 44100, blockFrames: 2048,
  }));
  const ready = audioReady({
    manifestGeometrySha256: ALT_GEOMETRY_SHA,
    sampleRate: 44100, blockFrames: 2048,
  });
  player.acceptReady(ready);
  assert.equal(player.getStatus().blockFrames, 2048);
  assert.equal(player.getStatus().primeFrames, 6144);
});

test('ready must exactly match manifest-derived public status geometry', () => {
  runtimeClient.publishStatus(serverWorldReadyStatus({
    manifestGeometrySha256: PROD_GEOMETRY_SHA,
    sampleRate: 44100, blockFrames: 4096,
    channels: 2, format: 'f32le', binaryHeaderVersion: 1, headerBytes: 32,
  }));
  assert.throws(() => player.acceptReady(audioReady({
    manifestGeometrySha256: PROD_GEOMETRY_SHA,
    sampleRate: 48000, blockFrames: 4096,
  })), /AUDIO_READY_GEOMETRY_MISMATCH/);
  assert.equal(player.getStatus().enabled, false);
});
```

加入 first `audio.ready`/next binary cursor equality、late subscriber nonzero resume、payload length、
repeat/reorder/gap/startFrame overflow、client discontinuity、stream discontinuity、worker restart
new epoch、global rebuild same epoch/new revision、Audio WS/Runtime WS 独立断线。逐字段覆盖
`manifestGeometrySha256/sampleRate/blockFrames/channels/format/binaryHeaderVersion/headerBytes`
mismatch；任一 mismatch 都关闭 socket、清 ring 且不创建 AudioContext。RuntimeClient 测试覆盖
bootstrap 初值、严格递增 `statusRevision`、owner world→legacy→world、worker restart、
recovering/degraded 和 Runtime WS 重连，旧 status 不得重新启用 player。`audio.ready` 与
discontinuity 的 `resumeStartFrame` 复用 Task 2/4 canonical u64 decimal codec；JSON number、
overflow 或非 canonical string 均拒绝。

- [ ] **Step 2: Run RED**

```powershell
node --test `
  flock-voice-engine/runtime/test/audio/pcm-v1.test.js `
  flock-voice-engine/runtime/test/audio/pcm-ring.test.js `
  flock-voice-engine/runtime/test/audio/audio-fanout.integration.test.js `
  flock-voice-engine/runtime/test/audio/audio-discontinuity.test.js `
  mvp/test/pcm-protocol.test.js `
  mvp/test/pcm-player.test.js
```

Expected: server tests FAIL with missing modules；Phase 1–2 disabled player assertions fail until
Phase 5 lifecycle is implemented。

- [ ] **Step 3: Implement exact encoder, time-window ring, and per-client writer**

```js
export function encodeAudioFrameV1(header, samples) {
  if (samples.length !== header.frameCount * 2) throw new Error('AUDIO_LENGTH_MISMATCH');
  const out = Buffer.allocUnsafe(32 + samples.length * 4);
  out.write('FLK1', 0, 'ascii');
  out.writeUInt8(1, 4); out.writeUInt8(0, 5); out.writeUInt16LE(32, 6);
  out.writeUInt32LE(header.streamRevision, 8);
  out.writeUInt32LE(header.blockSeq, 12);
  out.writeBigUInt64LE(header.startFrame, 16);
  out.writeUInt32LE(header.frameCount, 24);
  out.writeUInt16LE(2, 28); out.writeUInt16LE(1, 30);
  for (let i = 0; i < samples.length; i += 1) out.writeFloatLE(samples[i], 32 + i * 4);
  return out;
}
```

shared ring history 固定 3,000 ms；per-client egress 固定 500 ms。两者由
`ceil(ms*sampleRate/(1000*blockFrames))` 计算容量，不写死 block count。publisher 只同步
append ring 和 signal writer，不 await socket。writer queue 超限时清自己的 queue、跳 live edge、
发送 `scope="client"` discontinuity 后重新 prime。

global timeline 规则固定：

- worker restart：new `audioEpoch`、`renderFrame/startFrame=0`、`streamRevision+1`、`blockSeq=0`；
- same-worker rebuild：epoch 不变、`streamRevision+1`、`blockSeq=0`、`startFrame` 继续单调；
- client skip：epoch/revision 不变。

- [ ] **Step 4: Enable the browser player without local synthesis**

`createPcmPlayer()` 订阅 `RuntimeClient` 的动态 public audio status，仅在
`runtimeOwner=server,audioOwner=world,workerReady=true,degraded=false` 时创建 AudioContext、注册
`pcm-player-worklet.js` 并打开 `/api/v1/audio`。它先解析 `audio.ready`，清空/prime worklet ring，
先逐字段精确比较 `audio.ready` 与 manifest-derived `status.audio`，再接受 cursor 精确相等的首个
binary frame。比较包括 `manifestGeometrySha256/sampleRate/blockFrames/channels/format/
binaryHeaderVersion/headerBytes`，不得使用默认值补字段。任何 parser error/discontinuity 清本地 ring，不调用
`mvp/src/audio.js`。worker restart、identity mismatch 或 degraded 会立即关闭 Audio WS、清空并
停止 prime，等 RuntimeClient 后续 ready status 再重连；禁止创建本地 fallback。

```js
export function createPcmPlayer({
  runtimeClient, audioContextFactory, webSocketFactory,
}) {
  const player = createDynamicPlayer({ audioContextFactory, webSocketFactory });
  const unsubscribe = runtimeClient.subscribeStatus((status) => {
    const enabled = status.runtimeOwner === 'server'
      && status.audioOwner === 'world'
      && status.workerReady === true
      && status.recovering !== true
      && status.degraded !== true;
    if (enabled) player.enable(status.audio);
    else player.disableAndClear('PCM_RUNTIME_NOT_READY');
  });
  return { ...player.publicApi, destroy() { unsubscribe(); player.destroy(); } };
}
```

- [ ] **Step 5: Run GREEN and real Chromium reconnect E2E**

```powershell
node --test flock-voice-engine/runtime/test/audio/*.test.js mvp/test/runtime-client.test.js mvp/test/pcm-protocol.test.js mvp/test/pcm-player.test.js
npm --prefix flock-voice-engine/runtime run test:e2e -- reconnect.spec.js
npm run test:mvp
npm run verify:phase0
npm run verify:phase12
npm run verify:phase34
```

Expected: PASS；golden encoder/parser 独立命中固定 hex，paused client 不影响 hot client。

- [ ] **Step 6: Commit**

```powershell
git add flock-voice-engine/runtime/src/audio/pcm-v1.js flock-voice-engine/runtime/src/audio/pcm-ring.js flock-voice-engine/runtime/src/audio/audio-client-writer.js flock-voice-engine/runtime/src/api/audio-ws.js flock-voice-engine/runtime/test/audio flock-voice-engine/runtime/test/fixtures/audio-ws-v1-golden.hex flock-voice-engine/runtime/src/server.js flock-voice-engine/runtime/src/index.js mvp/src/runtime-client.js mvp/src/pcm-protocol.js mvp/src/pcm-player.js mvp/src/pcm-player-worklet.js mvp/test/runtime-client.test.js mvp/test/pcm-protocol.test.js mvp/test/pcm-player.test.js
git commit -m "feat(audio): fan out one versioned PCM stream"
```

**Rollback:** stop localhost candidate/revert；production clients still use legacy `/decoder`。

### Task 6: Legacy adapter, maintenance authentication, control barrier, and audio owner

**Files:**
- Modify: `flock-voice-engine/runtime/src/control/lease-manager.js`
- Create: `flock-voice-engine/runtime/src/control/maintenance-auth.js`
- Create: `flock-voice-engine/runtime/src/audio/audio-control-barrier.js`
- Create: `flock-voice-engine/runtime/src/audio/split-ring.js`
- Create: `flock-voice-engine/runtime/src/legacy/decoder-session-registry.js`
- Create: `flock-voice-engine/runtime/src/legacy/decoder-adapter.js`
- Create: `flock-voice-engine/runtime/src/legacy/audio-owner.js`
- Create: `flock-voice-engine/runtime/src/api/legacy-routes.js`
- Create: `flock-voice-engine/runtime/tools/legacy-lease.mjs`
- Modify: `flock-voice-engine/runtime/test/control/lease-manager.test.js`
- Create: `flock-voice-engine/runtime/test/control/maintenance-auth.test.js`
- Create: `flock-voice-engine/runtime/test/audio/audio-control-barrier.test.js`
- Create: `flock-voice-engine/runtime/test/audio/split-ring.test.js`
- Create: `flock-voice-engine/runtime/test/legacy/decoder-session.test.js`
- Create: `flock-voice-engine/runtime/test/legacy/audio-owner.test.js`
- Create: `flock-voice-engine/runtime/test/legacy/legacy-adapter.integration.test.js`
- Modify: `flock-voice-engine/runtime/src/latent/latent-runtime.js`
- Modify: `flock-voice-engine/runtime/src/latent/preview-lease.js`
- Modify: `flock-voice-engine/runtime/src/audio/public-audio-status.js`
- Modify: `flock-voice-engine/runtime/src/protocol/v1.js`
- Modify: `flock-voice-engine/runtime/src/api/runtime-ws.js`
- Modify: `flock-voice-engine/runtime/src/api/bootstrap.js`
- Modify: `flock-voice-engine/runtime/src/server.js`
- Modify: `flock-voice-engine/client/voice-client.js`
- Modify: `flock-voice-engine/client/demo.html`
- Modify: `flock-voice-engine/client/tracks.html`

**Interfaces:**
- Consumes: Phase 4 existing
  `createLeaseManager({clock,tokenFactory,defaultTtlMs,maxTtlMs})`, Task 4
  planner/supervisor/state projector, Task 3 split frames, Task 5 master ring.
- Produces: frozen `createAudioControlBarrier`, `createAudioOwnerController`;
  `createDecoderSessionRegistry({tokenFactory})`;
  `createSplitRing({historyMs,geometry})`;
  `createLegacyRoutes({sessionRegistry,audioOwner,masterRing,splitRing})`.

- [ ] **Step 1: Extract lease core under existing tests and write failing legacy races**

```js
test('lease is bound to the exact decoder socket generation', async () => {
  const first = sessions.attach(socketA);
  sessions.detach(socketA);
  const second = sessions.attach(socketB);
  assert.notEqual(first.decoderSessionId, second.decoderSessionId);
  await assert.rejects(
    owner.takeLegacy(maintenanceRequest(first.decoderSessionId)),
    /LEGACY_DECODER_SESSION_GONE/,
  );
});

test('disconnect uses the same all-off replace release sequence', async () => {
  await owner.takeLegacy(maintenanceRequest(activeSession.decoderSessionId));
  await owner.decoderDisconnected(activeSession.decoderSessionId);
  assert.deepEqual(trace.names, [
    'ownerTransition.begin', 'legacy.rejectWrites',
    'preview.allOff', 'voice.allOff', 'control.applied',
    'audio.state.replace', 'audio.state.applied',
    'audioOwner.world', 'audio.discontinuity',
    'worldWrites.resume', 'ownerTransition.end',
  ]);
});

test('take commits legacy owner before its public discontinuity', async () => {
  await owner.takeLegacy(maintenanceRequest(activeSession.decoderSessionId));
  assert.deepEqual(trace.names, [
    'ownerTransition.begin', 'worldWrites.pause',
    'preview.allOff', 'voice.allOff', 'control.applied',
    'audioOwner.legacy', 'audio.discontinuity',
    'legacy.allowExactGeneration', 'ownerTransition.end',
  ]);
});

test('pausing world writes cannot swallow reliable control all-off', async () => {
  planner.pauseWorldWrites('legacy-take');
  await barrier.enterLegacy('lease-acquired');
  assert.equal(worker.appliedCommands.some((x) => x.type === 'voice.allOff'), true);
  assert.equal(worker.appliedCommands.some((x) => x.type === 'voice.reset'), true);
});
```

加入普通 decoder take/renew、maintenance auth 缺失/错误、token 绑错 resource/generation、双
decoder 竞争、TTL、heartbeat、release、socket close、adapter exception、replace timeout、
transition 中 note/control、split/non-split client、demo/tracks 顺序 lease。每种 release cause
都断言相同 restore trace，且 `audioOwner.world` 必须严格早于 stream discontinuity；take trace
同样要求 `audioOwner.legacy` 早于 discontinuity。replace/control timeout 保持
`recovering=true`、两侧 writes 均拒绝，不发布半完成 owner。

- [ ] **Step 2: Run RED**

```powershell
node --test `
  flock-voice-engine/runtime/test/control/*.test.js `
  flock-voice-engine/runtime/test/audio/audio-control-barrier.test.js `
  flock-voice-engine/runtime/test/audio/split-ring.test.js `
  flock-voice-engine/runtime/test/legacy/*.test.js
```

Expected: FAIL with missing control/legacy modules。

- [ ] **Step 3: Implement shared lease and maintenance boundary**

```js
const leaseManager = createLeaseManager({
  clock, tokenFactory, defaultTtlMs: 3000, maxTtlMs: 10000,
});
```

直接扩展 Phase 4 manager 的测试，不另造 core。保持原资源 `latent:${voice}`、TTL 3,000 ms、
preview TTL 2,000 ms 和 exactly-once all-off；legacy 传
`resource="legacy-audio"`、`clientId=maintenanceClientId`、
`connectionGeneration=decoderSessionId`，从而精确复用现有 owner identity。
`createAudioOwnerController` 必须接收由 production composition 创建的同一个 `leaseManager`
实例；测试用对象 identity 断言 latent、preview、legacy 三类 resource 均落在该实例，禁止包装器
内部再次调用 `createLeaseManager()`。decoder registry 每次 attach 产生不可复用 generation，
close 后即使 socket object/maintenance clientId 相同也不能续租旧 token。

maintenance secret 固定从 `/run/secrets/flock-maintenance-token` 读取，要求至少 32 bytes，
以 `crypto.timingSafeEqual` 校验 Runtime WS 的 `maintenance.authenticate`。secret/token 不进入
snapshot、journal、DOM、URL、localStorage 或普通日志。文件缺失时 legacy take capability
关闭，但 world PCM 继续。

`legacy-audio` TTL 固定 5,000 ms、heartbeat 最晚 1,000 ms。普通 decoder 收到
`legacy.session` 后保持只读；maintenance operator 通过 server-side
`runtime/tools/legacy-lease.mjs` 提交 exact decoderSessionId。demo/tracks 只显示该 ID 和 owner
状态，不读取 maintenance credential。

- [ ] **Step 4: Implement owner transitions and compatibility routes**

`createSplitRing({historyMs:3000,geometry})` 是 Node 私有 bounded ring，只接 worker
`PCM_SPLIT`，不注册 public Audio WS route；lag/overflow 触发同一 supervisor stream rebuild。
Task 6 composition 通过 supervisor 的 `splitPcmSink` seam 原子替换 Task 4 的 discard sink；
无 legacy reader 时 split ring 仍由 drain cursor 持续取走并丢弃，只有 active exact-generation
legacy session 才复制到自己的 bounded writer，绝不停止读取 UDS kind 3。

owner transition 由 `createAudioControlBarrier()` 完整拥有，caller 不得在 barrier 外写 owner：

```js
await controlBarrier.enterLegacy({
  reason: 'legacy-take',
  decoderSessionId,
});
```

`enterLegacy` 先取得唯一 `ownerTransitionMutex`；用短
`WorldSession.runExclusive('audio-owner-transition-begin')` 原子设置 `transitioning/recovering`、
拒绝双方新写并 pause world，然后释放 mailbox。随后通过 control-only reliable queue 发送
`preview.allOff/voice.allOff/voice.reset` 并等 `command.accepted/appliedCommandSeq`。最后用第二个
短 mailbox fence 原子完成 `audioOwner=legacy`、bump stream revision、广播 status/discontinuity、
只允许指定 decoder generation 写入并清 transitioning。owner 更新严格先于对外 discontinuity；
control-only queue 不受 world pause gate 影响，任何 wait 都不占用 mailbox。

退出 legacy 统一调用：

```js
await controlBarrier.restoreWorld('legacy-release');
```

`restoreWorld` 在同一 transition mutex 下先用 mailbox begin fence 拒绝 legacy/world writes、
设置 recovering 并 pause；在 mailbox 外发送 reliable
`preview.allOff/voice.allOff/voice.reset` → 等 applied → complete `state.replace` → 等
`audio.state.applied` → 设置 post-applied PCM cutoff 并等待 prime。最后用一个 mailbox commit
依次完成 `audioOwner=world`、bump/broadcast status+discontinuity、`resumeWorldWrites()` 和
transition end。TTL、release、socket close、adapter error 都只调用这一函数；caller 不得另写
owner、revision 或 session write permission。

Node 提供 `/api/decoder-status`、`/api/load`、`/decoder`、demo/tracks 静态资源；legacy
note/control 翻译成 planner commands。mixed legacy client 读 Task 5 master；`?split=1` 只读
Task 3 pre-mix split。禁止实例化 backend 或第二 worker。

- [ ] **Step 5: Run GREEN and legacy regressions**

```powershell
node --test flock-voice-engine/runtime/test/control/*.test.js flock-voice-engine/runtime/test/legacy/*.test.js
node --test flock-voice-engine/runtime/test/latent/*.test.js
npm run check
npm run verify:phase0
npm run verify:phase12
npm run verify:phase34
```

Expected: PASS；所有 release cause 产生相同 trace，非 owner 写显式 reject。

- [ ] **Step 6: Commit**

```powershell
git add flock-voice-engine/runtime/src/control flock-voice-engine/runtime/src/audio/audio-control-barrier.js flock-voice-engine/runtime/src/audio/split-ring.js flock-voice-engine/runtime/src/audio/public-audio-status.js flock-voice-engine/runtime/src/legacy flock-voice-engine/runtime/src/api/legacy-routes.js flock-voice-engine/runtime/tools/legacy-lease.mjs flock-voice-engine/runtime/test/control flock-voice-engine/runtime/test/audio/audio-control-barrier.test.js flock-voice-engine/runtime/test/audio/split-ring.test.js flock-voice-engine/runtime/test/legacy flock-voice-engine/runtime/src/latent/latent-runtime.js flock-voice-engine/runtime/src/latent/preview-lease.js flock-voice-engine/runtime/src/protocol/v1.js flock-voice-engine/runtime/src/api/runtime-ws.js flock-voice-engine/runtime/src/api/bootstrap.js flock-voice-engine/runtime/src/server.js flock-voice-engine/client/voice-client.js flock-voice-engine/client/demo.html flock-voice-engine/client/tracks.html
git commit -m "feat(runtime): lease the legacy audio adapter"
```

**Rollback:** stop localhost candidate/revert；旧 Python `/decoder` production 仍在。

### Task 7: PCM-only production bundle and full localhost owner integration

**Files:**
- Create: `mvp/src/view-app.js`
- Create: `mvp/src/server-main.js`
- Create: `mvp/src/view-config.js`
- Create: `mvp/src/view-sequence.js`
- Create: `mvp/test/server-main.test.js`
- Create: `mvp/test/view-config.test.js`
- Create: `mvp/test/view-sequence.test.js`
- Create: `mvp/test/backend-owner-boundary.test.js`
- Create: `mvp/test/audio-reconnect.test.js`
- Create: `flock-voice-engine/runtime/test/integration/phase5-local.test.js`
- Create: `flock-voice-engine/runtime/test/security/production-bundle-boundary.test.js`
- Create: `flock-voice-engine/runtime/test/helpers/import-graph.js`
- Create: `flock-voice-engine/runtime/test/production-graph.test.js`
- Create: `flock-voice-engine/runtime/test/fixtures/production-graph/graph-fixture.json`
- Create: `flock-voice-engine/runtime/tools/build-production-graph.mjs`
- Create: `flock-voice-engine/runtime/tools/lib/production-graph.mjs`
- Create: `flock-voice-engine/runtime/test/fixtures/candidate-ui/shadow-app.js`
- Create: `flock-voice-engine/runtime/test/e2e/phase5-local.spec.js`
- Modify: `mvp/index.html`
- Modify: `mvp/src/renderer.js`
- Modify: `mvp/src/scene-layout.js`
- Modify: `flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js`
- Modify: `flock-voice-engine/runtime/test/candidate-surface.test.js`
- Modify: `mvp/test/backend-owned-boundary.test.js`
- Modify: `flock-voice-engine/runtime/src/index.js`
- Modify: `flock-voice-engine/runtime/package.json`
- Modify: `flock-voice-engine/runtime/package-lock.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: Phase 1–4 `RuntimeClient`, pure-view latent roamer, renderer; Task 5 `PcmPlayer`; Task 6
  compatibility routes.
- Produces: `createServerOwnedApp({runtimeClient,pcmPlayer,renderer,ui})`;
  test-only `createHistoricalShadowApp({browserRuntime,renderer,ui})`;
  `VIEW_CONFIG`; `defaultViewSequenceDimensions()`;
  `sequencePlayheadForViewTree(viewTree,dimensions)`;
  `buildProductionGraph({repoRoot,roots}) -> {files:string[],edges:object[]}`;
  `npm run verify:phase5-local`.

- [ ] **Step 1: Write failing owner and dependency-boundary tests**

```js
test('server owner app renders snapshots and never advances domain', async () => {
  const app = createServerOwnedApp({ runtimeClient, pcmPlayer, renderer, ui });
  await app.start();
  runtimeClient.publishSnapshot(SNAPSHOT);
  assert.deepEqual(renderer.frames.at(-1), SNAPSHOT);
  assert.equal(runtimeClient.commands.length, 0);
  assert.equal(pcmPlayer.starts, 1);
});
```

`production-bundle-boundary.test.js` 使用统一 production graph，固定 roots：

```js
[
  { kind: 'html', path: 'mvp/index.html' },
  { kind: 'node', path: 'flock-voice-engine/runtime/src/index.js' },
  { kind: 'python', path: 'flock-voice-engine/server/audio_worker/__main__.py' },
]
```

graph 必须覆盖 HTML script/link/src、CSS `@import/url()`、JS static import/re-export、literal
dynamic import、`new URL(literal,import.meta.url)`、Worker/SharedWorker、AudioWorklet module、仓库内
literal fetch/static asset，以及 Python `ast.Import/ImportFrom`。每条边记录 source、line、
edge kind 和 resolved literal path；非 literal production edge、unresolved edge、越出 repo、
symlink、大小写歧义或 Python dynamic import 均 `PRODUCTION_GRAPH_UNRESOLVED_EDGE`，不得忽略。
`graph-fixture.json` 枚举上述每一种 edge 及 expected closure，测试还逐项注入非 literal edge
证明 fail closed。production graph 断言不含：

```js
[
  'mvp/src/main.js', 'mvp/src/world.js', 'mvp/src/agent.js',
  'mvp/src/audio.js', 'mvp/src/ecological-latent.js',
  'mvp/src/config.js', 'mvp/src/sequence.js',
  'mvp/src/mix-agent.js', 'mvp/src/llm/', 'mvp/src/master/',
]
```

`view-config.test.js` 和 `view-sequence.test.js` 先锁定 renderer/scene-layout 当前所需的纯视图
投影：`tempo`、`tree.trunkHeight`、`visual`，以及
`defaultViewSequenceDimensions()`/`sequencePlayheadForViewTree()`。它们断言生产 import graph
不含完整 `mvp/src/config.js` 或 domain `mvp/src/sequence.js`，并用一组非默认尺寸验证 helper
没有偷偷固化当前几何。

把 Phase 1 `candidate-surface.test.js` 与 Phase 3–4
`mvp/test/backend-owned-boundary.test.js` 演进为两个固定入口、固定命令：
`test:surface:shadow` 只加载
`flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html` 与其 test-only
`shadow-app.js`；`test:surface:production` 只加载 `mvp/index.html`。任何入口都不读取
process env 来选择 owner。历史 gate 不再断言 Phase 5 production
index 永远保留 browser owner。

E2E 拦截浏览器请求/constructor，断言无 8081、DeepSeek、`/decoder`、本地 oscillator/
buffer-source/convolver，仅有 Runtime WS 和 `/api/v1/audio`。

- [ ] **Step 2: Run RED**

```powershell
node --test `
  mvp/test/server-main.test.js `
  mvp/test/view-config.test.js `
  mvp/test/view-sequence.test.js `
  mvp/test/backend-owner-boundary.test.js `
  mvp/test/audio-reconnect.test.js `
  flock-voice-engine/runtime/test/security/production-bundle-boundary.test.js `
  flock-voice-engine/runtime/test/production-graph.test.js
```

Expected: FAIL because `server-main.js` is absent and production entry still imports `main.js`。

- [ ] **Step 3: Implement pure-view composition and atomic owner assertion**

```js
export function createViewApp({ snapshotSource, audioPlayer, renderer, ui }) {
  return {
    bind() {
      return snapshotSource.subscribe((snapshot) => {
        renderer.render(snapshot);
        ui.render(snapshot);
      });
    },
    startAudio() { audioPlayer?.start(); },
    stopAudio() { audioPlayer?.stop(); },
  };
}

export function createServerOwnedApp({ runtimeClient, pcmPlayer, renderer, ui }) {
  const view = createViewApp({
    snapshotSource: runtimeClient, audioPlayer: pcmPlayer, renderer, ui,
  });
  return {
    async start() {
      await runtimeClient.connect();
      const status = runtimeClient.getStatus();
      if (status.runtimeOwner !== 'server') {
        throw new Error('SERVER_OWNER_TUPLE_NOT_READY');
      }
      view.bind();
      view.startAudio();
    },
    async stop() {
      view.stopAudio();
      runtimeClient.disconnect();
    },
  };
}
```

先把 `renderer.js` 和 `scene-layout.js` 从完整 `CONFIG`/domain `sequence.js` 解耦：
`view-config.js` 只导出 renderer 所需的不可变 view projection，
`view-sequence.js` 只承载上述两个无副作用几何 helper；两者都不得反向 import 完整
`config.js`、`sequence.js` 或 domain runtime。再把 `mvp/index.html` production entry 改为
`server-main.js`；`main.js` 和 browser domain files 留在 repository 作为 previous release 源码，
但不进入 production bundle。test-only `shadow-app.js` 导出
`createHistoricalShadowApp({browserRuntime,renderer,ui})`，只复用无 owner 断言的
`createViewApp`/renderer seam，并显式启动 fixture 的 browser runtime；它不得调用
`createServerOwnedApp()`。因此 historical browser-owner shadow 不会触发
`SERVER_OWNER_TUPLE_NOT_READY`，production wrapper 仍保留 server-only assertion。两条入口均不
通过 query/localStorage/client flag 选择 owner。

`build-production-graph.mjs` 是 Task 7、Task 11、Task 12 共用的唯一 graph implementation；
`runtime/test/helpers/import-graph.js` 只做测试适配，不另写 regex parser。Node parser 与 Python
AST extractor 的依赖版本和 lockfile 一起冻结；graph 输出使用 repo-relative POSIX paths、
稳定排序和 canonical SHA-256，供后续 deletion manifest 复验。

- [ ] **Step 4: Add full localhost integration and aggregate script**

`phase5-local.test.js` 启动 fake UDS worker + runtime `127.0.0.1:18090`，连接两个 Runtime WS、
两个 Audio WS 和一个 legacy decoder，验证 one world/one worker/one master timeline。
`phase5-local.spec.js` 验证 UI intent、snapshot、PCM prime、Runtime reconnect、Audio reconnect、
latent preview 和 legacy non-owner reject。

根 `package.json` 增加：

```json
{
  "scripts": {
    "test:surface:shadow": "node --test flock-voice-engine/runtime/test/candidate-surface.test.js mvp/test/backend-owned-boundary.test.js",
    "test:surface:production": "node --test flock-voice-engine/runtime/test/security/production-bundle-boundary.test.js flock-voice-engine/runtime/test/production-graph.test.js",
    "verify:phase5-local": "npm run verify:phase0 && npm run verify:phase12 && npm run verify:phase34 && npm run test:surface:production && npm --prefix flock-voice-engine/runtime test && npm run test:mvp && npm run test:voice && npm run check && npm --prefix flock-voice-engine/runtime run test:e2e -- phase5-local.spec.js"
  }
}
```

保留 `verify:phase12`/`verify:phase34` 当前全部命令，并分别追加
`npm run test:surface:shadow`；不得重写或缩短历史 gate。两个 profile test 通过各自固定
fixture/entry 选择 profile，不依赖进程环境。Phase 5 local gate 另运行
`test:surface:production`，production entry 的迁移不会使 shadow gate 误报。

- [ ] **Step 5: Run GREEN**

```powershell
node --test mvp/test/server-main.test.js mvp/test/view-config.test.js mvp/test/view-sequence.test.js mvp/test/backend-owner-boundary.test.js mvp/test/audio-reconnect.test.js
node --test flock-voice-engine/runtime/test/integration/phase5-local.test.js flock-voice-engine/runtime/test/security/production-bundle-boundary.test.js flock-voice-engine/runtime/test/production-graph.test.js
npm --prefix flock-voice-engine/runtime run test:e2e -- phase5-local.spec.js
npm run verify:phase5-local
```

Expected: all PASS；candidate 只监听 localhost 18090，未访问生产。

- [ ] **Step 6: Commit**

```powershell
git add mvp/index.html mvp/src/view-app.js mvp/src/server-main.js mvp/src/view-config.js mvp/src/view-sequence.js mvp/src/renderer.js mvp/src/scene-layout.js mvp/test/server-main.test.js mvp/test/view-config.test.js mvp/test/view-sequence.test.js mvp/test/backend-owner-boundary.test.js mvp/test/backend-owned-boundary.test.js mvp/test/audio-reconnect.test.js flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js flock-voice-engine/runtime/test/fixtures/candidate-ui/shadow-app.js flock-voice-engine/runtime/test/fixtures/production-graph/graph-fixture.json flock-voice-engine/runtime/test/candidate-surface.test.js flock-voice-engine/runtime/test/integration/phase5-local.test.js flock-voice-engine/runtime/test/security/production-bundle-boundary.test.js flock-voice-engine/runtime/test/production-graph.test.js flock-voice-engine/runtime/test/helpers/import-graph.js flock-voice-engine/runtime/test/e2e/phase5-local.spec.js flock-voice-engine/runtime/tools/build-production-graph.mjs flock-voice-engine/runtime/tools/lib/production-graph.mjs flock-voice-engine/runtime/src/index.js flock-voice-engine/runtime/package.json flock-voice-engine/runtime/package-lock.json package.json
git commit -m "feat(mvp): consume server snapshots and PCM only"
```

**Rollback:** revert production entry in Git；已发布 production 仍未改变。

### Task 8: Two-container release, localhost staging, and identity-aware readiness

**Files:**
- Create: `flock-voice-engine/deploy/Dockerfile.runtime`
- Create: `flock-voice-engine/deploy/Dockerfile.audio`
- Create: `flock-voice-engine/deploy/release.sh`
- Create: `flock-voice-engine/deploy/import-release.sh`
- Create: `flock-voice-engine/deploy/verify-candidate.sh`
- Create: `flock-voice-engine/deploy/requirements-audio.lock`
- Create: `flock-voice-engine/tools/render_cutover_docs.py`
- Create: `flock-voice-engine/tests/test_phase5_deploy_contract.py`
- Create: `flock-voice-engine/runtime/test/release-smoke.test.js`
- Modify: `flock-voice-engine/runtime/src/config.js`
- Modify: `flock-voice-engine/docs/deploy.md`
- Modify: `flock-voice-engine/docs/HANDOFF.md`
- Update outside Git and report separately: `D:/workspace/spark_hackrothon/HANDOFF.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 release manifests, Task 2 worker entry, Task 7 runtime entry and local gate.
- Produces: `release.sh build-local|stage-local|verify-local|package|prepare-cutover-request|import|cutover|rollback|status`;
  `verify-candidate.sh RELEASE_DIR BASE_URL`; managed Phase 5 status blocks in deploy docs.

- [ ] **Step 1: Write failing Docker/release safety tests**

```python
def test_runtime_has_no_gpu_and_audio_has_no_published_port(release_script):
    run = fake_docker(release_script, "stage-local")
    runtime = run.container("flock-runtime-candidate")
    audio = run.container("flock-audio-candidate")
    assert "--gpus" not in runtime.args
    assert runtime.published_ports == ["127.0.0.1:18090:8090"]
    assert audio.args[audio.args.index("--gpus") + 1] == "all"
    assert audio.published_ports == []
    assert runtime.container_bind == "0.0.0.0:8090"

def test_health_without_ready_or_identity_never_succeeds(release_script):
    fake_http.health = 200
    fake_http.ready = 503
    result = run_script(release_script, "verify-local")
    assert result.returncode != 0
    assert "CANDIDATE_NOT_IDENTITY_READY" in result.stderr

@pytest.mark.parametrize("field", ["runtime", "audio"])
def test_build_rejects_missing_or_mutable_base_image_digest(release_script, inputs, field):
    del inputs["baseImages"][field]["digest"]
    result = run_script(release_script, "build-local", inputs=inputs)
    assert result.returncode != 0
    assert "BASE_IMAGE_DIGEST_INVALID" in result.stderr
```

加入 wrong operator、mutable `latest`、missing OCI digest、runtime torch import、UDS mount/mode、
LAN candidate bind、提前 publish 8090、identity mismatch、只 health 不 ready、先 rm previous、
rollback 缺 manifest/image/对应 state record（首次为 reset record，N→N+1 为 snapshot）、
unknown subcommand。另覆盖 direct-local 错用 container bind、
container-local 监听 127.0.0.1、host publish 指向错误 container port、trusted manifest sidecar
缺失/错误、checksum sidecar 内 basename 与实际传入 archive 不一致，以及
`prepare-cutover-request` 在 acceptance/package 完成前或非 `reset-new-world` policy 下失败。
它还必须拒绝 numeric/固定 generation，以及 initial snapshot、bootstrap、`state.replace` 和
cutover request 中 `worldGeneration` 类型或字符串值任一不一致。

- [ ] **Step 2: Run RED**

```powershell
python -m pytest flock-voice-engine/tests/test_phase5_deploy_contract.py -q
node --test flock-voice-engine/runtime/test/release-smoke.test.js
```

Expected: FAIL because Phase 5 deploy files are absent。

- [ ] **Step 3: Implement immutable images and local-only staging**

两个 Dockerfile 的 `FROM` 都只能来自 Task 1 已校验输入，例如
`ARG RUNTIME_BASE_REPOSITORY`、`ARG RUNTIME_BASE_DIGEST` 后
`FROM ${RUNTIME_BASE_REPOSITORY}@${RUNTIME_BASE_DIGEST}`；audio 同理。`release.sh build-local`
只把 schema 校验通过且与 release manifest 完全一致的值作为 build args，Dockerfile 禁止
fallback/tag/default digest。缺失、mutable tag 或 digest 不一致均在调用 Docker 前 fail closed。

`Dockerfile.runtime` 基于该 exact digest Node image，只 COPY runtime/MVP static/release reader，
不安装 Python/torch/CUDA。`Dockerfile.audio` 基于 exact digest Python image，COPY worker code
和 `requirements-audio.lock` 中带 version/hash 的 pinned Python dependencies；vendor/weights/maps/calibration/assets 仍可只读 mount，但必须由
Task 1 manifest 精确覆盖。

`build-local` 从 clean HEAD 用 BuildKit 输出两个 OCI image-layout archive，并同时 load 本地
candidate tag：

```text
.artifacts/phase5-local/images/runtime.oci.tar
.artifacts/phase5-local/images/audio.oci.tar
```

本计划中 `runtimeImageDigest/audioImageDigest` 的唯一定义是：OCI layout `index.json` 选中的
linux/arm64 descriptor 所指向 manifest blob 的 `sha256:<64 hex>` 内容 digest。builder 用
Python 标准库按 descriptor 打开 blob、重算 digest、验证 config/layer descriptors 后写 manifest；
本地 Docker `image inspect .Id` 仅记录为诊断字段 `localEngineImageId`，绝不作为 release identity，
也不要求未 push image 存在 RepoDigest。import 时对 archive 重做同一算法，load 后再核对已加载
config digest 与 OCI manifest 的 config descriptor。

immutable local tags 仍为
`flock-runtime:${CANDIDATE_REVISION}-${SOURCE_SHA12}` 与
`flock-audio:${CANDIDATE_REVISION}-${SOURCE_SHA12}`。只有上述 OCI digest 可回写
`release-manifest.json`；任何 tag 含 `latest` 直接拒绝。完成 manifest 后生成
`release-manifest.json.sha256`，runtime trusted reader 从只读 `/release` 同时读取这两个文件；
sidecar digest 与 import 已验证 release record 必须一致。

`package` 同时输出：

```text
release.tar.zst
release.tar.zst.sha256
import-release.sh
import-release.sh.sha256
```

两个 `.sha256` 都固定写
`<64-lower-hex><two spaces><exact basename>`，package/import/Task 10 传输期间禁止重命名任一
payload 或 sidecar。`import-release.sh` 是最小、独立 bootstrap：先验证自己的 SHA 文件与 archive SHA，再安全解包
到新建临时目录（拒绝 absolute path、`..`、symlink/hardlink 逃逸），验证 release manifest 和
archive 内 `deploy/release.sh` digest 后，才执行该已验证脚本的 `import`。manifest 记录 bootstrap
SHA；生产端不得假定 `/incoming` 预先存在 release script。

`stage-local` 固定：

```text
flock-audio-candidate
  --gpus all
  no published port
  /release:ro
  shared /run/flock-audio

flock-runtime-candidate
  no --gpus
  127.0.0.1:18090:8090
  process profile container-local -> 0.0.0.0:8090 inside container
  /release:ro
  shared /run/flock-audio
```

Task 1–9 的脚本检查 `FLOCK_DEPLOY_SCOPE=local`，拒绝 production IP、8090 host publish、
`/srv/deploy` 和 running container names `flock-runtime`/`flock-audio`。
runtime profile 由不可混用的固定 CLI entry 选择：`direct-local` =
`127.0.0.1:18090`，`container-local` = `0.0.0.0:8090` +
host `127.0.0.1:18090:8090`，`production` = `0.0.0.0:8090` + host 8090；Task 1–9 的
parser 明确拒绝 `production`。不得用通用 `HOST`/`PORT` 环境变量覆盖 profile。

- [ ] **Step 4: Implement exact `/readyz` verification and managed docs**

`verify-candidate.sh` 读取 release manifest，依次核对 `/healthz`、`/readyz`：

```python
assert ready["runtimeOwner"] == "server"
assert ready["audioOwner"] == "world"
assert ready["workerReady"] is True
assert ready["workerIdentity"]["expected"] == ready["workerIdentity"]["reported"]
assert ready["workerIdentity"]["expected"] == release["workerIdentity"]
assert ready["phaseGate"] in {"phase5-local", "phase5-production"}
```

随后执行 bootstrap、Runtime WS、Audio WS golden cursor、legacy read-only smoke。任何一步失败，
script exit nonzero 且保留 previous release。

在 Git 内 `flock-voice-engine/docs/HANDOFF.md` 与 `flock-voice-engine/docs/deploy.md` 增加
`phase5-managed-status` fenced block，初始明确“未切换、生产仍为 legacy”。未来 Task 10 的
`render_cutover_docs.py` 只根据 digest-attested cutover record 更新该块，不改其它人工内容。
权威外部 `D:/workspace/spark_hackrothon/HANDOFF.md` 使用同一 renderer 单独更新并单独报告，
它不属于 worktree，绝不出现在 `git add` 或 commit 中。

```powershell
python flock-voice-engine/tools/render_cutover_docs.py `
  --initial-status legacy-not-cut-over `
  --handoff flock-voice-engine/docs/HANDOFF.md `
  --deploy-doc flock-voice-engine/docs/deploy.md
python flock-voice-engine/tools/render_cutover_docs.py `
  --initial-status legacy-not-cut-over `
  --handoff D:/workspace/spark_hackrothon/HANDOFF.md
```

- [ ] **Step 5: Run GREEN using only `.artifacts` and loopback**

```powershell
python -m pytest flock-voice-engine/tests/test_phase5_deploy_contract.py -q
node --test flock-voice-engine/runtime/test/release-smoke.test.js
bash flock-voice-engine/deploy/release.sh build-local `
  --inputs .artifacts/phase5-inputs/audio-inputs.json `
  --output .artifacts/phase5-local
bash flock-voice-engine/deploy/release.sh stage-local `
  --release-dir .artifacts/phase5-local
bash flock-voice-engine/deploy/release.sh verify-local `
  --release-dir .artifacts/phase5-local `
  --base-url http://127.0.0.1:18090
npm run verify:phase5-local
```

Expected: 若受控真实 inputs 尚未由用户放入 `.artifacts/phase5-inputs`，`build-local` 必须以
`AUDIO_INPUTS_MISSING` 停止，后续命令不得执行。inputs 存在且全部 digest 正确时，所有命令
exit 0，只有 loopback 18090 listener。

- [ ] **Step 6: Commit**

```powershell
git add flock-voice-engine/deploy/Dockerfile.runtime flock-voice-engine/deploy/Dockerfile.audio flock-voice-engine/deploy/release.sh flock-voice-engine/deploy/import-release.sh flock-voice-engine/deploy/verify-candidate.sh flock-voice-engine/deploy/requirements-audio.lock flock-voice-engine/tools/render_cutover_docs.py flock-voice-engine/tests/test_phase5_deploy_contract.py flock-voice-engine/runtime/test/release-smoke.test.js flock-voice-engine/runtime/src/config.js flock-voice-engine/docs/deploy.md flock-voice-engine/docs/HANDOFF.md package.json
git commit -m "feat(deploy): stage identity-checked audio releases"
```

**Rollback:** stop/delete only local candidate containers and revert；production 8090 不变。

### Task 9: Fault injection, equivalent-host load, and cutover acceptance

**Files:**
- Create: `flock-voice-engine/release/acceptance.schema.json`
- Create: `flock-voice-engine/release/machine-attestation.schema.json`
- Create: `flock-voice-engine/tools/stress_audio_worker.py`
- Create: `flock-voice-engine/tools/capture_machine_attestation.py`
- Create: `flock-voice-engine/tools/validate_phase5_acceptance.py`
- Create: `flock-voice-engine/runtime/tools/soak-phase5.mjs`
- Create: `flock-voice-engine/runtime/playwright.phase5-acceptance.config.js`
- Create: `flock-voice-engine/runtime/test/phase5-faults.integration.test.js`
- Create: `flock-voice-engine/runtime/test/phase5-soak.test.js`
- Create: `flock-voice-engine/tests/test_phase5_acceptance.py`
- Create: `flock-voice-engine/tests/test_machine_attestation.py`
- Modify: `flock-voice-engine/deploy/release.sh`
- Modify: `flock-voice-engine/deploy/release_control.py`
- Modify: `flock-voice-engine/runtime/test/e2e/phase5-local.spec.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: complete Task 8 local release and user-supplied
  `.artifacts/phase5-inputs/staging-equivalence.json` plus independently captured
  `.artifacts/phase5-inputs/production-machine-attestation.json`.
- Produces on an isolated equivalent Spark only: `.artifacts/phase5-local/acceptance.json`;
  `.artifacts/phase5-local/staging-machine-attestation.json`;
  local fake runs produce only `.artifacts/phase5-local/fault-smoke.json`;
  `validate_acceptance(value, release_manifest) -> None`;
  `npm run verify:phase5-acceptance`.

- [ ] **Step 1: Turn the real-GPU staging unknown into a fail-closed contract**

`staging-equivalence.json` schema 固定要求：

```json
{
  "schemaVersion": 1,
  "kind": "isolated-equivalent-spark",
  "productionMachineAttestationSha256": "<64-lower-hex>",
  "gpuModel": "NVIDIA GB10",
  "architecture": "aarch64",
  "sampleRate": 44100,
  "blockFrames": 4096,
  "poolSize": 5,
  "speciesLoadEndpoint": "http://127.0.0.1:8081/v1",
  "speciesModel": "bird_agent"
}
```

`capture_machine_attestation.py` 必须直接从当前 kernel/host 读取并分别 hash：

```json
{
  "schemaVersion": 1,
  "machineIdSha256": "<sha256-of-/etc/machine-id-bytes>",
  "sshHostKeySha256": "<SHA256 fingerprint of ed25519 host public key>",
  "canonicalInterfaceAddresses": ["<sorted canonical non-loopback/non-link-local unicast IPv4/IPv6>"],
  "gpuUuids": ["<sorted NVIDIA GPU UUID>"],
  "rawEvidence": {
    "machineId": "<file-sha256>",
    "sshHostKey": "<file-sha256>",
    "interfaces": "<capture-sha256>",
    "gpus": "<capture-sha256>"
  }
}
```

production attestation 由 owner 在本计划外只读采集并交付，`staging-equivalence.json` 固定它的
文件 digest；staging attestation 必须由 gate 当场采集，不能接受调用者直接传 JSON。validator
要求两份 attestation schema/digest 均正确，并拒绝相等的 machine-id、SSH host key、任一 GPU UUID
或任一 canonical production interface address（尤其 `192.168.9.140`）；hostname 只能作为诊断，不能作为
身份判据。它还要求 evidence 包含 CUDA/driver/torch、available memory、vLLM normal/burst profile
采样文件 SHA。文件缺失、原始 evidence digest 不符或任一稳定 machine identity 相交时返回
`EQUIVALENT_STAGING_REQUIRED`。`productionWritesAllowed:false` 之类自声明字段不参与证明。
本计划不允许以“维护窗口先停旧”
绕过 pre-cutover 真实门禁，因为那会让 Task 10 之前发生生产写。
上述 geometry 是本次 release manifest 的实例值；validator 从 manifest 比对，不把 5/4096/rows
编译成 acceptance schema 常量。

`canonicalInterfaceAddresses` 只能由 capture tool 对 raw interface evidence 计算，不能由调用者
填写：IPv6 先去掉 zone suffix，再用 Python `ipaddress.ip_address()` 解析；IPv4-mapped IPv6
规范成 IPv4，普通 IPv6 使用压缩小写形式；排除 loopback（整个 `127.0.0.0/8`、`::1`）、link-local
（`169.254.0.0/16`、`fe80::/10`）、unspecified 和 multicast，保留 RFC1918/ULA 等实际可路由
私网地址，去重后按 binary address 稳定排序。machine separation 只比较该 canonical set；
`127.0.0.1`、`::1` 和 link-local 等普遍地址仅留在 raw evidence，不得造成 host collision。
过滤结果为空、attestation 字段不是 canonical 输出或 production/staging canonical set 有交集均
fail closed。

- [ ] **Step 2: Write failing fault and acceptance tests**

```js
test('worker crash never rebuilds world and emits one stream boundary', async () => {
  const before = session.kernel.getSnapshot();
  fakeWorker.crash();
  await supervisor.waitForReady();
  assert.equal(session.kernel.getSnapshot().worldGeneration, before.worldGeneration);
  assert.equal(discontinuities.filter((x) => x.scope === 'stream').length, 1);
  assert.notEqual(supervisor.getStatus().audioEpoch, 'old-epoch');
});
```

```python
def test_acceptance_rejects_idle_gpu_numbers(tmp_path, release_manifest):
    result = valid_acceptance()
    result["speciesLoad"]["normalRequests"] = 0
    result["speciesLoad"]["burstRequests"] = 0
    with pytest.raises(AcceptanceError, match="SPECIES_LOAD_EVIDENCE_REQUIRED"):
        validate_acceptance(result, release_manifest)

def test_fake_local_evidence_can_never_satisfy_cutover(release_manifest):
    result = valid_acceptance()
    result["environment"]["kind"] = "local-fake"
    with pytest.raises(AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        validate_acceptance(result, release_manifest)

def test_same_machine_id_fails_even_when_hostname_differs(attestations):
    production, staging = attestations
    staging["hostname"] = "different-name"
    staging["machineIdSha256"] = production["machineIdSha256"]
    with pytest.raises(AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        validate_machine_separation(production, staging)

def test_shared_loopback_and_link_local_addresses_are_ignored():
    production = [
        "127.0.0.1", "::1", "169.254.10.20", "fe80::1%eth0", "192.168.9.140",
    ]
    staging = [
        "127.0.0.1", "::1", "169.254.10.20", "fe80::1%eth1", "192.168.9.141",
    ]
    assert canonical_machine_addresses(production) == ["192.168.9.140"]
    assert canonical_machine_addresses(staging) == ["192.168.9.141"]
    assert_machine_address_sets_are_distinct(production, staging)

def test_canonical_nonlocal_address_collision_still_fails():
    with pytest.raises(AcceptanceError, match="EQUIVALENT_STAGING_REQUIRED"):
        assert_machine_address_sets_are_distinct(
            ["::ffff:192.168.9.140"],
            ["192.168.9.140"],
        )
```

加入 identity tamper、worker stall、replace timeout、edge overflow、PCM corruption、slow writer、
lease disconnect、8081 provider timeout、world continues、wrong release tuple、short duration、
wrong pool/block、missing raw percentile samples。
machine identity tests 还覆盖 production IP 在 staging 次要网卡、相同 SSH host key、共享 GPU UUID、
attestation 文件 digest 错、raw evidence 被替换、过滤后为空、非 canonical address field 和
capture tool 缺权限；全部 fail closed。

- [ ] **Step 3: Run RED**

```powershell
node --test flock-voice-engine/runtime/test/phase5-faults.integration.test.js flock-voice-engine/runtime/test/phase5-soak.test.js
python -m pytest flock-voice-engine/tests/test_phase5_acceptance.py flock-voice-engine/tests/test_machine_attestation.py -q
```

Expected: FAIL with missing tools/schema/tests dependencies。

- [ ] **Step 4: Implement deterministic fault runner and acceptance validator**

`stress_audio_worker.py` 支持 fake/real backend，但 real 模式必须读取 release manifest。计时范围固定
command drain 开始到 PCM ring publish 完成。`soak-phase5.mjs` 创建 4 个 Runtime/Audio client，
client 4 每 5 秒 pause read 2 秒；其余 3 个持续校验 cursor/underrun/reconnect。

acceptance hard thresholds：

```json
{
  "durationMinutes": 30,
  "clients": 4,
  "slowClients": 1,
  "hotClientAbnormalCloses": 0,
  "hotClientReconnectStorms": 0,
  "hotClientUnderruns": 0,
  "runtimeReadyP95MsMax": 1000,
  "uiStateLagP95MsMax": 150,
  "renderP95BlockFractionMax": 0.70,
  "renderP99BlockFractionMax": 0.90
}
```

还必须记录 normal/burst 8081 load request count/latency/error、四 species audible probe、demo/tracks/
new UI sequential lease、release tuple、raw samples SHA 和 operator listening checklist。另固定
`surfaceProfile="production-fixed-entry"`、production multi-root graph digest、真实 Chromium
`phase5-local.spec.js` JSON result digest、staging/production machine attestation digest。shadow
fixture、fake browser、环境变量选 profile 或缺 E2E evidence 均不能签 acceptance。

- [ ] **Step 5: Run fake GREEN locally, then real GREEN only on isolated equivalent host**

Local deterministic gate：

```powershell
node --test flock-voice-engine/runtime/test/phase5-faults.integration.test.js flock-voice-engine/runtime/test/phase5-soak.test.js
python -m pytest flock-voice-engine/tests/test_phase5_acceptance.py flock-voice-engine/tests/test_machine_attestation.py -q
python flock-voice-engine/tools/stress_audio_worker.py `
  --backend fake --duration-seconds 60 `
  --release-dir .artifacts/phase5-local `
  --output .artifacts/phase5-local/fault-smoke.json
```

fake runner 的 schema 与文件名均不同于 acceptance；它不得写、复制、补全或被 validator
提升为 `acceptance.json`。`validate_acceptance` 必须核对环境 evidence 的
`kind=isolated-equivalent-spark`、host attestation 与 digest，任何 fake/local 标记永久拒绝。

Equivalent-host gate（soak gate 自行运行固定 acceptance Playwright config、生成 Chromium/lease
evidence，并在长测末尾用当次 normal/burst raw profile 现场采集 staging machine attestation；调用者
不得预先创建这些输出）：

```powershell
node flock-voice-engine/runtime/tools/soak-phase5.mjs `
  --base-url http://127.0.0.1:18090 `
  --species-base-url http://127.0.0.1:8081/v1 `
  --species-model bird_agent `
  --clients 4 --slow-client 4 --duration-minutes 30 `
  --surface-profile production-fixed-entry `
  --production-attestation .artifacts/phase5-inputs/production-machine-attestation.json `
  --staging-attestation .artifacts/phase5-local/staging-machine-attestation.json `
  --production-graph .artifacts/phase5-local/production-graph.json `
  --release .artifacts/phase5-local/release-manifest.json `
  --release-revision (git rev-parse HEAD) `
  --operator '<operator-id>' `
  --listening-checklist .artifacts/phase5-local/listening-checklist.json `
  --output .artifacts/phase5-local/acceptance.json
python flock-voice-engine/tools/validate_phase5_acceptance.py `
  --acceptance .artifacts/phase5-local/acceptance.json `
  --release .artifacts/phase5-local/release-manifest.json `
  --equivalence .artifacts/phase5-inputs/staging-equivalence.json
bash flock-voice-engine/deploy/release.sh package `
  --release-dir .artifacts/phase5-local
```

Expected: all thresholds pass，`release.tar.zst` 与 SHA-256 生成。无等价 staging evidence 时明确
阻塞 Task 10，不能在生产主机补测。这是明确的外部环境 blocker；本地 fake 全绿只能证明
故障 runner 可工作，绝不满足 cutover gate。

- [ ] **Step 6: Add the aggregate gate**

根 `package.json` 增加：

script 必须把 machine-attestation tests 和 artifact validator 纳入，不允许 aggregate 只跑
validator 的 unit tests：

```json
{
  "scripts": {
    "verify:phase5-acceptance": "npm run verify:phase5-local && node --test flock-voice-engine/runtime/test/phase5-faults.integration.test.js flock-voice-engine/runtime/test/phase5-soak.test.js && python -m pytest flock-voice-engine/tests/test_phase5_acceptance.py flock-voice-engine/tests/test_machine_attestation.py -q && python flock-voice-engine/tools/validate_phase5_acceptance.py --acceptance .artifacts/phase5-local/acceptance.json --release .artifacts/phase5-local/release-manifest.json --equivalence .artifacts/phase5-inputs/staging-equivalence.json"
  }
}
```

```powershell
npm run verify:phase5-acceptance
```

Expected: exit 0。

- [ ] **Step 7: Commit**

```powershell
git add flock-voice-engine/release/acceptance.schema.json flock-voice-engine/release/machine-attestation.schema.json flock-voice-engine/tools/stress_audio_worker.py flock-voice-engine/tools/capture_machine_attestation.py flock-voice-engine/tools/validate_phase5_acceptance.py flock-voice-engine/runtime/tools/soak-phase5.mjs flock-voice-engine/runtime/test/phase5-faults.integration.test.js flock-voice-engine/runtime/test/phase5-soak.test.js flock-voice-engine/tests/test_phase5_acceptance.py flock-voice-engine/tests/test_machine_attestation.py flock-voice-engine/deploy/release.sh package.json
git commit -m "test(audio): gate cutover on shared-load stability"
```

**Rollback:** stop isolated staging candidate；生产不变。

### Task 10: Historical draft — do not execute

> 本节命令不包含 2026-07-28 reconciliation 要求的 request bundle、activation grant、
> trusted launch roles、single active-set replace 与 transaction-stable record，禁止复制执行。
> 唯一后续入口是
> `docs/superpowers/plans/2026-07-28-phase5-production-control-reconciliation.md`
> 的 Task 13–14。

**Files:**
- Create after operation: `docs/releases/phase5-cutover-record.json`
- Create after operation: `docs/releases/phase5-cutover-record.json.sha256`
- Modify after successful operation: `flock-voice-engine/docs/HANDOFF.md`
- Modify after successful operation: `flock-voice-engine/docs/deploy.md`
- Update outside Git after operation and report separately: `D:/workspace/spark_hackrothon/HANDOFF.md`

**Interfaces:**
- Consumes: Task 9 packaged release/acceptance, Task 8 `release.sh`, exact user authorization.
- Produces: production owner tuple `(server,world)`, one runtime on 8090, one audio worker, digest-attested
  cutover record, preserved previous legacy release, and an explicit server-owned initial snapshot.
  首次 browser-owner→server-owner cutover 不声称该 snapshot 来自 legacy/browser world。

- [ ] **Step 1: Stop and obtain exact user authorization**

Before any SSH/scp/remote Docker or remote file write, report candidate:

```powershell
bash flock-voice-engine/deploy/release.sh prepare-cutover-request `
  --release-dir .artifacts/phase5-local `
  --state-policy reset-new-world `
  --output .artifacts/phase5-local/cutover-request.json
$authorizedTuple = Get-Content -Raw -Encoding UTF8 `
  .artifacts/phase5-local/cutover-request.json | ConvertFrom-Json
```

该 local-only command 复验 release、archive、bootstrap 与 acceptance digest，在隔离 local
candidate 上启动真实 server-owned `WorldSession`，执行首次
`commit('initial-world', initialMutation)`，随后通过同一 mailbox barrier 调
`requestSnapshot()`。它验证 snapshot envelope 的 `worldGeneration` 是 canonical UUID 语法的
非空 opaque string，且 `worldId/revision/eventSeq/protocolVersion/snapshotSchemaVersion` 完整，
再冻结完整 initial snapshot 和 digest；不得用纯 DTO initializer、数字 `1` 或测试
`worldGenerationFactory` 伪造。随后显示：

```text
releaseRevision
sourceManifestSha256
audioArtifactSha256
runtimeImageDigest
audioImageDigest
acceptanceSha256
releaseArchiveSha256
importBootstrapSha256
previousReleaseIdentity
stateMigrationPolicy=reset-new-world
newWorldId
newWorldGeneration  // JSON string; exact UUID from initial snapshot
initialWorldSha256
```

Ask the user to explicitly authorize this exact operation:
`AUTHORIZE_PHASE5_8090_ATOMIC_CUTOVER` for the displayed tuple，包括明确接受当前浏览器
authoritative world 不会迁移、所有客户端在 cutover 后进入上述新 world。`newWorldId`、seed、
config revision、opaque string `newWorldGeneration` 和 canonical `initialWorldSha256` 必须在询问
授权前由上述实际 initial commit/snapshot 生成并固定，授权后不得重算。cutover request、
snapshot envelope、bootstrap、`state.replace.world.worldGeneration` 和最终 cutover record
必须保持同一个 string；任一 number 或值漂移都 fail closed。A prior request to write the plan,
build locally, “finish”, or “deploy when ready” is not authorization. If the user does not authorize,
end Task 10 without any production command.

- [ ] **Step 2: After authorization, run read-only production preflight**

```powershell
$spark = 'yfhuang@192.168.9.140'
ssh $spark 'id -un; docker ps --format "{{.Names}} {{.Status}} {{.Ports}}"; curl -fsS --noproxy "*" http://127.0.0.1:8090/healthz; curl -fsS --noproxy "*" http://127.0.0.1:8081/v1/models'
```

Expected: operator `yfhuang`；8090 当前 owner 与 previous manifest 一致；8081 model list 含
`bird_agent`；8083 未被命令读取或修改。任何差异停止并重新评审。

- [ ] **Step 3: Transfer/import the exact package and save rollback inputs**

这是本计划第一次生产写：

```powershell
ssh $spark 'install -d -m 0750 /srv/deploy/flock-release-incoming'
scp .artifacts/phase5-local/release.tar.zst `
  ${spark}:/srv/deploy/flock-release-incoming/release.tar.zst
scp .artifacts/phase5-local/release.tar.zst.sha256 `
  ${spark}:/srv/deploy/flock-release-incoming/release.tar.zst.sha256
scp .artifacts/phase5-local/import-release.sh `
  ${spark}:/srv/deploy/flock-release-incoming/import-release.sh
scp .artifacts/phase5-local/import-release.sh.sha256 `
  ${spark}:/srv/deploy/flock-release-incoming/import-release.sh.sha256
$archiveSha = (Get-FileHash -Algorithm SHA256 .artifacts/phase5-local/release.tar.zst).Hash.ToLowerInvariant()
$bootstrapSha = (Get-FileHash -Algorithm SHA256 .artifacts/phase5-local/import-release.sh).Hash.ToLowerInvariant()
if ($archiveSha -ne $authorizedTuple.releaseArchiveSha256) { throw 'AUTHORIZED_ARCHIVE_DIGEST_MISMATCH' }
if ($bootstrapSha -ne $authorizedTuple.importBootstrapSha256) { throw 'AUTHORIZED_BOOTSTRAP_DIGEST_MISMATCH' }
ssh $spark "cd /srv/deploy/flock-release-incoming && printf '%s  %s\n' '$archiveSha' 'release.tar.zst' | sha256sum -c -"
ssh $spark "cd /srv/deploy/flock-release-incoming && printf '%s  %s\n' '$bootstrapSha' 'import-release.sh' | sha256sum -c -"
ssh $spark 'bash /srv/deploy/flock-release-incoming/import-release.sh --archive /srv/deploy/flock-release-incoming/release.tar.zst --archive-sha /srv/deploy/flock-release-incoming/release.tar.zst.sha256 --release-root /srv/deploy/flock-releases'
```

bootstrap 按 Task 8 规则安全解包并验证 archive 内 release script 后，`import` 验证
acceptance/manifest/image digests，创建 candidate link，保留 current/previous image
digests；不停止当前服务。当前首次 cutover 的 authoritative world 位于各浏览器，既没有全局
一致导出点，也没有 Node snapshot；因此 import **不得**调用或记录“authoritative runtime
snapshot”。它只保存旧 legacy release/image/static bundle 作为 rollback 输入，并验证授权 tuple
中的 `reset-new-world` server-owned initial snapshot；该 snapshot 是新 world 的启动输入，不是
旧 browser world 的迁移产物。未来 server-owner N→N+1 升级才迁移当前 authoritative snapshot。
远端 sidecar 用于完整性与 bootstrap 内复验，但执行 bootstrap 前的信任锚是用户已授权 tuple 中的
`importBootstrapSha256/releaseArchiveSha256`；不得仅凭一起传输的 payload+sidecar 自证。

- [ ] **Step 4: Execute the single cutover transaction**

```powershell
ssh $spark 'bash /srv/deploy/flock-release-candidate/source/flock-voice-engine/deploy/release.sh cutover --release-root /srv/deploy/flock-releases --candidate-link /srv/deploy/flock-release-candidate --current-link /srv/deploy/flock-release-current --previous-link /srv/deploy/flock-release-previous --confirm AUTHORIZE_PHASE5_8090_ATOMIC_CUTOVER'
```

script 内顺序固定：

1. 记录 old owner marker，停止接受旧 8090 新连接；明确不导出 browser world；
2. stop old Python 8090；
3. start candidate singleton audio worker；
4. 从 digest-attested `reset-new-world` authorized initial snapshot 恢复 candidate，并验证恢复后
   `worldGeneration` 与授权 tuple 是同一个 opaque string；runtime 容器内
   `0.0.0.0:8090`，host 仅临时 publish `127.0.0.1:18090:8090`；
5. wait identity/warmup/initial state.replace/post-applied PCM prime/`/readyz`；核对 bootstrap、
   state.replace、snapshot 与 status 的 worldGeneration 类型和值后运行 localhost smoke；
6. recreate only runtime container with production profile：容器内仍为 `0.0.0.0:8090`，host
   publish 8090；audio worker 不重启；
7. verify 8090 exact identity、Runtime WS、Audio WS golden cursor、legacy routes；
8. atomically move previous/current links，owner tuple 变为 `(server,world)`。

任何一步失败自动运行 rollback；禁止只保留 `/decoder`、UI、world 或 audio 的一部分。

- [ ] **Step 5: Verify production identity and rollback readiness**

```powershell
ssh $spark 'bash /srv/deploy/flock-release-current/source/flock-voice-engine/deploy/release.sh status --release-root /srv/deploy/flock-releases --base-url http://127.0.0.1:8090'
ssh $spark 'docker ps --format "{{.Names}} {{.Status}} {{.Ports}}"'
```

Expected: only `flock-runtime` binds 8090；only `flock-audio` has GPU；old Python GPU container stopped；
`/readyz=200` 且 expected/reported tuple 精确等于 current manifest；default
`runtimeOwner=server,audioOwner=world`。

若验证失败，运行 exact rollback：

```powershell
ssh $spark 'bash /srv/deploy/flock-release-current/source/flock-voice-engine/deploy/release.sh rollback --release-root /srv/deploy/flock-releases --current-link /srv/deploy/flock-release-current --previous-link /srv/deploy/flock-release-previous --confirm AUTHORIZE_PHASE5_8090_ATOMIC_ROLLBACK'
```

rollback 停新 runtime/worker，以 previous digest 启动旧 Python 8090 + legacy browser bundle，
验证 legacy 六字段 identity 和 decoder smoke，并明确由每个重新连接的 legacy browser 重建
自己的 world；首次 cutover 没有来自旧 browser world 的 authoritative server snapshot 可导入。
rollback 不得把新 server-owned initial snapshot 导入 legacy browser；该 snapshot 只属于失败的
candidate/new-world 前滚链。

- [ ] **Step 6: Generate the release record and update managed docs**

```powershell
New-Item -ItemType Directory -Force -Path docs/releases | Out-Null
scp ${spark}:/srv/deploy/flock-release-current/cutover-record.json `
  docs/releases/phase5-cutover-record.json
scp ${spark}:/srv/deploy/flock-release-current/cutover-record.json.sha256 `
  docs/releases/phase5-cutover-record.json.sha256
(Get-FileHash -Algorithm SHA256 docs/releases/phase5-cutover-record.json).Hash.ToLowerInvariant() `
  | ForEach-Object {
      if (-not (Select-String -Quiet -SimpleMatch $_ docs/releases/phase5-cutover-record.json.sha256)) {
        throw 'CUTOVER_RECORD_DIGEST_MISMATCH'
      }
    }
python flock-voice-engine/tools/render_cutover_docs.py `
  --record docs/releases/phase5-cutover-record.json `
  --handoff flock-voice-engine/docs/HANDOFF.md `
  --deploy-doc flock-voice-engine/docs/deploy.md
python flock-voice-engine/tools/render_cutover_docs.py `
  --record docs/releases/phase5-cutover-record.json `
  --handoff D:/workspace/spark_hackrothon/HANDOFF.md
python -m json.tool docs/releases/phase5-cutover-record.json > $null
git diff --check
```

Expected: digest-attested record 含 exact release/previous tuple、`reset-new-world`、
opaque string `newWorldGeneration`、`initialWorldSha256`、timestamps、operator、smoke，
且 record generation 与授权 initial snapshot envelope 精确相等；
outcome；无凭据。若自动 rollback，record 的 outcome 必须是 `rolled-back`，文档继续声明 legacy
owner，不得写成成功。

- [ ] **Step 7: Commit**

```powershell
git add docs/releases/phase5-cutover-record.json docs/releases/phase5-cutover-record.json.sha256 flock-voice-engine/docs/HANDOFF.md flock-voice-engine/docs/deploy.md
git commit -m "docs(release): record phase5 audio cutover"
```

外部 `D:/workspace/spark_hackrothon/HANDOFF.md` 的 diff 和更新结果单独报告；不得 `git add`、
复制进 worktree 或声称它包含在上述 commit。

**Rollback:** 上述 `release.sh rollback` 是唯一允许的整体 rollback；目标五分钟内完成。

### Task 11: Phase 6 stability window and successful-release-cycle gate

**Files:**
- Create: `flock-voice-engine/release/phase6-policy.json`
- Create: `flock-voice-engine/release/phase6-test-migration.schema.json`
- Create: `flock-voice-engine/release/phase6-test-migration.json`
- Create: `flock-voice-engine/release/phase6-source-retirement.schema.json`
- Create: `flock-voice-engine/release/phase6-source-retirement.json`
- Create: `flock-voice-engine/runtime/tools/verify-stability-window.mjs`
- Create: `flock-voice-engine/runtime/tools/verify-phase6-migration.mjs`
- Create: `flock-voice-engine/runtime/test/phase6-removal-gate.test.js`
- Create: `flock-voice-engine/runtime/test/phase6-test-migration.test.js`
- Create: `docs/releases/phase6-stability-record.json`
- Create: `docs/releases/phase6-stability-record.json.sha256`
- Modify: `flock-voice-engine/runtime/domain-migration.json`
- Modify: `flock-voice-engine/runtime/domain-test-migration.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: Phase 5 current release N、一个成功的新架构 N→N+1 发布、previous N manifest、
  current world snapshot and 24-hour telemetry.
- Produces: `verifyStabilityWindow({policy,current,previous,telemetry,snapshot})`;
  `verifyTestMigration({ledger,productionGraph,testInventory,sourceRetirement,domainMigration})`;
  digest-attested `phase6-stability-record.json`; a validated deletion manifest;
  `npm run verify:phase6-gate`.

- [ ] **Step 1: Freeze policy and write failing gate tests**

`phase6-policy.json`：

```json
{
  "schemaVersion": 1,
  "minimumObservationHours": 24,
  "minimumSuccessfulServerOwnerUpgrades": 1,
  "requirePreviousRelease": true,
  "requireCurrentWorldSnapshot": true,
  "maximumAbnormalCloseCount": 0,
  "maximumReconnectStormCount": 0,
  "maximumAudioUnderrunCount": 0
}
```

```js
test('first Phase 5 release cannot remove legacy', () => {
  assert.throws(() => verifyStabilityWindow({
    policy, current: releaseN, previous: legacyRelease,
    telemetry: hours(24), snapshot,
  }), /PHASE6_SERVER_OWNER_UPGRADE_REQUIRED/);
});

test('N to N+1 plus 24 clean hours permits removal', () => {
  const result = verifyStabilityWindow({
    policy, current: releaseN1, previous: releaseN,
    telemetry: cleanHours(24), snapshot,
  });
  assert.equal(result.allowed, true);
});
```

加入 identity mismatch、missing previous image、snapshot digest 错、23.99 小时、underrun、
runtimeOwner 非 server、audioOwner 非 world。

同一步写 `phase6-test-migration.test.js`：枚举将退役实现对应的每个既有 test file 和 test name，
要求每条记录给出 `legacyTest`、`coverageId` 和 `status="retired"|"retained"`；retired 记录还
必须有 `retireAfterReplacement=true` 与至少一个
`replacementTest={path,testName}`，并验证 replacement 当前实际存在且已通过。retained 高价值
测试必须有不可为空的 retain reason。空映射、重复
coverageId、只写文件不写 test name、replacement 被 skipped/non-runnable、或生产 import graph 仍引用
待删 source 均 fail closed。ledger 还明确记录保留的 renderer/UI tests，不允许把“删实现”解释为
整批删除高价值测试。

同一步冻结 `phase6-source-retirement.json`：它逐个 exact file 枚举 Task 7 multi-root graph 之外
仍留在 repository 的所有 browser domain/audio/LLM/master、legacy client/route/deploy entry 和
legacy-only test，字段固定为：

```json
{
  "path": "mvp/src/world.js",
  "kind": "source",
  "currentOwner": "browser",
  "replacementPath": "flock-voice-engine/runtime/src/domain/world.js",
  "replacementOwner": "server",
  "status": "retired",
  "retireAfterGate": "phase6"
}
```

保留文件也必须显式列为 `status="retained"` 并给 reason，避免 inventory 新文件默默落在 ledger
之外。inventory 至少穷尽 `mvp/src/**`、`flock-voice-engine/client/**`、
`flock-voice-engine/server/app.py`、legacy deploy entry，以及所有直接或间接引用这些路径的 tests；
每个 literal file 必须恰好出现一次。schema 禁止 directory/glob、重复 path、未知 status、
缺 replacement 或自引用。
`domain-migration.json` 升级到 `schemaVersion=2` authoritative 状态：
`behaviorOwner="runtime/src"`、`candidateMode="authoritative"`、`deleteByPhase=6`，每条原
`source/candidate` pair 增加
`sourceStatus="retired"`、`candidateStatus="retained"`、`retireAfterGate="phase6"`；
`domain-test-migration.json` 同样升到 schema v2，并记录每个旧测试的
retained/replaced/retired 状态。两份 domain
ledger 与 exhaustive source/test ledger 必须逐 path 双向一致，不能只覆盖 deterministic 子集。

- [ ] **Step 2: Run RED**

```powershell
node --test flock-voice-engine/runtime/test/phase6-removal-gate.test.js flock-voice-engine/runtime/test/phase6-test-migration.test.js
```

Expected: FAIL with missing verifier/policy。

- [ ] **Step 3: Implement verifier and aggregate command**

stability verifier 只接受两个连续、不同 revision、都为 server-owner 且都通过 Phase 5 acceptance 的 release；
telemetry 时间窗必须覆盖 N+1 ready 后连续 24 小时。previous image/manifest 与 current snapshot
必须可读并通过 digest。

`verify-phase6-migration.mjs` 在 legacy 文件仍存在时调用 Task 7 唯一
`buildProductionGraph()`，roots 固定为 `mvp/index.html`、
`flock-voice-engine/runtime/src/index.js` 和
`flock-voice-engine/server/audio_worker/__main__.py`；HTML/Node/Python/dynamic import/
Worker/AudioWorklet/fetch/static asset 任一 unresolved edge 都 fail closed。它读取实际 source/test
inventory、source retirement、domain migration 和 test ledger，逐个运行 ledger 指向的 replacement
tests；全部通过后才生成
`.artifacts/phase6-removal-paths.json`。删除 manifest 只能包含同时满足三项的路径：

1. production graph 已不引用；
2. 被 exhaustive source retirement 明确标记为 retired；domain path 还必须在
   `domain-migration.json` 中以相同 replacement 明确 retired；
3. 其全部既有测试均在 ledger 中映射到通过的 runtime/worker contract test。

manifest 的路径集合必须与 source ledger 中
`status=retired && retireAfterGate=phase6` 和 test ledger 中
`status=retired && retireAfterReplacement=true` 的并集
完全相等，不能是子集或超集；每项都记录 source ledger digest、test ledger digest、domain ledger
digest、production graph digest 和当前 HEAD。任一仓库 legacy inventory 未登记、待删 test/source
未映射、replacement 未通过、Python worker graph 触达 `server/app.py` 或 graph 不可解析都不生成
manifest。`server/backend_factory.py` 必须在 Python production closure 内且标记 retained。

根 `package.json` 增加：

```json
{
  "scripts": {
    "verify:phase6-gate": "npm run verify:phase5-acceptance && node --test flock-voice-engine/runtime/test/phase6-removal-gate.test.js flock-voice-engine/runtime/test/phase6-test-migration.test.js flock-voice-engine/runtime/test/production-graph.test.js && node flock-voice-engine/runtime/tools/verify-phase6-migration.mjs --test-ledger flock-voice-engine/release/phase6-test-migration.json --source-ledger flock-voice-engine/release/phase6-source-retirement.json --domain-ledger flock-voice-engine/runtime/domain-migration.json --output .artifacts/phase6-removal-paths.json"
  }
}
```

- [ ] **Step 4: Run GREEN only after a successful N→N+1 release**

```powershell
node flock-voice-engine/runtime/tools/verify-stability-window.mjs `
  --policy flock-voice-engine/release/phase6-policy.json `
  --current-manifest .artifacts/releases/current/release-manifest.json `
  --previous-manifest .artifacts/releases/previous/release-manifest.json `
  --telemetry .artifacts/releases/current/stability-24h.json `
  --snapshot .artifacts/releases/current/world-snapshot.json `
  --output docs/releases/phase6-stability-record.json
Get-FileHash -Algorithm SHA256 docs/releases/phase6-stability-record.json |
  ForEach-Object { "$($_.Hash.ToLowerInvariant())  phase6-stability-record.json" } |
  Set-Content -Encoding ascii docs/releases/phase6-stability-record.json.sha256
node flock-voice-engine/runtime/tools/verify-phase6-migration.mjs `
  --test-ledger flock-voice-engine/release/phase6-test-migration.json `
  --source-ledger flock-voice-engine/release/phase6-source-retirement.json `
  --domain-ledger flock-voice-engine/runtime/domain-migration.json `
  --output .artifacts/phase6-removal-paths.json
npm run verify:phase6-gate
```

Expected: 在首次 Phase 5 release 后明确失败；只有 N→N+1 和 24 小时 clean window 后 exit 0。

- [ ] **Step 5: Commit**

```powershell
git add flock-voice-engine/release/phase6-policy.json flock-voice-engine/release/phase6-test-migration.schema.json flock-voice-engine/release/phase6-test-migration.json flock-voice-engine/release/phase6-source-retirement.schema.json flock-voice-engine/release/phase6-source-retirement.json flock-voice-engine/runtime/domain-migration.json flock-voice-engine/runtime/domain-test-migration.json flock-voice-engine/runtime/tools/verify-stability-window.mjs flock-voice-engine/runtime/tools/verify-phase6-migration.mjs flock-voice-engine/runtime/test/phase6-removal-gate.test.js flock-voice-engine/runtime/test/phase6-test-migration.test.js docs/releases/phase6-stability-record.json docs/releases/phase6-stability-record.json.sha256 package.json
git commit -m "test(release): gate phase6 cleanup on a stable upgrade"
```

**Rollback:** 保持当前 server-owner release，不删除任何 legacy 文件。

### Task 12: Phase 6 browser-runtime and legacy-protocol cleanup

**Files:**
- Consume (generated, not edited): `.artifacts/phase6-removal-paths.json`
- Create (generated, not committed): `.artifacts/phase6-active-tests.json`,
  `.artifacts/phase6-active-tests-current.json`, `.artifacts/phase6-active-tests-node20.json`
- Delete only: exact source/protocol/test paths enumerated by the validated removal manifest
- Create: `flock-voice-engine/runtime/test/security/phase6-no-legacy.test.js`
- Modify: `mvp/test/phase4-interaction.test.js`
- Modify: `mvp/test/product-surface.test.js`
- Modify: `mvp/test/ui-acceptance-f1f2f3.test.js`
- Modify: `flock-voice-engine/tests/test_deploy_contract.py`
- Modify: `flock-voice-engine/tests/test_release_info.py`
- Modify: `flock-voice-engine/runtime/tools/verify-phase6-migration.mjs`
- Modify: `flock-voice-engine/tools/render_cutover_docs.py`
- Modify: `flock-voice-engine/docs/deploy.md`
- Modify: `flock-voice-engine/docs/HANDOFF.md`
- Update outside Git and report separately: `D:/workspace/spark_hackrothon/HANDOFF.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 11 green stability record; server-owned domain/audio/legacy replacement accumulated in
  Tasks 1–10; validated `phase6-test-migration.json` and generated removal manifest.
- Produces: `discoverActiveRuntimeTests({root,testLedger,removalManifest}) -> string[]`;
  `writeActiveTestManifest({paths,exclusions,ledgerDigests,output}) -> ActiveTestManifest`;
  `runActiveRuntimeTests({manifest,runner})`; a server-owner-only repository and
  `npm run verify:phase6`.

- [ ] **Step 1: Prove removal is allowed and write failing no-legacy test**

```js
import { buildProductionGraph, PRODUCTION_ROOTS } from '../../tools/lib/production-graph.mjs';

const FORBIDDEN_PATHS = Object.freeze([
  'mvp/src/main.js',
  'mvp/src/world.js',
  'mvp/src/agent.js',
  'mvp/src/audio.js',
  'mvp/src/ecological-latent.js',
  'mvp/src/config.js',
  'mvp/src/sequence.js',
  'mvp/src/economy.js',
  'mvp/src/harmony.js',
  'mvp/src/mapping.js',
  'mvp/src/jungle.js',
  'mvp/src/deterministic-conductor.js',
  'mvp/src/mix-agent.js',
  'mvp/src/survival-actions.js',
  'mvp/src/survival-shadow.js',
  'mvp/src/llm/',
  'mvp/src/master/',
  'flock-voice-engine/client/',
  'flock-voice-engine/server/app.py',
]);

test('all retired paths are gone and every production root remains closed', async () => {
  for (const path of FORBIDDEN_PATHS) assert.equal(existsSync(path), false, path);
  const graph = await buildProductionGraph({ repoRoot: process.cwd(), roots: PRODUCTION_ROOTS });
  assert.equal(graph.files.some((path) => isForbidden(path, FORBIDDEN_PATHS)), false);
  assert.equal(graph.files.includes('flock-voice-engine/server/backend_factory.py'), true);
  assert.equal(graph.files.includes('flock-voice-engine/server/app.py'), false);
});

test('recursive inventory covers every active nested runtime suite', async () => {
  const active = await discoverActiveRuntimeTests({
    root: 'flock-voice-engine/runtime/test',
    testLedger,
    removalManifest,
  });
  for (const suite of [
    'audio', 'control', 'agents', 'latent', 'api',
    'protocol', 'integration', 'security',
  ]) {
    assert.equal(active.some((path) => path.includes(`/test/${suite}/`)), true, suite);
  }
  assert.equal(
    active.includes('flock-voice-engine/runtime/test/security/phase6-no-legacy.test.js'),
    true,
  );
});

test('only digest-validated retired ledger entries may be excluded', async () => {
  await assert.rejects(
    discoverActiveRuntimeTests({
      root: fixtureRoot,
      testLedger: ledgerWithout('nested/audio/live.test.js'),
      removalManifest: manifestExcluding('nested/audio/live.test.js'),
    }),
    /PHASE6_UNLEDGERED_TEST_EXCLUSION/,
  );
});

test('current Node and explicit Node 20 consume the exact same active-test manifest', async () => {
  const manifest = await writeActiveTestManifest({
    paths: discoveredPaths,
    exclusions: digestValidatedRetiredTests,
    ledgerDigests,
    output: '.artifacts/phase6-active-tests.json',
  });
  const current = await runActiveRuntimeTests({
    manifest,
    runner: { label: 'current', command: process.execPath, args: ['--test'] },
  });
  const node20 = await runActiveRuntimeTests({
    manifest,
    runner: { label: 'node20', command: 'npx', args: ['-y', 'node@20', '--test'] },
  });
  assert.equal(current.manifestSha256, manifest.manifestSha256);
  assert.equal(node20.manifestSha256, manifest.manifestSha256);
  assert.deepEqual(current.discoveredPaths, node20.discoveredPaths);
  assert.deepEqual(current.exclusions, node20.exclusions);
  assert.deepEqual(current.activePaths, node20.activePaths);
});

test('either runner failure or manifest drift fails the deletion gate', async () => {
  for (const runner of [currentFailingRunner, node20FailingRunner]) {
    await assert.rejects(
      runActiveRuntimeTests({ manifest, runner }),
      /PHASE6_ACTIVE_TEST_RUN_FAILED/,
    );
  }
  await assert.rejects(
    runActiveRuntimeTests({ manifest: tamperManifest(manifest), runner: node20Runner }),
    /PHASE6_ACTIVE_TEST_MANIFEST_MISMATCH/,
  );
});
```

Run gate first:

```powershell
npm run verify:phase6-gate
if ($LASTEXITCODE -ne 0) { throw 'Phase 6 cleanup is not authorized by stability evidence' }
node flock-voice-engine/runtime/tools/verify-phase6-migration.mjs `
  --test-ledger flock-voice-engine/release/phase6-test-migration.json `
  --source-ledger flock-voice-engine/release/phase6-source-retirement.json `
  --domain-ledger flock-voice-engine/runtime/domain-migration.json `
  --output .artifacts/phase6-removal-paths.json
node --test flock-voice-engine/runtime/test/security/phase6-no-legacy.test.js
```

Expected: gate PASS；new test FAIL because legacy files still exist。

- [ ] **Step 2: Apply the graph-and-ledger deletion manifest**

不得手写目录级删除命令。cleanup tool 逐条读取刚生成的
`.artifacts/phase6-removal-paths.json`，再次核对 manifest digest、当前 HEAD、production import
graph 与三个 ledger digest 后，才删除 manifest 中的 exact files；任何新增引用或工作树漂移都停止。
tool 必须先证明 removal manifest literal path 集合与 source/test retirement ledger 的
`status=retired` 集合完全相等；少一项、多一项、directory/glob、case alias 或 ledger 外 legacy
inventory 都停止，不能以“本次先删一部分”绕过穷尽性。
保留 `mvp/src/server-main.js`、`view-config.js`、`view-sequence.js`、renderer/scene/UI、
RuntimeClient、PcmPlayer，以及 `flock-voice-engine/server/backends/` 和
`server/backend_factory.py`、`server/audio_worker/`。Task 7 已经把完整
`config.js`/domain `sequence.js` 从 production graph
抽走；本任务只验证该事实，不在删除时临时改 renderer。

每个 legacy test 必须先由 `phase6-test-migration.json` 映射到已通过的 runtime/worker contract
test；只有 ledger 明确标记为 `retireAfterReplacement=true` 的 test 才会进入 removal manifest。
renderer、scene-layout、product surface、interaction、UI acceptance、reconnect 和 production
boundary 等高价值测试继续保留并运行。任何未映射测试、replacement skipped/non-runnable/failed，都发生在
删除前并使任务停止。`test_deploy_contract.py` 和 `test_release_info.py` 改为断言：

```powershell
node flock-voice-engine/runtime/tools/verify-phase6-migration.mjs `
  --test-ledger flock-voice-engine/release/phase6-test-migration.json `
  --source-ledger flock-voice-engine/release/phase6-source-retirement.json `
  --domain-ledger flock-voice-engine/runtime/domain-migration.json `
  --apply-validated-removals .artifacts/phase6-removal-paths.json
```

该命令只接受 manifest 内逐项 literal path，不接受 directory、glob 或运行时计算出的额外路径。

```python
def test_only_phase5_release_entry_remains():
    assert Path("flock-voice-engine/deploy/release.sh").is_file()
    assert not Path("flock-voice-engine/deploy/docker-run.sh").exists()
    assert not Path("flock-voice-engine/server/app.py").exists()
    assert Path("flock-voice-engine/server/backend_factory.py").is_file()
    graph = python_import_graph("flock-voice-engine/server/audio_worker/__main__.py")
    assert "flock-voice-engine/server/backend_factory.py" in graph
    assert "flock-voice-engine/server/app.py" not in graph
```

`verify:phase0` 保留为 historical baseline command，不再放进 Phase 6 日常 gate。
`verify-phase6-migration.mjs --write-active-test-manifest` 只执行一次 discovery/exclusion：
使用 `fs.readdir` 递归遍历
`flock-voice-engine/runtime/test` 的所有 nested directories，收集每个 literal `*.test.js`，拒绝
symlink、读取失败、case alias、重复 realpath 和无法分类文件。active set 是完整 recursive
inventory 减去同时满足以下条件的 exact test path：在 digest 已验证的
`phase6-test-migration.json` 中 `status=retired && retireAfterReplacement=true`，并且也存在于
当前 digest 已验证 removal manifest。仅出现在旧 package script/glob、仅从磁盘消失或仅列在一份
ledger 中都报 `PHASE6_UNLEDGERED_TEST_EXCLUSION`。

生成的 canonical manifest 固定 stable-sorted discovered paths、exact exclusions、active paths、
每个 active test 的 SHA-256、test/source/domain ledger 与 removal manifest 的路径和 digest，以及
自身 `manifestSha256`。后续 runner 不得重新 discovery、重算 exclusion 或读取
`flock-voice-engine/runtime/package.json` 的浅层 test glob；必须先复验 manifest、ledger、removal
manifest 和 active test digest 未漂移，再执行 manifest 中完全相同的 active paths。

第一遍使用当前、不限制 major 的 `process.execPath --test`；第二遍显式使用
`npx -y node@20`，由该进程的 `process.execPath --test` 执行。两遍都只能采用 manifest 中已经
digest-validated 的 retired-test exclusions。任一遍 nonzero exit、nested suite 未执行、零测试、
skip-only、manifest/digest 漂移，或两份结果的 manifest SHA、paths、exclusions 不完全相等，
`verify:phase6` 都失败。生产 gate 改为：

```json
{
  "scripts": {
    "verify:phase6": "node flock-voice-engine/runtime/tools/verify-phase6-migration.mjs --test-ledger flock-voice-engine/release/phase6-test-migration.json --source-ledger flock-voice-engine/release/phase6-source-retirement.json --domain-ledger flock-voice-engine/runtime/domain-migration.json --removal-manifest .artifacts/phase6-removal-paths.json --write-active-test-manifest .artifacts/phase6-active-tests.json && node flock-voice-engine/runtime/tools/verify-phase6-migration.mjs --active-test-manifest .artifacts/phase6-active-tests.json --run-with-process-exec-path --runner-label current --result .artifacts/phase6-active-tests-current.json && npx -y node@20 flock-voice-engine/runtime/tools/verify-phase6-migration.mjs --active-test-manifest .artifacts/phase6-active-tests.json --run-with-process-exec-path --runner-label node20 --result .artifacts/phase6-active-tests-node20.json && node flock-voice-engine/runtime/tools/verify-phase6-migration.mjs --active-test-manifest .artifacts/phase6-active-tests.json --assert-dual-run-results .artifacts/phase6-active-tests-current.json .artifacts/phase6-active-tests-node20.json && npm run test:mvp && npm run test:voice && npm run check && python -m pytest flock-voice-engine/tests/test_phase5_acceptance.py flock-voice-engine/tests/test_phase5_deploy_contract.py flock-voice-engine/tests/test_audio_worker_import_graph.py -q"
  }
}
```

- [ ] **Step 3: Run GREEN and scan protocol/dependency residue**

```powershell
node --test flock-voice-engine/runtime/test/security/phase6-no-legacy.test.js
rg -n --glob "*.{js,mjs,py,html,sh,json}" `
  --glob "!**/docs/**" --glob "!**/release/phase6-test-migration.json" `
  --glob "!**/test/fixtures/**" `
  "/decoder|legacy-decoder|runtimeOwner.?browser|audioOwner.?legacy|FlockVoiceClient" `
  mvp/src mvp/index.html flock-voice-engine/runtime/src flock-voice-engine/server flock-voice-engine/deploy
npm run verify:phase6
```

Expected: no active production source hit；历史 docs/ledger/fixtures 不参与该 active-code gate；all
tests PASS。

- [ ] **Step 4: Update managed docs and verify rollback artifacts remain external**

Git 内 `flock-voice-engine/docs/HANDOFF.md` 和 deploy doc 声明 current/previous 都是新架构
release、runtime owns 8090、
audio worker singleton、legacy protocol removed。Task 11 的 previous release manifest/image 和
current world snapshot 仍保留在 release store；cleanup 不删除 rollback artifact。
外部 `D:/workspace/spark_hackrothon/HANDOFF.md` 用同一受管块单独更新、单独报告，不进入 commit。

```powershell
python flock-voice-engine/tools/render_cutover_docs.py `
  --phase6-record docs/releases/phase6-stability-record.json `
  --handoff flock-voice-engine/docs/HANDOFF.md `
  --deploy-doc flock-voice-engine/docs/deploy.md
python flock-voice-engine/tools/render_cutover_docs.py `
  --phase6-record docs/releases/phase6-stability-record.json `
  --handoff D:/workspace/spark_hackrothon/HANDOFF.md
git diff --check
npm run verify:phase6
```

Expected: PASS。

- [ ] **Step 5: Commit**

```powershell
node flock-voice-engine/runtime/tools/verify-phase6-migration.mjs --test-ledger flock-voice-engine/release/phase6-test-migration.json --source-ledger flock-voice-engine/release/phase6-source-retirement.json --domain-ledger flock-voice-engine/runtime/domain-migration.json --stage-validated-removals .artifacts/phase6-removal-paths.json
git add mvp/test/phase4-interaction.test.js mvp/test/product-surface.test.js mvp/test/ui-acceptance-f1f2f3.test.js flock-voice-engine/runtime/tools/verify-phase6-migration.mjs flock-voice-engine/runtime/test/security/phase6-no-legacy.test.js flock-voice-engine/tests/test_deploy_contract.py flock-voice-engine/tests/test_release_info.py flock-voice-engine/tools/render_cutover_docs.py flock-voice-engine/docs/deploy.md flock-voice-engine/docs/HANDOFF.md package.json
node flock-voice-engine/runtime/tools/verify-phase6-migration.mjs --test-ledger flock-voice-engine/release/phase6-test-migration.json --source-ledger flock-voice-engine/release/phase6-source-retirement.json --domain-ledger flock-voice-engine/runtime/domain-migration.json --verify-staged-deletions .artifacts/phase6-removal-paths.json
git commit -m "refactor(runtime): remove browser and legacy owners"
```

`--stage-validated-removals` 只执行逐项 `git add -- <literal-file>`，不得接受目录、glob 或把其它
工作树变化带入 index。外部 HANDOFF diff 不得加入 staged set；提交后单独报告其路径与状态。

**Rollback:** 优先切回 Task 11 保留的 previous 新架构 release；若它也不可用，整体退 legacy
release 并按 Task 10 显式重建 world，不导入 server snapshot。

## Review Gates

1. Task 1：reviewer 必须从 manifest 反查每个 worker runtime input；发现 unknown vendor、
   未 hash weight/map/calibration/audio asset、基础镜像缺 exact digest、mutable image tag 或
   entry base 写进 candidate identity，拒绝；expected tuple 必须来自受信 manifest+sidecar reader。
2. Task 2：20 次 reconnect 只 load 一次；blocked UDS writer 不阻塞 render；可靠 edge/PCM ring
   overflow 只能 degraded+rebuild，不能 silent drop；oversized/partial/truncated framing 全拒绝；
   JSON u64 golden、严格递增 seq、batch all-or-none 和永久 backend factory/import closure 全通过。
3. Task 3：最终 master 是 stereo，split 只在 private legacy tap；四 species 和 ambience 都在
   worker 发声。
4. Task 4：mailbox/planner 只做同步 bounded enqueue、绝不 await socket；identity exact match 和
   state.replace ACK 前无 command/PCM，ACK 后丢弃 pre-applied PCM；所有 restart reason 共用一个
   rebuild path；split 始终 drain；Phase 3–4 完整 telemetry/admission 和 mailbox public status 不缩水。
5. Task 5：server/browser 独立命中固定 golden；paused client 只改变自己的 cursor；
   RuntimeClient 动态 owner/ready/recovering/degraded 状态才能启用 player，Audio WS ready 与
   manifest-derived geometry 逐字段一致，alternate geometry 通过。
6. Task 6：maintenance auth 与 lease token 分离；owner 绑定 exact decoder socket generation；
   同一个 lease manager 服务三类 resource；control barrier 绕过 world pause并原子拥有 owner/
   allOff/applied/state.replace/discontinuity 顺序；所有释放原因共用一个 sequence；split ring 私有有界。
7. Task 7：HTML/Node/Python/dynamic/Worker/AudioWorklet/fetch/static multi-root graph 不含 browser world/agent/latent/audio implementation；
   也不含完整 config/domain sequence；shadow/production profile gates 都通过，local aggregate
   使用固定入口并明确执行 Chromium E2E；shadow 有专用 composition，不存在双 owner flag。
8. Task 8：runtime 无 GPU、audio 无 published port、`/readyz` 与脚本双重 identity check；
   Docker `FROM` 来自受控 exact digests；package 含经 hash 的安全 import bootstrap；
   local OCI manifest digest 定义可复算、checksum basename 不变、container bind/profile 可达；
   Git 内/外 HANDOFF 分开；Task 1–9 无生产路径。
9. Task 9：真实 pool 5/block 4096，四客户端 30 分钟，8081 normal/burst 共载，原始分位数可复算；
   fixed production entry Chromium E2E 与外部 machine attestation 都入 evidence；fake/local/self-asserted
   evidence 永不能满足 acceptance；地址 identity 只比较 canonical non-loopback/non-link-local
   unicast set；无 isolated equivalent staging evidence 就停止。
10. Task 10：另取用户对 exact tuple 和首次 `reset-new-world` 授权；不伪造 browser→Node snapshot；
    worldGeneration 来自实际 initial commit/snapshot 且全 envelope 保持同一 opaque UUID string；
    只执行整体 cutover/rollback，不接受部分成功。
11. Task 11：首次 Phase 5 release 必须 RED；至少一次 N→N+1 和 24 小时 clean window 才允许清理；
    每个待退役 source/test 都在穷尽 ledger，domain ledger 双向一致且 replacement 已通过。
12. Task 12：删除只能来自 multi-root graph+ledger 生成并复验的 literal-path manifest；删除集合与
    retired ledger 集合完全相等；高价值 UI tests、
    previous 新架构 release 和 snapshot 仍在；同一 digest-attested recursive inventory 由当前
    `process.execPath` 与显式 `npx -y node@20` 各执行一次，覆盖全部 active nested runtime suites，
    且两遍仅排除 digest-validated retired tests；删除 source 不等于删除 rollback artifact。

## Completion Criteria

- candidate release identity 由当前 clean HEAD 和实际 artifact 内容生成，不含 entry base 常量。
- worker 生命周期只 load 一次 model/VoicePool；client/socket 数量不增加模型实例。
- render→bounded PCM/telemetry rings→I/O writer 解耦；blocked UDS 不阻塞 render，frame size/
  partial EOF 合约全过。
- JSON u64 全用 canonical decimal wire codec；`audioEpoch/commandSeq/targetFrame/
  appliedCommandSeq/renderFrame` 单调和排序测试全过，batch enqueue all-or-none。
- worker restart/edge overflow 通过 complete state.replace 恢复，authoritative world 不回滚。
- final 44.1 kHz stereo master、texture/Jungle/ambience、mix/EQ/reverb/mute/solo 全在 worker。
- Audio WS v1 fixed golden、resume cursor、payload length、repeat/reorder、client/stream
  discontinuity 全过；manifest/status/ready geometry 精确相等。
- 共享 PCM ring 和 per-client writer 使一个 slow/paused client 不影响其他客户端。
- legacy adapter 只消费 singleton worker；lease 绑定 exact decoder socket，default owner world。
- production bundle 只画 snapshot、发 intent、播 final PCM，没有 local synth fallback。
- production renderer 只依赖 view config/geometry helpers，完整 config/domain sequence 不在 import graph；
  multi-root graph 对动态/asset edge fail closed；historical shadow 专用 composition 与 fixed
  production Chromium entry 分别通过。
- runtime/audio 两镜像来自同一 immutable release；`/readyz` 和 deploy verifier 精确比对 worker
  expected/reported identity；基础镜像 digest 与 import bootstrap 都由 release digest chain 覆盖。
- 等价 staging 的 4-client/30-minute/8081 shared-load acceptance 全绿。
- 等价 staging 由 machine-id/SSH host key/interface/GPU UUID attestation 证明不是 production，
  interface 比较忽略 canonical loopback/link-local 地址；fixed production-entry E2E evidence 进入 acceptance。
- Task 10 经另行授权 exact release 与 `reset-new-world` 后一次性切 8090；新 worldGeneration
  来自实际 server-owned initial snapshot/commit，并在所有 envelope 中保持 opaque UUID string；
  失败五分钟内整体
  rollback 并显式重建 legacy browser world。
- Task 11 完成一个成功新架构升级和 24 小时观察后，Task 12 才删除 browser/legacy source。
- Phase 6 每个删除 source/test 都有 passing replacement/retirement ledger，删除集由完整
  multi-root graph+ledger 生成并复验；同一 fail-closed recursive active-test manifest 由当前
  `process.execPath` Node（不限制 major）和显式 `npx -y node@20` 各执行一次，任一失败即阻断；
  Python worker 永久保留 backend factory。
