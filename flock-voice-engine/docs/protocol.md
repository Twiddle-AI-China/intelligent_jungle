# flock-voice-engine 服务协议

给前端对接用。与 Latent-Cosmos 基线**线兼容**,已有 worklet 改个 URL 就能接;
本项目额外加了 `note` 帧(见 [§4.2](#42-note--本项目新增)),这是 perch/unperch
语义需要的那条路。

- 默认地址:`http://<host>:8090`
- 采样率 44100 Hz,块 1024 样本(23.22 ms)
- 端口 8090 是硬约束:Spark 上 8081/8083/8086/4173 等已被占用

---

## 1. 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/healthz` | 存活探针,返回 `{"ok":true,"backend":"synth-s"}` |
| GET | `/api/decoder-status` | 后端自述,连 WS 之前先探这个 |
| WS  | `/decoder` | 音频流。`binaryType = "arraybuffer"` |

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
  "controlSchemes": ["control", "note"],
  "timbres": ["bass", "pad", "lead", "pluck"],
  "serverSideMastering": false
}
```

`poolSize` 决定合法的 `voice` 行号范围(`0 … poolSize-1`)。**V1 是 1**,V2 是 4。
越界的行号会被静默丢弃 —— 不会扩容,理由见 §6。

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
| 4096–12288 帧 | 比例控制,6000 帧处取 1.0 | 稳在 6000 帧附近 |
| > 12288 帧 | 1.2 | 减速让客户端消费 |

服务端会把你上一次的回报**外推到当下**(它知道回报之后自己又发了多少帧、过了
多久),所以 0.74 s 的回报周期不会造成超调。实测稳态水位 **122 ms,峰谷差 7 ms**。

> 早期版本直接用回报原值,盲区里会冲出 0.48 s 超调,水位在 80–525 ms 之间锯齿,
> 峰值超出延迟预算。现在这版已修。

端到端单音延迟实测约 **120–160 ms**,在 100–300 ms 预算内。

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

texture 声部不走本服务,保留前端的 WebAudio granular。

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

换到神经后端(`brave`)后音色由 CLAP 音色向量决定,`timbre` 字段的语义会变,
届时另行说明。协议本身不变。

---

## 9. 训练域边界(硬约束)

神经后端只在这个范围内可信,服务层会**夹紧**而不是报错:

- **MIDI 31–95**,越界夹紧
- **`durationSeconds` 0.25–6.0**,越界夹紧
- velocity 训练时只有 `{50, 127}` 两档。前端三档(0.42 / 0.68 / 1.0)的映射
  (0.42→v50,0.68 与 1.0→v127 + 增益差分,**禁止插值**)由 brave 后端内部处理,
  协议层照常传 0–1 连续值。

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
