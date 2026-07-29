# Phase 5 签名故障证据与等价主机验收设计

日期：2026-07-29
状态：设计已冻结，本地 runner 切片实现中，真实等价主机验收未执行
适用分支：`refactor/backend-owned-runtime` / rebuild continuation

## 1. 目的与非目标

本设计补齐 reconciliation Task 10 的真实故障验收链。目标不是让一个脚本输出
`passed: true`，而是证明：

1. 固定候选 release 在隔离等价 Spark 上运行；
2. 固定七类故障确实发生；
3. 故障态被独立观测；
4. 系统在限定时间内恢复；
5. 计划内影响与额外异常严格分账；
6. raw evidence、summary、acceptance 和 package 形成不可静默替换的链。

本设计不授权访问、修改、停止或重启生产 8090。没有隔离等价 Spark 和受控 actuator
时，Task 10 必须保持 blocked。

## 2. fake 与 real 永久分轨

### 2.1 本地 fake smoke

本地文件固定为 `fault-smoke.json`：

- `schemaVersion = 2`
- `kind = "local-fake-fault-smoke"`
- `cutoverEligible = false`
- 场景固定为：
  `identity-tamper`、`worker-crash`、`worker-stall`、`replace-timeout`、
  `edge-overflow`、`pcm-corruption`、`slow-writer`、`lease-disconnect`、
  `provider-timeout`、`world-continues`

fake smoke 只证明 runner 能执行状态迁移、识别 no-op 和缺失恢复。它不得被复制、改名、
补字段或经 validator 提升为 acceptance evidence。

### 2.2 真实等价主机 fault run

真实运行固定产生：

- `acceptance-evidence/fault-events.json`
- `acceptance-evidence/phase5-summary.json`
- `acceptance.json`

真实场景顺序固定为：

1. `worker-crash-restart`
2. `runtime-reconnect`
3. `slow-client`
4. `queue-pressure`
5. `agent-timeout`
6. `agent-malformed-response`
7. `audio-epoch-discontinuity`

场景不得重叠；全部落在同一个 30 分钟 measurement window 内；最后一个场景恢复后必须
保留至少 30 秒稳定窗口。

## 3. 统一 run identity

soak 启动时一次性生成：

- `runId`：UUID v4
- `challenge`：256-bit 随机值的小写十六进制

下列文件必须绑定相同的 `runId` 和完整 release tuple：

- `fault-events.json`
- `soak-run.json`
- `phase5-summary.json`
- `acceptance.json`
- staging machine attestation

release tuple 包含：

- `releaseManifestSha256`
- `releaseRevision`
- `sourceManifestSha256`
- `audioArtifactSha256`
- 完整 geometry

任一文件的 run identity 或 release tuple 不同均 fail closed。

## 4. `fault-events.json`

顶层 exact keys：

```json
{
  "schemaVersion": 1,
  "kind": "isolated-equivalent-spark-fault-events",
  "runId": "<uuid-v4>",
  "challenge": "<hex64>",
  "release": {},
  "geometry": {},
  "profile": {},
  "window": {},
  "signer": {},
  "scenarioEvents": [],
  "transportEvents": [],
  "eventChainSha256": "<hex64>"
}
```

每个场景固定五个事件：

```text
before
→ fault-action
→ fault-observed
→ recovery-action
→ recovery-observed
```

因此必须恰好有 35 个 scenario event。事件 exact keys：

```json
{
  "sequence": 1,
  "runId": "<same uuid>",
  "scenario": "<fixed scenario>",
  "phase": "<fixed phase>",
  "atMonotonicMs": 0,
  "atUnixMs": 0,
  "previousEventSha256": "<hex64>",
  "payload": {},
  "signature": "<canonical Ed25519 base64>"
}
```

`previousEventSha256` 指向前一个包含 signature 的 canonical event；首事件使用 64 个
`0`。`eventChainSha256` 等于末事件 digest。

signed transport event 必须足以独立重算服务端所见四个客户端的：

- runtime/audio open、close 与 reconnect generation
- PCM cursor、block sequence、start frame 和 gap
- pause/resume
- audio discontinuity、epoch 与 stream revision

它不能替代客户端实际接收证明。`client-observations.json` 还必须逐事件保存四个客户端
在 decode 后观察到的 socket lifecycle、PCM header/length/finite/cursor 校验结果、
双时钟、connection identity/generation、frame digest 与显式 discontinuity；
`render-samples.json` 必须保存每次 250 ms 采样的原始 render P95/P99、
block duration 和 recent underruns。validator 对 hot clients 1–3 全窗重算 boundary、
pairwise 和 final PCM gap；计划故障 SLO 不能被整段当作 gap 豁免。client 4 只有与 signed
slow-client action/receipt exact 对上的 pause→resume 区间可以免除区间内部 gap。
只保存 aggregate 不满足验收。

## 5. 签名与 actuator 边界

普通 SHA 只能防事后误改，不能防完整手写一套 raw JSON。真实 acceptance 因此要求候选
runtime 在 isolated fault mode 中生成 run-scoped Ed25519 key：

- private key 仅存在于候选进程内；
- fault-control 只能签固定 typed state；
- 不提供“签任意 payload”接口；
- actuator 只允许固定场景和固定 candidate target；
- 禁止调用者传任意脚本、shell 字符串或容器名。

签名输入固定为：

```text
"flock-phase5-fault-event-v1\0"
+ canonical({
    "challenge": top.challenge,
    "release": top.release,
    "event": event_without_signature
  })
```

staging attestation 必须绑定 signer SPKI bytes 的 SHA。validator 同时验证 SPKI、每个 event
签名、event hash chain 和场景语义。没有 signer binding 的输出只能叫 smoke，不能设置
`cutoverEligible = true`。

## 6. 场景语义与恢复 SLO

| 场景 | 必须出现的故障 | 必须出现的恢复 | SLO |
|---|---|---|---|
| worker-crash-restart | exact audio candidate 被 kill，worker not-ready | 新 audio epoch，world generation 不变，热 PCM 继续 | 15 s |
| runtime-reconnect | client 4 runtime disconnect | 新 connection generation，snapshot barrier 恢复 | 5 s |
| slow-client | client 4 显式 pause 至少 2 s | client 4 PCM 恢复，热 1–3 持续推进 | 7 s |
| queue-pressure | client 4 egress 达容量并以 4410/EGRESS_OVERFLOW 关闭 | client 4 新 generation 重连，热客户端不关闭 | 5 s |
| agent-timeout | 单个注入请求实际 timeout | world 继续，下一真实 bird_agent 请求成功 | 15 s |
| agent-malformed-response | 预定 malformed response 被 schema 拒绝 | world 继续，下一真实请求成功 | 15 s |
| audio-epoch-discontinuity | 受控 epoch rotation | 四客户端各恰好一个 discontinuity，随后新 epoch PCM 推进 | 10 s |

summary 的 outcome 必须由 validator 从 signed raw events 重算，不能信任 producer 的
`passed` 字段。

## 7. 计划内影响与 unexpected 指标

现有逻辑把所有 hot-client close、reconnect、discontinuity、telemetry gap 都计为异常，
这与真实 fault run 冲突。

新规则：

- 只有签名 fault window 内、数量和类型与场景精确一致、且在 SLO 内恢复的影响才计为
  `expectedFaultEffects`；
- 超量、超时、错误客户端、错误 close code、window 外事件全部计为
  `unexpectedStabilityFailures`；
- acceptance 中的零异常只表示 unexpected 为零，绝不允许清零原始事件。

## 8. `phase5-summary.json` 与 acceptance

summary exact 绑定：

- run/release/geometry/profile/window
- fault raw events digest、event chain digest、signer digest
- soak raw timeline、四客户端实际接收观测与三组 percentile samples
- species normal/burst samples
- Chromium E2E 与 lease evidence
- production graph
- production/staging attestation
- `phase5-raw-manifest.json` 及其 candidate capture-nonce PoP
- listening checklist
- acceptance tool identity

summary 固定为 schema v2，顶层 exact keys 为：

```text
schemaVersion, kind, status, runId, challenge, release, geometry, profile,
window, session, rawArtifacts, faultValidation, acceptanceProjection,
acceptanceTool
```

其中 `rawArtifacts` 必须 exact 绑定
`faultEventsSha256`、`soakRunSha256`、`rawRuntimeReadySamplesSha256`、
`rawUiStateLagSamplesSha256`、`rawRenderSamplesSha256`、
`clientObservationsSha256`、`speciesNormalSamplesSha256`、
`speciesBurstSamplesSha256`、`phase5E2eSha256`、`leaseEvidenceSha256`、
`productionGraphSha256`、`productionMachineAttestationSha256`、
`stagingMachineAttestationSha256`、`listeningChecklistSha256`、
`equivalenceSha256` 和 `rawManifestSha256`。summary 中的
`faultValidation` 必须是固定 Node composite 的 canonical 原样结果；
`acceptanceProjection` 的每个值必须由 validator 从 raw 重算，不能读取 producer
aggregate。

`acceptance.json` 升为 schema v2：

- 新增顶层 `runId`
- evidence 新增且仅新增 `phase5SummarySha256`
- 其余 release、geometry、duration、stability、latency、species、audible、lease 字段必须
  与 summary projection 完全一致

链路固定为：

```text
signed typed event
→ fault-events.json SHA
→ phase5-summary.json SHA
→ acceptance.evidence.phase5SummarySha256
→ package acceptance SHA
```

## 9. Machine attestation v2

等价机除稳定身份不得与生产相交外，还必须匹配：

- architecture
- GPU model
- driver version
- CUDA version
- 由 `MemTotal` 向上归一到标准 2 的幂容量档的 memory class

`MemAvailable` 只保留为当时运行环境观测，不能代表机器内存等级。v1 attestation 缺少
稳定 memory class，必须重新采集，不能自动升级。

staging 的 fault-session binding 不能只接受任意路径中的自导 SPKI digest。capture
必须从固定 candidate run root 的受控 channel 取得一次性 challenge 的 Ed25519
proof-of-possession；PoP 覆盖 runId、challenge、完整 release/geometry/profile、signer
和 capture nonce，并由进入 release 执行身份的固定 Node verifier 验证。

非 fault raw 不能只依赖一条可整体重算的普通 SHA 链。所有 measurement raw 先写入
磁盘，再生成 canonical `phase5-raw-manifest.json`；manifest 固定列出这些 raw 的摘要，
但排除 staging attestation、summary 和 acceptance，避免自引用。
`rawManifestSha256` 必须同时进入 candidate capture-nonce PoP 和 staging run binding。
summary 从磁盘重算 manifest、PoP 和全部成员摘要，三者必须 exact 一致。这样事后替换
client/render/checklist 等 raw 并重算 summary 不能获得新的有效会话证明。机器
attestation evidence 目录及所有父路径/叶子必须拒绝 symlink、junction 与 reparse，
按 production/staging 角色使用 exact inventory；每个 raw 文件只读取一次，同一份
bytes 同时用于 digest 和解析。机器 binding 仍须在 acceptance v2 与 fault-events、
summary、soak 和 release 交叉绑定，单独一份自洽 JSON 不是 trust root。

## 10. 原子写入顺序

1. 创建私有 temporary evidence 目录；
2. 生成 runId/challenge，校验 canonical release；
3. 启动 signed fault session；
4. 完成 Chromium/lease preflight，打开四个客户端；
5. 运行 30 分钟 window 与七个非重叠场景；
6. 先写 raw samples、client observation timeline、transport timeline、fault
   events、soak run 和 canonical raw manifest；
7. 以 raw manifest digest 完成 capture-nonce PoP，并当场采集 staging attestation；
8. 从磁盘重新读取并重算 summary；
9. 原子 rename temporary evidence；
10. 最后以 `wx` 写 acceptance。

任一步失败都不得留下 final acceptance。

## 11. 实施与验收边界

本地可完成：

- fake runner 与 no-op/recovery/type-confusion 负测
- exact fault plan/schema/validator
- virtual-clock fault window 与 expected/unexpected 分账
- signature/hash-chain 的测试 key 验证
- raw → summary → acceptance 重算测试
- crash-point 原子发布测试
- machine attestation v2

只能在隔离等价 Spark 完成：

- 真实 candidate actuator 和 runtime signer
- 真实 release、pool 5/block 4096
- 四客户端、一个 slow、30 分钟
- 真实 bird_agent 8081 shared load
- 七类真实 fault 与 operator listening
- staging attestation 和最终 acceptance

在最后一组证据存在并通过前，只能声明 runner/validator 本地 GREEN，不能声明 Task 10 或
cutover gate 完成。

## 12. 安全审查后的 schema v2 收敛

本节覆盖第 4、5、8 节中 `fault-events.json` schema v1 的结构描述。安全审查证明：
只签 35 个 scenario event，仍无法阻止 transport、geometry、profile 或 window 被整体
替换；允许自由 `payload` 也无法证明七类故障真实发生。因此真实 acceptance 必须
hard-reject schema v1，不提供自动升级或 v1/v2 双栈放行。

### 12.1 fault evidence v2 顶层

顶层 exact keys 固定为：

```text
schemaVersion, kind, runId, challenge, release, geometry, profile, window,
signer, scenarioEvents, transportEvents, eventChainSha256,
transportChainSha256, closure
```

固定值和边界：

- `schemaVersion = 2`；
- geometry 必须精确为 `44100 / 4096 / 5 /
  [bass,pad,lead,pluck,pad]`；
- profile 必须精确为 4 clients、client 4 为 slow、30 分钟、
  `http://127.0.0.1:8081/v1` 和 `bird_agent`；
- monotonic 与 Unix window 均精确为 `1,800,000 ms`；
- 两个时钟的事件相对 offset 偏差不得超过 1 ms；
- canonical JSON 拒绝非有限数、未配对 surrogate、accessor、Symbol、
  non-enumerable 字段、稀疏数组和自定义 prototype。

### 12.2 transport chain 与 scenario prefix

transport event exact envelope：

```json
{
  "sequence": 1,
  "runId": "<uuid-v4>",
  "atMonotonicMs": 0,
  "atUnixMs": 0,
  "client": 0,
  "type": "<fixed enum>",
  "previousTransportSha256": "<hex64>",
  "payload": {}
}
```

固定 type enum：

```text
runtime.open, runtime.ready, runtime.snapshot, runtime.close, runtime.egress,
audio.open, audio.ready, audio.pcm, audio.discontinuity,
audio.pause, audio.resume, audio.close,
worker.sample, agent.start, agent.settle, observer.failure
```

runtime/audio 事件只允许 client 1–4；worker/agent/observer 事件只允许 client 0。
sequence 必须连续，首事件链头为 64 个 `0`，后续指向前一个 canonical transport
event digest。真实证据要求至少一个 transport event。

scenario event v2 在原 exact envelope 上新增：

```text
transportPrefixCount, transportPrefixSha256
```

两字段进入 event signing bytes。prefix count 单调不降；`0` 绑定零链头，否则必须
等于对应 transport 前缀的末 digest；被包含的 transport 时间不得晚于 scenario event。
prefix 还必须是该 scenario event 时刻已 flush 的最大前缀：若存在第一个未包含
transport event，它的 monotonic 与 Unix 时钟都必须严格晚于 scenario event，任一时钟
早于或等于 scenario event 都 fail closed，禁止把已经发生的影响留到后续 prefix
“因果回填”。
第 35 个 scenario event 必须绑定非空恢复前缀，但不能覆盖其时间之后的 30 秒稳定尾窗；
完整 transport chain 由 window end 的 closure 绑定。recorder 在签 event 前先 flush，
禁止先签名后补写观察；tail continuity 由 summary validator 从最后 prefix 到
`window.end` 独立重算。最后一个 transport event 的两个时钟都必须落在各自
`window.end` 前 250 ms 内；只记录最后场景后的 30 秒、随后提前截断 30 分钟 window
其余部分必须拒绝。

### 12.3 run-end closure

closure exact keys：

```json
{
  "scenarioEventCount": 35,
  "transportEventCount": 1,
  "signature": "<canonical Ed25519 base64>"
}
```

签名输入固定为：

```text
"flock-phase5-run-closure-v1\0"
+ canonical({
    runId, challenge, release, geometry, profile, window,
    eventChainSha256, transportChainSha256,
    scenarioEventCount, transportEventCount
  })
```

closure 由同一个 run-scoped signer 产生。追加、截断、重排 transport，替换
geometry/profile/window，或改任一 count/digest，都必须导致验签失败。外部 validator
不得使用 evidence 自带 signer digest 作为信任根；它只能使用已经通过 raw-evidence
复算的 staging machine attestation 中的 fault-session binding。

### 12.4 typed payload 与纯函数分账

状态 phase 的 payload 固定为：

```json
{"kind":"state","state":{}}
```

action phase 固定为：

```json
{"kind":"action","action":{"operation":"<fixed>","target":"<fixed>","receipt":{}}}
```

operation、target 和 receipt schema 按七场景/phase 固定。调用方只能请求“执行 plan
下一步”，不能传 shell、argv、容器名、PID 或任意 target。actuator sequence 必须严格为
1–14。state 必须等于 validator 从已绑定 transport prefix 计算出的投影，不能信任
producer 自报。

`transportProjection` 不是 producer 可提交的 evidence 字段。它只能是 validator 在
完成 raw transport chain、prefix 与 signer 校验后生成的内存对象，并作为 typed
semantics validator 的必需独立输入；缺失投影、把 scenario payload 深拷贝成投影或
使用未验签 transport 生成投影都必须拒绝。

composite 入口必须先把 evidence 与外部 trusted run binding 分别序列化为一次
canonical JSON bytes，再从该 bytes 解析出 validator-owned 普通对象快照。验签、
cross-bind、transport projection、typed semantics、effect ledger 与最终 SHA 全部只能
读取同一快照；禁止在验签后重新读取调用方可变引用。这样既固定 CLI 的 JSON 边界，也
避免内存调用方通过 Proxy 或时序变更在验签后替换 transport。

worker 投影使用 exact 字段
`pid/ready/recovering/audioEpoch/restartCount/supervisorGeneration/lastExitedPid/lastExitSignal`。
crash 后必须观察到旧 PID 与 `SIGKILL`，恢复由 supervisor 自行完成；recovery action
只能是 `await-supervisor-ready` 一类非变更观察，不能主动 restart 来掩盖 supervisor
失效。七场景构成同一条 reducer 时间线，场景间 world、generation、PCM cursor、
discontinuity、worker restart/supervisor generation 不得回滚或静默重置。
四个 runtime client 的 run-scoped connection identity 必须两两不同；reconnect 只能
保留本 client 原 identity，不能借共享 digest 把一个连接伪装成四个客户端。

provider 的 `startedAtMonotonicMs/settledAtMonotonicMs` 与 scenario
`atMonotonicMs` 使用同一 monotonic clock domain，并强制
`faultAction <= injected.start <= injected.settle <= faultObserved` 以及
`recoveryAction <= real.start <= real.settle <= recoveryObserved`。timeout receipt 绑定
固定 attempt timeout、deadline、fixture identity/hash 和 idle admission 结果。共享
负载允许 before 已有上一条合法真实结果，不能要求 `lastResult` 为 null。

五个 prefix 形成每个场景的 action/observed 区间。matcher 只把数量、客户端、类型和
时间都精确符合合同的影响记入 `expectedFaultEffects`；任意未消费的 close、reopen、
pause/resume、discontinuity、worker degraded、non-ok agent 或 `observer.failure` 均进入
`unexpectedStabilityFailures`。summary 中的 `passed` 或 count 永远不作为输入。
`before → fault-action` 与 `fault-observed → recovery-action` 两个间隙也必须只包含
相对各自基线的中性观察；不能在 action 区间之外插入 pause→resume 一类最终状态恢复的
瞬态副作用。逐事件消费账本必须覆盖每个 prefix 之间的全部 raw transport，不能只比较
三个状态快照。

最后一个 recovery-observed 之后必须保留至少 30 秒可验证稳定尾窗。尾窗内只允许保持
同 generation 的正常快照/egress open、连续 audio PCM、完全相同的 ready worker
sample，以及成对完成的真实 provider start/ok settle。四客户端 PCM 观察间隔不得超过
250 ms；四客户端 runtime snapshot 与 worker sample 同样不得留下超过 250 ms 的
未观测空洞，最后一次各类观察必须覆盖到 window end。world 必须继续推进；真实 provider
请求必须在固定 15 秒 deadline 内完成。任何未消费 close/open、pause/resume、
discontinuity、degraded worker、injected/non-ok provider、pending request、overflow
或 `observer.failure` 都使整次 run fail closed。只检查最终状态而忽略中间副作用不构成
稳定性证明。

### 12.5 acceptance v2 与实现顺序

`acceptance.json` 同样 hard-bump 到 schema v2，并新增同一 `runId` 和
`phase5SummarySha256` 绑定。Python 标准库没有 Ed25519 verifier；实现不得静默跳过验签，
也不得假定未声明的 `cryptography`/`nacl` 依赖。采用 Node `crypto` 时，verifier 本身
必须进入 release 的执行身份清单，由 Python 以固定路径、固定参数、超时和精确 stdout
调用。

固定 Node verifier 不接受 argv，只接受 stdin 上 exact canonical
`{"evidence":...,"runBinding":...}\n`。读取阶段使用 128 MiB 上限，拒绝 duplicate key、
非法 UTF-8、非 canonical whitespace、尾随 bytes 和 producer 提交的 result/projection；
只有完整 composite 成功并完成 canonical result 序列化后才能一次提交 stdout，失败时
stdout 必须为空。CLI 及其 evidence/projector/semantics/composite import closure 都要
进入 release 执行身份，不能只认证入口文件。

本地实施顺序固定为：

1. transport hash chain、scenario prefix 和 closure signature；
2. 七场景 typed state/action 与虚拟时钟攻击测试；
3. staging attestation fault-session binding；
4. raw evidence 到 summary 的纯函数重算；
5. acceptance/schema/package/Phase 6 consumer 同步 hard-bump；
6. isolated-only actuator 与 recorder 接线；
7. 隔离等价 Spark 上真实 30 分钟运行。

前五步可本地完成。第六步只能构造默认关闭、production wiring 不可达的候选能力；第七步
仍是 Task 10 唯一真实 GREEN 条件。

## 13. 非 fault raw v2 精确合同

本节冻结 summary 可信复算所需的非 fault raw。旧 runner 只保存 aggregate，且每 5 秒
暂停 client 4 两秒；两者均不得升级为 v2。v2 的 slow-client 豁免只能来自七场景中
唯一、签名且 exact 对应的 `slow-client` pause→resume。

### 13.1 `client-observations.json`

顶层 exact keys 固定为：

```text
schemaVersion, kind, runId, challenge, release, geometry, profile,
window, clients, events
```

固定值：

```text
schemaVersion = 2
kind = "isolated-equivalent-spark-phase5-client-observations"
```

`clients` 必须按 1、2、3、4 排序，每项 exact keys 为
`client,clientIdentitySha256`，四个 identity 两两不同，并与 signed transport 的
`runtime.open.payload.clientIdentitySha256` 一一相同。

每个 event exact envelope 为：

```text
sequence, client, type, connectionGeneration,
atMonotonicMs, atUnixMs, payload
```

`sequence` 从 1 连续递增；每个客户端、每个通道 generation 从 1 开始，只能在 close
后增加；双时钟不得回退，并以 window 起点计算的相对时间差不得超过 1 ms。允许的
type/payload 为：

`events` 必须非空且最多 100,000 项。`connectionGeneration`、`streamRevision` 与
`blockSeq` 上限为 uint32，close code 为 1–65535；其余 sequence/revision/eventSeq、
transport sequence 与十进制 frame cursor 均不得超过 JavaScript safe integer。
`worldGeneration` 与 `audioEpoch` 为 1–128 个非 NUL 字符，reason 为 1–256 个非
NUL 字符。

| type | payload exact keys |
|---|---|
| `runtime.open` | `mode` |
| `runtime.ready` | `frameSha256,worldGeneration,revision,eventSeq` |
| `runtime.snapshot` | `frameSha256,worldGeneration,revision,eventSeq,probeSeq` |
| `runtime.close` | `code,reason` |
| `runtime.error` | 空对象；accepted 中禁止出现 |
| `runtime.invalid-frame` | `frameSha256,byteLength,validationCode`；accepted 中禁止出现 |
| `audio.open` | 空对象 |
| `audio.ready` | `frameSha256,audioEpoch,streamRevision,blockSeq,resumeStartFrame` |
| `audio.pcm` | 见下 |
| `audio.discontinuity` | `frameSha256,scope,audioEpoch,streamRevision,blockSeq,resumeStartFrame` |
| `audio.pause` / `audio.resume` | `transportSequence,transportEventSha256` |
| `audio.close` | `code,reason` |
| `audio.error` | 空对象；accepted 中禁止出现 |
| `audio.invalid-frame` | `frameSha256,byteLength,validationCode`；accepted 中禁止出现 |

`audio.pcm.payload` exact keys 为：

```text
frameSha256, byteLength, wireVersion, flags, headerBytes, audioEpoch,
streamRevision, blockSeq, startFrame, frameCount, channels, format,
headerValid, lengthValid, finiteSamples, cursorValid
```

accepted artifact 固定 `byteLength=32800`、`wireVersion=1`、`flags=0`、
`headerBytes=32`、`frameCount=4096`、`channels=2`、`format=1`，四个校验布尔值
全部为 true；`startFrame` 使用 canonical 十进制字符串；`frameSha256` 对实际收到的
完整 WebSocket binary message bytes 求 SHA-256。invalid event 必须先记入 raw 再使
run 失败，禁止用空 catch 吞掉。

hot client 1–3 的 window start→first、任意 pair、last→window end 在两个时钟上均须
小于等于 1000 ms；fault SLO 不豁免 hot gap。client 4 只允许一个与 signed transport
exact 对应的 pause→resume；扣除暂停时长后的相邻 PCM gap 仍须小于等于 1000 ms，
boundary/final gap 不豁免。额外 pause、错 client/generation、暂停期间仍收到 PCM、
resume 后无 PCM 均失败。discontinuity 与 signed transport 必须双射消费。
所有 runtime open 以及 audio open/close 生命周期也必须与 verified signed transport
projection exact 双射；不能在 raw 中插入一个未签名的 close→reopen 后仍把 reconnect
计为零。同一 audioEpoch 内即使 streamRevision 合法增加，blockSeq 和 PCM cursor 也
不得回滚；只有 audioEpoch 实际变化时才允许按已签 discontinuity 合同从零开始。
新 audioEpoch 不得复用该客户端此前已经出现过的历史 epoch。window 结束时四个
runtime 与 audio 通道必须全部处于 open+ready，且 audio 不得仍在 paused 状态。

transport projector 的纯函数输出 kind 固定为中性的
`phase5-client-observations-transport-projection`。只有固定 Node composite 在同一份
validator-owned canonical snapshot 上完成 closure/Ed25519 验签、external signer
cross-binding、完整 transport 重放、typed semantics 与 effect ledger 后，才可提升为
`phase5-client-observations-signed-transport-projection`。Python fixed-memory package
schema v2 通过 exact `operation=fault-validation-with-client-projection` 从同一次 stdout
同时取得 `faultValidation` 与该投影；summary composite raw boundary 只能消费这一输出，
不得接受外部单独传入或只凭 signed kind 命名的 projection。旧显式 projection helper
仅保留为兼容/单元边界，不是可信 acceptance 主路径。

Python 的三个 public signed-fault boundary 只接受 evidence/root/run binding，不暴露
verifier path、runner、identity 或 Node executable 注入。五文件 Node verifier closure
由 validator 内固定 SHA-256 pin，并要求 summary `acceptanceTool` 声明 exact 相等；
实际执行前再从固定 release/source-tree 位置单读并复核同一组 pin。测试 runner/path 等
替身只允许进入下划线私有 helper。Node executable 仍来自受控外部
`PHASE5_APPROVED_NODE_EXE` / `PHASE6_APPROVED_NODE_EXE` 配置，因此这一闭环只证明
fixed composite 接线，不替代 capture PoP、formal `validate_bundle` 或 host-root trust。

### 13.2 `render-samples.json`

顶层复用相同 run/release/window binding，末项为 `samples`，kind 固定为：

```text
isolated-equivalent-spark-phase5-render-samples
```

每项 exact keys：

```text
sequence, atMonotonicMs, atUnixMs,
renderP95Ms, renderP99Ms, blockDurationMs, recentUnderruns
```

三个时间值必须 finite、非负且 `renderP95Ms <= renderP99Ms`；
`blockDurationMs` 必须等于 `4096 / 44100 * 1000`；`recentUnderruns` 必须为零。
render 数值不得超过 JavaScript safe integer。Phase 5 v2 canonical bytes 使用固定
key 的 UTF-16 code-unit 顺序和 ECMAScript `JSON.stringify` 数字拼写；因此
`1.0→1`、`1e-5→0.00001`、`-0.0→0`。summary 数值投影也按同一规则比较，
不能因 Python 的 `100.0` / Node 的 `100` 或零值拼写差异拒绝合法证据。
250 ms 采样至少覆盖 90%，首样本不晚于 500 ms，末样本距 window end 不超过
750 ms，pair gap 不超过 1000 ms。summary 只从这些原值重算 P95/P99 block fraction，
不得读取 producer ratio。

### 13.3 `phase5-raw-manifest.json`

顶层 exact keys：

```text
schemaVersion, kind, runId, challenge, release, geometry, profile,
window, artifacts
```

固定 `schemaVersion=2`，
`kind="isolated-equivalent-spark-phase5-raw-manifest"`。每项 exact keys 为
`artifact,path,byteLength,sha256`，并按以下顺序恰好 14 项：

1. `faultEventsSha256` → `acceptance-evidence/fault-events.json`
2. `soakRunSha256` → `acceptance-evidence/soak-run.json`
3. `rawRuntimeReadySamplesSha256` → `acceptance-evidence/runtime-ready-samples.json`
4. `rawUiStateLagSamplesSha256` → `acceptance-evidence/ui-state-lag-samples.json`
5. `rawRenderSamplesSha256` → `acceptance-evidence/render-samples.json`
6. `clientObservationsSha256` → `acceptance-evidence/client-observations.json`
7. `speciesNormalSamplesSha256` → `acceptance-evidence/species-normal-samples.json`
8. `speciesBurstSamplesSha256` → `acceptance-evidence/species-burst-samples.json`
9. `phase5E2eSha256` → `acceptance-evidence/phase5-e2e.json`
10. `leaseEvidenceSha256` → `acceptance-evidence/lease-evidence.json`
11. `productionGraphSha256` → `production-graph.json`
12. `productionMachineAttestationSha256` → `production-machine-attestation.json`
13. `listeningChecklistSha256` → `listening-checklist.json`
14. `equivalenceSha256` → `staging-equivalence.json`

manifest 不自列，也不包含 staging attestation、fault-session attestation、summary 或
acceptance。summary 的 16 个 raw digest 因此由 14 个 leaf、manifest 自身及其后生成的
staging attestation 完整闭合。path 只接受上述固定 POSIX spelling；拒绝重排、重复、
大小写别名、绝对路径、`..`、symlink、junction 和 reparse。每个 leaf 只读一次，同一份
bytes 同时用于 byteLength、SHA 和解析。

大小写约束同时检查实际目录项 spelling，不能只比较 manifest 字符串后依赖大小写不敏感
文件系统打开。manifest 上限 1 MiB；leaf 在读取前以 `fstat`、读取过程中以累计字节数
双重限长，固定上限如下：

| artifact | max bytes |
|---|---:|
| `faultEventsSha256` | 128 MiB |
| `soakRunSha256`, `phase5E2eSha256`, `productionGraphSha256` | 各 16 MiB |
| `rawRuntimeReadySamplesSha256`, `rawUiStateLagSamplesSha256` | 各 8 MiB |
| `rawRenderSamplesSha256` | 16 MiB |
| `clientObservationsSha256` | 64 MiB |
| `speciesNormalSamplesSha256`, `speciesBurstSamplesSha256` | 各 64 MiB |
| `leaseEvidenceSha256`, `productionMachineAttestationSha256`, `listeningChecklistSha256`, `equivalenceSha256` | 各 8 MiB |

### 13.4 capture-nonce PoP

fault-session attestation hard-bump 到 v2，并新增：

```json
"captureProof": {
  "captureNonce": "<hex64>",
  "rawManifestSha256": "<hex64>",
  "signature": "<canonical Ed25519 base64>"
}
```

签名输入固定为：

```text
"flock-phase5-capture-proof-v1\0"
+ canonical({
    runId, challenge, release, geometry, profile,
    signer, captureNonce, rawManifestSha256
  })
```

staging `runBinding` exact 增加
`captureNonce,rawManifestSha256`。固定 Node fault verifier 继续接收 runBinding 原有
字段的 validator-owned projection；PoP 由另一个进入 release execution identity 的固定
Node verifier 验证。流程固定为 leaf 落盘→manifest→candidate 一次性 finalize/签名→
capture 当场验 PoP→显式 `--attestation-role staging-phase5`→summary 单次重读复算。

这不是硬件远程证明，不能抵抗已控制 isolated host root 的攻击者；它防止的是 run 结束
后替换整组非 fault raw 并重算 summary。当前候选实现已经包含 pure signature verifier、
固定 CLI/release closure、candidate 内部一次性 finalizer、受控 capture channel、
Python bootstrap/attempt registry，以及 runtime 与 controller 接线；各窄边界攻击复审和
Spark 裸机 UDS 验证已经通过。这些结果仍不能替代同一容器 PID1、Docker namespace、
bind mount 和完整 staging run 的组合证明，因此尚不能把 production staging session
描述为已验收。

#### 13.4.1 candidate 受控 channel（冻结设计 v2，候选已接线）

真实 candidate 必须在承载 runtime 的同一个 Node 进程内创建 capture finalizer；禁止另起
只负责签名的 helper 进程。finalizer 内部生成 Ed25519 私钥，私钥不得从 caller 注入、不得
导出，第一次 finalize 尝试（包括 malformed 请求）后立即永久封闭。

`docker run -d` / Engine create 没有把宿主任意匿名 FD 继承给容器 PID1 的受控接口；
stdin attach 会改变 detached 生命周期并混入另一条控制通道。因此 v1 文案中的“继承匿名
FD”不可实现，禁止以 env、argv、普通 nonce 文件、`docker exec` 或签名 helper
repair-forward。冻结的 v2 bootstrap 固定如下：

1. controller 为本次 attempt 创建唯一的宿主机私有目录，以及彼此分离的
   `run-flock-phase5-bootstrap/` 与 `run-flock-phase5-candidate/` bind-source；三者均为
   controller 所有、`0700`、全路径 `lstat` 拒绝 symlink。bootstrap source 只读挂载到
   candidate 固定 `/run/flock-phase5-bootstrap`，capture source 读写挂载到固定
   `/run/flock-phase5-candidate`；controller registry 不挂入容器；
2. controller 在 bootstrap source 中先监听 `bootstrap.sock`，生成 32-byte CSPRNG
   nonce，nonce 只保留于 controller 内存；candidate PID1 Node 启动后连接容器内固定
   `/run/flock-phase5-bootstrap/bootstrap.sock`；
3. controller 接受第一条连接后立即停止 accept 并 unlink pathname，经
   `docker inspect` 固定 host PID/UID 后，以 `SO_PEERCRED` exact 核对同一 peer；连接
   自此只剩两端持有的匿名 FD；
4. controller 发送唯一一行 canonical bootstrap，exact keys 为
   `schemaVersion,kind,identity,captureNonce`。`identity` 是完整五字段
   `runId,challenge,release,geometry,profile`；candidate 必须把其中 release/geometry/
   profile 与自身 trusted release 和固定验收 profile exact 核对；
5. 同一 PID1 Node 用该 nonce 创建内部 finalizer 和 `capture.sock`，再在同一全双工
   bootstrap 连接返回 canonical admission；controller 将 PID/UID、identity、nonce、
   SPKI DER/SHA-256 和 admission digest 以 `O_EXCL`、`0400`、fsync 写入容器不可见的
   attempt registry；成功落盘后 controller 才新生成 32-byte CSPRNG
   `receiptChallenge`，回传 exact 绑定 admission digest 和该 challenge 的 canonical
   ACK，并保持自己的 write side 打开；
6. Node 读到 ACK 的唯一 canonical LF 后验证 digest 与 `receiptChallenge`，回传 exact
   绑定二者的 canonical receipt，并造成该连接不可逆的全双工关闭。controller 只有收到
   receipt、EOF，并在自身 write side 仍打开时确认 peer 真正 `POLLHUP`，才把 bootstrap
   标记完成；该证据证明的是 peer 已不可逆关闭连接，不单独声称观察到某个具体 `close()`
   syscall。仅 `SHUT_WR`、预发 receipt 或未消费 ACK 均不得通过。Node 只有该关闭完成后
   才允许 `app.start()`。EOF、超限、超时、credential mismatch、state commit 失败、
   ACK/receipt 丢失或 challenge mismatch，均关闭 capture listener、消费 finalizer 并
   使 candidate 启动失败；不得接受第二连接或复用 run/nonce。

控制器必须在测量开始前在自身私有状态中固定：

```text
expected candidate PID + UID
expected runId + challenge
expected capture nonce
expected signer SPKI DER + SHA-256
expected canonical admission SHA-256
```

candidate 只监听固定
`/run/flock-phase5-candidate/capture.sock`；父目录必须由本次控制器以 `0700` 创建并
通过 bind mount 持有。容器内 candidate pathname 与宿主机 controller pathname不同：
controller 只能连接本次私有 bind-source 下的 `capture.sock`，不能要求 `yfhuang`
在宿主机 `/run` 创建目录。socket 和所有父路径拒绝 symlink。capture client 连接后必须
先用 Linux
`SO_PEERCRED` 得到 peer PID/UID，与启动时固定值 exact 相等；不能信任响应里的自报 PID。
listener 接受第一条连接后立即停止 accept 并 unlink pathname。请求是唯一一行 canonical
JSON，exact keys：

```text
schemaVersion, kind, runId, challenge, captureNonce, rawManifestSha256
```

其中 `schemaVersion=1`、`kind="phase5-candidate-capture-finalize-request"`；所有绑定字段
必须与控制器预先固定值和刚落盘 manifest digest exact 相等。任意 EOF、额外字节、重复
member、超限、peer mismatch 或签名失败都永久消费 channel/finalizer，整个 run 失败，
不得 reconnect/retry 获得第二次签名。

响应只允许一行 canonical JSON，包含 v2 session 与完整 9-field runBinding。capture 用
测量开始前固定的 external SPKI 验签，并 exact 核对 nonce、manifest、PID/UID、release、
geometry、profile 后，才允许立即采集 `staging-phase5` machine attestation。Windows
本地测试只覆盖 pure protocol/state machine；`SO_PEERCRED`、目录权限、socket inode 和
同进程 runtime ownership 必须在 Linux authority test 与隔离等价 Spark 上验证。

当前本地候选实现已经把这条链拆成四个窄边界并分别 fail closed：

1. candidate 内部 finalizer 自行生成 Ed25519 私钥，caller 只能交付 32-byte nonce；
   首次成功或失败 finalize 都清空私钥并永久封闭；
2. pure protocol 在首次请求开始前即消费 channel，request/session/response 都按原始
   canonical UTF-8 bytes 校验，BOM、duplicate member、尾随字节和超限全部拒绝；
3. candidate listener 的 public production API 固定容器内 pathname、`0700` parent、
   `0600` socket，首连接立即停止 accept 并 unlink，使用固定 4096-byte request buffer
   和覆盖 request、response flush、peer close 的绝对 5 秒 deadline；传输失败、
   listener error 或显式 close 均关闭 active peer 并消费 finalizer；下划线内核可接受
   同结构的 host bind-source pathname，仅供测试；
4. controller client helper 接受 controller-owned bind-source 目录并自行派生
   `capture.sock`，在发送前拥有并验证 admission 与完整五字段 run identity，
   通过 `SO_PEERCRED` exact 核对 signed PID/unsigned UID，确认 pathname 已 unlink，
   half-close 一次请求，并用固定 2 MiB buffer 读到 EOF；response 再进入固定 Node
   verifier，按 canonical bytes exact 比对完整 validation。

这些 helper 已进入 `runtime/src/index.js`、固定 release execution closure 与
`deploy/release_control.py stage-local`。controller 在任何 Docker 副作用前，从已验
manifest 的 bytes 固定加载两个 Python 模块；它创建并持续持有短路径私有 registry、
bootstrap UDS 与 attempt/nonce 状态，runtime 入口先完成 admission，再初始化 agents
并 listen。admission 由 controller 先 durable commit，回传其 SHA 后 bootstrap 才 ACK；
每个 Docker launch 使用 controller 私有、事前不存在的 cidfile；即使 CLI 失败或 stdout
损坏，也只允许从完整稳定的 64-hex cidfile 获得清理 authority，随后按 runtime→audio
顺序清理。partial、symlink、重绑或非法 cidfile 不获得删除权限。legacy lease 工具不再
通过可重绑 pathname 挂载；每次操作都把 manifest 已验的 exact module bytes 加固定 shim，
经 stdin 送入一次解析后的 exact runtime container ID。runtime lifecycle 也已把 signal、
capture terminal 与 HTTP fatal 收敛到一次 cleanup。

Windows pure tests、独立窄复核以及 Spark 隔离 `/tmp` 中不启动 Docker 的真实
bootstrap/UDS/`SO_PEERCRED`/fresh receipt/admission fsync/cidfile 组合测试已经通过。
scope gate 忽略 `SSH_CONNECTION` 等传输元数据，但仍拒绝 `/srv/deploy`、生产 IP、
production publish 与 remote Docker 配置；本次最终机验证另外限定在隔离 `/tmp` 和
本地 Docker。
尚未完成的强制项是：从已提交 revision 重绑 production graph、真实 Docker PID
namespace 与 bootstrap/candidate bind mount authority、完整 artifact/attestation，以及
30 分钟正式验收。因此仍不得据此签发 `staging-phase5`。

#### 13.4.2 capture-and-attest controller 安全勘误

本节覆盖 13.4 中“显式 `--attestation-role staging-phase5`”的 CLI 描述。后续事务审计证明：
若 machine collector 公开接受 role、session 或 evidence path，调用方可以绕过 admitted
candidate attempt 和一次性 channel 的因果边界；若 summary 在 channel 消费前验证或由 soak
另行生成，则崩溃恢复还可能丢失 session 或重签。

正式 staging 流程因此只允许一个公开入口：

```text
release_control.py capture-and-attest-local --release-dir <release-root>
```

除 release root 外不得公开 attempt/container/PID/UID/socket/nonce/SPKI/raw manifest/session/
profile/role/output/host evidence/runner 输入。staging machine capture 是 controller-owned
Python 内部 API；machine collector CLI 只保留 production-baseline。

controller 必须先持有唯一 admitted attempt 和 release-root dirfd，完成全部 raw/profile/output
preflight，再以 append-only `capture-intent.json` 武装一次性事务；随后只消费一次 channel，
并立即持久化 verifier 从 response `session` 字段固定的 exact canonical session bytes，而不是
整个 response wrapper。进程重启后，external full-9 trust root 只能由 immutable admission 的
identity/nonce/SPKI DER、capture intent 的 raw-manifest SHA 和 persisted session 的
controller-computed SHA 重建，并用 admission SPKI DER 重新验 session；禁止从 session 或
attestation 自导 expected binding。

admission commit 必须在 append-only record 中持久化当时 capture socket 的 exact
`device/inode/type/mode/uid/gid/nlink`，并在 record fsync 前后从 held candidate dirfd 证明
socket snapshot 未变。candidate bind-source inventory 必须随 append-only state 精确收窄：
pre-arm 恰好是 admission 持久化 snapshot 对应的 `capture.sock`；
session/attestation/commit 时必须为空；intent-only 只允许同一 socket 或空目录且两者都永久
禁止 reconnect；failure record 必须用固定
`channelDisposition=not-connected|consumed` 分别绑定同一 socket 或空目录。所有状态都拒绝
额外 entry；新进程必须从 admission snapshot 识别同路径 replacement，不能用全局放宽
inventory 支持 resume。

signer 武装后，validator 不得再通过用户 pathname 重新打开 raw manifest、machine evidence
或 summary 输入。controller 必须从 held release-root dirfd 以 no-follow single-read 固定 owned
bundles；machine composite 和 summary builder 只消费这些 snapshots。summary 必须由
validator-owned builder 从 raw/session/attestation bundles 重算并立即 composite 验证，不能把
只验证调用方 value 的旧 API 当作 summary producer。

machine evidence 必须先在 controller-owned 私有 temporary tree 完整写入并 fsync，再
exclusive no-replace 发布 final evidence，最后以 O_EXCL output 作为 marker。evidence-only
状态只能在 exact inventory/composite 复验后补 output；output-only、partial final evidence、
未知 temporary tree 或冲突 inventory fail closed。只允许清理经 held dirfd/inode 与事务 marker
证明属于同一 attempt 的 private partial temp，永不删除或覆盖 final evidence。

attestation commit 必须绑定 capture intent、session、raw manifest、normal/burst profile、
staging machine output 和 exact evidence inventory 的摘要。commit 后，controller 是
`phase5-summary.json` 的唯一 writer，并以 canonical O_EXCL/0400/fsync 发布；soak 只生产
raw leaves 与 raw manifest，不能另写 summary。Task 1–5 稳定后必须从 committed blobs 最终
重绑 production graph，再允许运行完整 consumer gate。

2026-07-29 已在最终 Spark 主机 `yfhuang@192.168.9.140` 的隔离 `/tmp` 目录运行真实
Node listener/finalizer/protocol 与 Python controller/fixed Node verifier：
正向链 `SO_PEERCRED` 的 peer PID 与 controller 固定 PID exact 相等、UID=1004、
socket=0600、完整 Ed25519 capture response 通过，Node raw `peer.on("data")` 观测
366 bytes；故意 PID mismatch 时同一 raw observer 观测 `0` bytes，Node
channel/finalizer 仍一次性消费并封闭。探针目录和进程已清理。
这次单独的 listener 探针关闭了裸机 Linux capture-channel authority 的窄缺口；后续
隔离测试又覆盖了 bootstrap UDS，但仍没有覆盖同一容器 PID1 的 runtime 生命周期、
Docker PID namespace/bind mount 或 30 分钟正式验收。

### 13.5 runtime ready 与 UI lag 原始时刻

`runtime-ready-samples.json` 不再保存 producer 计算的四个 latency 数字。顶层 exact
keys 为：

```text
schemaVersion, kind, runId, challenge, release, geometry, profile,
window, samples
```

固定 `schemaVersion=2`，
`kind="isolated-equivalent-spark-phase5-runtime-ready-samples"`。`samples` 恰好按
client 1、2、3、4 排列，每项 exact keys 为：

```text
sequence, client, connectionGeneration,
openedAtMonotonicMs, openedAtUnixMs,
readyAtMonotonicMs, readyAtUnixMs, readyFrameSha256
```

四个客户端必须在 30 分钟 window 开始后才打开，首代 connectionGeneration 固定为 1；
ready 不得早于 open。open 与 ready 各自的 monotonic/Unix 相对时钟偏差不超过 1 ms，
同一个样本用两个时钟计算出的 ready latency 也不得相差超过 1 ms。summary 的
`runtimeReadyP95Ms` 只取四个 monotonic 差值的 nearest-rank P95；这些时刻及
`readyFrameSha256` 后续必须与 `client-observations.json` 的 `runtime.open` /
`runtime.ready` exact 一一对应。

`ui-state-lag-samples.json` 使用相同顶层 binding，固定
`kind="isolated-equivalent-spark-phase5-ui-state-lag-samples"`。每项 exact keys：

```text
sequence, client, connectionGeneration, probeSeq,
sentAtMonotonicMs, sentAtUnixMs,
observedAtMonotonicMs, observedAtUnixMs, snapshotFrameSha256
```

sequence 从 1 连续递增，client 按 1、2、3、4 固定轮询；probeSeq 对每个
client/connectionGeneration 从 1 连续递增，generation 增加时重置为 1。sent/observed
必须位于 window 内且 observed 不早于 sent；两端相对双时钟
偏差和两个时钟算出的 latency 差均不超过 1 ms。目标 cadence 为 2 秒，至少 95% 覆盖；
首个 sent 不晚于 window start 后 4 秒，最后一个 observed 距 window end 不超过 6 秒，
相邻 sent 和 observed 的 gap 均不超过 8 秒。summary 只从 monotonic
`observed-sent` 重算 P95。`snapshotFrameSha256`、client/generation/probeSeq 和 observed
时刻后续必须与 client observations 中的 `runtime.snapshot` exact 一一对应；不能用
独立 raw 文件重复声明而不做交叉验证。

### 13.6 species load 保存原始响应

`species-normal-samples.json` 与 `species-burst-samples.json` 使用相同 exact 顶层：

```text
schemaVersion, kind, runId, challenge, release, geometry, profile,
window, mode, samples
```

固定 `schemaVersion=2`，
`kind="isolated-equivalent-spark-phase5-species-load-samples"`；`mode` 分别只能为
`normal` 与 `burst`。每项 exact keys：

```text
sequence, batchSequence, slot,
startedAtMonotonicMs, startedAtUnixMs,
settledAtMonotonicMs, settledAtUnixMs,
httpStatus, responseBodyBase64
```

每次请求都必须在 window 内开始和结束，双时钟相对偏差与两个时钟计算出的 latency
偏差均不超过 1 ms，单次 latency 不超过 15 秒，HTTP status 必须 exact 200。
`responseBodyBase64` 是实际 HTTP response body bytes 的 canonical base64；validator
必须在 base64 解码前先按 1 MiB decoded 上限约束编码长度，解码后再次限长，严格
UTF-8/JSON 解析、拒绝 duplicate members，并从第一条 choice 的 message content
重新解析 exact `{"ok":true}` token。producer 不再提交可自报的 `ok` 或
`latencyMs`。

normal 每批一项，`batchSequence=sequence`、`slot=1`，2 秒目标 cadence 至少 95%
覆盖；首请求不晚于 4 秒，最后响应距 window end 不超过 10 秒，相邻开始时刻 gap
不超过 10 秒。burst 每 10 秒一批、每批固定四项，sequence、batchSequence、slot
必须形成连续 `[1,2,3,4]`，同批开始时刻 spread 不超过 100 ms；至少 95% 的 180 批，
首批不晚于 20 秒，末批响应距 window end 不超过 50 秒，相邻批开始 gap 不超过
50 秒。accepted run 中所有样本均须成功，summary 的 request count 和两个 raw digest
只从这两份 manifest-owned bytes 重算，errors 固定为零。
“最后响应”取所有并发 samples 的最大 settled monotonic/Unix 时刻，而不是数组最后一项
或最后一批；完成顺序不要求与 sequence 相同。
