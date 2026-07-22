# P0-C1：Pitch label benchmark

## 决策

**P0-B 使用的 on-the-fly NCCF 只保留为管线 smoke 工具，不得用于正式长训练。**

下一候选是离线预计算 pYIN 标注。pYIN 已通过合成集的音高精度部分，但其
voiced/unvoiced 边界和当前 128-sample RMS gate 仍未通过全部阈值；必须先做真实
语料审计，不能据此直接启动 P0-C 长训练。

```text
NCCF on-the-fly
  └─ synthetic pitch benchmark: FAIL

pYIN offline precompute
  ├─ pitch cents/octave: PASS
  └─ voicing + RMS gate: NEEDS REAL-CORPUS AUDIT
```

## 评测对象

评测调用与训练完全相同的 NCCF 提取路径，并用同一套真值信号对照 pYIN：

- 44.1 kHz，128 samples/conditioning frame；
- MIDI 36–84，并补充 MIDI 45/69 的 note-on/off transition；
- sine、saw、odd harmonics、missing fundamental 四种谐波谱；
- target RMS 0.04 与 0.12；
- silence、white noise、low-pass noise；
- 共 79 个 case、15,168 帧。

阈值在运行前固定为：median ≤25 cents、P95 ≤50 cents、gross pitch error ≤1%、
voiced recall ≥95%、unvoiced false positive ≤5%、gate error ≤1%。`gross pitch
error` 定义为绝对误差 ≥600 cents；`octave error` 记录误差是否落在
±100 cents 的整数八度邻域。

## 结果

| 指标 | 当前 NCCF | 离线 pYIN | 阈值 |
|---|---:|---:|---:|
| median absolute cents | 1199.37 | 5.00 | ≤25 |
| P95 absolute cents | 3368.93 | 15.00 | ≤50 |
| gross pitch error | 64.07% | 0.00% | ≤1% |
| octave error | 45.34% | 0.00% | 记录项 |
| voiced recall | 96.75% | 100.00% | ≥95% |
| unvoiced false positive | 66.49% | 5.47% | ≤5% |
| gate error | 3.01% | 3.01% | ≤1% |

NCCF 的失败不是轻微调音误差：从 MIDI 60 开始大量向下误判一个或多个八度。
例如 261.63 Hz 的中位预测约为 133 Hz，392 Hz 的中位预测约为 196 Hz，
783.99 Hz 的中位预测约为 196 Hz。将 NCCF `frame_time` 从当前 2.9 ms 改为
10–40 ms、median window 改为 3–30 帧后，整八度误判仍然存在，因此不能仅靠
放大分析窗口修复。

对无音高但有能量的信号，NCCF 将 white noise 的 100% 和 low-pass noise 的
99.48% 帧错误赋予某个 f0。当前 `gate = RMS > floor` 只表示“有声音”，不能充当
voicing detector。

pYIN 的音高精度已经足以进入下一轮候选，但 5.47% unvoiced false positive 略高于
预设阈值；其中包含分析窗跨越 note-on/off 边界的情况。gate error 来自当前仅
128 samples 的局部 RMS：低频波形的单帧能量会随相位越过阈值，即使真实 gate
始终开启。两项都需要在真实语料上制定边界容差并评估更长的能量包络窗。

## 复现

```bash
cd research
uv run --extra rave --extra analysis lcs-pitch-label-benchmark \
  --output ../reports/p0c1-pitch-label-benchmark.json
```

生成报告属于实验产物，按仓库规则不提交；报告包含各谐波类别和各 MIDI note 的
分项指标、依赖版本、固定阈值与机器信息。代码入口为
`latent_cosmos_research.pitch_label_benchmark`。

## 下一道闸门

在 pitch intervention 之前先完成 `P0-C1b`：

1. 离线预计算 pYIN `f0 + voiced probability`，不在训练 step 内实时分析；
2. 从真实训练 corpus 分层抽样，人工检查 pitched、breathy/noisy、attack、release；
3. 比较 pYIN voiced threshold 与独立 voicing detector；
4. 将 gate 改为较长窗口的能量包络候选，并明确 transition tolerance；
5. 固化 label artifact 的 schema、sample/frame alignment 和 corpus hash。

只有真实语料 voicing/gate 审计通过后，才允许生成正式训练标签并进入固定 latent 的
pitch intervention。
