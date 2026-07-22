# 二维音色地图

> **本文描述的是 v1（`brave` 后端，128D 共享地图）**。v2 生产后端 `brave-voices`
> 是每轨独立的 256D 地图（`assets/timbre/voice_maps/{bass,pad,lead,pluck}.json`），
> 字段与客户端接法见 `protocol.md` §8.5。kNN 混合、不做反投影的结论两版通用。

1239 个真实 Serum preset 铺成的可拖动平面。拖到哪，音色就走到哪。

页面：`/_client/map.html`（全屏，riso 双色印刷美学）
数据：`assets/timbre/latent_map.json`（1.7 MB）
构建：`tools/build_latent_map.py`（在 Octopus 上跑，CLAP 缓存在那）

## 布局为什么用 t-SNE 而不是 PCA

去重后的语料上，**PCA 前二只解释 45.0% 的方差**（PC1 34.3% + PC2 10.7%）。

> ⚠️ 早期文档里流传的「PC1 占 60.6%」是在**未去重**的 1822 个 preset 上算的。
> 语料里约 1/3 是重复导入（CLAP 余弦 >0.995，重复在输入空间就存在，不是模型行为），
> 重复项挤在相同方向上人为抬高了主成分占比。去重到 1239 之后是 45%。
> 引用这个数字时注意区分。

45% 撑不起「二维承载全部信息」。但**这个平面并不需要承载信息** —— 它只是导航面，
真正送进 decoder 的 z 来自 kNN 混合真实 preset。导航面需要的性质是
「平面上挨得近 ⇒ 听感也近」，那正是 t-SNE 优化的目标；PCA 优化的是全局方差保留，
两者目标不同。

实现细节：用 PCA 结果做 t-SNE 的初始化（随机初始化的布局不可复现），
度量用 cosine（z 是 tanh 输出，方向比模长更能代表音色）。

## 为什么不做「XY → 反投影回 128 维」

反投影出来的点会落在流形之外 —— 听感上是失真、怪音、或者干脆不发声。
而且 t-SNE 本来就没有可逆的基。

正确做法是 **kNN 混合**：XY → 平面上最近的 k 个真实 preset → 距离加权（反平方）
混合它们的 z。这样得到的点永远落在真实音色的凸包内。

```
weights = 1 / (distance + 0.02)²      # eps 防止正好落在某点上时除零
weights /= weights.sum()
z = Σ weights[i] * z[i]
```

**代价必须如实呈现**：preset 稀疏的区域，音色会「黏」在最近的几个点上而不是平滑过渡。
这不是 bug，是这片区域的真实性质。所以：

* 散点密度直接画在背景上，让人看得见哪里密哪里疏
* 最近邻距离 > 0.06 时画虫斑绿虚线圈 + 「此处稀薄 · 音色会黏住」
* kNN 命中的点高亮并连线到光标 —— 让「当前音色由哪几个 preset 混出来」可见

## k 的听感后果

k 是有听感后果的参数，不是可视化选项。实测（同一 XY 点）：

| k | 谱质心 |
|---|---|
| 1 | 1245 Hz |
| 3 | 1158 Hz |
| 6 | 978 Hz |
| 16 | 907 Hz |

k=1 是硬切到最近的 preset；k 越大混得越广，越趋近该区域的平均音色，亮部被平均掉。
默认 6。

> 曾经有个 bug：k 滑块只改了本地可视化，服务端的 k 写死为 6，客户端从没把它发出去。
> 表现是「连线数变了、声音一点没变」。凡是参数在客户端与服务端都有副本的地方，
> 改一边就要查另一边。

## 限速：直接操纵 ≠ 自动漫游

两种交互对速度的要求相反，所以用两套限速：

| 模式 | 限速 | 理由 |
|---|---|---|
| 锚点自动漫游 | 1.6 /秒（0.8/音符事件） | 要慢到能听出「同一个音在变形」 |
| XY 直接操纵 | 20 /秒 | 拖到哪要立刻响到哪；典型 preset 间距 5–10，约 0.3–0.5 秒走完 |

XY 模式下仍然限速而不是瞬间跳变，是为了避免块边界的可闻撕裂。

> 另一个曾经的 bug：XY 直控沿用了漫游的 1.6/秒，而且 `note_on` 会先落到**锚点**
> 再朝 XY 爬 —— 于是每按一个新音都把音色拉回锚点，拖动地图听起来「几乎没有变化」。
> 现在 XY 模式起音直接落在 XY 对应的 z 上。

## 响度

XY 可以落在任意位置，九个锚点的增益覆盖不了。所以**逐点标定**：
`tools/calibrate_map_loudness.py` 给 1239 个点各渲一次算 K 加权响度，
跨点极差 **42.6 dB**（比锚点间的 21.8 dB 还大一倍 —— 这就是为什么
「取最近锚点的增益」那个近似不够）。

增益与 z 用**同一组 kNN 权重**混合，平面上的响度才连续。
实测残差 9.6 dB。残差偏大的已知原因：标定用 1.2 秒渲染掐掉 0.4 秒起音，
剩 0.8 秒稳态，对起音慢的 preset 可能还没进稳态就被量了。加长窗口能改善，
代价是标定时间线性增长。

## 协议

```json
{"type":"control","voices":[{"voice":0,"timbreXY":[0.12,-0.05],"timbreK":6}]}
{"type":"control","voices":[{"voice":0,"timbreXY":null}]}   // 回到锚点槽位模式
```

`timbreXY` 优先于 `timbre` 槽位 —— 槽位只是地图上的九个路标，XY 是任意位置。

## 重建地图

```bash
# 1) 从 checkpoint 导出 timbre.net 的 6 个张量（Spark，需要 torch）
ssh rolf@192.168.9.140 'cd /home/rolf/projects/flock-voice-engine && \
  .venv/bin/python /home/rolf/staging/dump_timbre_net.py'

# 2) 在 Octopus 上建图（CLAP 缓存在那；脚本纯 numpy，不需要 torch）
ssh -o ProxyJump=rolf@192.168.9.140 -p 2222 rolf@58.216.118.227 \
  'cd /home/rolf && python3 build_latent_map.py --out latent_map.json'

# 3) 拉回 Spark 并标定逐点响度
ssh rolf@192.168.9.140 'cd /home/rolf/projects/flock-voice-engine && \
  .venv/bin/python -m tools.calibrate_map_loudness'
```

换 checkpoint（比如 Phase 2 出来之后）**必须重建** —— z_timbre 的分布会变，
旧地图的坐标和响度标定都不再对应。
