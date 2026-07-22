# flock-voice-engine 服务协议

给前端对接用。与 Latent-Cosmos 基线**线兼容**,已有 worklet 改个 URL 就能接;
本项目额外加了 `note` 帧(见 [§4.2](#42-note--本项目新增)),这是 perch/unperch
语义需要的那条路。

- 默认地址:`http://<host>:8090`
- 采样率 44100 Hz,块长可配置(`--block-samples`)。**生产(`brave-voices`,2026-07-21 起)
  用 2048 样本 = 46.44 ms**;下面部分示例 JSON 里的 `blockSamples: 1024` 是 V1
  单声部 `synth` 兜底后端的默认值,连上服务后**以 `ready` 帧 / `/api/decoder-status`
  实际返回的值为准**,不要硬编码
- 端口 8090 是硬约束:Spark 上 8081/8083/8086/4173 等已被占用

---

## 1. 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/healthz` | 存活探针,返回 `{"ok":true,"backend":"synth-s"}` |
| GET | `/api/decoder-status` | 后端自述,连 WS 之前先探这个 |
| GET | `/api/load` | 当前负载快照,不用开 WS 就能查(§1.1) |
| WS  | `/decoder` | 音频流。`binaryType = "arraybuffer"`。`?split=1` 开分轨(§2.1) |

### `GET /api/decoder-status`

```json
{
  "engine": "flock-voice-engine",
  "defaultModel": "synth-s",
  "models": [{ "id": "synth-s", "engine": "programmatic-synth", "tier": "S",
               "timbres": ["bass","pad","lead","pluck"], "loaded": true }],
  "sampleRate": 44100,
  "blockSamples": 1024,
  "samplesPerFrame": 1024,
  "framesPerDecode": 1,
  "poolSize": 1,
  "channels": 2,
  "pcmFormat": "f32-interleaved-stereo",
  "splitSupported": true,
  "splitChannels": 4,
  "controlSchemes": ["control", "note"],
  "timbres": ["bass", "pad", "lead", "pluck"],
  "serverSideMastering": false
}
```

`splitSupported`/`splitChannels` 是**后端能力**,不是连接状态 —— 判断某个
后端是否支持分轨用它,但某条具体连接是否真的分轨了以 `ready` 帧的 `split`
为准(§2.1),两者不一定一致(后端支持但你没在 URL 上加 `?split=1`)。

`poolSize` 决定合法的 `voice` 行号范围(`0 … poolSize-1`)。**V1 是 1**,V2 生产
是 **7**(2026-07-21 起:bass/pad/lead/pluck 各占 1 行 + pad 和弦额外占 3 行,
详见下方「pad 和弦占多行」)。越界的行号会被静默丢弃 —— 不会扩容,理由见 §6。

### 1.1 `GET /api/load`

**只读、不开 WS**。用户正在漫游时想看负载,不该逼着再开一条连接去测 ——
那会让服务端多建一份 voice 池和后端实例,等于把要测的东西自己改大一倍。
数据来自发送循环里顺手记的快照,过期上限约一个块(生产 46 ms 量级)。

```json
{
  "connections": 2,
  "sessions": [
    { "connId": "10.0.0.5#3af2", "split": true, "channels": 4,
      "activeVoices": 3, "renderMs": 19.32, "db": -18.7, "aliveSeconds": 142.3 }
  ],
  "logPath": "/home/rolf/logs/flock-voice-load.jsonl"
}
```

`sessions` 里每条对应一个当前存活的 WS 连接;连接断开后立刻从列表移除。
服务端同时把 p50/p95/max 的 `renderMs` 落盘到 `logPath`(每约 1.9 s 一行,
`server/app.py` 的 `LOAD_LOG_EVERY_BLOCKS`),那是给事后排查用的,接口本身
只报最新快照。

---

## 2. 连接握手

连上 `/decoder` 后,服务端立刻推一条 `ready`(JSON 文本帧):

```json
{
  "type": "ready",
  "modelId": "synth-s",
  "sampleRate": 44100,
  "blockSamples": 1024,
  "poolSize": 1,
  "channels": 2,
  "pcmFormat": "f32-interleaved-stereo",
  "backend": { "id": "synth-s", "engine": "programmatic-synth", "...": "..." }
}
```

收到 `ready` 之后就可以发上行帧了。**服务端从连接建立那一刻起就持续发音频**,
没有音在响的时候发的是零块 —— 不要因为"现在没声音"就断开或暂停消费,voice 池
是常驻的,流断了再接会爆音。

### 2.1 分轨模式(`?split=1`)

默认混合立体声(干声等幅复制成 L/R)是**线兼容**的基线行为,零改动就能接。
想让前端给每一轨接自己的 EQ / 混响发送 / 频段占位,连接时在 URL 上加
`?split=1`(也认 `true`/`yes`):

```
ws://<host>:8090/decoder?split=1
```

**按连接选择,连上之后不可变**——通道数变了,客户端环形缓冲和 worklet
输出数都要重建,协议不支持连接期间切换。

分轨与否由 `ready` 帧的实际字段说了算,**不要按请求参数自己假设**:

```json
{ "type": "ready", "split": true, "channels": 4,
  "pcmFormat": "f32-interleaved-tracks", "trackCount": 4, "...": "..." }
```

| 字段 | 混合模式 | 分轨模式 |
|---|---|---|
| `split` | `false` | `true` |
| `channels` / `trackCount` | `2` / `1` | `poolSize` / `poolSize` |
| `pcmFormat` | `f32-interleaved-stereo` | `f32-interleaved-tracks` |

分轨下二进制帧是 `poolSize` 个通道按帧交错(第 n 通道 = 第 n 轨干声,
不是立体声),即 `[t0_row0, t0_row1, t0_row2, t0_row3, t1_row0, …]`。

**后端不支持分轨时会静默降级为混合立体声**,并在服务端日志打一行
`请求分轨但后端 X 不支持,降级为混合立体声`。前端必须按 `ready` 帧的
`split`/`channels` 实际值搭环形缓冲,不能假设请求的就是给到的
——`/api/decoder-status` 的 `splitSupported`(后端能力,服务级)可以用来
提前判断要不要发 `?split=1`,但连接级事实永远以 `ready` 为准。

---

## 3. 下行

### 3.1 音频(二进制帧)

**交错立体声 float32 小端 PCM**,即 `L R L R …`。一帧 = 1024 样本 × 2 声道 ×
4 字节 = **8192 字节**。

音源本身是干声 mono,发送前等幅复制到两声道 —— 所以左右恒等。**声像、混响、
EQ、昼夜宏一律由前端处理**,服务端只出干声(见 §7)。

```js
ws.binaryType = 'arraybuffer';
ws.onmessage = (event) => {
  if (typeof event.data === 'string') { handleJson(JSON.parse(event.data)); return; }
  const interleaved = new Float32Array(event.data);   // L R L R …
  const frames = interleaved.length / 2;
  // 干声 mono:取偶数下标即可,不必分别取左右
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = interleaved[i * 2];
  ring.push(mono);
};
```

### 3.2 `telemetry`(JSON 文本帧)

每 8 块发一条,纯观测用,可以整条忽略。

```json
{
  "type": "telemetry",
  "renderMs": 1.83,
  "revision": 12,
  "bufferedFrames": 5400,
  "estimatedBufferedFrames": 5512,
  "underruns": 0,
  "activeVoices": 1,
  "db": -21.4,
  "voices": [{
    "row": 0, "timbre": "pad", "gate": true,
    "midi": 55.0, "velocity": 0.68, "envelope": 0.83,
    "remainingSeconds": 1.42
  }]
}
```

`bufferedFrames` 是你上报的原值,`estimatedBufferedFrames` 是服务端外推到当下的
估计值(§5)。两者差得远说明你的上报周期太长。

### 3.3 `error`

坏帧不会断连接,只回一条 `{"type":"error","message":"..."}`。

---

## 4. 上行

三种上行帧都是 JSON 文本。`note` 和 `control` **驱动同一个 voice 池**,可以混用,
后到的那个说了算。

### 4.1 `control` —— 基线的连续 gate 语义

60 Hz 全量下发。适合"按住就响、松开就停"的交互。

```json
{ "type": "control", "voices": [
  { "voice": 0, "gate": true, "midi": 55, "velocity": 0.68,
    "timbre": "pad", "gain": 0.8, "rich": 0.5, "dirt": 0.0 }
]}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `voice` | int | 行号。也认 `row` / `objectId`;都没有就用数组下标 |
| `gate` | bool | `true` 起音,`false` 进入 release。**给了这个字段就接管该行**,清掉 note 倒计时 |
| `midi` | number | 31–95,越界会被夹紧 |
| `velocity` | number | 0–1 |
| `timbre` | int \| string | 见 §8 |
| `gain` `rich` `room` `dirt` | number | 0–1,见 §8 |

只想改参数不想动 gate,就**别带 `gate` 字段** —— 带了就会被当成 gate 指令。

### 4.2 `note` —— 本项目新增

前端是 perch/unperch 的 note 语义(落一下响一段,时长由 `unperchToRelease` 给出),
没有持续的 gate 流,所以加了这条。发一次就完事,服务端自己数时长、到点松键。

```json
{ "type": "note", "voice": 0, "midi": 55, "velocity": 0.68,
  "durationSeconds": 1.8, "timbre": "pad" }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `voice` | int | 是 | 行号,`0 … poolSize-1` |
| `midi` | number | 是 | **31–95**,越界夹紧(训练域边界) |
| `velocity` | number | 是 | 0–1 |
| `durationSeconds` | number | 是 | **0.25–6.0**,越界夹紧;对齐 `unperchToRelease` |
| `timbre` | int \| string | 否 | 不给就沿用该行当前音色 |
| `gain` `rich` `room` `dirt` | number | 否 | 0–1 |

时长到点后自动进入 release,**release 尾巴不算在 `durationSeconds` 里**
(pad 的尾巴可以拖好几秒)。

想提前掐断就发 `noteOff`:

```json
{ "type": "noteOff", "voice": 0 }
```

**抢占**:同一行上新音直接顶掉旧音(last-note-priority),不用先发 `noteOff`。
抢占时振荡器相位是连着走的,不会爆音。

### 4.3 `buffer` —— 背压回报

```json
{ "type": "buffer", "bufferedFrames": 5400, "underruns": 0 }
```

`bufferedFrames` 是你环形缓冲里**还没播出去**的帧数(单声道帧,不是字节、不是样本对)。

---

## 5. 背压 pacing(客户端必须实现)

服务端按你回报的水位调节发送节奏。**不回报 `buffer` 帧,节奏控制就是瞎的**,
缓冲要么饿死要么无限堆积。

客户端契约(照搬基线 worklet):

1. 环形缓冲 1.5 s
2. 攒够 **4096 帧**才起播
3. **每 32 块**回报一次 `buffer`

服务端策略(纯内部实现,不影响协议,列在这里只为让你知道它在干什么):

| 水位 | 系数 | 行为 |
|------|------|------|
| < 4096 帧 | 0.5 | 抢跑填缓冲 |
| 4096–16384 帧 | 比例控制,11000 帧处取 1.0 | 稳在 11000 帧(≈250 ms)附近 |
| > 16384 帧 | 1.2 | 减速让客户端消费 |

服务端会把你上一次的回报**外推到当下**(它知道回报之后自己又发了多少帧、过了
多久),所以 0.74 s 的回报周期不会造成超调。

> 目标水位 2026-07-21 从 6000 帧(136 ms)提到 11000 帧(250 ms):四轨满载
> 渲染毛刺会超过块预算(46.44 ms),136 ms 余量在连续毛刺下被磨穿、客户端
> underrun 不断。250 ms ≈ 5.4 块余量,端到端 ~230–280 ms,仍在 100–300 ms
> 预算内。代价就是延迟高了约 110 ms,换来不掉帧。

端到端单音延迟实测约 **230–280 ms**,在 100–300 ms 预算内。

---

## 6. voice 池为什么是固定长度

`poolSize` 在服务启动时定死,运行期不变;`voice` 行号与声部**永久绑定**。

解码的 batch 维就是声部维。神经后端跨块保持的状态(条件缓冲、上采样卷积的
padding、激励相位)都按 batch 尺寸分配,尺寸一变就要重新分配并清零 ——
结果是所有声部的状态同时被打断,听感上一起爆一下。

所以:**不发声的声部带 `gate=0` 继续跟着跑,不会被移出池子**;越界的行号直接
丢弃而不是扩容。前端不需要做任何"申请/释放 voice"的事,直接往固定的行号上打
note 就行。

---

## 7. 服务端**不**做的事

以下全部在前端,与音源解耦,服务端一概不碰:

- master 总线 / 限幅 / 压缩
- 混响(`room` 参数照收但服务端不消费)
- 三段 EQ、声部总线增益
- 昼夜宏低通
- 声像(下行左右恒等)

服务端只出**干声 mono**(复制成立体声发送)。`serverSideMastering: false` 就是这个意思。

texture 声部目前不走本服务（在 `pendingVoices` 里，checkpoint 到位后接入），
前端保留 WebAudio granular。

---

## 8. 音色与参数

V1 兜底音源(`synth-s`)四种音色,取自 `eco-sequencer-riso/audio.js` 的 `note()`:

| 下标 | 名字 | 音色 | 起音 | 尾巴 |
|------|------|------|------|------|
| 0 | `bass` | 正弦+次谐波,低通 320 Hz | 40 ms | 长(2.2 s 衰减) |
| 1 | `pad` | 三个失谐三角波,低通 1.8 kHz | 500 ms | 长,有延音 |
| 2 | `lead` | 方波,低通 2.6 kHz | 20 ms | 中 |
| 3 | `pluck` | 三角波 | 3 ms | 短(0.24 s) |

`timbre` 字段给下标或名字都行,不认识的回落到 `pad`。

连续参数(全部 0–1):

| 参数 | 作用 |
|------|------|
| `gain` | 该声部输出增益 |
| `rich` | 谐波数与失谐宽度 → 越大越亮越厚 |
| `dirt` | 轻微失谐游走(±25 cents)+ 抬高滤波截止 |
| `room` | **服务端不消费**,混响在前端。照收不报错 |

神经后端（`brave-voices`，见 §8.5）每行音色固定绑定（bass/pad/lead/pluck；
pad 额外占了 3 行做和弦，见 §8.5「一个音色占多行」），
`control`/`note` 的音色相关字段里只有 `timbreXY`/`timbreK` 实际影响发声；
`gain` 照常用。协议本身不变。

---

## 8.5 音色地图 XY 直控（v2：每轨独立地图）

生产后端 `brave-voices` 的每一行（bass/pad/lead/pluck）有**自己独立的漫游地图**，
坐标系互不相关 —— 同一个 `[x, y]` 打到不同行上是完全不同的音色区域。
（v1 旧 `brave` 后端是一张 1239 点的共享地图，语义见 `latent-map.md`，本节以 v2 为准。）

```json
{"type":"control","voices":[{"voice":0,"timbreXY":[0.12,-0.05],"timbreK":4}]}
{"type":"note","voice":0,"midi":55,"velocity":0.68,"durationSeconds":1.8,"timbreXY":[0.3,0.1]}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `timbreXY` | `[x, y]` 或 `null` | 该轨自己的地图坐标（归一化范围大致 [-1,1]，映射用各轨 `roam.scale`）。`note` 帧带 XY 时起音**直接落在**对应 z 上（不从默认音色漫游过去）；持续发声中改 XY 走漫游路径、音不断 |
| `timbreK` | 1–32，默认 4 | kNN 邻居数。**有听感后果**：k=1 硬切到最近 preset，k 大则糊成该区域的平均音色 |

⚠️ **`null` 语义与 v1 不同**：v1 的 `timbreXY:null` 是「回到锚点槽位模式」；
v2 没有锚点槽位，`null` = 停在当前 z 不动（下次起音若仍无 XY 则用该轨默认音色向量）。
v2 下 `timbre` 槽位字段**不影响发声**（保留解析仅为协议兼容）。

`timbrePCA` **2026-07-21 起对 v2 生效**（在此之前只解析不消费，是协议兼容占位）：
无约束 PCA 子空间系数，数组长度 = 该轨 `roam.pca.dims`（见 §8.5a），
`z = mean + Σ coeff[i] * basis[i]`。**优先级高于 `timbreXY`**——两个字段
同时给，服务端按 PCA 算，`timbreXY` 被忽略。跟 kNN 混合不同，**这条路径
不保证落在训练流形上**，极端系数可能产生失真/怪音/不发声，这是协议本身
的性质（见 §8.5a 与 `docs/latent-map.md`「为什么不做 XY → 反投影」）。

服务端拿 XY 在该轨地图的真实 preset 点里找最近 k 个，反平方距离加权混合它们的 z。
**不做反投影** —— 会落到流形外产生怪音。限速 20/秒（直接操纵要即时）。

### 客户端怎么拿到地图（别写死）

`ready` 帧与 `/api/decoder-status` 的 `backend`/`models[0]` 里带：

```json
{ "roamSupported": true,
  "pendingVoices": ["texture"],
  "rowsBySpecies": { "bass": [0], "pad": [1, 4], "lead": [2], "pluck": [3] },
  "voices": { "bass": { "row": 0, "gain": 1.3371,
    "roam": { "available": true, "points": 44, "layout": "tsne",
              "scale": 8.655, "asset": "/assets/timbre/voice_maps/bass.json",
              "defaultK": 4 } }, "...": "..." } }
```

`roam.available=false` 或字段缺失 = 该轨没有漫游能力，UI 要降级而不是静默假设。
地图 JSON 结构：`{schema, voice, checkpointStep, configHash, layout, scale,
points: [{id, x, y, gain}], z}` —— 前端只需要 `points`（散点渲染）和 `scale`
（画布坐标 → 地图坐标的换算）；`z` 是给服务端/调试用的 256D 潜向量。

### 一个音色占多行：pad 和弦（2026-07-21 起）

`voices.pad.row` 只报**一行**（主行，见上面的例子），但 pad 实际占 **2 行**
（2026-07-22 起，之前是 4 行 `[1,4,5,6]`；为缓解共享 GPU 争用下的卡顿收窄，见
`docs/deploy.md` §9）——`rowsBySpecies.pad` 才是权威来源，**不要**假设"每个音色
= 一行"或硬编码 `[1, 4]`（更别硬编码旧的 `[1, 4, 5, 6]`）这种字面量。这些行背后
是同一个已加载模型实例（同一份权重，同一张漫游地图/默认音色），不是不同音色，
只是能同时独立发声、独立 `hold`/`release`。

想让 pad 出和弦，就把和弦里的每个音分别 `hold` 到一个空闲行上：

```json
{"type":"control","voices":[{"voice":1,"midi":60,"velocity":0.7,"gate":true}]}
{"type":"control","voices":[{"voice":4,"midi":64,"velocity":0.7,"gate":true}]}
{"type":"control","voices":[{"voice":6,"midi":67,"velocity":0.7,"gate":true}]}
```

三行同时 `gate:true` 就是三音和弦，跟单独发三个音符没有本质区别——服务端
不知道"和弦"这个概念，只知道三个独立的行各自在 hold 一个音。哪个音落在
哪一行、什么时候该释放哪一行，是**客户端职责**（分配/回收行号），不是协议
职责；`mvp/src/audio.js` 的 `neural.syncPadChord()` 是参考实现。

同时发声的音数上限 = `rowsBySpecies.pad.length`（目前 4）。超过上限的音
客户端要自己决定怎么办（丢弃、退回本地合成……），协议层不做任何限制或提示。

## 8.5a `timbrePCA`：无约束 PCA 子空间漫游（2026-07-21 起对 v2 生效）

跟 `timbreXY`（kNN 混合真实 preset，安全，永远在凸包内）取舍完全相反：

```json
{"type":"control","voices":[{"voice":0,"timbrePCA":[1.2,-0.8,0,0,0,0,0,0,0,0]}]}
{"type":"note","voice":0,"midi":55,"velocity":0.68,"durationSeconds":1.8,"timbrePCA":[0.5,0.3]}
```

`timbrePCA` 是数组，长度 ≤ 该轨 `roam.pca.dims`（少给的维按 0 补，见下面
`ready` 帧的例子）；服务端算 `z = mean + Σ coeff[i] * basis[i]`，`mean`/
`basis` 是该轨自己的 PCA 基，训练语料就是该轨漫游地图里的真实 preset。
**优先级高于 `timbreXY`**——两个字段同时给，`timbreXY` 被忽略；`null`
退出 PCA 模式，回落到 `timbreXY`（如果也给了的话）或默认音色。

⚠️ **不保证落在训练流形上。** PCA 主成分是线性方向，真实的 z 流形未必
线性，子空间里的点可能落在流形外——听感上是失真、怪音、甚至不发声。
这不是 bug，是这条路径存在的意义（详见 `docs/latent-map.md`「为什么不做
XY → 反投影」、`tools/build_pca_basis_v2.py` 模块 docstring）。**v2 每轨
的 PCA 基语料只有 ~31–45 个 preset**（该轨漫游地图的全部点），比 v1 共享
的 1239 个薄得多——`ready` 帧里的 `explainedTotal` 数字看起来会比 v1 高
（语料越小，PCA 越容易"完美解释"这几十个点本身），但不代表基更稳健，
反而更可能是对这几十个点的过拟合方向。

### 客户端怎么拿到 PCA 基（同样别写死）

`ready.backend.voices[name].roam.pca`：

```json
{ "available": true, "dims": 10, "explainedTotal": 0.838,
  "ranges": [ { "p5": -2.07, "p50": 0.05, "p95": 2.63, "min": -3.1, "max": 3.4 }, "..." ] }
```

`available=false` 或字段缺失 = 该轨语料太薄没能算出 PCA 基（见
`build_pca_basis_v2.py` 的最小样本要求），UI 应该隐藏 PCA 模式而不是让用户
拖一个不存在的滑杆。`ranges[i]` 是第 i 维系数的 p5/p50/p95/min/max——滑杆
范围建议用 p5–p95 而不是 min–max，避免被离群点把大部分滑动范围压扁（跟
`timbreXY` 的地图散点是同一套取舍）。

参考实现：`mvp/src/ui/latent-roamer.js`（弹窗，鼠标位置 → PC1/PC2、
滑杆 → PC3 及以上）；沿用 `client/map.html`（v1）已经验证过的
"PC1/PC2 当二维散点位置、其余维用滑杆"这套交互，不是重新设计。

## 8.6 `hold` / `release` —— 无上限延音（客户端方法）

`note` 帧有 6 秒时长上限（`DURATION_MAX_SECONDS`），到点自动松键；而且每次重触发
都会把 z_timbre 拉回目标锚点，**切断漫游的连续性**。要听「同一个音上音色连续变形」
就不能用它。

客户端的 `hold(voice, midi, velocity)` / `release(voice)` 走 `control` 帧的 gate 语义：

```json
{"type":"control","voices":[{"voice":0,"midi":60,"velocity":1.0,"gate":true}]}
{"type":"control","voices":[{"voice":0,"gate":false}]}
```

gate 只在 false → true 时起音，之后换锚点/换 XY 走的都是漫游路径，音不断。

> **延音期间改音高会重触发。** 服务端原先只在 gate 翻转时起音，导致按住不放改音高
> 毫无反应（`voice.midi` 更新了但流式声部还在放旧音）。现在「gate 持续 + 音高变化」
> 判定为换音，按 last-note-priority 重新起音。

## 9. 训练域边界(硬约束)

神经后端只在这个范围内可信,服务层会**夹紧**而不是报错:

- **MIDI 31–95**,越界夹紧（协议层 `server/config.py` 与 `voice-client.js` 的
  `MIDI_MIN/MAX` 同步强制；checkpoint 真实训练域更宽，是 21–109，但协议层不放开）
- **`durationSeconds` 0.25–6.0**,越界夹紧
- velocity 训练时只有 `{50, 127}` 两档（v1/v2 的 manifest 逐条核实过）。前端三档
  (0.42 / 0.68 / 1.0)的映射(0.42→v50,0.68 与 1.0→v127 + 增益差分,**禁止插值**)
  由 brave 后端内部处理,协议层照常传 0–1 连续值。

---

## 10. 起服务 / 自测

```bash
# 起服务(默认 0.0.0.0:8090,pool=1,synth 兜底后端)
python3 server/app.py

# V2 四声部
python3 server/app.py --pool-size 4

# 换后端。名字取自各后端类的 backend_id,服务启动时自动扫描 server/backends/。
# 未注册 / 导入失败(比如没装 torch)/ 构造签名不匹配,都会打一行 warn 然后
# 回落到 synth 兜底 —— 服务不会因为模型没就绪而起不来。
python3 server/app.py --backend brave --model-path /data/model_weights/midiBrave/....pt

# 冒烟测试:发一段曲目、录 WAV、校验时长/爆音/underrun,退出码即结论
python3 tools/smoke_client.py --seconds 9 --out staging/smoke.wav
```

每个模块都带自测入口:

```bash
python3 server/config.py          # 配置校验
python3 server/backends/base.py   # 接口契约
python3 server/backends/synth.py  # 跨块连续性(重点)
python3 server/app.py --selftest  # 端到端,不占 8090
```

本机验证过 macOS + Python 3.13 / numpy 2.4 / aiohttp 3.13;`soundfile` 可选
(有就写 float32 WAV,没有就用标准库写 PCM16)。
