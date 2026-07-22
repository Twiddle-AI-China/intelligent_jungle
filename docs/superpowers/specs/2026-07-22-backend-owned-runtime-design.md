# 后端权威运行时重构设计

日期：2026-07-22

状态：设计已口头批准，待书面复核

目标分支：`refactor/backend-owned-runtime`

## 1. 背景

当前产品表面上由 `mvp/` 前端和 `flock-voice-engine/` 音源后端组成，实际上浏览器承担了完整运行时：

- 创建并推进权威 world；
- 执行 Sequence、Economy、Harmony、species agent 和 master agent；
- 直接访问 LLM 服务并维护重试、超时和熔断；
- 将生态状态投影到潜空间并直接控制音源行；
- 把 world 事件映射成音符，完成排程、混音、EQ、混响和电平统计；
- 为每个浏览器建立独立 decoder 会话。

Python 服务只负责按浏览器上行的音符/控制帧渲染 PCM，而且每条 WebSocket 连接都会创建一套 Session、VoicePool 和 AudioBackend。模型加载和 GPU render 均同步发生在 aiohttp 事件循环中，导致一次慢加载或渲染尖峰影响所有 HTTP、心跳、控制和音频发送。

线上 `/srv/deploy/flock-voice-engine` 还是脱离 Git 的热拷贝目录。2026-07-22 审计显示，218 个相关线上文件中有 27 个内容漂移、27 个线上独有；线上实际契约为 pool 5、block 4096，而 Git 文档和脚本仍记录 pool 7。当前分支不能直接重建线上，重构前必须先收编生产事实。

## 2. 目标

本次重构要实现：

1. 浏览器只负责 UI、用户输入、只读状态投影和 PCM 播放。
2. 后端成为 world、agent、潜空间、音频计划和混音状态的唯一事实源。
3. species agent 固定调用本地 `bird_agent@8081`；master agent 固定调用云端 DeepSeek，二者使用独立 provider、队列和故障策略。
4. 神经音源模型只在 audio worker 启动时加载一次，浏览器连接不再创建 GPU 后端。
5. 控制/状态通道与 PCM 数据通道分离，音频卡顿不能阻塞世界控制。
6. 一个共享世界只计算、渲染一次，多个浏览器复用相同状态和 PCM。
7. 保留现有 UI 外观、交互语义和已验证的领域算法，通过增量迁移完成切换。
8. 建立可复现发布、版本标识、验收门禁和五分钟内可执行的回滚路径。

## 3. 非目标

本轮不包含：

- 视觉设计重做；
- 模型重训、checkpoint 更换或音质调优；
- 开放任意数量的独立世界；
- 构建完整公网账号、计费或权限系统；
- 改动外部端口 8090 或上游模型名 `bird_agent`；
- 把系统拆成可独立部署、独立扩缩容的全套微服务；
- 在迁移完成前删除旧 `/decoder` 协议。

## 4. 冻结的架构决定

### 4.1 单一共享世界

第一版只运行一个权威世界 `default`：

- 所有浏览器订阅同一份 snapshot、domain events 和 PCM；
- 一个 world tick、一个 agent 日程和一个 audio render loop；
- 每个可接管对象只有一个写控制租约，其他客户端保持只读；
- Sequence、mix、master 和 latent 写操作都服从对应对象的租约；未持租约的客户端只能观察；
- preview 是共享世界内的权威试听，必须持有该声部租约，所有听众都会听到；本轮不提供每客户端私有试听渲染；
- 客户端断开后，租约经过短 TTL 自动释放并回到 AGENT；
- 架构保留 `WorldSessionRegistry` 抽象，但暂不启用多世界并行渲染。

这样可以消除“多开一个标签页就复制一套 GPU 实时会话”的资源模型。

### 4.2 Node 控制面 + Python audio worker

后端逻辑上是一个服务，运行时分成两个隔离进程：

```text
浏览器
  ├─ Canvas / DOM / 相机 / 手势 / 无障碍
  ├─ RuntimeClient：命令 + 只读 snapshot
  └─ PcmPlayer：AudioWorklet 缓冲与设备播放
       │
       ├─ JSON Runtime WebSocket
       └─ PCM Audio WebSocket
              │
Node Runtime Control Plane（外部唯一入口 :8090）
  ├─ WorldSession / SimulationRuntime
  ├─ Sequence / Economy / Harmony
  ├─ AgentOrchestrator
  ├─ LatentRuntime
  ├─ AudioPlanner / MixState
  ├─ SnapshotProjector
  └─ API / WS Gateway
              │ 私有、有界 IPC
Python Audio Worker（不暴露局域网端口）
  ├─ 单例模型仓库与唯一 GPU owner
  ├─ VoicePool / realtime render state
  ├─ 服务端混音、EQ、混响和限幅
  ├─ PCM ring / telemetry
  └─ 最终 f32 stereo PCM
```

采用 Node 控制面是为了复用当前已经有 353 项测试覆盖的 JavaScript 领域逻辑，避免把 world、economy、harmony 和 agent 重新翻译成 Python。Python worker继续复用现有 torch、MidiBrave 和 streaming 实现。

两者是同一发布单元，不是两个对外微服务。生产建议使用两个容器：`flock-runtime` 不申请 GPU，`flock-audio` 是本发布单元内唯一直接使用 torch/CUDA 的进程；宿主机上的 `bird_agent` vLLM 仍是外部 GPU 租户。只有 runtime 绑定 8090，audio 只允许私有网络或 Unix domain socket 访问。两个容器必须来自同一份不可变 release manifest；runtime 与 worker 分别从自己的只读发布内容加载身份，不能由连接发起方临时告诉 worker“应该回报什么版本”。

### 4.3 浏览器边界

浏览器允许保留：

- DOM/Canvas 渲染、相机和 hit test；
- 键盘、鼠标、触摸和 MIDI 输入到用户意图的转换；
- 只读 snapshot 缓存与 renderer view model；
- RuntimeClient 的连接、重连和协议校验；
- 潜空间地图、光标和滑杆的纯展示；
- AudioWorklet 的 PCM 缓冲、播放和设备侧最终音量；
- 可选的本地 MediaRecorder 录制。

浏览器禁止承担：

- `world.tick()`、昼夜/季节或 Sequence 推进；
- economy、harmony、mapping、agent/master 或规则 fallback；
- 任何 LLM 直连、API key、重试、熔断和 provider 选择；
- 生态关系到 XY/PCA 的计算、kNN、后端行号或 preview 行租赁；
- 音符排程、pad 行分配、voice pool、混音、EQ、混响、mute/solo 的权威状态；
- 直接访问底层 `/decoder` 或 8081。

前端可以做短暂的按压/拖动反馈，但服务端 revision 返回后必须覆盖本地临时状态。

### 4.4 8090 所有权与迁移拓扑

端口所有权按阶段冻结，不能在实施时临时选择：

- Phase 0–4：当前 Python 生产服务继续独占 8090；Node 候选运行时只绑定 `127.0.0.1:18090` 等临时内部端口，用于 contract test、shadow-run 和新 UI 验证，不承接生产流量。
- Phase 0–4 的生产权威始终是指定 legacy 浏览器；Node 只做影子计算，不驱动生产 PCM。
- Phase 5 切换是原子发布边界：停旧 8090 容器后，由 `flock-runtime` 接管 8090，并连接同一 release 内唯一的 `flock-audio` worker。
- Phase 5 之后静态资源、新 `/api/v1/*`、兼容 `/decoder`、`/api/decoder-status` 和 `/api/load` 全部由 Node gateway 提供；不得再并行运行第二个旧 Python GPU 服务。
- 候选 release 在切换前通过 localhost 临时端口验证；临时端口不加入上游契约，也不对局域网开放。

因此 Phase 2–4 不会出现“服务端 world 已接管、音频仍等待浏览器本地事件”的半切换状态。UI、world owner 和 audio owner 只在 Phase 5 一次性切换。

## 5. 控制面模块

### 5.1 WorldSession

`WorldSession` 是共享世界的聚合根，持有：

- world、transport、sequence、economy、harmony 状态；
- 当前 day/phase、单调 revision 和确定性随机种子；
- tree/master 控制租约；
- agent 日程、待生效决策和规则 fallback 状态；
- 每个声部的 latent、mix、mute/solo 和 voice mode；
- 客户端订阅与命令去重窗口。

每个 WorldSession 只有一个 mailbox/actor 串行应用命令、tick、agent 结果和 worker telemetry。不能依赖“阻塞事件循环”隐式避免竞态。

### 5.2 SimulationRuntime

- 使用固定步长后台时钟，不依赖浏览器 RAF；
- 页面无人连接时仍按产品配置决定继续或暂停，默认继续；
- 一次 tick 产生的 world 变化、domain events 和 audio commands 作为同一逻辑批次提交；
- runtime → audio 的 note/gate 边沿进入有界可靠队列，队列溢出视为 audio 故障并触发重建，绝不静默丢弃；
- 面向 UI 的所有可重建状态变化写入同一个带 eventSeq 的有界 journal：每个逻辑批次至少包含 `baseRevision/resultRevision`、有序 `state.patch` 和同批 `domain.event`；不能只记视觉事件而遗漏权威状态 patch。慢客户端落后超出 journal 窗口时用 snapshot 重同步，不能反压 tick；
- timeline、decision 和当前控制权必须同时存在于 snapshot 投影中，客户端恢复不能依赖无限 WS 历史；
- journal record 按 eventSeq 全序且可由 baseRevision 验证连续性；状态 patch 可以被新 snapshot 取代，但 revision/eventSeq 任一不连续时必须显式重同步；
- snapshot 包含 seed、day、phase、revision 和 protocolVersion，便于重放和诊断。

### 5.3 AgentOrchestrator

- species agents 只调用本地 `bird_agent@8081`；
- master agent 只调用服务端配置的 DeepSeek；
- 两条 provider 使用独立 client、并发上限、超时、重试和熔断；
- LLM 请求不在 tick 或 audio render 路径等待；
- 每个结果携带 `worldRevision`、`day` 和应用边界，过期结果丢弃；
- provider 失败时继续使用现有确定性 policy，不停止世界；
- prompt、schema、凭证和原始模型响应不发送到浏览器。

本地 `bird_agent` 与 audio worker 仍共享同一块 GB10，因此 species 调度必须服从实时音频优先级：

- species 请求使用单个批量请求并限制为最多 1 个本地 GPU 请求在途，禁止多 flock 并发轰击 8081；
- 只有 PCM headroom、audio queue depth 和最近 render p95/p99 都在门限内时才启动本地推理；
- render 超过预算、出现 underrun、worker 恢复中或统一内存低于预留时，跳过本轮本地请求并直接使用规则 fallback；
- master 走云端 provider，不占本地 GPU，但仍受独立并发和超时约束；
- 启动检查必须给 audio 模型、PCM ring 和瞬时峰值保留明确内存余量，不能只依赖 vLLM 的剩余可用值；
- 稳定性验收必须在持续施加正常及突发 8081 species-agent 负载时测量 audio render p99，而不是只测空闲 GPU。

### 5.4 LatentRuntime

后端统一持有：

- 八个生态关系量；
- 每物种固定投影、extent、平滑器和当前目标；
- kNN/XY 与 PCA 两种模式及合法范围；
- USER/AGENT 接管和恢复行为；
- preview 行租赁与超时；
- audio worker 实际接收的 latent intent。

前端 `latent-roamer` 只发送归一化光标、模式、preview start/stop，并显示服务端返回的地图 metadata、邻居、范围和当前游标。前端不得解析 backend row，也不得直接发送 `timbreXY` 或 `timbrePCA` 给音源。

### 5.5 AudioPlanner 与 MixState

AudioPlanner 把确定的 world/sequence/latent 事件翻译成 audio worker 命令，负责：

- perch/unperch、hold/release 和 pad chord voice assignment；
- 采样时间或 worker timeline 上的目标时刻；
- MIDI/velocity/时值训练域夹紧；
- 每声部 latent、gain、EQ、reverb、mute/solo；
- 命令优先级和背压策略。

连续参数更新可以合并为最新值；note on/off、gate 边沿和控制权切换不能被静默覆盖。

控制面与 worker 建立明确的音频时钟映射 `{worldTime, audioFrame}`。AudioPlanner 必须把事件转换成绝对 `targetFrame`，提前放入 worker 队列；worker 按 frame 顺序应用，不能再用浏览器 `setTimeout` 排音符。迟到命令需要按类型执行显式策略：连续参数立即应用，note 边沿记录 late 指标后尽快应用，已经完全过期的 preview 命令拒绝并回报。

当前浏览器内的 texture/Jungle granular 声部也必须进入后端音频所有权。texture 神经 checkpoint 不在本轮范围内，但 Phase 5 必须把现有确定性 sample/granular fallback 移入 audio worker，确保删除浏览器 WebAudio 领域代码后四个物种仍完整发声。

### 5.6 状态持久化

共享世界不能因浏览器刷新而重建。控制面至少在 dawn、控制权变化和发布切换前写入带 schemaVersion/configRevision 的原子 snapshot：

- Runtime 重启优先加载兼容 snapshot，并以 seed、day、phase 和 revision 继续；
- snapshot schema 不兼容时显式创建新世界并广播 `world.reset`，不得静默部分加载；
- audio worker 重启后由控制面用当前 world/latent/mix snapshot 重建 worker 状态；
- LLM 凭证、原始响应和浏览器连接信息不写入世界 snapshot。

## 6. Audio worker

### 6.1 生命周期

- worker 进程启动时加载模型、voice maps、默认 latent 和响度标定；
- 加载成功后才报告 ready，浏览器连接绝不触发 `backend.load()`；
- worker 是音频后端内部唯一 CUDA context 和音频 GPU state owner；宿主机 vLLM 的外部争用按 5.3 的门禁处理；
- 一个共享世界对应一套固定长度 VoicePool 和一个 render loop；
- render thread 是唯一允许修改 VoicePool、backend streaming state 或调用 torch/CUDA 的线程；
- IPC reader、日志线程和 telemetry 线程只能向有界队列写消息或读取不可变快照，不能直接调用 backend；
- render loop 不等待 LLM、HTTP、磁盘日志或客户端；
- telemetry 和日志通过非阻塞队列异步上报。

### 6.2 IPC 与背压

控制面和 worker 使用版本化的私有双向 IPC，至少承载：

- `worker.ready` / `worker.error`；
- 有序 audio command batch；
- PCM block；
- meter、render timing、queue depth、underrun 和 worker revision；
- restart/discontinuity 通知。

`worker.ready` 必须携带不可变 worker identity，至少包括：

```json
{
  "releaseRevision": "git-sha",
  "sourceManifestSha256": "sha256",
  "protocolFamily": "flock-audio-ipc",
  "protocolVersion": 1,
  "audioArtifactKind": "vendor-tree|release-artifact",
  "audioArtifactSha256": "sha256"
}
```

worker 在加载模型前从自己的只读 identity 文件取得发布字段，并对实际加载的 vendor tree 或受控 artifact 重算 `audioArtifactSha256`；不一致时不得报告 ready。Phase 0 的 `vendor-tree` 只用于描述当前过渡基线；Phase 5 切换必须使用 `release-artifact`，其内容 manifest 覆盖 worker image/code、vendor、模型/voice weights、voice maps 与校准资产，即使大文件仍从只读外部挂载，也要以精确 digest 纳入该 manifest。runtime 独立从候选 release manifest 得到期望 tuple。IPC 每次建立或 worker restart 后都必须先做精确相等校验；校验成功前禁止发送 `audio.state.replace`/command，禁止接受 PCM，也不能把 `/readyz` 标为 ready。失败时隔离该连接，并在 health/status 同时展示 expected/reported identity 与 mismatch 原因，不能只比较协议版本或相信 worker 自报的 release 字符串。

每次 worker 启动生成新的 `audioEpoch`，并从 `renderFrame=0` 开始维护单调采样帧时钟。命令批次固定包含：

```json
{
  "audioEpoch": "uuid",
  "commandSeq": 1001,
  "targetFrame": 88200,
  "commands": []
}
```

- 旧 audioEpoch 的命令一律拒绝；
- `commandSeq` 在同一 epoch 内严格递增并用于去重、诊断和同帧排序；
- 同一 targetFrame 的应用顺序固定为：`state.replace` → note/gate off → continuous/latent/mix → note/gate on，再按 commandSeq 排序；
- worker 接收入队后回 `command.accepted`，render thread 真正应用后通过 `appliedCommandSeq` 和 `renderFrame` 回报；
- continuous 更新迟到时立即应用；note/gate 边沿迟到时记录 lateFrames 并尽快应用；已经完全过期的 preview 拒绝并回报；
- render cycle 计时从命令 drain 开始，到模型 forward、服务端混音和 PCM 发布进共享 ring 结束，不能只统计模型 forward。

控制队列必须有界。连续 latent/mix 更新按 `(world, voice, parameter)` 合并；runtime → audio 边沿命令进入独立有界可靠队列，溢出即把 worker 标为 degraded 并进行全量重建，不能降级成丢 note。worker → runtime 的 PCM 使用单一共享、严格有界的 live ring。

### 6.3 Worker 重启与全量状态替换

新 worker 报告 `worker.ready(audioEpoch, identity)` 且 identity 与候选 release 精确匹配后，控制面才暂停增量 audio command，并发送幂等的 `audio.state.replace`，内容至少包括：

- transport/worldTime 到 renderFrame 的新 epoch 映射；
- 当前 active notes/gates、剩余时值或 release 状态；
- pad/voice assignment 与 row binding；
- latent mode、XY/PCA、平滑目标；
- gain、EQ、reverb、mute/solo、master 和 voice mode；
- worker 重建所需的确定性 seed/config revision。

worker 丢弃旧 epoch 队列，render thread 原子应用 replace，并回 `audio.state.applied(audioEpoch, stateRevision)`。控制面收到确认前不恢复增量命令或对外 PCM；确认后增加 `streamRevision`、广播 `audio.discontinuity`，客户端清空旧 ring 并重新 prime。重建可能产生一次可见/可听 discontinuity，但不能让 world 回滚或重复创建模型。

### 6.4 最终输出

worker 的生产主输出是服务端完成混音后的 44.1 kHz、little-endian float32、双声道 PCM。新 UI 不再接收五路/七路干声，也不再拥有权威 EQ、混响或 mute/solo，只保留设备端最终音量和 AudioWorklet 播放缓冲。

兼容周期内 worker 额外保留一个**仅供 Node legacy adapter 在维护模式使用**的 pre-mix split tap，以支持 `/decoder?split=1` 和 `tracks.html`。该 tap 不进入 `/api/v1/audio`，不能被新 UI 订阅，并随旧协议一起删除。

pool size、block size、rowVoices 和 latent capability 必须来自 worker ready/status，任何客户端或控制面模块都不得硬编码 5 或 7。

### 6.5 PCM fan-out

- worker 只向 runtime 发布一份共享 PCM live ring；
- 每个浏览器拥有独立 writer task、严格有界的 egress queue 和 live-edge cursor；广播器只做非阻塞 enqueue，禁止顺序 `await` 每个 WebSocket；
- `audioEpoch`、`streamRevision`、`blockSeq` 和 `startFrame` 属于共享全局时间线：worker restart 才更换 audioEpoch，并把 render/startFrame 归零；worker/global stream 重建增加 streamRevision、把 blockSeq 归零，但同一 audioEpoch 内的 startFrame 继续单调递增；单个客户端跳转不得修改这些全局值；
- 新订阅或重连的 `audio.ready` 携带 `resumeBlockSeq/resumeStartFrame`，其第一块以该 live-edge cursor 为基线，可以大于 0；之后每块才要求 seq/frame 连续；
- egress queue 上限按时间窗口配置，不按固定块数写死；超过上限时只清空该客户端旧队列、把 cursor 移到 live edge，并发送 `scope="client"`、保持当前 audioEpoch/streamRevision、携带新 `resumeBlockSeq/resumeStartFrame` 的 `audio.discontinuity` 后重新 prime；
- 单个慢客户端只影响自己的连续性，不能占满共享 ring、阻塞其它客户端或阻塞 Runtime WS 事件循环。

## 7. 外部协议

所有新接口使用 `/api/v1`，外部仍只暴露 8090。

### 7.1 HTTP

`GET /healthz`

- 只表达进程存活；
- 返回 release revision、runtime 状态和 audio worker 状态摘要；同时返回 runtime 期望与 worker 实际报告的不可变 identity 及 mismatch 原因。

`GET /readyz`

- 只有 world 已启动、audio worker 模型已加载，且 `releaseRevision/sourceManifestSha256/protocolFamily/protocolVersion/audioArtifactKind/audioArtifactSha256` 整个 identity tuple 精确匹配时返回 ready。

`GET /api/v1/bootstrap`

```json
{
  "protocolVersion": 1,
  "releaseRevision": "...",
  "worldId": "default",
  "revision": 42,
  "eventSeq": 9001,
  "snapshot": {},
  "capabilities": {},
  "clientId": "...",
  "bootstrapToken": "opaque-short-lived-token",
  "bootstrapExpiresAt": "ISO-8601"
}
```

bootstrap 不是在 HTTP 线程中先读 snapshot、再另读 journal 游标；请求必须进入 WorldSession mailbox，在同一个串行步骤内冻结 `snapshot/revision/eventSeq`，并签发绑定 `worldId/clientId/revision/eventSeq` 的短期 token。token、凭证和连接信息不进入 snapshot 或日志。

`GET /api/v1/latent-maps/{voice}`

- 返回只用于绘图的点、范围、标签、PCA 维度和当前 cursor；
- 不返回 worker 行号、内部 checkpoint 路径或凭证。

### 7.2 Runtime WebSocket

`GET /api/v1/runtime`

WebSocket 建立后客户端第一帧必须是 opening handshake，任何业务命令都不得先于它：

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "clientId": "...",
  "bootstrapToken": "...",
  "lastRevision": 42,
  "lastEventSeq": 9001
}
```

Gateway 校验 token 后，把 attach 请求投递到同一个 WorldSession mailbox，原子选择两条路径之一：只有统一 journal 完整覆盖 `lastEventSeq` 之后的范围、首个 replay record 的 baseRevision 等于 `lastRevision`，且后续 record 的 revision/eventSeq 连续时，才按 eventSeq replay其中的 state.patch + domain.event，再发 `ready` barrier；任一条件不满足就发送带当前 `revision/eventSeq` 的完整 `snapshot`，再发 `ready` barrier。barrier 之前不向该连接开放 live 增量事件或业务命令。`ready` 同时轮换一个绑定同一 `clientId` 的短期 resume token；重连携带该 token 和最后已应用游标，服务端同一时刻只允许该 client generation 有一个 active socket。token 失效时重新 bootstrap 并接受完整 snapshot。幂等窗口按 `(clientId, commandId)` 建键，因此同一客户端重连不会重复执行已确认命令。

客户端命令统一格式：

```json
{
  "type": "command",
  "protocolVersion": 1,
  "commandId": "uuid",
  "baseRevision": 42,
  "name": "sequence.toggle",
  "payload": {}
}
```

第一版命令集合：

```text
runtime.pause | runtime.resume
snapshot.request
control.take | control.release | control.heartbeat
sequence.toggle | sequence.place | bird.shoo
transport.setTempo | transport.setMeter
master.setSeasonLength | master.setColor
mix.setParam | mix.setMute | mix.setSolo | voice.setMode
latent.setCursor | latent.setMode
preview.start | preview.stop
```

服务端事件集合：

```text
ready
snapshot
state.patch
domain.event
decision
latent.state
meter
audio.status
control.lease
command.result
error
```

所有可影响客户端状态的服务端事件都带 `revision/eventSeq`。`commandId` 在有界窗口内按 clientId 幂等。结构性命令如 Sequence 修改和控制租约要求 revision/lease 校验；连续控制如 latent cursor 和 mix slider 可以接受稍旧 revision，并按最新值合并。任何拒绝都必须返回 `command.result`，不能静默丢弃。

`legacy-audio` 维护租约使用同一组 `control.*` 命令，但 payload 必须明确资源和租约凭据。每个 `/decoder` socket 连接后先收到只读 `legacy.session` 帧，其中的不可猜测 `decoderSessionId` 只标识该 socket generation、尚不授予写权；Phase 5 同步更新 demo/tracks 以读取该帧。`control.take` 携带 `resource="legacy-audio"`、目标 `decoderSessionId` 与请求 TTL，且只接受通过维护权限校验的操作员；成功结果返回 `leaseToken` 和 `expiresAt`，并在服务端把租约原子绑定到该 decoder socket 对象。`control.heartbeat`/`control.release` 必须同时携带 resource 与 token。adapter 对每个 legacy `note/control` 帧都按 socket identity 校验 owner，帧本身无需携带 token；非 owning socket 保持只读并收到显式 error。decoder socket 关闭或 generation 被替换时立即进入统一释放序列，Runtime WS/heartbeat 消失则由 TTL 保底释放。普通 `/decoder` 连接无权自行申请、转移或续租。

客户端发现 patch revision/eventSeq 不连续时立即停止应用 patch，发送 `snapshot.request`（携带最后已应用游标）；服务端同样通过 WorldSession mailbox 生成 snapshot barrier，在完整 snapshot + `ready` 前暂停该连接的增量流。客户端不得自行推断缺失状态；若连接已不可用，则走上述 resume/bootstrap 握手而不是回放未知 patch。

### 7.3 Audio WebSocket

`GET /api/v1/audio`

- 第一帧为 `audio.ready` JSON，声明 audioEpoch、sampleRate、channels、format、blockFrames、streamRevision、`resumeBlockSeq/resumeStartFrame`、binaryHeaderVersion=1 和 headerBytes=32；下一 binary frame 必须精确等于该 resume cursor；
- 后续 binary frame 固定为 32-byte header + interleaved stereo f32le PCM，v1 头部按下表编码，所有整数均 little-endian：

```text
offset  bytes  type/value
0       4      ASCII "FLK1"
4       1      u8 headerVersion = 1
5       1      u8 flags = 0（v1 保留）
6       2      u16 headerBytes = 32
8       4      u32 streamRevision
12      4      u32 blockSeq
16      8      u64 startFrame
24      4      u32 frameCount
28      2      u16 channels = 2
30      2      u16 format = 1（f32le）
32      ...    frameCount * channels * 4 bytes，按帧 L/R 交错
```

- 共享流在一个 streamRevision 内从 `blockSeq=0` 开始；`startFrame` 使用 audioEpoch 的单调 renderFrame，因此新 revision 的首个 startFrame 可以非零。客户端可以由 ready/discontinuity 指定的非零 resume cursor 迟加入，收到首块后才要求 `blockSeq + 1` 且 `startFrame` 等于上一块结尾。payload 长度必须精确匹配头部，越界、倒序、重复或长度不符都触发该客户端 discontinuity；
- 客户端只上报 buffer depth、underrun 和播放状态；
- worker/global stream 重建时发送 `scope="stream"` 的 `audio.discontinuity`：worker restart 同时更换 audioEpoch，所有全局重建都增加 streamRevision、给出 `resumeBlockSeq=0` 与当前 `resumeStartFrame`（只有新 epoch 才为 0）；单客户端丢块只发送 `scope="client"` boundary，保持全局 audioEpoch/streamRevision 并给出当前 live-edge cursor；
- 两类 boundary 后的下一 binary frame 都必须精确匹配其 resume cursor，且 WebSocket 顺序内不得在 boundary 后继续发送被放弃的旧块。播放器先清空本地 ring，看到匹配 boundary 后才重新 prime；
- Audio WS 断线不关闭 Runtime WS，Runtime WS 断线也不立即停止 PCM。

### 7.4 旧协议兼容

迁移期间保留：

- `/api/decoder-status`；
- `/api/load`；
- `/decoder`；
- 现有 demo/tracks 验证页。

Phase 5 后这些路径由 Node 内的 legacy adapter 实现，并消费**同一个 singleton audio worker**；禁止为了兼容路径继续运行旧 GPU 服务或加载第二份模型。

legacy `note/control` 帧先翻译为 AudioPlanner command，并受全局 `audioOwner=world|legacy` 状态机和排他的 `legacy-audio` 维护租约约束：

- 默认 `audioOwner=world`，World AudioPlanner 是唯一 writer；legacy 客户端只能监听 PCM/telemetry，写帧得到显式 error；
- 操作员必须先通过受控的 Runtime maintenance command 打开 legacy audio，普通 `/decoder` 连接不能自行抢占；
- 切到 `audioOwner=legacy` 时，Runtime 暂停 World AudioPlanner 输出，对 VoicePool 执行 all-off/reset，增加 streamRevision 后才允许 legacy 帧写入；world 仿真继续运行但不驱动音频；
- legacy stereo `/decoder` 读取 worker 主混音，`/decoder?split=1` 从同一 worker 的内部 pre-mix split tap 读取真实 row channels，不创建第二个 VoicePool 或模型；
- 操作员 release、heartbeat 超时、租约连接断开和 adapter 异常都必须走同一释放序列：先拒绝新 legacy 写入并 all-off，再用当前共享 world 的完整 `audio.state.replace` 恢复 latent、mix、active gates 和 assignment；确认应用后切回 `audioOwner=world` 并广播 discontinuity；
- demo/tracks 与新 UI 的兼容门禁分别在排他租约下顺序执行，不要求两者同时写同一个世界；
- adapter 不负责推进 world，也不能成为第二个 runtime owner。

旧协议至少保留一个成功发布周期。新 UI 全量切换并通过稳定性门禁后，才能另行决策删除。

## 8. 前端迁移方式

1. 新增 `RuntimeClient`，其只读 snapshot 尽量保持现有 `world.getSnapshot()` 形状，使 renderer 和 UI 模块继续工作。
2. 新增 `PcmPlayer`，接管 AudioWorklet、缓冲、重连和本地录制。
3. 将 `world.set*`、`conductor.set*`、`audio.set*` 调用替换为 runtime command；按钮、命中检测和键盘/MIDI 入口保留。
4. 保留现有 `perch`、`unperch`、`dawn`、`dusk` 和 `sequence-pattern` 事件载荷，供视觉 flash、timeline 和提示文案消费。
5. `latent-roamer.js` 只保留绘图、模式按钮、滑杆和手势，删除邻居计算、PCA 换算、行解析和直接 audio 调用。
6. 迁移期间以全局发布配置 `runtimeOwner=browser|server` 二选一；它不是每客户端 feature flag。browser owner 阶段只允许指定的 legacy 展演页推进生产世界，其他页面只做测试；server owner 阶段所有浏览器都只读服务端世界。任何时刻禁止双 tick 或混合 owner。
7. server owner 稳定后，从生产 bundle 移除 world tick、agent prompt、latent projection 和 WebAudio 领域编排。

## 9. 生产收编与目录策略

开始业务重构前先完成 Phase 0：

1. 只读拉取 `/srv/deploy/flock-voice-engine` 中 Git-controlled 源码和非权重资产到临时审计目录；不能把“未复制进快照”误写成“不是运行输入”。
2. 建立带 SHA-256 的生产 manifest，记录容器参数、pool/block、模型能力和 release 时间；对 manifest 之外但被容器实际挂载的运行输入单独记录完整性证据与可重建缺口。
3. 按 canonical 映射收编：线上 `web/` 对应 Git `mvp/`，线上 `server/` 对应 `flock-voice-engine/server/`；不能把热部署目录整棵复制成第二份源码。
4. 排除 `.venv/`、vendor 内容、checkpoint、staging、备份文件、生成缓存和凭证；但 active vendor 必须记录聚合树 SHA/文件数/来源与 unknown revision，runtime config 必须用不回传内容的私有 HMAC 做前后证明。必要的小型 JSON 地图资产单独审计后入库。
5. 用独立提交记录 Git-controlled 生产基线和 external runtime input 边界，提交信息建议为 `chore: capture 2026-07-22 production baseline`。
6. 在 health/status 中加入 Git revision 和协议版本；未完成前禁止从当前分支覆盖生产。

`mvp/` 继续作为前端 canonical source；部署时复制到 release 的静态目录。`flock-voice-engine/web/` 不作为第二份可手工编辑源码。

## 10. 部署、安全与资源

- 所有 SSH、发布和文件归属切换到 `yfhuang`；不得使用 `rolf` 登录。
- 容器 UID/GID、日志目录、release 目录和 bind-mount 权限必须一起迁移，不能只改用户名文本。
- 删除仓库中的明文密码、旧 expect 脚本和服务端 API key；凭证通过环境变量或只读 secret file 注入。
- `flock-runtime` 不申请 GPU；本发布单元只有 `flock-audio` 申请 GPU，宿主机既有 vLLM 仍按外部共享租户管理。
- 权重和训练资产只读挂载。
- 当前 active vendor 是无 `.git` revision 的部署镜像，只能内容指纹验证、不能声称可由 Git 重建；Phase 5 替换或打包前必须固定可获取的上游 revision 或受控 artifact。
- audio worker 暴露 queue depth、render p50/p95/p99、GPU/统一内存、underrun 和 restart count。
- vLLM 与 audio worker 仍共享 GB10 统一内存，因此必须做启动时容量检查、有限会话准入和 OOM 降级；CPU shares 不能当作 GPU 配额。
- 外部保持 8090；8081 的模型名保持 `bird_agent`。

## 11. 失败与恢复

- LLM 超时或失败：使用确定性 policy，world 和 audio 不暂停。
- audio worker 未 ready：Runtime 正常提供 UI 状态，但 `audio.status=degraded`，不伪装成本地合成成功。
- audio worker 崩溃或可靠边沿队列溢出：停止增量音频命令，supervisor 重启 worker，并按 6.3 完成新 epoch 的全量 `audio.state.replace`；共享 world 不重建。
- Runtime 进程重启：加载最近兼容的原子 world snapshot，再重建 worker；无法兼容时显式广播 `world.reset`。
- Runtime WS 重连：客户端通过绑定 clientId 与 lastRevision/lastEventSeq 的 hello/resume 握手，由 WorldSession mailbox 原子选择 journal replay 或完整 snapshot barrier，不回放未知 patch。
- Audio WS 重连：`audio.ready` 以当前全局时间线的 resume cursor 建立新本地基线，只重建播放器 ring，不创建新模型实例或重置全局 streamRevision。
- 慢 Runtime 客户端：超出 event journal 后用 snapshot 重同步；慢 Audio 客户端：独立 egress queue 跳到 live edge并 discontinuity，二者都不能拖慢共享世界。
- 控制租约客户端消失：普通控制租约 TTL 到期回 AGENT 并广播 lease 变化；legacy owning decoder socket 消失则立即执行 all-off/state.replace 释放序列，Runtime maintenance socket 消失由短 TTL 保底。
- 发布失败：切回上一 release revision 和旧 runtime owner；协议保持向后兼容。

## 12. 测试与验收门禁

### 12.1 测试层级

1. 领域单元测试：迁移现有 world/economy/harmony/agent/latent 测试到 Node runtime。
2. 协议契约测试：command schema、revision、幂等、lease、HTTP bootstrap 后仅发生 state.patch 再 WS attach、journal gap/snapshot barrier、decoder session 唯一 writer、断线恢复、worker identity mismatch 拒绝，以及 Audio WS v1 header golden vector/新订阅/重连/慢客户端 cursor 跳转/乱序与两类 discontinuity 边界。
3. 确定性 shadow 测试：同 seed、同输入下比较浏览器旧内核与服务端新内核的关键 snapshot 和 domain event 序列；浮点字段使用显式容差。
4. Worker 单元测试：模型只加载一次、队列合并、边沿命令可靠、render loop 不做 I/O。
5. Audio 自测：保留 server selftest、streaming consistency、smoke、note expiry 和 stress_pool4。
6. 浏览器 E2E：真实 Chromium 验证 UI、Runtime WS、AudioWorklet、接管、潜空间和重连。
7. 发布测试：候选 release 在 localhost 临时端口完成 health/ready/selftest/smoke 后才切 8090。
8. Phase 0 生产不变测试：Git-controlled core source hash、vendor 聚合树 SHA/文件数、runtime config 私有 HMAC 和 active mount 契约都必须前后一致；该证明明确不覆盖权重与宿主机 site-packages。

现有测试入口需要先修复：

- `npm test` 当前 34/34；
- `npm run test:mvp` 当前 353/353；
- voice pytest 当前 7/7；
- `python -m unittest discover` 会得到 0 tests，不能作为门禁；
- `npm run check` 引用不存在的 `src/instrument/live-session.js`，当前 `npm run verify` 不可信；
- 新 verify 必须显式包含 runtime、MVP、voice pytest、协议和 E2E 的可运行子集。

### 12.2 验收指标

- 生产前端 bundle 不包含 world tick、agent prompt、LLM client、latent projection、音符排程或服务端混音逻辑。
- 同 seed shadow 对关键 snapshot/domain events 一致，所有容差写入测试。
- 模型每个 worker 生命周期只加载一次；浏览器连接数不增加模型实例。
- 四个并发浏览器订阅同一世界连续运行 30 分钟，其中一个持续限速/暂停读取 PCM：其它客户端异常关闭 0、重连风暴 0、audio underrun 0。
- hot client 的 runtime ready p95 < 1 秒；UI state lag p95 < 150 ms。
- render cycle（命令 drain + 模型 + 混音 + 共享 PCM ring publish）p95 < block 时长 70%，p99 < 90%；指标必须按线上实际 pool/block 重测。
- bass、pad、melody 和 texture 四个物种均由服务端音频路径发声；生产 bundle 不再依赖本地合成兜底。
- species/master 任一 provider 故障不阻塞 tick，且 fallback/source 可观测；持续施加正常与突发 8081 species 负载时仍满足 audio p99/underrun 门禁。
- 旧 demo/tracks 与新 UI 在各自排他控制租约下顺序通过；租约精确绑定一个 decoder socket generation，并发连接时任何非 owning legacy 写入都被显式拒绝且不扰动新 UI。
- health/status 包含 releaseRevision、sourceManifestSha256、protocolVersion、runtimeOwner、audioOwner、worker expected/reported artifact identity 与 mismatch、workerReady、queueDepth 和 render timing。

## 13. 分阶段迁移与回滚

### Phase 0：生产事实收编

- 拉取、映射和提交 Git-controlled 线上漂移，记录 external runtime input 指纹与不可重建边界；
- 修复测试入口；
- 清理凭证和旧身份；
- 增加 revision/status；
- 不改 8090 运行内容。

回滚：纯 Git 操作，无线上切换。

### Phase 1：加法协议与骨架

- 新建 Node runtime、WorldSession mailbox、RuntimeClient 和 PcmPlayer 骨架；
- Node 只在 localhost 临时端口提供新接口，8090 旧服务不变；
- 全局保持 `runtimeOwner=browser`，Node 不驱动生产 audio。

回滚：停止 localhost 候选进程；8090 无变化。

### Phase 2：确定性内核下沉

- 下沉 world、sequence、economy、harmony 和 mapping；
- shadow-run 对比，不驱动真实 audio；
- 候选新 UI 改读临时端口的服务端 snapshot 做 E2E；生产 UI 和生产 audio owner 均不切换。

回滚：停止 shadow/candidate；生产始终是 browser owner。

### Phase 3：Agent 下沉

- species/master 分离 provider；
- 加入有限并发、超时、熔断、过期结果丢弃和 policy fallback；
- 候选新 UI 停止访问 8081；生产 legacy 页直到原子切换前保持现状。

回滚：候选 runtime 关闭远端 provider，继续 shadow 规则 policy；生产无变化。

### Phase 4：潜空间下沉

- 后端接管关系投影、XY/PCA、平滑、接管和 preview；
- 候选 UI 漫游器改为纯视图/意图客户端；
- 仍只在临时端口验证，不形成“server world + legacy browser audio”的生产混合态。

回滚：关闭候选用户漫游写命令；生产无变化。

### Phase 5：音频编排收口与原子切换

- 引入单例 Python audio worker；
- 下沉音符计划、voice assignment、mix/EQ/reverb/mute/solo；
- 把现有 texture/Jungle sample-granular fallback 移入 worker；
- 完成 worker epoch、不可变 identity handshake、state.replace、PCM fan-out、legacy pre-mix split adapter、`audioOwner` 维护切换和压力门禁；worker identity mismatch 测试与 Audio WS v1 golden vector 是切换前硬门禁；
- 候选 release 在临时端口完整通过后，停止旧 8090 容器，由 Node runtime 原子接管 8090；
- 同一次切换把全局 `runtimeOwner` 改为 `server`，新 UI 改收最终 stereo PCM；禁止拆成 UI、world、audio 三次独立切换。

回滚：整体切回上一 release 的 Python 8090 + legacy browser owner。旧实现不能导入新共享世界 snapshot，因此本阶段回滚会显式重建世界；切换前保存新世界 snapshot 供再次前滚使用。不得只切 `/decoder` 而留下混合 owner。

### Phase 6：稳定与清理

- 保持 `runtimeOwner=server` 并完成发布后稳定性观察；
- 保留上一 release revision 和新 world snapshot；
- 一个成功发布周期后删除 browser runtime 和旧协议。

回滚：切回 Phase 5 上一个已验证的新架构 release；若必须退回 legacy release，按 Phase 5 的显式 world reset 规则执行。

## 14. 目录目标

建议逐步收敛到：

```text
mvp/
  src/
    main.js                 UI 装配
    runtime-client.js       JSON runtime client
    pcm-player.js           PCM AudioWorklet client
    renderer.js
    ui/

flock-voice-engine/
  runtime/                  Node control plane
    package.json
    src/
      api/
      domain/
      agents/
      latent/
      audio/
      world-session.js
  server/                   Python audio worker
    worker.py
    backends/
    voices.py
  client/                   旧协议兼容/诊断页
  deploy/
  docs/
```

领域代码迁移完成后，不允许在 `mvp/` 与 `runtime/` 保留两份可独立演进的业务实现。迁移期共享/复制必须带明确 owner、测试和删除期限。

## 15. 设计结论

本设计采用 strangler 方式重构系统所有权：保留现有 UI 和已验证领域行为，先收编生产事实，再让 Node 控制面逐步成为唯一权威运行时；Python 音源缩为单例、隔离的 realtime worker。最终浏览器只表达意图、显示服务端状态并播放服务端 PCM，潜空间漫游也由同一后端状态机管理。
