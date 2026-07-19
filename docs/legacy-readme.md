# 旧版 README 摘要（冻结遗产）

> 本页保存重构前的项目叙述，只用于历史追溯；当前事实请回到仓库根 README 与 `docs/rebuild-plan.md`。

旧版 Latent Cosmos Synth 被定义为一个把 boids 鸟群自组织映射为声音控制的浏览器乐器，并配套 macOS JUCE 壳与 BRAVE/RAVE 模型研究流水线。其关系模型是 Species 表示神经声源身份、Flock 表示 decoder voice、Boid 表示 voice 内行为粒子；二维地图承担循环位置和 Dorian 音高控制，群体关系汇总为 8D latent 状态。

旧版主要交互包括添加鸟与障碍、拖动引导、擦除、切换 Species/decoder、调整 flock 空间参数、改变和声中心，以及用 MIDI Note On 和 Velocity 注入控制。研究侧曾维护 BRAVE 16D、FSL10K RAVE 16D、MRP RAVE 8D 等 streaming decoder 与训练/基准脚本，并以 decoder 失败时明确静音为事实边界。

这些实现和研究材料仍留在 `src/`、`research/` 与 `native/`，但不再是当前树-鸟生态音序器的产品定义或开发主线，也不应被当作新 MVP 已完成能力。

