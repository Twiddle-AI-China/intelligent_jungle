# Pitch-conditioned BRAVE 研究交接索引

更新：2026-07-16。分支：`codex/pitch-conditioned-brave`。

本文档是 pitch 研究的权威入口。历史文档保留当时的问题、预注册闸门和
失败结论；若与早期“下一步”描述冲突，以本文档和
[`pitch-only-mvp-plan.md`](pitch-only-mvp-plan.md) 为准。

## 当前结论

- 当前产品范围是 **pitch-only**：单音、谐波音色，MIDI pitch/bend 显式
  控制音高，timbre latent 负责音色漫游。
- velocity/gate 是演奏信号，不是研究维度；periodicity 只是底层兼容机制，
  产品 API 自动令 `periodicity=gate`。
- 当前 artifact-locked checkpoint SHA-256 为
  `e655a53daff1bd4e205e2381e62cd4e3c947906c0f2a70c501de15cdb5e92e39`。
- 16 个 harmonic-like 候选中 14 个通过；KINKLY BIT (21594) 与
  ToyOrkstra (54079) 明确不支持。
- brightness/articulation/FaderRAVE、非谐波 tail、复音与 1,778 段真实语料
  scale-up 全部 deferred。
- checkpoint、音色白名单、schema 和导出 SHA 的机器可读 truth source：
  [`../research/pitch-mvp.lock.json`](../research/pitch-mvp.lock.json)。

## 模型尝试历史

| 阶段 | 做了什么 | 结论 | 文档 |
|---|---|---|---|
| BRAVE Phase 1 | 三小时程序化 corpus，1M steps，8/16/32D 导出 | 低延迟 baseline 成立，但无原生 pitch conditioning | [`current-facts-and-plan.md`](current-facts-and-plan.md), [`implementation-status.md`](implementation-status.md) |
| P0-B | BRAVE decoder 加 harmonic/noise excitation 和多层 FiLM；2-step smoke、checkpoint、TorchScript | 训练/导出管线通，不声称 pitch 可控 | [`p0b-training-and-export-plan.md`](p0b-training-and-export-plan.md), [`pitch-conditioned-brave.md`](pitch-conditioned-brave.md) |
| P0-C1 | NCCF 与 pYIN 在有真值合成集上对比 | NCCF 正式淘汰出长训练标注 | [`p0c1-pitch-label-benchmark.md`](p0c1-pitch-label-benchmark.md) |
| P0-C1b | 盘点 Dexed/NSynth/TinySOL，审计受控多音高 render | 得到首个 8-preset / 48-clip renderer-truth pilot | [`p0c1b-real-corpus-pilot.md`](p0c1b-real-corpus-pilot.md) |
| P0-C2 | 普通同条件 reconstruction，2k-step overfit | **失败**：decoder 忽略条件，仍从 latent 读 pitch | [`p0c2-overfit-intervention-result.md`](p0c2-overfit-intervention-result.md) |
| P0-C3 | same-preset/different-note paired pitch swap，encoder 冻结 | 6/8 preset 通过，证明显式 pitch 因果路径成立 | [`p0c3-paired-pitch-swap-result.md`](p0c3-paired-pitch-swap-result.md) |
| P0-C4A | pitch adversary、warm-up/GRL、latent consistency、output invariance | residual probe 未达标；改用 output-level invariance 通过小集闸门，拒绝 scale-up | [`p0c4-next-stage-plan.md`](p0c4-next-stage-plan.md), [`p0c4a-review-and-output-invariance-plan.md`](p0c4a-review-and-output-invariance-plan.md), [`p0c4-scale-readiness-decision.md`](p0c4-scale-readiness-decision.md) |
| P0-C4B | schema-v2 periodicity，tail 采样/课程/短恢复 | 8-preset 候选通过；暴露并修正 encoder BN buffer、随机评测、phase 导出问题 | [`p0c4b-periodicity-conditioning-plan.md`](p0c4b-periodicity-conditioning-plan.md), [`p0c4b-calibration-audit.md`](p0c4b-calibration-audit.md) |
| P0-C5 | 过选 72、审计 verified24，500/50-step 恢复，target-latent oracle | **24-preset 失败**：tail 回归来自 decoder/loss 上限，不是单纯 latent pitch 泄漏 | [`p0c5-24-preset-generalization-plan.md`](p0c5-24-preset-generalization-plan.md) |
| P0-C6 | 原计划做 tail residual + brightness/articulation | **Deferred**；不阻塞 pitch-only MVP | [`p0c6-tail-reconstruction-plan.md`](p0c6-tail-reconstruction-plan.md) |
| Pitch-only MVP | 复用 P0-C5 step-500 artifact，完整审计 16 个 harmonic-like，收口三通道 API | 14 个支持音色通过；offline/streaming 导出和 M4 加载通过 | [`pitch-only-mvp-plan.md`](pitch-only-mvp-plan.md) |

## 当前训练架构

权威张量图与设计解释：

1. [`explicit-pitch-conditioning-architecture.md`](explicit-pitch-conditioning-architecture.md)：完整训练图、
   推理图、excitation/PQMF/FiLM 注入点和 TorchScript 张量形状。
2. [`training-inference-architecture-review.md`](training-inference-architecture-review.md)：对内部
   “`z_midi + z_timbre` 拼接”图的逐项评审，以及为什么采用显式
   excitation + multi-scale FiLM。
3. [`pitch-conditioned-brave.md`](pitch-conditioned-brave.md)：schema-v2、BRAVE/P-RAVE 对齐、
   训练器接入和历史实验事实。
4. [`p0b-training-and-export-plan.md`](p0b-training-and-export-plan.md)：最初训练/导出实现计划，
   作为管线审计记录，其 v1 接口描述是历史快照。

当前训练路径简化为：

```text
source render -> frozen BRAVE encoder -> z_timbre -----------------------+
target MIDI truth -> [f0, loudness, gate, periodicity] -> excitation/PQMF + FiLM
target render -----------------------------------------------------------> losses
                                                                         |
                                                    BRAVE decoder -> waveform
```

paired pitch-swap 使 source 和 target 为同 preset 不同 note，迫使 decoder 使用 target
pitch condition。encoder 参数与 BN buffers 都严格冻结。

## 当前推理架构

```text
MIDI note/bend -> f0_hz --------+
velocity ------> target RMS ----+-> decode_pitch -> internal periodicity=gate
gate ---------------------------+          |
timbre atlas/latent ---------------------> BRAVE decoder -> waveform
```

- 产品接口：`decode_pitch([z_timbre, f0_hz, loudness, gate])`。
- 底层审计接口：`decode_conditioned([z_timbre, f0_hz, loudness, gate, periodicity])`。
- 两者在 `periodicity=gate` 时逐样本一致。
- oscillator phase 存在 TorchScript buffer 中，已验证 batch=1 跨 block 连续。
- timbre 输入应来自 encoder atlas 上的节点/局部插值，不应用无约束
  `G(boids)` 生成分布外 latent。

## 交接验证

```bash
cd research
uv run --extra rave --extra analysis python -m unittest discover -s tests -v
cd ..
npm test -- --run
```

当前基线：60 项研究测试 + 12 项前端测试全绿。模型权重与导出物被
`.gitignore` 排除，不会随 Git 推送；交接时依据 lock 文件 SHA 从授权存储另行传输。

## 后续开发边界

1. 可以继续：host 接入 `decode_pitch`、14-preset timbre bank/atlas、MIDI bend/gate/
   velocity 产品集成、听测和长时 streaming 稳定性。
2. 需新预注册才能继续：重训 checkpoint、扩音色库、解冻 encoder、复音、
   真实语料 scale-up。
3. 当前不做：brightness/articulation descriptor、FaderRAVE discriminator、
   tail residual decoder。
