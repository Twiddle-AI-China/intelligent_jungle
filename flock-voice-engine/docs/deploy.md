# flock-voice-engine Spark 部署契约

服务当前运行在 DGX Spark，由 `yfhuang` 观察，源码根为
`/srv/deploy/flock-voice-engine`，Docker 容器只监听 8090。

当前线上只读基线：

- 后端：`brave-voices`，device `cuda`
- 音频：44.1 kHz，block 4096，pool 5
- 行音色：`[bass,pad,lead,pluck,pad]`
- 静态前端：同一容器托管完整 `web/` release 输出
- 上游模型：8081 / `bird_agent`，不得改端口或模型名

本文只描述候选发布契约，不是生产操作手册。Phase 0 的当前 8090 不在本阶段重启。

## 1. Phase 0 发布边界

- Phase 0 只维护本地候选源码；候选尚未同步、应用、启动或重启生产。
- 当前没有 hot copy、文件级热同步或 apply 工具，也不提供向 active release 写文件、
  远程起停容器、伪造 marker 的命令。
- `deploy/docker-run.sh` 是候选 operator contract。只有后续发布器完成 staging、完整
  校验和原子切换后，才可由受控流程调度其变更动作。
- 候选 contract 只允许 `yfhuang` 直接访问 Docker；不得切换其他账号或用提权绕过。
- 当前容器仍有 legacy UID/log mount 债务。下一次受控 release 必须把动态 UID/GID、
  日志目录、revision 和 source manifest 一起切换，不能分批热修。

## 2. 生产 hot copy 的定位

当前 active hot copy 只作为 Phase 0 的**事实来源**：它用于生成只读 inventory、hash 与
reconstruction decision，不再作为开发源。候选代码只能来自 clean Git revision 和受控
artifact；不得把 active tree 中的文件随手拷回仓库后继续开发。

`flock-voice-engine/` 是 engine 代码与文档唯一 canonical tree。生成的
`spark-docs/flock-voice-engine/` 文档镜像已经删除，不再双写。

## 3. release 来源链

完整 release tree 必须按以下单向关系构建：

| release scope | canonical 来源 | 当前可重建性 |
|---|---|---|
| `web/src` | `mvp/src` | Git-controlled |
| `server` | `flock-voice-engine/server` | Git-controlled |
| `deploy` | `flock-voice-engine/deploy` | Git-controlled |
| `web/_client` | `flock-voice-engine/client` | Git-controlled |
| `vendor` | 三个受控上游来源 | 仅冻结聚合 SHA，revision unknown |
| `web/runtime-config.js` | 私有运行时注入 | 内容不捕获 |

仓库根部 stale `client` 不参与发布。`mvp/` 是 canonical UI；`web/` 只是 release 输出，
不能手改成第二份源码。

四个 Git-controlled scope 可由
`origin/beta@3cf686eb1dd2ed356594904e2f366805ae7dd11a` 重建。`vendor` 当前聚合 SHA 为
`21ad9124be2de72e56f3f96cee70dbcfe0617dfd57a86c934f22857219526049`；
三个来源均为 **revision unknown**，vendor **不能由 Git 重建**。任何替换都必须先固定
可获取 revision 或受控 artifact，再让 builder 验证内容。

`web/runtime-config.js` 不进 Git，不记录内容；只使用私有 **HMAC-SHA256** 证明
Phase 0 前后未变化。HMAC key 只能从私有 secret 注入位置提供，不能写入仓库、日志或
release manifest。

模型权重与宿主机 site-packages 同样是受控环境输入。Phase 0 不声称它们可由 Git 或
镜像独立复现。

## 4. 成对 release identity

每份受控 release 必须同时包含：

- `.release-revision`
- `.release-source-manifest.sha256`

两个 marker 必须**成对**生成、成对校验。服务 status/health/ready 返回的
`releaseRevision` 与 `sourceManifestSha256` 必须对应同一份 marker；两者只能同时为
已知值，或同时为 `unknown`。任何一项缺失、格式错误或与 endpoint 不一致，都使预检
fail closed。

同一 endpoint identity 还必须包含：

- `protocolFamily`
- `protocolVersion`
- `runtimeOwner`
- `audioOwner`

Phase 0–4 的候选值仍是 legacy decoder / browser runtime owner / legacy audio owner。
这些字段属于候选源码契约；当前未重启的 8090 可能还没有返回，不能据此声称生产已经
切到 Node。

## 5. 候选 operator contract

候选脚本固定以下约束：

- operator：`yfhuang`
- release 根：`/srv/deploy/flock-voice-engine`
- 容器内身份：运行时解析 operator 的动态 UID/GID
- 代码、vendor、assets、web：只读挂载
- 日志：release 根下受控日志目录，使用同一动态 UID/GID
- 端口：仅 8090
- 后端参数：`brave-voices` / `cuda` / block 4096 / pool 5
- status：只读，并校验 marker 与 endpoint identity

脚本可保留 build、start、status、logs、restart、stop 等动作名称作为未来 operator
contract，但本文件不提供变更动作的可执行 runbook。Phase 0 只允许 status/health
观察。

## 6. 只读基线核对

下面的请求不写 release tree，也不改变容器状态：

```bash
curl --noproxy '*' -s http://127.0.0.1:8090/healthz
curl --noproxy '*' -s http://127.0.0.1:8090/api/decoder-status
curl --noproxy '*' -s http://127.0.0.1:8090/api/load
```

检查 `poolSize=5`、`blockSamples=4096` 与 `rowsBySpecies.pad=[1,4]`。前端
`web/src/config.js` 的行绑定必须与 endpoint 完全一致；不一致会让浏览器向不存在的行
发音。

本机若设置 HTTP 代理，请保留 `--noproxy '*'`。代理返回的 502 不是服务 health 结果。

## 7. Phase 5 原子发布器

Phase 5 才引入 staging release 与原子切换，最小闭环为：

1. 从 clean HEAD 与受控 artifact 构建完整 release tree。
2. 物化 `web/src`、`server`、`deploy`、`web/_client`、vendor、assets 与私有 runtime
   config 注入点。
3. 生成 source manifest，并同时生成两个 release marker。
4. 在 staging 中校验所有来源、权限、runtime config HMAC 和候选 endpoint。
5. 原子切换 active release；禁止对子目录做局部覆盖。
6. 读取新 endpoint identity，确认 revision、manifest SHA 与六字段契约一致。
7. 任一步失败都保持或恢复上一份完整 active release。

builder 必须同时包含 `assets/timbre/` 和 `web/assets/timbre/`；aiohttp serve 的是后者，
两者不是可以事后在 active tree 补齐的同一个目录。

## 8. 容器与环境边界

Spark 是 aarch64 Grace Blackwell。候选镜像不自带另一套未经验证的 CUDA torch，而是
只读挂载宿主机已验证的 site-packages；因此镜像不能脱离这台受控宿主机独立复现。

神经 checkpoint 位于 `/data/model_weights/midiBrave/`，只读。容器使用 GPU，但这是
常驻低延迟服务，不属于训练或批推理队列。任何压测必须进入隔离 staging，不能用生产
8090 做压力实验。

## 9. 已知问题与诊断

| 现象 | 只读诊断 |
|---|---|
| health 请求得到 502 | 先确认是否走了本机 HTTP 代理，并使用 no-proxy 请求 |
| pad 某行无声 | 对比 `rowsBySpecies.pad` 与 UI config；当前应为 `[1,4]` |
| 间歇 underrun | 查看 `/api/load` 的 render 指标，区分共享 GPU 突发争用与客户端水位 |
| 新连接影响旧连接 | 记录事件循环阻塞与 worker 初始化；不要靠多开生产连接复现 |
| endpoint identity 不一致 | 视为发布失败；禁止在 active tree 上补 marker 或源码 |
| 端口被占用 | 8090 是硬契约；不要改端口、停未知进程或触碰其他用户容器 |

浏览器当前仍拥有 world/agent/latent/audio orchestration，Node 后端权威 runtime 尚未切
生产。部署门禁只证明候选 release 的身份与完整性，不会自行改变 runtime ownership。

<!-- phase5-managed-status:start -->
```json
{
  "production": "legacy",
  "status": "legacy-not-cut-over"
}
```
<!-- phase5-managed-status:end -->
