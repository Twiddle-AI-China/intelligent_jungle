// mvp/src/config.js —— Phase 1.8 全部可调参数。
// 硬约束：代码里不允许裸魔法数，所有调参数集中在这里。
// 本文件只含生态/几何/音色「数值」，不含任何音乐决策逻辑（那在 mapping.js）。
//
// §3.5.1 和声化日循环 + tempo 主控：一昼夜 = 4 小节 4/4（transport 显示），
// 昼夜时长 = bars×4×60/BPM 派生；发声保持栖落事件驱动（§3.5.2 网格化已被
// 产品负责人裁定取消，见 rebuild-plan）。

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
    seasonLengthRange: [2, 8],// master 菜单：季节停留天数范围
  },

  // ---- 和声进行（§3.5.1：昼夜交替 = 和弦进行走一步；季节 = 色彩变体）----
  // 每个昼夜黎明切到当日和弦；每季 seasonDays 个昼夜后换色彩。枝干永远 5 根，
  // 每枝一音（MIDI），按音高排列；家枝按最近音级迁移（voice-leading）。
  harmony: {
    seasonDays: 4,            // 一季几个昼夜
    seasons: ['spring', 'summer', 'autumn', 'winter'],
    seasonNames: { spring: '春', summer: '夏', autumn: '秋', winter: '冬' },
    // 每季一条循环进行：root=MIDI 根音，intervals=五枝音程（升序）。
    // 配器保持在同一音区（约 E3–C5），相邻和弦的最近音级迁移才有 voice-leading 意义。
    progressions: {
      spring: [ // 春 · major 系
        { id: 'F', root: 53, intervals: [0, 4, 7, 12, 16] },
        { id: 'C', root: 55, intervals: [0, 5, 9, 12, 17] },
        { id: 'G', root: 55, intervals: [0, 4, 7, 12, 16] },
        { id: 'Am', root: 57, intervals: [0, 3, 7, 12, 15] },
      ],
      summer: [ // 夏 · sus 系
        { id: 'Csus4', root: 55, intervals: [0, 5, 10, 12, 17] },
        { id: 'Gsus4', root: 55, intervals: [0, 5, 7, 12, 17] },
        { id: 'Fsus2', root: 53, intervals: [0, 2, 7, 12, 14] },
        { id: 'Asus4', root: 50, intervals: [0, 7, 12, 14, 19] },
      ],
      autumn: [ // 秋 · dorian/m7 系
        { id: 'Am7', root: 57, intervals: [0, 3, 7, 10, 15] },
        { id: 'Dm7', root: 50, intervals: [0, 3, 7, 10, 15] },
        { id: 'G7', root: 55, intervals: [0, 4, 7, 10, 12] },
        { id: 'Cmaj7', root: 55, intervals: [0, 5, 9, 12, 16] },
      ],
      winter: [ // 冬 · minor 系
        { id: 'Am', root: 57, intervals: [0, 3, 7, 12, 15] },
        { id: 'Em', root: 52, intervals: [0, 3, 7, 12, 15] },
        { id: 'Dm', root: 50, intervals: [0, 3, 7, 12, 15] },
        { id: 'E', root: 52, intervals: [0, 4, 7, 12, 16] },
      ],
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

  // ---- 四树（Phase 3：等大横排，各归各的物种与鸟群）----
  // densityTiers 是每树可参与容量的比例，world 按各树 birdCount/capacity 换算实数。
  trees: [
    { id: 'pad', species: 'pad', xOffset: -0.33, birdCount: 5, mirror: false, drawScale: 1.0, registerOffset: 0 },
    { id: 'melody', species: 'melody', xOffset: -0.11, birdCount: 3, mirror: true, drawScale: 1.0, registerOffset: 12 },
    { id: 'bass', species: 'bass', xOffset: 0.11, birdCount: 2, mirror: false, drawScale: 1.0, registerOffset: -12 },
    { id: 'texture', species: 'texture', xOffset: 0.33, birdCount: 3, mirror: true, drawScale: 1.0, registerOffset: 7 },
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
    // 啄木鸟 = texture 型：每次自主离枝时抽签，下一次落枝优先返回刚离开的枝。
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
  // 枝→音高不再固定：每黎明按 harmony.progression 切当日和弦（harmony.js）。
  mapping: {
    velocitySolo: 0.42,              // 力度三档：同枝 1 只
    velocityDuet: 0.68,              //       同枝 2 只
    velocityChoir: 1.0,              //       同枝 3+ 只
    duetCount: 2,
    choirCount: 3,
    dwellMinAudible: 0.25,           // 驻留→时值：最短可闻时值（秒）
    dwellMaxDuration: 6.0,           //                 最长时值（秒）
    chorusStaggerSeconds: 0.14,      // 黎明晨鸣：逐鸟延迟（换和弦的标记音，克制）
    chorusNoteSeconds: 0.7,          // 晨鸣单音时值
    chorusVelocity: 0.35,
  },

  // ---- 音频（Web Audio 合成参数；timbres 按树分离，§3.5.3.4 各自独立音色）----
  audio: {
    masterGain: 0.5,
    filterBaseHz: 900,
    filterDaylightSpan: 4200, // 昼夜滤波宏：夜里闷、白天亮
    filterQ: 1.1,
    nightGainScale: 0.55,     // 夜间整体音量缩放（夜里安静）
    timbres: {
      // pad = 慢起音持续：saw + 低滤波 + 长释放（铺底）
      pad: {
        oscType: 'sawtooth',
        attackSeconds: 0.35,
        releaseSeconds: 1.2,
        sustainLevel: 0.5,
        subOscMix: 0.35,      // 低八度垫音比例
        filterScale: 0.55,    // 相对全局滤波的缩放（闷一点）
        polyphonic: true,     // 每鸟一 osc，驻留持续
      },
      // melody = 拨弦短衰减：快起快落、单音优先（新音顶旧音）
      melody: {
        oscType: 'triangle',
        attackSeconds: 0.004,
        releaseSeconds: 0.5,  // 拨弦衰减尾
        sustainLevel: 0.9,
        subOscMix: 0.0,
        filterScale: 1.4,     // 亮一点
        polyphonic: false,    // 单音：新音顶旧音
      },
      // bass = 低音区极慢长音：saw 主体 + sub，经更暗的局部低通。
      bass: {
        oscType: 'sawtooth',
        attackSeconds: 0.8,
        releaseSeconds: 2.4,
        sustainLevel: 0.42,
        subOscMix: 0.65,
        filterScale: 0.32,
        polyphonic: true,
      },
      // texture = 中音区短促重复：一次栖落触发一小串木质脉冲。
      texture: {
        oscType: 'square',
        attackSeconds: 0.003,
        releaseSeconds: 0.09,
        sustainLevel: 0.32,
        subOscMix: 0,
        filterScale: 1.15,
        polyphonic: false,
        repeatCount: 3,
        repeatIntervalSeconds: 0.075,
        noteSeconds: 0.07,
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
