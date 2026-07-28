# Phase 5 生产控制面与同源入口实施计划

> 配套设计：
> `docs/superpowers/specs/2026-07-28-phase5-production-control-reconciliation.md`

**目标：** 在不写生产、不改变 8090 的前提下，闭合同源 UI、严格 snapshot 恢复、
授权证据传输、可信导入、原子 active-set 与整体 rollback；随后在隔离等价 Spark 完成
Task 9，冻结 exact tuple，停在用户逐字授权点。

**执行原则：** 每个 task 由一个实现代理完成 RED → GREEN，再由不同代理复核。controller
负责验证、原子 commit 和进度账本。任何 production adapter 的测试都使用临时目录、
FakeHostOps/FakeDocker/FakeHTTP；默认 CLI 不得构造真实 adapter。

## Task 0：恢复可信跨平台门禁

**范围**

- 修复 Windows Node 测试中的路径/launcher 问题，但 production graph 仍 hash raw bytes。
- Python 把 249 个 portable contract 与 11 个 Linux release-security contract 明确分开。
- 添加 `*.sh text eol=lf`。
- actual release CLI 在 non-Linux 以 `RELEASE_GATE_REQUIRES_LINUX` 提前失败。

**验收**

```powershell
cd flock-voice-engine/runtime
npm test
cd ../../
python -m pytest flock-voice-engine/tests -q
git diff --check
```

- Windows Node 全绿。
- Windows Python 精确为 `249 passed, 11 skipped`；skip inventory 无扩张。
- 11 项在 native Linux 私有 mode-0700 basetemp 全执行、0 skip、全绿。

## Task 1：Graph-allowlisted 同源静态入口

**新增**

- `flock-voice-engine/runtime/src/api/static-ui.js`
- `flock-voice-engine/runtime/test/api/static-ui.test.js`
- route-manifest schema/builder tests

**修改**

- `runtime/src/server.js`
- `runtime/src/runtime-app.js`
- `runtime/src/index.js`
- production graph config/builder
- Docker runtime layout
- MVP/legacy route tests

**RED**

1. `/`、`/index.html` 必须返回 canonical `mvp/index.html`，且内容只引入
   `mvp/src/server-main.js`。
2. `/demo.html`、`/tracks.html` 保持 exact compatibility URL；它们仍走同一 Node gateway。
   `/voice-client.js`、`/voice-client-production.js`、`/pcm-player-worklet.js`、
   `/assets/timbre/latent_map.json`、`/assets/timbre/voice_maps/*.json` 也保持原 URL。
3. route manifest 中每个文件可读且 raw SHA 相等；非 graph 文件、browser-owner
   `mvp/src/main.js`、目录、大小写漂移、symlink、明文/编码 traversal 全 404。
4. legacy handler 不得再抢占 `/`。
5. Docker image 内物理路径保持 repo-relative，测试逐项核 route manifest。

**GREEN**

实现只读 explicit route map；禁止通用 static directory fallback。

**验证**

```powershell
node --test flock-voice-engine/runtime/test/api/static-ui.test.js
npm --prefix flock-voice-engine/runtime test
```

## Task 2：UI 只从 `window.location.origin` 派生接口

**修改**

- `mvp/src/server-main.js`
- `mvp/test/server-main.test.js`
- Phase 5 Playwright config/E2E

**RED**

- HTTP candidate 产生同源 HTTP + WS。
- HTTPS fixture 产生同源 HTTPS + WSS。
- bootstrap、Runtime WS、Audio WS、三个 latent map 全部同源。
- production source graph 不含 `18090`、`4193`、`8081`、`/decoder` 或 endpoint override。
- Playwright 只访问 Node origin，不启动第二个 4193 static server。

**GREEN**

提供单一纯函数 `deriveRuntimeEndpoints(location.origin)`；浏览器 app 只消费该结果。

## Task 3：统一 exact-origin policy

**新增**

- `runtime/src/api/origin-policy.js`
- `runtime/test/api/origin-policy.test.js`

**修改**

- bootstrap/latent handler
- Runtime/Audio/decoder WebSocket gateway
- legacy route CORS
- config、smoke、soak 与 maintenance 测试

**RED**

- candidate 只接受 `http://127.0.0.1:18090`。
- production 只接受授权中的 `http://localhost:8090`。
- WS missing/null/alias/wrong scheme/port origin 全拒绝。
- `/` 与 static 要求 exact Host；top navigation 还要求
  `Mode=navigate, Dest=document, Site=none|same-origin`，错误 Host 返回 421/403 且不 redirect。
- bootstrap/latent 有 Origin 时必须 exact；无 Origin 时必须 exact Host +
  `Sec-Fetch-Site=same-origin`，不接受 navigation 的 `none`。
- 不反射 Origin/Host，不信任 `X-Forwarded-*`，不把 `0.0.0.0` 当 origin。
- health/readiness 的 loopback 运维读取是单独 policy。

## Task 4：Strict initial-world 与不可伪造 production activation

**新增**

- `runtime/src/startup/trusted-artifact.js`
- `runtime/src/startup/activation.js`
- `runtime/src/startup/initial-world.js`
- `runtime/src/runtime-main.js`
- `runtime/src/authorized-entry.js`
- activation/request/transaction record schema
- 对应 unit/integration tests

**修改**

- `runtime/src/config.js`
- `runtime/src/index.js`
- `runtime/src/runtime-app.js`
- `runtime/src/world-session/world-session.js`
- production graph roots

**RED**

1. `index.js`/local entry 永久拒 production；普通 `allowProduction` bool、env、confirm string
   均不能放行。
2. authorized entry 缺 activation grant、sidecar、trusted mode/owner、prior attestation、
   request、snapshot、journal、active-set/recipe/container identity 或 digest 任一漂移，在
   agent/UDS/timer/listen 前失败。
3. failed/rolled-back terminal record 拒绝；成功 record 必须反向绑定 grant；无 terminal
   record 只接受 journal 当前 phase/role，rollback 后旧 grant 永久不可重放。
4. request、initial outer/nested、bootstrap、state.replace 的 world ID/generation/revision/
   eventSeq/seed/config/protocol/schema 完全一致；generation 是 canonical UUID string。
5. production 使用 `restorePolicy=required`，`restoreDisposition !== "restored"` 立即失败；
   不允许随机 generation fallback。
6. eager default session 验证完才可 `listen(0.0.0.0, 8090)`。
7. 同一 grant 固定 `cutover-candidate` 与 `production` 两个 branded role：分别绑定
   `127.0.0.1:18090` 与 `http://localhost:8090`，并共享 exact image/snapshot/species/
   transaction；env 不能选 role。

**GREEN**

将组合逻辑移到 side-effect-free `runtime-main.js`；authorized entry 只接受 trusted loader
与 journal 返回的 branded authority。local/shadow 的 incompatible rebuild 语义保持不变。

## Task 5：固定 production species provider

**修改**

- agent config/composition 与 production activation loader
- provider tests、production graph tests、fake call-log tests

**RED**

- production 精确为 `http://127.0.0.1:8081/v1`、`bird_agent`、
  `speciesEnabled=true`。
- 8083 永不出现在 call log/graph。
- master secret 只从进程环境进入 provider，不进入 JSON evidence 或日志。
- local fixture 可以注入 fake provider，但不能伪装成 production authority。

## Task 6：Canonical authorization-request builder

**新增/修改**

- `runtime/tools/prepare-cutover-request.mjs`
- `deploy/release_control.py`
- authorization request-bundle schema/builder/tests

**RED**

- prior production attestation 为 unknown/placeholder/超过 10 分钟/未来超过 30 秒/漂移则
  拒绝。
- `productionPublicOrigin`、seed/config、四份 generation、archive/bootstrap/acceptance/
  graph/image digest 任一缺失或漂移则拒绝。
- 多文件生成任一故障后，不留下可被接受的半 request bundle。
- bundle inventory/sidecar exact-basename、canonical bytes、duplicate/traversal/symlink
  全部 fail closed。
- request 绑定 archive，archive 不递归包含 request。

**GREEN**

本 Task 只实现/测试 builder，不生成最终授权 tuple。它在临时目录写齐、fsync、验证后一次
publish request bundle。最终实例必须等 Task 10 equivalent-host acceptance 完成后，由 Task 13
以最新只读 prior attestation 立即生成；不写生产、不请求 cutover 授权。

## Task 7：Production control 安全壳与持久 import

**新增**

- `flock-voice-engine/deploy/production_control.py`
- `flock-voice-engine/tests/test_phase5_production_deploy_contract.py`

**修改**

- `release_control.py`
- `release.sh`
- `import-release.sh`

**RED**

1. `collect-prior-production-attestation` 只接收没有 mutator 方法的
   `ReadOnlyProductionOps`；它可以在授权前运行，任何 remote write/Docker mutation 在类型和
   call log 上都不可达。
2. missing/wrong confirm、operator 非 `yfhuang`、非 canonical `/srv/deploy/...`、错误 base
   URL、env-only production 都在 mutating `ProductionHostOps` factory 前失败。
3. `import-production` 必须同时验证外部 expected request/archive/bootstrap/request-bundle
   SHA、确认后生成的 expected activation-grant SHA 与内部 sidecar。
4. 解包拒绝 absolute、`..`、duplicate、symlink/hardlink、special file、大小超限。
5. acceptance/package/equivalence/manifest/OCI/request/grant 任一漂移拒绝。
6. 成功只创建 immutable release、rollback descriptor、candidate link；旧容器、
   active/current/previous 完全不变。
7. default/test CLI 有 sentinel 证明从未构造 real mutating adapter。

## Task 8：Read-only preflight、容器 recipe 与原子 transaction

**RED**

- preflight exact 校验主机、`yfhuang`、旧容器 ID/image/restart/port/GPU/mount、六字段、
  static HMAC、8081 `bird_agent`；任一差异 `mutating_calls == []`。
- old stop 前不得有 production 8090 bind。
- audio 唯一 `--gpus all` 且无 published port；runtime 无 GPU。
- temporary `cutover-candidate` 只 publish `127.0.0.1:18090:8090`，使用 grant 中的
  candidate role、required snapshot 和 production species。
- final role publish exact `0.0.0.0:8090:8090`，但 browser static 仍只接受 canonical
  localhost Host；recreate runtime 时 audio ID/startCount/epoch 不变。
- 每个 phase 故障注入后自动 rollback，无 partial owner。
- full smoke 前 `active` 不变；写并 fsync commit-intent/smoke digest 后才
  `os.replace(active)` 并 fsync parent。
- success 路径只一次 replace；replace 后、terminal record 前崩溃时，recovery 重跑 final
  status/smoke，通过则补写 succeeded，失败则第二次 replace 回旧 set。
- lock/journal 阻止并发，并能对每个 crash point 幂等恢复；旧 grant rollback 后不可重放。

**Rollback RED**

- 只 stop/rm record 中的 exact 新容器 ID。
- 在 stopped exact legacy container ID 上先恢复原 restart policy，再 start exact ID。
- 不把新 initial snapshot 导入 legacy browser。
- legacy identity/HMAC/ID 漂移时 outcome=`rollback-failed`，禁止猜测重建。

## Task 9：Production smoke、record 与 docs

**RED**

- temporary 和 final smoke 都核对 bootstrap、Runtime ready、snapshot、state-applied、
  `/readyz` 中同一个 string generation。
- 验证 Audio golden cursor、legacy exact URLs/API、static route manifest 和 provider。
- transaction record schema 同时满足 Task 10 audit 与 Phase 6 consumer。
- record 只落 `transactions/<id>`；immutable candidate 不追加交易后文件，active set 只保存
  transaction reference。
- renderer 只接受 `outcome="succeeded"`，failed/rolled-back/rollback-failed 均不写
  “已切换”。
- Phase 6 consumer 还要求 record transaction == current active set、完整 stability window 和
  一个成功 server-owned N→N+1 发布周期；否则 removal manifest 不可生成。
- renderer 先验证所有目标，再原子写；外部 HANDOFF 仍不进 Git。

**Fake E2E**

用 temp root + FakeDocker 完成：

```text
import-production -> preflight -> cutover -> status-production
```

以及每个 fail point 的自动 rollback。测试不得打开 socket、访问 Docker daemon 或 8090。

## Task 10：Task 9 真实 fault runner 与等价主机验收

先修 `stress_audio_worker.py`：每个 scenario 必须有实际 fault action、前后观测和恢复证据；
禁止仅按 scenario 名写 `passed: true`。

真实 GREEN 只能在隔离等价 Spark：

- 同架构/驱动/CUDA/内存等级，machine attestation 与生产不相同；
- 真实 release artifact、真实 pool 5/block 4096；
- 4 clients，其中 1 slow；
- 30 分钟；
- 与真实 `bird_agent` 8081 shared-load；
- 逐项 fault：worker crash/restart、runtime reconnect、slow client、queue pressure、agent timeout/
  malformed response、audio epoch/discontinuity；
- 产出 raw evidence、summary、acceptance 与 machine attestation 的 digest chain。

本地 fake 全绿只能证明 runner，可提交但 `cutoverEligible=false`。

## Task 11：Phase 6 semantic replacements

- 逐个实现 policy ledger 中 28 个 pending path 的 server-owned semantic replacement。
- retained support suite 迁移到 canonical domain，不复制旧 test 名充数。
- verifier 除 exact name/runnable 外，增加行为 witness/parity attestation。
- 这只是 removal preparation；legacy source 仍不删除，也不生成 removal manifest。删除门禁
  仍要求成功 terminal record、current active transaction、production stability window、
  server-owned N→N+1 成功周期和 24 小时 clean window。

## Task 12：候选总验收、review、commit、push

运行：

- full Node + browser E2E；
- full Python + Linux authority；
- phase5 fake transaction；
- phase6 contracts；
- production graph/source manifest/acceptance consistency；
- `git diff --check` 与 secret scan。

每个逻辑 batch 独立 review/commit。最终推送 exact candidate 到
`Twiddle-AI-China/intelligent_jungle` 的 `rebuild`，记录 commit SHA 和未满足的等价主机证据。

## Task 13：停在生产授权点

只有 Task 0–12 全部满足后：

1. 用独立 `ReadOnlyProductionOps` / `yfhuang` 采集最新 prior attestation；不写远端。
2. 在 attestation 10 分钟有效窗内生成 actual initial world、cutover request 和最终
   authorization-request bundle；它必须绑定 Task 10 最终 acceptance。
3. 展示 exact authorization tuple 和 request-bundle SHA，并明确说明旧浏览器 world 会 reset。
4. 请求逐字授权 `AUTHORIZE_PHASE5_8090_ATOMIC_CUTOVER`。

没有逐字授权时结束，不运行 scp、remote Docker mutation 或 production filesystem write。
为构造/复验 prior attestation 而执行的显式只读 SSH preflight 不是 cutover 授权，必须与任何
写命令隔离并记录。本计划本身不授权生产操作。

## Task 14：逐字授权后的唯一 runbook

只有 Task 13 对本次 exact tuple 收到逐字授权后才进入：

1. 本地 controller 生成 `activation-grant.json`，绑定已授权 request-bundle SHA、exact tuple、
   `cutover-candidate|production` recipes 与确认动作；显示并固定 grant SHA。
2. 在 attestation 有效窗内执行 live read-only equality；过期或漂移就废弃授权 chain，回
   Task 13 重新展示，不能沿用旧确认。
3. 传输 archive/bootstrap/request bundle/grant；每个 import 参数显式携带本地固定的
   expected SHA。import 只持久化 immutable release、transaction inputs 和 candidate link，
   不停旧服务。
4. 运行 transaction：temporary candidate smoke → stop exact legacy → final runtime →
   full smoke → commit-intent/fsync → single active replace/fsync → terminal record。
5. 任一失败按 exact legacy-container rollback；replace 后 crash 按 Task 8 恢复规则完成提交或
   第二次 replace 回滚。
6. 从 `transactions/<id>/` 取 record，不从 current 猜路径；只有 succeeded 才更新 Git 内受管
   文档，外部 HANDOFF 单独更新且不进 Git。

本 runbook 的真实命令必须由 Task 7–9 生成的 CLI `--help`、schemas 和测试共同校验；旧
2026-07-23 Task 10 命令仅为历史草案，不得复制执行。
