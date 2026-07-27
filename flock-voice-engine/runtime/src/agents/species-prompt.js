import { applySequenceCellMutations } from '../domain/sequence.js';

export const SPECIES_MODEL = 'bird_agent';
export const SPECIES_MAX_TOKENS = 512;

const REASON_PATTERN = '^[\\u4e00-\\u9fa50-9\\uff0c\\u3002\\u3001\\uff1b\\uff1a]{4,30}$';
const REASON_RE = /^[\u4e00-\u9fa50-9，。、；：]{4,30}$/u;
const DEFAULT_MENU = Object.freeze({
  dwellBeats: Object.freeze([0.25, 16]),
  activeBars: Object.freeze([0, 4]),
  holdLoops: Object.freeze([2, 8]),
  maxMutations: 8,
});

const addressSchema = Object.freeze({
  type: 'object',
  properties: {
    pitchBranchId: { type: 'integer' },
    stepIndex: { type: 'integer' },
  },
  required: ['pitchBranchId', 'stepIndex'],
  additionalProperties: false,
});

export const SPECIES_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    reason: { type: 'string', pattern: REASON_PATTERN },
    flocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          reason: { type: 'string', pattern: REASON_PATTERN },
          dwellBeats: { type: 'number' },
          activeBars: { type: 'number' },
          holdLoops: { type: 'integer' },
          mutations: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: { type: 'integer' }, to: { type: 'integer' } },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
          cellMutations: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: addressSchema, to: addressSchema },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
        },
        required: ['reason', 'dwellBeats', 'activeBars', 'holdLoops', 'mutations', 'cellMutations'],
        additionalProperties: false,
      },
    },
    master: {
      type: 'object',
      properties: { ops: { type: 'array', items: { type: 'object' }, maxItems: 0 } },
      required: ['ops'],
      additionalProperties: false,
    },
  },
  required: ['flocks', 'master'],
  additionalProperties: false,
});

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
}

function normalizeRange(value, fallback, { integer = false, min = 0, max = Infinity } = {}) {
  const source = Array.isArray(value) ? value : [];
  let lo = finite(source[0]) ? source[0] : fallback[0];
  let hi = finite(source[1]) ? source[1] : fallback[1];
  lo = Math.min(max, Math.max(min, lo));
  hi = Math.min(max, Math.max(min, hi));
  if (integer) {
    lo = Math.ceil(lo);
    hi = Math.floor(hi);
  }
  return lo <= hi ? [lo, hi] : [hi, lo];
}

function normalizeMenu(value) {
  const menu = plain(value) ? value : {};
  return {
    dwellBeats: normalizeRange(menu.dwellBeats, DEFAULT_MENU.dwellBeats, { min: 0.0625 }),
    activeBars: normalizeRange(menu.activeBars, DEFAULT_MENU.activeBars, { integer: true, min: 0 }),
    holdLoops: normalizeRange(menu.holdLoops, DEFAULT_MENU.holdLoops, { integer: true, min: 2, max: 8 }),
    maxMutations: Number.isInteger(menu.maxMutations)
      ? Math.min(8, Math.max(0, menu.maxMutations)) : DEFAULT_MENU.maxMutations,
  };
}

function cleanString(value, max = 80) {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '';
}

function safeData(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (finite(value)) return value;
  if (typeof value === 'string') return cleanString(value, 120);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => safeData(item, depth + 1));
  if (!plain(value)) return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (/note|root|midi|chord/i.test(key)) continue;
    const safe = safeData(item, depth + 1);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

function normalizeInput(input = {}) {
  const flocks = Array.isArray(input?.flocks) ? input.flocks : [];
  return {
    day: Number.isSafeInteger(input?.day) && input.day >= 0 ? input.day : 0,
    flocks: flocks.map((flock) => {
      const menu = normalizeMenu(flock?.menu);
      const branches = (values) => [...new Set((Array.isArray(values) ? values : [])
        .filter((value) => Number.isInteger(value) && value >= 0))];
      return {
        species: cleanString(flock?.species, 40),
        energy: finite(flock?.energy) ? flock.energy : 0,
        tension: finite(flock?.tension) ? flock.tension : 0,
        homeBranches: branches(flock?.homeBranches),
        skeletonBranchIds: branches(flock?.skeletonBranchIds),
        colorBranchIds: branches(flock?.colorBranchIds),
        menu,
        ...(plain(flock?.flags) ? { flags: safeData(flock.flags) } : {}),
        ...(plain(flock?.ecology) ? { ecology: safeData(flock.ecology) } : {}),
        ...(plain(flock?.sequencePattern) ? { sequencePattern: safeData(flock.sequencePattern) } : {}),
      };
    }),
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const SYSTEM_PROMPT = `你是生态群落的日界规划器。只根据输入中的生态指标、枝位集合和菜单为每群选择温和的下一日行为。
数值必须在对应 menu 范围内；变异 from 必须来自 homeBranches，from 与 to 不同，数量不超过 maxMutations。格点变异只能把已占格移到合法空格；无 sequencePattern 时必须返回空数组。
输出群数与输入顺序一致，master.ops 必须为空数组。只输出符合 schema 的 JSON，不要回显输入。`;

export function buildSpeciesRequest(flockInput) {
  const normalized = normalizeInput(flockInput);
  return {
    model: SPECIES_MODEL,
    temperature: 0,
    max_tokens: SPECIES_MAX_TOKENS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(normalized) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'flock_day_plan', strict: true, schema: SPECIES_PLAN_SCHEMA },
    },
  };
}

function validReason(value) {
  return typeof value === 'string' && REASON_RE.test(value);
}

function inRange(value, range, { integer = false } = {}) {
  return finite(value) && (!integer || Number.isInteger(value))
    && value >= range[0] && value <= range[1];
}

function normalizeFlockPlan(plan, source) {
  if (!exactKeys(plan, ['reason', 'dwellBeats', 'activeBars', 'holdLoops', 'mutations', 'cellMutations'])
    || !validReason(plan.reason)) return null;
  const menu = normalizeMenu(source?.menu);
  if (!inRange(plan.dwellBeats, menu.dwellBeats)
    || !inRange(plan.activeBars, menu.activeBars)
    || !inRange(plan.holdLoops, menu.holdLoops, { integer: true })
    || !Array.isArray(plan.mutations) || plan.mutations.length > menu.maxMutations
    || !Array.isArray(plan.cellMutations) || plan.cellMutations.length > menu.maxMutations) return null;

  const home = new Set(Array.isArray(source?.homeBranches) ? source.homeBranches : []);
  const mutations = [];
  for (const mutation of plan.mutations) {
    if (!exactKeys(mutation, ['from', 'to'])
      || !Number.isInteger(mutation.from) || !Number.isInteger(mutation.to)
      || mutation.from < 0 || mutation.to < 0
      || mutation.from === mutation.to || !home.has(mutation.from)) return null;
    mutations.push({ from: mutation.from, to: mutation.to });
  }

  let cellMutations = [];
  if (source?.sequencePattern === undefined) {
    if (plan.cellMutations.length) return null;
  } else {
    const applied = applySequenceCellMutations(source.sequencePattern, plan.cellMutations, {
      maxMutations: menu.maxMutations,
    });
    if (!applied) return null;
    cellMutations = applied.mutations;
  }
  return {
    dwellBeats: plan.dwellBeats,
    activeBars: plan.activeBars,
    holdLoops: plan.holdLoops,
    mutations,
    cellMutations,
  };
}

export function parseSpeciesResponse(raw, flockInput = {}) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const rootKeys = parsed && Object.hasOwn(parsed, 'reason')
    ? ['reason', 'flocks', 'master'] : ['flocks', 'master'];
  if (!exactKeys(parsed, rootKeys)
    || (Object.hasOwn(parsed, 'reason') && !validReason(parsed.reason))
    || !Array.isArray(parsed.flocks)
    || !exactKeys(parsed.master, ['ops'])
    || !Array.isArray(parsed.master.ops) || parsed.master.ops.length !== 0) return null;
  const sources = Array.isArray(flockInput?.flocks) ? flockInput.flocks : [];
  if (parsed.flocks.length !== sources.length) return null;
  const flocks = parsed.flocks.map((plan, index) => normalizeFlockPlan(plan, sources[index]));
  if (flocks.some((plan) => plan === null)) return null;
  return deepFreeze({ flocks, master: { ops: [] } });
}
