# timeline.js 挂载说明

Phase 2 决策时间线面板（只读历史列表，无过滤器/搜索/导出）。

```js
import { createTimelinePanel } from './timeline.js';

const panel = createTimelinePanel({
  container: document.getElementById('decision-log'), // 侧栏容器
  maxDays: 14,                                        // 可选，默认保留最近 14 天
});

// 每条 agent 决策落地处调用：
panel.appendDecision({
  day,                    // 第几天（同日条目归一组）
  actor: 'flock',         // 'flock' | 'master'
  flockId: 0,             // actor 为 flock 时可选
  source: 'llm',          // 'rule' | 'llm' | 'external' → 徽标 规则/LLM/外部
  action: 'mutateHomeBranch',
  reason: '……',           // 超 60 字自动截断，点击展开/收起
  score: 0.83,            // 可选，目前不展示
});
```

- 无 `document` 或无 `container` 时 `createTimelinePanel` 返回 `null`（不 throw），
  node 环境可安全 import 纯函数 `formatDecisionRow` / `appendToDays` 做单测。
- 颜色严格三 token（`TOKENS` 导出）：paper `#F2EAD8` / ink `#2E3E8F` / accent `#E75C26`，
  样式经注入的 `<style id="lcs-timeline-style">` 提供；夜间纸底反转由外层负责。
- 面板自带 `snapshot()` 只读快照，便于接线核对。
