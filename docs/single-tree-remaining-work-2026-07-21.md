# 单树 UI — 后续工作短清单

更新：2026-07-21

完整状态与验收：[`single-tree-refactor-backlog-2026-07-21.md`](single-tree-refactor-backlog-2026-07-21.md)

乐理 / Agent / 得分评审：[`music-agent-scoring-review-2026-07-21.md`](music-agent-scoring-review-2026-07-21.md)

## P0 正确性

- ~~修正 H / 响度 / tension 三处反馈事实冲突。~~ 已完成并通过 302 项测试及固定 seed 16 天评估。
- ~~Sequence v2 可听 cell 闭环：规则/LLM/USER 写格，world/audio 执行，pattern similarity / recorder / evaluator 读网格，删除 Bass 5–9 runner。~~ 已完成。

## P1 产品体验

- ~~信息栏增加 Pad / Melody / Bass / Texture 四轨实时响度。~~ 已完成，区分 RMS/peak/CLIP 与 mute/solo。
- ~~决策历史改为旧→新并在接近底部时自动跟随。~~ 已完成，用户上滚时显示回底按钮。
- ~~总分/分项增加可点击、可聚焦、移动端可用的计算 tooltip。~~ 已完成，复用 `scoreBreakdown()` 并支持 Escape。
- ~~启动先显示全树 overview，选轨后进入现有两声部 voice view；浏览与 USER 接管继续分离。~~ 已完成，并通过 1280×720 / 390×844 真浏览器验收。

## P2 后续 Epic

- ~~Master AGENT/USER：BPM 纳入所有权，新增拍号、季长、色彩、和弦走向。~~ 已完成：BPM 立即，拍号/色彩下一小节，季长/四季预排下一日。
- ~~Sequence 收尾：crossVoice evaluator 改读起音/gate，删 Bass 5–9 兼容层。~~ 已完成。
- ~~Bass/Pad 五枝素材、Alpha soft matte、鹈鹕烘焙小枝、树顶/树根 cap。~~ 已完成并接入。
- ~~Bass Sequence 节奏评分、群聚时间加权 P90、evaluator 机制专项闸门。~~ 已完成。
- ~~1280×720 / 390×844 真浏览器验收。~~ 已完成，含 Bass 计分 tooltip 跨实时重绘持久态。
- ~~草稿 PR。~~ 已完成：PR #1。
- ~~Spark 重部署。~~ 已完成：2026-07-22 部署 `8ea14c8`，8099 桌面与 390px 真浏览器冒烟通过。
