# Latent Cosmos Single-Flock Timbre Engine

单群 Boids neural timbre engine 实验。18 只鸟在 XYZ 三维空间中保留分离、对齐、聚合三原则并永久自主运动；群的整体关系状态只控制 FSL10K RAVE 16D latent，键盘音高和力度走独立演奏链。

```text
单群 Boids → 8D 整体关系 → real-corpus Atlas → FSL10K 16D → decoder → keyboard pitch → PCM
```

8D 关系为：三维紧密、三维对齐、三维扩张、能量、XY 环流、三维湍流、三维边界压力、群中心深度。界面只暴露聚合、对齐、分离、速度、空间、深度六个运动旋钮；Z 通过鸟的大小与不透明度显示。点击启动后，单个 neural carrier 默认以 C4 永久发声；电脑键盘 `A W S E D F T G Y H U J K` 对应 C4–C5，最多三音共享同一次 neural decode。全部松键后回到 C4，但声音、latent 轨迹和鸟群都不停止、不归位。输出端另有低成本 Web Audio 延迟和短卷积混响。

## 运行

```bash
cd /Users/zhangjiangnan/Developer/Twiddle开发项目/Latent-Cosmos-Synth-xy-engine
npm run dev
```

打开 <http://localhost:4174>。实验 worktree 固定使用 `4174`，避免与 main 的 `4173` 冲突。

```bash
npm test
npm run check
npm run test:research
npm run test:realtime  # 需要正在运行的 npm run dev
```

完整定义见 [单群关系 Latent Engine 开发文档](docs/xy-latent-engine.md)。
