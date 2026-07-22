# Intelligent Jungle

> [!IMPORTANT]
> **预训练权重效果说明：**由于比赛时间限制，当前开放的预训练权重并没有取得很好的效果。
> 建议使用本仓库开源的训练代码，结合目标数据自行训练；当前权重更适合作为流程演示与训练基线，
> 不建议直接作为最终发行质量的依据。

一个可独立部署的生态系统音序器：二维森林同时是 16 步循环空间，鸟群的栖息、
迁徙、能量与季节变化驱动声音；本地或云端 LLM 只作生态决策，音乐结构由仿真
涌现。浏览器、实时神经音源和 Agent 代理统一由一个 `:8090` 服务提供。

## 发行边界

仓库包含完整前端、aiohttp 后端、三套生产神经音源源码依赖、音色地图、校准资源
和部署脚本。四个约 95–98 MiB 的神经音源权重由 `setup.sh` 从固定 GitHub Release
断点续传并校验，不进入 Git 历史。

vLLM 与通用 LLM 权重不包含在本仓库，也不会被 `setup.sh` 安装。它们是可选的外部
依赖：只要提供 OpenAI 兼容 `/v1` 端点，就能通过 `config/runtime.json` 接入。没有
LLM 或上游暂时离线时，生态仿真会继续运行并使用确定性规则。

## DGX Spark 开箱部署

生产神经音源的首要平台是 NVIDIA DGX Spark（aarch64、CUDA 13）。目标机需预先
安装 Docker、NVIDIA Container Toolkit，以及系统自带的 CUDA 13 PyTorch 3.12
运行时。克隆仓库后只需：

```bash
./scripts/setup.sh
./scripts/start.sh
./scripts/verify.sh
```

完成后打开 `http://<DGX地址>:8090/`。`verify.sh` 会同时检查四个权重哈希、
`brave-voices`、生产块长/池大小、静态资源、Agent 路由和真实非零 PCM。

常用运维命令：

```bash
./scripts/status.sh
./scripts/logs.sh
./scripts/stop.sh
```

完整前置条件、镜像下载和故障处理见 [部署手册](docs/deployment.md)。

## 切换 Agent

唯一需要编辑的运行配置是 [`config/runtime.json`](config/runtime.json)。

- `local`：连接外部本地 OpenAI 兼容服务；默认地址是宿主机 `8081/v1`，模型名
  沿用当前契约 `bird_agent`。参见 [本地 LLM](docs/local-llm.md)。
- `cloud`：连接云端 OpenAI 兼容服务；密钥只从服务端环境变量读取。参见
  [云端 LLM](docs/cloud-llm.md)。
- `rules`：不发起任何 Agent 网络请求，完全使用确定性生态规则。

配置修改后执行：

```bash
./scripts/stop.sh
./scripts/start.sh
./scripts/verify.sh
```

浏览器始终只调用同源 `/api/agent/v1/*`，不会收到上游地址或密钥。

## 普通电脑运行前端

普通 Windows、macOS 或 Linux 开发机不要求 DGX、Docker 或模型权重。安装 Node.js
20+ 后运行：

```bash
npm run serve:mvp
```

打开 `http://localhost:4193/mvp/`。神经音源或 Agent 不可达时，页面自动使用
WebAudio 与确定性规则回退。

## 测试

```bash
npm run test:release
npm test
npm run test:mvp
```

`test:release` 覆盖发行树、秘密扫描、配置、Agent 代理、前端组装、权重安装器与
HTTP/WebSocket PCM 冒烟；后两条保留旧系统与当前 MVP 的完整回归。

## 目录

```text
config/                      唯一运行配置与权重制品清单
mvp/                         当前浏览器产品
flock-voice-engine/server/   音源、静态站点与 Agent 同源服务
flock-voice-engine/vendor/   生产神经音源源码快照
flock-voice-engine/assets/   音色地图与校准资源
scripts/                     setup/start/verify 与可测试的安装工具
runtime/                     本地生成的 web、日志（不进入 Git）
```

生态规则与设计背景仍以 [`docs/rebuild-plan.md`](docs/rebuild-plan.md) 和
[`docs/eco-incentive-design.md`](docs/eco-incentive-design.md) 为事实来源。第三方
源码快照与发布边界见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
