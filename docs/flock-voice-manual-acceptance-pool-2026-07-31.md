# Flock Voice 人工验收需求池

> 建立日期：2026-07-31
> 工程基线：`rebuild@d41904ef5f48eaa315af7760d31685325c113a3a`
> Owner：Zhang Jiangnan
> 状态：工程重构本轮收口；人工验收、正式 acceptance GREEN 与生产切换延期

## 1. 收口边界

本轮以 backend-owned runtime 的工程实现、自动化合同和 Spark 隔离工程预检完成为收口。
以下事实不随本轮 goal 收口而改变：

- 线上仍是 legacy/browser-owned runtime；
- 没有执行生产切换，也没有生产切换授权；
- 没有完成 operator listening；
- 没有执行最终 30 分钟、四客户端、七故障正式验收；
- 因此不能声明 Phase 5、Task 10 或 cutover gate 为 GREEN。

已经完成并保留的工程能力包括 backend-owned world/agent/latent/audio runtime、受限 fault
authority、四客户端 raw recorder、七故障 actuator、controller-owned capture/attestation、
acceptance v2、package/import 校验器和 owner-approved same-host Spark policy。Spark 工程候选曾
达到 `workerReady=true`、无 degraded、无近期 underrun；试听窗口无人签核后已按合同超时并
精确清理。本轮未对生产 8081/8090 执行启动、停止、重启或替换。

## 2. 需求池

### FV-MA-01：候选人工试听

- 优先级：P0（正式 acceptance GREEN 的前置条件）
- 执行人：Zhang Jiangnan 或 owner 明确指定的听感验收人
- 环境：Spark 上隔离 candidate，host-network 仅监听 `127.0.0.1:18090`，通过本机 SSH
  tunnel 访问；不得触碰生产 8090
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
- 授权范围：仅授权 Phase 5 隔离验收和对现有 8081 的 normal/burst 请求；不授权生产切换，
  不授权停止、重启或替换 8081/8090
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

### FV-MA-05：生产切换决策

- 优先级：P1，独立于本轮重构和 Phase 5 隔离验收
- 当前状态：未授权
- 前置条件：FV-MA-01 至 FV-MA-04 全部通过，并另行形成切换窗口、回滚负责人、监控指标和
  明确书面授权
- 约束：不得把 `owner-approved-production-spark` 验收授权解释为 cutover 授权
- 通过标准：由 owner 单独作出 GO/NO-GO；没有明确 GO 时保持 legacy/browser-owned runtime

## 3. 恢复执行顺序

未来恢复时只执行一条冻结流水线：

1. 完成 FV-MA-01；
2. 冻结最终提交并跑一次完整门禁；
3. 只重建一次正式 release；
4. 获得 FV-MA-02 授权；
5. 执行一次 FV-MA-03 正式验收；
6. 执行一次 FV-MA-04 package/import；
7. 精确清理候选资源并复核生产边界；
8. 如需上线，另开 FV-MA-05，不沿用验收授权。

不得把工程预检、健康接口、聚焦测试、模拟时钟 soak 或无人签核的试听窗口替代上述人工
验收证据。

## 4. 本轮关闭说明

本轮 goal 按“工程重构与可执行验收能力交付”完成。FV-MA-01 至 FV-MA-05 进入需求池，
不计为本轮已通过验收；关闭 goal 不改变生产状态，也不构成任何上线声明。
