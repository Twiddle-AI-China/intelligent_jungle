# flock-voice-engine

生态/鸟群音序器的音源后端。把 MVP 前端现在的 WebAudio 裸合成换成 midiBrave 神经音源。

**运行环境是 DGX Spark，不在 Mac 上跑**；本仓库只保存代码，权重与渲染产物不进 Git。

## V1 范围

单声部（pad），checkpoint 用 `midibrave-full-c9-phase1-step-000075365`。四声部是 V2 —— 
两者的差别只是 voice 池长度从 1 变成 4。

## 分层

```
生态层 + 映射层        浏览器（sim.js 冻结，映射层唯一实现）
音乐底层契约  ── WS ──→ Spark :8090  本服务
                        sequencer + voice 池 + 神经 decoder
                        ←── 二进制 float32 PCM
声部总线/混响/EQ/昼夜宏  浏览器（已有，与音源解耦）
```

**服务端只替换 engine（音源）这一层**，不做 master / 混响 / EQ / 昼夜宏 —— 前端已有这些层，
且它们的设计就是与音源解耦的，换音源不该丢掉它们。

## 目录

```
server/
  app.py               aiohttp 服务：/healthz /api/decoder-status /decoder(WS)
  config.py            端口 8090、44100 Hz、1024 样本块、voice 池长度
  voices.py            固定长度 voice 池（行绑定，last-note-priority）
  backends/
    base.py            后端抽象，服务层不知道背后是谁
    synth.py           S 档程序合成兜底（零模型依赖）
    midibrave_backend.py   神经音源
vendor/midibrave/      从 Octopus docker 镜像抽出的模型源码（权重不进 Git）
tools/smoke_client.py  最小自测客户端
docs/                  protocol.md / model-notes.md / bench.md
```

## 两条硬约束

**voice 池固定长度、行绑定。** 解码的 batch 维就是声部维；神经后端跨块保持的状态
（条件缓冲、上采样卷积 padding、激励相位）都按 batch 尺寸分配，尺寸一变就重新分配并清零，
结果是所有声部同时被打断、一起爆一下。所以池子常驻固定长度，不发声的声部带 `gate=0`
继续跟着跑，**绝不做「有音就 append、没音就 remove」的动态列表**。

**训练数据边界。** Serum 语料，note 范围 **31–95**，velocity 只有 **{50, 127} 两档**。
前端三档里 0.42 → v50，0.68 与 1.0 → v127 + 增益差分，**禁止插值**。越界即分布外。

## 从哪开始

**接手先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)** —— 现在在哪、下一步做什么、哪里有坑。

三个入口（服务端同源托管）：

| | |
|---|---|
| `/` | 四棵树前端（`mvp/`），pad 声部走神经音源 |
| `/_client/map.html` | 音色地图，1239 个 preset 的可拖动平面 |
| `/_client/demo.html` | 协议自测台 |

## 相关文档

- 方案：飞书 `E12NddFAYo7f8IxfhXxcifShnch`
- 交接：`midibrave-backend-integration.md`（章江南 2026-07-19 拍板一期形态）
- 训练方案：飞书 `D4VwdGUNpoQOMGxcqs0cYlZ2nRf`（方案A 双分支；注意其中 z_midi 写作 64D，
  实际 checkpoint 是 32D，以 checkpoint 为准）
