#!/usr/bin/env node

import { MinimaxClient } from '../src/llm/client.js';
import { DayPlanScheduler } from '../src/llm/scheduler.js';
import { MasterLlmClient } from '../src/master/llm-master.js';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.error('缺少 MINIMAX_API_KEY。请先执行：export MINIMAX_API_KEY="你的 MiniMax API Key"');
  console.error('然后运行：node mvp/tools/llm-live-smoke.mjs');
  process.exitCode = 2;
}

function diagnosticFetch(label) {
  let latest = null;
  return {
    async fetchImpl(url, options) {
      const started = performance.now();
      try {
        const response = await fetch(url, options);
        const text = await response.clone().text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* 保留原文片段 */ }
        latest = {
          label,
          httpStatus: response.status,
          httpOk: response.ok,
          baseStatus: data?.base_resp?.status_code ?? null,
          requestMs: Math.round(performance.now() - started),
          content: data?.choices?.[0]?.message?.content ?? null,
          snippet: text.replace(/\s+/g, ' ').slice(0, 360),
        };
        console.log(`[${label}] 原始响应摘要`, latest);
        return response;
      } catch (error) {
        latest = {
          label,
          networkError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          requestMs: Math.round(performance.now() - started),
        };
        console.error(`[${label}] 网络诊断`, latest);
        throw error;
      }
    },
    latest: () => latest,
  };
}

const flockSnapshot = (day) => ({
  day,
  dayPhase: 'dusk',
  season: 'spring',
  flocks: [
    {
      species: '斑鸠', energy: 0.46, perchFlyRatio: 0.78,
      treeCondition: { health: 0.62, foliage: 0.7, pest: 0.18 },
      dailyStats: { homeReturns: 5, branchChanges: 1, activeRatio: 0.55 },
    },
    {
      species: '百灵', energy: 0.73, perchFlyRatio: 0.31,
      treeCondition: { health: 0.51, foliage: 0.58, pest: 0.27 },
      dailyStats: { homeReturns: 2, branchChanges: 6, activeRatio: 0.82 },
    },
  ],
});

const masterInput = {
  menu: {
    progressions: [['clearing', 'breeze', 'rain', 'sunbreak'], ['heat', 'cloud', 'shower', 'calm']],
    seasonPalettes: { spring: ['clear'], summer: ['humid', 'storm'] },
    seasonLengthRange: [2, 8],
    cooldownDays: 2,
  },
  state: {
    currentSeason: 'spring', currentProgression: 0, currentStep: 1,
    daysInSeason: 4, daysSinceChange: 3,
  },
  observations: { treeScores: [0.68, 0.55, 0.71, 0.63], patternSimilarity: 0.74 },
};

function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function reportFailure(label, diagnostic, value) {
  if (value != null) return;
  const info = diagnostic.latest();
  if (!info) console.error(`[${label}] 失败：请求未产生可观测响应（可能被调度器拦截或提前异常）`);
  else if (info.networkError) console.error(`[${label}] 失败：${info.networkError}`);
  else if (!info.httpOk) console.error(`[${label}] 失败：HTTP ${info.httpStatus}；响应片段：${info.snippet}`);
  else if (Number(info.baseStatus) !== 0) console.error(`[${label}] 失败：base_resp.status_code=${info.baseStatus}；响应片段：${info.snippet}`);
  else console.error(`[${label}] 失败：响应通过 HTTP/业务校验但解析或菜单校验未通过；模型原文：${String(info.content ?? info.snippet).slice(0, 360)}`);
}

async function requestMasterWithTimeout(client, input, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await client.requestDecision(input, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runOnce(key, iteration) {
  const flockDiagnostic = diagnosticFetch(`flock-${iteration}`);
  const masterDiagnostic = diagnosticFetch(`master-${iteration}`);
  const flockClient = new MinimaxClient({ apiKey: key, fetchImpl: flockDiagnostic.fetchImpl });
  // 流水线预算是一整天（12–90s），批量决策响应常超 3s；冒烟用 20s 上限实测真实延迟。
  const scheduler = new DayPlanScheduler({ client: flockClient, timeoutMs: 20000 });
  const masterClient = new MasterLlmClient({ apiKey: key, fetchImpl: masterDiagnostic.fetchImpl });

  const flockStarted = performance.now();
  const flockPromise = scheduler.requestDayPlan(flockSnapshot(iteration));
  const masterStarted = performance.now();
  const masterPromise = requestMasterWithTimeout(masterClient, masterInput);
  const [flock, master] = await Promise.all([flockPromise, masterPromise]);
  const flockMs = Math.round(performance.now() - flockStarted);
  const masterMs = Math.round(performance.now() - masterStarted);

  console.log(`[flock-${iteration}] 耗时 ${flockMs} ms；解析决策`, flock);
  console.log(`[flock-${iteration}] 校验结果：${flock ? 'PASS' : 'FAIL'}`);
  reportFailure(`flock-${iteration}`, flockDiagnostic, flock);
  console.log(`[master-${iteration}] 耗时 ${masterMs} ms；解析决策`, master);
  console.log(`[master-${iteration}] 校验结果：${master ? 'PASS' : 'FAIL'}`);
  reportFailure(`master-${iteration}`, masterDiagnostic, master);
  return { flock: { ok: flock != null, ms: flockMs }, master: { ok: master != null, ms: masterMs } };
}

async function verifyBadKeyFallback() {
  const flockDiagnostic = diagnosticFetch('bad-key-flock');
  const masterDiagnostic = diagnosticFetch('bad-key-master');
  const flockClient = new MinimaxClient({
    apiKey: `intentionally-invalid-${Date.now()}`,
    fetchImpl: flockDiagnostic.fetchImpl,
  });
  const masterClient = new MasterLlmClient({
    apiKey: `intentionally-invalid-${Date.now()}`,
    fetchImpl: masterDiagnostic.fetchImpl,
  });
  const [flock, master] = await Promise.all([
    flockClient.requestDayPlan(flockSnapshot(99)),
    requestMasterWithTimeout(masterClient, masterInput),
  ]);
  reportFailure('bad-key-flock', flockDiagnostic, flock);
  reportFailure('bad-key-master', masterDiagnostic, master);
  const passed = flock === null && master === null;
  console.log(`[bad-key] 两条链优雅回落校验：${passed ? 'PASS（均返回 null）' : 'FAIL（预期均为 null）'}`);
  return passed;
}

async function main(key) {
  const runs = [];
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    console.log(`\n=== 真实 API 第 ${iteration}/3 轮 ===`);
    runs.push(await runOnce(key, iteration));
  }
  for (const channel of ['flock', 'master']) {
    const entries = runs.map((run) => run[channel]);
    const successes = entries.filter((entry) => entry.ok).length;
    console.log(`\n[${channel}] 成功率 ${successes}/${entries.length} (${Math.round(successes / entries.length * 100)}%)；p95 ${p95(entries.map((entry) => entry.ms))} ms`);
  }
  console.log('\n=== 坏 key 回落 ===');
  const fallbackOk = await verifyBadKeyFallback();
  const allLiveOk = runs.every((run) => run.flock.ok && run.master.ok);
  if (!allLiveOk || !fallbackOk) process.exitCode = 1;
}

// 入口放文件尾，避免 top-level await 在 const 声明前触发 TDZ。
if (apiKey) await main(apiKey);
