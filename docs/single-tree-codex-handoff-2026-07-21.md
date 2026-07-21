# 单树 UI + 律动优化 — Codex 交接

> **2026-07-21 后续更新：**本文的 tip 和首轮 P0–P2 队列已是历史交接快照。当前完成度以 `docs/single-tree-refactor-backlog-2026-07-21.md` 为准。**旧 Bass runner 5–9 / walk 契约已退役，现行硬契约是四声部统一 0–4 音高枝 × 16 步。**

> 更新：2026-07-21 · 给 Codex（主开发）的可执行交接。  
> 负责人上下文：江南已确认方向；当前分支已 push；Spark 已部署一版。  
> 凭据不落本文（SSH / LibTV / API key 用本机已有配置）。

## 0. 一页速览

| 项 | 值 |
|---|---|
| 分支 | `feat/single-tree-ui`（已跟踪 `origin/feat/single-tree-ui`） |
| Tip | `46bb8bd` — `feat(mvp): 单树纵向 UI 与生产贴图接入` |
| 基线 | 从 `feat/four-trees` @ `a7589ad` 切出，**当时工作区未提交改动全部继承** |
| 本地 | `npm run serve:mvp` → http://localhost:4193/mvp/ |
| Spark | `/home/jnzhang/deploy/latent-cosmos-synth`，`python3 -m http.server 8099` → http://192.168.9.140:8099/ |
| 规格 | `docs/single-tree-ui-design-2026-07-21.md` |
| 素材 Prompt | `docs/single-tree-asset-prompts-2026-07-21.md` |
| 剩余清单 | `docs/single-tree-remaining-work-2026-07-21.md`（本文更权威、可派工） |

**重要：** 当前 tip **一个 commit 混装了两件事**：

1. 单树纵向 UI（壳 / 相机 / 年轮 / 贴图）
2. 此前未提交的律动 / musicality / Bass runner 优化

合并 `main` 前建议拆线；日常修观感可以先在本分支继续。

---

## 1. 已完成（不要重做）

### 1.1 UI / 渲染

- 单树世界坐标 + `viewportY` 相机：`mvp/src/scene-layout.js`
- Canvas 渲染 / 命中 / 年轮：`mvp/src/renderer.js`
- 页面壳：HUD、声部定位器、右侧 drawer、viewport 输入：`mvp/index.html`、`mvp/src/main.js`、`mvp/src/ui/*`
- 生产贴图已接入：`mvp/assets/single-tree/` + `config.visual.singleTree`
- 相关测试：`mvp/test/scene-layout.test.js`、`ui-*.test.js`、`renderer-layout.test.js` 等

### 1.2 继承的律动 / musicality（来自切分支前未提交改动）

对照 `feat/four-trees`，本分支还包含：

| 文件 | 内容摘要 |
|---|---|
| `mvp/src/audio.js` | Bass 音色加厚（二次谐波等） |
| `mvp/src/harmony.js` / `mapping.js` | 声部菜单放宽；Bass runner → 和弦音；西端根音偏好 |
| `mvp/src/world.js` | Bass 横向 runner 槽；邻节点 `walk`；驻留统计含 walk |
| `mvp/src/agent.js` + 测试 | 配套 |
| `docs/musicality-depth-plan-2026-07-20.md` | 律动深化计划 |
| `docs/wave2-bass-runner-report-2026-07-20.md` | Bass runner wave2 报告 |

**不要把这些当“UI 误改”删掉。** 若要拆 commit，用 `git rebase` / 新分支拣文件，勿 reset 丢历史。

### 1.3 素材管线

- 锁定原图目录（本地大文件，**不入库**）：`mvp/assets/generated/`（已 `.gitignore`）
- 运行时用：`mvp/assets/single-tree/`（已入库，~16MB）
- LibTV 画布：`单树UI素材 2026-07-21`（UUID `57d4895bb0aa4014af105a61daf48f13`）
- 模型路由见素材 Prompt 文档；账户无 GPT Image 2.0，主用 `Lib Image` / `Seedream 5.0 Pro`

---

## 2. Codex 优先任务队列（建议按序）

### P0-A — 实机观感校准（先做）

目标：打开 Spark 或本地页面，让树干/枝群/鸟/年轮「看起来对、点得中」。

可调参数（`mvp/src/config.js` → `visual.singleTree`）：

- `trunkDrawWidthRatio`（默认 `0.22`）
- `branchHeightRatio`（默认 `0.72`）

代码落点：

- 树干拼接 / 枝群绘制 / 鸟姿态 / 年轮底：`mvp/src/renderer.js`（`drawTrunk` / `drawBranchCluster` / `drawBirdSprite` / `drawRings`）
- 枝点与 Sequence 世界坐标：`mvp/src/scene-layout.js`（命中与贴图要对齐）

验收：

- 四声部上下滚动连续，无明显「四棵树拼接」
- 点枝 / 点鸟 / 拖年轮仍符合既有契约（见规格 §2）
- 窄屏 ~390 与桌面都能操作年轮

### P0-B — 拆分 commit / 合并策略（合并 main 前）

目标：把 UI 与 musicality 拆开，避免 review/回滚绑死。

这一节只记录当时的拆分建议，现已失效：相关音乐性代码已经合并，旧 Bass runner 也已退役。后续不要再从历史分支拣 runner / walk 实现。

**未授权不要 `--force` push。**

### P0-C — 树顶 / 树根收束段（已完成）

规格与 Prompt 已在 `docs/single-tree-asset-prompts-2026-07-21.md`（crown / root）。

已生成并接入 `tree-trunk-crown-cap.png` / `tree-trunk-root-cap.png`；cap 在后景，连续 `trunk-main` 覆盖中部接缝，不恢复分段 variant 拼接。

### P1 — 素材精修

1. ~~**Bass / Pad 枝群重做**~~：已接入五层独立音高枝 v2，每枝承载 16 步时间线。
2. ~~Alpha 边缘精修~~：v2 经过 soft matte / despill。
3. ~~Bass 鹈鹕栖姿去掉烘焙小枝~~：左右栖姿 v2 已完成。
4. 可选：季节叠加层、树皮颗粒（不阻塞首版）

### P2 — 验收与工程

1. 贴图加载后的桌面 + 窄屏实跑清单（可参考 `mvp/test/ui-acceptance-f1f2f3.test.js` 的 F1/F2/F3 精神，但要真浏览器）
2. 开 PR（标题/正文说明 UI + 混入的 musicality，或拆完再 PR）
3. Spark 再部署：rsync `mvp/` → `/home/jnzhang/deploy/latent-cosmos-synth/`（排除 `local-config.js`、`assets/generated/`）

---

## 3. 硬约束（Codex 必守）

### 3.1 玩法契约（规格 §2）

- `world.getSnapshot().trees` 仍四逻辑树
- 命中仍返回 `{ type, treeId, branchId, birdId }`；`ring` 为新增类型
- 相机移动 **不得** `setTreeControl` / `setZoomFocus`
- 显式接管才切 USER + audio focus
- 四声部 branchId / pitchBranchId 统一 **0–4**；时间只用 stepIndex 0–15
- Mute/Solo 只影响播放层

### 3.2 文件习惯

- 颜色仍走 `config.visual` 三 token（paper / ink / accent）
- 大原图只放 `mvp/assets/generated/`，不提交
- 不改 `mvp/local-config.js`（gitignore）
- 不把 `.libtv/` 提交进仓库

### 3.3 测试

```bash
cd mvp && node --test test/*.test.js
# 或至少：
node --test test/scene-layout.test.js test/renderer-layout.test.js \
  test/ui-camera-ring-integration.test.js test/ui-acceptance-f1f2f3.test.js \
  test/audio.test.js test/world.test.js test/mapping.test.js test/harmony.test.js
```

改 musicality 必跑 audio/world/mapping/harmony；改 UI 必跑 scene-layout + ui-*。

---

## 4. 关键代码地图

| 职责 | 路径 |
|---|---|
| 单树布局 / 相机纯函数 | `mvp/src/scene-layout.js` |
| 绘制 + hitTest + 年轮值 | `mvp/src/renderer.js` |
| 装配 / 事件 / 接管 | `mvp/src/main.js` |
| 贴图路径 | `mvp/src/config.js` → `visual.singleTree` |
| Drawer / 定位器 / 滚轮触摸 | `mvp/src/ui/*` |
| Sequence / 五层音高映射 | `mvp/src/sequence.js` + `world.js` + `mapping.js` |
| 音色 | `mvp/src/audio.js` |
| 和声菜单 | `mvp/src/harmony.js` |

---

## 5. 已知问题 / 坑

1. ~~**Bass / Pad 枝群贴图结构弱**~~：五枝 v2 与 layout 锚点已对齐。
2. **透明底靠后处理**：模型出纸色底；运行时 PNG 已是 RGBA，但边缘可能脏。
3. **飞鸟姿态**：角色板 2×2 假定左下=飞朝左、右下=飞朝右；若重切表需同步 `drawBirdSprite`。
4. **Spark 8099** 主要是内网；外网 SSH 用 `spark-natapp`（`~/.ssh/config`）。静态资源更新后一般不用重启 http.server；若进程挂了：

```bash
ssh spark-natapp
tmux kill-session -t lcs 2>/dev/null || true
tmux new-session -d -s lcs \
  "cd /home/jnzhang/deploy/latent-cosmos-synth && exec python3 -m http.server 8099 --bind 0.0.0.0 >/home/jnzhang/deploy/lcs-server.log 2>&1"
```

5. **历史范围混杂**：早期 commit 曾把 UI 与已退役的 runner 改动混在一起；review 当前实现应以统一 0–4 音高枝契约为准。

---

## 6. 建议 Codex 第一回合（最小闭环）

1. 读完：`docs/single-tree-ui-design-2026-07-21.md` §1–§4、§6；本文 §2–§5
2. 本地 `npm run serve:mvp`，对照 Spark 页记 3–5 条观感问题
3. 只改 `config.visual.singleTree` + 必要的 `renderer.js` / `scene-layout.js` 对齐
4. 跑 §3.3 测试
5. 给江南：截图/简述 + 是否需要拆 musicality 分支

**不要一上来重做整棵树或重写 world。**

---

## 7. 回滚与对照

```bash
# UI+律动一体 tip
git show 46bb8bd --stat

# 相对四树基线的全部差
git diff a7589ad...feat/single-tree-ui --stat

# 只看律动相关
git diff a7589ad...feat/single-tree-ui -- \
  mvp/src/audio.js mvp/src/harmony.js mvp/src/mapping.js \
  mvp/src/world.js mvp/src/agent.js
```

---

## 8. 文档索引

| 文档 | 用途 |
|---|---|
| `docs/single-tree-ui-design-2026-07-21.md` | 产品/交互/实现边界（事实源） |
| `docs/single-tree-asset-prompts-2026-07-21.md` | 生图 Prompt 与模型路由 |
| `docs/single-tree-remaining-work-2026-07-21.md` | 短清单（可与本文对照） |
| `docs/musicality-depth-plan-2026-07-20.md` | 律动深化计划 |
| `docs/wave2-bass-runner-report-2026-07-20.md` | Bass runner 报告 |
| `mvp/assets/single-tree/README.md` | 运行时贴图说明 |
| `mvp/assets/generated/locked/LOCK.md` | 本地锁定原图索引（若机器上还有 generated） |
