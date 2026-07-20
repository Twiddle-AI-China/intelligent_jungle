# 交接：从这里开始

> 状态截至 2026-07-20 05:00。V1 已跑通并在 Spark 上以容器常驻。
> 本文是入口，不重复其它文档的内容，只说**现在在哪、下一步做什么、哪里有坑**。

## 一分钟接手

```bash
# 1) 打通到 Spark（Mac 直连会被本机代理拦，走 SSH 隧道最稳）
ssh -f -N -L 8090:127.0.0.1:8090 rolf@192.168.9.140

# 2) 页面
open http://localhost:8090/                      # 四棵树前端（mvp/）
open http://localhost:8090/_client/map.html      # 音色地图（riso 美学，全屏）
open http://localhost:8090/_client/demo.html     # 协议自测台

# 3) 服务在容器里
ssh rolf@192.168.9.140 'cd /home/rolf/projects/flock-voice-engine && bash deploy/docker-run.sh status'
```

改服务端代码：改完 `scp` 到 `/home/rolf/projects/flock-voice-engine/server/` 然后
`bash deploy/docker-run.sh restart`。**不用 rebuild** —— `server/` 是挂载进容器的
（`vendor/` `assets/` `web/` 同理）。只有改依赖才需要 `docker-run.sh build`。

## 现在能用的

| 能力 | 状态 |
|---|---|
| midiBrave 流式实时推理（单声部） | ✅ 逐样本与离线一致（6.9e-07），块长无关 |
| 性能 | ✅ p50 10.29 ms / p95 16.77 ms，预算 23.22 ms |
| 音色漫游（9 锚点） | ✅ 限速 0.8/音符事件，走完一对 4–6 秒 |
| 音色地图 XY 直控（1239 preset） | ✅ kNN 混合，限速 20/秒（直接操纵要即时） |
| 响度归一化 | ✅ 离线逐点 K 加权标定，42.6 dB → 9.6 dB |
| 容器常驻 + 同源托管前端 | ✅ 442.9 MiB，`--restart unless-stopped` |
| 前端接入（pad 声部走神经音源） | ✅ 其余三树静音 |

## 下一步：Phase 2 对抗微调（**当前最高优先级**）

**音质问题的根因已经定位：checkpoint 是 Phase 1，`discriminator_updates = 0`。**

方案A 文档里 Phase 2 是 250k step 的 RAVE 式对抗微调（多尺度 Discriminator +
hinge adversarial + feature matching），**一步没跑**。RAVE 系模型在 GAN 微调之前，
输出就是「正弦感 + 噪声」的塑料质感 —— MR-STFT 只约束幅度谱，不约束相位和精细纹理。
这与实听描述完全吻合。

排除掉的另一个假设：曾怀疑 stock CLAP 的语义空间不适合做音色编码
（这正是 TimbreCLAP 的立项理由）。但九个锚点的谱质心跨度 1029–8811 Hz、
logmel 距离最大 70.7 —— **音色是分得开的**，不支持「CLAP 把一切压成一团」。
CLAP 的局限仍然真实（z 有效维度仅 2.6/128），但它不是当前音质的主因。

> 还缺一个决定性证据没做：把模型输出与**同一 preset 的原始 Serum 渲染**做 A/B。
> 素材在 Octopus `/data/midibrave/evaluation`（dashboard 那 24 组是 target/recon 配对）。
> 若原始丰富、重建塑料 → 坐实 Phase 1；若原始也平淡 → 回头查 CLAP。
> **做架构改动之前应该先跑这个。**

Phase 2 训练不在本仓范围内（模型侧），但推理这边要准备：
新 checkpoint 落地后，`server/backends/midibrave_backend.py` 的
`EXPECTED_CONFIG_SHA256` / `EXPECTED_MANIFEST_SHA256` / `EXPECTED_TENSOR_COUNT`
要更新，否则加载会（正确地）拒绝。

## 之后：四声部

**串行前向超预算 2.6 倍**，实测：

| pool | p50 | p95 | 预算 23.22 ms |
|---|---|---|---|
| 1 | 10.29 ms | 16.77 ms | ✅ |
| 2 | 19.20 ms | 33.11 ms | ✗ |
| 4 | 38.78 ms | 60.60 ms | ✗ |

必须**把 4 路合成一次 forward**（模型 batch 维就是声部维）。`brave.py` 现在是
`for voice in voices: stream.render_block(...)` 的逐行串行。改造要点见
`streaming-design.md` §3「跨块状态清单」—— 每行的 cache 要沿 batch 维拼接，
forward 之后再拆回各行。

⚠️ **batch 尺寸一旦确定不能变**：跨块状态按 batch 尺寸分配，尺寸变化会重新分配并清零，
所有声部同时被打断。voice 池必须常驻固定长度，不发声的行带 `gate=0` 跟着跑。

⚠️ **性能测量必须在无其它模型进程时做。** 容器与 bench 进程各持一份模型时，
机器只剩 2 GB 空闲，p95 从 16.77 飙到 32.48（换页特征）。

## 环境与访问

| | |
|---|---|
| Spark | `ssh rolf@192.168.9.140` —— **公钥认证是通的**，不要用 `expect` 强制密码 |
| Octopus | `ssh -o ProxyJump=rolf@192.168.9.140 -p 2222 rolf@58.216.118.227`（Mac 直连超时） |
| 模型源码 | Octopus `/home/jyhu/MidiBrave`，**可直接读，不需要 sudo** |
| checkpoint | Spark `/data/model_weights/midiBrave/midibrave-full-c9-phase1-step-000075365.pt`（只读） |
| CLAP 缓存 | Octopus `/data/midibrave/cache/serum_strict_1822/clap`，110,409 条 512D |
| 代码 | Spark `/home/rolf/projects/flock-voice-engine/`，日志 `/home/rolf/logs/` |
| Git | 见下方「代码在哪个目录」—— **不在主 checkout 里** |

**踩过的连接坑**（都会伪装成「服务挂了」）：

* `expect` + 强制密码认证会触发 sshd 限速 —— 表现为连上、提示输密码、然后无限挂起。
* 本机 `HTTP_PROXY` 无 `NO_PROXY` 时，curl 访问内网/localhost 返回**代理的 502**。
  已在 `~/.zshrc` 补了 `NO_PROXY`，但新环境要重新配。
* `expect` 放到后台跑会吞掉输出（看起来像命令没执行）。要前台跑。
* 浏览器直连 `192.168.9.140:8090` 会被 Clash Verge 拦（实测 502），
  尽管它的规则里 `GEOIP,private → 全球直连`。**规则与实际行为不一致**，走隧道最稳。

## 代码在哪个目录（容易走错）

同一个仓库开了三个 worktree，`git status` 在哪个目录跑就看哪个分支：

| 目录 | 分支 | 说明 |
|---|---|---|
| `Latent-Cosmos-Synth/` | `codex/pitch-conditioned-brave` | 主 checkout，**本项目的代码不在这里** |
| **`flock-voice-engine-repo/`** | `feat/flock-voice-engine` → `feat/unconstrained-pca-roam` | **所有后端代码与前端 mvp/** |
| `four-trees-fe/` | de275a8（detached） | 前端只读参考副本 |

当初用 worktree 是因为要同时读 `codex/pitch-conditioned-brave` 的参考实现
（`realtime_server.py`、`pcm-player-worklet.js`），不想来回切分支。
代价就是容易在主 checkout 里跑 `git status` 然后看到「working tree clean」而困惑。

分支关系：

```
origin/main
  └─ feat/flock-voice-engine          V1 交付（已合入 origin/feat/four-trees 的前端）
       └─ feat/unconstrained-pca-roam 实验：去掉 kNN 约束，只在前 10 主成分里漫游
```

**尚未 push** —— `ROLFFFX` 对 `Twiddle-AI-China/Latent-Cosmos-Synth` 只有读权限
（`push: false`），需要管理员加 collaborator。

## `mvp/` 前端是快照，不跟随上游

本分支里的 `mvp/` 停在 `origin/feat/four-trees @ de275a8`，**刻意不跟随上游**。

我们在其上加了 102 行，只为把 pad 声部接到神经音源：

| 文件 | 改动 |
|---|---|
| `mvp/src/config.js` | 新增 `voiceEngine` 段（enabled / species / muteOthers / url / anchor / voice） |
| `mvp/src/audio.js` | `createAudioEngine` 内建神经桥；perch/unperch 派发加接管与静音分支；`scheduleBassArp` 入口拦截 |
| `mvp/src/main.js` | 暴露 `window.__audio` |
| `mvp/index.html` | 引入 `/_client/voice-client.js` |

**上游已经走远**：`de275a8` 之后有 6 个提交（截至 2026-07-20 是 `a7589ad`），
而且**我们改过的四个文件上游全动过** —— `audio.js` 改了 242 行，其中包含 pad 的
落位与音色。真要合并是一次实打实的冲突解决，不是自动合并。

所以：

* **不要**在本分支上 `git merge origin/feat/four-trees`，那会把后端工作淹没在前端冲突里。
* 前端的正确归宿是让上游自己接入 —— 服务端协议已经稳定并文档化
  （`protocol.md` / `client-integration.md`），`client/voice-client.js` 是现成的接入包。
* 本分支的 `mvp/` 只作为「后端能被真实前端驱动」的证明，不是前端的主线。

## `latent_map.json` 的权威副本在 Spark

**Spark 上的 `assets/timbre/latent_map.json` 是唯一权威副本。本地改之前必须先拉。**

它有两处是在 Spark 上生成、本地没有的：
* 逐点响度增益（`points[].gain`，`tools/calibrate_map_loudness.py` 跑 1239 次渲染）
* 换 checkpoint 后需要重建的一切

踩过的坑：本地拿一份**标定之前**的旧副本跑了 `build_pca_basis.py`，推回 Spark 时
把 1239 个点的响度标定整个冲掉了（日志里表现为「逐点响度 缺失」）。重跑标定才恢复。

## 本项目最值得记的一条经验

**「测量/配置出错」伪装成「产品出错」，本项目出现了六次。**

1. 漫游自测只跑 1.39 秒就断言「音色几乎没变」—— 实际连三分之一路程都没走完。
2. 端到端测试传 `durationSeconds:30` 被夹到上限 6 秒，第 12 秒静音、谱质心 0 Hz ——
   看起来像漫游把声音搞没了。
3. 用频谱余弦判断音色变化 —— 同一 midi 的谐波峰位置相同，余弦对此天然不敏感，指标选错。
4. 无头测试用 `--virtual-time-budget` 快进定时器 → 报「连接超时」，真实时间下完全正常。
5. 测试台的 WS 地址**硬编码**成局域网地址，页面走隧道、WS 走直连被代理拦 → 「一直连接断开」。
6. 为做干净基线停了容器，忘了重启 → 用户听到的是本地兜底合成 → 「完全没有漫游的感觉」。

**教训**：报「功能坏了」之前，先确认测量方式、配置来源、服务状态三件事。
尤其当症状是「完全没有效果」时 —— 那更像是链路断了，而不是效果太弱。

还有一类同源问题：**同一个概念在客户端与服务端各存一份，只改一边**。
音色名单（`TIMBRES` vs `timbrePresets`）和 kNN 的 k 都栽过。
凡是「名单/参数」在两侧都有副本的地方，改一边就要查另一边。

## 文档索引

| 文档 | 内容 |
|---|---|
| `model-notes.md` | 模型事实：条件接口、时间轴几何、训练边界、实测性能、已知问题 |
| `streaming-design.md` | 流式因果性审计、跨块状态清单、三个必踩准的坑、验收结果 |
| `latent-map.md` | 二维音色地图：为什么 t-SNE 不用 PCA、为什么 kNN 不做反投影 |
| `timbre.md` | z_timbre 塌陷证伪、锚点选取、漫游速率标定 |
| `protocol.md` | WS 协议全量字段 |
| `client-integration.md` | 给前端的接入说明 |
| `deploy.md` | 部署、启停、排障 |
| `audit.md` | 验收工具的判据与门槛来源 |
