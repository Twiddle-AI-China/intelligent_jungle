# MidiBrave Roamer

模型包驱动的神经潜空间乐器宿主。这里没有 Jungle 的树、鸟、species、Agent 或
Sequence；一个可演奏模型由 checkpoint、匹配配置、latent map、默认 latent 与校准共同定义。

当前是 monorepo 内的 extraction branch：复用已经验证过的 `flock-voice-engine` decoder
和浏览器 PCM client，先冻结独立产品协议。接口稳定并完成一次真实 GPU 试听后，再迁移到
独立私有仓库。

## 本地开发

本地默认使用程序合成后端验证页面、PCM、按键、XY 和自动漫游状态机，不冒充神经模型：

```bash
cd midibrave-roamer
npm test
npm run dev
```

打开 <http://127.0.0.1:8092/>。页面即使断开服务也会进入浏览器 WebAudio fallback。

## 模型包契约

`config/models.json` 是唯一模型清单。公开身份使用 `mbv2-a-*` 这类 model id；
`bass/lead/pad/pluck` 只暂存在 `compatibility` 中，用来接现有五行 decoder，不能成为新产品 API。

一个模型条目必须绑定：

- engine adapter；
- checkpoint 文件名、字节数和 SHA-256；
- checkpoint 对应的 config/hash；
- 该 checkpoint 自己生成的 latent map；
- 默认 latent/响度校准；
- extraction 阶段的 legacy row binding。

不同 checkpoint 的 XY/PCA 坐标系不可互换。页面显示归一化 `[-1,1]` 坐标，发送给当前
decoder 前按各地图 `scale` 恢复为模型原始坐标。

## Spark 部署形态

真实推理必须同时位于 Docker 和 SLURM `gpu` partition allocation 内。构建镜像本身不运行推理：

```bash
docker build -f midibrave-roamer/deploy/Dockerfile -t midibrave-roamer:local .
```

准备三个只读目录：

- vendor：`midibrave-v2/` 与 `trajectorybrave/`；
- calibration：四个 `voice_defaults/*.npy`；
- weights：`bass_latest.pt`、`lead_latest.pt`、`pluck_latest.pt`、
  `trajectorybrave-pad-v1-step-035000.pt`，逐个按 `models.json` 校验。

vendor 和 calibration 当前冻结在 `standalone-release`，可在 checkout 根目录物化到忽略区：

```bash
midibrave-roamer/scripts/materialize_source_assets.sh
```

提交前可独立检查整个模型包；神经服务启动时也会执行同一检查，缺文件或 hash 不符直接退出：

```bash
python3 midibrave-roamer/scripts/verify_assets.py \
  --manifest midibrave-roamer/config/models.json \
  --model-root /absolute/path/to/model_weights/midiBrave \
  --vendor-root midibrave-roamer/runtime/assets/vendor \
  --calibration-root midibrave-roamer/runtime/assets/calibration
```

然后从 Spark checkout 提交：

```bash
export MIDIBRAVE_ROAMER_ROOT=/absolute/path/to/intelligent_jungle
export MIDIBRAVE_VENDOR_ROOT=/absolute/path/to/verified/vendor
export MIDIBRAVE_MODEL_ROOT=/absolute/path/to/verified/model_weights/midiBrave
export MIDIBRAVE_CALIBRATION_ROOT=/absolute/path/to/verified/calibration
sbatch "$MIDIBRAVE_ROAMER_ROOT/midibrave-roamer/deploy/roamer.sbatch"
```

默认监听 8092，作为隔离实验服务；不占用当前 8090/18090 公开试用链路。停止使用
`scancel <job-id>`，容器随 SLURM job 退出并自动删除。

## 拆仓门槛

满足以下条件后再创建独立私有仓库：

1. 本地测试全绿；
2. Spark 上至少一个 MidiBrave v2 模型真实出声；
3. XY 全地图边界、持续音和切模型无爆音；
4. vendor revision/license 与权重下载来源补齐；
5. 移除 `compatibility.row`，由独立后端直接按 model id 加载单模型。
