# 单树 UI 生产贴图

由 `mvp/assets/generated/locked/` 降采样导出，供运行时加载。

- 树干：`trunk-main.webp` + `trunk-variant-{a,b}.webp` + `tree-trunk-{crown,root}-cap.webp`
- 枝群：`branch-{pad,melody,bass,texture}-*.webp`（Pad/Bass v2 为清晰五枝）
- 鸟：`birds/bird-{voice}-{pose}.webp`
- 年轮：`rings/ring-control-{small,medium,large}.webp`

路径配置见 `mvp/src/config.js` → `visual.singleTree`。
