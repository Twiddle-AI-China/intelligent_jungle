# flock-voice-engine 共享施工简报

黑客松「生态系统音序器」的音源与候选 runtime 后端。动手前先读
[`docs/HANDOFF.md`](docs/HANDOFF.md) 和本简报；两者都只描述当前事实，不把历史
实验配置混入生产契约。

## 当前生产事实（2026-07-22 只读基线）

- 操作身份仅为 `yfhuang`，服务源码位于 `/srv/deploy/flock-voice-engine`，当前由
  Docker 容器监听 8090。
- 音频契约是 **44.1 kHz**、block **4096**、**pool 5**，行音色固定为
  `[bass,pad,lead,pluck,pad]`；pad 使用行 1/4，调用方必须读 `rowsBySpecies`，
  不能自行推导行号。
- 8081 是上游模型契约，模型名固定为 `bird_agent`；端口或模型名都不能在本项目中改。
- `mvp/` 是 canonical UI 源码；部署目录 `web/` 是 release 输出，不能手改成第二份源码。
- 当前浏览器仍拥有 world、agent、latent 与 audio orchestration。Node 后端权威 runtime
  尚未切生产；本分支只能把这一目标实现成候选源码，不能把它写成线上既成事实。
- Phase 0 不改线上内容。当前容器仍有 legacy UID/log mount 债务；下一次受控 release
  必须把 UID/GID、日志目录与 release revision 一起切换并验证。
- 候选树不再提供 `run.sh`/`sync.sh`。禁止用手工口令、交互脚本或文件级热覆盖绕过发布边界。

## 可重建边界

- Git-controlled 的 `web/src`、`server`、`deploy`、`web/_client` 可由
  `origin/beta@3cf686eb1dd2ed356594904e2f366805ae7dd11a` 重建；重构分支是
  `refactor/backend-owned-runtime`。
- `vendor` 当前只有冻结聚合 SHA
  `21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049`；
  三个来源均为 **revision unknown**，因此 vendor **不能由 Git 重建**。替换前必须固定
  可获取 revision 或受控 artifact。
- `web/runtime-config.js` 的内容不捕获、不进 Git；只用私有 **HMAC-SHA256** 证明
  Phase 0 前后未变。
- Phase 0 不宣称模型权重或宿主机 site-packages 可复现，它们都是受控环境输入。
- `flock-voice-engine/` 是 engine 代码与文档唯一 canonical tree；
  `spark-docs/flock-voice-engine/` 生成副本已经删除，不再双写。

## 系统边界

```text
浏览器（当前权威）
  world / agent / latent / audio orchestration
            │ legacy decoder WS
            ▼
8090 Docker flock-voice-engine
  sequencer / 固定 voice pool / 神经 decoder
            │ binary float32 PCM
            ▼
浏览器
  PCM 播放 / 声部总线 / EQ / reverb / master
```

这条图描述当前线上。目标架构会把 world、agent、latent 与音频规划迁到 Node
`flock-runtime`，浏览器最终只保留 UI、输入采集、接口调用与 PCM 播放；切换前必须继续
声明 `(runtimeOwner, audioOwner) = ("browser", "legacy")`。

## 模型与训练边界

- 生产后端是 `brave-voices`。bass/lead/pluck 使用 MidiBrave v2（256D
  `z_timbre`），pad 使用 TrajectoryBrave pad（8D 控制坐标 → 128D 声学轨迹）。
- checkpoint 位于 `/data/model_weights/midiBrave/`，只读。加载必须用 checkpoint
  自报 `config_hash` 与训练配置 SHA-256 精确匹配，不能靠文件名猜。
- 所有当前 checkpoint 都是 Phase 1（`discriminator_updates=0`）；不要把模型音质问题
  误判成服务分层问题。
- 协议层 MIDI note 范围固定为 31–95。velocity 训练档只有 `{50, 127}`：
  0.42→v50，0.68/1.0→v127 + 增益差分，禁止插值。
- 输出是 44.1 kHz mono float；客户端负责按目标 AudioContext 重采样与播放。

## 运行时硬约束

1. **voice pool 固定长度、行绑定。** batch 尺寸变化会重建跨块状态并中断所有声部；
   生产固定 pool 5，静音行用 `gate=0` 保持常驻。
2. **last-note-priority。** 每行同一时刻只有一个音，新音抢占旧音。
3. **服务端不做 master、混响、EQ 或昼夜宏。** 这些仍是浏览器播放链路的职责。
4. **浏览器不是权威 runtime 的最终归宿，但目前仍是生产 owner。** 在受控切换前，
   不得让 Node 和浏览器同时推进 world tick 或重复触发音频。

## 当前协议

- `GET /api/decoder-status`
- `WS /decoder?model=<id>`；上行 `control` / `note` / `noteOff` / `buffer`
- 下行 ready/telemetry JSON 与二进制交错 float32 PCM
- release 诊断字段：
  `releaseRevision`、`sourceManifestSha256`、`protocolFamily`、`protocolVersion`、
  `runtimeOwner`、`audioOwner`

六个 release 字段是候选源码契约；未重启的当前 8090 可能尚未返回它们，不能据此
误报线上异常。

## 目录纪律

```text
flock-voice-engine/
  server/            Python decoder 服务
  client/            legacy decoder 客户端
  deploy/            候选 operator contract
  docs/              协议、部署、交接与模型事实
  tests/             自动化契约
  tools/             只读检查与受控测试工具
mvp/                 canonical UI 源码
web/                 release builder 物化的部署输出
```

不要在项目根目录散落临时文件。权重、语料、渲染产物和私有 runtime config 一律不进
Git。所有服务器状态检查默认只读；任何生产发布、重启或凭据轮换都必须走后续受控流程。

## 代码风格

Python 3.12+，使用类型注解与中文注释；依赖保持克制。行为变化先写失败测试，再做最小
实现并跑全套相关回归。
