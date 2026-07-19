// mvp/src/config.js —— Phase 1.8 全部可调参数。
// 硬约束：代码里不允许裸魔法数，所有调参数集中在这里。
// 本文件只含生态/几何/音色「数值」，不含任何音乐决策逻辑（那在 mapping.js）。
//
// §3.5.1 → harmony-season-redesign：一昼夜 = 4 小节 4/4（transport 显示），
// 昼夜时长 = bars×4×60/BPM 派生；和声上季 = 单和弦骨架（8–16 天）、
// 昼夜 = 色彩档明暗（只动高枝），发声保持栖落事件驱动。

export const CONFIG = Object.freeze({

  // ---- 仿真节拍（与渲染帧解耦）----
  sim: {
    tickHz: 30,               // world.tick 的固定步进频率
    startPhase: 0.08,         // 开局相位：0=黎明 0.25=正午 0.5=黄昏 0.75=午夜
    duskPhase: 0.5,           // 跨过此相位发 dusk 事件（仅视觉/日志节点）
  },

  // ---- tempo 主控（一昼夜 = 4 小节 4/4；时长由此派生）----
  tempo: {
    barsPerDay: 4,            // 一昼夜几小节（transport 显示用）
    beatsPerBar: 4,           // 每小节几拍
    defaultBpm: 60,           // 默认 BPM；dayLength = bars×beats×60/BPM
    bpmMin: 50,
    bpmMax: 140,
  },

  // ---- LLM 个性层（无 key 时纯规则运行）----
  llm: {
    timeoutDayFraction: 0.5,  // 调度器超时 = 半个昼夜（随 BPM 派生）
    masterCooldownDays: 2,    // master 换季冷却
    seasonLengthRange: [8, 16],// master 菜单：季节停留天数范围（季=单和弦，8–16 天）
  },

  // ---- 和声（docs/harmony-season-redesign.md：季 = 单和弦骨架，昼夜 = 色彩档）----
  // 整季一根音（季中不走步）；每黎明只换高枝色彩档（同根音的明暗呼吸）。
  // 五枝分两类：低 skeletonBranches 枝 = 骨架枝（root/5th/octave，整季不动），
  // 其余高枝 = 色彩枝（每日一档，只动这几枝）。四季骨架串成一条进行：
  // 春 F(major 系) → 夏 C(sus 系) → 秋 Am(dorian/m7 系) → 冬 G(minor 系)。
  // 枝干永远 5 根，每枝一音（MIDI），按音高升序；换季才做最近音级大迁移（voice-leading）。
  harmony: {
    seasons: ['spring', 'summer', 'autumn', 'winter'],
    seasonNames: { spring: '春', summer: '夏', autumn: '秋', winter: '冬' },
    skeletonBranches: 3,      // 低 3 枝 = 骨架枝；高 2 枝 = 色彩枝
    defaultSeasonLength: 12,  // 规则兜底季长（master 未给 seasonLength 时；须在 8..16）
    tensionBase: 0.2,         // 规则兜底张力：季内从 base 爬到 peak
    tensionPeak: 0.6,
    // 和谐分 H 权重（只观测不进分）：骨架枝 1.0 / 色彩枝 0.7 / 框架外 0
    harmonyWeights: { skeleton: 1.0, color: 0.7, outside: 0 },
    // 每季：skeleton = 五枝骨架（低 3 枝整季固定）；colors = 色彩档菜单（只写高 2 枝）。
    bySeason: {
      spring: { // 春 · F major 系
        skeleton: { id: 'F', root: 53, notes: [53, 60, 65, 69, 72] },
        colors: [
          { id: '本色', notes: [69, 72] },   // 3rd+5th
          { id: '挂四', notes: [70, 72] },   // 4th+5th
          { id: '六度', notes: [69, 74] },   // 3rd+6th
          { id: '九度', notes: [67, 72] },   // 9th+5th
        ],
      },
      summer: { // 夏 · C sus 系
        skeleton: { id: 'C', root: 48, notes: [48, 55, 60, 65, 67] },
        colors: [
          { id: '挂四', notes: [65, 67] },   // 4th+5th
          { id: '大调', notes: [64, 67] },   // 3rd+5th
          { id: '挂二', notes: [62, 67] },   // 2nd+5th
          { id: '六九', notes: [62, 69] },   // 2nd+6th
        ],
      },
      autumn: { // 秋 · Am dorian/m7 系
        skeleton: { id: 'Am', root: 57, notes: [57, 64, 69, 72, 76] },
        colors: [
          { id: '本色', notes: [72, 76] },   // m3+5th
          { id: '挂四', notes: [74, 76] },   // 4th+5th
          { id: '多利亚', notes: [74, 78] }, // 4th+6th（dorian 色彩）
          { id: '小七', notes: [72, 79] },   // m3+m7
        ],
      },
      winter: { // 冬 · G minor 系
        skeleton: { id: 'G', root: 55, notes: [55, 62, 67, 70, 74] },
        colors: [
          { id: '小调', notes: [70, 74] },   // m3+5th
          { id: '大调', notes: [71, 74] },   // 3rd+5th（picardy）
          { id: '挂四', notes: [72, 74] },   // 4th+5th
          { id: '小七', notes: [70, 77] },   // m3+m7
        ],
      },
    },
  },

  // ---- 树与枝干（几何与 duotone-riso 树贴图对齐；原点在树根）----
  // branches 的 angle/length/attach 从 codex 生成的树贴图实测：5 根结构枝对应图上
  // 5 根真实枝（id 按物理高度升序 = 音高升序），栖位因此落在贴图的枝上。
  // angle: 与竖直方向夹角（度，左负右正），length: 占树干高比例，
  // attach: 枝在树干上的附着高度（0=树根 1=树顶）。
  tree: {
    trunkHeight: 0.62,        // 树干高度（占画布高度的比例）
    trunkWidthRatio: 0.012,   // （保留：未来无贴图模式用）
    branches: [
      { id: 0, angle: 79.4, length: 0.554, attach: 0.355 },  // 右下枝
      { id: 1, angle: -79.6, length: 0.564, attach: 0.372 }, // 左下长枝
      { id: 2, angle: -73.7, length: 0.483, attach: 0.514 }, // 左中枝
      { id: 3, angle: 76.9, length: 0.501, attach: 0.559 },  // 右中枝
      { id: 4, angle: -66.5, length: 0.370, attach: 0.684 }, // 左高枝
    ],
    perchSlotsPerBranch: 3,   // 每枝栖位数
    slotSpacing: 0.18,        // 栖位沿枝的间距（占枝长比例）
    slotStart: 0.45,          // 第一个栖位距枝根的起点（贴图枝中段实处）
  },

  // ---- 四树（2×2 四象限；GPT 贴图与枝锚点均为图片归一化坐标）----
  // densityTiers 是每树可参与容量的比例，world 按各树 birdCount/capacity 换算实数。
  trees: [
    { id: 'pad', species: 'pad', xOffset: -0.33, birdCount: 5, mirror: false, drawScale: 1.0, registerOffset: 0,
      layout: { row: 0, col: 0 }, treeAsset: 'assets/tree-pad.png', birdAsset: 'assets/bird-pad.png',
      branchAnchors: [
        { x: 0.68, y: 0.72, span: 0.36 }, { x: 0.33, y: 0.61, span: 0.36 },
        { x: 0.68, y: 0.46, span: 0.36 }, { x: 0.32, y: 0.345, span: 0.34 },
        { x: 0.68, y: 0.235, span: 0.32 },
      ],
      birdFrames: { perched: { x: 0.02, y: 0.27, w: 0.48, h: 0.48 }, flying: { x: 0.51, y: 0.18, w: 0.48, h: 0.56 } } },
    { id: 'melody', species: 'melody', xOffset: -0.11, birdCount: 3, mirror: true, drawScale: 1.0, registerOffset: 12,
      layout: { row: 0, col: 1 }, treeAsset: 'assets/tree-melody.png', birdAsset: 'assets/bird-melody.png',
      branchAnchors: [
        { x: 0.65, y: 0.78, span: 0.30 }, { x: 0.35, y: 0.64, span: 0.30 },
        { x: 0.67, y: 0.51, span: 0.30 }, { x: 0.34, y: 0.37, span: 0.28 },
        { x: 0.64, y: 0.25, span: 0.25 },
      ],
      birdFrames: { perched: { x: 0.03, y: 0.34, w: 0.43, h: 0.43 }, flying: { x: 0.51, y: 0.18, w: 0.48, h: 0.56 } } },
    { id: 'bass', species: 'bass', xOffset: 0.11, birdCount: 2, mirror: false, drawScale: 1.0, registerOffset: -12,
      layout: { row: 1, col: 0 }, treeAsset: 'assets/tree-bass.png', birdAsset: 'assets/bird-bass.png',
      branchAnchors: [
        { x: 0.70, y: 0.70, span: 0.38 }, { x: 0.30, y: 0.57, span: 0.38 },
        { x: 0.70, y: 0.445, span: 0.38 }, { x: 0.30, y: 0.335, span: 0.34 },
        { x: 0.68, y: 0.225, span: 0.30 },
      ],
      birdFrames: { perched: { x: 0.03, y: 0.30, w: 0.43, h: 0.48 }, flying: { x: 0.54, y: 0.17, w: 0.45, h: 0.55 } } },
    { id: 'texture', species: 'texture', xOffset: 0.33, birdCount: 3, mirror: true, drawScale: 1.0, registerOffset: 7,
      layout: { row: 1, col: 1 }, treeAsset: 'assets/tree-texture.png', birdAsset: 'assets/bird-texture.png',
      branchAnchors: [
        { x: 0.26, y: 0.735, span: 0.34 }, { x: 0.77, y: 0.60, span: 0.32 },
        { x: 0.27, y: 0.46, span: 0.32 }, { x: 0.76, y: 0.32, span: 0.30 },
        { x: 0.72, y: 0.17, span: 0.26 },
      ],
      birdFrames: { perched: { x: 0.04, y: 0.27, w: 0.40, h: 0.50 }, flying: { x: 0.53, y: 0.21, w: 0.46, h: 0.53 } } },
  ],

  // ---- 鸟群生理（生态属性，无音乐词汇）----
  birds: {
    energyStartMin: 0.45,     // 初始体力区间
    energyStartSpan: 0.45,
    energyDrainPerSecond: 0.030,   // 飞行耗体力
    energyRecoverPerSecond: 0.045, // 栖枝回体力
    energyHopFloor: 0.15,     // 体力低于此值不主动换枝（本能物理）
    flightBaseSeconds: 0.9,   // 单次飞行基准时长
    flightJitter: 0.6,        // 飞行时长抖动幅度
    orbitRadiusMin: 0.16,     // 绕树飞行半径区间（占画布高）
    orbitRadiusSpan: 0.14,
    orbitAngularSpeed: 0.9,   // 弧度/秒（基准，逐鸟有差异）
    orbitSpeedJitter: 0.5,    // 逐鸟速度差异幅度
    orbitBobAmplitude: 0.012, // 飞行上下浮动幅度（占画布高）
    orbitBobSpeed: 2.1,       // 浮动频率（弧度/秒）
  },

  // ---- 物种行为矩阵（docs/rebuild-plan.md §3.5 + §3.5.3 音乐单位化）----
  // 双树各绑一个物种。决策单位：驻留=拍、活跃窗=小节（world 按 BPM 换算秒执行）。
  species: {
    // 斑鸠 = pad 型：长驻少变、多枝同栖成群、全天稳定。
    pad: {
      label: '斑鸠 · pad',
      fidelity: 0.9,             // 黎明返家枝概率（恋枝性）
      dwellBeats: 40,            // 驻留尺度（拍）：跨多 loop（60BPM 下 = 40s）
      dwellJitter: 0.3,          // 驻留时长抖动
      switchQuota: 0,            // 日内换枝配额：≈0，只在日界变
      maxCohortPerBranch: 3,     // 同枝群聚上限：多鸟同枝
      activityBars: [[0.0, 4.0]], // 活动时段（小节，一昼夜 4 小节）：全天稳定
    },
    // 百灵 = melody 型：短促跳枝、独占枝头（单音性）、晨昏与前夜最活跃。
    melody: {
      label: '百灵 · melody',
      fidelity: 0.4,             // 恋枝性低：每天晨练位置有天然漂移
      dwellBeats: 1.2,           // 驻留尺度（拍）：短促（60BPM 下 = 1.2s）
      dwellJitter: 1.0,
      switchQuota: 12,           // 日内换枝配额：高频
      maxCohortPerBranch: 1,     // 单鸟单枝
      activityBars: [[0.0, 0.75], [1.4, 2.6], [3.4, 4.0]], // 晨昏+前夜活跃（小节）
      monophonyBounceProb: 0.9,  // 单音性：第二只落 melody 树被弹开的概率（0.1 装饰双音）
    },
    // 鹈鹕 = bass 型：只栖低枝、跨循环长驻；换季日由 world 成批搬家一次。
    bass: {
      label: '鹈鹕 · bass',
      fidelity: 1.0,
      dwellBeats: 16,
      dwellJitter: 0.2,
      switchQuota: 0,
      maxCohortPerBranch: 2,
      activityBars: [[0.0, 4.0]],
      allowedBranches: [0, 1],
      seasonMigrationOnly: true,
    },
    // 啄木鸟 = texture 型：每次自主离枝登记原枝，下一次落枝按概率优先返回。
    texture: {
      label: '啄木鸟 · texture',
      fidelity: 0.75,
      dwellBeats: 2.2,
      dwellJitter: 0.8,
      switchQuota: 6,
      maxCohortPerBranch: 1,
      activityBars: [[0.0, 4.0]],
      returnBranchProbability: 0.72, // 覆盖日内 hop 与黎明 settle；手动起落不套性格偏置
    },
  },

  // ---- 日循环行为内核（本能物理的参数，全部音乐单位，不属于 agent）----
  dayCycle: {
    settleBeats: 3,           // 黎明归巢窗口（拍）：返家枝错落发生
    holdRecheckBeats: 1.5,    // 配额尽/窗口外时的驻留续看间隔（拍）
  },

  // ---- 日界变奏 agent（评估流水线，日内不干预）----
  agent: {
    maxMutationsPerDay: 2,     // 每日最多变异几只鸟的家枝
    roamMutationChance: 0.35,  // 无拥挤时仍注入一只漫游变异的概率（进化压力）
    crowdedBranchSize: 3,      // 家枝负载 ≥ 此值视为拥挤（触发散巢）
    densityTiers: { sparse: 0.4, normal: 0.65, full: 1 }, // 密度档位 → 每树可参与容量比例
    defaultDensityTier: 'normal',
    silentRaiseThreshold: 0.4, // 白天过静（沉默时间占比）→ 升档
    frenzyLowerThreshold: 6,   // 每活跃鸟日换枝次数 > 此值 → 降档（太闹）
    dwellBaselineMin: 0.7,     // 明日 dwell 基线的可调范围
    dwellBaselineMax: 1.4,
    dwellBaselineStep: 0.15,   // 每次评估的微调步长
    dwellExpectLowFactor: 0.5, // 期望驻留区间 = dwellBase × [low, high]
    dwellExpectHighFactor: 2.0,
    silentPerchedBelow: 2,     // 栖鸟少于此数计入「沉默时间」
    // 乐句保持期（§3.5.3.3）：melody pattern 连续 H 个昼夜不变异，期满小变
    holdLoopsRange: [2, 8],    // H 自选范围（agent 在范围内挑）
    defaultHoldLoops: 4,       // 默认保持 4 遍
    holdMutationMax: 2,        // 期满小变上限（禁整句重掷）
  },

  // ---- 生态计分偏好带（docs/eco-incentive-design.md §1–§2，全音乐单位）----
  // 换枝=次/循环、驻留=拍；带内满分、带外按 slope 线性衰减。调音乐 = 调这张表。
  economy: {
    prefs: {
      melody: {
        branchChanges: { lo: 8, hi: 16, slope: 1 / 8 },
        meanDwell: { lo: 0.5, hi: 2, slope: 2 / 3 },
        cohortSize: { lo: 1, hi: 1, slope: 1 },
        weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
      },
      pad: {
        branchChanges: { lo: 0, hi: 1, slope: 1 / 2 },
        meanDwell: { lo: 8, hi: Number.POSITIVE_INFINITY, slope: 1 / 8 },
        cohortSize: { lo: 1, hi: 2, slope: 1 },
        weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
      },
      bass: {
        branchChanges: { lo: 0, hi: 0, slope: 1 },
        meanDwell: { lo: 16, hi: Number.POSITIVE_INFINITY, slope: 1 / 16 },
        cohortSize: { lo: 1, hi: 2, slope: 1 },
        weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
      },
      texture: {
        branchChanges: { lo: 4, hi: 8, slope: 1 / 4 },
        meanDwell: { lo: 1, hi: 4, slope: 1 / 3 },
        cohortSize: { lo: 1, hi: 1, slope: 1 },
        weights: { branchChanges: 1, meanDwell: 1, cohortSize: 1 },
      },
    },
  },

  // ---- 映射层数值（mapping.js 使用；键名即契约）----
  // 枝→音高由当季固定骨架与每日色彩档共同映射（harmony.js）。
  mapping: {
    velocitySolo: 0.42,              // 力度三档：同枝 1 只
    velocityDuet: 0.68,              //       同枝 2 只
    velocityChoir: 1.0,              //       同枝 3+ 只
    duetCount: 2,
    choirCount: 3,
    dwellMinAudible: 0.25,           // 驻留→时值：最短可闻时值（秒）
    dwellMaxDuration: 6.0,           //                 最长时值（秒）
  },

  // ---- 音频（Web Audio 合成参数；timbres 按物种分离，§3.5.3.4 各自独立音色）----
  // 四声部差异化（频段占位，互不打架）：bass 60-250Hz / pad 180-2000Hz 铺底 /
  // melody 1-4kHz 存在感 / texture 2.5-6kHz 敲击带。每声部独立 EQ（eq 数组），
  // 混响干湿分离（reverbSend 按声部分配），bass 独占 WaveShaper 饱和。
  audio: {
    masterGain: 0.5,
    filterBaseHz: 900,
    filterDaylightSpan: 4200, // 昼夜滤波宏：夜里闷、白天亮
    filterQ: 1.1,
    nightGainScale: 0.55,     // 夜间整体音量缩放（夜里安静）
    saturationOversample: '4x', // WaveShaper 过采样（抑制饱和混叠）
    reverb: {
      seconds: 1.9,           // 脉冲响应长度（混响尾巴）
      decayExp: 2.6,          // 脉冲指数衰减曲率（越大越短促）
    },
    timbres: {
      // 斑鸠 pad = 中频铺底：双 saw 轻失谐柔和叠加 + 低八度垫，慢起音长释放；
      // 高通 180Hz 给 bass 让位、低通 2kHz 压暗，混响最湿。
      pad: {
        engine: 'sustained',
        oscType: 'sawtooth',
        attackSeconds: 0.35,
        releaseSeconds: 1.2,
        sustainLevel: 0.42,  // 微降 0.04，给 bass 拨弦瞬态留出余量
        subOscMix: 0.3,       // 低八度垫音比例
        detuneCents: 9,       // 第二 saw 失谐量（柔和宽度）
        detuneMix: 0.5,       // 失谐 saw 混入比例
        eq: [
          { type: 'highpass', frequency: 180 },
          { type: 'lowpass', frequency: 2000, Q: 0.7 },
        ],
        reverbSend: 0.5,      // 最湿
        polyphonic: true,     // 每鸟一 osc，驻留持续
      },
      // 百灵 melody = FM 哨笛短句：每次落枝从框架内邻近音级级进至目标枝音，
      // 载波受 2.5× 调制器频率调制，index 快衰减，尾音带 6Hz 颤音。
      melody: {
        engine: 'fmPhrase',
        polyphonic: false,
        carrierType: 'sine',
        modulatorType: 'sine',
        fmRatio: 2.5,
        fmIndex: 1.8,
        fmIndexDecaySeconds: 0.055,
        vibratoHz: 6,
        vibratoCents: 16,
        outputOctave: 12,     // 枝音级不变，哨笛在其高八度发声（约 0.8–4kHz 带）
        phraseMinNotes: 2,
        phraseMaxNotes: 4,
        noteMinSeconds: 0.12,
        noteMaxSeconds: 0.22,
        attackSeconds: 0.006,
        releaseSeconds: 0.08,
        sustainLevel: 0.34,
        eq: [
          { type: 'highpass', frequency: 800 },
          { type: 'lowpass', frequency: 4000, Q: 0.7 },
        ],
        reverbSend: 0.18,
      },
      // 鹈鹕 bass = Karplus-Strong 拨弦琶音器：噪声激励延迟线，经反馈低通衰减；
      // 当日骨架低三音按 1-5-8-5 循环，低张力每拍、高张力每半拍触发。
      bass: {
        engine: 'karplusArp',
        polyphonic: false,
        sustainLevel: 0.25,
        arpPattern: [0, 1, 2, 1],
        lowTensionStepBeats: 1,
        highTensionStepBeats: 0.5,
        tensionDensitySplit: 0.55,
        feedback: 0.92,
        dampingHz: 240,
        excitationSeconds: 0.012,
        noteDecaySeconds: 0.42,
        eq: [
          { type: 'highpass', frequency: 50 },
          { type: 'lowpass', frequency: 300, Q: 0.8 },
        ],
        reverbSend: 0.02,
      },
      // 啄木鸟 texture = granular 噪声簇：每次落枝 5–12 粒，各粒独立时距、
      // 10–40ms 包络与 2.5–6kHz 带通中心；粒数和散布复用 tension。
      texture: {
        engine: 'granular',
        polyphonic: false,
        sustainLevel: 0.3,
        grainCount: [5, 12],
        grainSeconds: [0.01, 0.04],
        grainGapSeconds: [0.02, 0.12],
        grainBandHz: [2500, 6000],
        grainQ: 1.2,
        reverbSend: 0.05,
      },
    },
  },

  // ---- 视觉：duotone-riso 三 token（docs/rebuild-plan.md §7，全部颜色唯一住所）----
  // paper 纸底 / ink 靛蓝 / accent 橙红；夜晚 = 纸底转深靛、贴图重上色为浅纸色（双色反转），
  // accent 全程不变。禁止第四色相：暗部/亮部只能是这三个色相的深浅。
  visual: {
    paper: '#F2EAD8',        // 纸底（昼）：米白
    ink: '#2E3E8F',          // 靛蓝（昼：树/地面线/UI 文字）
    accent: '#E75C26',       // 橙红（唯一彩色：鸟 + UI 强调）
    paperNight: '#262C54',   // 纸底（夜）：ink 同色相的深部
    inkNight: '#E9DFC8',     // 线条（夜）：浅纸色（双色反转）
    nightEdge: 0.34,         // daylight 低于此值开始入夜
    transitionSpan: 0.22,    // 昼夜过渡带宽（黎明/黄昏各几秒）
    horizonRatio: 0.78,      // 地面线高度（占画布高），构图对齐基准图留白
    paperGrainAlpha: 0.05,   // 纸底颗粒强度
    backgroundAssets: {
      spring: 'assets/bg-spring.jpg', summer: 'assets/bg-summer.jpg',
      autumn: 'assets/bg-autumn.jpg', winter: 'assets/bg-winter.jpg',
    },
    backgroundOpacity: 0.76, // 低对比环境图只作气氛，不抢四树前景
    seasonFadeSeconds: 1.5,  // 换季背景交叉淡入淡出
    // 贴图资产（由 studies/art-directions/round-3/duotone-riso/render.png 抠制）：
    // 白色+alpha 的覆盖率图，运行时按 token 重新上色——riso 肌理来自原图。
    treeImage: 'assets/tree-alpha.png',
    birdPerchedImage: 'assets/bird-perched.png',
    birdFlyImage: 'assets/bird-fly.png',
    treeHeightRatio: 0.72,   // 树贴图绘制高度（占画布高）
    anchorX: 779,            // 贴图根点（图像素坐标：树根与地面线交点，自动检测）
    anchorY: 923,
    birdPerchedDrawRatio: 0.042, // 栖鸟绘制高度（占画布高）
    birdFlyDrawRatio: 0.05,      // 飞鸟绘制高度
    // 日月（riso 网点天体，三 token 内）：日=ink 淡网点轮，月=纸色圆盘+轻晕
    celestialRadiusRatio: 0.045, // 天体半径（占画布高）
    celestialArcHeightRatio: 0.52, // 弧线顶点（占画布高）
    celestialArcSpanRatio: 0.36,   // 弧线水平摆幅（占画布宽）
    sunAlpha: 0.4,             // 日轮强度（克制）
    moonAlpha: 0.92,           // 月亮强度
    celestialGrainDots: 90,    // 天体网点颗粒数
    // 发声反馈：微亮+微放大
    flashSeconds: 0.7,
    flashScale: 1.3,
    flashBrighten: 0.55,     // 向浅纸色提亮的程度
  },

  // ---- 决策日志面板 ----
  log: {
    maxRows: 200,
  },
});
