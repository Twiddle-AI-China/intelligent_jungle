# Sequence v2 可执行规格

日期：2026-07-21

## 坐标契约

四个声部共用同一种二维地址：

```js
{ treeId, pitchBranchId, stepIndex }
```

- `pitchBranchId`：纵向音高轴，`0` 为最低枝，向上递增。
- `stepIndex`：时间轴，枝根为第 0 步，向枝梢递增。
- 默认每声部 5 条音高枝；当前 4 小节 × 4 拍对应 16 个时间步。
- Pad / Melody / Bass / Texture 的差异只属于生成和发声策略，不改变网格形状。

实现位于 `mvp/src/sequence.js` 及 world/agent/audio/renderer 接线；已完成全链路迁移。

## 旧契约兼容

- 旧纵枝 `branchId 0–4` 直接映射到同号 `pitchBranchId`，`stepIndex` 取事件发生时的整日 phase。
- 旧 Bass runner `branchId 5–9` 已删除，兼容桥对这些地址返回 `null`。
- 新原生事件显式携带 `pitchBranchId + stepIndex`，mapping/audio 优先消费该对坐标。

## 分阶段验收

1. 纯数据：四声部生成相同的 `5 × 16` 网格，播放头随 phase 线性循环。
2. 映射与音频：发声优先读取 `pitchBranchId`，`stepIndex` 不改变音高；旧 perch 事件缺少新字段时回退 `branchId`。（已完成兼容入口）
3. 渲染与交互：每条枝沿根→梢绘制 16 个时间节点并显示播放头；USER 可直接写格。（已完成）
4. World / Agent：规则/LLM/USER 写 cell，world 按格生成真实 perch/audio，dayReview 消费网格。（已完成）
5. 收尾：删除 Bass `5–9` runner，recorder/evaluator/crossVoice 读统一网格。（已完成）

## 本阶段硬边界

- 不重写当前四树 world。
- 不改变现有 `{ type, treeId, branchId, birdId }` 命中和事件契约。
- 不恢复 Bass runner 或任何超出 0–4 的声部特殊枝地址。
- 不让时间节点决定音高，也不让音高枝决定时间。
