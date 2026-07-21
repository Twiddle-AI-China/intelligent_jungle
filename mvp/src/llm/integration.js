// 日评估流水线适配层：请求在白天并联发起，结果只在后续黎明同步领取。

function callableFlock(flockScheduler) {
  if (typeof flockScheduler === 'function') return flockScheduler;
  if (typeof flockScheduler?.requestDayPlan === 'function') {
    return flockScheduler.requestDayPlan.bind(flockScheduler);
  }
  throw new Error('createAgentPipeline: flockScheduler.requestDayPlan is required');
}

function callableMaster(masterDecide) {
  if (typeof masterDecide === 'function') return masterDecide;
  if (typeof masterDecide?.requestDecision === 'function') {
    return masterDecide.requestDecision.bind(masterDecide);
  }
  throw new Error('createAgentPipeline: masterDecide is required');
}

function inputsFrom(snapshot = {}) {
  return {
    day: Number.isFinite(Number(snapshot.day)) ? Math.floor(Number(snapshot.day)) : null,
    flock: snapshot.flockSnapshot ?? snapshot.flock ?? snapshot,
    master: snapshot.masterInput ?? snapshot.master ?? snapshot,
  };
}

// 调度器也可由外部服务注入，因此在流水线边界再收敛一次 3.5.3 契约；
// 秒制旧字段不会被转译或透传，缺少新字段就视为该链失败。
// expectedFlockCount 给出时数量不符整包判 null：半套 LLM 计划是静默错误，
// 宁可整体走规则兜底。
export function mapFlockPlan(plan, expectedFlockCount) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.flocks)) return null;
  if (Number.isInteger(expectedFlockCount) && plan.flocks.length !== expectedFlockCount) return null;
  const flocks = [];
  for (const decision of plan.flocks) {
    if (!decision || typeof decision !== 'object' || !Array.isArray(decision.mutations)) return null;
    const dwellBeats = Number(decision.dwellBeats);
    const activeBars = Number(decision.activeBars);
    const holdLoops = Number(decision.holdLoops);
    if (!Number.isFinite(dwellBeats) || dwellBeats <= 0) return null;
    if (!Number.isFinite(activeBars) || activeBars < 0) return null;
    if (!Number.isInteger(holdLoops) || holdLoops < 2 || holdLoops > 8) return null;
    const mutations = [];
    for (const mutation of decision.mutations) {
      const from = Number(mutation?.from);
      const to = Number(mutation?.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from === to) continue;
      mutations.push({ from, to });
    }
    const hasCellMutations = Object.hasOwn(decision, 'cellMutations');
    const cellMutations = [];
    for (const mutation of decision.cellMutations ?? []) {
      const fromPitch = Number(mutation?.from?.pitchBranchId);
      const fromStep = Number(mutation?.from?.stepIndex);
      const toPitch = Number(mutation?.to?.pitchBranchId);
      const toStep = Number(mutation?.to?.stepIndex);
      if (![fromPitch, fromStep, toPitch, toStep].every(Number.isInteger)
        || [fromPitch, fromStep, toPitch, toStep].some((value) => value < 0)
        || (fromPitch === toPitch && fromStep === toStep)) continue;
      cellMutations.push({
        from: { pitchBranchId: fromPitch, stepIndex: fromStep },
        to: { pitchBranchId: toPitch, stepIndex: toStep },
      });
    }
    flocks.push({
      dwellBeats,
      activeBars,
      holdLoops,
      mutations,
      ...(hasCellMutations ? { cellMutations } : {}),
    });
  }
  return { flocks };
}

// masterDecide 可能返回组合器（resolveMasterDecisionWithSource）的
// {decision, source} 形状：来源标签穿透到 dawnPlan。{decision:null}
// 是失败结果而非空决策，不发布，黎明改走 masterFallback。
function unwrapMasterResult(value) {
  if (value == null) return null;
  if (typeof value === 'object' && 'decision' in value) {
    if (value.decision == null) return null;
    return {
      decision: value.decision,
      source: typeof value.source === 'string' && value.source ? value.source : 'llm',
      fallback: false,
    };
  }
  return { decision: value, source: 'llm', fallback: false };
}

export function createAgentPipeline({
  flockScheduler,
  masterDecide,
  masterFallback,
  now = () => Date.now(),
} = {}) {
  const requestFlock = callableFlock(flockScheduler);
  const requestMaster = callableMaster(masterDecide);
  if (typeof masterFallback !== 'function') {
    throw new Error('createAgentPipeline: masterFallback is required');
  }
  if (typeof now !== 'function') throw new Error('createAgentPipeline: now must be a function');

  let sequence = 0;
  let dawnCount = 0;
  let latestInput = null;
  const ready = { flock: null, master: null };

  function publish(channel, value, review) {
    if (value == null) return;
    const eligibleDawn = dawnCount >= review.intendedDawn ? dawnCount + 1 : review.intendedDawn;
    if (!ready[channel] || review.sequence >= ready[channel].sequence) {
      ready[channel] = {
        value,
        sequence: review.sequence,
        reviewedDay: review.day,
        eligibleDawn,
        completedAt: now(),
      };
    }
  }

  // 非 async：两条 Promise 在同一个调用栈内建立，保证真正并联。
  function dayReview(daySnapshot) {
    const input = inputsFrom(daySnapshot);
    latestInput = input;
    const review = {
      sequence: ++sequence,
      day: input.day,
      intendedDawn: dawnCount + 1,
      startedAt: now(),
    };

    const flockTask = Promise.resolve()
      .then(() => requestFlock(input.flock))
      .then((value) => {
        const expected = Number.isInteger(input.flock?.flocks?.length)
          ? input.flock.flocks.length
          : undefined;
        const mapped = mapFlockPlan(value, expected);
        publish('flock', mapped, review);
        return mapped;
      })
      .catch(() => null);
    const masterTask = Promise.resolve()
      .then(() => requestMaster(input.master))
      .then((value) => {
        const resolved = unwrapMasterResult(value);
        publish('master', resolved, review);
        return resolved?.decision ?? null;
      })
      .catch(() => null);

    return Promise.all([flockTask, masterTask]).then(([flock, master]) => ({
      reviewedDay: review.day,
      flock,
      master,
      completedAt: now(),
    }));
  }

  function take(channel) {
    const candidate = ready[channel];
    if (!candidate || candidate.eligibleDawn > dawnCount) return null;
    ready[channel] = null;
    return candidate;
  }

  function dawnPlan() {
    dawnCount += 1;
    const flockReady = take('flock');
    const masterReady = take('master');
    const reviewDays = [flockReady?.reviewedDay, masterReady?.reviewedDay, latestInput?.day]
      .filter(Number.isFinite);
    let fallbackDecision = null;
    if (!masterReady) {
      try {
        fallbackDecision = masterFallback(latestInput?.master);
      } catch {
        fallbackDecision = null;
      }
    }

    return {
      reviewedDay: reviewDays.length ? Math.max(...reviewDays) : null,
      plannedAt: now(),
      flock: flockReady
        ? { plan: flockReady.value, source: 'llm', fallback: false }
        : { plan: null, source: 'rule-fallback', fallback: true },
      master: masterReady
        ? masterReady.value
        : {
            decision: fallbackDecision,
            source: fallbackDecision == null ? null : 'policy',
            fallback: true,
          },
      fallback: {
        flock: !flockReady,
        master: !masterReady,
      },
    };
  }

  return Object.freeze({ dayReview, dawnPlan });
}
