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

打开 <http://127.0.0.1:8092/>。独立宿主关闭浏览器合成 fallback：真实服务断开就无声，
避免试听时把模拟音误认成神经模型。

电脑键盘 `A W S E D F T G Y H U J K` 演奏一个八度，`Z/X` 降/升八度。外接 MIDI
键盘点击 `Enable MIDI` 授权后即可演奏；note on/off、通道、音高和力度直接进入当前模型，
力度会按模型训练边界量化为受支持的档位。支持 CC64 延音踏板、CC120/123 Panic；设备断开
会精准释放该设备留下的音符。

### 输入与漫游架构

宿主对当前模型提供 4 复音，发声输入和潜空间调制是两条独立控制链：

- MIDI、电脑键盘和手动 Hold 只竞争 gate、pitch、velocity；
- 画布、kNN 和 Auto Wander 只修改 `timbreXY/timbreK`；
- MIDI 与电脑键盘同优先级；最多保留最新 4 个音，第 5 个音抢占最早的声部，松开后恢复仍按住的旧音；
- 手动 Hold 低于现场键盘、高于 Auto Wander 的无输入预览音；
- Auto Wander 不会因 MIDI Note On/Off 停止，切模型时当前 held note 会迁移到新模型；
- 窗口失焦只释放电脑键盘，不能误伤仍在工作的硬件 MIDI。

四个复音行共享模型权重和同一条 XY/Auto Wander 音色轨迹，但各自保留独立的生成、
包络和 release 状态。因此可以一边开启 Auto Wander 自动移动音色，一边用 MIDI 键盘演奏和弦。Note 滑杆
只保存手动 Hold/预览音高，不会再被 MIDI 输入改写。

## 模型包契约

`config/models.json` 是唯一模型清单。公开身份使用 `mbv2-a-*` 这类 model id；
`bass/lead/pad/pluck` 只暂存在 `compatibility` 中，用来接现有十六行 decoder，不能成为新产品 API。

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

服务就绪后，在该 SLURM job 的容器内跑真权重四复音门禁（脚本会拒绝
synth 后端）：

```bash
python3 /app/midibrave-roamer/scripts/verify_polyphony.py --port 8092
```

默认监听 8092，作为隔离实验服务；不占用当前 8090/18090 公开试用链路。停止使用
`scancel <job-id>`，容器随 SLURM job 退出并自动删除。

## 拆仓门槛

满足以下条件后再创建独立私有仓库：

1. 本地测试全绿；
2. Spark 上至少一个 MidiBrave v2 模型真实出声；
3. XY 全地图边界、持续音和切模型无爆音；
4. vendor revision/license 与权重下载来源补齐；
5. 移除 `compatibility.polyphonyRows`，由独立后端直接按 model id 建立四复音声部。
