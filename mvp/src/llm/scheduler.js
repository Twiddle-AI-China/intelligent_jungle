// 黄昏日评估的 LLM 调度器：单飞、日长派生超时、指数退避、连续失败断路器。
// 任意失败都返回 null，调用方必须立即回落到纯规则 evaluateDay（G7）。

const TIMEOUT = Symbol('timeout');
export const MIN_DAY_PLAN_TIMEOUT_MS = 12000;

function snapshotDay(snapshot) {
  const day = Number(snapshot?.day);
  return Number.isFinite(day) ? Math.max(0, Math.floor(day)) : 0;
}

export class DayPlanScheduler {
  constructor({
    client,
    timeoutMs = 3000,
    minTimeoutMs = MIN_DAY_PLAN_TIMEOUT_MS,
    baseBackoffDays = 1,
    circuitFailureThreshold = 3,
    circuitCooldownDays = 5,
  } = {}) {
    const request = client?.requestDayPlan ?? client?.requestWorldPlan;
    if (typeof request !== 'function') {
      throw new Error('DayPlanScheduler: client.requestDayPlan is required');
    }
    this.client = client;
    this.request = request;
    // bird_agent 失败后还要为 MiniMax 保留完整的串行兜底窗口。
    // setter 也执行下限，因为 BPM 变化时集成层会直接更新 timeoutMs。
    this.minTimeoutMs = Math.max(1, Number(minTimeoutMs) || MIN_DAY_PLAN_TIMEOUT_MS);
    this.timeoutMs = timeoutMs;
    this.baseBackoffDays = Math.max(1, Math.floor(Number(baseBackoffDays) || 1));
    this.circuitFailureThreshold = Math.max(1, Math.floor(Number(circuitFailureThreshold) || 3));
    this.circuitCooldownDays = Math.max(1, Math.floor(Number(circuitCooldownDays) || 5));
    this.consecutiveFailures = 0;
    this.nextAllowedDay = 0;
    this.circuitOpenUntilDay = 0;
    this.inFlight = null;
  }

  set timeoutMs(value) {
    this._timeoutMs = Math.max(this.minTimeoutMs, Number(value) || 3000);
  }

  get timeoutMs() {
    return this._timeoutMs;
  }

  // 非 async，确保重入调用拿到完全相同的 Promise。
  requestDayPlan(snapshot) {
    if (this.inFlight) return this.inFlight;
    const day = snapshotDay(snapshot);
    if (day < this.nextAllowedDay || day < this.circuitOpenUntilDay) return Promise.resolve(null);

    let task;
    task = this.#run(snapshot, day).finally(() => {
      if (this.inFlight === task) this.inFlight = null;
    });
    this.inFlight = task;
    return task;
  }

  async #run(snapshot, day) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMEOUT);
      }, this.timeoutMs);
      timer.unref?.();
    });

    let plan = null;
    try {
      const request = Promise.resolve().then(() => this.request.call(this.client, snapshot, {
        signal: controller.signal,
      }));
      const result = await Promise.race([request, timeout]);
      if (result !== TIMEOUT && result != null) plan = result;
    } catch {
      plan = null;
    } finally {
      clearTimeout(timer);
    }

    if (plan == null) {
      this.#recordFailure(day);
      return null;
    }
    this.#recordSuccess(day);
    return plan;
  }

  #recordFailure(day) {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.circuitFailureThreshold) {
      this.circuitOpenUntilDay = day + this.circuitCooldownDays;
      this.nextAllowedDay = this.circuitOpenUntilDay;
      return;
    }
    const delay = this.baseBackoffDays * (2 ** (this.consecutiveFailures - 1));
    this.nextAllowedDay = day + delay;
  }

  #recordSuccess(day) {
    this.consecutiveFailures = 0;
    this.nextAllowedDay = day;
    this.circuitOpenUntilDay = 0;
  }

  getState() {
    return Object.freeze({
      consecutiveFailures: this.consecutiveFailures,
      nextAllowedDay: this.nextAllowedDay,
      circuitOpenUntilDay: this.circuitOpenUntilDay,
      inFlight: this.inFlight !== null,
    });
  }
}

export function createDayPlanScheduler(options) {
  return new DayPlanScheduler(options);
}
