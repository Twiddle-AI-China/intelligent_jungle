# 单树纵向 UI 重构规格

状态：已对齐，进入实现  
日期：2026-07-21  
视觉参考：用户手绘草图及 2026-07-21 第二版概念图

## 1. 已确认的产品边界

1. 画面中只有一棵纵向连续的大树。
2. 底层仍保留 `pad`、`melody`、`bass`、`texture` 四个逻辑 tree/voice；不合并 world 数据模型。
3. 每个声部是树干不同高度上的一个单侧枝群，相邻枝群左右交替。
4. 用户通过滚轮、触控拖动、键盘或左侧声部定位器上下移动相机。
5. 移动相机只浏览；点击枝群或“接管”才切换 USER。浏览不得冻结 Agent，也不得改变混音。
6. 每个声部枝群拥有固定的一组 EQ / FX / Volume 年轮。
7. EQ 年轮的三层分别映射现有 low/mid/high EQ；FX 映射现有 `reverbSend`；Volume 映射现有声部 `gain`。
8. 四声部统一使用 branchId / pitchBranchId 0–4，每条枝根→梢为 16 步时间轴。
9. “无限树”仅是视觉连续与相机体验；世界仍只有四个有限声部区。

## 2. 不得改变的逻辑契约

- `world.getSnapshot().trees` 仍返回四个逻辑树。
- 枝鸟命中仍返回 `{ type, treeId, branchId, birdId }`。
- `world.userPlaceOnBranch()`、`world.userShooBird()`、`world.setTreeControl()` 的语义不变。
- Mute/Solo 仍只影响播放层，不停止鸟群、Agent 或生态统计。
- 普通相机移动不得调用 `world.setTreeControl()` 或 `audio.setZoomFocus()`。
- 显式接管声部时才同步 USER/AGENT 与 `audio.setZoomFocus(treeId)`。
- Harmony、mapping、agent、economy、recorder 的数据接口保持不变。

## 3. 单树世界坐标

推荐从上到下排列：

| 声部 | 枝群方向 | 交互结构 |
|---|---|---|
| Pad | 右 | 五层长枝，允许和弦式多鸟栖落 |
| Melody | 左 | 五层短枝，强调单鸟跳动 |
| Bass | 右 | 五条偏厚的低音枝，共用 0–4 音高枝 × 16 步时间轴 |
| Texture | 左 | 五层不规则短枝 |

- 每个声部拥有固定 `worldY` 中心与 `bandHeight`。
- Renderer 中所有树、枝、鸟、年轮位置先以世界坐标计算，再通过 `screenY = worldY - viewportY` 投影。
- 相机在声部中心附近吸附，但滚动过程中允许连续位置。
- 画布外声部可以不绘制；不可删除其 world/audio 状态。
- 树干必须在相邻声部间视觉连续，不出现四棵树拼接痕迹。

## 4. 年轮控件

每个声部固定三枚年轮，位于该声部枝群附近的树干：

- EQ：三层可交互环，内/中/外分别控制 low/mid/high gain。
- FX：单环控制 `reverbSend`。
- Volume：单环控制 `gain`。
- 环上橙红弧表示值；默认静止为靛蓝线稿。
- 年轮必须有 DOM/Canvas 可访问名称、数值和键盘调整入口。
- 右侧面板可显示精确数值，但不得默认再放一套重复滑杆。

## 5. 页面信息架构

### 5.1 常驻

- 顶部 HUD：Day、小节/拍、阶段、季节、和弦、BPM、播放/暂停、录制。
- 左侧声部定位器：Pad / Melody / Bass / Texture、当前视口声部、上下移动提示。
- Canvas：树干、枝群、年轮、鸟、发声反馈、接管状态。
- 右侧信息页 toggle：常驻窄标签；展开后覆盖舞台，不压缩 Canvas 世界坐标。

### 5.2 右侧信息页

分为四区：

1. 当前声部：名称、AGENT/USER、接管/释放、meter、Mute、Solo、年轮精确值。
2. 生态：上一日总分、和谐与分项指标；明确“上一日结算”。
3. 决策历史：合并原时间线与决策日志，默认只显示结构化 plan/apply/master。
4. 设置/诊断：LLM 状态、API Key、录制/Provider 错误及可选 Debug 事件。

### 5.3 删除或合并

- 删除隐藏的旧 `#transport`。
- 日历、和弦、BPM、暂停、录制合并到顶部 HUD。
- 删除常驻四条 mixer card；只呈现当前声部。
- 删除常驻 pattern 枝位列表；Canvas 是唯一主表达。
- 删除四树栖鸟数量汇总。
- 合并 timeline 与 decision log；逐鸟 perch/unperch 仅进入 Debug 过滤。
- UI 枝编号统一为 1-based，内部 branchId 不变。

### 5.4 Toggle 行为

- 桌面：宽 320–360px 的 overlay drawer，不改变 Canvas 尺寸与相机。
- 收起：只保留窄标签和展开按钮。
- 移动端：底部 sheet。
- 支持按钮和 Escape；使用 `aria-expanded` / `aria-controls`。
- 记忆上次展开状态；面板开关不得影响播放、接管或世界更新。

## 6. 实现边界

### Worker A：Canvas / 相机 / 命中（Kimi）

允许修改：

- `mvp/src/renderer.js`
- `mvp/test/renderer-layout.test.js`
- 可新增 `mvp/src/scene-layout.js`
- 可新增 `mvp/test/scene-layout.test.js`

禁止修改：

- `mvp/index.html`
- `mvp/src/main.js`
- `mvp/src/config.js`
- world/audio/agent/harmony/mapping/economy/recorder/timeline

对外契约：

- Renderer 继续兼容现有 `render`、`resize`、`hitTest`、`flash`、焦点读取接口。
- 可新增相机接口：`setViewportY`、`getViewportY`、`moveViewportBy`、`focusVoice`、`getVisibleVoice`。
- 旧 `computeTreeLayout` 的导出若被测试使用，保留兼容包装或明确迁移测试。

### Worker B：页面外壳 / 信息去重 / Toggle

允许修改：

- `mvp/index.html`
- `mvp/src/main.js`
- 可新增 `mvp/src/ui/` 下文件
- 可新增对应 DOM 单元测试

禁止修改：

- `mvp/src/renderer.js`
- `mvp/src/config.js`
- world/audio/agent/harmony/mapping/economy/recorder
- Worker A 的新增文件

对外契约：

- 先按 Renderer 相机接口接线；接口暂不可用时做存在性保护，不自行修改 Renderer。
- 右侧 drawer 只整理展示，不更改业务数据来源。
- 年轮的 Canvas 交互由 Worker A 负责；右侧仅显示/同步当前值。

## 7. 验收

- 画面始终被识别为一棵连续树，无四宫格、无四棵独立树。
- 四个声部可通过滚动、拖动、键盘和定位器到达。
- 滚动不切 USER；显式接管后行为与现有特写 USER 一致。
- 四个声部各自拥有固定 EQ / Reverb / Volume 年轮。
- Bass 保留低音音色、根音偏好与换季迁移；旧 runner 5–9 / walk 行为已由 Sequence v2 取代。
- 右侧信息页可隐藏/显示，隐藏后不改变 Canvas 布局。
- 重复状态、pattern、双份日志不再常驻。
- 现有测试保持通过，并新增相机、声部吸附、drawer 与显式接管测试。
- 1280×720 与 390px 宽度均可操作。

## 8. 否决记录

- 否决“四棵宇宙树 + 中央宇宙核心”：与草图不符。
- 否决底层真正合并为一个 world tree：会破坏声部、和声与 Agent 独立性。
- 否决滚动自动 USER：浏览行为不应冻结 Agent 或改变混音。
