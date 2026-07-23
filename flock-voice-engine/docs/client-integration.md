# 浏览器端接入说明

给前端同事。目标：把现在的 WebAudio 裸合成换成 flock-voice-engine 的神经音源，
**总线以后的链路一行不动**。

配套文件：

| 文件 | 用途 |
|------|------|
| `client/voice-client.js` | 接入包本体。非 module、全局对象、无构建步骤 |
| `client/pcm-player-worklet.js` | AudioWorklet 环形缓冲播放器，跟着上面那个走 |
| `client/demo.html` | 独立自测台，**验证服务端好不好使就靠它** |

协议细节见 [`docs/protocol.md`](./protocol.md)（服务端那边定稿的）。本文只讲怎么用。

## 当前职责与候选源码诊断契约

当前生产仍由浏览器拥有 world、agent、latent 和 audio orchestration；本文的 legacy
client 只把事件发给 8090 decoder，并播放返回的 PCM。本次文档更新不改变连接、fallback
或发声行为，Node 后端权威 runtime 尚未切生产。

候选源码会在 health、status 与 ready 中暴露六个诊断字段：

| 字段 | 诊断用途 |
|---|---|
| `releaseRevision` | 当前完整 release 的 Git revision |
| `sourceManifestSha256` | 与 revision 成对的完整源码清单摘要 |
| `protocolFamily` | 区分 legacy decoder 与未来 Node runtime |
| `protocolVersion` | 协议的数值版本 |
| `runtimeOwner` | 当前推进 world/agent 的权威 owner |
| `audioOwner` | 当前拥有 decoder/audio timeline 的 owner |

`releaseRevision` 与 `sourceManifestSha256` 只能同时已知或同时为 `unknown`。当前未重启的
8090 可能尚无这些字段；字段缺失不能改变 legacy fallback，也不能被解释成 Node 已经接管。

---

## 1. 三行接进去

```html
<script src="./client/voice-client.js"></script>
```

```js
const voice = FlockVoiceClient.create({ context: audioCtx, destination: padBus });
await voice.connect('ws://192.168.9.140:8090/decoder');
voice.noteWithDuration(0, midi, velocity, durationSeconds);
```

- `context` 传**你现有的** AudioContext。不传就自己新建一个（自测台就是这么干的）。
- `destination` 传你的**声部总线节点**。干声从这里进你已有的 EQ / reverbSend /
  昼夜宏 / master 链路。不传就直接接 `context.destination`。

`connect()` 里会 `context.resume()`，但浏览器要求首次启动音频必须在用户手势里，
所以第一次调用请挂在点击事件上。

---

## 2. 替换现有 engine 层

你的 `audio.js` 现在大致是：

```
事件 → 四 engine（裸 WebAudio 合成）→ 声部总线 → 三段 EQ → reverbSend → 昼夜宏 → master
                └────── 换掉这一段 ──────┘
```

替换的是 **engine 这一层**，也只有这一层。具体做法：

```js
// 每个声部一个客户端实例，destination 指向该声部的总线入口
const engines = {
  pad:    FlockVoiceClient.create({ context: ctx, destination: buses.pad }),
  melody: FlockVoiceClient.create({ context: ctx, destination: buses.melody }),
  bass:   FlockVoiceClient.create({ context: ctx, destination: buses.bass }),
};
```

然后把 `mapping.js` 的输出直接喂进来：

```js
// perch：落枝
const { midi, velocity } = perchToNote(perchEvent);
// 实际发声音高 = 枝音 + registerOffset + engine 音区偏移，这一步还是你算
const sounding = midi + registerOffset[part];
engines[part].noteWithDuration(0, sounding, velocity, durationSeconds);

// unperch：起飞
const { midi, durationSeconds } = unperchToRelease(unperchEvent);
```

**两点务必注意：**

1. `voice` 参数（第一个）是**服务端 voice 池的行号**，不是声部名。生产服务端
   `poolSize = 5`（44.1 kHz、block 4096、pool 5），行音色为
   `[bass,pad,lead,pluck,pad]`：行 0/2/3 **固定绑定** bass/lead/pluck，
   行 1/4 **绑定 pad**——2 行同一个模型，独立
   `hold`/`release`，同时用就是和弦（见 protocol.md §8.5「一个音色占多行」，
   别硬编码行号，读 `rowsBySpecies`）。往任意一行打 note 出来的就是那行绑定的
   音色，选不了音色（音色变化走 §8 的漫游地图）。越界行号会被服务端静默丢弃。
   **每条 WS 连接有自己独立的一套 5 行池子**（跨连接不共享、不互抢），所以
   每声部一条连接或一条连接用全部行都行：前者每条连接只用自己那（些）行，
   后者下行是全部行混音（要分轨下行就连 `ws://…/decoder?split=1`，每轨一路
   独立 mono，连接时定死、运行期不可变）。
2. **`texture` 声部不要接**（还在服务端 `pendingVoices` 里，checkpoint 未交付），
   保留你现在的 WebAudio granular。

---

## 3. API

### `FlockVoiceClient.create(options)`

| 选项 | 默认 | 说明 |
|------|------|------|
| `context` | 新建 | 你的 AudioContext |
| `destination` | `ctx.destination` | 干声接到哪个节点 |
| `autoReconnect` | `true` | 断线自动重连 |
| `reconnectMinMs` / `reconnectMaxMs` | 500 / 8000 | 指数退避区间（带抖动） |
| `stallTimeoutMs` | 1500 | 这么久收不到音频块就判定流卡死 |
| `fallbackEnabled` | `true` | 断线是否回落到本地 WebAudio |
| `quantizeVelocity` | `true` | 见 §6 |
| `workletUrl` | 同目录 | worklet 路径，一般不用传 |

返回的实例：

| 方法 | 说明 |
|------|------|
| `connect(url)` | 连接。接受 `ws://h:8090/decoder`、`http://h:8090`、`h:8090` 三种写法 |
| `noteOn(voice, midi, velocity)` | 持续音，要自己 `noteOff` |
| `noteOff(voice)` | 松键 |
| `noteWithDuration(voice, midi, velocity, seconds)` | **主路径**，到点自动松键 |
| `setParams(voice, {...})` | `timbreXY / timbreK / gain / rich / room / dirt`（漫游见 §8；只在 `streaming` 模式真的发帧） |
| `disconnect()` | 主动断开，停止重连 |
| `onStateChange(cb)` | 状态订阅，返回退订函数 |
| `getState()` / `getStats()` | 快照 / 实时指标，自己轮询 |
| `output` | 干声出口 GainNode（`create` 时已接到 destination） |

`noteOn` / `noteWithDuration` 返回 `{ midi, clamped, tier, durationSeconds }` —— `clamped`
告诉你这个音是不是被夹过，可以拿来做 UI 提示。

### 状态

`onStateChange` 的回调拿到 `{ mode, reason, connected, usingFallback, ... }`，`mode` 五种：

```
idle → connecting → streaming        正常路径
                 ↘  fallback  ↺      断线：本地兜底 + 后台重连
                     closed          disconnect() 之后
```

**`connect()` 不会因为服务端不可用而 reject。** 连不上就静默进 `fallback`，
后台一直重连。前端界面不该因为音源后端挂了而报错 —— 这是韧性要求的一部分。
要知道当前状态就订阅 `onStateChange`。

---

## 4. 怎么验证

### 4.1 服务端

已经在 Spark 上跑着，不用自己起：

```
http://192.168.9.140:8090/healthz          → {"ok":true,"backend":"brave-voices"}
ws://192.168.9.140:8090/decoder
```

当前生产是 `brave-voices` 神经后端（四音色 checkpoint，每轨独立漫游地图），
`synth` 程序合成兜底仍在，服务起不来时自动回落。

> **代理坑（会浪费你半小时）**：本机 Mac 有 `HTTP_PROXY=127.0.0.1:7897`。
> `curl` 不加 `--noproxy '*'` 打这个端点会返 **502**，看起来跟服务挂了一模一样。
> 浏览器同理 —— **先把 `192.168.9.140` 加进代理白名单（绕过代理）**，
> 否则 `demo.html` 连不上，而且报错信息不会告诉你是代理干的。

### 4.2 开自测台

**必须用 http server 打开，不能 `file://`** —— AudioWorklet 的 `addModule()`
在 file:// 下会被安全策略拦掉。

```bash
cd flock-voice-engine
python3 -m http.server 5500
# 浏览器打开 http://localhost:5500/client/demo.html
```

填地址 → 连接 → 点键盘。要看的四件事：

| 看什么 | 期望 |
|--------|------|
| 状态灯 | 绿色 `streaming`，右边显示 `brave-voices · 池长度 5 · 44100 Hz` |
| buffer target | 约 **13000 frames ≈ 295 ms**；持续爬升或大幅锯齿 = 背压回报没生效 |
| 端到端延迟 | 诊断公式是 **buffer target + runtime outputLatency + 网络/渲染耗时**；精确 E2E 区间**待当前配置复测**，不要写死新范围 |
| underruns | 起播后不再增长。持续增长 = 服务端发得不够快 |
| 丢帧 | 应当是 0。非 0 = 服务端发太快，环形缓冲溢出 |

页面上另外三个按钮：**三音琶音**（听抢占有没有爆音）、**音域扫描 31→95**
（听整个训练域）、**越界测试**（验证 midi 12/120 被夹到 31/95）。

### 4.3 韧性验收（拔后端）

以下步骤只允许对本地或隔离 staging 服务执行，**不得对当前生产 8090 执行**：

1. 连上，确认在 `streaming`
2. 停止隔离的测试服务
3. **期望**：状态转黄色 `fallback`，日志出现「连接断开」，
   **键盘照样出声**（本地 WebAudio），页面无报错、无红字
4. 恢复隔离的测试服务
5. **期望**：几秒内自动转回绿色 `streaming`，本地合成静音交还发声权

第 3 步就是需求里那条「拔掉后端，画面继续、界面不报错」。

### 4.4 自动化验收口径

当前复验用 node 原生 WebSocket + 打桩 Web Audio 驱动**真实的
`voice-client.js`**；对生产 8090 的验收口径是：

- 连上真服务 → `streaming`，`ready` 帧解析出 `brave-voices` / 44100 Hz /
  poolSize=5 / blockSamples=4096
- 混合模式二进制块 **32768 字节**（4096 样本 × 2 声道 × 4 字节），note 后波形非零
- `note` 帧字段正确：`velocity 0.68 → 1.0`、`gain 0.544`（= 0.8 × 0.68 增益差分）
- 夹取：midi 12→31、120→95；duration 0.1→0.25、99→6；velocity 0.42→0.3937
- `buffer` 背压回报上行；服务端 `telemetry` 的水位与 underrun 持续可读
- `setParams` 发的 `control` 帧**不带 `gate`**，不会误触发音符
- 断线 → `fallback` → 自动重连回 `streaming`，状态机路径
  `idle→connecting→streaming→fallback→streaming→closed`
- 连一个根本不存在的地址：`connect()` 不抛异常，直接进 `fallback`，照样能发音

浏览器里的真实听感（重采样、worklet 环形缓冲、爆音）仍需你用 `demo.html` 过一遍 ——
上面这轮验证的是协议和状态机，不是音质。

---

## 5. 回落行为说明

断线判定有三条触发路径，任意一条都会进 `fallback`：

- `connect()` 时连不上（含超时，默认 6 s）
- 连接中途 `close` / `error`
- **连着但不发流**：超过 `stallTimeoutMs`（默认 1.5 s）没收到音频块。
  服务端只要有客户端连着就会持续发流（没声音时发零块），所以静默 = 故障。
  这条能抓住 TCP 没断但服务端卡死的情况，光看 `onclose` 是抓不到的。

进入 `fallback` 后：

- 本地 WebAudio 简易合成接管，四种音色的参数照着服务端 `backends/synth.py`
  抄的，听感跳变尽量小 —— 应该像「音源换了个档次」，不像「换了个乐器」。
- **仍在响的音会被原样搬到本地合成器上**，包括剩余时长，听感不断。
- 后台按指数退避重连（0.5 s → 8 s，带抖动）。
- 重连成功后：本地合成静音，**参数和仍在响的音会补发给服务端**（按剩余时长），
  所以接上就有声，不用等下一个 note。

回落合成器和服务端一样**只出干声** —— 没有混响、没有 master。你的总线链路
在两种模式下都照常工作，这也是回落听起来不突兀的原因。

---

## 6. 与 `protocol.md` 的一处出入（记一笔）

已按定稿的 `docs/protocol.md` 逐条核过：端口 8090、`/decoder`、
`control` / `note` / `noteOff` / `buffer` 四种上行帧、`ready` 帧里用到的字段、
当前混合模式下行 32768 字节交错立体声 —— 全部以 `ready` 的
blockSamples/channels 为准，§4.4 的验收口径覆盖这些。
只有下面这一处口径需要说明。

`docs/protocol.md` §9 写的是：velocity 三档→两档的映射
（0.42→v50，0.68 与 1.0→v127 + 增益差分，禁止插值）**由 brave 后端内部处理，
协议层照常传 0–1 连续值**。

交接给我的口径是这件事在客户端做。我的处理：**客户端默认也做一遍**，理由有二：

1. **幂等**。量化后的值只有 `50/127 ≈ 0.3937` 和 `1.0` 两个，再被后端量化一次
   还是它自己，不会双重变换。增益差分同理 —— 后端收到的是已量化的 `1.0`，
   区分不出它原本是 0.68 还是 1.0，不会重复施加。
2. **V1 现在跑的是 `synth` 兜底后端，它根本不量化**。客户端不做，连续 velocity
   就直接漏进去了。brave 后端还没落地之前，这层保险是有意义的。

确认 brave 后端接管、且它内部确实做了这个映射之后，前端可以关掉：

```js
FlockVoiceClient.create({ quantizeVelocity: false });
```

另外两处**不算冲突、但值得知道**的实现选择：

- `protocol.md` §5 与当前 worklet 都是每 32 个 **render quanta**
  （约 85 ms @ 48 kHz）回报一次 `buffer`；计数单位不是服务端 audio block。
- `protocol.md` §3.1 的示例把交错立体声降回 mono 再进环形缓冲。我保留了两个
  声道（虽然服务端左右恒等），这样将来服务端真出立体声时客户端不用改。

---

## 7. 已知坑

- **`file://` 打不开自测台**，AudioWorklet 限制，见 §4.2。
- **裸局域网 IP 也打不开神经音源，跟 `file://` 是同一类限制，但更隐蔽。**
  `AudioWorklet` 要求 secure context——`https:`、`localhost`、`127.0.0.1` 满足，
  `http://192.168.9.140:8090/` 这种裸局域网 IP **不满足**，`context.audioWorklet`
  直接是 `undefined`。跟 `file://` 不同的是：**这里不会报错**，`voice-client.js`
  直接优雅降级进 `fallback`，页面照常打开、World 照常跑、控制台没有红字，
  你只会觉得「怎么听起来都是本地合成」。排查用 `voice.getState().usingFallback`
  或 `window.__audio.isNeural(species)`。正确打开方式是 SSH 隧道到本机后走
  `http://localhost:8090/`，不要直接打开 Spark 的局域网地址（2026-07-21 踩坑，
  详见 `docs/HANDOFF.md`「mvp/ 前端接入」）。
- **`GET /api/decoder-status` 跨域会失败** —— 服务端没开 CORS 头。这不影响
  WebSocket（WS 不走 CORS）。所以本包**不依赖**这个接口，一切配置以 WS 的
  `ready` 帧为准；`probeStatus()` 只是自测台上的一个便利按钮，失败属正常。
- **本机代理会伪装成「服务挂了」**：Mac 上有 `HTTP_PROXY=127.0.0.1:7897`，直连
  局域网的 8090 会返 **502**。`curl` 加 `--noproxy '*'`；**浏览器要把
  `192.168.9.140` 加进代理白名单**，否则 `demo.html` 连不上。这是本项目目前
  最容易误判的一个坑 —— 服务是好的，代理把请求吃了。
- **采样率**：服务端固定 44.1 kHz，你的 AudioContext 大概率是 48 kHz。worklet
  里做了线性插值重采样，你不用管，也**不需要**为此新建一个 44.1 kHz 的
  AudioContext（那会和你现有的链路打架）。
- **生产 `poolSize = 5`**，行音色 `[bass,pad,lead,pluck,pad]`；行 0/2/3 绑 bass/lead/pluck，
  行 1/4 绑 pad（和弦，见 protocol.md §8.5）。行号越界会被静默丢弃。

---

## 8. 音色漫游（XY 直控，v2）

每条轨有一张**独立的**音色漫游地图 —— 同一个 `[x,y]` 打到不同行是不同音色区域，
**不要跨轨共用坐标或 scale**。

**拿配置：一切从 `ready` 帧来，不写死。** `ready.backend` 里有
`roamSupported`、`pendingVoices`，以及 `voices.{bass,pad,lead,pluck}.roam`：

```json
{ "available": true, "points": 44, "layout": "tsne",
  "scale": 8.655, "asset": "/assets/timbre/voice_maps/bass.json", "defaultK": 4 }
```

`roam.available=false` 或字段缺失 = 该轨没有漫游能力，UI 降级，别静默假设。

**漫游：** 地图 JSON（`roam.asset`）里有 `points: [{id,x,y,gain}]` 和 `scale`。
把画布坐标除以 `scale` 归一化后发给服务端：

```js
voice.setParams(row, { timbreXY: [x, y], timbreK: 4 });  // k 默认 4，范围 1–32
```

- `note` 帧也可以直接带 `timbreXY`，起音就落在对应音色上（不会从默认音色滑过去）。
- 持续发声中改 XY 是连续漫游、音不断；限速 20 次/秒，拖动时别发得更勤。
- k 有听感后果：k=1 硬切最近 preset，k 大糊成区域平均。
- `timbreXY: null` = 停在当前音色不动（v2 没有「回到槽位」的概念；`timbre` 字段
  在 v2 不影响发声）。

参考实现：`client/tracks.html`（每轨一块 XY 画布 + k 滑杆，全部配置从 `ready` 帧读）。
