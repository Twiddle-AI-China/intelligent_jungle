# flock-voice-engine

生态/鸟群音序器的音源后端。把 MVP 前端现在的 WebAudio 裸合成换成 midiBrave 神经音源。

**运行环境是 DGX Spark，不在 Mac 上跑**；本仓库只保存代码，权重与渲染产物不进 Git。

## 现状：v2 四音色已切生产（2026-07-21）

生产后端是 `brave-voices`：四条轨固定绑定 bass/pad/lead/pluck 四个音色专用
checkpoint（各 ~98 MB，256D z_timbre），每轨带自己独立的音色漫游地图
（kNN 混合真实 preset，XY 直控）。v1 单声部链路保留作回归基线。

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
  config.py            端口 8090、44100 Hz、2048 样本块、voice 池长度 4
  voices.py            固定长度 voice 池（行绑定，last-note-priority）
  backends/
    base.py            后端抽象，服务层不知道背后是谁
    synth.py           S 档程序合成兜底（零模型依赖）
    brave.py           v1 神经音源（单 checkpoint，回归基线）
    brave_voices.py    v2 四音色后端（生产），行→音色固定绑定 + 每轨漫游地图
    midibrave_backend_v2.py  v2 checkpoint 加载/校验（config_hash 精确匹配）
    streaming.py       逐块流式渲染（v1/v2 共用，条件兼容 v2 的 norm1/norm2）
  assets/timbre/       voice_maps/（每轨漫游地图）+ voice_defaults/（.npy 不进 git）
vendor/midibrave/      v1 模型源码（Spark 侧部署产物，不进 Git）
vendor/midibrave-v2/   v2 模型源码（同上）
client/tracks.html     四轨独立漫游测试页（v2 主力验证页）
tools/                 冒烟/压测/建图/验收脚本（stress_pool4、test_v2_full 等）
docs/                  HANDOFF.md / protocol.md / model-notes.md …
```

## 两条硬约束

**voice 池固定长度、行绑定。** 解码的 batch 维就是声部维；神经后端跨块保持的状态
（条件缓冲、上采样卷积 padding、激励相位）都按 batch 尺寸分配，尺寸一变就重新分配并清零，
结果是所有声部同时被打断、一起爆一下。所以池子常驻固定长度，不发声的声部带 `gate=0`
继续跟着跑，**绝不做「有音就 append、没音就 remove」的动态列表**。

**训练数据边界。** 协议层 note 范围 **31–95**（`server/config.py` 与客户端同步夹紧；
checkpoint 真实训练域更宽，是 21–109，协议层不放开），velocity 只有 **{50, 127} 两档**
（v1/v2 manifest 逐条核实）。前端三档里 0.42 → v50，0.68 与 1.0 → v127 + 增益差分，
**禁止插值**。越界即分布外。

## 从哪开始

**接手先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)** —— 现在在哪、下一步做什么、哪里有坑。

四个入口（服务端同源托管）：

| | |
|---|---|
| `/` | 四棵树前端（`mvp/` 快照），pad 声部走神经音源 |
| `/_client/tracks.html` | 四轨独立漫游测试页：每轨自己的 XY 画布、音量/solo/电平 |
| `/_client/map.html` | v1 音色地图（旧 brave 后端的 1239 preset 平面，仅参考） |
| `/_client/demo.html` | 协议自测台 |

## 相关文档

- 方案：飞书 `E12NddFAYo7f8IxfhXxcifShnch`
- 交接：`midibrave-backend-integration.md`（章江南 2026-07-19 拍板一期形态）
- 训练方案：飞书 `D4VwdGUNpoQOMGxcqs0cYlZ2nRf`（方案A 双分支；注意其中 z_midi 写作 64D，
  实际 checkpoint 是 32D，以 checkpoint 为准）
