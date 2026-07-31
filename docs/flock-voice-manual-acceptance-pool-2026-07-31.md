# Flock Voice 人工验收需求池

> 建立日期：2026-07-31
> 工程基线：`rebuild@5f5f49c83eb0d0c95fc16c5e56b4778e02790b09`
> Owner：Zhang Jiangnan
> 状态：重构候选已部署到 Spark 供人工验收；正式 acceptance GREEN 仍待完成

## 1. 收口边界

本轮最初以 backend-owned runtime 的工程实现、自动化合同和 Spark 隔离工程预检完成为收口。
以下是收口当时的历史边界，已被下方“部署检查点”中的 owner 后续授权部分更新：

- 线上仍是 legacy/browser-owned runtime；
- 没有执行生产切换，也没有生产切换授权；
- 没有完成 operator listening；
- 没有执行最终 30 分钟、四客户端、七故障正式验收；
- 因此不能声明 Phase 5、Task 10 或 cutover gate 为 GREEN。

已经完成并保留的工程能力包括 backend-owned world/agent/latent/audio runtime、受限 fault
authority、四客户端 raw recorder、七故障 actuator、controller-owned capture/attestation、
acceptance v2、package/import 校验器和 owner-approved same-host Spark policy。Spark 工程候选曾
达到 `workerReady=true`、无 degraded、无近期 underrun；试听窗口无人签核后已按合同超时并
精确清理。本轮收口时未对 8081/8090 执行启动、停止、重启或替换。

### 1.1 2026-07-31 初始部署检查点（已被 1.2 取代）

Owner 随后明确授权停掉旧服务，并要求将重构版本部署到 Spark 供次日人工验收。当前真实状态：

- 最终 release 来自 `rebuild@5f5f49c83eb0d0c95fc16c5e56b4778e02790b09`；
- backend-owned runtime 和 audio worker 已在 Spark 启动，分别使用精确 image config
  `sha256:bdaec55d72a36c5747a651fbb7dd00c1af71a0a01be84a875b323c975783fa05` 和
  `sha256:45f7fae00730a868f4392bd1f76b14b9dfec2dbe288699bba96c36ef9a1ffe6f`；
- runtime 受现有安全合同限制，只监听 `127.0.0.1:18090`，人工验收通过 SSH tunnel 访问；
- 原 `flock-voice-engine` 已停止并保留为
  `flock-voice-engine-legacy-backup-20260731`，restart policy 已设为 `no`，8090 当前未监听；
- 8081 `vllm-step3vl-ct` 的 full container ID 前后均为
  `c2c67868a702d93d93c3fc1cd37736b68faea6ff5c2154181a5df54abd1cf19e`，未停止、重启或替换；
- 切换后 `/readyz` 连续返回 200，`workerReady=true`、worker identity 完全匹配、容器 restart
  count 为 0、近期 underrun 为 0；SSH tunnel 下首页返回 200；
- Spark 上的部署取证保存在 `/tmp/flock-deployment-20260731-5f5f49c/`。

该检查点是“部署供人工试用”，不是 operator listening 签核，也不是 Phase 5/Task 10/acceptance
GREEN。当前代码仍显式拒绝 `production` runtime profile，不得通过反向代理改写 Host/Origin
绕过这一安全边界。

### 1.2 2026-07-31 局域网/公网试用检查点

Owner 随后授权不再使用人工 SSH tunnel，允许直接开放局域网/公网试用入口。当前状态：

- 公网入口为 `https://flock.twiddle-ai.com.cn`，Cloudflare 代理 A 记录指向 Gilmour，源站 TLS
  由 Let's Encrypt 终止；办公室局域网直达入口为 `http://192.168.9.140:18090`；
- Gilmour 只在 loopback 暴露反向通道，Spark 使用受限专用 Ed25519 key 建立
  `Gilmour 127.0.0.1:18090 -> Spark LAN gateway 127.0.0.1:18090 -> runtime 8090`；key 只允许
  该 `permitlisten`；公网和局域网因此共享同一个 4 席闸门；
- Gilmour 本地提供 production graph 收敛出的 UI 静态文件和运行时动态加载的 audio worklet，
  API/WS 才进入反向通道；Spark 另有独立 LAN proxy 投影固定 Host/Origin 并清除 forwarded
  headers，不需要人工 SSH tunnel；
- runtime 已启用固定 `production` profile，Phase 5 capture/fault authority 在该 profile 下不创建，
  普通浏览器不再需要验收专用 capability；
- Chromium 从局域网入口完成真实页面进入，状态为 `server runtime ready`，控制台 0 error；
  公网域名已验证首页、bootstrap 200 和 runtime WebSocket 101/双向 frame，但当前测试网络
  经海外 Cloudflare POP 时仍出现大 PNG HTTP/2 重传和首轮状态收敛过慢，明日人工验收应优先
  使用局域网入口；不得把公网链路标成已人工验收；
- nginx 暂时限制最多 4 条并发 audio WebSocket，第 5 条实测返回 503；该保护阈值不是完整
  排队系统，也不是容量结论；
- 当前计算是单 GPU worker 生成一份共享 PCM，新增听众主要增加 Node fan-out 与约
  2.82 Mbps/人的公网带宽；尚未完成容量压测，不能声明真实最大并发；
- 公网接入调试期间 audio worker 曾两次记录 `AUDIO_WORKER_THREAD_FAILED` 并由容器自动恢复；
  当前 `workerReady=true`、runtime restart count 为 0、audio restart count 为 2。四席握手和
  第五席 503 只证明闸门行为，不证明四席长期稳定，FV-MA-01 必须观察是否再次恢复；
- 原 legacy rollback 容器已按 owner 的清理要求删除。8081 未停止、重启或替换。

该检查点仍只是次日人工试用入口，不构成 FV-MA-01、正式 30 分钟 acceptance 或 cutover
GREEN。当前 runtime 使用已验收镜像加受控 production-profile source overlay；下一次正式
release 必须把这些 source 重新绑定到新的 source manifest、production graph 和 image identity，
不得把 overlay 当作正式签名 release。

## 2. 需求池

### FV-MA-01：候选人工试听

- 优先级：P0（正式 acceptance GREEN 的前置条件）
- 执行人：Zhang Jiangnan 或 owner 明确指定的听感验收人
- 环境：Spark 上已部署的重构候选；办公室优先访问 `http://192.168.9.140:18090`，公网可访问
  `https://flock.twiddle-ai.com.cn`；两条入口均投影到固定 production Origin，不需要人工 SSH
  tunnel
- 操作：持续试听至少 1–2 分钟，覆盖 bass、pad、lead、pluck 四种 species，并观察正常状态
  变化
- 通过标准：四种 species 均可听见；无爆音/咔嗒声；无卡顿、异常停播或明显声像错误
- 失败处理：记录时间点、species、操作和听感；不得生成通过 checklist；返回工程池修复
- 证据：由 operator 明确确认后生成 canonical `listening-checklist.json`，至少包含
  `completed=true`、`allSpeciesAudible=true`、`noClicks=true`、`noStalls=true` 和 operator
  身份

### FV-MA-02：批准正式 30 分钟验收窗口

- 优先级：P0
- 执行人：Owner
- 授权范围：仅授权 Phase 5 验收和对现有 8081 的 normal/burst 请求；不得停止、重启或替换
  8081。旧 8090 的停服授权已单独执行，不等于正式 acceptance GREEN
- 前置条件：
  1. `rebuild` 冻结到唯一最终提交；
  2. 最后一次完整 Python、Node、compileall 门禁通过；
  3. 使用最终提交和受控 44.1 kHz PCM forest 输入只构建一次正式 release；
  4. FV-MA-01 已通过；
  5. 验收前记录生产容器 full ID、restartCount、health、ports 和状态摘要
- 证据：owner-approved `staging-equivalence.json` v2，必须固定
  `kind=owner-approved-production-spark` 和 `productionCutoverAuthorized=false`

### FV-MA-03：旁站正式 Phase 5 验收

- 优先级：P0
- 时长：连续 30 分钟
- 自动化范围：四客户端、client 4 slow、七类真实故障、35 个 signed events、14 个固定
  action receipts、真实 8081 `bird_agent` normal+burst 共载、四客户端 decoded raw
  observations 和最后 30 秒稳定尾窗
- 人工职责：确认验收窗口与授权一致；不向 candidate 注入计划外操作；发现生产异常时立即
  中止验收，不执行 cutover
- 通过标准：controller 生成的 staging attestation、summary v2 和 acceptance v2 全部通过
  独立重算与 schema 校验，且生产边界前后不变
- 证据：完整 run-scoped evidence bundle、acceptance v2、生产 before/after boundary record

### FV-MA-04：审核 release package/import 结果

- 优先级：P0
- 前置条件：FV-MA-03 通过
- 自动化范围：对唯一 accepted release 执行 package，随后在隔离目标执行 import validator；
  不部署到生产
- 人工审核：release revision、source manifest、production graph、image identity、acceptance
  identity 和导入结果必须属于同一 exact tuple
- 通过标准：package/import validator 全绿，无缺失 member、重绑定、摘要不一致或额外文件
- 证据：package/import 日志、最终 inventory 和摘要

### FV-MA-05：最终对外服务决策

- 优先级：P1，独立于本轮重构和 Phase 5 隔离验收
- 当前状态：已授权停用旧服务并部署重构候选供试用；局域网和公网试用入口已建立，正式
  acceptance GREEN 和长期运行方式仍待决策
- 前置条件：FV-MA-01 至 FV-MA-04 全部通过，并另行形成切换窗口、回滚负责人、监控指标和
  明确书面授权
- 约束：不得把 `owner-approved-production-spark` 验收授权解释为 cutover 授权
- 通过标准：人工验收后由 owner 决定继续保持当前入口、替换公网反向通道，或回滚 legacy；
  不得把当前候选健康状态冒充正式 acceptance GREEN

### FV-MA-06：公网容量与等待队列

- 优先级：P0（扩大公开访问前）
- 当前保护：最多 4 条并发 audio WebSocket；超额请求返回 503，bootstrap 入口另有速率缓冲
- 必须实现：服务端原子席位租约、按到达顺序的等待队列、可见的排队名次/预计等待、断线
  自动释放、页面关闭清理、心跳超时、自动入场，以及 runtime/audio 两条 WebSocket 的同一
  用户绑定；不得依赖 IP 作为用户身份
- 容量验证：分别测 1/2/4/8/16 个监听客户端，记录 Gilmour 出口、Node RSS/CPU、音频
  writer queue、断流/重连、Spark render P95/P99 和 underrun；依据结果确定正式席位数
- 通过标准：超额用户只能进入等待室；活跃用户不因排队者变慢；席位释放后队首只入场一次；
  慢客户端仍按现有 bounded egress 合同单独熔断

## 3. 恢复执行顺序

未来恢复时只执行一条冻结流水线：

1. 完成 FV-MA-01；
2. 冻结最终提交并跑一次完整门禁；
3. 只重建一次正式 release；
4. 获得 FV-MA-02 授权；
5. 执行一次 FV-MA-03 正式验收；
6. 执行一次 FV-MA-04 package/import；
7. 复核部署边界并决定保留候选或执行精确回滚；
8. 如需提供对外 8090，另行实现并验证受控 profile，不绕过现有 Origin 合同。

不得把工程预检、健康接口、聚焦测试、模拟时钟 soak 或无人签核的试听窗口替代上述人工
验收证据。

## 4. 本轮关闭说明

本轮 goal 按“工程重构与可执行验收能力交付”完成。随后执行的 Spark 部署更新了运行状态，
但 FV-MA-01 至 FV-MA-04 仍未通过；关闭 goal 和当前健康检查均不构成正式验收声明。
