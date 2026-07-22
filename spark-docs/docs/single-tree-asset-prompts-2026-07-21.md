# 单树 UI 视觉素材清单与生成 Prompt

日期：2026-07-21  
用途：`mvp/` 单树纵向 UI  
负责人：协调者定义与验收；图像生成 worker 批量生成；前端 worker 只负责切图、标锚点与接入

## 1. 统一视觉母 Prompt

以下文字应附加在每一条素材 Prompt 后：

```text
Visual language: restrained two-color risograph botanical illustration, warm paper implied but the delivered asset itself has a truly transparent background, hand-drawn deep indigo ink lines, subtle dry-brush and print grain, quiet editorial composition, elegant natural irregularity, consistent line weight, no gradients, no glow, no neon, no photorealism. Tree and branches use deep indigo ink only. Orange-red accent is reserved exclusively for birds and runtime interaction, never baked into tree assets. Isolated production asset, centered and fully contained, clean alpha edges, no text, no labels, no UI panels, no frame, no cast shadow, no scenery, no sky, no ground, no other objects.
```

统一负面约束：

```text
Avoid: fantasy tree, cosmic imagery, galaxy, glowing magic, dense foliage, colorful flowers, watercolor wash, 3D rendering, glossy vector art, black background, beige rectangle behind the asset, decorative border, typography, musical notes, knobs, sliders, interface cards, baked-in highlights.
```

## 2. 必须生成的素材

### A. 主树干基础段

建议文件：`tree-trunk-main.png`  
建议画布：1536×2730，透明背景  
用途：纵向树世界的主要连续树干，可在 Canvas 中重叠拼接

```text
Create one very tall isolated tree trunk segment for a vertically scrolling musical interface. The trunk runs continuously from beyond the top edge to beyond the bottom edge, centered, occupying about 38 percent of canvas width. It has a mature broad deciduous-tree silhouette, natural bark grooves and a few subtle knots, but no branches, no leaves, no roots and no cut ends. Keep the left and right outer contours calm and readable, with enough quiet flat bark areas to host circular growth-ring controls. The top and bottom widths should be visually compatible so multiple copies can overlap without an obvious seam. Front-facing orthographic asset, no perspective tilt.
```

验收：

- 顶底都必须“出画”，不能出现截断木桩。
- 中间至少有三块可容纳年轮的安静树皮区域。
- 不允许自带枝条、鸟、控件或橙色。

### B. 树干变化段

建议文件：

- `tree-trunk-variant-a.png`
- `tree-trunk-variant-b.png`

建议画布：1536×2730，透明背景

```text
Create an alternate long middle segment of the exact same continuous tree trunk as the reference trunk asset. Match its width, indigo line weight, bark density and front-facing silhouette. Change only the arrangement of bark grooves and small knots so repeated vertical sections do not look tiled. No branches, leaves, roots, cut ends or controls. Both top and bottom continue beyond the canvas and remain overlap-compatible with the main trunk segment.
```

### C. 树顶收束段

建议文件：`tree-trunk-crown-cap.png`  
建议画布：1536×2048，透明背景

```text
Create the upper ending section of the same enormous tree. The lower edge continues the established broad trunk width; moving upward, the trunk naturally divides into a restrained open crown with only a few structural limbs. Keep generous empty space and sparse small twigs. No dense canopy and no leaves baked in. The tree should feel like the top of the same continuous vertical interface tree, not a separate tree.
```

### D. 树根收束段

建议文件：`tree-trunk-root-cap.png`  
建议画布：1536×2048，透明背景

```text
Create the lower ending section of the same enormous tree. The upper edge continues the established broad trunk width; moving downward, it expands into a few elegant visible roots that leave generous open space between them. Front-facing and flat, no soil, grass, rocks or ground plane. Include one quiet central bark area suitable for a future master-volume growth-ring control, but do not draw any UI.
```

## 3. 四组声部枝群

共同生产规则：

- 每张必须恰好有五根清晰主枝。
- 主枝纵向中心建议位于画布高度的 14%、32%、50%、68%、86%。
- 靠树干的一侧必须出画，方便与树干重叠。
- 另一侧枝尖完整保留。
- 鸟、发声光效和点击节点不烘焙进图。
- Pad 与 Bass 朝右；Melody 与 Texture 朝左。

### E. Pad 枝群

建议文件：`branch-cluster-pad-right.png`  
建议画布：2048×1536，透明背景

```text
Create one isolated right-growing branch cluster for the Pad voice of a musical tree interface. Exactly five clearly separated main branches emerge from beyond the left edge and extend horizontally toward the right. The branches are long, calm, gently curved and supportive, with broad stable silhouettes and a few sparse rounded twigs. They should feel suitable for several rounded doves to perch together, expressing sustained harmony and warmth. Keep the five branch levels visually distinct and leave clean perchable horizontal sections. No trunk, no birds, no leaves and no control graphics.
```

### F. Melody 枝群

建议文件：`branch-cluster-melody-left.png`  
建议画布：2048×1536，透明背景

```text
Create one isolated left-growing branch cluster for the Melody voice of a musical tree interface. Exactly five clearly separated main branches emerge from beyond the right edge and extend horizontally toward the left. The branches are slender, light, agile and slightly upward-sweeping, with delicate tips and fewer secondary twigs than the Pad cluster. Each level needs one especially clear small perch for a single lark. The silhouette should communicate quick movement and melodic jumping while remaining quiet and readable. No trunk, no birds, no leaves and no control graphics.
```

### G. Bass 枝群

建议文件：`branch-cluster-bass-right.png`  
建议画布：2048×1536，透明背景

```text
Create one isolated right-growing branch cluster for the Bass voice of a musical tree interface. Exactly five clearly separated structural branches emerge from beyond the left edge, ordered from low to high pitch. Each branch needs a clean root-to-tip path that can carry sixteen subtle programmatic time steps. The silhouette feels grounded, heavy and slow, suitable for pelicans, without becoming cartoonish. Keep the lower branches slightly heavier but do not create a separate horizontal runner. No dots, labels, trunk, birds, leaves or UI graphics.
```

### H. Texture 枝群

建议文件：`branch-cluster-texture-left.png`  
建议画布：2048×1536，透明背景

```text
Create one isolated left-growing branch cluster for the Texture voice of a musical tree interface. Exactly five clearly readable main branches emerge from beyond the right edge and extend toward the left. Their spacing remains structured, but the branch contours are more angular, broken and percussive, with short side twigs and visible bark marks that suggest woodpecker taps. Preserve five unambiguous main levels and clean perch points; irregularity must not become visual clutter. No trunk, no birds, no leaves and no control graphics.
```

## 4. 年轮控件纹理

年轮数值弧、文字、命中区和动画由程序绘制。素材只提供无状态木纹底。

建议文件：

- `ring-control-small.png`
- `ring-control-medium.png`
- `ring-control-large.png`

建议画布：1024×1024，透明背景

```text
Create an isolated circular growth-ring engraving embedded in a small irregular patch of tree bark, designed as the neutral background texture for an interactive control. Use 7 to 9 organic concentric rings with slight natural asymmetry, a clear quiet center and restrained indigo ink texture. No pointer, no colored progress arc, no number, no label and no icon. The outer bark edge should feather naturally so it can blend over a larger trunk asset. Front-facing perfect circular reading, but hand-drawn rather than geometric.
```

EQ 使用大号底图，在运行时叠加三条独立交互弧；FX 和 Volume 可复用中/小号。

## 5. 四种鸟 Sprite

每种鸟先生成一张四姿态角色板，确认一致性后再切为独立透明 PNG：

1. perched facing left
2. perched facing right
3. flying wings up
4. flying wings down

建议画布：2048×2048，透明背景  
建议最终文件：`bird-{voice}-{pose}.png`

鸟允许使用唯一橙红强调色，但仍以靛蓝线条勾勒。四类必须主要靠轮廓区分，不能只换颜色。

### I. Pad：斑鸠

```text
Create a four-pose character sheet of the same stylized turtledove for a restrained risograph musical interface: perched facing left, perched facing right, flying with wings up, flying with wings down. The bird has a rounded calm body, small head, short beak and broad gentle wings, expressing sustained warmth. Deep indigo engraved outlines with one muted orange-red body accent, minimal internal detail, instantly readable at 48–96 pixels. Keep all four poses equal scale and fully separated on a truly transparent background.
```

### J. Melody：百灵

```text
Create a four-pose character sheet of the same stylized lark for a restrained risograph musical interface: perched facing left, perched facing right, flying with wings up, flying with wings down. The bird has a slim upright body, fine pointed beak, alert small crest and agile narrow wings, expressing quick melodic hops. Deep indigo engraved outlines with one muted orange-red body accent, minimal internal detail, instantly readable at 40–80 pixels. Keep all four poses equal scale and fully separated on a truly transparent background.
```

### K. Bass：鹈鹕

```text
Create a four-pose character sheet of the same stylized pelican for a restrained risograph musical interface: perched facing left, perched facing right, flying with wings up, flying with wings down. The bird has a low heavy body, unmistakable long bill and pouch, broad wings and grounded weight, expressing slow bass movement. Simplify the silhouette so it remains readable at 56–110 pixels and can sit naturally on one of five sturdy pitch branches. Deep indigo engraved outlines with one muted orange-red body accent. Keep all four poses equal scale and fully separated on a truly transparent background.
```

### L. Texture：啄木鸟

```text
Create a four-pose character sheet of the same stylized woodpecker for a restrained risograph musical interface: perched clinging left, perched clinging right, flying with wings up, flying with wings down. The bird has a compact angular body, sharp straight beak, stiff tail and graphic striped markings, expressing precise percussive taps. Deep indigo engraved outlines with one muted orange-red head or breast accent, minimal internal detail, instantly readable at 40–85 pixels. Keep all four poses equal scale and fully separated on a truly transparent background.
```

## 6. 第二阶段可选素材

这些不应阻塞首版：

### 季节透明叠加层

- `season-spring-buds.png`
- `season-summer-leaves.png`
- `season-autumn-leaves.png`
- `season-winter-twigs.png`

```text
Create a sparse transparent botanical overlay for the same indigo risograph tree. [SPRING: tiny buds / SUMMER: restrained sparse leaves / AUTUMN: a few dry leaves, still indigo-only / WINTER: fine bare twig accents]. Keep more than 70 percent of the canvas empty. This is a repeatable seasonal detail layer, not a complete tree and not a background. No birds, trunk, scenery, text or extra colors.
```

### 近景树皮颗粒遮罩

建议文件：`bark-grain-mask.png`

```text
Create a seamless monochrome alpha texture of sparse dry-brush bark grain and risograph ink speckles. No recognizable objects, no gradient, no frame and no paper color. Designed to be softly multiplied over a large tree trunk without visible repetition.
```

## 7. 不需要生成图片的元素

以下必须程序化，不能烘焙进素材：

- 年轮数值弧、指针、标签和交互状态
- 五层音高编号与每枝 16 个 Sequence 时间节点
- 鸟的命中区和飞行轨迹
- 发声脉冲、选中态和 USER/AGENT 状态
- 顶部 HUD、左侧声部导航、右侧抽屉
- 昼夜反色、季节色调和纸张底色
- Meter、Mute、Solo、录制状态

## 8. 推荐生成顺序

1. 主树干 + 一张变化段
2. Melody 左枝群，用当前概念图先校准
3. Pad / Bass / Texture 枝群
4. 四种鸟角色板
5. 年轮底纹
6. 树顶、树根
7. 季节叠加层与颗粒遮罩

每一步先确认风格和锚点，再继续下一批；不要一次生成全部后再发现线重、墨色或比例不一致。

## 9. LibTV 模型路由

2026-07-21 通过 LibTV CLI 1.1.1 实际查询：当前账户的 image 模型列表中没有 GPT Image / GPT Image 2.0，不能假装调用。优先使用当前真实可用的高质量模型：

1. `lib-image-2`（Lib Image）：主生产模型；支持 high 画质、4K、1:2/2:1 等长比例。树干、枝群和最终角色板优先用它。
2. `doubao-seedream-5-0-pro`（Seedream 5.0 Pro）：结构约束和干净资产备选；适合“五根枝”“四姿态角色板”等明确版式，最高 2K。
3. `mj-v8.1`（Midjourney V8.1）：只用于第一轮风格探索和审美比稿；固定四张、可调 stylize/chaos，但不作为最终透明生产资产的唯一来源。
4. `nebula-ultra`（Lib Navo Pro / 全能图片模型 V2）：图生图修订与一致性收敛；支持 4K，适合拿已确认的树干或鸟角色图继续改姿态、去杂物和统一线条。

推荐流程：

- `mj-v8.1` 或 `lib-image-2` 生成 4 张风格候选。
- 选中一张后，用 `lib-image-2` high + 4K 生产主资产。
- 用 `nebula-ultra` 以确认图为参考做变体和一致性修订。
- 对“恰好五枝、固定四姿态”等结构失败的素材，改用 `doubao-seedream-5-0-pro` 重做。
- 透明背景不能只相信 Prompt；下载后必须检查 alpha。若模型输出纸色底，统一走离线抠图并保留原图。
