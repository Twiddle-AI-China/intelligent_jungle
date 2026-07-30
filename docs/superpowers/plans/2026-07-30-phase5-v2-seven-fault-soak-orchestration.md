# Phase 5 v2 七故障 soak orchestration 实施计划

> 分支：`rebuild/phase6-reconciliation`
>
> 基线：`63a29b3d1e36dd68a27a965d4288de8efd4e8841`
>
> 设计依据：
> `docs/superpowers/specs/2026-07-29-phase5-signed-fault-evidence-design.md`
>
> 执行方式：每个 task 先写能证明安全边界的 RED，再做最小 GREEN；每个 task 独立评审和
> 提交。Task 9 只完成真实 producer/runner 的本地实现和隔离工程预检。
>
> **2026-07-30 owner policy update：** Zhang Jiangnan 明确批准 Task 10 复用
> production Spark 的稳定 machine/SSH/GPU/interface identity。该例外必须以
> `owner-approved-production-spark` equivalence v2 落盘，且必须固定
> `productionCutoverAuthorized=false`。它只授权 Phase 5 隔离验收，不授权生产切换。

## 1. 当前基线与目标

当前已经完成：

- `fault-events.json` schema v2、transport SHA chain、35 个 scenario events、closure
  signature；
- 七场景 typed state/action、14 个固定 receipt、SLO、effect ledger 与稳定尾窗验证；
- 四客户端 raw、render、runtime-ready、UI lag、species raw、14-leaf raw manifest 的
  Python validator；
- candidate admission、run-scoped Ed25519 capture proof、append-only attempt state；
- controller-owned machine attestation、summary 重算和唯一 summary 发布事务；
- production graph 当前为 185 files / 294 edges / 68 routes，inner SHA
  `438843ee36d90168dc292d893654d1f5e1edb5532b1c85673aceebd4b3b29cfe`。

当前尚未完成：

- 候选 runtime 内没有真实七故障 authority、transport recorder 或 fault signer producer；
- capture finalizer 的私钥只用于 capture proof，尚未以受限接口签 fault events；
- `runtime/tools/soak-phase5.mjs` 仍是 schema v1 aggregate runner：
  每 5 秒暂停 client 4、直接采 staging attestation、直接写 v1 acceptance；
- 四客户端没有 v2 decoded observation timeline；
- species v2 raw recorder 已实现但未接入 soak；
- audio candidate 没有能见证 `SIGKILL` 并安全重建 child/UDS 的固定 PID1 supervisor；
- public acceptance schema/CLI 仍是 v1；
- 尚未完成真实七故障、四客户端、30 分钟 equivalent-host run。

目标是把上述缺口补齐，同时保持以下所有边界：

1. 浏览器/public HTTP/public WS 永远不能访问 fault control。
2. production profile 永远不能启用 fault authority；不能用普通环境变量把它打开。
3. 私钥不导出，不接受 caller key，不提供 `sign(any)`。
4. actuator 只接受无参数的“执行固定计划下一步”；不能传 operation、target、receipt、
   shell、argv、PID、container、URL 或 fixture。
5. soak 只能新建前 10 个 measurement leaves 和同目录
   `acceptance-evidence/phase5-raw-manifest.json`；其余 4 个 manifest members 只允许
   no-follow snapshot 读取。不能写、删或覆盖 production graph/attestation/checklist/
   equivalence、session、staging attestation、commit、summary、acceptance。
6. `capture-and-attest-local --release-dir <exact-root>` 仍是唯一公开 controller 入口。
7. 生产 8081/8090 在开发、测试、Spark 工程预检期间不启动、不停止、不重启、不替换。

## 2. 固定架构

### 2.1 一把私钥、四个受限能力

把现有 capture finalizer 的 run-scoped Ed25519 key 收敛到 candidate PID1 内部的
`Phase5FaultSessionAuthority`。私钥只被四个固定能力使用：

1. `appendTransportObservation(ownedRuntimeObservation)`：只接收 runtime 内部 instrumentation
   创建的 exact typed observation；
2. `advance()`：无参数，推进 35-phase 固定计划的下一步；仅在其中 14 个 action phase
   推进严格 1–14 的 actuator sequence，其余 phase 从 runtime-owned projection 取 state。
   每步都先 flush 当前最大 transport prefix，再生成固定 receipt/state 并签名；
3. `closeFaultWindow()`：window 精确结束后签 run closure，冻结并导出
   `fault-events.json` bytes，但保留 key；
4. `finalizeCapture(rawManifestSha256)`：只能由现有 capture channel 在 controller 已验证
   raw bundle 后调用一次，只签 capture proof，然后清除 key。

closure 必须先于 raw manifest 生成，因为 manifest 自身要绑定完整
`fault-events.json`；capture proof 随后再绑定 manifest digest。禁止把两个阶段合成一个会
产生循环依赖的 generic `finalize()`。

不暴露 private key、KeyObject、generic payload signer、clock setter 或 arbitrary target。
`createSignedFaultEventEvidence(input, keyPair)` 继续只用于 verifier 测试 fixture，不接入真实
candidate 路径。

### 2.2 私有 control plane

候选 fault control 不能复用现有 candidate capture bind source；该目录的 inventory 被
`phase5_candidate_attempt.py` 固定为只允许 `capture.sock`。controller 必须创建、持有并
验证第三个独立 bind source，在启动容器前创建两个 private listeners，再挂载到 runtime
与 audio candidate：

```text
/run/flock-phase5-fault-control/
  runtime-control.sock
  audio-control.sock
```

约束：

- 只在 Linux、`phaseGate=phase5-local`、admission handshake 成功且 exact candidate mount
  验证通过后创建；
- controller 用 held dirfd 固定该目录的 owner/mode/inode/inventory，拒绝
  symlink/reparse/rename/ABA；两个 socket mode `0600`，各自只接受一个 candidate peer；
- runtime/audio 作为 Unix clients 主动连接；controller 用 `SO_PEERCRED` 分别要求
  peer PID/UID exact 等于 Docker inspect 和 admitted attempt，成功 accept 后立即停止
 监听并 unlink pathname；candidate 还要验证 controller-owned admission challenge；
- attempt state 明确记录 fault-control mount identity、admitted/active/closed phase 和
  exact inventory；capture resume 必须区分 capture source 与 fault-control source；
- request 只有固定的 `advance`、`close-window` 两类 exact envelope；transport observation
  只来自 candidate 内部 instrumentation，不经过 control request；
- `advance` 不含 action 参数，35-phase cursor 与 1–14 action cursor 都由 authority 自增；
- 重放、跳号、并发、第二连接、窗口外调用和 closure 后 action 调用永久 fail closed；
- production runtime construction 根本不创建该 socket，不依赖“默认 false”的可变配置。

客户端自己的 `disconnect/reconnect/pause/resume` 通过固定两阶段协议执行：

1. authority 先 flush prefix、签名并 durable commit 当前 `fault-action`；
2. 同一 `advance` transaction 才下发该 sequence 唯一的无参数 lifecycle instruction；
3. controller-owned、release-attested lifecycle manager 执行 instruction，只能返回该
   transaction 的 fixed completion frame；
4. candidate 对 runtime close/open/egress 等可见影响做 server-side instrumentation；
   对远端 `_socket.pause()/resume()` 不伪称服务端可见，而是由 authority 记录固定
   instruction completion，并要求独立 client raw exact 证明 pause 区间无 decoded PCM、
   resume 后 PCM 恢复；
5. 只有 signed transport 与 client raw 交叉匹配后，下一次 `advance()` 才能签
   `fault-observed`。

执行失败、no-op、重复 completion 或 action 签名前出现影响都会永久终止 run。caller 不能
提交 receipt、state、timestamp 或 action 参数。

### 2.3 七故障的实际执行 owner

| 场景 | 固定执行 owner | 恢复机制 |
|---|---|---|
| worker-crash-restart | audio container 的固定 PID1 launcher 对 exact child worker 发 `SIGKILL` 并 `waitpid` 见证 signal | launcher 重建 child；现有 Node supervisor 自行重连，actuator 禁止主动掩盖恢复 |
| runtime-reconnect | soak lifecycle manager 关闭 client 4 runtime socket | 同 identity、新 generation 重连并完成 snapshot barrier |
| slow-client | soak lifecycle manager 唯一一次暂停 client 4 audio transport至少 2 秒 | 同 generation resume，随后实际 PCM 推进 |
| queue-pressure | candidate 对 client 4 exact egress 注入固定 capacity+1 | 4410/`EGRESS_OVERFLOW` 后同 identity、新 generation 重连 |
| agent-timeout | candidate provider adapter 启用一次固定 timeout fixture | fixture 自动消费；下一次真实 `bird_agent` 请求成功 |
| agent-malformed-response | candidate provider adapter 启用一次固定 malformed fixture | fixture 自动消费；下一次真实 `bird_agent` 请求成功 |
| audio-epoch-discontinuity | 私有 worker protocol 执行一次 fixed epoch rotation，不重启 worker | 四客户端各一个 discontinuity，随后同一新 epoch PCM |

audio worker private commands 不进入 public audio command protocol。controller 为本次
admitted attempt 在独立 fault-control bind source 中生成 run-scoped capability，并将该
目录只挂载给两个 candidate；production launch 不创建、不挂载该目录。audio PID1 launcher
与 admitted runtime 必须做 capability possession handshake 后才安装两个固定 handler；
普通 env/argv、public worker command 或未 admission peer 都不能启用。worker
hello/telemetry 增加的 PID、epoch、`waitpid` signal 和 receipt 信息必须由 Node 严格
验证，不能信任 arbitrary dict。

### 2.4 candidate 网络拓扑

真实 profile 固定 species endpoint 为 `http://127.0.0.1:8081/v1`，因此 bridge 模式中的
container loopback 不可用。staging runtime 改为：

- `--network host`；
- exact `FLOCK_RUNTIME_PROFILE=direct-local`；
- 只监听 `127.0.0.1:18090`，不使用 `--publish`；
- candidate ops probe 也只访问 `127.0.0.1:18090`；
- 8081 只读共享负载通过 host loopback 到现有 `bird_agent`；
- 8090 不访问、不监听、不修改。

`config.js` 必须让每个 profile 拥有 exact ops authority；不能让 direct-local probe
继续落到 `127.0.0.1:8090`。

### 2.5 原始证据与唯一发布者

raw manifest 引用 exact 14 leaves；soak 只创建前 10 个，后 4 个只读：

1. `acceptance-evidence/fault-events.json`
2. `acceptance-evidence/soak-run.json`
3. `acceptance-evidence/runtime-ready-samples.json`
4. `acceptance-evidence/ui-state-lag-samples.json`
5. `acceptance-evidence/render-samples.json`
6. `acceptance-evidence/client-observations.json`
7. `acceptance-evidence/species-normal-samples.json`
8. `acceptance-evidence/species-burst-samples.json`
9. `acceptance-evidence/phase5-e2e.json`
10. `acceptance-evidence/lease-evidence.json`
11. `production-graph.json`
12. `production-machine-attestation.json`
13. `listening-checklist.json`
14. `staging-equivalence.json`

soak 自持 release-root dirfd，通过 marker-bound private temporary directory写前 10 份，
以 no-follow held descriptor 读取后 4 份 canonical bytes，再在同一 temporary directory
生成 exact `phase5-raw-manifest.json`。11 个文件全部 fsync 并复验后，用 exclusive
no-replace directory publish 一次性把整个 tree 变为 `acceptance-evidence`，随后 fsync
release-root；不能先暴露 leaves 再单独发布 manifest，不能覆盖 existing/partial tree。
cleanup 只认同本 attempt 的 marker 与 temp inode。它随后只能执行：

```text
python3 deploy/release_control.py capture-and-attest-local \
  --release-dir <exact-release-root-path>
```

held fd 不跨进程传递：soak 用自己的 dirfd 完成 raw 发布；controller 进程随后通过唯一 CLI
独立重新持有并核验同一 candidate release root。

controller 独占：

- capture intent/session/failure/commit append；
- candidate capture-nonce PoP；
- staging machine attestation；
- full-9 binding；
- `phase5-summary.json`；
- 从 summary projection 构造 schema v2 acceptance：先在同目录 private temp 中
  O_EXCL/0400 完整写入、fsync、重读验证，再用 Linux no-replace 原子 publish，fsync
  parent dir，最后清理 temp。crash 最多留下 private temp，不能留下空/半写 final
  `acceptance.json`，也不需要删除已发布 final。

## 3. Task 1：先冻结必须失败的安全合同

**修改测试：**

- `flock-voice-engine/runtime/test/phase5-soak.test.js`
- `flock-voice-engine/runtime/test/capture/phase5-candidate-capture-owner.test.js`
- `flock-voice-engine/runtime/test/tools/phase5-capture-finalizer.test.js`
- 新增 `flock-voice-engine/runtime/test/acceptance/phase5-fault-session-authority.test.js`
- 新增 `flock-voice-engine/runtime/test/acceptance/phase5-fault-control.test.js`
- `flock-voice-engine/tests/test_phase5_deploy_contract.py`

先写 RED，至少覆盖：

- generic operation/target/script/argv/PID/container/socket path/provider URL/fixture/private key/
  signer/clock 注入全部在副作用前拒绝；
- `advance()` 只能严格推进固定 35-phase 计划，14 个 action sequence 必须严格 1–14；
  重放、跳号、并发、第二连接、窗口外调用拒绝；
- malformed first action 永久消费，不能重试获得另一份签名；
- signer SPKI 与 admission、fault events、closure、capture session 必须完全一致；
- transport 必须 flush 最大 prefix 后才能签；equal-time omitted event、prefix 回填、
  closure 后 append 拒绝，但同一 key 仍只能用于随后一次 capture proof；
- client action 必须先 durable-sign `fault-action`、后下发 fixed instruction；action
  签名前出现 effect、completion no-op/重复、缺失 server/raw 交叉观测都拒绝；
- production profile construction 不创建 socket；
- candidate capture bind source 出现第二个 socket 必须拒绝；独立 fault-control source 的
  owner/mode/inode/inventory/mount 任一漂移必须在副作用前拒绝；
- 普通 env/argv、public worker command、未 admission peer 均不能启用 audio fault handler；
- host-network candidate 只能 bind/probe 18090，任何 bind/probe 8090 的路径 RED；
- soak source 不再包含 collector invocation、staging output、summary/acceptance writer、
  periodic slow-client schedule 或 recursive final-evidence cleanup；
- soak 对受保护名称的 write/rename/unlink/rm spy 测试全部失败；
- controller command argv exact，不能附加 caller path/verifier/role/output。

**基线命令：**

```powershell
cd flock-voice-engine/runtime
node --test test/phase5-soak.test.js `
  test/capture/phase5-candidate-capture-owner.test.js `
  test/tools/phase5-capture-finalizer.test.js `
  test/acceptance/phase5-fault-session-authority.test.js `
  test/acceptance/phase5-fault-control.test.js
```

预期：新测试 RED；只允许因“功能尚未实现”失败，不能因测试 fixture 错误失败。

**提交：**

```text
test(phase5): freeze private fault authority boundary
```

## 4. Task 2：同 PID1 fault session authority 与 signer 生命周期

**新增：**

- `flock-voice-engine/runtime/src/acceptance/phase5-fault-session-authority.js`
- 对应 unit test

**修改：**

- `runtime/src/capture/phase5-capture-finalizer.js`
- `runtime/src/capture/phase5-candidate-capture-owner.js`
- 对应 capture tests

实现要求：

- key 仍由 candidate PID1 内部 `generateKeyPairSync('ed25519')` 生成；
- finalizer 不再独占 key，而是消费 authority 的 capture-proof capability；
- authority 内部保存 canonical identity、window、transport chain、scenario chain 和固定
  action cursor；
- 所有输入先复制为 ordinary exact data，拒绝 Proxy、accessor、Symbol、non-enumerable、
  sparse array、自定义 prototype；
- 双时钟只来自 authority-owned clock；禁止 caller 传 timestamp；
- 每个 scenario event 前先锁定并 flush transport prefix；
- 35 events 与 run closure 使用现有签名 domain 和 canonical rules；
- capture channel finalize 成功或任意 terminal failure 后逻辑永久封闭 authority 并释放
  KeyObject 引用；Node 不保证可证明的物理内存 zeroize，测试只证明之后不能再签名；
- fault run 尚未 closure、事件数量不为 35、transport 未覆盖 window end 时，
  capture proof 必须拒绝；
- 同一 finalizer/authority 不能二次 finalize。

不得把 `runtime/tools/lib/phase5-fault-evidence.mjs` 的 test builder 引入 runtime
production graph；production authority 只实现同一冻结 wire contract，最终由固定 verifier
交叉验证。

**GREEN：**

```powershell
node --test test/acceptance/phase5-fault-session-authority.test.js `
  test/tools/phase5-capture-finalizer.test.js `
  test/capture/phase5-candidate-capture-owner.test.js `
  test/tools/phase5-fault-evidence.test.js `
  test/tools/phase5-fault-validation.test.js
```

**提交：**

```text
feat(phase5): own one candidate fault signing authority
```

## 5. Task 3：私有 fault-control UDS 与四客户端身份注册

**新增：**

- `runtime/src/acceptance/phase5-fault-control-protocol.js`
- `runtime/src/acceptance/phase5-fault-control-server.js`
- `runtime/src/acceptance/phase5-client-registry.js`
- 对应 protocol/server/registry tests
- `runtime/tools/lib/phase5-fault-control-client.mjs`
- 对应 tool test

**修改：**

- `runtime/src/capture/phase5-candidate-capture-owner.js`
- `runtime/src/index.js`
- `runtime/src/api/runtime-ws.js`
- `runtime/src/api/audio-ws.js`
- `runtime/src/api/connection-egress.js`
- `deploy/phase5_candidate_attempt.py`
- `deploy/release_control.py`
- `tests/test_phase5_candidate_attempt.py`
- `tests/test_phase5_deploy_contract.py`

实现要求：

- controller 创建独立 fault-control bind source 与两个 listeners；capture source 仍
  exact 只有 `capture.sock`，两个 namespace 不得混用；
- listeners 只用于 admitted local candidate，mode/owner/path/inventory exact；
- protocol 为 newline-delimited canonical JSON，固定大小上限，duplicate key/invalid UTF-8/
  trailing bytes fail closed；
- controller 在首连接用 `SO_PEERCRED` 验 exact runtime/audio candidate PID/UID 后立即停止
  accept 并 unlink pathname；双方绑定 attempt、SPKI、socket inode 与 admission challenge，
  拒绝同 UID 抢占、pathname ABA 与第二连接；
- 每个 request 连续 sequence；大 response 上限与 128 MiB verifier cap 一致，按
  backpressure/drain 完整发送一个 canonical frame 后 end，不能假设一次 `write` 原子；
- runtime authority 的 first admitted response 一次性下发四个 opaque client
  capabilities；不增加 caller-supplied registration 请求；
- runtime/audio WebSocket 都用 Node-only custom upgrade header 呈递 capability，禁止 query、
  URL、日志或 browser-settable subprotocol；server 映射 client 1–4；
- capability 绑定 runId、client slot、socket kind；runtime/audio capability 不可互换；
  reconnect 复用 slot identity，但必须消费下一 generation grant；
- public browser 不能设置 custom header，也不能通过 public runtime hello 声明 fault client；
- runtime/audio 两条 socket 必须绑定同一 client identity、独立 generation；
- reconnect 保留 client identity、generation 精确加一；
- runtime/audio open/ready/snapshot/egress/close、audio PCM/discontinuity 全由 server-side
  instrumentation 写 transport chain；audio pause/resume 只来自固定 transaction completion
  并必须与 client raw 交叉匹配；
- 不能接受 caller 提交的 transport event、state、receipt 或 timestamp；
- `advance()` 的 state phase 在 candidate 内等待 fixed predicate/deadline；caller 不轮询；
  action phase严格为 flush→sign+commit→dispatch instruction；
- owned timer 在预定 window end 自动冻结 transport、签 closure；`close-window` 只能在 closure
  后取 exact canonical bytes，soak 必须原样落盘，禁止 parse/reserialize；
- 连接关闭、协议错误或 recorder overflow 生成 `observer.failure` 并使 run terminal。

**GREEN：**

```powershell
node --test test/acceptance/phase5-fault-control-protocol.test.js `
  test/acceptance/phase5-fault-control-server.test.js `
  test/acceptance/phase5-client-registry.test.js `
  test/tools/phase5-fault-control-client.test.js `
  test/tools/phase5-fault-transport-projection.test.js
```

**提交：**

```text
feat(phase5): add candidate-private fixed fault control
```

## 6. Task 4：实现七个固定 actuator

### 4.1 audio worker crash 与 epoch rotation

**新增/修改：**

- 新增 `server/audio_worker/launcher.py` 作为 audio container 固定 PID1；
- `server/audio_worker/worker.py`
- 私有 worker protocol 的 Python/Node codec 与 tests
- `runtime/src/audio/worker-protocol.js`
- `runtime/src/audio/worker-supervisor.js`
- `deploy/release_control.py` 的独立 candidate fault-control mount

要求：

- PID1 launcher 只管理一个 exact child worker，正常 stop 与 fault restart 分账；
- private control command enum 只有 `crash-child` 与 `rotate-epoch`，无参数；
- launcher 只有在 production 不存在的 run-scoped mount 完成 possession handshake 后才安装
  handler；普通 worker socket永远不接受这两个 command；
- `crash-child` 对 exact child PID 发 `SIGKILL`，由 PID1 `waitpid` 观测并记录
  `lastExitedPid/lastExitSignal`，安全清理旧 UDS inode，再固定重建 child；
- stale UDS 只能由 launcher 在证明旧 child 已 waitpid、inode 与 owned snapshot exact 后
  no-follow unlink，不能用宽泛 cleanup；
- Node supervisor 自行重连并恢复，actuator 不调用 Docker restart；
- epoch rotation 不重启 worker、不增加 restartCount，只生成一个新 epoch；
- worldGeneration/revision/eventSeq 在两个场景中继续推进且不重建。

### 4.2 client 4 lifecycle 与 queue pressure

**修改：**

- `runtime/src/api/runtime-ws.js`
- `runtime/src/api/audio-ws.js`
- `runtime/src/api/connection-egress.js`
- `runtime/tools/lib/phase5-soak-client-lifecycle.mjs`

要求：

- reconnect、pause/resume 都只作用于 registry 中 exact client 4；
- slow-client 只出现一次，暂停至少 2 秒，不允许 pause 中收到 decoded PCM；
- queue-pressure 固定注入 capacity+1，必须以 4410/`EGRESS_OVERFLOW` 关闭；
- hot clients 1–3 不能关闭、重连、暂停或失去 PCM；
- client 4 每次恢复都保留 identity，generation 精确 +1。

### 4.3 provider timeout 与 malformed fixture

**修改：**

- `runtime/src/agents/provider-runner.js`
- 新增 admitted-only `runtime/src/acceptance/phase5-agent-fault-probe.js`
- `runtime/src/config.js`
- `runtime/src/index.js`
- 对应 unit/integration tests

要求：

- 不用 `FLOCK_AGENT_SPECIES_ENABLED` 打开 production species agents；该 env 继续 fail closed；
- fault probe 只在 admission authority 创建后构造，复用 production
  `createProviderRunner` 和 response parser，但不是 public route或通用 provider API；
- fixture ID/hash/12s attempt timeout/15s deadline 与 validator 常量 exact；
- 每个 fixture 只消费一次目标请求，不能从 caller 提供 body/status/URL/model；
- injected settle 后下一请求必须走真实
  `http://127.0.0.1:8081/v1` / `bird_agent` 并成功；
- shared-load recorder 与 candidate 内部 agent fault 是两条不同证据链；
- world 在两个故障期间继续 tick。

### 4.4 host-loopback candidate topology

**修改：**

- `runtime/src/config.js`
- `deploy/release_control.py`
- candidate ops reader/tests

要求：

- runtime candidate exact `--network host` + `direct-local`，无 published ports；
- bind、browser、ops 全部为 `127.0.0.1:18090`；
- candidate 内部真实 provider probe 可访问 host loopback 8081；
- Docker inspect 必须证明 network mode、无 port bindings、exact command/env/mounts；
- 测试 spy 证明从未读取、写入、监听或停止 8090。

**整组 GREEN：**

```powershell
node --test test/phase5-faults.integration.test.js `
  test/acceptance/phase5-fault-actuator.test.js `
  test/tools/phase5-fault-semantics.test.js `
  test/tools/phase5-fault-transport-projection.test.js `
  test/tools/phase5-fault-validation.test.js

python -B -m pytest `
  flock-voice-engine/tests/test_audio_worker_framing.py `
  flock-voice-engine/tests/test_audio_worker_identity.py `
  flock-voice-engine/tests/test_audio_worker_lifecycle.py `
  flock-voice-engine/tests/test_phase5_deploy_contract.py -q -p no:cacheprovider
```

**提交：**

```text
feat(phase5): execute seven fixed candidate faults
```

## 7. Task 5：四客户端与非 fault raw recorder

**新增：**

- `runtime/tools/lib/phase5-client-observation-recorder.mjs`
- `runtime/tools/lib/phase5-latency-recorder.mjs`
- `runtime/tools/lib/phase5-render-recorder.mjs`
- `runtime/tools/lib/phase5-raw-manifest.mjs`
- 各自 tests

**复用：**

- `runtime/tools/lib/phase5-species-raw-recorder.mjs`
- `runtime/tools/lib/phase5-lease-evidence.mjs`

实现要求：

- `client-observations.json` 保存四个 distinct identity、所有 decoded lifecycle、双时钟、
  exact connection generation、PCM header/length/finite/cursor、frame SHA；
- PCM frame 必须精确 32,800 bytes / 4,096 frames；invalid frame 先记录 failure evidence，
  再让 run fail closed，不能只加 aggregate；
- hot clients 1–3 boundary/pairwise/final gap 均 <=1s，无 fault exemption；
- client 4 只允许 signed slow-client pause→resume 的区间内部 exemption；
- runtime-ready 固定四项；UI probe client 轮询、generation-aware probeSeq；
- render 每 250ms 保存原始 P95/P99/block duration/recent underruns；
- normal 每 2s，burst 每 10s × 4；保存实际 response body bytes 的 canonical base64；
- raw recorder 全部有 size/count 上限、busy/finalized state、双时钟 offset 检查；
- raw manifest artifact 顺序、path、byteLength、SHA 与 Python validator exact 一致；
- raw temporary directory 内包含且只包含 10 leaves + manifest，最后一次 no-replace
  directory publish；existing final、casefold alias、partial inventory 和 temp inode
  漂移全部拒绝；
- 新增 JS producer → Python validator cross-runtime tests，不能只做 JS 自洽测试。

**GREEN：**

```powershell
node --test test/tools/phase5-client-observation-recorder.test.js `
  test/tools/phase5-latency-recorder.test.js `
  test/tools/phase5-render-recorder.test.js `
  test/tools/phase5-species-raw-recorder.test.js `
  test/tools/phase5-raw-manifest.test.js

python -B -m pytest `
  flock-voice-engine/tests/test_phase5_client_observations.py `
  flock-voice-engine/tests/test_phase5_latency_samples.py `
  flock-voice-engine/tests/test_phase5_latency_client_cross_binding.py `
  flock-voice-engine/tests/test_phase5_render_samples.py `
  flock-voice-engine/tests/test_phase5_species_load_samples.py `
  flock-voice-engine/tests/test_phase5_raw_manifest.py -q -p no:cacheprovider
```

**提交：**

```text
feat(phase5): record manifest-owned v2 soak evidence
```

## 8. Task 6：重写 v2 soak orchestration

**修改：**

- `runtime/tools/soak-phase5.mjs`
- `runtime/test/phase5-soak.test.js`

**新增：**

- `runtime/tools/lib/phase5-soak-orchestrator.mjs`
- `runtime/test/tools/phase5-soak-orchestrator.test.js`

**同步 execution closure：**

- `deploy/release_control.py` 的 `PHASE5_SUMMARY_DEPLOY_SOURCES` /
  `DEPLOY_EXECUTION_NAMES`；
- `runtime/src/audio/release-manifest.js` 的 deploy execution names；
- `tools/validate_phase5_acceptance.py` 的 owned tool artifacts、digest 与 summary field 映射；
- `release/phase5-summary.schema.json` 的 `acceptanceTool` exact fields；
- `deploy/import-release.sh` 的目录与 inventory；
- release 中保持 `phase5-summary/soak-phase5.mjs` 与
  `phase5-summary/lib/*.mjs` 的相对 import 布局。

固定状态机：

1. 从 candidate admission 读取 exact runId/challenge/release/geometry/profile；
2. 验证 release、production graph、production attestation、equivalence、listening checklist；
3. Chromium/lease preflight；
4. window 开始后打开四组 runtime/audio sockets；
5. 按固定顺序执行七场景，每场五 phase，场景不重叠；
6. 全窗并行执行 render/runtime/UI/species 原始采样；
7. 最后一个 recovery-observed 后保留至少 30 秒稳定尾窗；
8. window 必须精确 1,800,000 ms，最后 observation 距 end <=250 ms；
9. 先 finalize 所有 raw recorder，再从落盘 bytes 生成 raw manifest；
10. 在 private temp 内完成 10 leaves + manifest 的 fsync/复验，再一次 no-replace publish
    整个 `acceptance-evidence` directory；
11. exact 调用 controller `capture-and-attest-local --release-dir`；
12. controller 成功后只读取结果做最终报告，不自行写 acceptance。

虚拟时钟测试必须覆盖完整 30 分钟而不 wall-clock 等待；真实 clock 只用于 Task 10。
本 Task 的 crash-point tests 覆盖每个 leaf/manifest 写入、temp fsync、no-replace
directory publish 和 parent fsync；controller intent/session/machine/summary/acceptance
crash matrix 放在 Task 7 的 Python controller tests。

移除：

- `advanceSlowClientSchedule()` 周期逻辑；
- `capture_machine_attestation.py` 直接调用；
- caller-supplied staging attestation/output；
- schema v1 aggregate acceptance 构造；
- 对 final evidence、session、staging、summary、acceptance 的清理权限。

**GREEN：**

```powershell
node --test test/phase5-soak.test.js `
  test/tools/phase5-soak-orchestrator.test.js `
  test/tools/phase5-fault-verifier-cli.test.js
```

**提交：**

```text
refactor(phase5): make soak a raw-only v2 orchestrator
```

## 9. Task 7：acceptance v2 与 controller 最终发布

**修改：**

- `release/acceptance.schema.json`
- `tools/validate_phase5_acceptance.py`
- `deploy/release_control.py`
- `deploy/import-release.sh`
- acceptance/package/import/Phase 6 consumer tests

实现要求：

- `acceptance.json` hard-reject v1；
- 顶层新增且只新增同一 `runId`；
- acceptance 的非 evidence payload 必须 exact 等于 summary `acceptanceProjection`；
- acceptance `evidence` 固定由 summary `rawArtifacts` 映射旧 10 个 evidence digests，并且
  新增且只新增 `phase5SummarySha256`；不能由 acceptance 自报；
- controller 在仍持有 summary descriptor 的 callback 内，从同一份已验证 summary bytes
  计算 summary SHA 与 acceptance bytes；直到 acceptance durable publish 前持续核对
  descriptor 与 linked inode，禁止按 pathname 重新打开产生 ABA；
- acceptance 先在同目录 private temp 中 O_EXCL/0400 完整写、fsync、重读验证，再以
  `renameat2(RENAME_NOREPLACE)` 或等价 `linkat` no-replace 原子 publish，并 fsync
  parent；crash 不能留下空/半写 final；
- controller output namespace 增加
  `committed → summary-only → summary+acceptance` 恢复状态；casefold alias、陌生 temp、
  partial final 一律 fail closed。rerun 只能验证 exact existing bytes或从合法
  summary-only 状态补发 acceptance，不能覆盖/删 final；
- Python crash matrix覆盖 intent/session/machine/commit/summary/acceptance 每个 durable
  边界，以及 validation 后 inode swap/同 bytes inode swap；
- `validate_bundle()` 必须先拥有并验证 summary/full raw/session/machine composite，再验证
  acceptance projection；不得回落 legacy integrity-only path；
- CLI 的 legacy `equivalence_path` 只能与 raw-manifest-owned equivalence bytes做
  cross-check，不能成为 run/machine binding trust root；
- package/import/bound record 全部要求 schema v2；
- `stress_audio_worker.py --backend real` 继续 fail closed，不把它接入正式路径。

**GREEN：**

```powershell
python -B -m pytest `
  flock-voice-engine/tests/test_phase5_acceptance.py `
  flock-voice-engine/tests/test_phase5_summary_schema.py `
  flock-voice-engine/tests/test_phase5_capture_proof_boundary.py `
  flock-voice-engine/tests/test_phase5_deploy_contract.py `
  flock-voice-engine/tests/test_deploy_contract.py `
  flock-voice-engine/tests/test_release_artifact.py -q -p no:cacheprovider
```

**提交：**

```text
feat(release): publish acceptance v2 from owned summary
```

## 10. Task 8：安全评审、closure 与 production graph 最终重绑

先做两个独立 code review：

1. private key/actuator/UDS/TOCTOU/ABA/cleanup authority；
2. raw-to-summary-to-acceptance ownership、schema hard bump、package consumer。

必须证明：

- public route graph 中没有 fault endpoint；
- production profile 没有 fault socket、fixture 或 actuator；
- exact 14 leaves 与受保护 output namespace；
- 同一 signer 从 admission → 35 events → closure → capture session；
- full 9 binding 与 raw manifest/capture nonce 不漂移；
- 新 execution closure 所有模块都进入 release identity；
- 任意 source mutation 都触发正确的 graph/deploy identity failure。

全部代码提交后，从 committed blobs 做两份独立 snapshot，分别离线构建 production graph，
要求 canonical bytes、inner SHA、files/edges/routes 完全一致；再一次性更新两个 consumer
pin。禁止从 dirty worktree helper 输出重绑。

**完整本地门禁：**

```powershell
python -B -m pytest flock-voice-engine/tests -q -p no:cacheprovider

cd flock-voice-engine/runtime
npm test

cd ..
python -m compileall -q server tools
git status --short
```

**提交：**

```text
fix(release): bind v2 soak execution closure
```

## 11. Task 9：最终 Spark 隔离工程预检

目标机器：

```text
yfhuang@192.168.9.140
```

只允许：

- 独立 `/tmp/flock-phase5-*` root；
- 唯一 Docker network、唯一 candidate container names、唯一 18090 类临时端口；
- immutable image ID、read-only rootfs、private tmpfs/UDS；
- `--pull never`；
- 测试前后记录 8081/8090 full container IDs、restartCount、health、ports 和生产状态摘要；
- 测试完按 exact ID/absolute path 清理本次资源。

禁止：

- `rolf` SSH 用户；
- 触碰、重启、停止或替换生产 8081/8090；
- 修改 `/srv/deploy/flock-voice-engine`；
- 修改其它用户容器、网络、模型或端口；
- 用同机身份签发正式 equivalent-host acceptance。

如果 Spark 缺少 immutable candidate images、完整 release、private runtime config、
operator checklist 或真实 8081 共享负载条件，只运行能隔离证明的工程测试并明确列出缺口；
不能伪造 30 分钟结果。

## 12. Task 10：正式等价 GB10 验收（外部条件）

正式 GREEN 条件：

- aarch64 / NVIDIA GB10 / driver / CUDA / memory class 与生产匹配；
- stable machine identity、SSH host key 和接口 identity 与生产不相交；或者
  equivalence v2 包含 exact owner-approved same-host policy，并且 staging 的四类稳定
  identity 与 production 全部精确相等（禁止部分重合）；
- exact committed release/graph/tool closure；
- 4 clients / client 4 slow / 30 分钟；
- 真实 8081 `bird_agent` normal+burst shared load；
- 七类真实 fault、35 signed events、14 fixed action receipts；
- 四客户端 raw decode observations；
- 最后 30 秒稳定尾窗；
- operator listening；
- controller 生成 staging attestation、summary v2、acceptance v2；
- package/import validator 全绿。

owner 已明确批准使用当前 Spark 进行 Task 10；操作身份为 `jnzhang`。
验收必须使用独立 `/tmp/flock-phase5-*` root、不可变 candidate image ID、
host-network loopback 18090，并证明生产 8081/8090 前后 container identity/restart/
health/ports 完全不变。该政策变更不授权 cutover。
