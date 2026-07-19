// mvp/src/main.js —— 装配层：world / harmony / agent(流水线+master) / mapping / audio / renderer。
// Phase 1.9 双树同屏：pad 树 + melody 树等大并排（替代 profile 切换），双音色双鸟群；
// 计划契约 {dwellBeats, activeBars, holdLoops, mutations[]}；key 自动加载
// （local-config.js → localStorage → 输入框）。发声保持栖落事件驱动。

import { CONFIG } from './config.js';
import { createWorld } from './world.js';
import { attachPipelineConductor } from './agent.js';
import { createAudioEngine } from './audio.js';
import { createRenderer } from './renderer.js';
import { createAgentPipeline } from './llm/integration.js';
import { createDayPlanScheduler } from './llm/scheduler.js';
import { createMinimaxClient } from './llm/client.js';
import { createMasterLlmClient } from './master/llm-master.js';
import { createExternalMaster, resolveMasterDecisionWithSource } from './master/external-master.js';
import { decideMaster } from './master/policy.js';
import { transportFromPhase } from './harmony.js';
import { createDayObserver, scoreDay, deviationReport } from './economy.js';
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

function buildPipeline(key) {
  const client = createMinimaxClient({ apiKey: key });
  llmScheduler = createDayPlanScheduler({ client, timeoutMs: halfDayTimeoutMs() });
  const masterLlm = createMasterLlmClient({ apiKey: key });
  // 玮圣外部 master 接口位：endpoint 未配置时恒 null，决策序 external → llm →（pipeline 的）policy 兜底
  const externalMaster = createExternalMaster({
    endpoint: window.LCS_KEYS?.masterEndpoint,
    headers: window.LCS_KEYS?.masterHeaders ?? {},
    timeoutMs: halfDayTimeoutMs(),
  });
  return createAgentPipeline({
    flockScheduler: llmScheduler,
    masterDecide: (input) => resolveMasterDecisionWithSource({ external: externalMaster, llm: masterLlm }, input),
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

function engageKey(key, origin) {
  apiKey = key || null;
  conductor.setPipeline(apiKey ? buildPipeline(apiKey) : nullPipeline());
  appendLog(apiKey ? `LLM 已接入（${origin}）→ LLM+规则兜底` : '纯规则层运行', 'master');
}

// ---- 生态计分接线（economy）：逐树观察器，黄昏结算，喂日评估与 LLM ----
const TREE_NAMES = { pad: 'pad树', melody: 'melody树' };
const ecoObservers = Object.fromEntries(CONFIG.trees.map((t) => [
  t.id, createDayObserver(CONFIG.economy.prefs[t.species]),
]));
const latestEcology = {};   // treeId → 契约对象 {branchChangesPerLoop, meanDwellBeats, clusterSize, score, deviation}
const beatsPerSecond = () => world.getSnapshot().bpm / 60;
// world 的具名事件载荷不带事件名，economy 的 eventType() 需要 event 字段——补上。
world.on('perch', (e) => ecoObservers[e.treeId]?.feed({ ...e, event: 'perch' }));
world.on('unperch', (e) => ecoObservers[e.treeId]?.feed(
  { ...e, event: 'unperch', dwellTime: e.dwellTime * beatsPerSecond() }, // 驻留折算成拍
));
// 用 onBeforeDawn（注册先于 conductor → 先执行）：保证黎明 dayReview 拿到的
// 是刚结束这一天的观察，而不是隔一天的旧数据。
world.onBeforeDawn(() => {
  for (const t of CONFIG.trees) {
    const observed = ecoObservers[t.id].finishDay();
    const prefs = CONFIG.economy.prefs[t.species];
    const dev = deviationReport(observed, prefs);
    latestEcology[t.id] = {
      branchChangesPerLoop: observed.branchChanges,
      meanDwellBeats: observed.meanDwell,
      clusterSize: observed.cohortSize,
      score: scoreDay(observed, prefs),
      deviation: {
        branchChanges: { direction: dev.branchChanges, amount: dev.magnitude.branchChanges },
        meanDwell: { direction: dev.meanDwell, amount: dev.magnitude.meanDwell },
        cohortSize: { direction: dev.cohortSize, amount: dev.magnitude.cohortSize },
      },
    };
  }
  updateEco();
});

const ecoEl = document.getElementById('eco');
function updateEco() {
  ecoEl.textContent = CONFIG.trees.map((t) => {
    const e = latestEcology[t.id];
    if (!e) return `${TREE_NAMES[t.id] ?? t.id} 长势 —（首日观察中）`;
    const mark = (d) => (d.direction === 'within' ? '✓' : d.direction === 'low' ? '低' : '高');
    return `${TREE_NAMES[t.id] ?? t.id} 长势 ${(e.score * 100).toFixed(0)}`
      + ` · 换枝${e.branchChangesPerLoop}/循环${mark(e.deviation.branchChanges)}`
      + ` · 驻留${e.meanDwellBeats > 0 ? `${e.meanDwellBeats.toFixed(1)}拍${mark(e.deviation.meanDwell)}` : '—（当日无起落）'}`
      + ` · 群聚${e.clusterSize}${mark(e.deviation.cohortSize)}`;
  }).join('\n');
}
updateEco();

// ---- 评估流水线 + master（先建 conductor：audio 需要它的 getChord）----
const conductor = attachPipelineConductor(world, {
  config: CONFIG,
  pipeline: nullPipeline(), // 默认纯规则；key 就绪后换入 LLM pipeline
  ecologyProvider: (treeId) => latestEcology[treeId] ?? null,
  onPlan: ({ source, reviewedDay, targetDay }) => {
    appendLog(`第 ${reviewedDay + 1} 天·复盘第 ${reviewedDay} 天 → 第 ${targetDay} 天生效（${source}）`, 'plan');
  },
  onApply: ({ plans, day, migrations }) => {
    for (const [treeId, { plan, source, held }] of Object.entries(plans)) {
      const mut = plan.mutations.length ? plan.mutations.map((m) => `鸟${m.birdId}:${m.from}→${m.to}`).join(' ') : '无变异';
      const hold = held.held ? ` · 乐句保持中(余${held.holdLeft})` : held.expired ? ` · 期满小变(下期${held.nextLoops})` : '';
      appendLog(`${TREE_NAMES[treeId] ?? treeId}（${source}）: ${mut} · 驻留${plan.dwellBeats.toFixed(1)}拍${hold}`, 'apply');
      timelinePanel?.appendDecision({
        day,
        actor: 'flock',
        flockId: treeId,
        source: source.includes('LLM') ? 'llm' : 'rule',
        action: plan.mutations.length ? `变异×${plan.mutations.length}` : '保持 pattern',
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
    const what = decision.changeSeason ? `换季→${decision.changeSeason}`
      : Number.isInteger(decision.jumpToStep) ? `跳步→第${decision.jumpToStep + 1}步`
        : '顺走';
    appendLog(`master（${source}）: ${what} · ${chord.id}（${chord.seasonName}）${seasonChanged ? ' · 已换季' : ''}`, 'master');
    timelinePanel?.appendDecision({
      day: world.getSnapshot().day,
      actor: 'master',
      source: source.includes('LLM') ? 'llm' : source.includes('external') || source.includes('外部') ? 'external' : 'rule',
      action: what,
      reason: decision.reason ?? `${chord.id}（${chord.seasonName}）`,
    });
  },
});

// ---- 决策时间线面板（timeline.js 挂载；无 DOM 时安全为 null）----
const timelinePanel = createTimelinePanel({
  container: document.getElementById('timeline'),
  maxDays: 14,
});

const audio = createAudioEngine({ config: CONFIG, getChord: conductor.getChord });
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
  `${TREE_NAMES[e.treeId] ?? ''}鸟${e.birdId} 离枝#${e.branchId}（${e.cause}·驻留 ${e.dwellTime.toFixed(1)}s）`, 'event'));
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
  transportEl.textContent = `transport: 第 ${s.day} 天 · 第 ${t.bar} 小节.第 ${t.beat} 拍`
    + ` · ${chord.id}（${chord.seasonName}）· ${s.bpm} BPM`;
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
  renderer.render(world.getSnapshot());
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
window.__world = world;
window.__conductor = conductor;
window.__llmDebug = () => ({ apiKey: !!apiKey, scheduler: llmScheduler ? llmScheduler.getState() : null });
