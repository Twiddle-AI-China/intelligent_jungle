# Latent Cosmos Synth 独立发行版设计

> 日期：2026-07-22  
> 状态：已确认  
> 首要验收平台：NVIDIA DGX Spark（aarch64、CUDA 13）

## 1. 背景

当前 `beta` 分支已经包含完整的 `mvp/` 浏览器应用和
`flock-voice-engine/server/` 服务端代码，但生产运行仍依赖服务器上的固定目录：

- `/srv/deploy/flock-voice-engine`：生产部署副本；
- `/data/model_weights/midiBrave`：四个实际加载的模型权重；
- `/usr/local/lib/python3.12/dist-packages`：DGX Spark 专用
  `torch==2.12.1+cu130` 与 CUDA 13 Python 依赖；
- 手工组装的 `web/`：`mvp/`、音源客户端和运行配置的部署快照。

此外，LLM Agent 目前由浏览器按部署地址直接接入，发行版需要同时支持本地与云端
OpenAI 兼容服务，且不能把云端密钥暴露给浏览器。

## 2. 目标

1. 公开源码仓库包含前端、音源后端、三套 vendor 源码、音色地图、音色标定和全部部署脚本。
2. 四个生产神经音源权重作为 GitHub Release assets 分发，不进入普通 Git 历史。
3. 在一台满足前置条件的全新 DGX Spark 上，执行以下三条命令即可完成部署与验收：

   ```bash
   ./scripts/setup.sh
   ./scripts/start.sh
   ./scripts/verify.sh
   ```

4. 所有项目文件都从仓库相对路径读取，不再依赖 `/srv/deploy` 或宿主机
   `/data/model_weights`。
5. 使用一个 `config/runtime.json` 在本地 LLM、云端 LLM 与纯规则模式间切换。
6. 云端密钥只由服务端从环境变量读取，不进入仓库、配置文件、日志或浏览器。
7. 普通开发机仍可运行前端与 WebAudio 回退，不要求具备 DGX 或模型权重。

## 3. 非目标

- 不把 9.7 GiB 的 `bird_agent` LLM 权重纳入本次发行版。
- 不承诺神经音源在 Windows、macOS 或任意 NVIDIA GPU 上获得生产性能。
- 不改变生态仿真、和声、映射或音色算法。
- 不把冻结的 `src/`、`research/`、`native/` 改造成当前产品运行路径。
- 不在本轮解决多用户同时演奏时的共享 GPU 争用问题。

## 4. 总体架构

```text
浏览器
  │ 同源 HTTP / WebSocket
  ▼
flock-voice-engine :8090
  ├─ /                         runtime/web 静态前端
  ├─ /decoder                  神经音频 WebSocket
  ├─ /healthz                  服务健康检查
  ├─ /api/decoder-status       音源模型与行映射自述
  ├─ /api/runtime-status       音源、配置与 Agent 降级状态
  └─ /api/agent/v1/*           OpenAI 兼容 Agent 代理
           ├─ local  → 本机 bird_agent 或其它兼容服务
           ├─ cloud  → 云端兼容服务，服务端注入密钥
           └─ rules  → 禁用网络 Agent，前端使用确定性规则
```

浏览器不直接持有上游 LLM 地址或密钥。前端只探测并调用同源
`/api/agent/v1`；后端根据 `config/runtime.json` 选择上游。

## 5. 发行目录

```text
mvp/                                当前前端源码
flock-voice-engine/
  server/                           aiohttp 服务端
  client/                           AudioWorklet 与 WebSocket 客户端
  vendor/
    midibrave/                      v1 兼容源码快照
    midibrave-v2/                   bass/lead/pluck 生产源码快照
    trajectorybrave/                pad 生产源码快照
  assets/timbre/
    voice_maps/                     生产音色地图
    voice_defaults/                 生产响度/默认 latent 标定
  model_weights/midiBrave/          setup 下载位置，不进 Git
    SHA256SUMS                      固定校验清单，进入 Git
  deploy/
    Dockerfile                      DGX Spark 生产镜像
config/
  runtime.json                      唯一运行配置，无密钥
  model-assets.json                 GitHub Release 文件名、URL、大小与 SHA-256
scripts/
  setup.sh                          环境检查、权重下载、web 组装、镜像构建
  start.sh                          启动并等待服务就绪
  stop.sh                           停止发行版容器
  status.sh                         查看健康和运行状态
  logs.sh                           查看容器日志
  verify.sh                         完整 DGX 发布验收
runtime/
  web/                              自动组装，不进 Git
```

`runtime/web/` 由以下内容确定性生成：

- `mvp/index.html`、`mvp/src/`、`mvp/eval/`、`mvp/assets/`；
- `flock-voice-engine/client/` → `runtime/web/_client/`；
- 根据后端同源代理生成的无密钥 `runtime-config.js`。

## 6. 模型制品

首个制品版本固定为 GitHub Release tag `neural-audio-v1`，包含：

| 文件 | 生产用途 | SHA-256 |
|---|---|---|
| `bass_latest.pt` | bass，MidiBrave v2 | `3b507d98d898022ac27175048094fb48b31f70aad77b9c452b69b3ed32a39165` |
| `lead_latest.pt` | melody/lead，MidiBrave v2 | `90d2b33316bbdcda7d1d35280f8c9c06a80b57499b7db26daef2c3ab587f10e9` |
| `pluck_latest.pt` | pluck 后端行，MidiBrave v2 | `7176c0a84fd179c70d669867f77b741a64237c27c90b782232b28bc1343ca0ab` |
| `trajectorybrave-pad-v1-step-035000.pt` | pad，TrajectoryBrave | `644bf99d2463af136e2819b780657d9502bbbb7b2f0f055a4a9c7da46c7f4b1b` |

`setup.sh` 使用 `curl -L -C -` 断点续传。下载到临时文件后先校验 SHA-256，
再原子移动到最终位置。URL 固定到具体 tag，不使用漂移的 `latest` 下载地址。
默认基地址固定为
`https://github.com/Twiddle-AI-China/Latent-Cosmos-Synth/releases/download/neural-audio-v1`。
环境变量 `LCS_MODEL_RELEASE_BASE_URL` 可覆盖默认 GitHub Release 基地址，用于镜像或
离线制品站，但不能绕过哈希校验。

## 7. 运行配置

`config/runtime.json` 是唯一需要编辑的运行配置。初始配置采用本地 Agent：

```json
{
  "http": {
    "host": "0.0.0.0",
    "port": 8090
  },
  "audio": {
    "backend": "brave-voices",
    "device": "cuda",
    "poolSize": 5,
    "blockSamples": 4096
  },
  "agent": {
    "mode": "local",
    "timeoutSeconds": 60,
    "local": {
      "baseUrl": "http://host.docker.internal:8081/v1",
      "model": "bird_agent"
    },
    "cloud": {
      "baseUrl": "",
      "model": "",
      "apiKeyEnv": "LCS_AGENT_API_KEY"
    }
  }
}
```

约束：

- `agent.mode` 只接受 `local`、`cloud`、`rules`；
- 只强制验证当前所选模式的配置段；未启用的 cloud 段允许保持空字符串；
- `cloud` 模式必须能从 `apiKeyEnv` 指定的环境变量读到非空值；
- local/cloud 模式被选中时，其 URL 必须是 `http` 或 `https`，模型名不能为空；
- `poolSize=5` 时后端 `rowsBySpecies.pad` 必须是 `[1,4]`；
- 未知字段、类型错误和不满足约束的组合在启动时直接报错；
- 配置或环境变量值不得完整写入日志。

## 8. Agent 代理

服务端新增轻量 OpenAI 兼容代理，至少提供：

- `GET /api/agent/v1/models`：探测当前 Agent 可用性；
- `POST /api/agent/v1/chat/completions`：转发结构化请求与响应；
- `GET /api/runtime-status`：返回当前模式、上游是否可达、最近降级原因，不返回密钥。

代理保留现有 `response_format=json_schema` 请求体，不改写生态 prompt 或 schema。
`local` 模式不添加 Authorization，除非以后配置显式声明需要；`cloud` 模式从环境变量
注入 `Bearer` 头。响应体按流式或非流式方式透传，限制请求体大小并设置超时。

上游不可达、超时、返回非法响应或结构化结果无效时，前端的现有 pipeline 保留纯规则
计划；世界仿真、渲染与发声不能等待 Agent 恢复。

## 9. Docker 与 DGX 约束

生产镜像继续采用已经实测的方案：

- 基础镜像 `python:3.12-slim-bookworm`；
- 宿主机 `/usr/local/lib/python3.12/dist-packages` 只读挂载到
  `/opt/host-site-packages`；
- 容器内额外安装 `aiohttp`、`pyyaml`、`scipy`、`soundfile`；
- 使用 `--gpus all`、`OMP_NUM_THREADS=16`、`--cpu-shares=262144`；
- 后端参数固定为 `brave-voices + cuda + pool 5 + block 4096`；
- server、vendor、assets、model_weights、runtime/web 均从仓库路径只读挂载；
- 添加 `host.docker.internal:host-gateway`，供本地 Agent 模式访问宿主机 8081。

脚本使用自身路径定位仓库根目录，禁止写死用户名、UID、`/srv/deploy` 或项目安装目录。
容器名、端口和镜像名可以由无密钥环境变量覆盖，默认分别为
`latent-cosmos-synth`、`8090`、`latent-cosmos-synth:local`。

## 10. 错误处理与安全

- 权重缺失或哈希不符：setup/start 失败，不启动神经后端。
- DGX 架构、Docker、NVIDIA Runtime、Torch 或 CUDA 检查失败：指出具体缺项并退出。
- 神经音源容器启动失败：输出最近日志，返回非零；浏览器运行期间断开仍保留
  WebAudio 回退。
- `/api/runtime-status` 明确区分 `neural` 与 `fallback`，避免安静降级造成误判。
- LLM 故障不终止仿真，只记录经过清洗的错误类别并切回规则层。
- 云端密钥缺失时拒绝进入 cloud 模式，禁止把密钥返回给浏览器或打印到日志。
- `.gitignore` 只忽略 `model_weights/midiBrave/*.pt`，显式保留并跟踪同目录的
  `SHA256SUMS`；`runtime/`、`.env` 与本地日志全部忽略。
- 生产必需的 `assets/timbre/voice_defaults/*.npy` 显式取消忽略并进入源码仓库；
  vendor 内的生成缓存、fixture 音频与 `__pycache__` 继续忽略并从发行树移除。
- vendor 进入公开仓库，并用 `THIRD_PARTY_NOTICES.md` 记录来源、快照日期、上游版本
  与用户确认的发布授权；不携带生成缓存、`__pycache__`、测试音频或训练产物。

## 11. 测试

### 11.1 普通 CI/开发机

- `npm run test:mvp`：现有前端测试全部通过；
- Python 后端单元测试与 `synth` 模式 HTTP/WS 冒烟；
- `runtime.json` 的 local/cloud/rules 正反例测试；
- 用假 OpenAI 服务测试代理、超时、流式转发、错误回退和密钥隔离；
- 用小型本地 HTTP 制品测试断点续传、错误哈希、重试和原子落盘；
- secret scan、`git diff --check`、vendor 来源清单和禁止产物检查。

### 11.2 DGX Spark 发布验收

`scripts/verify.sh` 必须验证：

1. 四个权重与 `SHA256SUMS` 完全一致；
2. `/healthz` 返回成功且 backend 为 `brave-voices`；
3. `poolSize=5`、`blockSamples=4096`、`rowsBySpecies.pad=[1,4]`；
4. `/`、`src/main.js`、`_client/voice-client.js`、
   `_client/pcm-player-worklet.js`、`runtime-config.js` 全部返回 200；
5. WebSocket 握手成功并收到非零的真实神经音频块；
6. local/cloud/rules 三种 Agent 模式的路由和规则回退符合配置；
7. 运行命令、容器挂载和生成产物均不依赖 `/srv/deploy` 或
   `/data/model_weights`。

压测不得直接在共享生产端口运行。发布验收只做单会话短冒烟；并发和长时间 soak
必须使用独立 staging 容器与端口。

## 12. 完成标准

在全新 DGX Spark 上，仅预装 Docker、NVIDIA Container Toolkit 和当前系统 Torch/CUDA
运行时；随后克隆公开仓库并执行 setup/start/verify。验收通过后，浏览器可从同一
8090 服务加载完整前端、连接生产神经音源，并按一个配置文件在本地 Agent、云端 Agent
和纯规则模式之间切换。仓库及脚本不依赖原生产服务器的用户目录或数据目录。
