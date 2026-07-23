# 交接：从这里开始

状态截至 2026-07-22。本页把生产观察事实、候选源码边界和下一步分开写；Phase 0
不会改变线上 8090。

```bash
ssh -i D:/workspace/TwiddleATOM/.ssh/spark_yfhuang_rsa yfhuang@192.168.9.140
cd /srv/deploy/flock-voice-engine
docker compose version >/dev/null 2>&1 || docker version
bash deploy/docker-run.sh status
curl --noproxy '*' http://127.0.0.1:8090/healthz
```

以上五行仅做只读的身份、Docker、status 与 health 核对。Phase 0 严禁从本分支运行
`start` 或 `restart`，也不提供 apply、文件热同步、marker 伪造或直接覆盖 active tree
的替代步骤。

## 当前生产事实

| 项目 | 当前值 |
|---|---|
| 操作身份 | 仅 `yfhuang` |
| 服务源码 | `/srv/deploy/flock-voice-engine` |
| 进程 | Docker `flock-voice-engine`，监听 8090 |
| 音频 | **44.1 kHz**，block **4096**，**pool 5** |
| 行音色 | `[bass,pad,lead,pluck,pad]`；pad 行 `[1,4]` |
| 上游模型 | 8081，模型名 `bird_agent`；端口与模型名均为不可变契约 |
| UI 源码 | `mvp/` 是 canonical UI；`web/` 是 release 输出 |
| 当前 runtime owner | 浏览器 |
| 当前 audio owner | legacy decoder |

浏览器当前仍拥有 world、agent、latent 和 audio orchestration；8090 只承担固定 voice
pool、神经 decoder 与 PCM 流。Node 后端权威 runtime 尚未切生产。任何把 world tick
或 agent 调度写成“服务端已经接管”的叙述都不符合当前事实。

## Phase 0 边界

- 本阶段只稳定候选源码与机器契约，不同步、不应用、不启动、不重启当前 8090。
- 候选树不再提供 `run.sh`/`sync.sh`；禁止手工口令、交互脚本或文件级热覆盖。
- 当前容器仍有 legacy UID/log mount 债务。下一次受控 release 必须把动态 UID/GID、
  日志目录、release revision 与 source manifest 一起切换；不能只修其中一项。
- `deploy/docker-run.sh` 是候选 operator contract，不是 Phase 0 的线上 apply 入口。
- status/health 的 release 字段是候选源码能力；未重启的当前 8090 可能尚未返回这些字段。

## canonical 源码与发布来源

- `flock-voice-engine/` 是 engine 代码与文档唯一 canonical tree。
  `spark-docs/flock-voice-engine/` 生成副本已删除，不再双写。
- `mvp/` 是 UI 唯一源码；release builder 从 `mvp/src` 物化 `web/src`。
- `web/_client` 来自 `flock-voice-engine/client`。仓库根部 stale `client` 不参与发布。
- `web/` 只表示某一 release 的完整输出；不能在 active tree 内原地编辑。

## 可重建边界

- Git-controlled 的 `web/src`、`server`、`deploy`、`web/_client` 可由
  `origin/beta@3cf686eb1dd2ed356594904e2f366805ae7dd11a` 重建。
- 重构工作在 `refactor/backend-owned-runtime`；设计与计划分别位于
  `docs/superpowers/specs/2026-07-22-backend-owned-runtime-design.md` 和
  `docs/superpowers/plans/2026-07-22-production-baseline-reconciliation.md`。
- `vendor` 是实际运行代码输入，但现在只冻结聚合 SHA
  `21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049`；
  三个来源均为 **revision unknown**，所以 vendor **不能由 Git 重建**。替换前必须
  固定可获取 revision 或受控 artifact。
- `web/runtime-config.js` 内容不捕获、不进 Git；仅用私有 **HMAC-SHA256** 证明
  Phase 0 前后未变。
- 模型权重与宿主机 site-packages 是环境输入；本阶段不宣称它们可由仓库复现。

## release identity 契约

候选 release 必须同时携带 `.release-revision` 与
`.release-source-manifest.sha256`，并把相同身份暴露为
`releaseRevision` 与 `sourceManifestSha256`。两者只能同时已知，或同时为
`unknown`；不得出现一项已知、一项未知。

健康、状态与 ready 帧的六个诊断字段为：

- `releaseRevision`
- `sourceManifestSha256`
- `protocolFamily`
- `protocolVersion`
- `runtimeOwner`
- `audioOwner`

Phase 0–4 的候选默认仍是 `protocolFamily=legacy-decoder`、
`runtimeOwner=browser`、`audioOwner=legacy`。Node `flock-runtime` 成为权威 owner
只允许发生在 Phase 5 完整 release tree、成对 marker、原子切换和 endpoint identity
验证全部通过之后。

## 当前神经音源边界

- 生产后端是 `brave-voices`。bass/lead/pluck 使用 MidiBrave v2；pad 使用
  TrajectoryBrave pad。pad 两行共用模型权重、各自保留独立流式状态。
- checkpoint 位于 `/data/model_weights/midiBrave/`，只读；加载必须以 checkpoint
  自报 `config_hash` 与训练配置 SHA-256 精确匹配，不能靠文件名猜。
- 当前 checkpoint 均为 Phase 1（`discriminator_updates=0`）。
- 协议 note 范围是 31–95；velocity 训练档只有 `{50, 127}`，禁止连续插值。
- texture 没有对应生产 checkpoint，仍留在浏览器本地合成。

## 浏览器接入事实

- 页面必须通过安全上下文使用 AudioWorklet。经 SSH 隧道访问
  `http://localhost:8090/` 可以满足要求；裸局域网 HTTP 不满足。
- `voice-client.js` 在 AudioWorklet 不可用或 WS 中断时会静默回落到本地 WebAudio；
  页面正常不等于神经链路正在工作，应检查 client state。
- 干声回到浏览器后仍经过分轨总线、EQ、混响、昼夜宏和 master。服务端不重复这些层。
- 调用方从 `rowsBySpecies` 读取行绑定；不能硬编码 pad 行或根据音色数量猜 pool。

## 只读排障顺序

1. 先确认 status/health 可读，且请求绕过本地 HTTP 代理。
2. 再看 `/api/decoder-status` 的 `poolSize`、`blockSamples` 与 `rowsBySpecies` 是否符合
   当前契约。
3. 浏览器听到本地音色时，先查 secure context、client state 与 WS，再判断后端。
4. 卡顿时区分共享 GPU 突发争用、客户端 underrun 与新连接阻塞；Phase 0 不通过改端口、
   停未知容器或生产压测来“验证”。
5. endpoint identity 与候选 marker 不一致属于发布失败，不能在 active tree 上补文件。

## 已知架构债务

- 当前浏览器和 Python decoder 的职责边界使 world 状态、latent 规划与音频触发分散，
  这是本次 strangler refactor 要解决的核心问题。
- legacy decoder socket 需要连接租约；Node 接管后浏览器不得再建立第二条权威 decoder
  连接。
- 音频时间线必须有单调帧号、明确 discontinuity 和幂等控制屏障，避免重连后旧 PCM
  或旧控制越过新的 world epoch。
- Python 音频 worker 必须保持单例，Node 负责 control plane；不能把推理 worker 生命周期
  重新塞回浏览器。

## 下一步

1. 继续在 `refactor/backend-owned-runtime` 完成候选 runtime、音频 worker 边界与测试。
2. 保持 legacy client 行为不变，直到 server-owned runtime 的协议、恢复路径和验证门禁齐全。
3. Phase 5 才实现 staging release、完整 manifest、成对 marker、原子切换和受控回滚。
4. owner 授权后轮换历史凭据；文档只记录 secret 注入位置，不记录任何凭据值。

## 文档索引

| 文档 | 内容 |
|---|---|
| `protocol.md` | legacy decoder 协议与候选 release identity |
| `client-integration.md` | 浏览器 legacy client 接入与诊断 |
| `deploy.md` | Phase 0 发布边界、来源链与 Phase 5 候选契约 |
| `model-notes.md` | 模型条件、训练边界与已知音质限制 |
| `latent-map.md` | 当前音色地图与漫游约束 |
