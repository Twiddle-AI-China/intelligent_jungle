# Phase 5 生产控制面与同源入口补充设计

日期：2026-07-28

状态：候选设计，尚未切生产

适用分支：`refactor/backend-owned-runtime` / `rebuild` 后续候选

上位设计：`2026-07-22-backend-owned-runtime-design.md`

本文修正
`docs/superpowers/plans/2026-07-23-phase-5-6-audio-cutover.md`
中 Task 8–10 经代码审计发现的闭环缺口。与旧计划冲突时，以本文及配套
`2026-07-28-phase5-production-control-reconciliation.md` 计划为准。

## 1. 不变边界

- Phase 5 之前，生产 8090 继续由 legacy Python 容器独占。
- 候选实现、fake HostOps、临时目录、loopback 测试和文档修改不构成生产授权。
- 生产写入仍只允许在展示 exact tuple 后，由用户逐字授权
  `AUTHORIZE_PHASE5_8090_ATOMIC_CUTOVER`。
- 服务器身份只能是 `yfhuang`；不触碰 8083、未知容器、他人进程或只读权重。
- 外部端口仍为 8090；species 推理仍为
  `http://127.0.0.1:8081/v1` + `bird_agent`。
- 首次切换固定使用 `reset-new-world`。旧浏览器 world 不伪装成可迁移的全局
  authoritative snapshot。

## 2. 已确认的旧计划矛盾

### 2.1 授权 tuple 缺少旧 owner 的可信身份

旧实现把 `previousReleaseIdentity` 写成占位字符串，却要求用户对 exact tuple 授权；真实
旧 owner 又被安排在授权后读取。这不是 exact authorization。

修正：授权请求必须消费一份此前只读采集、canonical、digest-bound 的
`prior-production-attestation.json`。它至少绑定：

- 主机稳定身份摘要和 `yfhuang`；
- 当前 8090 legacy 容器 ID、image ID、固定 publish/GPU/restart policy；
- legacy 六字段 release marker 与 endpoint identity；
- legacy 静态树身份和 runtime-config 私有 HMAC 证明；
- 采集时间与只读 preflight 版本。

只读采集使用独立 `collect-prior-production-attestation` 入口和
`ReadOnlyProductionOps`；该接口没有 filesystem write 或 Docker mutator 方法，不要求 cutover
confirm。attestation 的 wall-clock 最大年龄固定为 10 分钟，未来漂移容限固定为 30 秒；生成
授权请求、接收用户确认和停止旧容器前都重新校验。超时就废弃整条 request chain 并重采，
不能自行延长。授权后的 live preflight 只做 exact equality check。占位值、unknown、过期或
漂移均 fail closed。

### 2.2 授权 world 没有进入传输单元

旧顺序先打 release archive，后生成 `cutover-request.json`、`initial-world.json`、
`bootstrap.json` 和 `state-replace.json`；远端只接收 archive，因此不可能恢复用户授权的
world。

修正：release archive 保持不可变，授权前另生成 canonical
`authorization-request-bundle.tar`，只包含：

- `cutover-request.json`
- `initial-world.json`
- `bootstrap.json`
- `state-replace.json`
- 每个文件的 exact-basename SHA-256 sidecar
- bundle inventory 与 sidecar

request 绑定 archive、bootstrap、最终 equivalent-host acceptance、prior attestation 和四份
world 证据的摘要。用户逐字确认该 request bundle 后，本地 controller 才生成独立 canonical
`activation-grant.json`，绑定 request-bundle SHA、request SHA、exact tuple、确认动作和
transaction launch recipes。grant 不进入 request bundle，也不改变已授权字段。外层 SSH
命令必须携带用户已授权的
`expectedRequestSha256`、`expectedArchiveSha256`、
`expectedBootstrapSha256`、`expectedAuthorizationRequestBundleSha256`，以及确认后由本地
controller 显示的 `expectedActivationGrantSha256` 作为信任锚。request bundle、grant 或任一
payload 与其 sidecar 一起传输都不能自证。

### 2.3 两个 symlink 不是原子切换

分别 rename `current` 和 `previous` 会暴露中间组合。

修正：release root 固定使用：

```text
releases/<immutable-release>/
sets/<transaction-id>/{current,previous}
active -> sets/<transaction-id>
transactions/<transaction-id>/
```

先完整构造并 fsync 新 set，把已通过 full smoke 的摘要写入 `commit-intent` journal 并 fsync，
最后只对 `active` 做一次同文件系统 `os.replace` 并 fsync parent。该 replace 是 commit point；
外部 `current`/`previous` 只能通过 `active/current`、`active/previous` 解析。

若在 replace 后、terminal record 落盘前崩溃，recovery 看到
`active -> sets/<transaction-id>` + exact commit-intent 时必须重跑 final status/smoke：通过则
补写 `succeeded`，失败则用第二次 `os.replace` 回旧 set 并写 `rolled-back`。成功路径严格一次
replace；失败回滚路径允许一次提交 replace 加一次回退 replace，测试分别计数。

### 2.4 rollback 后找不到 transaction record

自动回滚后 `current` 已恢复为 legacy，不能再从 current release 取失败记录。

修正：每次交易的 canonical record 与 sidecar只写入
`transactions/<transaction-id>/`。immutable release 永不追加交易后文件；active set 只保存
transaction ID/reference。成功、rolled-back 或 rollback-failed 都从 transaction 路径取证。
文档 renderer 只接受 `outcome="succeeded"`。

## 3. 浏览器入口与静态文件所有权

### 3.1 URL 决策

- `GET /`：新的 backend-owned MVP。
- `/demo.html`、`/tracks.html` 及其现有依赖：保留 exact legacy compatibility URL，
  由同一 Node gateway 和同一 singleton audio worker 提供；不重定向、不另起旧 GPU 服务。
- 新 UI 的所有 HTTP 与 WebSocket 地址从 `window.location.origin` 派生。
- production source/bundle 不得包含 `127.0.0.1:18090` 或开发 UI origin `4193`。

### 3.2 Static route manifest

不允许裸目录 static serve。production graph builder 输出 digest-bound route manifest，
只把 graph 中声明为 browser/static 的文件映射为 URL。镜像保留 repo topology，route
manifest 记录 URL、repo-relative path、MIME 和 byte SHA-256。Node 在启动前验证每个实际
文件字节与 manifest 一致。

`/` 显式映射 `mvp/index.html`；MVP 相对资源和 legacy compatibility 资源都必须出现在同一
graph/route manifest。legacy 至少保留现有 URL：
`/voice-client.js`、`/voice-client-production.js`、`/pcm-player-worklet.js`、
`/assets/timbre/latent_map.json`、`/assets/timbre/voice_maps/*.json`，不能借重构默默迁到
`/_client/*`。未知路径、路径穿越、大小写漂移、symlink、重复 URL 和 MIME 不一致一律拒绝。

## 4. Canonical origin policy

### 4.1 固定 origin

- direct-local candidate：`http://127.0.0.1:18090`
- container-local candidate：宿主机仍为 `http://127.0.0.1:18090`
- production browser：`http://localhost:8090`

production 用户通过 SSH loopback tunnel 访问 `http://localhost:8090`；裸局域网
`http://192.168.9.140:8090` 不进入浏览器支持面。`productionPublicOrigin` 是授权 tuple 和
activation grant 的字段，不从请求 Host、转发头或普通环境变量推断。

8090 仍是既有外部服务端口，因此 host publish 保持 exact `0.0.0.0:8090:8090`；这不等于允许
任意 Host 加载 browser UI。非浏览器 health/兼容协议使用各自显式 policy，不能复用 static
document 的 origin 规则。

### 4.2 请求校验

- Runtime/Audio/legacy WebSocket：`Origin` 必须与 active profile 的 canonical origin
  byte-for-byte 相等。
- `/`、HTML、JS 和 static：Host 必须精确为 canonical origin 的 authority。top-level
  document 还要求 `Sec-Fetch-Mode=navigate`、`Sec-Fetch-Dest=document`、
  `Sec-Fetch-Site` 为 `none|same-origin`；非 canonical Host 返回 421/403，禁止 redirect。
- bootstrap/latent browser fetch：有 `Origin` 时必须精确相等；无 Origin 时要求 exact Host
  且 `Sec-Fetch-Site=same-origin`，不得把 navigation 的 `none` 放宽给 API。
- health/readiness 的无 Origin loopback 运维读取可以单独 allowlist，不放宽 browser API。
- 不信任 `X-Forwarded-*`；不反射 Host；拒绝 localhost/127.0.0.1/IPv6 的别名互换。
- container bind address `0.0.0.0` 永远不能成为 `selfOrigin`。

## 5. Production runtime 的不可伪造启动

### 5.1 入口分离

- `index.js` / local entry 永久拒绝 production profile。
- side-effect-free `runtime-main.js` 负责组合依赖。
- `authorized-entry.js` 是 cutover-candidate 与 production 的唯一受权 entry；它只能从
  trusted activation loader 和 transaction journal 取得 branded launch role，不能通过
  `allowProduction=true` 或环境变量打开。

activation loader 使用 `O_NOFOLLOW`/owner/mode/canonical bytes/sidecar 校验读取：

- release manifest
- prior production attestation
- cutover request
- initial world
- activation grant
- transaction journal、active-set reference 与本容器 exact recipe/ID
- 可选 terminal transaction record

任一缺失、digest 漂移、失败或 rolled-back record 都必须在初始化 agents、连接 UDS 和
`listen()` 之前失败。

### 5.2 Activation 生命周期

`activation-grant.json` 是用户逐字确认 exact request bundle 后、任何 production write
之前由本地 controller 生成的不可变凭证。它绑定 exact transaction、candidate、prior owner、
request-bundle SHA、initial snapshot、image identity、两个 launch recipe 和确认动作。远端只
在 SSH 命令携带的 `expectedActivationGrantSha256` 与实际 bytes 相等后接受；grant 与 sidecar
一起传输不能自证。

- 无 terminal record：只有 journal 当前 phase、launch role、active candidate identity、
  本容器 recipe/ID 全部匹配时，才允许该 transaction 启动。
- `outcome="succeeded"` record 且摘要匹配：允许同 release 受控重启。
- `rolled-back`、`rollback-failed`、`failed` 或任一摘要漂移：拒绝启动。

成功 record 不替代 grant，而是给它加 terminal outcome。rollback journal 必须把该 grant
永久标为不可重放；旧 grant 即使仍在磁盘也不能再次 bind。普通 env 或容器参数不能构造
activation authority。

### 5.3 Strict initial restore

production 必须使用 `requiredRestore=true`：

- `initial-world.snapshot` 传给 `createRuntimeApp({restoredSnapshot})`；
- outer/request/bootstrap/state.replace/snapshot 中的
  `worldId`、`worldGeneration`、revision、eventSeq、seed、configRevision、
  protocolVersion、snapshotSchemaVersion 必须完全一致；
- `worldGeneration` 必须是 canonical UUID string，数字或重新生成均拒绝；
- `WorldSession.restoreDisposition` 必须为 `restored`，并在 `listen()` 前 eager assert。

local/shadow 可以保留 `rebuilt-incompatible` 行为；production 不得静默 fallback。

### 5.4 Trusted launch roles

同一 activation grant 同时绑定两个不可由 env 切换的 role：

```text
cutover-candidate:
  container bind 0.0.0.0:8090
  host publish 127.0.0.1:18090:8090
  browser origin http://127.0.0.1:18090

production:
  container bind 0.0.0.0:8090
  host publish 0.0.0.0:8090:8090
  browser origin http://localhost:8090
```

两者使用同一 runtime image、transaction、required snapshot、species profile 和 release
identity。journal phase 决定当前唯一 role；temporary smoke 完成后只重建 runtime 容器，
audio worker 不重启。local `index.js` 不能承担 cutover-candidate。

## 6. Production agent profile

production activation grant 固定启用 species provider：

```text
speciesEnabled=true
speciesBaseUrl=http://127.0.0.1:8081/v1
speciesModel=bird_agent
```

8083 永不出现在 production call graph。master provider 仍从进程 secret 注入；没有授权
secret 时按设计显式禁用，不把 secret 写进 manifest、attestation、record 或日志。

## 7. 生产控制面

新增隔离的 `production_control.py`。授权前 attestation collector 只依赖没有 mutator 的
`ReadOnlyProductionOps`；授权后核心依赖注入的 `ProductionHostOps`：

- filesystem / lock / fsync / atomic replace
- Docker inspect/start/stop/rm/update
- loopback HTTP/WS smoke
- clock 与 journal

真实 mutating adapter 只能在 exact confirm、`yfhuang`、canonical paths、trusted
authorization request bundle、activation grant 和 live preflight 全部通过后构造。只读
collector 可以在授权前构造，但类型上没有 write/stop/start/rm/update 方法。单元/集成测试使用
temp root + FakeHostOps/FakeDocker，不得访问真实 Docker、网络或 8090。

命令分为：

- `collect-prior-production-attestation`
- `import-production`
- `preflight-production`
- `cutover`
- `rollback`
- `status-production`

所有 production path、base URL 和 trust-anchor digest 必须显式传入并匹配固定 allowlist；
local `status`、`import`、`rollback` 不得隐式落到 production adapter。

## 8. Rollback

首次切换不删除旧容器，也不依赖 mutable tag 重建：

1. preflight 捕获 exact legacy container ID/image ID/restart policy/port/GPU/mount/marker/static
   HMAC，写入 digest-bound rollback descriptor；不记录 raw env/secret。
2. cutover 把旧容器 restart policy 临时设为 `no`，再 stop exact ID；不 rm。
3. rollback 停并删除记录中的 exact 新 runtime/audio container ID；在仍 stopped 的 exact
   legacy ID 上先恢复原 restart policy，再 start exact legacy ID。
4. 验证 legacy 六字段、8090 owner、decoder smoke 和 static/HMAC；旧 browser 各自重建 world。
5. exact ID 或证据漂移时不猜测重建，记录 `rollback-failed`，文档不得宣称 Phase 5 成功。

## 9. Cutover 交易不变量

- old 8090 stop 之前，不启动 production-published runtime。
- temporary runtime 只 publish `127.0.0.1:18090:8090`。
- audio 是唯一 GPU candidate，无 published port；runtime 无 GPU。
- temporary → final runtime re-create 期间 audio container ID 与 start count 不变。
- full production smoke 之前不替换 `active`。
- active replace 前必须有 fsync 后的 commit-intent + smoke digest；replace 后必须 fsync parent。
- 无 terminal record 的 crash recovery 按 2.3 的 commit-point 规则完成提交或第二次 replace
  回滚，不能凭进程内状态猜测。
- 任一步失败自动整体 rollback；不得留下 UI/world/audio/legacy 的部分 owner。
- 不使用 `latest`、`pkill`、未知容器名、8083 或未记录的 filesystem target。
- transaction journal 支持并发锁和崩溃重入；每个 phase 都可故障注入。

## 10. Record 与文档

统一 transaction record schema，至少包含：

- `outcome`
- transaction/activation-grant/request/archive/bootstrap/request-bundle digests
- release/source/audio/image identity
- previous exact owner tuple 与 release identity
- `runtimeOwner="server"`、`audioOwner="world"`
- state policy、initial world SHA、world ID/generation、seed/config revision
- ready time、operator、smoke results、rollback outcome

Phase 6 consumer 与 docs renderer 共用同一 schema。renderer 必须先验证所有输入和所有目标，
再原子写文档；只有 `outcome="succeeded"` 且 record transaction 与当前 active set 精确相等
才写已切换。Phase 6 removal 还必须有完整 production stability window、至少一个成功的
server-owned N→N+1 发布周期；failed/rolled-back/no-record 时 removal manifest 不得生成。
外部 `D:/workspace/spark_hackrothon/HANDOFF.md` 仍单独更新，不进入 Git。

## 11. 当前完成定义

候选代码完成不等于生产完成。进入用户授权点前必须同时满足：

1. Node/Python 本地契约全绿，Linux release-security 项真实执行；
2. 同源 MVP、strict restore、activation 和 fake production transaction 全绿；
3. Task 9 在隔离等价 Spark 上完成真实 fault injection、4 clients/1 slow client、30 分钟和
   shared 8081 load；
4. exact release/package/authorization/prior-attestation tuple 已冻结；
5. production write 尚未发生，等待逐字授权。
