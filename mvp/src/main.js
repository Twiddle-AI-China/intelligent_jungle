// mvp/src/main.js —— 装配层：world / harmony / agent(流水线+master) / mapping / audio / renderer。
// Phase 1.9 双树同屏：pad 树 + melody 树等大并排（替代 profile 切换），双音色双鸟群；
// 计划契约 {dwellBeats, activeBars, holdLoops, mutations[]}；key 自动加载
// （local-config.js → localStorage → 输入框）。发声保持栖落事件驱动。

import { CONFIG } from './config.js';
import { createWorld } from './world.js';
import { attachPipelineConductor } from './agent.js';
import { createAudioEngine, MIX_PARAM_SPECS } from './audio.js';
import { createRenderer } from './renderer.js';
import { createAgentPipeline } from './llm/integration.js';
import { createDayPlanScheduler } from './llm/scheduler.js';
import { chainProviders, createMinimaxClient } from './llm/client.js';
import { createBirdAgentClient } from './llm/openai-client.js';
import { createMasterLlmClient } from './master/llm-master.js';
import { resolveMasterDecisionWithSource } from './master/external-master.js';
import { decideMaster, getMasterDecisionEvidence } from './master/policy.js';
import { transportFromPhase } from './harmony.js';
import {
  createDayObserver, scoreDay, scoreBreakdown, deviationReport,
  loudnessBalanceFromLevels, clipWarnFromLevels,
} from './economy.js';
import { createTimelinePanel } from './timeline.js';
import { createRecorder, downloadBlob } from './recorder.js';

const canvas = document.getElementById('scene');
const logEl = document.getElementById('decision-log');
const statusEl = document.getElementById('status');
const transportEl = document.getElementById('transport');
const patternEl = document.getElementById('pattern');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start-btn');
const bpmSlider = document.getElementById('bpm');
const bpmLabel = document.getElementById('bpm-label');
const apiKeyInput = document.getElementById('api-key');

const world = createWorld({ config: CONFIG });
const renderer = createRenderer(canvas, CONFIG);
const KEY_STORAGE = 'lcs_minimax_key';

// ---- 决策日志：按天分组，决策来源逐行标注 ----
let logRows = 0;
function appendLog(text, kind = 'event') {
  const row = document.createElement('div');
  row.className = `log-row log-${kind}`;
  row.textContent = text;
  logEl.appendChild(row);
  logRows += 1;
  if (logRows > CONFIG.log.maxRows) {
    logEl.removeChild(logEl.firstChild);
    logRows -= 1;
  }
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- LLM 接线（key 只存内存/localStorage，绝不进 git）----
let apiKey = null;
let llmScheduler = null; // 换 BPM 时同步派生超时
function llmStatus() { return apiKey ? 'LLM+规则兜底' : '规则层'; }

function halfDayTimeoutMs() {
  return Math.max(3000, world.getSnapshot().dayLength * 1000 * CONFIG.llm.timeoutDayFraction);
}

// provider 链：bird_agent（本地 8081，健康检查通过才入链）→ MiniMax → 规则兜底。
// 任何探测失败（超时/网络错/非 200/挂起）都静默落链，绝不阻塞应用启动（T19）。
async function pickFlockProvider(key) {
  const minimax = createMinimaxClient({ apiKey: key });
  const minimaxOnly = () => ({
    provider: minimax, masterLlm: createMasterLlmClient({ apiKey: key }), origin: 'MiniMax',
  });
  const birdBase = (typeof window !== 'undefined' && window.LCS_KEYS?.birdAgentBase) || null;
  if (!birdBase) return minimaxOnly();
  try {
    const bird = createBirdAgentClient({ baseUrl: birdBase });
    if (await bird.checkHealth()) {
      return {
        provider: chainProviders(bird, minimax),
        masterLlm: chainProviders(bird, createMasterLlmClient({ apiKey: key })),
        origin: 'bird_agent→MiniMax',
      };
    }
    appendLog('bird_agent 健康检查失败，回落 MiniMax', 'master');
  } catch {
    appendLog('bird_agent 探测异常，回落 MiniMax', 'master');
  }
  return minimaxOnly();
}

function buildPipeline(key, { provider, masterLlm }) {
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

// 无 key 时也走同一条 pipeline 路径（恒 null → 恒规则兜底），代码不分叉
function nullPipeline() {
  return createAgentPipeline({
    flockScheduler: async () => null,
    masterDecide: async () => null,
    masterFallback: (input) => decideMaster(input),
  });
}

async function engageKey(key, origin) {
  apiKey = key || null;
  if (!apiKey) {
    conductor.setPipeline(nullPipeline());
    appendLog('纯规则层运行', 'master');
    return;
  }
  try {
    const picked = await pickFlockProvider(apiKey);
    conductor.setPipeline(buildPipeline(apiKey, picked));
    appendLog(`LLM 已接入（${origin}，${picked.origin}）→ LLM+规则兜底`, 'master');
  } catch {
    // provider 选择链任何异常都不得影响启动：回到 MiniMax 单链。
    conductor.setPipeline(buildPipeline(apiKey, {
      provider: createMinimaxClient({ apiKey }),
      masterLlm: createMasterLlmClient({ apiKey }),
    }));
    appendLog('LLM provider 探测异常，回落 MiniMax 单链', 'master');
  }
}

// ---- 生态计分接线（economy）：逐树观察器，黄昏结算，喂日评估与 LLM ----
const TREE_NAMES = { pad: 'pad树', melody: 'melody树', bass: '鹈鹕树', texture: '啄木鸟树' };
const ecoObservers = Object.fromEntries(CONFIG.trees.map((t) => [
  t.id, createDayObserver(CONFIG.economy.prefs[t.species]),
]));
const latestEcology = {};   // treeId → 契约对象 {branchChangesPerLoop, meanDwellBeats, clusterSize, loudnessBalance, score, harmonyScore, deviation}
const beatsPerSecond = () => world.getSnapshot().bpm / 60;
// world 的具名事件载荷不带事件名，economy 的 eventType() 需要 event 字段——补上。
world.on('perch', (e) => ecoObservers[e.treeId]?.feed({ ...e, event: 'perch' }));
world.on('unperch', (e) => ecoObservers[e.treeId]?.feed(
  { ...e, event: 'unperch', dwellTime: e.dwellTime * beatsPerSecond() }, // 驻留折算成拍
));
// 用 onBeforeDawn（注册先于 conductor → 先执行）：保证黎明 dayReview 拿到的
// 是刚结束这一天的观察，而不是隔一天的旧数据。
world.onBeforeDawn(() => {
  // 读当日 RMS（不 reset：audio.attach 的黎明钩子随后关账重置累加器）。
  // audio 为后声明 const；本回调在模块初始化完成后才触发，闭包安全。
  const levels = typeof audio?.getAudioLevels === 'function'
    ? audio.getAudioLevels({ sample: true, reset: false })
    : null;
  const loudCfg = CONFIG.economy.loudness ?? {};
  for (const t of CONFIG.trees) {
    const day = ecoObservers[t.id].finishDay();
    const loudnessBalance = loudnessBalanceFromLevels(levels, t.species);
    const clipWarn = clipWarnFromLevels(levels, t.species, loudCfg.clipPeakWarn);
    const observed = {
      branchChanges: day.branchChanges,
      meanDwell: day.meanDwell,
      cohortSize: day.cohortSize,
      loudnessBalance,
    };
    const prefs = CONFIG.economy.prefs[t.species];
    const dev = deviationReport(observed, prefs);
    latestEcology[t.id] = {
      branchChangesPerLoop: observed.branchChanges,
      meanDwellBeats: observed.meanDwell,
      clusterSize: observed.cohortSize,
      loudnessBalance,
      clipWarn,
      peak: levels?.[t.species]?.peak ?? null,
      score: scoreDay(observed, prefs),
      // 和谐分 H（只观测不进分，display key 契约：harmonyScore）。
      // 本钩子注册先于 conductor：此时 conductor 的 H 计数还是刚结束当天的完整值
      // （conductor 在自己的 onBeforeDawn 末尾才重置）。conductor 为 const 后声明，
      // 模块初始化完成后本回调才执行，闭包取得到。
      harmonyScore: conductor.getHarmonyScores()[t.id]?.harmonyScore ?? null,
      deviation: {
        branchChanges: { direction: dev.branchChanges, amount: dev.magnitude.branchChanges },
        meanDwell: { direction: dev.meanDwell, amount: dev.magnitude.meanDwell },
        cohortSize: { direction: dev.cohortSize, amount: dev.magnitude.cohortSize },
        loudnessBalance: { direction: dev.loudnessBalance, amount: dev.magnitude.loudnessBalance },
      },
    };
  }
  updateEco();
});

const ecoEl = document.getElementById('eco');
function ecoBreakdown(entry, prefs) {
  return scoreBreakdown({
    branchChanges: entry.branchChangesPerLoop,
    meanDwell: entry.meanDwellBeats,
    cohortSize: entry.clusterSize,
    loudnessBalance: entry.loudnessBalance,
  }, prefs).metrics;
}

function formatBand({ lo, hi }) {
  return `[${lo},${Number.isFinite(hi) ? hi : '∞'}]`;
}

function masterEvidenceText(decision) {
  const evidence = getMasterDecisionEvidence(decision);
  if (!evidence) return '三观依据—（非 policy 决策）';
  const { balance, freshness, stability } = evidence;
  const daysSinceChange = stability.daysSinceChange == null ? '—' : stability.daysSinceChange;
  return `均衡${balance.lowLabel}·低分${balance.maxStreak}天·min${balance.lowestToday.toFixed(2)}/阈${balance.scoreFloor.toFixed(2)}`
    + ` · 新鲜同档${freshness.daysInColor}天/相似${freshness.patternSimilarity.toFixed(2)}`
    + `（阈${freshness.boredDays}天|${freshness.similarityThreshold.toFixed(2)}）`
    + ` · 平稳换季后${daysSinceChange}天/冷却${stability.cooldownDays}天`
    + `${stability.inCooldown ? '·冷却中' : ''}`;
}

function updateEco() {
  ecoEl.textContent = CONFIG.trees.map((t) => {
    const e = latestEcology[t.id];
    // 和谐分 H 来自日结生态快照；首日尚未结算时读 conductor 的实时观测。
    const h = e?.harmonyScore ?? conductor.getHarmonyScores()[t.id]?.harmonyScore;
    const harmonyTxt = ` · 和谐${Number.isFinite(Number(h)) ? Number(h).toFixed(2) : '—'}`;
    if (!e) return `${TREE_NAMES[t.id] ?? t.id} 长势 —（首日观察中）${harmonyTxt}`;
    const dimensions = ecoBreakdown(e, CONFIG.economy.prefs[t.species]);
    const metric = (label, key, value, unit) => {
      const d = dimensions[key];
      if (!d || d.direction === 'exempt' || d.score == null) {
        return `${label}— / 偏好${d ? formatBand(d) : '—'} / 豁免`;
      }
      const mark = d.direction === 'within' ? '带内' : d.direction === 'low' ? '偏低' : '偏高';
      return `${label}${value}${unit} / 偏好${formatBand(d)} / ${mark}·分${d.score.toFixed(2)}`;
    };
    const loudVal = Number.isFinite(Number(e.loudnessBalance))
      ? Number(e.loudnessBalance).toFixed(1)
      : null;
    const clipTxt = e.clipWarn
      ? ` · 削波告警 peak${Number(e.peak).toFixed(2)}`
      : '';
    return `${TREE_NAMES[t.id] ?? t.id} 长势总分 ${e.score.toFixed(2)}${harmonyTxt}\n`
      + `  ${metric('换枝', 'branchChanges', e.branchChangesPerLoop, '次')}`
      + ` · ${metric('驻留', 'meanDwell', e.meanDwellBeats.toFixed(1), '拍')}`
      + ` · ${metric('群聚', 'cohortSize', e.clusterSize, '只')}`
      + ` · ${metric('响度', 'loudnessBalance', loudVal, 'dB')}${clipTxt}`;
  }).join('\n');
}
// 初始绘制在 conductor 建成后（updateEco 的和谐分回退读取 conductor 实时观测）

// ---- 评估流水线 + master（先建 conductor：audio 需要它的 getChord）----
const conductor = attachPipelineConductor(world, {
  config: CONFIG,
  pipeline: nullPipeline(), // 默认纯规则；key 就绪后换入 LLM pipeline
  ecologyProvider: (treeId) => latestEcology[treeId] ?? null,
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
        mut = 'USER 接管·跳过计划';
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
        action: source === 'USER' ? 'USER 接管' : applied.length ? `变异×${applied.length}` : '保持 pattern',
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
    // 新契约（季=单和弦）：色彩档 + 张力；兼容旧 advanceStep/jumpToStep/changeSeason 形状。
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

const audio = createAudioEngine({ config: CONFIG, getChord: conductor.getChord, getFrame: conductor.getFrame });
audio.attach(world);

// ---- key 自动加载：local-config.js → localStorage → 输入框 ----
const bootKey = (typeof window !== 'undefined' && window.LCS_KEYS?.minimax)
  || (() => { try { return localStorage.getItem(KEY_STORAGE); } catch { return null; } })();
if (bootKey) engageKey(bootKey, typeof window !== 'undefined' && window.LCS_KEYS?.minimax ? 'local-config.js' : 'localStorage');

apiKeyInput.addEventListener('change', () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    try { localStorage.setItem(KEY_STORAGE, key); } catch { /* 私密模式等 */ }
    engageKey(key, '输入框已存 localStorage');
  } else {
    try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
    engageKey(null, '');
  }
  apiKeyInput.value = ''; // 输入框不保留明文
  apiKeyInput.placeholder = apiKey ? 'LLM 已接入 · 输入新 key 可替换' : 'MiniMax API key（仅内存）';
});

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

// ---- 枝位面板：按树分组（事件驱动更新）----
function updatePattern() {
  const s = world.getSnapshot();
  patternEl.textContent = s.trees.map((tree) => {
    const byBranch = new Map(tree.branches.map((b) => [b.id, []]));
    for (const b of tree.birds) {
      if (b.state === 'perched') byBranch.get(b.branchId)?.push(b.id);
    }
    const rows = tree.branches
      .map((br) => `  枝${br.id}: ${(byBranch.get(br.id) ?? []).map((id) => `鸟${id}`).join(' ') || '—'}`)
      .join('\n');
    return `${TREE_NAMES[tree.id] ?? tree.id}（${tree.species}）\n${rows}`;
  }).join('\n');
}
world.on('perch', updatePattern);
world.on('unperch', updatePattern);
world.on('dawn', updatePattern);
updatePattern();

// ---- Phase 4 / R3：档位=zoom；特写树=USER + 声部 MIX 面板（侧缘竖滑杆）----
const treeCardsEl = document.getElementById('tree-cards');
const mixPanelEl = document.getElementById('mix-panel');
const mixSlidersEl = document.getElementById('mix-sliders');
const CARD_LABELS = { pad: 'PAD · 斑鸠', melody: 'MELODY · 百灵', bass: 'BASS · 鹈鹕', texture: 'TEXTURE · 啄木鸟' };

function formatMixValue(key, value) {
  if (key.endsWith('Db')) return `${value >= 0 ? '+' : ''}${Number(value).toFixed(1)}`;
  if (key === 'phraseMaxNotes' || key === 'grainCountMax') return String(Math.round(value));
  if (key === 'attackSeconds') return `${Number(value).toFixed(2)}s`;
  if (key === 'reverbSend' || key === 'arpDensityMax' || key === 'gain') return Number(value).toFixed(2);
  return String(value);
}

function refreshMixPanel(focusId) {
  if (!mixPanelEl || !mixSlidersEl) return;
  if (!focusId) {
    mixPanelEl.classList.add('hidden');
    mixSlidersEl.innerHTML = '';
    return;
  }
  const tree = CONFIG.trees.find((t) => t.id === focusId);
  if (!tree) { mixPanelEl.classList.add('hidden'); return; }
  const species = tree.species;
  const specs = [...(MIX_PARAM_SPECS.common ?? []), ...(MIX_PARAM_SPECS[species] ?? [])];
  const values = audio.getMixParams?.(species) ?? {};
  mixSlidersEl.innerHTML = '';
  const title = mixPanelEl.querySelector('.mix-title');
  if (title) title.textContent = species.toUpperCase();
  for (const spec of specs) {
    const row = document.createElement('div');
    row.className = 'mix-row';
    const label = document.createElement('div');
    label.className = 'mix-label';
    label.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(values[spec.key] ?? spec.min);
    input.dataset.key = spec.key;
    input.title = spec.node ?? spec.key;
    const val = document.createElement('div');
    val.className = 'mix-val';
    val.textContent = formatMixValue(spec.key, Number(input.value));
    input.addEventListener('input', () => {
      const next = Number(input.value);
      audio.setParam?.(species, spec.key, next);
      val.textContent = formatMixValue(spec.key, next);
    });
    row.append(label, input, val);
    mixSlidersEl.appendChild(row);
  }
  mixPanelEl.classList.remove('hidden');
}

// 档位唯一写入方：zoom 进入/退出。world 标志供 agent 黎明跳过；不主动重置用户家枝/栖位。
function syncControlWithFocus(focusId) {
  for (const tree of CONFIG.trees) {
    world.setTreeControl(tree.id, tree.id === focusId ? 'USER' : 'AGENT');
  }
  audio.setZoomFocus?.(focusId);
  refreshTreeCards();
  refreshMixPanel(focusId);
}
function refreshTreeCards() {
  if (!treeCardsEl) return;
  const focus = renderer.getFocusTree?.() ?? null;
  for (const tree of CONFIG.trees) {
    let card = treeCardsEl.querySelector(`[data-tree-id="${tree.id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'tree-card';
      card.dataset.treeId = tree.id;
      card.innerHTML = `<span class="card-name"></span>`;
      treeCardsEl.appendChild(card);
      card.addEventListener('click', () => {
        const next = renderer.toggleFocusTree(tree.id);
        syncControlWithFocus(next);
        appendLog(
          next
            ? `${TREE_NAMES[tree.id] ?? tree.id} 特写 · USER 接管`
            : '回退全窗口 · 全树 AGENT',
          'apply',
        );
      });
    }
    card.classList.toggle('focused', focus === tree.id);
    card.title = focus === tree.id ? '特写中（USER）· 再点或 Esc 退出' : '点名进入特写（USER 接管）';
    card.querySelector('.card-name').textContent = CARD_LABELS[tree.id] ?? tree.id;
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
let pointerHold = null; // { treeId, birdId, branchId }
function onCanvasPointerDown(event) {
  if (overlay && !overlay.classList.contains('hidden')) return;
  const { x, y } = canvasPoint(event);
  const hit = renderer.hitTest?.(x, y);
  if (!hit) return;
  if (hit.type === 'tree') {
    const next = renderer.toggleFocusTree(hit.treeId);
    syncControlWithFocus(next);
    return;
  }
  const tree = CONFIG.trees.find((t) => t.id === hit.treeId);
  if (!tree) return;
  // 点选摆鸟仅特写（USER）树；AGENT 树点枝提示先进入特写。
  if (world.getTreeControl(hit.treeId) !== 'USER') {
    if (hit.type === 'branch' || hit.type === 'bird') {
      appendLog(`${TREE_NAMES[hit.treeId]} 仍为 AGENT：先点树进入特写再摆鸟`, 'event');
    }
    return;
  }
  if (hit.type === 'bird') {
    world.userShooBird(hit.birdId);
    return;
  }
  if (hit.type === 'branch') {
    const placed = world.userPlaceOnBranch(hit.treeId, hit.branchId);
    if (!placed || placed.same) return;
    if (holdSpecies(tree.species)) {
      pointerHold = { treeId: hit.treeId, birdId: placed.birdId, branchId: hit.branchId };
      try { canvas.setPointerCapture?.(event.pointerId); } catch { /* 合成/失效 pointerId 忽略 */ }
    }
  }
}
function onCanvasPointerUp(event) {
  if (!pointerHold) return;
  world.userShooBird(pointerHold.birdId);
  pointerHold = null;
  try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
}
canvas.addEventListener('pointerdown', onCanvasPointerDown);
canvas.addEventListener('pointerup', onCanvasPointerUp);
canvas.addEventListener('pointercancel', onCanvasPointerUp);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && renderer.getFocusTree?.()) {
    renderer.setFocusTree(null);
    syncControlWithFocus(null);
  }
});

// ---- tempo 主控：BPM 滑条，昼夜时长派生，调度器超时同步 ----
function refreshTempo() {
  const s = world.getSnapshot();
  bpmLabel.textContent = `${s.bpm} BPM · ${s.dayLength.toFixed(1)}s/昼夜`;
  if (llmScheduler) llmScheduler.timeoutMs = halfDayTimeoutMs();
}
bpmSlider.addEventListener('input', () => {
  if (world.setTempo(Number(bpmSlider.value))) refreshTempo();
});
bpmSlider.value = String(CONFIG.tempo.defaultBpm);
refreshTempo();

// ---- 状态行 + transport ----
function phaseName(phase) {
  if (phase < 0.06 || phase >= 0.97) return '黎明';
  if (phase < 0.44) return '白昼';
  if (phase < 0.56) return '黄昏';
  return '夜晚';
}

function updateStatus() {
  const s = world.getSnapshot();
  const chord = conductor.getChord();
  const perTree = s.trees.map((t) => `${TREE_NAMES[t.id] ?? t.id} 栖${t.perchedTotal}/${t.birds.length}`).join(' · ');
  statusEl.textContent = `第 ${s.day} 天 · ${phaseName(s.phase)} · ${perTree} · ${llmStatus()}`;
  const t = transportFromPhase(s.phase, CONFIG.tempo);
  // 和声框架优先读快照，缺省时直接读取 conductor 当前 frame。
  const frame = s.harmonicFrame
    ?? (typeof conductor.getFrame === 'function' ? conductor.getFrame() : null);
  let seasonTxt = '';
  if (frame && typeof frame === 'object') {
    const seasons = Array.isArray(CONFIG.harmony.seasons) ? CONFIG.harmony.seasons : [];
    const idx = seasons.indexOf(frame.season);
    const seasonName = CONFIG.harmony.seasonNames?.[frame.season] ?? frame.season ?? '—';
    const colorId = frame.color?.id ?? frame.colorId ?? '—';
    const tension = Number(frame.tension);
    seasonTxt = ` · 第${idx >= 0 ? idx + 1 : '?'}季(${seasonName})`
      + `·季内第${(Number(frame.seasonDay) || 0) + 1}/${frame.seasonLength ?? '?'}天`
      + `·色彩档${colorId}·张力${Number.isFinite(tension) ? tension.toFixed(1) : '—'}`;
  }
  transportEl.textContent = `transport: 第 ${s.day} 天 · 第 ${t.bar} 小节.第 ${t.beat} 拍`
    + ` · ${chord.id}（${chord.seasonName}）· ${s.bpm} BPM${seasonTxt}`;
}

// ---- 主循环：固定步进仿真 + 帧渲染 ----
const simDt = 1 / CONFIG.sim.tickHz;
let last = null;
let simAccum = 0;
function frame(now) {
  if (last === null) last = now;
  let elapsed = (now - last) / 1000;
  last = now;
  if (elapsed > 0.25) elapsed = 0.25; // 防螺旋：后台标签页回来时最多追 0.25s
  simAccum += elapsed;
  while (simAccum >= simDt) {
    world.tick(simDt);
    simAccum -= simDt;
  }
  renderer.render({ ...world.getSnapshot(), season: conductor.getChord().season });
  updateStatus();
  requestAnimationFrame(frame);
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
  overlay.classList.add('hidden');
});

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
// 音频引擎：控制台里做音色漫游用 —— __audio.roamTo(0..8) 换 atlas 锚点，
// __audio.isNeural() 看神经音源是否已接管。与 __world/__conductor 同一约定。
window.__audio = audio;
window.__world = world;
window.__conductor = conductor;
window.__llmDebug = () => ({ apiKey: !!apiKey, scheduler: llmScheduler ? llmScheduler.getState() : null });
