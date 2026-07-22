# Wave2 C · 贝斯横向枝走位音序器 — worker report

> 历史报告：本 runner 5–9 / walk 实现已于 2026-07-21 被 Sequence v2 统一 5×16 网格取代，不再是现行契约。

任务：`task_5b37ce3a6bec` · dispatch `ctx_4a8e8b58cf81` · 2026-07-20

## 做了什么（C1–C6）

- **C1** `config.js` + `world.js`：`tree.runners` 横向枝；bass `useRunners` 挂 5 个节点槽（branchId 5–9，西→东）；纵向五枝保留。
- **C2** `world.js`：runner 上驻留到期 → 吸拍后以 `walkProbability` 迈邻节点（`cause:'walk'`）；不耗 `switchQuota`；`walkProbability=0` 则续栖=单音。
- **C3** `mapping.js`：runner→和弦音；西端 `nodeIndex=0`→根音；world 只给 id。
- **C4** 鹈鹕 `birdCount: 5`；`bassRootBranchWeights` 经 `pushBranchPreferences` 软偏西端。
- **C5** bass timbre：二次谐波 + 更快起音 + lowpass 420→1400Hz。
- **C6** `renderer.js`：水平 runner 线 + 节点圆点；栖鸟落在节点上。

## 验收

### 1. 单测
`node --test 'mvp/test/*.test.js'` → **236 pass / 0 fail**

### 2. Eval（空格 `--seed`）+ bass before/after

| seed | bass perch onsets before→after | walks before→after | mean IOI (s) before→after |
|------|-------------------------------:|-------------------:|--------------------------:|
| 4997971 | 9 → **65** | 0 → **26** | 39.96 → **5.94** |
| 42 | 9 → **48** | 0 → **20** | 39.78 → **8.03** |
| 12345 | 6 → **54** | 0 → **22** | 73.83 → **6.96** |

（before = 旧低枝+2鸟+无 walk；after = runner+5鸟+迈步。24 天、同 seed。）

F 口径（节选）：
- seed 4997971：H'均值 F=0.767；行为分 F≈0.96；**bass损失=0**；`audibleModes.bass=pulse`（非隐藏琶音）
- seed 42 / 12345：H'与行为分 F≥C≥R 主序成立；bass 具身损失 0、mode=pulse

### 3. 现象证据
- runner 横向枝可见（`runnerAnchors` + overlay）
- 鹈鹕 `cause:'walk'` 逐节点迈步（单测覆盖）
- 西端根音偏置（`noteFromBranch(5)=notes[0]`）
- `walkProbability=0` → 零 walk（单鸟静止=单音）
- 多鸟不同节点 → groove 从站位+迈步涌现

### 4. 未 commit（江南统一验收）

## 分层铁律
world 只认 `branchId` / `isRunner` / `nodeIndex`；音高仅 mapping；无 onset 硬量化网格、无句法模板、无隐藏琶音器。
