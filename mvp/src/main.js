// mvp/src/main.js —— 装配层：world / harmony / agent(流水线+master) / mapping / audio / renderer。
// Phase 1.9 双树同屏：pad 树 + melody 树等大并排（替代 profile 切换），双音色双鸟群；
// 计划契约 {dwellBeats, activeBars, holdLoops, mutations[]}。生产环境只可通过
// runtime-config.js 指向 Spark StepFun；浏览器不读取、保存或透传第三方 API key。

import { CONFIG } from './config.js';
import { createWorld } from './world.js';
import { attachPipelineConductor } from './agent.js';
import { createAudioEngine } from './audio.js';
import { createRenderer } from './renderer.js';
import { createAgentPipeline } from './llm/integration.js';
import { createDayPlanScheduler } from './llm/scheduler.js';
import { createBirdAgentClient } from './llm/openai-client.js';
import { resolveMasterDecisionWithSource } from './master/external-master.js';
import { decideMaster, getMasterDecisionEvidence } from './master/policy.js';
import { transportFromPhase, colorOptions } from './harmony.js';
import {
  createDayObserver, createCrossVoiceObserver, scoreDay, deviationReport,
  loudnessBalanceFromLevels, clipWarnFromLevels,
} from './economy.js';
import { createLatentExplorationObserver, createSurvivalShadow } from './survival-shadow.js';
import { decideSurvivalAction } from './survival-actions.js';
import { noteFromBranch } from './mapping.js';
import { createTimelinePanel } from './timeline.js';
import { createRecorder, downloadBlob } from './recorder.js';
import { createInfoDrawer } from './ui/drawer.js';
import {
  createLatentRoamer,
  latentRoamerControlState,
} from './ui/latent-roamer.js?v=20260722-roamer-sidebar-1';
import { createEcologicalLatentController } from './ecological-latent.js';
import {
  VOICE_ORDER,
  browseVoiceByDelta,
  createVoiceLocator,
  resolveVisibleVoice,
} from './ui/voice-locator.js';
import {
  attachViewportInput,
  resolveCanvasTapAction,
  snapKeyboardBrowse,
} from './ui/viewport-input.js';
import {
  applyRingParam,
  createRingDragSession,
  isRingHit,
  syncRingsFromAudio,
} from './ui/ring-bridge.js';
import {
  bindRingA11yInputs,
  nextEqCycleTarget,
  ringA11yHtml,
  syncRingA11yDom,
} from './ui/ring-a11y.js';
import { levelMeterState } from './ui/level-meter.js';
import { defaultSequenceDimensions, sequencePlayheadForTree } from './sequence.js';

const canvas = document.getElementById('scene');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start-btn');
const bpmSlider = document.getElementById('bpm');
const bpmLabel = document.getElementById('bpm-label');
const drawerEl = document.getElementById('info-drawer');
const drawerToggleEl = document.getElementById('drawer-toggle');
const voiceLocatorEl = document.getElementById('voice-locator');
const voiceLevelsEl = document.getElementById('voice-levels');
const masterModeBtn = document.getElementById('master-mode');
const masterControlsEl = document.getElementById('master-controls');
const masterMeterEl = document.getElementById('master-meter');
const masterSeasonDaysEl = document.getElementById('master-season-days');
const masterColorEl = document.getElementById('master-color');

// 运行诊断不进入产品 UI；只有显式 ?debug=1 时写浏览器控制台。
const debugLogEnabled = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('debug') === '1';

// 右侧栏 / 全页 CSS token：config.visual 为唯一色源（覆盖 index.html :root 兜底）。
(function injectVisualTokens() {
  const v = CONFIG.visual ?? {};
  const root = document.documentElement?.style;
  if (!root) return;
  if (v.paper) root.setProperty('--paper', v.paper);
  if (v.ink) root.setProperty('--ink', v.ink);
  if (v.accent) root.setProperty('--accent', v.accent);
})();

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const world = createWorld({ config: CONFIG });
const renderer = createRenderer(canvas, CONFIG);
for (const tree of CONFIG.trees) renderer.setSequencePattern?.(tree.id, world.getSequencePattern(tree.id));
world.on('sequence-pattern', ({ treeId, pattern }) => renderer.setSequencePattern?.(treeId, pattern));
// ---- 决策日志：产品只显示结构化 timeline；原始事件仅显式 debug 控制台可见 ----
function appendLog(text, kind = 'event') {
  if (debugLogEnabled) console.debug(`[intelligent-jungle:${kind}]`, text);
}

// ---- StepFun 接线（部署期只注入服务地址；无地址/不可达时确定性规则运行）----
let llmScheduler = null; // 换 BPM 时同步派生超时

function halfDayTimeoutMs() {
  return Math.max(3000, world.getSnapshot().dayLength * 1000 * CONFIG.llm.timeoutDayFraction);
}

function buildPipeline({ provider, masterLlm }) {
  const timeoutMs = halfDayTimeoutMs();
  // 把调度预算作为诊断元数据透传；provider 仍由 scheduler 的 signal 负责真正中止。
  const budgetedProvider = {
    requestDayPlan: (snapshot, options = {}) => provider.requestDayPlan(snapshot, {
      ...options,
      schedulerBudgetMs: timeoutMs,
    }),
  };
  llmScheduler = createDayPlanScheduler({ client: budgetedProvider, timeoutMs });
  return createAgentPipeline({
    flockScheduler: llmScheduler,
    masterDecide: (input) => resolveMasterDecisionWithSource({ llm: masterLlm, policy: decideMaster }, input),
    masterFallback: (input) => decideMaster(input),
  });
}

// 无远端服务时也走同一条 pipeline 路径（恒 null → 确定性规则），代码不分叉。
function nullPipeline() {
  return createAgentPipeline({
    flockScheduler: async () => null,
    masterDecide: async () => null,
    masterFallback: (input) => decideMaster(input),
  });
}

async function engageStepfun() {
  const baseUrl = typeof window !== 'undefined' ? window.LCS_RUNTIME?.stepfunBase : null;
  if (!baseUrl) {
    conductor.setPipeline(nullPipeline());
    appendLog('StepFun 未配置，使用确定性林群规则', 'master');
    return;
  }
  try {
    const stepfun = createBirdAgentClient({ baseUrl });
    if (!await stepfun.checkHealth({ timeoutMs: 1500 })) {
      conductor.setPipeline(nullPipeline());
      appendLog('StepFun 不可达，使用确定性林群规则', 'master');
      return;
    }
    conductor.setPipeline(buildPipeline({ provider: stepfun, masterLlm: stepfun }));
    appendLog('StepFun 已接入', 'master');
  } catch {
    conductor.setPipeline(nullPipeline());
    appendLog('StepFun 探测异常，使用确定性林群规则', 'master');
  }
}

// ---- 生态计分接线（economy）：逐树观察器 + 跨声部错峰，黄昏结算，喂日评估与 LLM ----
const TREE_NAMES = { pad: 'pad树', melody: 'melody树', bass: '鹈鹕树', texture: '啄木鸟树' };
const ecoObservers = Object.fromEntries(CONFIG.trees.map((t) => [
  t.id, createDayObserver(CONFIG.economy.prefs[t.species], {
    beatsPerDay: CONFIG.tempo.barsPerDay * CONFIG.tempo.beatsPerBar,
    stepCount: CONFIG.tempo.barsPerDay * CONFIG.tempo.beatsPerBar,
  }),
]));
const cvCfg = CONFIG.economy.crossVoice ?? {};
const crossVoiceObserver = createCrossVoiceObserver({
  treeIds: CONFIG.trees.map((t) => t.id),
  bpm: CONFIG.tempo.defaultBpm,
  binBeats: cvCfg.binBeats ?? 0.5,
  timeWeight: cvCfg.timeWeight ?? 0.7,
  registerWeight: cvCfg.registerWeight ?? 0.3,
  conflictThreshold: cvCfg.conflictThreshold ?? 0.5,
  blankThreshold: cvCfg.blankThreshold ?? 0.25,
  suppressCount: cvCfg.suppressCount ?? 1,
  stickyShareMin: cvCfg.stickyShareMin ?? 0.8,
  gateBeats: cvCfg.gateBeats ?? 0.5,
  denseVoiceThreshold: cvCfg.denseVoiceThreshold ?? 3,
  closeRegisterSemitones: cvCfg.closeRegisterSemitones ?? 5,
  suppressExclude: cvCfg.suppressExclude ?? [],
});
const latestEcology = {};   // treeId → 行为/Sequence/响度/合奏日结；原始值与 scoreBreakdown 同源
const survivalShadow = createSurvivalShadow({ treeIds: CONFIG.trees.map((tree) => tree.id) });
const latentExploration = createLatentExplorationObserver();
const beatsPerSecond = () => world.getSnapshot().bpm / 60;
// world 的具名事件载荷不带事件名，economy 的 eventType() 需要 event 字段——补上。
world.on('perch', (e) => {
  ecoObservers[e.treeId]?.feed({ ...e, event: 'perch' });
  // 音区注解在 conductor 建成后可用；首日黎明前 getChord 可能未就绪 → midi 缺省，register 豁免。
  let midi = null;
  try {
    const chord = conductor?.getChord?.();
    if (chord && Number.isInteger(e.branchId)) {
      const tree = CONFIG.trees.find((t) => t.id === e.treeId);
      const drumMode = tree?.species === 'texture' && audio?.getVoiceMode?.('texture') !== 'texture';
      midi = drumMode ? null : noteFromBranch(e.branchId, chord, tree?.species) + (tree?.registerOffset ?? 0);
    }
  } catch { /* conductor 尚未声明时忽略 */ }
  crossVoiceObserver.feed({ ...e, event: 'perch', midi });
});
world.on('unperch', (e) => {
  ecoObservers[e.treeId]?.feed(
    { ...e, event: 'unperch', dwellTime: e.dwellTime * beatsPerSecond() }, // 驻留折算成拍
  );
  crossVoiceObserver.feed({ ...e, event: 'unperch' });
});
// 用 onBeforeDawn（注册先于 conductor → 先执行）：保证黎明 dayReview 拿到的
// 是刚结束这一天的观察，而不是隔一天的旧数据。
world.onBeforeDawn(({ stats }) => {
  // 读当日 RMS（不 reset：audio.attach 的黎明钩子随后关账重置累加器）。
  // audio 为后声明 const；本回调在模块初始化完成后才触发，闭包安全。
  const levels = typeof audio?.getAudioLevels === 'function'
    ? audio.getAudioLevels({ sample: true, reset: false })
    : null;
  const loudCfg = CONFIG.economy.loudness ?? {};
  const snap = world.getSnapshot();
  const dayCross = crossVoiceObserver.finishDay({
    endTime: snap.simTime,
    dayStart: snap.simTime - snap.dayLength,
    dayLength: snap.dayLength,
    bpm: snap.bpm,
  });
  for (const t of CONFIG.trees) {
    const latentDay = latentExploration.finishDay(t.id);
    const day = ecoObservers[t.id].finishDay({
      dayStart: snap.simTime - snap.dayLength,
      endTime: snap.simTime,
      openDwellBeats: stats?.trees?.[t.id]?.openDwellBeats,
    });
    const loudnessBalance = loudnessBalanceFromLevels(levels, t.species);
    const clipWarn = clipWarnFromLevels(levels, t.species, loudCfg.clipPeakWarn);
    const observed = {
      branchChanges: day.branchChanges,
      onsetCount: day.onsetCount,
      intervalRegularity: day.intervalRegularity,
      roleDiversity: day.roleDiversity,
      meanDwell: day.meanDwell,
      cohortSize: day.cohortSize,
      loudnessBalance,
      crossVoice: dayCross.treeScores[t.id] ?? dayCross.crossVoice,
    };
    const textureMode = t.species === 'texture' ? audio?.getVoiceMode?.('texture') : null;
    const prefs = textureMode === 'texture'
      ? CONFIG.economy.textureModePrefs.texture : CONFIG.economy.prefs[t.species];
    const dev = deviationReport(observed, prefs);
    latestEcology[t.id] = {
      branchChangesPerLoop: observed.branchChanges,
      sequenceOnsetCount: observed.onsetCount,
      intervalRegularity: observed.intervalRegularity,
      roleDiversity: observed.roleDiversity,
      meanDwellBeats: observed.meanDwell,
      clusterSize: observed.cohortSize,
      clusterPeak: day.cohortPeak,
      loudnessBalance,
      crossVoice: dayCross.treeScores[t.id] ?? dayCross.crossVoice,
      crossVoiceHint: dayCross.biasHints[t.id] ?? 'hold',
      crossVoiceConflictRatio: dayCross.conflictRatio,
      crossVoiceBlankRatio: dayCross.blankRatio,
      clipWarn,
      peak: levels?.[t.species]?.peak ?? null,
      latentExploration: latentDay.intensity,
      latentExplorationEvidence: latentDay,
      score: scoreDay(observed, prefs),
      // 和谐分 H（只观测不进分，display key 契约：harmonyScore）。
      // 本钩子注册先于 conductor：此时 conductor 的 H 计数还是刚结束当天的完整值
      // （conductor 在自己的 onBeforeDawn 末尾才重置）。conductor 为 const 后声明，
      // 模块初始化完成后本回调才执行，闭包取得到。
      harmonyScore: conductor.getHarmonyScores()[t.id]?.harmonyScore ?? null,
      deviation: {
        branchChanges: { direction: dev.branchChanges, amount: dev.magnitude.branchChanges },
        onsetCount: { direction: dev.onsetCount, amount: dev.magnitude.onsetCount },
        intervalRegularity: {
          direction: dev.intervalRegularity, amount: dev.magnitude.intervalRegularity,
        },
        roleDiversity: { direction: dev.roleDiversity, amount: dev.magnitude.roleDiversity },
        meanDwell: { direction: dev.meanDwell, amount: dev.magnitude.meanDwell },
        cohortSize: { direction: dev.cohortSize, amount: dev.magnitude.cohortSize },
        loudnessBalance: { direction: dev.loudnessBalance, amount: dev.magnitude.loudnessBalance },
        crossVoice: { direction: dev.crossVoice, amount: dev.magnitude.crossVoice },
      },
    };
  }
  // Phase 0 仅做旁路结算：三维存量挂到同一日结快照供 A/B 与后续 UI 使用，
  // 不进入 ecologyProvider 的行为建议字段，也不写回 world。
  const survival = survivalShadow.settle({
    day: stats?.day,
    trees: latestEcology,
    controls: Object.fromEntries(CONFIG.trees.map((tree) => [
      tree.id, world.getTreeControl(tree.id),
    ])),
  });
  for (const tree of CONFIG.trees) {
    latestEcology[tree.id].survival = survival.trees[tree.id];
    latestEcology[tree.id].survivalAction = decideSurvivalAction(survival.trees[tree.id]);
  }
  updateEco();
});

const ecoEl = document.getElementById('eco');
const SURVIVAL_LABELS = Object.freeze({ stamina: '体力值', health: '生命值', catch: '捕获量' });

function survivalButton(treeId, metric, resource) {
  const target = `score-help-${treeId}`;
  const label = SURVIVAL_LABELS[metric];
  const delta = Number(resource?.delta) || 0;
  const deltaText = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
  return `<button type="button" class="eco-resource eco-score-help" data-score-help="${treeId}" data-score-metric="${metric}"`
    + ` aria-expanded="false" aria-controls="${target}" aria-label="解释${label}变化">`
    + `<span class="eco-resource-label">${label}</span>`
    + `<b>${Number(resource?.value ?? 60).toFixed(0)}</b>`
    + `<small class="${delta < 0 ? 'is-down' : ''}">${deltaText}</small></button>`;
}

function survivalHelpPanel(treeId, survival) {
  const rows = Object.entries(SURVIVAL_LABELS).map(([key, label]) => {
    const item = survival?.[key];
    const delta = Number(item?.delta) || 0;
    const deltaText = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
    const terms = (item?.terms ?? []).map((term) => {
      const value = Number(term.delta) || 0;
      return `${escapeHtml(term.label)} ${value > 0 ? '+' : ''}${value.toFixed(1)}`;
    }).join(' · ') || '今日尚未结算';
    return `<li data-score-row="${key}"><b>${label} ${Number(item?.value ?? 60).toFixed(0)}`
      + `（${deltaText}）</b><span>${terms}</span></li>`;
  }).join('');
  return `<div id="score-help-${treeId}" class="eco-score-popover" role="dialog" aria-label="今日生存结算" hidden>`
    + `<div><b>今日变化</b> · 点击任一资源查看对应依据</div><ul>${rows}</ul></div>`;
}

// updateEco 会随实时画面刷新；把展开态放在 DOM 外，避免 innerHTML 重建后
// tooltip 只闪现一帧。选择按 treeId + metric 恢复，日结换值时内容仍保持最新。
let openScoreHelp = null;

function restoreScoreHelp() {
  if (!openScoreHelp) return;
  const { treeId, metric } = openScoreHelp;
  const panel = document.getElementById(`score-help-${treeId}`);
  const button = ecoEl.querySelector(
    `[data-score-help="${treeId}"][data-score-metric="${metric}"]`,
  );
  if (!panel || !button) {
    openScoreHelp = null;
    return;
  }
  panel.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  panel.querySelector(`[data-score-row="${metric}"]`)?.classList.add('is-target');
}

function masterEvidenceText(decision) {
  const evidence = getMasterDecisionEvidence(decision);
  if (!evidence) return '林群依据—未提供';
  const { balance, freshness, stability } = evidence;
  const daysSinceChange = stability.daysSinceChange == null ? '—' : stability.daysSinceChange;
  return `均衡${balance.lowLabel}·低分${balance.maxStreak}天·min${balance.lowestToday.toFixed(2)}/阈${balance.scoreFloor.toFixed(2)}`
    + ` · 新鲜同档${freshness.daysInColor}天/相似${freshness.patternSimilarity.toFixed(2)}`
    + `（阈${freshness.boredDays}天|${freshness.similarityThreshold.toFixed(2)}）`
    + ` · 平稳换季后${daysSinceChange}天/冷却${stability.cooldownDays}天`
    + `${stability.inCooldown ? '·冷却中' : ''}`;
}

function updateEco() {
  const initialSurvival = survivalShadow.snapshot().trees;
  ecoEl.innerHTML = CONFIG.trees.map((t) => {
    const name = escapeHtml(TREE_NAMES[t.id] ?? t.id);
    const e = latestEcology[t.id];
    const survival = e?.survival ?? initialSurvival[t.id];
    const action = e?.survivalAction;
    const status = e
      ? `第 ${survivalShadow.snapshot().day} 日结算 · Master ${action?.label ?? '观察'}`
      : '等待首日结算';
    const resources = Object.keys(SURVIVAL_LABELS)
      .map((key) => survivalButton(t.id, key, survival?.[key])).join('');
    return `<div class="eco-tree">`
      + `<div class="eco-head">`
      + `<span class="eco-name">${name}</span>`
      + `<span class="eco-harmony">${status}</span></div>`
      + `<div class="eco-resources">${resources}</div>`
      + survivalHelpPanel(t.id, survival)
      + `</div>`;
  }).join('');
  restoreScoreHelp();
}

function closeScoreHelp({ forget = true } = {}) {
  let hadOpen = false;
  for (const panel of ecoEl.querySelectorAll('.eco-score-popover')) {
    if (!panel.hidden) hadOpen = true;
    panel.hidden = true;
    for (const row of panel.querySelectorAll('.is-target')) row.classList.remove('is-target');
  }
  for (const button of ecoEl.querySelectorAll('.eco-score-help')) button.setAttribute('aria-expanded', 'false');
  if (forget) openScoreHelp = null;
  return hadOpen;
}
ecoEl.addEventListener('click', (event) => {
  const button = event.target.closest?.('.eco-score-help');
  if (!button) return;
  const panel = document.getElementById(button.getAttribute('aria-controls'));
  if (!panel) return;
  const opening = panel.hidden;
  closeScoreHelp({ forget: false });
  if (!opening) {
    openScoreHelp = null;
    return;
  }
  openScoreHelp = { treeId: button.dataset.scoreHelp, metric: button.dataset.scoreMetric };
  panel.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  const metric = button.dataset.scoreMetric;
  panel.querySelector(`[data-score-row="${metric}"]`)?.classList.add('is-target');
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && closeScoreHelp()) event.stopImmediatePropagation();
}, true);
document.addEventListener('click', (event) => {
  if (!ecoEl.contains(event.target)) closeScoreHelp();
});
// 初始绘制在 conductor 建成后（updateEco 的和谐分回退读取 conductor 实时观测）

// ---- 评估流水线 + master（先建 conductor：audio 需要它的 getChord）----
const TEMPO_TIERS = [50, 60, 70, 80, 90];
const TEMPO_LABELS = new Map([[50, '缓慢'], [60, '从容'], [70, '流动'], [80, '轻快'], [90, '急驰']]);
let tempoSlew = null;
function requestTempoTarget(target) {
  const snap = world.getSnapshot();
  const bounded = Math.max(CONFIG.tempo.bpmMin, Math.min(CONFIG.tempo.bpmMax, Number(target) || snap.bpm));
  if (Math.abs(bounded - snap.bpm) < 0.01) return false;
  tempoSlew = {
    from: snap.bpm,
    target: bounded,
    start: snap.simTime,
    duration: CONFIG.tempo.beatsPerBar * 60 / snap.bpm,
    lastQuarter: -1,
  };
  return true;
}
function requestTempoIntent(intent) {
  if (!['slower', 'faster'].includes(intent)) return false;
  const bpm = world.getSnapshot().bpm;
  const current = TEMPO_TIERS.reduce((best, tier) => (
    Math.abs(tier - bpm) < Math.abs(best - bpm) ? tier : best
  ), CONFIG.tempo.defaultBpm);
  const index = TEMPO_TIERS.indexOf(current);
  return requestTempoTarget(TEMPO_TIERS[Math.max(0, Math.min(TEMPO_TIERS.length - 1,
    index + (intent === 'faster' ? 1 : -1)))]);
}
function advanceTempoSlew(simTime) {
  if (!tempoSlew) return;
  const progress = Math.max(0, Math.min(1, (simTime - tempoSlew.start) / tempoSlew.duration));
  const quarter = Math.min(4, Math.floor(progress * 4));
  if (quarter !== tempoSlew.lastQuarter) {
    tempoSlew.lastQuarter = quarter;
    world.setTempo(tempoSlew.from + (tempoSlew.target - tempoSlew.from) * (quarter / 4));
    refreshTempo();
  }
  if (progress >= 1) tempoSlew = null;
}
const conductor = attachPipelineConductor(world, {
  config: CONFIG,
  pipeline: nullPipeline(), // 默认确定性规则；StepFun 就绪后换入远端 pipeline
  ecologyProvider: (treeId) => latestEcology[treeId] ?? null,
  getPercussionMode: () => audio?.getVoiceMode?.('texture') ?? 'jungle',
  onTempoIntent: requestTempoIntent,
  onPlan: ({ source, reviewedDay, targetDay }) => {
    appendLog(`第 ${reviewedDay + 1} 天·复盘第 ${reviewedDay} 天 → 第 ${targetDay} 天生效（${source}）`, 'plan');
  },
  onApply: ({ plans, day, migrations, prevChord, nextChord }) => {
    const seasonTurned = prevChord && nextChord && prevChord.season !== nextChord.season;
    if (seasonTurned) {
      const movedCount = migrations.filter((m) => m.to !== m.from).length;
      appendLog(`换季大迁移：${movedCount} 只鸟迁家枝 → ${nextChord.seasonName ?? nextChord.season}`, 'chord');
    }
    for (const [treeId, { plan, source, held, dropped }] of Object.entries(plans)) {
      // 变异可见性（P0-A/P0-C）：区分 应用/保持期清空/提议被丢/模型未提议，
      // 不再一律打「无变异」；seasonOnly（bass）无 holdLeft，不进乐句保持文案。
      const applied = plan.mutations;
      const droppedList = Array.isArray(dropped) ? dropped : [];
      let mut;
      if (source === 'USER') {
        mut = '用户接管·保留演奏';
      } else if (applied.length) {
        mut = `应用${applied.length}条: ${applied.map((m) => `鸟${m.birdId}:${m.from}→${m.to}`).join(' ')}`;
      } else if (held.seasonOnly) {
        mut = '日内不变异';
      } else if (held.held && held.holdLeft != null) {
        mut = '保持期清空';
      } else if (droppedList.length) {
        const byReason = {};
        for (const d of droppedList) byReason[d.reason ?? 'unknown'] = (byReason[d.reason ?? 'unknown'] ?? 0) + 1;
        mut = `提议${droppedList.length}条被丢(${Object.entries(byReason).map(([r, n]) => `${r}×${n}`).join(',')})`;
      } else {
        mut = source.includes('LLM') ? '模型未提议' : '无变异';
      }
      let hold = '';
      if (held.seasonOnly) hold = ' · 换季才迁·日内不变异';
      else if (held.held && held.holdLeft != null) hold = ` · 乐句保持中(余${held.holdLeft})`;
      else if (held.expired) hold = ` · 期满小变(下期${held.nextLoops})`;
      appendLog(`${TREE_NAMES[treeId] ?? treeId}（${source}）: ${mut} · 驻留${plan.dwellBeats.toFixed(1)}拍${hold}`, 'apply');
      console.debug('apply-mutations', {
        treeId, source, day,
        applied: applied.length,
        dropped: droppedList,
        held: { held: !!held.held, seasonOnly: !!held.seasonOnly, holdLeft: held.holdLeft ?? null, expired: !!held.expired },
      });
      timelinePanel?.appendDecision({
        day,
        actor: 'flock',
        flockId: treeId,
        source: source === 'USER' ? 'user' : source.includes('LLM') ? 'llm' : 'rule',
        action: source === 'USER' ? '用户接管' : applied.length ? `变奏×${applied.length}` : '延续乐句',
        reason: `${plan.reason ?? ''}${hold}`.trim() || `驻留${plan.dwellBeats.toFixed(1)}拍`,
        score: latestEcology[treeId]?.score,
      });
    }
    const moved = migrations.filter((m) => m.to !== m.from);
    if (moved.length) {
      appendLog(`家枝随和弦迁移: ${moved.map((m) => `${TREE_NAMES[m.treeId] ?? ''}鸟${m.birdId}:${m.from}→${m.to}`).join(' ')}`, 'chord');
    }
  },
  onChord: ({ prevChord, nextChord }) => {
    const seasonChange = prevChord.season !== nextChord.season;
    appendLog(`和弦 ${prevChord.id} → ${nextChord.id}`
      + (seasonChange ? ` · 换季入${nextChord.seasonName}` : `（${nextChord.seasonName}）`), 'chord');
  },
  onMaster: ({ decision, source, chord, seasonChanged }) => {
    if (!decision) return;
    // 当前契约：四和弦按日推进；Master 只点色彩档 + 张力。
    const tensionTxt = Number.isFinite(Number(decision.tension)) ? Number(decision.tension).toFixed(1) : null;
    const colorTxt = decision.colorId
      ? `色彩档${decision.colorId}${tensionTxt != null ? `·张力${tensionTxt}` : ''}` : null;
    const what = decision.nextSeason
      ? `换季→${decision.nextSeason}（季长${decision.seasonLength}天）`
      : decision.changeSeason ? `换季→${decision.changeSeason}`
        : Number.isInteger(decision.jumpToStep) ? `跳步→第${decision.jumpToStep + 1}步`
          : decision.advanceStep ? '顺走' : '续季';
    const evidence = masterEvidenceText(decision);
    appendLog(`master（${source}）: ${what}${colorTxt ? ` · ${colorTxt}` : ''} · ${chord.id}（${chord.seasonName}）${seasonChanged ? ' · 已换季' : ''} · 依据 ${evidence}`, 'master');
    timelinePanel?.appendDecision({
      day: world.getSnapshot().day,
      actor: 'master',
      source: source.includes('LLM') ? 'llm' : 'rule',
      action: what,
      reason: [decision.reason, colorTxt].filter(Boolean).join(' · ') || `${chord.id}（${chord.seasonName}）`,
    });
  },
});
updateEco(); // 初始绘制（须在 conductor 建成后：和谐分回退读 conductor 实时观测）

// ---- 决策时间线面板（timeline.js 挂载；无 DOM 时安全为 null）----
const timelinePanel = createTimelinePanel({
  container: document.getElementById('timeline'),
  maxDays: 14,
});

const audio = createAudioEngine({
  config: CONFIG,
  getChord: conductor.getChord,
  getFrame: conductor.getFrame,
  onNeuralStateChange: () => refreshMixControls(),
});
audio.attach(world);
const latentRoamer = createLatentRoamer({
  audio,
  onExplore: (event) => {
    const treeId = CONFIG.trees.find((tree) => tree.species === event.species)?.id;
    if (treeId) latentExploration.feed({ ...event, treeId });
  },
});
const ecologicalLatent = createEcologicalLatentController({
  config: CONFIG,
  send: (species, xy, k) => audio.roamTo?.(species, xy, k) ?? false,
});

// ---- 林群总控 AGENT/USER：时间流速；拍号/色彩下一小节；季长下一日 ----
let pendingMasterMeter = null;
let pendingMasterColor = null;
let lastMasterBarKey = null;
function refreshMasterControls() {
  const state = conductor.getMasterState();
  const isUser = state.control === 'USER';
  masterModeBtn.textContent = state.control === 'USER' ? '林群总控 · 用户接管' : '林群总控 · 自主演化';
  masterModeBtn.classList.toggle('is-user', isUser);
  masterModeBtn.setAttribute('aria-pressed', isUser ? 'true' : 'false');
  masterControlsEl.hidden = !isUser;
  bpmSlider.disabled = !isUser;
  masterMeterEl.value = String(CONFIG.tempo.beatsPerBar);
  // 仿真会在每小节刷新面板；不得覆盖用户尚未 blur/change 的数字输入。
  if (document.activeElement !== masterSeasonDaysEl) {
    masterSeasonDaysEl.value = String(state.pendingSeasonLength ?? state.seasonLength);
  }
  masterSeasonDaysEl.min = String(Math.max(CONFIG.llm.seasonLengthRange[0], state.seasonDay + 1));
  const colors = colorOptions(state.season, CONFIG.harmony, state.seasonDay, 'day');
  const colorSignature = colors.map((color) => color.id).join('|');
  if (masterColorEl.dataset.options !== colorSignature) {
    masterColorEl.dataset.options = colorSignature;
    masterColorEl.innerHTML = colors.map((color) => `<option value="${escapeHtml(color.id)}">${escapeHtml(color.name ?? color.id)}</option>`).join('');
  }
  masterColorEl.value = pendingMasterColor ?? state.colorId;
}
masterModeBtn.addEventListener('click', () => {
  const next = conductor.getMasterState().control === 'USER' ? 'AGENT' : 'USER';
  conductor.setMasterControl(next);
  if (next === 'AGENT') { pendingMasterMeter = null; pendingMasterColor = null; }
  refreshMasterControls();
});
masterMeterEl.addEventListener('change', () => { pendingMasterMeter = Number(masterMeterEl.value); });
masterColorEl.addEventListener('change', () => { pendingMasterColor = masterColorEl.value; });
masterSeasonDaysEl.addEventListener('change', () => {
  conductor.setUserSeasonLength(Number(masterSeasonDaysEl.value));
  refreshMasterControls();
});
refreshMasterControls();

engageStepfun();

world.on('dawn', (e) => {
  const chord = conductor.getChord();
  appendLog(`══ 第 ${e.day} 天 · 黎明 · 当日和弦 ${chord.id}（${chord.seasonName}） ══`, 'day');
});
world.on('dusk', (e) => appendLog(`── 第 ${e.day} 天 · 黄昏 ──`, 'day'));
world.on('perch', (e) => appendLog(
  `${TREE_NAMES[e.treeId] ?? ''}鸟${e.birdId} 落枝#${e.branchId}（${e.cause}·同枝 ${e.perchedOnBranch}）`, 'event'));
world.on('unperch', (e) => appendLog(
  `${TREE_NAMES[e.treeId] ?? ''}鸟${e.birdId} 离枝#${e.branchId}（${e.cause}·驻留 ${(Number.isFinite(e.dwellBeats) ? e.dwellBeats : e.dwellTime * beatsPerSecond()).toFixed(1)}拍）`, 'event'));
// 发声瞬间的视觉反馈：落枝鸟微亮/微放大（渲染器可选接口）
world.on('perch', (e) => renderer.flash?.(e.birdId));

// ---- 枝位列表已移除：Canvas 是唯一主表达 ----

// ---- 单树 UI：当前声部单轨 + 年轮精确值只读同步；四树 mixer cards 已删除 ----
const treeCardsEl = document.getElementById('tree-cards');
const guideOverlay = document.getElementById('guide-overlay');
const GUIDE_STORAGE_KEY = 'lcs-guide-done-v1';
const CARD_LABELS = { pad: 'PAD · 斑鸠', melody: 'MELODY · 百灵', bass: 'BASS · 鹈鹕', texture: 'TEXTURE / DRUMS · 啄木鸟' };
/** Alt+←/→ 循环调节 EQ 三环的下标。 */
let eqCycleIndex = 0;

/** 当前信息页展示的声部：USER 焦点优先，否则跟随左侧明确选择/当前视口。 */
let panelVoiceId = 'pad';

function dismissGuide() {
  try { localStorage.setItem(GUIDE_STORAGE_KEY, '1'); } catch { /* private mode */ }
  guideOverlay?.classList.add('hidden');
}

function maybeShowGuide() {
  if (!guideOverlay) return;
  let done = false;
  try { done = localStorage.getItem(GUIDE_STORAGE_KEY) === '1'; } catch { /* ignore */ }
  if (done) {
    guideOverlay.classList.add('hidden');
    return;
  }
  guideOverlay.classList.remove('hidden');
}

document.getElementById('guide-ok')?.addEventListener('click', dismissGuide);
document.getElementById('guide-skip')?.addEventListener('click', dismissGuide);

function resolvePanelVoiceId() {
  const focus = renderer.getFocusTree?.() ?? null;
  if (focus) return focus;
  // locator click 会先更新 active，再启动相机滚动。active 必须先于尚未到位的
  // getVisibleVoice，否则右栏会在同一帧被旧视口声部覆盖回去。
  const selected = voiceLocator?.getActive?.() ?? null;
  if (selected) return selected;
  if (typeof renderer.getVisibleVoice === 'function') {
    const v = renderer.getVisibleVoice();
    if (v != null && v !== '') return v;
  }
  return resolveVisibleVoice(renderer, voiceLocator?.getActive?.() ?? panelVoiceId);
}

function ringReadoutHtml(treeId, species) {
  return ringA11yHtml(treeId, species, { renderer, audio });
}

function ensureMixTracks() {
  if (!treeCardsEl || treeCardsEl.dataset.ready === '1') return;
  treeCardsEl.innerHTML = '';
  const track = document.createElement('div');
  track.className = 'mix-track';
  track.id = 'current-voice-track';
  track.innerHTML = `
    <div class="mix-track-head" title="点名进入特写并接管声部">
      <span class="mix-track-affordance" aria-hidden="true">◎</span>
      <span class="mix-track-name">—</span>
      <span class="mix-track-mode">自主演化</span>
    </div>
    <div class="mix-track-row">
      <div class="mix-meter" title="声部实时电平"><div class="mix-meter-fill"></div></div>
      <button type="button" class="mix-btn mix-btn-solo is-solo" data-action="solo" title="Solo 单听（一次只听一轨）">S</button>
      <button type="button" class="mix-btn mix-btn-mute" data-action="mute" title="Mute 静音">M</button>
    </div>
    <button type="button" class="mix-takeover" data-action="takeover">接管此声部</button>
    <button type="button" class="mix-takeover mix-roam" data-action="roam" hidden>进入潜空间漫游器</button>
    <label class="percussion-mode" hidden>打击生态
      <select data-action="percussion-mode" aria-label="第四声部模式">
        <option value="texture">Texture</option>
        <option value="jungle">Jungle</option>
      </select>
    </label>
    <div data-role="ring-readout"></div>
  `;
  treeCardsEl.appendChild(track);

  track.querySelector('.mix-track-head').addEventListener('click', () => {
    const treeId = panelVoiceId;
    const next = renderer.toggleFocusTree(treeId);
    syncControlWithFocus(next);
    appendLog(
      next
        ? `${TREE_NAMES[treeId] ?? treeId} 特写 · 用户接管`
        : '回到全树 · 林群自主回应',
      'apply',
    );
  });
  track.querySelector('[data-action="takeover"]').addEventListener('click', (event) => {
    event.stopPropagation();
    const treeId = panelVoiceId;
    const focus = renderer.getFocusTree?.() ?? null;
    if (focus === treeId) {
      renderer.setFocusTree?.(null);
      syncControlWithFocus(null);
      appendLog('回到全树 · 林群自主回应', 'apply');
    } else {
      renderer.setFocusTree?.(treeId);
      syncControlWithFocus(treeId);
      appendLog(`${TREE_NAMES[treeId] ?? treeId} 特写 · 用户接管`, 'apply');
    }
    refreshMixControls();
  });
  track.querySelector('[data-action="roam"]').addEventListener('click', (event) => {
    event.stopPropagation();
    const tree = CONFIG.trees.find((t) => t.id === panelVoiceId);
    if (!tree) return;
    if (!audio.isNeural?.(tree.species)) return;
    if ((renderer.getFocusTree?.() ?? null) !== tree.id) {
      renderer.setFocusTree?.(tree.id);
      syncControlWithFocus(tree.id);
      appendLog(`${TREE_NAMES[tree.id] ?? tree.id} 潜空间 · USER 接管`, 'apply');
    }
    latentRoamer.open(tree.species);
  });
  track.querySelector('[data-action="solo"]').addEventListener('click', (event) => {
    event.stopPropagation();
    const tree = CONFIG.trees.find((t) => t.id === panelVoiceId);
    if (!tree) return;
    const state = audio.getMuteSolo?.() ?? { solo: {} };
    const next = !state.solo?.[tree.species];
    audio.setSolo?.(tree.species, next);
    refreshMixControls();
  });
  track.querySelector('[data-action="mute"]').addEventListener('click', (event) => {
    event.stopPropagation();
    const tree = CONFIG.trees.find((t) => t.id === panelVoiceId);
    if (!tree) return;
    const state = audio.getMuteSolo?.() ?? { mute: {} };
    const next = !state.mute?.[tree.species];
    audio.setMute?.(tree.species, next);
    refreshMixControls();
  });
  track.querySelector('[data-action="percussion-mode"]').addEventListener('change', (event) => {
    const mode = audio.setVoiceMode?.('texture', event.currentTarget.value);
    appendLog(`啄木鸟打击生态 → ${String(mode ?? event.currentTarget.value).toUpperCase()}`, 'apply');
    refreshMixControls();
  });
  treeCardsEl.dataset.ready = '1';
}

function ensureVoiceMeters() {
  if (!voiceLevelsEl || voiceLevelsEl.dataset.ready === '1') return;
  voiceLevelsEl.innerHTML = CONFIG.trees.map((tree) => `
    <div class="voice-level" data-species="${tree.species}">
      <span class="voice-level-name">${tree.id.toUpperCase()}</span>
      <div class="voice-level-rail" aria-label="${tree.id} 实时响度">
        <span class="voice-level-rms"></span><span class="voice-level-peak"></span>
      </div>
      <span class="voice-level-db">−∞</span><span class="voice-level-state">—</span>
    </div>`).join('');
  voiceLevelsEl.dataset.ready = '1';
}

function refreshMixControls() {
  if (!treeCardsEl) return;
  ensureMixTracks();
  panelVoiceId = resolvePanelVoiceId();
  const tree = CONFIG.trees.find((t) => t.id === panelVoiceId) ?? CONFIG.trees[0];
  if (!tree) return;
  const track = treeCardsEl.querySelector('#current-voice-track');
  if (!track) return;
  const species = tree.species;
  const focus = renderer.getFocusTree?.() ?? null;
  const isFocused = focus === tree.id;
  const muteSolo = audio.getMuteSolo?.() ?? { mute: {}, solo: {} };
  const muted = !!muteSolo.mute?.[species];
  const soloed = !!muteSolo.solo?.[species];
  track.dataset.treeId = tree.id;
  track.dataset.species = species;
  track.classList.toggle('is-focused', isFocused);
  track.classList.toggle('is-muted', muted);
  track.querySelector('.mix-track-name').textContent = CARD_LABELS[tree.id] ?? tree.id;
  track.querySelector('.mix-track-mode').textContent = isFocused ? '用户接管' : '自主演化';
  const percussionMode = track.querySelector('.percussion-mode');
  if (percussionMode) {
    percussionMode.hidden = species !== 'texture';
    const select = percussionMode.querySelector('select');
    if (select) select.value = audio.getVoiceMode?.('texture') ?? 'jungle';
  }
  track.querySelector('.mix-track-head').title = isFocused
    ? '声部已接管 · 再点或 Esc 退出'
    : '点名进入特写并接管声部';
  track.querySelector('[data-action="mute"]').classList.toggle('is-on', muted);
  track.querySelector('[data-action="solo"]').classList.toggle('is-on', soloed);
  const takeover = track.querySelector('[data-action="takeover"]');
  takeover.textContent = isFocused ? '交还林群' : '接管此声部';
  takeover.classList.toggle('is-user', isFocused);
  // 潜空间入口不能随 AGENT/USER 或异步连接状态凭空消失。配置了神经声部的
  // 乐器始终显示入口；AGENT 下点击即明确接管后打开。texture/drums 没有
  // voiceEngine binding，严格排除。连接状态由 audio 的回调触发本函数刷新。
  const roamBtn = track.querySelector('[data-action="roam"]');
  const roamState = latentRoamerControlState({
    configured: !!CONFIG.voiceEngine?.species?.[species],
    connected: !!audio.isNeural?.(species),
    focused: isFocused,
  });
  roamBtn.hidden = roamState.hidden;
  roamBtn.disabled = roamState.disabled;
  roamBtn.textContent = roamState.label;
  if ((roamState.hidden || roamState.disabled || !isFocused) && latentRoamer.isOpen()) {
    latentRoamer.close();
  }
  const ringHost = track.querySelector('[data-role="ring-readout"]');
  if (ringHost) {
    // 仅在声部切换或首次挂载时重建，避免打断正在聚焦的 range
    if (ringHost.dataset.voiceId !== tree.id) {
      ringHost.dataset.voiceId = tree.id;
      ringHost.innerHTML = ringReadoutHtml(tree.id, species);
      ringHost.dataset.ringBound = '';
      bindRingA11yInputs(ringHost, {
        renderer,
        audio,
        trees: CONFIG.trees,
        getTreeId: () => panelVoiceId,
        onChange: () => { /* values already live in inputs */ },
      });
    } else {
      syncRingA11yDom(ringHost, tree.id, species, { renderer, audio });
    }
  }
  // P1-1：定位器高亮只跟 viewport（syncPanelFromViewport → refresh），不跟 USER panel。
}

function refreshMixMeters() {
  if (!treeCardsEl || treeCardsEl.dataset.ready !== '1') return;
  const levels = typeof audio.getAudioLevels === 'function'
    ? audio.getAudioLevels({ sample: true, reset: false })
    : null;
  if (!levels) return;
  ensureVoiceMeters();
  const muteSolo = audio.getMuteSolo?.() ?? { mute: {}, solo: {} };
  const anySolo = Object.values(muteSolo.solo ?? {}).some(Boolean);
  for (const treeEntry of CONFIG.trees) {
    const row = voiceLevelsEl?.querySelector(`[data-species="${treeEntry.species}"]`);
    if (!row) continue;
    const meter = levelMeterState(levels[treeEntry.species]);
    row.querySelector('.voice-level-rms').style.width = `${meter.rmsPercent.toFixed(1)}%`;
    row.querySelector('.voice-level-peak').style.left = `${meter.peakPercent.toFixed(1)}%`;
    row.querySelector('.voice-level-db').textContent = Number.isFinite(meter.rmsDb)
      ? `${meter.rmsDb.toFixed(1)}dB` : '−∞';
    const muted = !!muteSolo.mute?.[treeEntry.species];
    const soloed = !!muteSolo.solo?.[treeEntry.species];
    const suppressed = anySolo && !soloed;
    row.classList.toggle('is-muted', muted || suppressed);
    row.classList.toggle('is-clipping', meter.clipping);
    row.querySelector('.voice-level-state').textContent = meter.clipping
      ? 'CLIP' : soloed ? 'SOLO' : muted ? 'MUTE' : suppressed ? '−S' : '—';
  }
  const tree = CONFIG.trees.find((t) => t.id === panelVoiceId);
  if (!tree) return;
  const fill = treeCardsEl.querySelector('#current-voice-track .mix-meter-fill');
  if (!fill) return;
  const level = levels[tree.species];
  const peak = Math.max(level?.peak ?? 0, (level?.rms ?? 0) * 1.8);
  const pct = Math.min(100, Math.round(Math.sqrt(Math.max(0, peak)) * 140));
  fill.style.width = `${pct}%`;
}

// 档位唯一写入方：zoom 进入/退出。world 标志供 agent 黎明跳过；不主动重置用户家枝/栖位。
function syncControlWithFocus(focusId) {
  for (const tree of CONFIG.trees) {
    if (tree.id === focusId) {
      world.setTreeControl(tree.id, 'USER');
    } else if (world.getTreeControl(tree.id) === 'USER') {
      // 明确的 USER→AGENT 释放：下一拍恢复已有 pattern，不等黎明。
      world.releaseTreeControl(tree.id);
    } else {
      world.setTreeControl(tree.id, 'AGENT');
    }
  }
  audio.setZoomFocus?.(focusId);
  refreshMixControls();
}
function refreshTreeCards() {
  refreshMixControls();
}

// ---- 右侧 drawer + 左侧声部定位器（相机接口存在性保护）----
const infoDrawer = createInfoDrawer({
  drawer: drawerEl,
  toggle: drawerToggleEl,
  // onChange 仅 UI；不得影响播放 / 接管 / 世界
});

const voiceLocator = createVoiceLocator({
  root: voiceLocatorEl,
  renderer,
  voices: VOICE_ORDER,
  onBrowse: (voiceId) => {
    panelVoiceId = voiceId;
    // 浏览不得切 USER / 混音
    refreshMixControls();
  },
  onOverview: () => {
    if (renderer.getFocusTree?.()) {
      renderer.setFocusTree?.(null);
      syncControlWithFocus(null);
    }
    refreshMixControls();
  },
});
// O2：窄栏短提示，完整说明放 title，避免逐字换行
{
  const hint = voiceLocatorEl?.querySelector?.('.voice-locator-hint');
  if (hint) {
    hint.textContent = '↑↓浏览';
    hint.title = '↑↓ 浏览 · 点枝接管 · ←/→ 年轮';
  }
}

refreshTreeCards();

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
    y: (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
  };
}
function holdSpecies(species) {
  // 设计：pad/bass 按住=持续；melody/texture 点一次触发。
  return species === 'pad' || species === 'bass';
}

function isUiBlocked() {
  if (overlay && !overlay.classList.contains('hidden')) return true;
  if (guideOverlay && !guideOverlay.classList.contains('hidden')) return true;
  return false;
}

function syncPanelFromViewport() {
  voiceLocator?.refresh?.();
  const nextPanel = resolvePanelVoiceId();
  if (nextPanel !== panelVoiceId) {
    panelVoiceId = nextPanel;
    refreshMixControls();
  } else {
    syncRingReadout();
  }
}

let pointerHold = null; // { treeId, birdId, branchId }

const ringDrag = createRingDragSession({
  renderer,
  audio,
  trees: CONFIG.trees,
  viewHeight: () => canvas.clientHeight || canvas.height || 360,
  onChange: () => { syncRingReadout(); },
});

function handleCanvasTap(hit) {
  if (!hit) return;
  if (renderer.getCameraMode?.() === 'overview' && hit.treeId != null) {
    renderer.focusVoice?.(hit.treeId);
    panelVoiceId = hit.treeId;
    syncPanelFromViewport();
    return;
  }
  const isUser = hit.treeId != null && world.getTreeControl(hit.treeId) === 'USER';
  const decision = resolveCanvasTapAction(hit, isUser);
  if (decision.action === 'browseVoice') {
    renderer.focusVoice?.(decision.treeId);
    panelVoiceId = decision.treeId;
    syncPanelFromViewport();
    return;
  }
  if (decision.action === 'takeoverOnly') {
    // F3：点枝群/鸟所属声部 → 显式接管；同一次点击不摆鸟/赶鸟
    renderer.setFocusTree?.(decision.treeId);
    syncControlWithFocus(decision.treeId);
    return;
  }
  if (decision.action === 'shoo') {
    world.userShooBird(decision.birdId);
    return;
  }
  if (decision.action === 'place') {
    activateAndPlaceAtStep(decision.treeId, decision.branchId);
    return;
  }
  if (decision.action === 'toggleSequenceCell') {
    const result = world.toggleSequenceCell(
      decision.treeId, decision.pitchBranchId, decision.stepIndex,
    );
    if (result?.active) {
      const stepCount = result.pattern.stepCount;
      world.userPlaceOnBranch(decision.treeId, decision.pitchBranchId, {
        pitchBranchId: decision.pitchBranchId,
        stepIndex: decision.stepIndex,
        stepCount,
      });
    }
  }
}

function currentSequenceAddress(treeId, pitchBranchId) {
  const pattern = world.getSequencePattern(treeId);
  const stepCount = pattern?.stepCount ?? defaultSequenceDimensions(CONFIG).stepCount;
  const { stepIndex } = sequencePlayheadForTree(
    world.getSnapshot().phase, stepCount, treeId, CONFIG,
  );
  return { pitchBranchId, stepIndex, stepCount };
}

// USER 的鼠标、键盘和 MIDI 共用这一条入口：先把当前时间格写入日计划，
// 再沿 world perch 事件触发声音。因此屏幕上的鸟、Sequence cell 与听见的 onset 同址。
function activateAndPlaceAtStep(treeId, pitchBranchId) {
  if (world.getTreeControl(treeId) !== 'USER') return null;
  const address = currentSequenceAddress(treeId, pitchBranchId);
  const pattern = world.getSequencePattern(treeId);
  const occupied = pattern?.occupiedCells?.some((cell) => (
    cell.pitchBranchId === pitchBranchId && cell.stepIndex === address.stepIndex
  ));
  if (!occupied) world.toggleSequenceCell(treeId, pitchBranchId, address.stepIndex);
  return world.userPlaceOnBranch(treeId, pitchBranchId, address);
}

attachViewportInput({
  canvas,
  renderer,
  canvasPoint,
  isBlocked: isUiBlocked,
  onViewportChange: syncPanelFromViewport,
  onHover: (event, hit) => {
    if (!event) {
      renderer.setHoverTree?.(null);
      canvas.style.cursor = 'default';
      return;
    }
    if (!hit) {
      renderer.setHoverTree?.(null);
      canvas.style.cursor = 'default';
      return;
    }
    renderer.setHoverTree?.(hit.treeId);
    if (hit.type === 'ring') canvas.style.cursor = 'ns-resize';
    else if (hit.type === 'tree') canvas.style.cursor = 'pointer';
    else if (hit.type === 'branch' || hit.type === 'bird' || hit.type === 'sequence-node') canvas.style.cursor = 'crosshair';
    else canvas.style.cursor = 'default';
  },
  onPointerDownHit: (hit, event) => {
    if (isRingHit(hit)) {
      ringDrag.start(hit, event);
      return 'ring';
    }
    // pad/bass 按住持续：必须在 down 时落枝，up 时赶走
    if (hit?.type === 'branch'
      && world.getTreeControl(hit.treeId) === 'USER') {
      const tree = CONFIG.trees.find((t) => t.id === hit.treeId);
      if (tree && holdSpecies(tree.species)) {
        const branchId = hit.branchId;
        const placed = activateAndPlaceAtStep(hit.treeId, branchId);
        if (placed && !placed.same) {
          pointerHold = { treeId: hit.treeId, birdId: placed.birdId, branchId };
        }
        return 'consume';
      }
    }
    return null;
  },
  onSuppressedMove: (event) => {
    if (ringDrag.isActive()) ringDrag.move(event);
  },
  onSuppressedUp: (event) => {
    if (ringDrag.isActive()) ringDrag.end(event);
    if (pointerHold) {
      world.userShooBird(pointerHold.birdId);
      pointerHold = null;
    }
  },
  onTap: handleCanvasTap,
});

window.addEventListener('keydown', (event) => {
  // Escape：drawer 打开时由 createInfoDrawer（capture）先关抽屉；此处处理 USER 释放。
  // drawer 开关不得改相机（infoDrawer 无 viewport 副作用）。
  if (event.key === 'Escape') {
    if (infoDrawer.isOpen()) return;
    if (renderer.getFocusTree?.()) {
      renderer.setFocusTree(null);
      syncControlWithFocus(null);
    } else if (renderer.getCameraMode?.() === 'voice') {
      renderer.setCameraMode?.('overview');
      voiceLocator?.refresh?.();
    }
    return;
  }
  const tag = (event.target?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || event.target?.isContentEditable) return;

  // A/S/D/F/G = 五枝；只在当前特写 USER 声部发声，并落到 transport 当前格。
  const pitchKey = ['a', 's', 'd', 'f', 'g'].indexOf(event.key.toLowerCase());
  const focusTree = renderer.getFocusTree?.() ?? null;
  if (pitchKey >= 0 && focusTree && world.getTreeControl(focusTree) === 'USER') {
    event.preventDefault();
    activateAndPlaceAtStep(focusTree, pitchKey);
    return;
  }

  // 年轮键盘微调：←/→ 调整当前声部年轮（若有 getRingControls）
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    && typeof renderer.getRingControls === 'function') {
    const controls = renderer.getRingControls() ?? [];
    const forVoice = controls.filter((c) => c.treeId === panelVoiceId);
    if (forVoice.length) {
      event.preventDefault();
      const dir = event.key === 'ArrowRight' ? 1 : -1;
      let target = forVoice.find((c) => c.controlId === 'gain') ?? forVoice[0];
      if (event.shiftKey) {
        target = forVoice.find((c) => c.controlId === 'reverbSend') ?? target;
      }
      if (event.altKey) {
        const cycled = nextEqCycleTarget(forVoice, eqCycleIndex, dir);
        if (cycled) {
          target = forVoice.find((c) => c.controlId === cycled.controlId) ?? target;
          eqCycleIndex = cycled.nextIndex;
        }
      }
      const step = target.step || 0.05;
      const next = (target.value ?? 0) + dir * step;
      applyRingParam({
        renderer, audio, trees: CONFIG.trees,
        treeId: target.treeId, controlId: target.controlId, value: next,
      });
      syncRingReadout();
      return;
    }
  }

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? -1 : 1;
    // O1：从非吸附位置也直接吸附到相邻声部中心（focusVoice），不用相对 moveViewportBy
    const result = snapKeyboardBrowse(renderer, delta, VOICE_ORDER);
    if (result.ok) {
      syncPanelFromViewport();
      return;
    }
    const cur = voiceLocator.getActive?.() ?? panelVoiceId;
    const fallback = browseVoiceByDelta(renderer, cur, delta, VOICE_ORDER);
    if (fallback.voiceId) {
      voiceLocator.setActive(fallback.voiceId, { browse: true });
    }
  }
});

// 启动时对齐 renderer 年轮与 audio 混音参数
syncRingsFromAudio({ renderer, audio, trees: CONFIG.trees });

// ---- tempo 主控：界面只表达时间流速；数值 BPM / Jungle 倍速 / 昼夜秒数不外露 ----
function refreshTempo() {
  const s = world.getSnapshot();
  const tier = [...TEMPO_LABELS.keys()].reduce((best, bpm) => (
    Math.abs(bpm - s.bpm) < Math.abs(best - s.bpm) ? bpm : best
  ), CONFIG.tempo.defaultBpm);
  bpmLabel.textContent = `时光·${TEMPO_LABELS.get(tier)}`;
  bpmSlider.value = String(tier);
  if (llmScheduler) llmScheduler.timeoutMs = halfDayTimeoutMs();
}
bpmSlider.addEventListener('change', () => {
  if (conductor.getMasterState().control !== 'USER') return;
  requestTempoTarget(Number(bpmSlider.value));
});
bpmSlider.value = String(CONFIG.tempo.defaultBpm);
refreshTempo();

function updateStatus() {
  const s = world.getSnapshot();
  advanceTempoSlew(s.simTime);

  // 视口声部：getVisibleVoice 更新展示，绝不自动 USER
  syncPanelFromViewport();
}

function syncRingReadout() {
  const tree = CONFIG.trees.find((t) => t.id === panelVoiceId);
  const ringHost = treeCardsEl?.querySelector('[data-role="ring-readout"]');
  if (!tree || !ringHost) return;
  syncRingA11yDom(ringHost, tree.id, tree.species, { renderer, audio });
}

// 旧 log-toggle 已并入 Debug 勾选。

// ---- 主循环：固定步进仿真 + 帧渲染 ----
const simDt = 1 / CONFIG.sim.tickHz;
let last = null;
let simAccum = 0;
let paused = false;
const pauseBtn = document.getElementById('pause-btn');

function syncPauseButton() {
  if (!pauseBtn) return;
  pauseBtn.textContent = paused ? '▶ 播放' : '❚❚ 暂停';
  pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
  pauseBtn.classList.toggle('is-paused', paused);
  pauseBtn.title = paused ? '恢复仿真与音频' : '暂停仿真与音频';
}

async function setPaused(next) {
  const want = !!next;
  if (want === paused) return;
  paused = want;
  const tap = audio.getRecordingTap?.();
  const ctx = tap?.audioContext;
  if (ctx) {
    try {
      if (paused && ctx.state === 'running') await ctx.suspend();
      else if (!paused && ctx.state === 'suspended') await ctx.resume();
    } catch { /* 浏览器策略：未手势启动时 suspend/resume 可能拒绝 */ }
  }
  if (!paused) {
    last = null; // 恢复时丢掉积压帧，避免追赶连跳
    simAccum = 0;
  }
  syncPauseButton();
}

pauseBtn?.addEventListener('click', () => {
  setPaused(!paused);
});
syncPauseButton();

function frame(now) {
  try {
    if (last === null) last = now;
    let elapsed = (now - last) / 1000;
    last = now;
    if (elapsed > 0.25) elapsed = 0.25; // 防螺旋：后台标签页回来时最多追 0.25s
    if (!paused) {
      simAccum += elapsed;
      while (simAccum >= simDt) {
        world.tick(simDt);
        const latentUpdates = ecologicalLatent.update(
          world.getSnapshot(), simDt, (treeId) => world.getTreeControl(treeId),
        );
        for (const update of latentUpdates) latentExploration.feed({
          treeId: update.treeId,
          position: update.xy,
          source: 'agent',
          mode: 'xy',
          sent: update.sent,
        });
        simAccum -= simDt;
      }
    }
    const masterTransport = transportFromPhase(world.getSnapshot().phase, CONFIG.tempo);
    const masterBarKey = `${world.getSnapshot().day}:${masterTransport.bar}`;
    if (lastMasterBarKey == null) lastMasterBarKey = masterBarKey;
    else if (masterBarKey !== lastMasterBarKey) {
      lastMasterBarKey = masterBarKey;
      if (conductor.getMasterState().control === 'USER') {
        if (pendingMasterMeter != null && world.setBeatsPerBar(pendingMasterMeter)) pendingMasterMeter = null;
        if (pendingMasterColor && conductor.applyUserColor(pendingMasterColor)) pendingMasterColor = null;
        refreshTempo();
        refreshMasterControls();
      }
    }
    renderer.render({ ...world.getSnapshot(), season: conductor.getChord().season });
    updateStatus();
    refreshMixMeters();
  } catch (error) {
    console.error('[frame] render loop recovered from error', error);
  } finally {
    requestAnimationFrame(frame);
  }
}

function resize() {
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  renderer.resize?.();
}
window.addEventListener('resize', resize);
resize();

startBtn.addEventListener('click', async () => {
  await audio.start();
  enableMidiInput();
  overlay.classList.add('hidden');
  maybeShowGuide();
});

let midiAccess = null;
function handleMidiMessage(event) {
  const [status = 0, note = 0, velocity = 0] = event.data ?? [];
  if ((status & 0xf0) !== 0x90 || velocity === 0) return;
  const treeId = renderer.getFocusTree?.() ?? null;
  if (!treeId || world.getTreeControl(treeId) !== 'USER') return;
  activateAndPlaceAtStep(treeId, Math.abs(Number(note) || 0) % 5);
}
function bindMidiInputs() {
  for (const input of midiAccess?.inputs?.values?.() ?? []) input.onmidimessage = handleMidiMessage;
}
function enableMidiInput() {
  if (midiAccess || typeof navigator.requestMIDIAccess !== 'function') return;
  navigator.requestMIDIAccess().then((access) => {
    midiAccess = access;
    bindMidiInputs();
    access.onstatechange = bindMidiInputs;
  }).catch((error) => {
    console.warn('[midi] 输入不可用:', error?.message ?? error);
  });
}

// ---- 录制导出（recorder.js）：主输出 → webm；音频未启动或环境不支持时给提示 ----
const recordBtn = document.getElementById('record-btn');
let recorder = null;
recordBtn.addEventListener('click', async () => {
  if (recorder?.isRecording()) {
    const blob = await recorder.stop();
    recordBtn.classList.remove('recording');
    recordBtn.textContent = '● 录制';
    if (blob) downloadBlob(blob, `latent-cosmos-${Date.now()}.webm`);
    return;
  }
  const tap = audio.getRecordingTap();
  if (!tap) { appendLog('录制需先 ▶ 进入启用音频', 'master'); return; }
  recorder = recorder ?? createRecorder(tap);
  if (!recorder) { appendLog('此环境不支持 MediaRecorder 录制', 'master'); return; }
  recorder.start();
  recordBtn.classList.add('recording');
  recordBtn.textContent = '■ 停止并导出';
});

appendLog('决策日志就绪：双树同屏，黎明换和弦 + 评估流水线（复盘昨天 → 后天生效）。', 'day');
requestAnimationFrame(frame);

// 调试/冒烟钩子：允许外部快进 world.tick 验证昼夜行为（不影响内部逻辑）。
// 音频引擎：控制台里做音色漫游用——__audio.roamTo(species, [x,y], k) 换该
// 物种自己漫游地图上的坐标，__audio.isNeural(species) 看是否已被神经接管。
window.__audio = audio;
window.__world = world;
window.__conductor = conductor;
window.__llmDebug = () => ({
  configured: !!window.LCS_RUNTIME?.stepfunBase,
  scheduler: llmScheduler ? llmScheduler.getState() : null,
  survivalShadow: survivalShadow.snapshot(),
});
