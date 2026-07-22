# 音乐性纵深 + 贝斯横向枝音序器 计划（2026-07-20，based on Downloads/现存的问题2.txt）

> 历史计划注：Wave 2 Bass runner 5–9 / walk 已被 Sequence v2 统一 5×16 网格取代。

> 承接 T0-T4 减法拨回涌现（c8e26a9）与 WS-1/WS-2 可读化（a7589ad）。本阶段：
> ①修 4 个 UI/交互 bug；②放宽音乐性纵深（音域/织体/音色）；③引入**贝斯横向枝走位音序器**
> ——世界观级新形态，江南 2026-07-20 拍板走 Option 1（走位涌现，非时钟扫描）。
> 量尺不变 = 北极星①音乐性>随机 ②生态/生命涌现 ③平衡 ④agent 是生物·音乐是副产品(§0 原则1)。

## 江南反馈原文归纳（现存的问题2.txt）
1. 太阳看不出是太阳；月亮想要峨眉月样式。
2. 电平表工作不正常。
3. 缺暂停/播放。
4. EQ 三旋钮太莫名其妙。
5. 几次尝试差别不大、旋律/音色都类似 → 是否每树可选的音就没几个？音色范围也可放宽。
6.（音乐性）贝斯需要更多律动 + 更多高频。**具体 idea**：参考传统音序器，鹈鹕树长**横向枝**，
   鹈鹕站上去按时间顺序触发音符形成律动；多一些鹈鹕；纵向枝保持分解和弦音高分布；提高落根音概率。
7. 最大问题：某树是否引入类似 sequencer 更清晰表示乐句——涉及多方向大改动。
8. pad 音色/节奏单一 → 调制/缓慢改变音色；改织体走分解和弦。
9. 旋律不用和弦内音改用**音阶**（现在太像练分解和弦）；音色可缓慢改变。
10. texture 过于单一 → 音色可快速随机变化。

## 已确认的代码根因（coordinator 实查）
- **音就没几个**：`mapping.noteFromBranch` 把 branchId 夹到 `chord.notes.length-1`；单和弦骨架季 → pad/bass/texture 每季仅 ~3-4 音可及。melody 有专属 `chord.melodyNotes` 密音格但仍是和弦内音。
- **电平表 bug**：`audio.js` 的 `levelAccumulators`（squareSum/sampleCount/peak）**从不重置**——两个读取方都 `getAudioLevels({reset:false})`；peak 单调只增→顶满不落，RMS 被长期平均洗平。
- **暂停/播放**：WS-1 清空了 transport 文字后无任何播放控件。
- **EQ**：`ensureSpeciesBus` 每声部 lowShelf250/peak1200/highShelf4000，UI 标签「EQ低/中/高」无说明。
- **太阳/月亮**：`renderer.js` 昼夜天体用同一个带光晕圆盘（sunAlpha/moonAlpha 切换），无光芒、无月牙。

---

## A · UI/交互 bug 修（纯执行，Wave 1）
- **A1 太阳/月亮样式**：太阳=暖色实心 + 外放光芒（短射线/径向渐层）；月亮=峨眉月牙（两圆相减 crescent）。仍复用 celestialArc 轨迹。文件：`renderer.js`。
- **A2 电平表**：改**逐帧窗口 or 峰值衰减**——peak 每帧指数衰减（如 ×0.85/帧）取 max，RMS 用滑窗；或读取方逐帧 reset 单一所有者。让电平随发声实时起落。文件：`audio.js`（累加器）+ `main.js`（渲染）。
- **A3 暂停/播放**：加 play/pause 切换（停 sim tick + audio suspend/resume），显式按钮。文件：`main.js` + `index.html`。
- **A4 EQ 可读化**：标签改「低音/中频/高音」+ 一句 tooltip（「压/提该频段，配 solo 探索每棵树的声音」）；默认平（0dB）。保留 3 段（是"鸟↔声"探索工具）。文件：`main.js` + `index.html`。

## B · 音乐性纵深·音域与音阶（Wave 1）
- **B1 放宽每树可及音**：季节骨架不变，但每树可及集从"纯和弦音"扩到**和弦音 + 邻近音阶音**，音域上下各扩约一个八度（分层：world 仍只给 branchId，扩展在 mapping/harmony 的音级菜单）。接受更多经过音=更少"就那几个音"。
- **B2 melody 走音阶非纯和弦**：`chord.melodyNotes` 由**当日调式音阶**生成（不再纯和弦内音），减「练分解和弦」感；保留 stepPreference 让轮廓仍级进。文件：`harmony.js` + `mapping.js` + `config.js`(音阶/音域键)。
- 边界：**不 onset 硬量化、不做句法模板**（§0 反面清单）。

## C · 贝斯横向枝走位音序器（Wave 2·flagship，江南拍板 Option 1）
> 核心原则：**树的形态即音序器**，律动是鸟具身运动的副产品——触发=「鸟到达节点」(行为)，
> **绝不是**「时钟扫描节点」(机器)。不退回被 T0.2 删掉的隐藏琶音器。

- **C1 横向 runner 枝形态**（world.js + config.js）：鹈鹕树新增**横向生长的 runner 枝**，其上有若干**栖节点**（水平排列）。这是形态特征（world 层结构，非音乐规则）。config 定义鹈鹕树的枝布局（纵向分解和弦枝 + 横向 runner）。
- **C2 鹈鹕逐节点行走**（world.js 行为）：鹈鹕在 runner 上不瞬移，而是**逐节点行走/跳跃**；每落定一节点=该节点发声。行走的**顺序**=乐句；**何时迈步**=律动（复用 T3.9 驻留到期吸拍本能，迈步时刻吸最近拍）。不引入固定网格步进器。
- **C3 节点→音 + 根音偏置**（mapping.js）：runner 节点音高=和弦音（纵向枝保持分解和弦分布）；**西端/起点节点=根音偏置**（提高落根音概率）。branchId 语义扩展为 runner 节点索引，仍 world 只给 id、mapping 给音高。
- **C4 多鹈鹕 groove 涌现**（config.js 种群 + agent.js）：鹈鹕数量提高；多鸟站不同节点→groove 从站位涌现，非编排。可给 agent 一个「根音/低节点」软枝偏好（复用 pushBranchPreferences）。
- **C5 贝斯音色加高频**（audio.js + config.audio.timbres.bass）：提高 bass 高频成分/亮度，让律动更清晰可辨。
- **C6 渲染横向枝**（renderer.js）：画出 runner 横向枝 + 节点 + 鹈鹕行走位置，让"树即音序器"一眼可读。
- 边界：world 永不懂音高；runner 是形态不是 step grid；迈步靠本能吸拍不靠时钟。

## D · pad / texture 音色丰富（Wave 3）
- **D1 pad**：缓慢音色调制（LFO 扫滤波/微失谐漂移）+ 分解和弦织体倾向。文件：`audio.js`。
- **D2 texture**：音色快速随机变化（每次触发换音色参数档）。文件：`audio.js`。
- 边界：只动 audio 音色层，不动 world/economy 决策。

---

## 实施波次与文件边界（单写者铁律：同一文件绝不同时给两人）

### Wave 1（两单并行·文件不相交）
- **W1-A（cursor·dev）UI/交互 bug**：`renderer.js`、`audio.js`、`main.js`、`index.html`。A1-A4。**独占这 4 文件本波**。
- **W1-B（kimi·dev）音域+音阶**：`mapping.js`、`harmony.js`、`config.js`(仅音阶/音域/note-pool 键)。B1-B2。与 W1-A 不相交。

### Wave 2（W1 完成释放 config.js/mapping.js/renderer.js 后）
- **W2-A（cursor·flagship）贝斯横向枝音序器**：`world.js`、`config.js`(鹈鹕枝布局/种群/bass timbre 键)、`mapping.js`(节点→音+根音偏置)、`renderer.js`(画横向枝)、`agent.js`(根音软偏好)、`audio.js`(bass 高频)。C1-C6。**本波独占 config.js/mapping.js/renderer.js/audio.js**。
- kimi 并行：验证 Wave 1（node --test + eval + live 观测），不碰代码。

### Wave 3（W2 释放 audio.js/config.js 后）
- **W3-A pad/texture 音色丰富**：`audio.js`、`config.audio.timbres` 段。D1-D2。

## 验收（每波 worker_done 必附）
1. `node --test 'mvp/test/*.test.js'` 全绿（新契约需同步更新断言，不删覆盖）；
2. `node mvp/eval/run.js --seed 4997971`（**空格形式**）+ ≥2 别 seed，六维 before/after：目标 F 不回归；音域放宽后 melody 音级多样性↑；C 后贝斯 IOI 脉冲/律动↑、可听分与物理分仍趋同（不回隐藏琶音器）；
3. 具体现象证据：太阳有光芒/月亮成牙；电平表随发声起落；横向枝可见、鹈鹕逐节点走、根音偏置生效；
4. 不 commit（江南统一验收后再提交）。分层铁律：world 永不懂音高。
