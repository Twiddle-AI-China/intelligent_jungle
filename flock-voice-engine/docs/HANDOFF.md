# 交接：从这里开始

> 状态截至 2026-07-21。**v2 四音色（`brave-voices`）已切生产**，Spark:8090 跑的就是它，
> 每轨带独立音色漫游地图。本文是入口，不重复其它文档的内容，只说**现在在哪、下一步做什么、哪里有坑**。

## 一分钟接手

```bash
# 1) 打通到 Spark（Mac 直连会被本机代理拦，走 SSH 隧道最稳）
ssh -f -N -L 8090:127.0.0.1:8090 rolf@192.168.9.140

# 2) 页面
open http://localhost:8090/                      # 四棵树前端（mvp/）
open http://localhost:8090/_client/tracks.html   # 四轨独立漫游测试页（v2 主力验证页）
open http://localhost:8090/_client/map.html      # v1 音色地图（旧 brave 后端资产，仅参考）
open http://localhost:8090/_client/demo.html     # 协议自测台

# 3) 服务在容器里
ssh rolf@192.168.9.140 'cd /home/rolf/projects/flock-voice-engine && bash deploy/docker-run.sh status'
```

改服务端代码：改完 `scp` 到 `/home/rolf/projects/flock-voice-engine/server/` 然后
`bash deploy/docker-run.sh restart`。**不用 rebuild** —— `server/` 是挂载进容器的
（`vendor/` `assets/` `web/` 同理）。只有改依赖才需要 `docker-run.sh build`。

⚠️ **`assets/timbre/` 与 `web/assets/timbre/` 是两份独立拷贝**（aiohttp serve 的是后者，
不是符号链接）。新建/更新漫游地图后**两处都要放**，只放一处浏览器 fetch 不到。

## 现在能用的

| 能力 | 状态 |
|---|---|
| v2 四音色流式推理 | ✅ `brave-voices` 后端，bass/pad/lead/pluck 行固定绑定，256D z_timbre |
| 每轨独立音色漫游地图 | ✅ 44/31/45/42 个真实 preset 点，kNN k=4，XY 限速 20/秒，坐标系互相独立 |
| 四轨满载性能 | ✅ p50 33.87 / p95 38.68 / max 40.46 ms，硬截止 46.44 ms，0 超时块、0 underrun |
| 响度归一化 | ✅ 单点粗标定：bass×1.34 / pad×3.23 / lead×1.74 / pluck×6.0（pluck 顶到增益夹，值得后续关注） |
| tracks.html 四轨测试页 | ✅ 每轨自己的 XY 画布 + scale，从 ready 帧读 roam 配置，不写死 |
| 容器常驻 + 同源托管前端 | ✅ `--restart unless-stopped`，`deploy/docker-run.sh` 生效配置 = 块长 2048 + pool 4 + `OMP_NUM_THREADS=16` |
| v1 单声部全链路 | ✅ 保留作回归基线（`python -m server.backends.streaming` 自测仍用旧 checkpoint） |

## 下一步

### 0. 已修：音一到期就炸会话（2026-07-21 生产事故）

症状是「后端不稳定、一直掉回本地 WebAudio 单音」。根因：v2 随机激励缓冲只按
「声明时长 + 8192 采样余量」生成，而自然到期的音还要按 `release_seconds`（0.40 s
≈ 17,640 采样）边衰减边渲染 —— release 中段切片越界，`excitation_bands` 形状
不匹配，RuntimeError 把整条 WS 打死。hold/gate 起音还用 stale duration（1.0 s），
按住 ~1.2 s 同样炸。四层修复：① `excitation_bands` 越界重复末帧补齐（冻结噪声
包络）；② `prepare_note_stochastic` 时长含 release；③ gate 起音按
`GATE_NOTE_BUFFER_SECONDS`（30 s）备缓冲；④ app.py 渲染异常改发零块不杀连接
（连续 200 次才放弃）。回归：`tools/test_note_expiry.py`（unit / ws 两段）。

同日第二刀（缓冲深度）：用户实测四轨漫游时渲染毛刺（47–52 ms）会超过
46.44 ms 块预算，136 ms 缓冲目标（`TARGET_FRAMES=6000`）被连续毛刺磨穿、
客户端 underrun 不止（听感：切音/断响）。已提到 11000 帧（250 ms，
`HIGH_WATER_FRAMES` 同步 12288→16384），端到端 ~230–280 ms 仍在预算内。
**渲染贴着预算跑的服务，缓冲目标不能只按「调度抖动」设计，要按
「连续 N 个毛刺块」设计。**

### 1. texture 音色接入（等 checkpoint）

`pendingVoices: ["texture"]` —— 训练配置已齐，jyhu 的 checkpoint 还没交付
（`/data/model_weights/midiBrave/handoff/` 目录已建、目前为空）。到货后按
「v2 接入的坑」一节的清单走：config_hash 比对 → strict-load → 单块整段对比 →
分块矩阵 → 端到端 → 建漫游地图 → 双处部署。

### 2. Phase 2 对抗微调的决定性 A/B（音质根因，仍未做）

**v2 四个 checkpoint 同样 `discriminator_updates=0`（Phase 1）** —— 「正弦感+噪声」的
塑料质感根因判断不变。做任何架构改动前，先把模型输出与**同一 preset 的原始渲染**做 A/B
（v1 素材在 Octopus `/data/midibrave/evaluation`，v2 对应 top50 manifest 的原始音频）。
若原始丰富、重建塑料 → 坐实 Phase 1；若原始也平淡 → 回头查 CLAP。

Phase 2 训练不在本仓范围内（模型侧）。新 checkpoint 落地后加载校验要跟上：
v2 靠 checkpoint 自报 `config_hash` 与训练配置文件 sha256 精确匹配，别靠文件名猜。

## 四声部性能：旧结论已被实测推翻（别再按它重构）

~~「必须把 4 路合成一次 forward」~~ **已否掉**。实测 batch 1/2/4 = 71.47/139.42/276.43 ms，
每声部摊薄只有 3% —— 是算术瓶颈不是固定成本瓶颈。把跨块状态沿 batch 维拼接的重构
（`streaming-design.md` §3）**高风险换 3%，取消**。

**真瓶颈是线程数。** 生效配置 `OMP_NUM_THREADS=16`（在 `deploy/docker-run.sh`）：

| OMP 线程 | 四轨满载 p95 | max | 结论 |
|---|---|---|---|
| 8 | 55.8–65.4 ms | 69–122 ms | 每次都超硬截止 |
| 16 | 37.1–38.4 ms | 40–42 ms | 每次都过，抖动塌掉 |

机器 20 核只给 8 线程，还要跟 8081/8083 两个 LLM 抢调度，尾部就炸。
~~4096 块长~~也否掉了：能过但延迟翻倍（93 ms/块），16 线程下反而更慢。

**整机饱和时再好的配置也没用（2026-07-21 实测）**：肖玮圣的 Dim-B 特征提取
一度开 ~18 个 `extract_features_v2.py` worker（每个 ~20 线程），load 87（20 核）、
us=100%。此状态下 4 轨渲染 p50 438 ms（预算 46.44），1 轨也要 111 ms ——
**这是机器被占满，不是服务退化**。队伍排干后同配置 0/83 超时块全 PASS。
报「变慢/卡顿」之前先 `uptime` + `vmstat 1 3` 看整机，别先改代码。

应对手段（已入 `deploy/docker-run.sh`）：`--cpu-shares=262144`（cgroup v2 下
≈ cpu.weight 10000，批处理任务默认 100 —— 争用时音频容器拿绝对优先，
我们空闲时批处理照样用满整机）。注意 **`OMP_WAIT_POLICY=PASSIVE` 是反优化，
别加**：流式渲染每块有大量小并行区，被动等待的唤醒延迟把 p50 从 ~34 ms
拖到 128 ms（同机同负载实测）。默认 ACTIVE 自旋才对。

**2026-07-21 机器排空后复测（与 07-20 一致，确认无回归）**：pool 4 × 2048
p50 34.11 / p95 37.57；stress_pool4 0/83 超时块；smoke 8/8 PASS；
test_note_expiry unit+ws 全 PASS。同一台机器争用时 pool 4 曾测出 p50 303 ms
—— 负载能造成 ~9 倍摆动，性能数字必须附带当时的整机负载才有意义。

**测并发必须用 `tools/stress_pool4.py`**，不能只用 `smoke_client.py`：后者曲目稀疏、
声部错开，而 `brave_voices.py` 对未激活 voice 是跳过的 —— pool=4 但只有 1 个在响时
成本等于 pool=1。孤立 microbenchmark（`tools/bench_compute.py`）不含服务层开销，
低估约 1.7×。

## v2 接入的坑（下次接 checkpoint 照这个清单走）

1. **训练配置靠 `config_hash` 精确匹配，不靠命名猜。** 四个 checkpoint 全部匹配到
   `configs/v2/generated_clap_recon_top50_100k/*_safe_fallback.yaml`（源码在 Octopus
   `/home/jyhu/MidiBrave-v2`，注意不是无后缀的 v1 目录）。文件 hash + checkpoint
   自报 hash 双重校验。
2. **「能 strict-load、能出声」≠行为正确。** v2 ModelConfig 比 v1 多 11 个字段，
   用 v1 vendor 代码加载 v2 checkpoint 会静默丢弃这些字段 —— 不报错、能出声、结果是错的。
3. **「新旧 checkpoint key 集合相同」是假阳性。** v2 的 `ResidualBlock` 多了
   `norm1`/`norm2` 两次 `ChannelRMSNorm`，但它们**无参数**，state_dict 里不留痕迹。
   `streaming.py` 必须用 `getattr(block,'norm1',None)` 条件应用。修复前 streaming vs
   offline 误差 0.2+，修复后全矩阵 ~1e-6。
4. **`stochastic_excitation` 只在 `decode()` 编排层**，streaming/backend 绕过它直调
   子模块，必须手动补（`prepare_note_stochastic()`）。`torch.randn(bands, N)` 对不同 N
   是独立 draw（行主序），所以必须在 note_on 时一次性生成整段随机缓冲（+8192 余量），
   流式按位置切片；**离线参考与流式测试必须共享同一个 buffer 对象**。
5. **漫游地图只用训练 manifest 里真实出现的 preset**（每音色恰好 50 个，CLAP 缓存里
   多出的 30 个是候选池残留，用了会漏出模型没见过的区域）。布局方法按每个音色自己
   实测：PCA 前二解释 ≥60% 才用 PCA（仅 pad 83.1% 符合），否则 t-SNE。
6. **验证模板**（每步独立可重跑，脚本都在 `tools/`）：`test_v2_load.py` →
   `test_v2_full.py`（块长矩阵）→ `test_multivoice.py` → `e2e_multivoice.py`（真实
   WS + split）→ `test_roam.py`（XY 必须渲出不同音频、漫游无 NaN/削顶）→
   `python -m server.backends.streaming`（v1 回归基线）。

## 环境与访问

| | |
|---|---|
| Spark | `ssh rolf@192.168.9.140` —— **公钥认证是通的**，不要用 `expect` 强制密码 |
| Octopus | `ssh -o ProxyJump=rolf@192.168.9.140 -p 2222 rolf@58.216.118.227`（Mac 直连超时） |
| 模型源码 | v1: Octopus `/home/jyhu/MidiBrave`；v2: `/home/jyhu/MidiBrave-v2`，**可直接读，不需要 sudo** |
| v2 checkpoint | Spark `/data/model_weights/midiBrave/{bass,pad,lead,pluck}_latest.pt`（只读，各 ~98 MB） |
| v1 checkpoint | 同目录 `midibrave-full-c9-phase1-step-000075365.pt`（回归基线用，别删） |
| v2 训练数据 | Octopus `/data/midibrave-v2/manifests/top50/{voice}.jsonl`（每音色 50 preset）+ `cache/top50/{voice}/clap/` |
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
| ~~`flock-voice-engine/`~~ | — | **已隔离为 `flock-voice-engine--stale-v1-do-not-edit/`**：worktree 建立前的 v1 残影，缺全部 v2 文件，别在里面改东西 |

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

**`vendor/` 不进 git**：`vendor/midibrave/`（v1）与 `vendor/midibrave-v2/` 都是
Spark 侧部署产物，别的机器上没有，重新部署要从 Octopus 源码重新抽。

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

## 地图资产的权威副本在 Spark

**v1 `assets/timbre/latent_map.json` 与 v2 `assets/timbre/voice_maps/*.json` 的
唯一权威副本都在 Spark。本地改之前必须先拉。**

它们有在 Spark 上生成、本地没有的产物：
* v1 逐点响度增益（`points[].gain`，`tools/calibrate_map_loudness.py` 跑 1239 次渲染）
* v2 每张地图的点响度（渲染参考音测 RMS）与 `voice_defaults/*.npy`（被 gitignore，只在 Spark）
* 换 checkpoint 后需要重建的一切

踩过的坑：本地拿一份**标定之前**的旧副本跑了 `build_pca_basis.py`，推回 Spark 时
把 1239 个点的响度标定整个冲掉了（日志里表现为「逐点响度 缺失」）。重跑标定才恢复。

另外 v2 的地图要**同时部署到 `assets/` 与 `web/assets/` 两处**（见「一分钟接手」）。

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
| `latent-map.md` | 二维音色地图：为什么 t-SNE 不用 PCA、为什么 kNN 不做反投影（v1；v2 每轨独立地图见 protocol.md §8.5） |
| `timbre.md` | z_timbre 塌陷证伪、锚点选取、漫游速率标定 |
| `protocol.md` | WS 协议全量字段（含 v2 漫游字段） |
| `client-integration.md` | 给前端的接入说明 |
| `deploy.md` | 部署、启停、排障 |
| `audit.md` | 验收工具的判据与门槛来源 |
