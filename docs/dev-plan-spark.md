# 开发规划：Spark 黑客松冲刺 + 长线路标

> 2026-07-16（D0）。Timeline：3 天内核心可运行、5 天内完整双层 demo；  
> 今晚/明日首轮训练，单轮 2 天、预留 2 轮余量。  
> 架构与验收标准见 [双层架构](two-layer-architecture.md)、[PRD](prd-flock-sequencer.md)。

## 1. 仓库收敛策略

当前三个 worktree 的分工与合并顺序：

```text
main（编排层宿主，集成主干）
 ├─ M1: 从 experiment/xy-latent-engine 迁入 src/instrument/（单群视图模块化，不再覆盖 world）
 ├─ M2: 从 codex/pitch-conditioned-brave 合入 research/（decode_pitch facade + lock 文件 + 测试）
 └─ 之后所有新开发以 feature 分支从 main 出，短周期合回
```

- **M1 注意**：xy-engine 实验当初是「替换 world」的独立形态（删了 `world.js`），迁入时改为并存模块——`src/orchestration/`（原 world/app 拆分）+ `src/instrument/`（xy-engine 的 boids/xy-engine/audio 改造），两个 view 由 `app.js` 路由。
- **M2 注意**：pitch 分支 35 个 commit 全是 research/docs，与 main 的 `research/realtime_server.py` 改动可能冲突，合并以 pitch 分支的 `pyproject/uv.lock` 为准跑一遍研究测试。
- 权重、语料、导出物一律不进 Git（既有约定）；跨机传输按 `research/pitch-mvp.lock.json` 的 SHA 校验。

## 2. 契约

按 [双层架构 §2](two-layer-architecture.md) 冻结三份接口，之后四条工作流并行互不阻塞：

1. **Voice Engine API**（note/timbre/pattern/transport）——章江南
2. **Agent Control API**（声部 + master 的 JSON 命令集）——肖玮圣
3. **接管状态机**（AGENT/USER × SCORE/INSTRUMENT）——

## 3. 冲刺排期

### D0（7/16）

- [ ] 冻结三份契约。

- [ ] 服务器上线；胡佳弋核对训练数据需求单，启动 50–100h riff 语料收集/预处理。

- [ ] 训练脚本预埋 pitch-swap 因果闸门：500 step 冒烟即可判定 decoder 是否真用 pitch 条件（复用 pitch 分支 P0-C3 方法与代码）。

- [ ] main 上开 feat/server-sequencer 分支：transport + pattern 调度迁入 realtime server（G1 闸门的前提）。

### D1（7/17）

- [ ] 首轮模型训练启动

- [ ] 编排层：网格量化 + pattern anchor 弹簧力 + 微变化预算；扫描线触发走 server 端，客户端旧触发留 fallback flag。

- [ ] M1 迁移：instrument view 模块化进 main。

- [ ] agent 服务骨架：StepFun 接口 + 命令 JSON 往返打通，先用「每 8 bar 随机换 anchor」的假策略验证链路。

### D2（7/18）

- [ ] 接管状态机 + 声部条 UI + 徽标（G3）。

- [ ] 双击下潜/返回，音频不断流（G4）。

- [ ] M2 合入：decode_pitch 接进 realtime server，后端 B 可选（后端 C 保底已有）。

- [ ] master agent 最小集：BPM/调式/音域分配 + 鼓 lane（采样鼓，8 步 3 行）。

### D3（7/19）

- [ ] 五步 demo 剧本完整走通（PRD §2），G1–G5 全部实测过闸。

- [ ] 首轮训练出结果：pitch-swap 闸门通过 → 接后端 A 试听；不过 → 修数据/超参进第二轮，demo 锁后端 B/C，不等模型。

- [ ] 录屏一版保底 demo。

### D4–D5（7/20–21）

- [ ] 回灌（G5）体验打磨、agent 幽灵轮廓动画、demo 视觉。

- [ ] 30 分钟稳定性压测（G6）+ 拔 agent 韧性测试（G7）。

- [ ] 第二轮训练收尾；若后端 A 达标，替换默认后端并重跑 G1–G6。

- [ ] 与黄弈风的 roadmap/需求文档对齐交付状态。

原则（会议共识）：先单声部核心逻辑可运行，再扩多 agent 协同与层级缩放；一切从极简起步，不超前开发。

## 4. 风险与断路器

| 触发条件 | 动作 |
|---|---|
| D1 结束 pitch-swap 闸门未通过 | 第二轮改用 pitch 分支验证过的 excitation+FiLM 配方，而不是调拼接超参 |
| D2 结束 server-sequencer 抖动不达 G1 | 回退客户端触发 flag，demo 接受较松节拍，G1 移入长线 |
| D3 中午 demo 剧本走不通 | 砍鼓 lane 和 master 自由文本，保「自动循环 + 接管 + 下潜」三件事 |
| StepFun 接口并发/延迟不稳 | agent 命令改离线预生成脚本回放，界面不变（观众无感） |

## 5. 黑客松之后的长线路标

黑客松验证的是交互形态；产品化按既有闸门文化推进：

| 阶段 | 内容 | 硬闸门 |
|---|---|---|
| L1 感知与听测 | 三后端同 session 人耳 A/B；riff 模型音色 Atlas 人工听测命名 | 盲听方向正确率 ≥75%（沿用 roadmap 既有标准） |
| L2 模型主线 | 语料扩容（真实乐器/多奏法）；复音 pitch conditioning；tail/非谐波（原 P0-C6，需新预注册） | pitch-swap + 输出不变性闸门，标准沿用 pitch 分支 |
| L3 原生化 | Voice Engine 移入 JUCE/LibTorch，浏览器只剩 UI | 48 kHz 30 分钟 0 underrun（既有闸门） |
| L4 乐器性 | 5–8 名音乐人两轮测试；录音/工程保存与恢复 | 规则辨认 ≥80%，状态可复现 |
| L5 多人与生态 | 多用户各接管一群（架构已留 controller 字段）；音色社区/Atlas 分享 | 另行预注册 |

长线原则：编排层与声音引擎层的契约（Voice Engine API）是产品最稳的资产——模型可以换代、UI 可以重写、agent 供应商可以更换，契约不动。
