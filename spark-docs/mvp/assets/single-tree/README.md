# 单树 UI 生产贴图

由 `mvp/assets/generated/locked/` 降采样导出，供运行时加载。

- 树干：`trunk-main.png` + `trunk-variant-{a,b}.png` + `tree-trunk-{crown,root}-cap.png`
- 枝群：`branch-{pad,melody,bass,texture}-*.png`（Pad/Bass v2 为清晰五枝）
- 鸟：`birds/bird-{voice}-{pose}.png`
- 年轮：`rings/ring-control-{small,medium,large}.png`

路径配置见 `mvp/src/config.js` → `visual.singleTree`。
