# Agent 间接控制的音色潜空间漫游

状态：`feat/flock-voice-engine` 已实现。适用声部：**bass、pad、melody**。
`texture/drums` 完全不在本功能范围内：不产生潜空间控制，也不进入其他声部的关系输入。

## 冻结的因果契约

Agent 不直接选择音色、不写 `timbreXY`，也不生成 latent。Agent 仍只在生态层改变
驻留、密度、活跃时段、换枝和家枝等行为。固定映射层观察这些行为，把可见的世界状态
连续翻译成音色地图坐标：

```
Agent 低频决策（bar/day 边界）
  → world 中真实鸟群行为
  → 8 个归一化生态关系量
  → 每声部固定二维投影 + 慢速平滑
  → timbreXY / timbreK
  → 后端 kNN 混合真实训练 anchor
```

音高仍由枝位/Sequence 事件决定；音色走连续控制流。两条链不混用。

## 八个关系输入

实现位于 `mvp/src/ecological-latent.js`，输入都来自 `world.getSnapshot()`，范围固定为
`[0,1]`：

1. 栖驻比；
2. 平均能量；
3. 栖鸟在音高枝上的展开度；
4. 栖鸟的枝中心；
5. 平均驻留拍数（按配置参考值归一化）；
6. 当日平均换枝使用量（按配置参考值归一化）；
7. 当日活跃群比例；
8. 其他**神经声部**的飞行活跃度。

第 8 项只统计 bass/pad/melody。Texture/drums 不读、不写、不影响本控制器。

## 固定投影与安全边界

`mvp/src/config.js` 的 `latentAgent.projections` 为每个声部定义两行权重。输入先中心化到
`[-1,1]`，每个输出轴按绝对权重和归一，再限制到声部配置的 `extent`。当前 extent 为
0.72–0.78，刻意停留在地图中央可信区域。

控制器以 10 Hz 更新（低于协议 30 Hz 上限），4 秒时间常数平滑。输出只走
`timbreXY` + `timbreK=4`，因此由后端在真实训练点的凸包内做 kNN 混合。
自动路径不使用 `timbrePCA`；无约束 PCA 仍只属于手动实验漫游器。

## 控制权

- `AGENT`：连续发送该树的生态映射坐标。
- `USER`：立即暂停该树的自动坐标更新，用户可使用潜空间漫游器。
- 返回 `AGENT`：从当时真实 world 状态重新计算目标并经平滑恢复；不会修改或回滚用户摆放的鸟。
- 后端未连接或声部未被神经音源接管：world 和 Agent 照常运行，控制帧安全失败；连接后下一次更新自动恢复。

## 验证

`mvp/test/ecological-latent.test.js` 锁定以下契约：关系量确定且有界、投影不越 extent、
USER 暂停、AGENT 恢复、平滑不跳变，以及 texture/drums 不参与。
