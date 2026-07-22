# DGX Spark 独立部署

本文面向一台新的 NVIDIA DGX Spark。脚本只管理名为 `latent-cosmos-synth` 的容器，
不会停止、重命名或探测替代端口上的其他服务。

## 1. 前置条件

- Linux `aarch64`；
- Docker daemon，当前用户属于 `docker` 组，或具备免交互 `sudo docker`；
- NVIDIA Container Toolkit，`docker info` 中存在 `nvidia` runtime；
- 宿主 Python 3.12 的 `/usr/local/lib/python3.12/dist-packages` 包含可用的
  CUDA 13 PyTorch；
- `curl` 与可访问 GitHub Release 的网络。

`scripts/doctor.sh` 会逐项检查以上条件。DGX Spark 的 PyTorch 是 NVIDIA 针对 GB10
提供的构建，脚本只读挂载它；不要在镜像内用普通 PyPI wheel 替换。

## 2. 安装

```bash
git clone https://github.com/Twiddle-AI-China/intelligent_jungle.git
cd intelligent_jungle
./scripts/setup.sh
```

`setup.sh` 依次执行：

1. 检查架构、Docker、NVIDIA runtime 和 Torch/CUDA；
2. 从 `neural-audio-v1` Release 下载四个音源权重；
3. 按 `config/model-assets.json` 校验字节数与 SHA-256；
4. 组装 `runtime/web/`；
5. 构建轻量音源服务镜像。

下载支持 `curl -C -` 断点续传。使用内部镜像站时只覆盖基地址，哈希仍取仓库清单：

```bash
export LCS_MODEL_RELEASE_BASE_URL=https://mirror.your-domain.invalid/neural-audio-v1
./scripts/setup.sh
```

## 3. 启动与验收

先按需求配置 local、cloud 或 rules Agent，再运行：

```bash
./scripts/start.sh
./scripts/verify.sh
```

默认页面地址为 `http://<DGX地址>:8090/`。可以用 `LCS_HOST_PORT` 改宿主映射端口，
容器内服务仍固定使用 8090：

```bash
LCS_HOST_PORT=18090 ./scripts/start.sh
```

验收通过必须同时满足：

- `brave-voices` 已加载，未静默落到 synth；
- `poolSize=5`、`blockSamples=4096`、pad 行为 `[1,4]`；
- 页面、模块、AudioWorklet 与运行配置均返回 HTTP 200；
- WebSocket 收到有限且非零的 float32 PCM；
- 当前 Agent 模式的同源路由行为正确；
- 四个本地权重与发行清单一致。

## 4. 生命周期

```bash
./scripts/status.sh     # 容器与脱敏 runtime 状态
./scripts/logs.sh       # 跟随最近 100 行容器日志
./scripts/stop.sh       # 只移除本项目容器
```

修改 `config/runtime.json` 或 `.env` 后必须 stop/start；服务只在启动时读取配置。

## 5. 可覆盖项

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `LCS_CONTAINER_NAME` | `latent-cosmos-synth` | 本项目容器名 |
| `LCS_IMAGE` | `latent-cosmos-synth:local` | 镜像名 |
| `LCS_HOST_PORT` | `8090` | 宿主机页面/API 端口 |
| `LCS_HOST_SITE_PACKAGES` | `/usr/local/lib/python3.12/dist-packages` | DGX 系统 Torch 路径 |
| `LCS_MODEL_RELEASE_BASE_URL` | 清单中的 GitHub Release | 音源权重镜像地址 |
| `LCS_AGENT_API_KEY` | 无 | cloud 模式的服务端密钥 |

## 6. 故障定位

- doctor 报架构错误：当前机器只能运行普通前端/WebAudio 回退，不能验收生产音源。
- 权重哈希错误：删除报错的 `.part` 后重跑 setup；不要手工改清单哈希。
- 容器启动后退出：运行 `./scripts/logs.sh`；cloud 模式最常见原因是未设置密钥。
- local Agent 不可达：确认外部服务监听宿主 8081，而非只监听另一个容器的
  `127.0.0.1`。
- 页面能开但 verify 报 fallback：神经后端没有完整加载；严格发行模式不会把它
  当作成功。
