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

## 2026-07-22 行为与 Jungle 收尾

- ~~Sequence 反馈闭环、驻留同源、非 Jungle grid drift、resolver。~~ 已完成。
- ~~单树/长期变化率闸门、`F-noSequence`、Master 相对低分、crossVoice 重标、统一 evidence。~~ 已完成。
- ~~Amen transient、句尾 retrigger/dropout、dub/filter/crush/reverse。~~ 已完成。
- 待资产：Think/Apache 音频未在 dnber 找到可确认授权来源；未复制未知授权素材，取得合法资产后再加入季节切换。

## 2026-07-22 Freeze 前最终轮

- ~~潜空间漫游器常驻声部枝条的对侧，去掉粒子并改为叶簇；实时显示 X/Y 坐标，支持鼠标、触控和键盘。~~ 已完成。
- ~~Pad / Melody / Bass / Texture 各自增加不可见 compressor；Master limiter 与录音 limiter 分离。~~ 已完成。
- ~~移除旧时光下拉，将时光、日序/昼夜、拍子、季节、和弦、色彩统一收进林群总控子菜单。~~ 已完成。
- ~~Pad 提高 Reverb 与 Ping-pong；Texture 提高 Reverb 与响度。~~ 已完成。
- ~~入口页改用正确的树干/枝条组合资产，统一纸张、墨蓝与朱砂视觉；入口只保留 `INTELLIGENT JUNGLE` 与“进入”。~~ 已完成。
- ~~Texture 模式控件移除黑底，恢复纸张底色与墨蓝文字。~~ 已完成。
- ~~森林环境声在入口/暂停渐入、乐器发声时 duck，且不进入录音；资源改为流式加载并记录来源与授权。~~ 已完成。
- ~~Claude 审查提出的响度单向棘轮、瞬时 RMS、USER 探索重复计分、Bass 神经音域、暂停态丢失与重复启动等问题。~~ 已修复并加入回归测试。
- 当前回归基线：`npm run test:mvp` 390/390。夜晚复奏仍按行为审查结论暂缓，不在 freeze 前引入高风险时序改造。
