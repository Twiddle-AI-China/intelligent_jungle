# 交接：从这里开始

> 状态截至 2026-07-21。**v2 四音色（`brave-voices`）已切生产、同日切到 GPU**，
> Spark:8090 跑的就是它，每轨带独立音色漫游地图。前端也在同日接通（单树 UI，
> bass/pad/melody 走神经、texture 仍本地）。本文是入口，不重复其它文档的内容，
> 只说**现在在哪、下一步做什么、哪里有坑**。
>
> **⚠️ 2026-07-22 后续（生产配置已变，本文下面的数字是当时历史记录）：**
> 为缓解和同机 vLLM 共享 GPU 时的实时卡顿，生产配置改成 **pool 7 → 5**
> （pad 和弦 4 行 `[1,4,5,6]` → 2 行 `[1,4]`）、**块长 2048 → 4096**
> （渲染硬截止 46.44 → 92.88 ms）、**8099 端口下线**。下文里所有 `pool 7`/
> `块 2048`/`46.44 ms 预算`/`pad 四行` 都是变更前的记录，**当前权威配置和
> 已知的 GPU 争用 / 并发卡顿问题看 `docs/deploy.md`（头部 + §9）**。

## 一分钟接手

```bash
# 1) 打通到 Spark（Mac 直连会被本机代理拦，走 SSH 隧道最稳）——
#    这一步不是可选的性能优化，是**硬要求**：AudioWorklet 需要 secure context，
#    localhost 天然满足、裸局域网 IP (http://192.168.9.140:8090/) 不满足。
#    裸 IP 打开页面不会报错，只是神经音源静默退回本地合成，容易误判成
#    「后端没接上」，见下方「mvp/ 前端接入」一节。
ssh -f -N -L 8090:127.0.0.1:8090 yfhuang@192.168.9.140

# 2) 页面（全部走 localhost，不要用 192.168.9.140）
open http://localhost:8090/                      # 单树前端（mvp/，2026-07-21 起）
open http://localhost:8090/_client/tracks.html   # 四轨独立漫游测试页（v2 主力验证页）
open http://localhost:8090/_client/map.html      # v1 音色地图（旧 brave 后端资产，仅参考）
open http://localhost:8090/_client/demo.html     # 协议自测台

# 3) 服务在容器里
ssh yfhuang@192.168.9.140 'cd /srv/deploy/flock-voice-engine && bash deploy/docker-run.sh status'
```

> Phase 0 只更新本地候选源码，尚未把新的 release/operator 契约同步或应用到生产。

完成后续受控发布后，服务端代码位于 `/srv/deploy/flock-voice-engine/server/`，再由
`bash deploy/docker-run.sh restart` 切换。**不用 rebuild** —— `server/` 是挂载进容器的
（`vendor/` `assets/` `web/` 同理）。只有改依赖才需要 `docker-run.sh build`。

⚠️ **`assets/timbre/` 与 `web/assets/timbre/` 是两份独立拷贝**（aiohttp serve 的是后者，
不是符号链接）。新建/更新漫游地图后**两处都要放**，只放一处浏览器 fetch 不到。

## 现在能用的

| 能力 | 状态 |
|---|---|
| 多引擎四音色流式推理 | ✅ `brave-voices` 后端；bass/lead/pluck 为 MidiBrave v2 256D z_timbre，pad 四行（1/4/5/6）为 TrajectoryBrave 8D 控制坐标 → 128D 声学轨迹 |
| pad 真和弦（2026-07-21 起） | ✅ 最多同时 4 个音，音高来自 `mapping.padVoicingAssignments`（当日和弦 + voice-leading，不是随便发的 MIDI），行分配见 `mvp/src/audio.js` 的 `neural.syncPadChord` |
| 潜空间漫游器弹窗（2026-07-21 起） | ✅ 接管声部后可打开，kNN/XY（安全）+ PCA 自由漫游（**不保证落在流形上**，见 protocol.md §8.5a）两种模式，视觉搬自 `client/map.html`；`mvp/src/ui/latent-roamer.js` |
| Agent 生态音色漫游 | ✅ bass/pad/melody 的可见 world 状态 → 8 个归一关系量 → 每声部固定投影 → 4 秒平滑 `timbreXY`/kNN；USER 接管暂停。Agent 不直接写 latent。texture/drums 完全不参与；见仓库 `docs/ecological-latent-control.md` |
| 每轨独立音色漫游地图 | ✅ 44/31/45/42 个真实 preset 点，kNN k=4，XY 限速 20/秒，坐标系互相独立 |
| 四轨满载性能（基线，不含 pad 和弦） | ✅ p50 33.87 / p95 38.68 / max 40.46 ms，硬截止 46.44 ms，0 超时块、0 underrun |
| 七行满载性能（含 pad 4 音和弦，跨行 CUDA stream 并行，2026-07-21 GPU 实测） | ✅ p50 30.16 / p95 33.83 ms，硬截止 46.44 ms，余量约 27%（并行前 p50/p95 36.78/37.49ms、余量约 19%——`render_split` 原来逐行 `.cpu()` 强制串行，改成各行发到自己的 stream、统一 synchronize 再拷回，音频输出数值不变，`tools/test_gpu_device.py` + 三个回归脚本验证过） |
| 响度归一化 | ✅ 单点粗标定：bass×1.34 / pad×3.23 / lead×1.74 / pluck×6.0（pluck 顶到增益夹，值得后续关注） |
| tracks.html 四轨测试页 | ✅ 每轨自己的 XY 画布 + scale，从 ready 帧读 roam 配置，不写死（不知道 pad 和弦增补行，仅供参考） |
| 容器常驻 + 同源托管前端 | ✅ `--restart unless-stopped`，`deploy/docker-run.sh` 生效配置 = 块长 2048 + pool 7 + `OMP_NUM_THREADS=16`（**当前已改为块长 4096 + pool 5，见 deploy.md**） |
| v1 单声部全链路 | ✅ 保留作回归基线（`python -m server.backends.streaming` 自测仍用旧 checkpoint） |
| GPU（2026-07-21 起） | ✅ `--device cuda`，四行基线 render p50/p95 17.8/22.3 ms（原 CPU 79.9/104.8 ms）；七行 + 跨行 stream 并行 p50/p95 30.16/33.83 ms，细节见 `docs/deploy.md` |
| `mvp/` 前端接入神经音源 | ✅ bass/pad/melody 三个物种（backend bass/pad/lead 行），texture 仍本地——真实浏览器会话验证过端到端，见下方「`mvp/` 前端接入」 |

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
| Spark | `ssh yfhuang@192.168.9.140` —— **公钥认证是通的**，不要用 `expect` 强制密码 |
| Octopus | `ssh -o ProxyJump=yfhuang@192.168.9.140 -p 2222 yfhuang@58.216.118.227`（Mac 直连超时） |
| 模型源码 | v1: Octopus `/home/jyhu/MidiBrave`；v2: `/home/jyhu/MidiBrave-v2`，**可直接读，不需要 sudo** |
| v2 checkpoint | Spark `/data/model_weights/midiBrave/{bass,pad,lead,pluck}_latest.pt`（只读，各 ~98 MB） |
| v1 checkpoint | 同目录 `midibrave-full-c9-phase1-step-000075365.pt`（回归基线用，别删） |
| v2 训练数据 | Octopus `/data/midibrave-v2/manifests/top50/{voice}.jsonl`（每音色 50 preset）+ `cache/top50/{voice}/clap/` |
| 代码 | Spark `/srv/deploy/flock-voice-engine/`，日志 `/srv/deploy/flock-voice-engine/logs/` |
| Git | 见下方「代码在哪个目录」—— **不在主 checkout 里** |

**踩过的连接坑**（都会伪装成「服务挂了」）：

* `expect` + 强制交互式口令认证会触发 sshd 限速 —— 表现为连上、提示输口令、然后无限挂起。
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

## `mvp/` 前端接入（2026-07-21 更新：拉到 single-tree-ui，重接神经桥）

`mvp/` 仍然是**快照，不跟随上游**——这条规矩没变，只是快照点往前挪了。

**旧状态**：停在 `origin/feat/four-trees @ de275a8`，只把 pad 一个声部接到 v1
`brave` 后端（102 行 patch）。

**现状**：整个 `mvp/` 用 `git checkout origin/feat/single-tree-ui -- mvp/` 整体
替换（不是 `git merge`——原因同以前：上游那几个文件改动太大，真合并是冲突
解决不是自动合并）。`feat/single-tree-ui` 恰好也是从 `de275a8` 分出去的，
带来了单树 UI、`mvp/src/ui/` 一整个新模块、生产贴图资产。旧的 102 行 patch
在新代码上重新写了一遍（不是照抄重放，新旧 `audio.js`/`config.js` 差异太大：
pad 从简单触发式变成聚合和弦、bass 从琶音变成节奏型 plan、multi-species 而不是
只有 pad），落在同样四个文件：

| 文件 | 改动 |
|---|---|
| `mvp/src/config.js` | `voiceEngine` 段改成按物种配置（`species: {bass:{row:0,...}, pad:{...}, melody:{...}}`），不再是单一 `species` 字段 |
| `mvp/src/audio.js` | 神经桥重写：分轨连接后把每条后端 voice 行的干声接进该物种自己的 `ensureSpeciesBus`（EQ/mute/solo/混响发送全套走本地链路，不是绕过去直怼 destination）；bass/melody 的节奏型/乐句 plan 用 `setTimeout` 逐音符转发；pad 用 `hold`/`release`（protocol.md §8.6）+ `neural.syncPadChord` 分配器把和弦分给最多 4 个后端行，同时发声，超过 4 音的部分落回本地 `refreshPadVoicing`（同日第二次更新，见下方「pad 真和弦」） |
| `mvp/src/main.js` | 暴露 `window.__audio`（不变） |
| `mvp/index.html` | 引入 `/_client/voice-client.js`（不变） |

**物种↔后端行的映射不是全部对上的**，这是接的时候发现的真实语义问题，不是显示 bug：

| 前端物种 | 后端行 | 情况 |
|---|---|---|
| `bass` | `bass` | 名字、单音性都对得上，最干净 |
| `pad` | `pad`（占 4 行：1/4/5/6） | 名字对得上；后端每行逐行单音，所以给 pad 配了 4 个同模型独立行做真和弦（见下方「pad 真和弦」），不再是"只带走一个音"的简化 |
| `melody` | `lead` | 名字不同，角色一致（都是单音旋律声部） |
| `texture` | 无 | 后端 `texture` checkpoint 还没练（`pendingVoices`），保持本地 granular |

漫游 API 也换了：旧 patch 用的是 v1 锚点索引 `setParams(voice, {timbre: N})`，
这个字段对生产的 `brave-voices` **已经不生效**（protocol.md §8.5），新版全部
改成 `timbreXY`/`timbreK`。`window.__audio.roamTo(species, [x,y], k)` 暴露了
接口，但目前没有 UI 接它——下一步要做音色漫游交互（比如接 `ring-bridge.js`
那套画布拖拽）就从这里下手。

**已用真实浏览器会话验证过**（Playwright + 真实 Chromium，不是单元测试）：
WS 连上 `mode=streaming`（不是 `fallback`），25 秒内 bass/melody 发出 114 条真实
`note` 帧，pad 发出 `control gate=true` 的 hold 帧且行号正确，`isNeural('texture')`
正确为 `false`。测试脚本没有留在仓库里（一次性验证，不是常驻工具），复现方法
就是「一分钟接手」那几行 + 浏览器控制台跑 `__audio.isNeural('bass')`。

**踩到的一个平台级坑，值得单独拎出来**：AudioWorklet 要求 secure context，
`http://192.168.9.140:8090/`（裸局域网 IP）不满足这个条件，`audioWorklet` 属性
直接是 `undefined`。`voice-client.js` 对此的处理是**优雅降级**——不报错，直接进
`fallback` 模式用本地合成顶上，`isNeural()` 全部返回 `false`。代价是**这个降级
非常安静**：页面正常打开、World 正常跑、控制台没有红字，唯一线索是
`isNeural()` 返回 false 或者听感上「怎么感觉都是本地音色」。用 SSH 隧道走
`http://localhost:8090/` 就没有这个问题（`localhost` 天然是 secure context）。

### pad 真和弦（同日第二次更新）

上面那版只带走"最新落位那一个音"是过渡状态，同一天里做了真正的和弦：

* **后端**：`server/backends/brave_voices.py` 的 `ROW_VOICES` 从 4 个变成 7 个——
  `("bass", "pad", "lead", "pluck", "pad", "pad", "pad")`，旧的 bass=0/pad=1/
  lead=2/pluck=3 绑定完全不变，新增的 3 行（4/5/6）追加在末尾、全部绑 pad。
  4 行背后是**同一个已加载的 pad 模型实例**（`_SHARED_VOICE_MODELS` 按名字缓存，
  不区分行号），不额外吃显存/加载时间，只多几份 `StreamingVoice` 轻量状态。
  `deploy/docker-run.sh` 显式传 `--pool-size 7`（**当前是 5**，见 deploy.md §9；
  没有改 `server/config.py` 的全局默认值 4，那个默认值是给 synth/silent 等其它
  场景用的，不该被 brave-voices 一家的需要牵动）。`info()` 新增 `rowsBySpecies`
  字段（当时 `{"pad":[1,4,5,6],...}`，现在 `{"pad":[1,4],...}`），
  别在调用方硬编码行号。
* **前端**：`mvp/src/config.js` 的 `voiceEngine.species.pad` 从 `{row:1,...}`
  改成 `{rows:[1,4,5,6], k:4}`；`mvp/src/audio.js` 加了 `neural.syncPadChord()`
  ——一个"鸟 ID → 行号"的分配器，每次 `refreshPadVoicing()` 跑完
  `mapping.padVoicingAssignments()`（这一步没有变，和弦音高仍然来自当日和弦 +
  voice-leading 约束，不是随便发的 MIDI）之后，把结果喂给分配器：已经占着行
  的鸟继续用同一行，新落位的鸟从空闲行里领一个，超过 4 行上限的音落回本地
  `startSustainedVoice`（优雅降级，不是报错）。`padPreviousMidi` 单独记账
  voice-leading 的"上一次落点"——不再依赖 `sustainedVoices`（本地振荡器状态），
  因为现在同一个音可能压根没有本地振荡器。
* **GPU 余量**：`tools/test_gpu_device.py` 已更新为按 `len(ROW_VOICES)` 动态
  跑（不再硬编码 4），实测七行满载（含真实 4 音和弦，纯串行前向）p50/p95 =
  36.78/37.49 ms，硬截止 46.44 ms，**过预算但余量只剩约 9 ms（19%）**——四行
  基线时余量是 24–28 ms（约 60%）。当天第三次更新：改成跨行 CUDA stream
  并行（见下一条），余量回到约 27%，不用再靠"别加行"硬扛。
* **跨行 CUDA stream 并行**（同日第三次更新，直接响应"能不能用更多 GPU"这个
  问题）：`server/backends/brave_voices.py` 的 `render_split` 原来是纯 Python
  for 循环——逐行前向、逐行 `.cpu().numpy()`。`.cpu()` 本身就是一次同步点，
  等于强迫 7 行严格排队执行，哪怕它们互不依赖（各行的跨块状态在
  `streaming.py` 的 `_VoiceState` 里完全独立，模型权重推理期只读，并发没有
  数据竞争）。改法：`load()` 里给每行建一个持久 `torch.cuda.Stream()`，
  `render_split` 先把 7 行的前向全部发出去（每行发到自己的 stream，不等），
  再一次性 `torch.cuda.synchronize()`，最后统一拷回 CPU。CPU 设备走原来的
  纯串行分支，不受影响。新增 `StreamingVoice.render_block_tensor()`
  （`render_block` 去掉 `.cpu().numpy()` 的版本），供并行路径用，`render_block`
  本身只是薄封装，行为不变。实测 p50 36.78→30.16 ms（降 18%）、p95
  37.49→33.83 ms（降 10%），`tools/test_multivoice.py`/`test_roam.py`/
  `test_note_expiry.py` 三个回归脚本重跑，逐行 RMS/peak 数值上与并行前
  完全一致——纯调度层面的改动，没碰任何数值计算逻辑。
  **没做的**：把 4 个 pad 行合并成一次带 batch 维的前向调用（理论上比
  stream 并行更快，因为能真正摊薄 kernel launch 开销，不只是让它们并发）。
  没做的原因是 pad 和弦成员是动态的（栖鸟随时落位/起飞），要批处理就要
  重构 `streaming.py` 里逐帧维护的因果卷积缓存去支持"batch 组成随时变"，
  这条路径的数值精度是卡在 6.9e-07 量级验证过的，改错的代价远大于收益，
  这轮先不碰。
* **验证**：Playwright 真实浏览器会话，40 秒运行窗口内观察到行 4/5/6 同时
  `gate:true`（三音和弦，行 1 因为窗口时机没抓到但逻辑对称）、以及正常的
  `gate:false` 释放帧。测试脚本同样没有留在仓库里。

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
7. 浏览器打开裸局域网 IP（不是 `localhost`）→ AudioWorklet 因为 secure context
   限制拿不到 → `voice-client.js` 优雅降级进 fallback，页面不报错、World 照常跑 →
   听到的全是本地合成，看起来像「神经音源没接上」，其实是打开方式不对。

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
