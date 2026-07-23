# flock-voice-engine

生态系统音序器的神经音源后端，以及后端权威 runtime 的候选实现。运行环境是 DGX
Spark；本仓库保存源码与契约，权重、私有配置和渲染产物不进 Git。

## 当前线上与候选状态

当前生产仍是 legacy 分层：浏览器拥有 world、agent、latent、audio orchestration，
8090 只承担固定 voice pool、神经 decoder 与 PCM 流。Node 后端权威 runtime 尚未切
生产；在受控发布完成前，不能把候选实现描述成线上 owner。

当前生产事实如下：

- 操作身份仅 `yfhuang`，服务源码为 `/srv/deploy/flock-voice-engine`，Docker 监听 8090。
- 音频是 **44.1 kHz**、block **4096**、**pool 5**；固定行音色
  `[bass,pad,lead,pluck,pad]`，pad 行为 `[1,4]`。
- 8081 上游模型契约固定为 `bird_agent`，端口与模型名都不可由本项目修改。
- `mvp/` 是 canonical UI；部署 `web/` 是 release 输出，不能作为第二份源码手改。
- Phase 0 不改变 8090，不发布、不启动、不重启。当前容器仍有 legacy UID/log mount
  债务；下一次受控 release 必须同时切换 UID/GID、日志目录和 revision。
- 候选树已移除 `run.sh`/`sync.sh`，不接受手工口令、交互脚本或文件级热覆盖。

## 可重建边界

- Git-controlled 的 `web/src`、`server`、`deploy`、`web/_client` 可由
  `origin/beta@3cf686eb1dd2ed356594904e2f366805ae7dd11a` 重建；当前重构分支为
  `refactor/backend-owned-runtime`。
- `vendor` 是实际代码输入，但当前只冻结聚合 SHA
  `21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049`；
  三个来源均为 **revision unknown**，所以 vendor **不能由 Git 重建**。
- `web/runtime-config.js` 内容不捕获；只保留私有 **HMAC-SHA256** 前后证明。
- 模型权重与宿主机 site-packages 是环境输入，Phase 0 不声称它们可由仓库复现。
- `flock-voice-engine/` 是 engine 代码与文档唯一 canonical tree；生成的
  `spark-docs/flock-voice-engine/` 副本已经删除，不再双写。

## 当前架构

```text
浏览器（生产 owner）
  world / agent / latent / audio orchestration
                    │ legacy decoder WS
                    ▼
Spark :8090
  sequencer / pool 5 / neural decoder
                    │ float32 PCM
                    ▼
浏览器
  PCM 播放 / 分轨总线 / EQ / reverb / master
```

服务端当前只替换 engine 层，不重复浏览器已有的 master、混响、EQ 或昼夜宏。目标架构
会把 world、agent、latent 与音频规划迁入 Node `flock-runtime`；届时浏览器只保留 UI、
输入、接口调用和 PCM 播放，但这属于后续受控切换。

## 后端与训练边界

- 生产后端 `brave-voices`：bass/lead/pluck 使用 MidiBrave v2；pad 使用
  TrajectoryBrave pad。每轨有独立音色漫游地图。
- checkpoint 只读，加载依赖 checkpoint `config_hash` 与训练配置 SHA-256 精确匹配。
- 当前模型均为 Phase 1（`discriminator_updates=0`）。
- 协议 note 范围 31–95；velocity 只有 `{50, 127}` 两个训练档，禁止连续插值。
- voice pool 固定长度、行绑定，静音行保持 `gate=0`；动态改变 batch 会清空跨块状态。

## 目录

```text
server/
  app.py                    aiohttp：health/status/decoder WS
  config.py                 8090、44.1 kHz、4096 样本块
  voices.py                 固定 voice pool 与 last-note-priority
  backends/                 synth / brave / brave-voices / streaming
client/                     legacy decoder 浏览器客户端
deploy/                     候选 operator contract；不是 Phase 0 apply 工具
docs/                       HANDOFF / protocol / deploy / client integration
tests/                      机器契约与回归
tools/                      诊断、验收与构建辅助
../mvp/                     canonical UI 源码
../web/                     release builder 生成的部署输出
```

`web/_client` 发布自 `flock-voice-engine/client`，`web/src` 发布自 `mvp/src`；仓库根部
任何 stale `client` 都不参与 release。

## 接手与验证

先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)。它只给 Phase 0 可执行的只读 status/health
步骤，不提供生产 apply 或重启路径。

常用本地验证：

```bash
python -m pytest tests -q
python -m compileall -q server tools
```

release 诊断字段见 [`docs/protocol.md`](docs/protocol.md)：
`releaseRevision`、`sourceManifestSha256`、`protocolFamily`、`protocolVersion`、
`runtimeOwner`、`audioOwner`。这些是候选源码契约；当前未重启的 8090 可能尚未返回，
legacy client 行为不因此改变。
