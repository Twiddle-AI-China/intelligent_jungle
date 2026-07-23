# Phase 3–4 Agent 与潜空间后端权威化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变生产 8090、生产 browser owner 和生产 PCM 的前提下，让 localhost Node candidate 独占 agent provider 编排与潜空间状态机，并把 candidate latent UI 收缩为纯视图/意图客户端。

**Architecture:** 本计划显式建立在 Phase 1–2 已落地的 `WorldSession` mailbox、确定性 domain、Runtime WebSocket、`RuntimeClient`、candidate 页面和 `NullAudioSink` 上。Phase 3 用两个相互隔离的 provider runner 实现 species `bird_agent@8081` 与 master DeepSeek，并以固定应用边界、服务端 policy fallback 和 fail-closed GPU admission 接入 authoritative candidate world；Phase 4 将生态关系、XY/PCA、平滑、control/preview lease 和 map API 收进同一个 mailbox，candidate UI 只发送规范化 intent。整个计划仍是 shadow/candidate 能力，Phase 5 前不接管生产 world 或 audio。

**Tech Stack:** Node.js 20+ ESM、`node:test`、Phase 1–2 已锁定的 `ws` 与 Playwright、浏览器原生 Fetch/WebSocket、现有 Python pytest 生产不变门禁。

## Global Constraints

- 进入本计划的 Phase 0 基线必须是 `releaseRevision=4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9` 的后继提交；不能用短 SHA 或其它基线替代。
- `docs/production-manifests/2026-07-22-production.json` 的 SHA-256 必须为 `1ebd697b2e0d0cec8b0cbec008fc884179c6273b97952837f661c2c39f6065ec`。
- 冻结 vendor tree SHA-256 必须为 `21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049`；本计划不替换 vendor，也不把 unknown revision 描述成可由 Git 重建。
- Phase 3–4 candidate identity 继承 Phase 1–2 的诚实 shadow 语义：`releaseRevision="unknown"`、`sourceManifestSha256="unknown"`；不能把当前 Git HEAD 与 Phase 0 production manifest SHA 拼成 candidate release identity。
- 每次任务回归必须保留 `npm run verify:phase0`；Phase 1–2 的 `npm run verify:phase12` 必须已经存在且通过。
- Node candidate 只能监听 `127.0.0.1:18090`；拒绝 `0.0.0.0`、LAN 地址和 8090。
- Phase 3–4 固定 `runtimeOwner=browser`、`audioOwner=legacy`；生产浏览器继续是唯一 world/agent/latent/audio owner。
- 不修改、同步、apply、启动、停止或重启生产 8090，不执行 SSH、Docker、scp，不写 `/srv/deploy/flock-voice-engine`。
- candidate 只使用 Phase 1–2 的 `NullAudioSink.accept(commands)`，不连接 `/decoder`、不写生产 PCM、不创建第二个 GPU audio backend；Phase 4 preview 只验证 authoritative 状态、lease 与 intent，不宣称可听。
- species endpoint 固定为服务端 `http://127.0.0.1:8081/v1`，模型固定 `bird_agent`；浏览器不能看到 endpoint、prompt 或 schema。
- Phase 3–4 没有真实 audio worker telemetry，live candidate 的 species admission 必须恒为 `telemetry_unknown` 且 provider 保持 disabled；只有直接注入完整安全 telemetry 的单元/集成 fixture 才能覆盖 admitted 分支，不得把伪造安全 telemetry 接到 candidate server，也不得真实调用 8081。
- master 固定为服务端 DeepSeek provider：默认 base URL `https://api.deepseek.com/v1`、默认模型 `deepseek-v4-flash`、key 只读 `DEEPSEEK_API_KEY` 进程环境；默认测试禁止真实外网。species 继续强制 `response_format=json_schema`。当前目标 DeepSeek Chat Completions 不宣称支持 `json_schema`，master 只能使用本计划 Task 1/3 明确收口的 `json_object` 受控例外：canonical schema 同时写入 prompt、响应必须经严格本地 schema/menu 校验，显式启用时先通过最小 capability probe，失败即保持 master disabled 并走 policy；不得把该例外扩展到 species 或其它 provider。
- 所有 provider、latent 和 preview 完成回调必须投递到 Phase 1–2 的单一 `WorldSession` mailbox；不得另建第二个 world、revision、eventSeq、command dedupe 或并发 reducer。
- 所有 agent completion 必须携带下文冻结的自描述 `AgentResultEnvelope`；不得仅凭当前 orchestrator 的 requestId side table 猜测旧结果属于哪个 generation、revision 或 boundary。
- 生产 legacy `mvp/src/main.js`、`mvp/src/llm/`、`mvp/src/audio.js` 与旧 latent owner 在 Phase 5 原子切换前保留为回滚面；candidate 与 legacy 不得在同一页面混装。
- 凭据、Authorization、完整 prompt、完整生态输入、原始模型响应、lease token、backend row、map/checkpoint 路径、PCA basis 和完整 latent vector不得进入 snapshot、REST/WS 公共事件、DOM、URL、localStorage 或普通日志。
- Phase 3–4 聚合门禁必须从 `flock-voice-engine/runtime` 工作目录分别用当前 Node 和显式 Node 20 执行同一个递归 `*.test.js` inventory；不得用顶层 glob，也不得把 Playwright `*.spec.js` 或 browser fixture 当成 Node tests。`agents/`、`latent/`、`api/`、`protocol/`、`integration/`、`security/` 等嵌套测试必须在两次运行中都被发现。

## Entry Gate

在 Task 1 前从仓库根目录运行；任一断言失败就停止本计划，不通过增加兼容分支绕过：

```powershell
$baseline = '4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9'
$manifestSha = '1ebd697b2e0d0cec8b0cbec008fc884179c6273b97952837f661c2c39f6065ec'
$vendorSha = '21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049'
git merge-base --is-ancestor $baseline HEAD
if ($LASTEXITCODE -ne 0) { throw 'HEAD 不是冻结 Phase 0 releaseRevision 的后继' }
$actualManifestSha = (Get-FileHash -Algorithm SHA256 'docs/production-manifests/2026-07-22-production.json').Hash.ToLowerInvariant()
if ($actualManifestSha -ne $manifestSha) { throw 'production source manifest SHA 不匹配' }
$metadata = Get-Content -Raw -Encoding UTF8 'docs/production-manifests/2026-07-22-metadata.json' |
  ConvertFrom-Json
$actualVendorSha = $metadata.externalRuntimeInputs.vendor.treeSha256
if ($actualVendorSha -ne $vendorSha) { throw "vendor tree SHA 不匹配: $actualVendorSha" }
@(
  'flock-voice-engine/runtime/src/world-session/world-session.js',
  'flock-voice-engine/runtime/src/simulation-runtime.js',
  'flock-voice-engine/runtime/src/domain/deterministic-conductor.js',
  'flock-voice-engine/runtime/src/audio/null-audio-sink.js',
  'flock-voice-engine/runtime/src/protocol/v1.js',
  'flock-voice-engine/runtime/src/api/bootstrap.js',
  'flock-voice-engine/runtime/src/api/runtime-ws.js',
  'flock-voice-engine/runtime/src/server.js',
  'flock-voice-engine/runtime/domain-migration.json',
  'flock-voice-engine/runtime/domain-test-migration.json',
  'mvp/src/runtime-client.js',
  'flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html',
  'flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js'
) | ForEach-Object { if (-not (Test-Path -LiteralPath $_)) { throw "Phase 1–2 产物缺失: $_" } }
npm run verify:phase0
if ($LASTEXITCODE -ne 0) { throw 'Phase 0 gate failed' }
npm run verify:phase12
if ($LASTEXITCODE -ne 0) { throw 'Phase 1–2 gate failed' }
```

Expected: 两个 verify 均 exit 0；candidate gate 继续证明 `127.0.0.1:18090`、`releaseRevision/sourceManifestSha256=unknown/unknown`、`runtimeOwner=browser`、`audioOwner=legacy`、`/readyz=503 phaseGate=shadow-no-audio`。

## File Structure

```text
flock-voice-engine/runtime/
  src/
    agents/
      contracts.js                 agent request/result/public status 类型与校验
      species-prompt.js            8081 species prompt/schema/request normalization
      master-prompt.js             DeepSeek master prompt/JSON normalization
      provider-runner.js           deadline/retry/in-flight/circuit 状态机
      species-provider.js          bird_agent OpenAI-compatible adapter
      deepseek-master-provider.js  DeepSeek adapter
      gpu-admission.js             audio-first 准入快照与稳定 reason
      agent-orchestrator.js        非阻塞调度、mailbox result、固定边界、fallback
      agent-composition.js         两条 provider/runner 的唯一进程接线与关闭顺序
      status-projector.js          浏览器安全的 provider/fallback 状态
    control/
      lease-manager.js             resource/client/socket-generation 通用租约内核
    latent/
      voice-config.js              species/voice/projection/extent 服务端配置
      map-repository.js            map 资产加载、校验与安全 DTO
      relations.js                 八个生态关系量
      projection.js                XY/PCA/kNN 与 worker intent
      latent-runtime.js            平滑、USER/AGENT、coalescing
      preview-lease.js             preview 状态、TTL 与 exactly-once all-off
    api/
      latent-routes.js             安全 map REST handler
  test/
    agents/
    latent/
    api/
    integration/
    security/
  scripts/
    run-phase34-tests.mjs          当前 Node/Node 20 共用的递归单元测试 inventory

mvp/
  src/
    ui/
      latent-roamer-legacy.js       Phase 5 前生产 browser owner 的冻结副本
      latent-roamer.js              candidate 纯视图/intent
  test/
    latent-roamer-view.test.js
    backend-owned-boundary.test.js
```

## Shared Interfaces

后续任务统一使用以下名称和类型，不允许另起同义字段：

```js
/** @typedef {'species'|'master'} AgentChannel */
/** @typedef {'llm'|'policy'} DecisionSource */
/** @typedef {'xy'|'pca'} LatentMode */
/** @typedef {'AGENT'|'USER'} LatentOwnerMode */
/** @typedef {{kind:'dawn',day:number}} AgentApplyBoundary */

/**
 * @typedef {object} AgentReviewRequest
 * @property {string} requestId
 * @property {number} scheduleSeq
 * @property {'default'} worldId
 * @property {string} worldGeneration
 * @property {number} scheduledWorldRevision
 * @property {number} reviewedDay
 * @property {AgentApplyBoundary} applyBoundary
 * @property {object} flockInput
 * @property {object} masterInput
 * @property {number} createdAtMs
 */

/**
 * Provider adapters always settle with this discriminated value. The runner
 * consumes retryable/code directly and never infers retry policy from null or text.
 * @template T
 * @typedef {object} ProviderInvocationResult
 * @property {boolean} ok
 * @property {T|null} value
 * @property {'ok'|'http_error'|'network_error'|'invalid_output'} status
 * @property {string} code
 * @property {boolean} retryable
 * @property {number|null} httpStatus
 */

/**
 * @template T
 * @typedef {object} ProviderResult
 * @property {string} requestId
 * @property {AgentChannel} channel
 * @property {'ok'|'disabled'|'gated'|'busy'|'timeout'|'circuit_open'|'provider_error'|'invalid_output'} status
 * @property {T|null} value
 * @property {number} attempts
 * @property {number} startedAtMs
 * @property {number} settledAtMs
 * @property {string|null} reason
 */

/**
 * @template T
 * @typedef {object} AgentResultEnvelope
 * @property {string} requestId
 * @property {number} scheduleSeq
 * @property {'default'} worldId
 * @property {string} worldGeneration
 * @property {number} scheduledWorldRevision
 * @property {number} reviewedDay
 * @property {AgentApplyBoundary} applyBoundary
 * @property {AgentChannel} channel
 * @property {ProviderResult<T>} provider
 */

/**
 * @typedef {object} AgentBoundaryOutcome
 * @property {string} requestId
 * @property {number} scheduleSeq
 * @property {string} worldGeneration
 * @property {number} scheduledWorldRevision
 * @property {number} reviewedDay
 * @property {AgentApplyBoundary} applyBoundary
 * @property {{source:DecisionSource,status:string,value:object|null,reason:string}} species
 * @property {{source:DecisionSource,status:string,value:object|null,reason:string}} master
 */

/**
 * @typedef {object} LatentCursor
 * @property {number} x
 * @property {number} y
 * @property {number[]} pca
 */
```

`scheduledWorldRevision` 是 schedule 身份与 supersede 证据，不要求 apply 时仍等于 `currentWorldRevision`；正常 tick 会前进 revision。每个 generation 内的 `scheduleSeq` 是严格递增安全整数。同一 `(worldGeneration,applyBoundary.kind,applyBoundary.day)` 只保留最大 `scheduleSeq`，相同 seq 仅允许相同 requestId 的幂等重放；更小 seq、同 seq 不同 requestId、未来 `scheduledWorldRevision > currentWorldRevision`、旧 generation、非 latest request 或已消费 boundary 的结果一律 `stale_discarded`。`takeForBoundary()` 只在 generation 相同且当前 `{kind,day}` 精确等于 `applyBoundary` 时消费一次；current revision 可以大于 scheduled revision，但不得用“当前 revision 不相等”误杀正常 tick 后的结果。

---

### Task 1: Agent 契约、species schema 与 master schema

**Files:**
- Create: `flock-voice-engine/runtime/src/agents/contracts.js`
- Create: `flock-voice-engine/runtime/src/agents/species-prompt.js`
- Create: `flock-voice-engine/runtime/src/agents/master-prompt.js`
- Create: `flock-voice-engine/runtime/test/agents/contracts.test.js`
- Create: `flock-voice-engine/runtime/test/agents/prompts.test.js`
- Reference only: `mvp/src/llm/client.js:18-344`
- Reference only: `mvp/src/llm/openai-client.js:19-230`
- Reference only: `mvp/src/master/llm-master.js:12-105`
- Reference only: `mvp/src/master/policy.js:122-427`

**Interfaces:**
- Consumes: Phase 1–2 domain snapshot and deterministic conductor; no browser or network imports.
- Produces: `validateAgentReview(value): AgentReviewRequest`; `providerOk(value,httpStatus): ProviderInvocationResult`; `providerFailure({status,code,retryable,httpStatus}): ProviderInvocationResult`; `validateProviderInvocationResult(value): ProviderInvocationResult`; `buildSpeciesRequest(flockInput): object`; `parseSpeciesResponse(raw, flockInput): object|null`; `buildMasterRequest(masterInput): object`; `parseMasterResponse(raw, masterInput): object|null`.

- [ ] **Step 1: Write the failing contract and prompt tests**

```js
test('species request keeps the frozen 8081 contract', () => {
  const body = buildSpeciesRequest(flockFixture);
  assert.equal(body.model, 'bird_agent');
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 512);
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties), ['reason', 'flocks', 'master']);
  assert.deepEqual(body.response_format.json_schema.schema.properties.master.properties.ops.maxItems, 0);
});
```

同文件加入 invalid enum、额外字段、菜单外 mutation、input echo、截断 JSON、master 非季末越权字段和 prompt 音乐词扫描。species body 必须继续是 `json_schema`。DeepSeek body 的受控例外必须是 `json_object`、`max_tokens=4096`，并满足：

```js
const masterBody = buildMasterRequest(masterFixture);
assert.equal(masterBody.response_format.type, 'json_object');
assert.match(masterBody.messages[0].content, /"additionalProperties":false/);
assert.match(masterBody.messages[0].content, /"required":\[/);
assert.equal(parseMasterResponse('{"unexpected":true}', masterFixture), null);
assert.equal(parseMasterResponse('{"reason":"越权","nextSeason":"winter"}', nonFinalFixture), null);
```

该例外不是“宽松 JSON”：canonical master schema 以稳定 JSON 写进 system prompt，`parseMasterResponse()` 先做 JSON parse，再执行 required/enum/type/finite/additionalProperties=false 和当前 menu/season 权限校验；任一失败返回 null/`invalid_output`，原始响应不进入日志。

- [ ] **Step 2: Run RED**

Run: `node --test flock-voice-engine/runtime/test/agents/contracts.test.js flock-voice-engine/runtime/test/agents/prompts.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/agents/contracts.js`。

- [ ] **Step 3: Implement the minimal server-only contracts**

```js
export const SPECIES_MODEL = 'bird_agent';
export const SPECIES_MAX_TOKENS = 512;
export const MASTER_MODEL_DEFAULT = 'deepseek-v4-flash';
export const MASTER_MAX_TOKENS = 4096;
export function validateAgentReview(value) {}
export function providerOk(value, httpStatus = 200) {}
export function providerFailure({ status, code, retryable, httpStatus = null }) {}
export function validateProviderInvocationResult(value) {}
export function buildSpeciesRequest(flockInput) {}
export function parseSpeciesResponse(raw, flockInput) {}
export function buildMasterRequest(masterInput) {}
export function parseMasterResponse(raw, masterInput) {}
```

把现有已验证的生态 flags、严格 schema、reason pattern 和菜单校验移到上述服务端模块；移植期间 production legacy 模块不改。`providerOk()` 固定 `{ok:true,value,status:'ok',code:'OK',retryable:false,httpStatus}`；`providerFailure()` 固定 `ok:false,value:null`，并拒绝未知 status、空 code、非 boolean retryable 或非法 HTTP status。agent prompt/schema 是新建的服务端边界，不加入 Phase 1–2 的 domain hash-pair；`flock-voice-engine/runtime/domain-migration.json` 与 `domain-test-migration.json` 保持原样并继续只登记既有 deterministic domain/source-test pairs。

- [ ] **Step 4: Run GREEN and regression**

Run: `node --test flock-voice-engine/runtime/test/agents/contracts.test.js flock-voice-engine/runtime/test/agents/prompts.test.js`

Expected: PASS。

Run: `npm run test:mvp`

Expected: PASS，legacy prompt 行为未改变。

- [ ] **Step 5: Commit**

```bash
git add flock-voice-engine/runtime/src/agents/contracts.js flock-voice-engine/runtime/src/agents/species-prompt.js flock-voice-engine/runtime/src/agents/master-prompt.js flock-voice-engine/runtime/test/agents/contracts.test.js flock-voice-engine/runtime/test/agents/prompts.test.js
git commit -m "feat(runtime): define server-side agent contracts"
```

**Rollback:** revert 本提交；candidate 继续使用 Phase 1–2 deterministic policy shadow，生产无变化。

### Task 2: ProviderRunner 的 deadline、retry、物理 in-flight 与 circuit

**Files:**
- Create: `flock-voice-engine/runtime/src/agents/provider-runner.js`
- Create: `flock-voice-engine/runtime/test/agents/provider-runner.test.js`

**Interfaces:**
- Consumes: injected `clock.now()`, `setTimer`, `clearTimer` and provider `invoke({signal, attempt, deadlineAtMs}): Promise<ProviderInvocationResult>`. The runner calls `validateProviderInvocationResult()` and never derives retryability from null, HTTP text or thrown message.
- Produces: `createProviderRunner(config)` returning `{ tryStart(job), getStatus(), close() }`; `tryStart({requestId, invoke, onSettled})` synchronously returns `{accepted, reason, requestId}` and later invokes `onSettled(ProviderResult)` exactly once.

- [ ] **Step 1: Write the failing state-machine tests**

```js
test('Abort ignored by fetch never opens a second physical species call', async () => {
  const hanging = deferred();
  const runner = createProviderRunner(speciesConfig(fakeClock));
  assert.equal(runner.tryStart(job('a', () => hanging.promise)).accepted, true);
  fakeClock.advance(12_001);
  assert.deepEqual(runner.tryStart(job('b', ok)), { accepted: false, reason: 'busy', requestId: 'b' });
  assert.equal(invocationCount, 1);
  hanging.resolve(providerOk(validResponse));
  await flushPromises();
  assert.equal(runner.getStatus().physicalInFlight, 0);
});
```

加入以下 typed classification 断言，以及绝对 deadline、三次失败 open、cooldown 后单 half-open probe、master/species 两实例互不影响、`close()` exactly-once settle：

```js
async function settleInvocation(invocationResult) {
  const settled = deferred();
  const clock = createFakeClock();
  const runner = createProviderRunner(speciesConfig(clock));
  let attempts = 0;
  assert.equal(runner.tryStart({
    requestId: 'typed',
    invoke: async () => { attempts += 1; return invocationResult; },
    onSettled: settled.resolve,
  }).accepted, true);
  await flushPromises();
  return { attempts, outcome: await settled.promise };
}

for (const failure of [
  providerFailure({ status: 'http_error', code: 'HTTP_429', retryable: true, httpStatus: 429 }),
  providerFailure({ status: 'http_error', code: 'HTTP_500', retryable: true, httpStatus: 500 }),
  providerFailure({ status: 'network_error', code: 'ECONNRESET', retryable: true }),
]) assert.equal((await settleInvocation(failure)).attempts, 2);

for (const failure of [
  providerFailure({ status: 'http_error', code: 'HTTP_400', retryable: false, httpStatus: 400 }),
  providerFailure({ status: 'invalid_output', code: 'INVALID_OUTPUT', retryable: false }),
]) assert.equal((await settleInvocation(failure)).attempts, 1);

const malformed = await settleInvocation({
  ok: false, value: null, status: 'http_error', code: 'HTTP_500',
  // retryable/httpStatus intentionally absent
});
assert.equal(malformed.attempts, 1);
assert.equal(malformed.outcome.status, 'provider_error');
assert.equal(malformed.outcome.reason, 'PROVIDER_INVOCATION_RESULT_INVALID');
```

- [ ] **Step 2: Run RED**

Run: `node --test flock-voice-engine/runtime/test/agents/provider-runner.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: Implement the runner**

```js
export function createProviderRunner({
  channel,
  attemptTimeoutMs,
  deadlineMs,
  maxAttempts,
  failureThreshold,
  cooldownMs,
  clock,
  setTimer,
  clearTimer,
}) {
  return { tryStart, getStatus, close };
}
```

species 固定 `attemptTimeoutMs=12000, deadlineMs=15000, maxAttempts=2, failureThreshold=3, cooldownMs=60000`；master 固定 `30000, 45000, 2, 3, 120000`。只有已通过 `validateProviderInvocationResult()` 且 `retryable=true` 的失败可消耗第二次 attempt；malformed result 直接结算 `provider_error/PROVIDER_INVOCATION_RESULT_INVALID`，不得猜测。timeout 可以完成逻辑 result，但物理 promise 未 settle 前不释放 slot，也不开始 retry。

- [ ] **Step 4: Run GREEN**

Run: `node --test flock-voice-engine/runtime/test/agents/provider-runner.test.js`

Expected: PASS；测试中的最大 physical in-flight 为 1。

- [ ] **Step 5: Commit**

```bash
git add flock-voice-engine/runtime/src/agents/provider-runner.js flock-voice-engine/runtime/test/agents/provider-runner.test.js
git commit -m "feat(runtime): bound agent provider execution"
```

**Rollback:** revert 本提交；没有 provider 能被 orchestrator 启动。

### Task 3: Species/DeepSeek adapters 与 audio-first GPU admission

**Files:**
- Create: `flock-voice-engine/runtime/src/agents/species-provider.js`
- Create: `flock-voice-engine/runtime/src/agents/deepseek-master-provider.js`
- Create: `flock-voice-engine/runtime/src/agents/gpu-admission.js`
- Create: `flock-voice-engine/runtime/test/agents/providers.test.js`
- Create: `flock-voice-engine/runtime/test/agents/gpu-admission.test.js`
- Modify: `flock-voice-engine/runtime/src/config.js`
- Modify: `flock-voice-engine/runtime/test/config.test.js`

**Interfaces:**
- Consumes: Task 1 builders/parsers and Task 2 runner. Phase 3–4 live candidate only has `NullAudioSink.getStatus()` and therefore has no admissible worker telemetry.
- Produces: `createSpeciesProvider({fetchImpl, baseUrl})` returning `{request(flockInput,{signal}): Promise<ProviderInvocationResult<object>>}`; `createDeepSeekMasterProvider({fetchImpl, baseUrl, model, apiKey})` returning `{probeCapabilities({signal}): Promise<ProviderInvocationResult<object>>,request(masterInput,{signal}): Promise<ProviderInvocationResult<object>>}`; `evaluateSpeciesAdmission(telemetry, thresholds, nowMs): {admitted:boolean,reason:string,sampledAtMs:number|null}`; `loadAgentProviderConfig(env): {speciesEnabled:false,masterEnabled:boolean,masterBaseUrl:string,masterModel:string,masterApiKey:string|null}`.

- [ ] **Step 1: Write failing adapter and admission tests**

```js
test('missing or stale telemetry fails closed before fetch', () => {
  assert.deepEqual(evaluateSpeciesAdmission(null, thresholds, 1000), {
    admitted: false, reason: 'telemetry_unknown', sampledAtMs: null,
  });
  assert.equal(evaluateSpeciesAdmission({ ...safeTelemetry, sampledAtMs: 0 }, thresholds, 2000).reason, 'telemetry_unknown');
});

test('provider separation is immutable', async () => {
  assert.equal((await species.request(flockInput, { signal })).ok, true);
  assert.equal((await master.request(masterInput, { signal })).ok, true);
  assert.equal(speciesCall.url, 'http://127.0.0.1:8081/v1/chat/completions');
  assert.equal(speciesCall.body.model, 'bird_agent');
  assert.equal(masterCall.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(masterCall.body.model, 'deepseek-v4-flash');
  assert.equal(masterCall.headers.Authorization, 'Bearer server-only');
});

test('Phase 3–4 live config cannot enable species without real worker telemetry', () => {
  assert.throws(
    () => loadAgentProviderConfig({ FLOCK_AGENT_SPECIES_ENABLED: 'true' }),
    /SPECIES_ADMISSION_UNAVAILABLE_PHASE_3_4/,
  );
});

test('enabled DeepSeek must pass the controlled json_object capability probe', async () => {
  const probe = await master.probeCapabilities({ signal });
  assert.equal(probe.ok, true);
  assert.equal(probe.value.probe, 'flock-master-json-v1');
  assert.equal(masterProbeCall.body.response_format.type, 'json_object');
  assert.match(masterProbeCall.body.messages[0].content, /"additionalProperties":false/);
});
```

adapter tests 逐项固定 200→typed ok、合法 JSON 但 schema/menu 失败→`invalid_output/INVALID_OUTPUT/retryable=false`、400→`http_error/HTTP_400/false`、429/500→对应 typed `http_error/.../true`、connection reset→`network_error/ECONNRESET/true`；原始 body/error text 不得进入 result。DeepSeek probe 使用最小固定响应 `{probe:"flock-master-json-v1"}`，仍走 `json_object` + canonical schema-in-prompt + 本地严格 validator；非 2xx、非 JSON、额外字段、错误 sentinel 或 timeout 均返回 typed failure，不得把 master runner 标为 enabled。

`safeTelemetry` 只能是本测试文件内直接传给纯函数的 fixture，不能由 config、HTTP、WS 或 `NullAudioSink` 生成。逐一注入 `workerReady=false`、recovering、PCM headroom < 3 blocks、queueDepth > 1、render p95 > 0.70、p99 > 0.90、最近 underrun > 0、统一内存 < 12 GiB、NaN 和采样超过 1000 ms；每项必须返回稳定 reason 且 fetch count 为 0。

- [ ] **Step 2: Run RED**

Run: `node --test flock-voice-engine/runtime/test/agents/providers.test.js flock-voice-engine/runtime/test/agents/gpu-admission.test.js flock-voice-engine/runtime/test/config.test.js`

Expected: FAIL with missing provider modules。

- [ ] **Step 3: Implement adapters and fail-closed configuration**

```js
export const SPECIES_BASE_URL = 'http://127.0.0.1:8081/v1';
export const DEFAULT_GPU_THRESHOLDS = Object.freeze({
  maxTelemetryAgeMs: 1000,
  minPcmHeadroomBlocks: 3,
  maxAudioQueueDepth: 1,
  maxRenderP95Ratio: 0.70,
  maxRenderP99Ratio: 0.90,
  maxRecentUnderruns: 0,
  minUnifiedMemoryFreeBytes: 12 * 1024 ** 3,
});
export function createSpeciesProvider({ fetchImpl, baseUrl = SPECIES_BASE_URL }) {
  return { request };
}
export function createDeepSeekMasterProvider({ fetchImpl, baseUrl, model, apiKey }) {
  return { probeCapabilities, request };
}
export function evaluateSpeciesAdmission(telemetry, thresholds, nowMs) {}
export function loadAgentProviderConfig(env = process.env) {
  if (env.FLOCK_AGENT_SPECIES_ENABLED === 'true') {
    throw new Error('SPECIES_ADMISSION_UNAVAILABLE_PHASE_3_4');
  }
  const masterEnabled = env.FLOCK_AGENT_MASTER_ENABLED === 'true';
  const masterApiKey = env.DEEPSEEK_API_KEY?.trim() || null;
  if (masterEnabled && !masterApiKey) throw new Error('DEEPSEEK_API_KEY_REQUIRED');
  return Object.freeze({
    speciesEnabled: false,
    masterEnabled,
    masterBaseUrl: 'https://api.deepseek.com/v1',
    masterModel: 'deepseek-v4-flash',
    masterApiKey,
  });
}
```

provider 自身不 retry、不缓存上次输出，只返回 Task 1 的 typed invocation result。Phase 3–4 server wiring 始终给 species runner `enabled=false`，live admission 固定产生 `telemetry_unknown`；只有注入 fake provider 和本地 `safeTelemetry` 的测试能覆盖 admitted 分支，真实 8081 准入延至 Phase 5 接入真实 audio worker telemetry 后实现。master 默认 disabled；显式启用时缺 `DEEPSEEK_API_KEY` 必须在 candidate 创建 server/listen 前报 `DEEPSEEK_API_KEY_REQUIRED`。有 key 后仍不能直接 enable runner：composition 必须先等待 `probeCapabilities()` 成功；probe 失败只产生安全状态 `deepseek_capability_unavailable` 并保持 policy fallback，不发送业务生态输入。日志只记录 requestId/channel/status/attempt/latency/error code。

- [ ] **Step 4: Run GREEN and config regression**

Run: `node --test flock-voice-engine/runtime/test/agents/providers.test.js flock-voice-engine/runtime/test/agents/gpu-admission.test.js flock-voice-engine/runtime/test/config.test.js`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add flock-voice-engine/runtime/src/agents/species-provider.js flock-voice-engine/runtime/src/agents/deepseek-master-provider.js flock-voice-engine/runtime/src/agents/gpu-admission.js flock-voice-engine/runtime/test/agents/providers.test.js flock-voice-engine/runtime/test/agents/gpu-admission.test.js flock-voice-engine/runtime/src/config.js flock-voice-engine/runtime/test/config.test.js
git commit -m "feat(runtime): isolate agent providers and GPU admission"
```

**Rollback:** candidate provider flags保持 false 或 revert；不能把 master 回接 8081，生产 provider 链不改。

### Task 4: AgentOrchestrator mailbox、固定 apply boundary 与 policy fallback

**Files:**
- Create: `flock-voice-engine/runtime/src/agents/agent-orchestrator.js`
- Create: `flock-voice-engine/runtime/src/agents/agent-composition.js`
- Create: `flock-voice-engine/runtime/test/agents/agent-orchestrator.test.js`
- Create: `flock-voice-engine/runtime/test/integration/agent-composition.test.js`
- Modify: `mvp/src/deterministic-conductor.js`
- Modify: `flock-voice-engine/runtime/src/domain/deterministic-conductor.js`
- Modify: `mvp/test/deterministic-conductor.test.js`
- Modify: `flock-voice-engine/runtime/test/domain/deterministic-conductor.test.js`
- Modify: `flock-voice-engine/runtime/test/domain-parity.test.js`
- Modify: `flock-voice-engine/runtime/src/simulation-runtime.js`
- Modify: `flock-voice-engine/runtime/test/simulation-runtime.test.js`
- Modify: `flock-voice-engine/runtime/src/world-session/world-session.js`
- Modify: `flock-voice-engine/runtime/test/world-session.test.js`
- Modify: `flock-voice-engine/runtime/src/server.js`
- Modify: `flock-voice-engine/runtime/src/index.js`
- Modify: `flock-voice-engine/runtime/test/health.test.js`

**Interfaces:**
- Consumes: Phase 1–2 `WorldSession.commit(kind, mutate)` / `executeCommand({clientId,generation,command})`, Task 2 runners, Task 3 admission/providers, the machine-checked deterministic-conductor hash pair in `domain-migration.json`, and its already-listed source/runtime test pair in `domain-test-migration.json`.
- Produces: `createAgentOrchestrator({speciesRunner,masterRunner,admission,policies,publishEnvelope,clock})` returning `{scheduleReview(request):void,acceptEnvelope(envelope,currentContext):void,takeForBoundary(boundary):AgentBoundaryOutcome,getPublicState():object,close():void}`.
- Produces: `createAgentComposition({providerConfig,fetchImpl,clock,setTimer,clearTimer,publishEnvelope,runnerFactory})` returning `{initialize():Promise<void>,scheduleReview(request),acceptEnvelope(envelope,currentContext),takeForBoundary(boundary),getPublicState(),close():Promise<void>}`. It owns exactly one species provider/runner and one distinct master provider/runner.
- Produces identically from both conductor copies: `buildAgentReview({requestId,scheduleSeq,worldId,worldGeneration,scheduledWorldRevision,reviewedDay,applyBoundary,snapshot,createdAtMs})`; `fallbackSpeciesPlan(review,currentDomain)`; `fallbackMasterDecision(review,currentDomain)`; `applyAgentOutcome(outcome,currentDomain)`.
- Extends SimulationRuntime with `acceptAgentResult(envelope): CommitDraft`; async completion is committed by `session.commit('agent.result', () => session.kernel.acceptAgentResult(envelope))`, so a result from a disposed runtime is checked against the current mailbox-owned kernel rather than a captured old simulation object.

- [ ] **Step 1: Write failing boundary and non-blocking tests**

```js
test('late result is discarded instead of moving to the next dawn', async () => {
  orchestrator.scheduleReview(review({
    requestId: 'r4', scheduleSeq: 4, worldGeneration: 'generation-a',
    scheduledWorldRevision: 40, reviewedDay: 4,
    applyBoundary: { kind: 'dawn', day: 5 },
  }));
  assert.equal(orchestrator.takeForBoundary(boundary({
    worldGeneration: 'generation-a', currentWorldRevision: 44, kind: 'dawn', day: 5,
  })).species.source, 'policy');
  speciesDeferred.resolve(providerOk(validSpecies));
  await flushPromises();
  assert.equal(orchestrator.takeForBoundary(boundary({
    worldGeneration: 'generation-a', currentWorldRevision: 50, kind: 'dawn', day: 6,
  })).species.source, 'policy');
  assert.equal(orchestrator.getPublicState().lastSpeciesStatus, 'stale_discarded');
});

test('tick never awaits a provider', () => {
  const result = simulation.tick(FIXED_STEP);
  assert.equal(typeof result?.then, 'undefined');
});

test('both deterministic conductor copies remain byte-identical', () => {
  assert.equal(sha256('mvp/src/deterministic-conductor.js'),
    sha256('flock-voice-engine/runtime/src/domain/deterministic-conductor.js'));
});

test('same-boundary latest schedule wins independently of completion order', () => {
  orchestrator.scheduleReview(review({
    requestId: 'older', scheduleSeq: 10, scheduledWorldRevision: 100,
    worldGeneration: 'generation-a', reviewedDay: 7,
    applyBoundary: { kind: 'dawn', day: 8 },
  }));
  orchestrator.scheduleReview(review({
    requestId: 'newer', scheduleSeq: 11, scheduledWorldRevision: 101,
    worldGeneration: 'generation-a', reviewedDay: 7,
    applyBoundary: { kind: 'dawn', day: 8 },
  }));
  acceptEnvelope(envelopeFor('newer', 'species', providerOk(validSpecies)), {
    worldGeneration: 'generation-a', currentWorldRevision: 105, currentDay: 7,
  });
  acceptEnvelope(envelopeFor('older', 'species', providerOk(otherSpecies)), {
    worldGeneration: 'generation-a', currentWorldRevision: 106, currentDay: 7,
  });
  const outcome = orchestrator.takeForBoundary(boundary({
    worldGeneration: 'generation-a', currentWorldRevision: 110, kind: 'dawn', day: 8,
  }));
  assert.equal(outcome.requestId, 'newer');
  assert.deepEqual(outcome.species.value, validSpecies);
});
```

加入正常按边界应用且第二次 take 不重复、旧 world generation 即使 day/revision 数字碰巧相同仍丢弃、已消费 boundary 后 completion 丢弃、`scheduledWorldRevision > currentWorldRevision` 丢弃、current revision 大于 scheduled revision 仍允许、低 scheduleSeq、同 seq 不同 requestId、out-of-order/superseded、当前菜单或 home branch 已变化、重复 resolve、species/master 单边失败、provider disabled/gated/circuit 和相同 seed fallback 重放。每个 envelope 必须与注册 review 的 requestId/scheduleSeq/generation/scheduled revision/reviewed day/apply boundary/channel 全字段相等；不能用 requestId side table 给缺字段结果“补身份”。

`agent-composition.test.js` 还必须注入 `runnerFactory`/fake fetch 并断言：恰好创建两个不同 runner，channel 分别为 species/master；两个 provider URL/model 不串线；master disabled 时无 DeepSeek fetch；master enabled 且缺 key 在 server 创建/listen 前抛 `DEEPSEEK_API_KEY_REQUIRED`；probe 失败时 server 可继续 shadow 但 master 状态 disabled/policy；probe 成功才允许业务 master request；live species 始终 `telemetry_unknown` 且 8081 fetch count 为 0；直接注入 safe telemetry 的 test-only composition 才能跑 admitted 分支，burst 中 species physical in-flight 仍为 1。

四个新纯函数的 characterization cases 以同一个 patch 成对加入 `mvp/test/deterministic-conductor.test.js` 与 `flock-voice-engine/runtime/test/domain/deterministic-conductor.test.js`；除 ESM import specifier 外测试体必须相同。`domain-parity.test.js` 必须继续逐项验证 `domain-migration.json` 的所有 hash pair，既有 `flock-voice-engine/runtime/test/domain/test-migration.test.js` 必须继续根据 `domain-test-migration.json` 验证成对测试体。

- [ ] **Step 2: Run RED**

Run: `node --test flock-voice-engine/runtime/test/agents/agent-orchestrator.test.js flock-voice-engine/runtime/test/integration/agent-composition.test.js mvp/test/deterministic-conductor.test.js flock-voice-engine/runtime/test/domain/deterministic-conductor.test.js flock-voice-engine/runtime/test/domain-parity.test.js flock-voice-engine/runtime/test/domain/test-migration.test.js flock-voice-engine/runtime/test/simulation-runtime.test.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/test/health.test.js`

Expected: FAIL because `agent-orchestrator.js`、`agent-composition.js` and the paired conductor APIs are absent。

- [ ] **Step 3: Implement mailbox integration**

```js
export function createAgentOrchestrator(deps) {
  return {
    scheduleReview,
    acceptEnvelope,
    takeForBoundary,
    getPublicState,
    close,
  };
}

export function createAgentComposition({
  providerConfig, fetchImpl, clock, setTimer, clearTimer, publishEnvelope, runnerFactory,
}) {
  // runnerFactory is called exactly twice with channel-specific immutable configs.
  // initialize() performs only the enabled master capability probe.
  // speciesEnabled is structurally false in live Phase 3–4 config.
  return { initialize, scheduleReview, acceptEnvelope, takeForBoundary,
    getPublicState, close };
}
```

每次日结创建 `applyBoundary={kind:'dawn',day:reviewedDay+1}` 和 generation 内严格递增 `scheduleSeq`；两 channel 同栈尝试启动但各自结算。每个 `onSettled(provider)` 必须从不可变 review 元数据构造完整 `AgentResultEnvelope` 后调用 `publishEnvelope(envelope)`，缺任一身份字段直接拒绝。orchestrator 以 boundary key 保存 latest schedule 和 consumed marker；结果到达和 boundary take 两处都执行 Shared Interfaces 的全套 stale 校验。apply 时用 current domain 重新 normalize；缺席、失败、迟到、superseded 或非法结果当场计算 policy，禁止读取 `lastFlockPlan` 或 `lastMasterDecision`。

把四个纯 agent-domain API 以同一个 patch 同时加入 `mvp/src/deterministic-conductor.js` 与 runtime copy；两个文件完成后必须逐字节相同，禁止只改 candidate copy。`src/index.js` 是唯一 composition root，顺序固定为：读取/校验 provider config → 创建两个独立 provider/runner 与 agent composition → 创建 simulation/session，并让 `publishEnvelope` 在回调执行时读取当前 `session.kernel` → `await agents.initialize()` → 创建 candidate server → localhost listen。缺 key 在 server/listen 前抛错；probe failure 只禁用 master 并保留 policy shadow。`server.js` 只接收 `agents.getPublicState` 的安全 getter，不接收 key/provider；SIGINT/SIGTERM 先停 tick，再 `await agents.close()`，最后关闭 server。

- [ ] **Step 4: Run GREEN and shadow regression**

Run: `node --test flock-voice-engine/runtime/test/agents/agent-orchestrator.test.js flock-voice-engine/runtime/test/integration/agent-composition.test.js mvp/test/deterministic-conductor.test.js flock-voice-engine/runtime/test/domain/deterministic-conductor.test.js flock-voice-engine/runtime/test/domain-parity.test.js flock-voice-engine/runtime/test/domain/test-migration.test.js flock-voice-engine/runtime/test/simulation-runtime.test.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/test/health.test.js`

Expected: PASS；fake provider 永不阻塞 tick，`domain-migration.json` 的实现 hash pairs 与 `domain-test-migration.json` 的 normalized test-body pairs 均保持相等。

Run: `git diff --no-index -- mvp/src/deterministic-conductor.js flock-voice-engine/runtime/src/domain/deterministic-conductor.js`

Expected: exit 0 and no output。

Run: `node --test flock-voice-engine/runtime/test/shadow-replay.test.js`

Expected: PASS with provider disabled and deterministic policy parity。

- [ ] **Step 5: Commit**

```bash
git add flock-voice-engine/runtime/src/agents/agent-orchestrator.js flock-voice-engine/runtime/src/agents/agent-composition.js flock-voice-engine/runtime/test/agents/agent-orchestrator.test.js flock-voice-engine/runtime/test/integration/agent-composition.test.js mvp/src/deterministic-conductor.js mvp/test/deterministic-conductor.test.js flock-voice-engine/runtime/src/domain/deterministic-conductor.js flock-voice-engine/runtime/test/domain/deterministic-conductor.test.js flock-voice-engine/runtime/test/domain-parity.test.js flock-voice-engine/runtime/src/simulation-runtime.js flock-voice-engine/runtime/test/simulation-runtime.test.js flock-voice-engine/runtime/src/world-session/world-session.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/src/server.js flock-voice-engine/runtime/src/index.js flock-voice-engine/runtime/test/health.test.js
git commit -m "feat(runtime): apply agent results at fixed boundaries"
```

**Rollback:** revert；Phase 1–2 policy-only shadow 恢复，生产 world 不受影响。

### Task 5: Agent 可观测性与 candidate 浏览器安全边界

**Files:**
- Create: `flock-voice-engine/runtime/src/agents/status-projector.js`
- Create: `flock-voice-engine/runtime/test/agents/status-projector.test.js`
- Create: `flock-voice-engine/runtime/test/security/agent-browser-boundary.test.js`
- Modify: `flock-voice-engine/runtime/src/world-session/world-session.js`
- Modify: `flock-voice-engine/runtime/test/world-session.test.js`
- Modify: `flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js`
- Modify: `flock-voice-engine/runtime/test/e2e/candidate-ui.spec.js`

**Interfaces:**
- Consumes: `AgentOrchestrator.getPublicState()`, Phase 1–2 snapshot/event journal and candidate RuntimeClient.
- Produces: `projectAgentStatus(internal): {species, master, lastDecision}` where each channel only exposes `enabled,status,source,reason,requestId,latencyMs,circuitState`.

- [ ] **Step 1: Write failing allowlist and browser tests**

```js
test('agent public state is allowlisted', () => {
  const json = JSON.stringify(projectAgentStatus(privateFixture));
  for (const forbidden of ['Authorization', 'prompt', 'rawResponse', '8081', 'api.deepseek.com']) {
    assert.equal(json.includes(forbidden), false);
  }
  assert.equal(JSON.parse(json).species.source, 'policy');
});
```

E2E 监听所有 candidate 请求并断言没有 8081、DeepSeek、`/decoder`；decision event 和 snapshot 必须能区分 `llm/policy/gated/stale_discarded`。

- [ ] **Step 2: Run RED**

Run: `node --test flock-voice-engine/runtime/test/agents/status-projector.test.js flock-voice-engine/runtime/test/security/agent-browser-boundary.test.js`

Expected: FAIL with missing status projector。

Run: `npm --prefix flock-voice-engine/runtime run test:e2e -- candidate-ui.spec.js`

Expected: FAIL on the new agent boundary/network assertions。

- [ ] **Step 3: Implement allowlisted projection**

```js
export function projectAgentStatus(internal) {
  return Object.freeze({
    species: projectChannel(internal.species),
    master: projectChannel(internal.master),
    lastDecision: projectDecision(internal.lastDecision),
  });
}
```

只把投影写入 authoritative snapshot/`decision` event；candidate 不实例化任何 LLM client。production `mvp/src/main.js` 的 legacy StepFun 接线不在本任务修改。

- [ ] **Step 4: Run GREEN**

Run: `node --test flock-voice-engine/runtime/test/agents/status-projector.test.js flock-voice-engine/runtime/test/security/agent-browser-boundary.test.js`

Expected: PASS。

Run: `npm --prefix flock-voice-engine/runtime run test:e2e -- candidate-ui.spec.js`

Expected: PASS，network log 只有 candidate HTTP/Runtime WS。

- [ ] **Step 5: Commit**

```bash
git add flock-voice-engine/runtime/src/agents/status-projector.js flock-voice-engine/runtime/test/agents/status-projector.test.js flock-voice-engine/runtime/test/security/agent-browser-boundary.test.js flock-voice-engine/runtime/src/world-session/world-session.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js flock-voice-engine/runtime/test/e2e/candidate-ui.spec.js
git commit -m "feat(runtime): expose safe agent provenance"
```

**Rollback:** revert UI/status projection；orchestrator 可继续 headless shadow，生产不变。

### Task 6: Latent map repository、八关系值与 XY/PCA 投影

**Files:**
- Create: `flock-voice-engine/runtime/src/latent/voice-config.js`
- Create: `flock-voice-engine/runtime/src/latent/map-repository.js`
- Create: `flock-voice-engine/runtime/src/latent/relations.js`
- Create: `flock-voice-engine/runtime/src/latent/projection.js`
- Create: `flock-voice-engine/runtime/test/latent/map-repository.test.js`
- Create: `flock-voice-engine/runtime/test/latent/relations.test.js`
- Create: `flock-voice-engine/runtime/test/latent/projection.test.js`
- Reference only: `mvp/src/config.js:497-539`
- Reference only: `mvp/src/ecological-latent.js:1-130`
- Reference only: `flock-voice-engine/assets/timbre/voice_maps/bass.json`
- Reference only: `flock-voice-engine/assets/timbre/voice_maps/pad.json`
- Reference only: `flock-voice-engine/assets/timbre/voice_maps/lead.json`

**Interfaces:**
- Produces: `createLatentMapRepository({assetRoot})` returning `{getInternal(voice), getPublicMap(voice, state)}`.
- Produces: `ecologicalRelations(tree, snapshot, config): number[8]`; `projectRelationsToXY(relations, projection): {x,y}`; `xyIntent(map,cursor,k)`; `pcaIntent(map,cursor)`; `findNeighbors(map,cursor,k)`.

- [ ] **Step 1: Write failing golden and leak tests**

```js
test('voice mapping and public DTO hide worker internals', () => {
  const internal = repository.getInternal('melody');
  assert.equal(internal.assetVoice, 'lead');
  const json = JSON.stringify(repository.getPublicMap('melody', latentState));
  for (const forbidden of ['row', 'checkpointStep', 'basis', '"z"', 'assetRoot']) {
    assert.equal(json.includes(forbidden), false);
  }
});

test('normalized PCA uses p5 and p95 asymmetrically', () => {
  assert.deepEqual(pcaIntent(map, { x: -0.5, y: 0.5, pca: [] }).coeffs.slice(0, 2), [
    0.5 * map.pca_basis.ranges[0].p5,
    0.5 * map.pca_basis.ranges[1].p95,
  ]);
});
```

加入 8 值归一化、现行 bass/pad/melody matrix/extent golden、XY scale/kNN、clamp、empty/corrupt map、NaN、非法 voice/PCA dim 和 `texture` 无 neural map。

- [ ] **Step 2: Run RED**

Run: `node --test flock-voice-engine/runtime/test/latent/map-repository.test.js flock-voice-engine/runtime/test/latent/relations.test.js flock-voice-engine/runtime/test/latent/projection.test.js`

Expected: FAIL with missing latent modules。

- [ ] **Step 3: Implement the repository and pure projection**

```js
export const LATENT_VOICES = Object.freeze({
  bass: { assetVoice: 'bass', extent: 0.72, k: 4 },
  pad: { assetVoice: 'pad', extent: 0.72, k: 4 },
  melody: { assetVoice: 'lead', extent: 0.78, k: 4 },
});
export function createLatentMapRepository({ assetRoot }) {
  return { getInternal, getPublicMap };
}
export function ecologicalRelations(tree, snapshot, config) {}
export function projectRelationsToXY(relations, projection) {}
export function xyIntent(map, cursor, k) {}
export function pcaIntent(map, cursor) {}
export function findNeighbors(map, cursor, k) {}
```

public point 坐标使用 map 的规范化 `px/py`；XY worker intent 使用 `cursor * map.scale`；PCA 每维负侧映射到 `p5`、正侧映射到 `p95`。basis、mean 和完整 `z` 只在 repository internal object 中存在。

- [ ] **Step 4: Run GREEN and legacy parity**

Run: `node --test flock-voice-engine/runtime/test/latent/map-repository.test.js flock-voice-engine/runtime/test/latent/relations.test.js flock-voice-engine/runtime/test/latent/projection.test.js`

Expected: PASS。

Run: `node --test mvp/test/ecological-latent.test.js`

Expected: PASS，现有 browser owner 未改变。

- [ ] **Step 5: Commit**

```bash
git add flock-voice-engine/runtime/src/latent/voice-config.js flock-voice-engine/runtime/src/latent/map-repository.js flock-voice-engine/runtime/src/latent/relations.js flock-voice-engine/runtime/src/latent/projection.js flock-voice-engine/runtime/test/latent/map-repository.test.js flock-voice-engine/runtime/test/latent/relations.test.js flock-voice-engine/runtime/test/latent/projection.test.js
git commit -m "feat(runtime): own latent maps and projection"
```

**Rollback:** revert；candidate 不再产生 latent intent，legacy browser 仍控制生产。

### Task 7: LatentRuntime 平滑、USER/AGENT control lease 与 cursor coalescing

**Files:**
- Create: `flock-voice-engine/runtime/src/control/lease-manager.js`
- Create: `flock-voice-engine/runtime/test/control/lease-manager.test.js`
- Create: `flock-voice-engine/runtime/src/latent/latent-runtime.js`
- Create: `flock-voice-engine/runtime/test/latent/latent-runtime.test.js`
- Create: `flock-voice-engine/runtime/test/latent/control-lease.test.js`
- Modify: `flock-voice-engine/runtime/src/world-session/world-session.js`
- Modify: `flock-voice-engine/runtime/test/world-session.test.js`
- Modify: `flock-voice-engine/runtime/src/simulation-runtime.js`
- Modify: `flock-voice-engine/runtime/test/simulation-runtime.test.js`

**Interfaces:**
- Consumes: Task 6 pure functions, `WorldSession.commit()` serialization and Phase 1–2 `NullAudioSink.accept(commands)`.
- Produces: `createLeaseManager({clock,tokenFactory,defaultTtlMs,maxTtlMs})` returning `{take({resource,clientId,connectionGeneration,ttlMs}),heartbeat({resource,clientId,connectionGeneration,leaseToken}),release({resource,clientId,connectionGeneration,leaseToken}),disconnect({clientId,connectionGeneration}),expire(nowMs),get(resource),getPublicState(resource)}`.
- Produces: `createLatentRuntime({voiceConfig,mapRepository,audioSink,clock,leaseManager})` returning `{updateEcology(snapshot,dt),takeControl(command),heartbeat(command),releaseControl(command),setCursor(command),setMode(command),tick(nowMs),disconnect({clientId,connectionGeneration}),getPublicState()}`.

- [ ] **Step 1: Write failing smoother/lease tests**

```js
test('takeover starts at current cursor and release glides back to ecology', () => {
  runtime.updateEcology(snapshot, 0.1);
  const before = runtime.getPublicState().melody.cursor;
  const lease = runtime.takeControl({
    voice: 'melody', clientId: 'c1', connectionGeneration: 'socket-1', ttlMs: 3000,
  });
  assert.deepEqual(runtime.getPublicState().melody.cursor, before);
  runtime.releaseControl({
    voice: 'melody', clientId: 'c1', connectionGeneration: 'socket-1',
    leaseToken: lease.leaseToken,
  });
  clock.advance(100);
  runtime.tick(clock.now());
  assert.notDeepEqual(runtime.getPublicState().melody.cursor, before);
});

test('disconnect only releases leases from the exact socket generation', () => {
  const first = leases.take({
    resource: 'latent:pad', clientId: 'c1', connectionGeneration: 'socket-1', ttlMs: 3000,
  });
  assert.equal(first.ok, true);
  assert.equal(leases.disconnect({ clientId: 'c1', connectionGeneration: 'socket-2' }).length, 0);
  assert.equal(leases.disconnect({ clientId: 'c1', connectionGeneration: 'socket-1' }).length, 1);
});
```

通用 lease tests 还要覆盖 take 冲突、token/client/generation 任一不符、heartbeat 延期、release 幂等、TTL expire、旧 socket disconnect 不释放新 socket 租约和 token 不进入 public state。latent tests 加入 `alpha=1-exp(-dt/4)` 的 fake-clock golden、10 Hz 更新上限、同 voice 双 client 竞争、TTL/disconnect 回 AGENT、乱序 eventSeq、高频 cursor 仅保留最新值、mode 切换清除旧 PCA/XY intent、world generation reset。

- [ ] **Step 2: Run RED**

Run: `node --test flock-voice-engine/runtime/test/control/lease-manager.test.js flock-voice-engine/runtime/test/latent/latent-runtime.test.js flock-voice-engine/runtime/test/latent/control-lease.test.js`

Expected: FAIL with missing `control/lease-manager.js` and `latent-runtime.js`。

- [ ] **Step 3: Implement the authoritative state machine**

```js
export function createLeaseManager({
  clock, tokenFactory, defaultTtlMs = 3000, maxTtlMs = 10000,
}) {
  return { take, heartbeat, release, disconnect, expire, get, getPublicState };
}

export function createLatentRuntime(deps) {
  return {
    updateEcology,
    takeControl,
    heartbeat,
    releaseControl,
    setCursor,
    setMode,
    tick,
    disconnect,
    getPublicState,
  };
}
```

通用 lease key 是 `resource`，owner identity 是 `(clientId,connectionGeneration)`；token 只在成功 `command.result` 返回持有者。未传入 `ttlMs` 时使用 `defaultTtlMs`，显式 TTL 必须是 `(0,maxTtlMs]` 内的有限整数；成功 take 保存该 TTL，heartbeat 仅在 resource/client/generation/token 全部精确匹配且尚未过期时按保存的 TTL 延期。`release` 幂等，`disconnect` 只释放精确 connection generation，`expire(nowMs)` 与 `disconnect()` 返回不可变的已释放 lease records 供调用者做 exactly-once cleanup；`getPublicState()` 永不含 token。latent resource 固定 `latent:<voice>`，默认 TTL 3000 ms、最大 TTL 10000 ms、heartbeat 最晚 1000 ms。Phase 5 的 `legacy-audio` 必须复用这个 manager，并把 `connectionGeneration` 设为精确 decoder socket generation，不能另造租约内核。连续 cursor 按 `(clientId,voice)` coalesce，范围固定 `[-1,1]`。

AudioSink 契约沿用 Phase 1–2：`accept(commands): void` 是同步调用，返回 `undefined` 即成功，不检查 truthiness；Phase 1–2 `NullAudioSink` 永不拒绝。失败测试只能注入 `throwingAudioSink`，其 `accept()` 同步抛 `AUDIO_INTENT_REJECTED`。LatentRuntime 必须先计算 immutable next state/audioCommands，在 `accept()` 成功后才发布 next state；throw 时不改变 authoritative latent state、revision/eventSeq 或 preview active 状态。每次 latent 更新把一个或多个 intent 组成数组交给 `audioSink.accept(commands)`；所有 mutation 和 accept 都由 `WorldSession.commit()` 的同一个 CommitDraft 驱动。

- [ ] **Step 4: Run GREEN and runtime regression**

Run: `node --test flock-voice-engine/runtime/test/control/lease-manager.test.js flock-voice-engine/runtime/test/latent/latent-runtime.test.js flock-voice-engine/runtime/test/latent/control-lease.test.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/test/simulation-runtime.test.js`

Expected: PASS；NullAudioSink 通过 `accept(commands)` 只累计 intent command 数量，没有网络/PCM。

- [ ] **Step 5: Commit**

```bash
git add flock-voice-engine/runtime/src/control/lease-manager.js flock-voice-engine/runtime/test/control/lease-manager.test.js flock-voice-engine/runtime/src/latent/latent-runtime.js flock-voice-engine/runtime/test/latent/latent-runtime.test.js flock-voice-engine/runtime/test/latent/control-lease.test.js flock-voice-engine/runtime/src/world-session/world-session.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/src/simulation-runtime.js flock-voice-engine/runtime/test/simulation-runtime.test.js
git commit -m "feat(runtime): own latent control and smoothing"
```

**Rollback:** disable candidate latent commands or revert；NullAudioSink 丢弃 shadow intent，生产无变化。

### Task 8: Preview lease、latent REST 与 Runtime WS commands

**Files:**
- Create: `flock-voice-engine/runtime/src/latent/preview-lease.js`
- Create: `flock-voice-engine/runtime/src/api/latent-routes.js`
- Create: `flock-voice-engine/runtime/test/latent/preview-lease.test.js`
- Create: `flock-voice-engine/runtime/test/api/latent-routes.test.js`
- Create: `flock-voice-engine/runtime/test/protocol/latent-commands.test.js`
- Modify: `flock-voice-engine/runtime/src/latent/latent-runtime.js`
- Modify: `flock-voice-engine/runtime/src/protocol/v1.js`
- Modify: `flock-voice-engine/runtime/src/api/bootstrap.js`
- Modify: `flock-voice-engine/runtime/src/api/runtime-ws.js`
- Modify: `flock-voice-engine/runtime/src/server.js`
- Modify: `flock-voice-engine/runtime/src/world-session/world-session.js`
- Modify: `flock-voice-engine/runtime/test/world-session.test.js`
- Modify: `flock-voice-engine/runtime/test/runtime-ws.test.js`

**Interfaces:**
- Consumes: Task 7 `leaseManager`, Phase 1–2 `executeCommand({clientId,generation,command})`, commandId/revision/eventSeq/dedupe, command `worldGeneration` and Runtime WS exact active connection generation. `RuntimeClient.command()` already copies the current `worldGeneration`; this plan does not add a second client-side generation source.
- Produces: `createPreviewLease({audioSink,clock,leaseManager})`; `createLatentRoutes({mapRepository,latentRuntime})`; commands `control.take/release/heartbeat`, `latent.setCursor`, `latent.setMode`, `preview.start/stop`; events `latent.state`, `control.lease`, `command.result`.

- [ ] **Step 1: Write failing protocol and release-race tests**

```js
test('preview requires the same voice control lease and always releases', () => {
  assert.equal(runtime.previewStart({
    voice: 'pad', clientId: 'observer', connectionGeneration: 'observer-1', commandId: 'p1',
  }).code, 'lease_required');
  const lease = takePad(runtime, 'owner', 'owner-1');
  assert.equal(runtime.previewStart({
    voice: 'pad', clientId: 'owner', connectionGeneration: 'owner-1',
    leaseToken: lease, commandId: 'p2',
  }).ok, true);
  runtime.disconnect({ clientId: 'owner', connectionGeneration: 'owner-1' });
  assert.equal(audioSink.accepted.at(-1)[0].type, 'preview.allOff');
  assert.equal(runtime.getPublicState().pad.preview.active, false);
});
```

加入 start 响应丢失后的同 commandId 重试、旧 `worldGeneration` 在 reset 后被拒绝、旧 connectionGeneration 的 stop/disconnect 不释放新 owner、TTL、candidate recovery、非法 revision/token/voice/mode、NaN/Infinity、path traversal 和 DTO 私有字段扫描。浏览器 payload 伪造 `connectionGeneration`/`generation` 必须被协议校验拒绝；generation 只来自服务端 attached socket context。

新增确定性 replacement race：socket generation 1 持有旧 handler，generation 2 attach 替换后，generation 1 依次发送 `control.take`、`control.heartbeat`、`control.release`、`latent.setCursor`、`latent.setMode` 和 `preview.start/stop`，每条都必须在 command dedupe lookup/write 和 `kernel.applyCommand()` 前返回 `STALE_CONNECTION_GENERATION`；lease、cursor、preview、revision/eventSeq 和 dedupe size 全部不变。generation 2 的同命令正常进入 kernel。另注入：

```js
const throwingAudioSink = {
  accept() { throw new Error('AUDIO_INTENT_REJECTED'); },
};
```

验证 preview start/latent update 返回显式 `audio_intent_rejected`，不把 `undefined` 当失败；刚取得的 preview lease 在同一 mailbox operation 内释放，public preview 始终 inactive，且没有错误的 all-off 重复发送。

- [ ] **Step 2: Run RED**

Run: `node --test flock-voice-engine/runtime/test/latent/preview-lease.test.js flock-voice-engine/runtime/test/api/latent-routes.test.js flock-voice-engine/runtime/test/protocol/latent-commands.test.js flock-voice-engine/runtime/test/runtime-ws.test.js flock-voice-engine/runtime/test/world-session.test.js`

Expected: FAIL with missing preview/route modules。

- [ ] **Step 3: Implement protocol allowlists**

```js
export const LATENT_COMMANDS = Object.freeze([
  'control.take', 'control.release', 'control.heartbeat',
  'latent.setCursor', 'latent.setMode',
  'preview.start', 'preview.stop',
]);
export function createPreviewLease({ audioSink, clock, leaseManager }) {}
export function createLatentRoutes({ mapRepository, latentRuntime }) {}
```

在 `protocol/v1.js` 中扩展 command allowlist/validator。`runtime-ws.js` 的 `routeCommand()`（若保持 inline handler，则该 handler 承担同一职责）只从 attached socket closure 取得服务端 generation，并对所有非 snapshot 命令调用 Phase 1–2 正式接口 `WorldSession.executeCommand({clientId,generation,command})`；浏览器不提供、也不能覆盖该值。authoritative exact-active 检查只能在 `executeCommand()` 的 mailbox 内完成，顺序固定为：查找 clientId 当前 subscription → exact generation 相等 → command/worldGeneration schema → commandId dedupe lookup/write → kernel；generation 缺失或 stale 返回 `STALE_CONNECTION_GENERATION`，不得命中/污染 dedupe，也不得调用 kernel。传给 kernel 的 immutable context 增加 `connectionGeneration:generation`。reset 后的旧 worldGeneration 不得取得、续租、释放或执行任何 latent/preview mutation。

`server.js` 注册 `GET /api/v1/latent-maps/{voice}`，`bootstrap.js` 只增加安全 latent capabilities。map route 返回 `{voice,points,range,pcaDimensions,pcaRanges,cursor,neighbors}`。preview 使用通用 manager 的 `preview:<voice>` resource，默认 TTL 2000 ms，并先验证同 owner 的 `latent:<voice>` lease；stop、TTL、control loss、disconnect、candidate recovery 均把 `[ {type:'preview.allOff', voice} ]` 交给 `audioSink.accept(commands)` exactly once。Phase 4 公共状态明确 `audible=false, phaseGate='shadow-no-audio'`。

- [ ] **Step 4: Run GREEN and protocol regression**

Run: `node --test flock-voice-engine/runtime/test/latent/preview-lease.test.js flock-voice-engine/runtime/test/api/latent-routes.test.js flock-voice-engine/runtime/test/protocol/latent-commands.test.js`

Expected: PASS。

Run: `node --test flock-voice-engine/runtime/test/runtime-ws.test.js flock-voice-engine/runtime/test/idempotency.test.js flock-voice-engine/runtime/test/bootstrap.test.js`

Expected: PASS；ready barrier、worldGeneration、revision、server-derived connectionGeneration 和 command dedupe 未回归。

- [ ] **Step 5: Commit**

```bash
git add flock-voice-engine/runtime/src/latent/preview-lease.js flock-voice-engine/runtime/src/api/latent-routes.js flock-voice-engine/runtime/test/latent/preview-lease.test.js flock-voice-engine/runtime/test/api/latent-routes.test.js flock-voice-engine/runtime/test/protocol/latent-commands.test.js flock-voice-engine/runtime/src/latent/latent-runtime.js flock-voice-engine/runtime/src/protocol/v1.js flock-voice-engine/runtime/src/api/bootstrap.js flock-voice-engine/runtime/src/api/runtime-ws.js flock-voice-engine/runtime/src/server.js flock-voice-engine/runtime/src/world-session/world-session.js flock-voice-engine/runtime/test/world-session.test.js flock-voice-engine/runtime/test/runtime-ws.test.js
git commit -m "feat(runtime): expose leased latent commands"
```

**Rollback:**关闭 candidate latent routes 或 revert；disconnect cleanup 先执行，生产 8090 不操作。

### Task 9: Candidate latent 纯视图、Phase 3–4 E2E 与聚合门禁

**Files:**
- Create by move: `mvp/src/ui/latent-roamer-legacy.js` from current `mvp/src/ui/latent-roamer.js`
- Create: `mvp/src/ui/latent-roamer.js`
- Create: `mvp/test/latent-roamer-view.test.js`
- Create: `mvp/test/backend-owned-boundary.test.js`
- Create: `flock-voice-engine/runtime/test/integration/phase34-shadow.test.js`
- Create: `flock-voice-engine/runtime/test/e2e/latent-candidate.spec.js`
- Create: `flock-voice-engine/runtime/test/security/phase34-data-leak.test.js`
- Create: `flock-voice-engine/runtime/scripts/run-phase34-tests.mjs`
- Modify: `mvp/src/main.js:31-35`
- Modify: `flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html`
- Modify: `flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js`
- Modify: `flock-voice-engine/runtime/test/candidate-surface.test.js`
- Modify: `mvp/test/latent-roamer-control.test.js`
- Modify: `mvp/test/latent-roamer-panel.test.js`
- Modify: `mvp/test/product-surface.test.js`
- Modify: `flock-voice-engine/runtime/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: Phase 1–2 `RuntimeClient.command(name,payload,{baseRevision,commandId})`（由 client 自动复制当前 `worldGeneration`）, Task 8 map API and public events.
- Produces: `createLatentRoamer({document,runtimeClient,fetchMap,getState,voice,onClose})` returning `{open(voice),close(),render(state),destroy()}`; no audio/provider/domain dependency.

- [ ] **Step 1: Preserve the legacy production adapter and write failing pure-view tests**

先用 `git mv mvp/src/ui/latent-roamer.js mvp/src/ui/latent-roamer-legacy.js`，把 `mvp/src/main.js` 和现有两组 legacy roamer tests 的 import 改到 `latent-roamer-legacy.js`，运行原测试证明零行为变化；随后为新 `latent-roamer.js` 写：

```js
test('candidate roamer sends normalized intent and trusts authoritative state', async () => {
  await roamer.open('melody');
  dragTo(0.25, -0.5);
  assert.deepEqual(runtimeClient.commands.at(-1), {
    name: 'latent.setCursor',
    payload: { voice: 'melody', cursor: { x: 0.25, y: -0.5 }, leaseToken: 'lease-1' },
  });
  roamer.render(serverState({ cursor: { x: 0.1, y: -0.2 } }));
  assert.deepEqual(readCursor(), { x: 0.1, y: -0.2 });
});
```

加入 take reject、heartbeat/TTL、preview pending/reject、WS reconnect、snapshot/event 乱序、map 404、async open/close race、键盘作用域与 aria-live。

- [ ] **Step 2: Run RED**

Run: `node --test mvp/test/latent-roamer-view.test.js mvp/test/backend-owned-boundary.test.js`

Expected: FAIL because the new pure-view module and boundary test are absent。

- [ ] **Step 3: Implement the pure view and candidate composition**

```js
export function createLatentRoamer({
  document,
  runtimeClient,
  fetchMap,
  getState,
  voice,
  onClose = () => {},
}) {
  return { open, close, render, destroy };
}
```

新模块只绘制 server points/neighbors/range/cursor，并发送 control/latent/preview commands。它不得 import `agent.js`、`llm/`、`audio.js`、`ecological-latent.js`，不得请求 `/api/decoder-status` 或 `voice_maps/`，不得出现 row/kNN/PCA basis/`timbreXY`/`timbrePCA`/`stepfunBase`/8081。candidate reconnect 后只用 server snapshot 恢复；lease token 仅保存在 RuntimeClient 内存。测试 fixture 的 `candidate-main.js` 从 repo-root 静态服务器以绝对路径导入 `/mvp/src/runtime-client.js`、renderer 和 `/mvp/src/ui/latent-roamer.js`；fixture 页面固定为 `flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html`，不在 `mvp/` 建 candidate entry。legacy 文件及 production main 继续 browser owner。

- [ ] **Step 4: Add shadow, E2E, security and aggregate scripts**

`phase34-shadow.test.js` 使用相同 seed/world fixture 验证 provider failure 不阻塞 tick、late result 丢弃、latent 生态 cursor 在明确 `1e-9` 绝对容差内与 legacy oracle 一致。`latent-candidate.spec.js` 打开 `http://127.0.0.1:4193/flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html`，用两个 Chromium client 验证唯一 lease、heartbeat、disconnect 回 AGENT、preview `audible=false` 和 reconnect snapshot。`phase34-data-leak.test.js` 扫描 REST、WS 和 candidate 依赖图。

扩展 `candidate-surface.test.js` 与 `backend-owned-boundary.test.js`，同时断言：

```js
assert.equal(readFileSync('mvp/index.html', 'utf8').includes('candidate-ui'), false);
assert.equal(readFileSync('docs/production-manifests/2026-07-22-production.json', 'utf8')
  .includes('candidate-ui'), false);
assert.equal(existsSync('flock-voice-engine/web/test/fixtures/candidate-ui'), false);
assert.equal(existsSync('mvp/candidate-runtime.html'), false);
assert.equal(existsSync('mvp/src/candidate-main.js'), false);
```

新增 `scripts/run-phase34-tests.mjs`：递归枚举 `test/` 下且仅枚举 `*.test.js`，按规范化相对路径排序；若 `test/agents/`、`test/latent/`、`test/api/`、`test/protocol/`、`test/integration/`、`test/security/` 任一前缀没有测试就 fail closed；随后用 `spawnSync(process.execPath, ['--test', ...files], {stdio:'inherit'})` 执行完整 inventory 并原样传播非零/异常退出。这样脚本在当前 Node 下启动当前 Node，在 `node@20` 下启动同一个 Node 20 executable，同时明确排除 `test/e2e/*.spec.js` 与 `test/fixtures/**`。

在 runtime `package.json` 增加：

```json
{
  "scripts": {
    "test:phase34": "node scripts/run-phase34-tests.mjs",
    "test:phase34:node20": "npx -y node@20 scripts/run-phase34-tests.mjs"
  }
}
```

在根 `package.json` 增加：

```json
{
  "scripts": {
    "verify:phase34": "npm run verify:phase0 && npm run verify:phase12 && npm --prefix flock-voice-engine/runtime run test:phase34 && npm --prefix flock-voice-engine/runtime run test:phase34:node20 && npm run test:mvp && npm run check"
  }
}
```

两个 runtime scripts 必须使用同一 inventory runner，不得各自维护文件列表。Node 20 门禁必须在 TAP 输出中看到 `agents/`、`latent/`、`api/`、`protocol/`、`integration/`、`security/` 下的命名测试，并与当前 Node 运行同样 exit 0。

- [ ] **Step 5: Run GREEN**

Run: `node --test mvp/test/latent-roamer-control.test.js mvp/test/latent-roamer-panel.test.js mvp/test/latent-roamer-view.test.js mvp/test/backend-owned-boundary.test.js mvp/test/product-surface.test.js`

Expected: PASS；legacy tests 走 `latent-roamer-legacy.js`，candidate tests 走纯视图。

Run: `npm --prefix flock-voice-engine/runtime run test:e2e -- latent-candidate.spec.js`

Expected: PASS；candidate 只连接 `127.0.0.1:18090`，无 PCM 和外部 provider 请求。

Run: `npm --prefix flock-voice-engine/runtime run test:phase34:node20`

Expected: PASS；显式 Node 20 从 runtime root 执行完整递归 `*.test.js` inventory，且没有加载 Playwright spec/browser fixture。

Run: `npm run verify:phase34`

Expected: PASS；其中 `npm run verify:phase0`、`npm run verify:phase12`、当前 Node runtime suite 与显式 Node 20 runtime suite 均 exit 0。

- [ ] **Step 6: Prove production invariants without writing production**

Run:

```powershell
$expectedManifest = '1ebd697b2e0d0cec8b0cbec008fc884179c6273b97952837f661c2c39f6065ec'
$actualManifest = (Get-FileHash -Algorithm SHA256 'docs/production-manifests/2026-07-22-production.json').Hash.ToLowerInvariant()
if ($actualManifest -ne $expectedManifest) { throw 'production manifest changed' }
git diff --exit-code 4d1eaaf0a0a5bb430c39d7c2b5f7ad6a4c1dbee9 -- flock-voice-engine/server flock-voice-engine/deploy flock-voice-engine/web docs/production-manifests
if ($LASTEXITCODE -ne 0) { throw 'Phase 3–4 touched frozen production paths' }
```

Expected: manifest SHA 精确相等，冻结 production paths 无 diff。本地 candidate identity 仍是 `releaseRevision=unknown/sourceManifestSha256=unknown`，`/readyz` 仍是 503、`phaseGate=shadow-no-audio`、`runtimeOwner=browser`、`audioOwner=legacy`。

- [ ] **Step 7: Commit**

```bash
git add mvp/src/ui/latent-roamer-legacy.js mvp/src/ui/latent-roamer.js mvp/src/main.js mvp/test/latent-roamer-control.test.js mvp/test/latent-roamer-panel.test.js mvp/test/latent-roamer-view.test.js mvp/test/backend-owned-boundary.test.js mvp/test/product-surface.test.js flock-voice-engine/runtime/test/fixtures/candidate-ui/index.html flock-voice-engine/runtime/test/fixtures/candidate-ui/candidate-main.js flock-voice-engine/runtime/test/candidate-surface.test.js flock-voice-engine/runtime/test/integration/phase34-shadow.test.js flock-voice-engine/runtime/test/e2e/latent-candidate.spec.js flock-voice-engine/runtime/test/security/phase34-data-leak.test.js flock-voice-engine/runtime/scripts/run-phase34-tests.mjs flock-voice-engine/runtime/package.json package.json
git commit -m "feat(ui): make candidate latent roamer view-only"
```

**Rollback:** 先停止 localhost candidate 或关闭 candidate latent writes，再 revert；production legacy module/main/8090 从未切换。

## Review Gates

1. Task 2 后审“逻辑 timeout 不释放未 settle 的物理 GPU slot”；不满足就禁止接 8081。
2. Task 4 后审固定 apply boundary、generation reset、current-domain revalidation 和无 last-result fallback；现有“迟到但保留”语义只能留在 production legacy，不能进入 candidate。
3. Task 5 后扫描 browser payload/bundle；出现 endpoint、prompt、raw response 或 provider import 就拒绝。
4. Task 7 后审 USER takeover/release 无跳变、token 不进 snapshot、所有 mutation 走 WorldSession mailbox。
5. Task 8 后审 preview exactly-once all-off 和 `audible=false`；Phase 4 不能伪装已接真实 audio worker。
6. Task 9 后必须同时通过 `npm run verify:phase0`、`npm run verify:phase12`、当前 Node 与显式 Node 20 的递归 runtime suite、`npm run verify:phase34` 与冻结路径 diff；只能报告“Phase 3–4 candidate/shadow 验证通过”，不能报告生产已接管。

## Phase 3–4 Completion Criteria

- species/master 任一 provider disabled、gated、timeout、circuit open、invalid output 或完全故障时，candidate world tick 都不阻塞，policy source/reason 可观察。
- 所有正常及 burst fixture 中 species 物理 in-flight 最大为 1；忽略 Abort 的旧请求 settle 前不会发第二个 8081 请求。
- 每个结果都是完整 `AgentResultEnvelope`，只在精确 `applyBoundary` 使用；低/冲突 scheduleSeq、非 latest request、迟到、已消费 boundary、旧 world generation、未来 scheduled revision 和当前菜单不合法均丢弃，正常 tick 导致 current revision 前进不误杀。
- candidate 浏览器没有 8081/DeepSeek、prompt/schema、API key、retry/circuit 或 agent fallback。
- 八关系、固定 projection、XY/PCA、kNN、平滑、control/preview lease 和 worker intent 均由 candidate backend 计算。
- candidate roamer 只画服务端 DTO、发规范化 intent、显示 authoritative state；不解析 row/map asset/PCA basis，不直接调用 audio。
- 两客户端竞争同 voice 时只有一个 lease；TTL/disconnect 后回 AGENT；preview 任何释放路径 exactly-once all-off。
- `127.0.0.1:18090`、`runtimeOwner=browser`、`audioOwner=legacy`、`shadow-no-audio` 保持不变；生产 8090 和生产 PCM 没有写操作。
- 当前 Node 与显式 Node 20 都从 runtime root 通过同一个 fail-closed inventory 执行全部嵌套 `*.test.js`，且不误载 E2E spec/browser fixture；任何一套失败都不算 Phase 3–4 完成。
- 最终音频 render p95/p99、underrun 与真实 8081 normal/burst 共载是 Phase 5 audio worker/原子切换硬门禁；本计划只交付 admission、telemetry contract 和可重复 fault fixture，不在共享生产 GPU 上压测。

## Rollback Boundary

Phase 3 rollback 是关闭 candidate provider flags并继续 deterministic policy shadow；Phase 4 rollback 是拒绝 candidate latent writes、释放所有 candidate lease/preview 后停止 localhost candidate。两者都不需要也不允许操作生产 8090。旧 Python 8090、legacy browser world/agent/latent/audio owner 和旧 `/decoder` 全程不变，因而回滚不涉及生产 world 导入或 PCM 切换。
