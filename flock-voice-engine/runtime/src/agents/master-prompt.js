import {
  canonMasterMenu,
  normalizeMasterDecision,
  tensionRange,
} from '../domain/master/policy.js';

export const MASTER_MODEL_DEFAULT = 'deepseek-v4-flash';
export const MASTER_MAX_TOKENS = 4096;

const MASTER_KEYS = Object.freeze([
  'reason', 'colorId', 'tension', 'duskColorShift', 'tempoIntent',
  'nextSeason', 'seasonLength', 'progressionId',
]);
const REASON_PATTERN = '^[\\u4e00-\\u9fa50-9\\uff0c\\u3002\\u3001\\uff1b\\uff1a]{4,30}$';
const REASON_RE = /^[\u4e00-\u9fa50-9，。、；：]{4,30}$/u;

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

function cleanString(value, max = 120) {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, max) : '';
}

function safeData(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (finite(value)) return value;
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => safeData(item, depth + 1));
  if (!plain(value)) return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 32)) {
    if (/note|root|midi|chord/i.test(key)) continue;
    output[key] = safeData(item, depth + 1);
  }
  return output;
}

function normalizeInput(input = {}) {
  return {
    menu: canonMasterMenu(input?.menu),
    state: safeData(plain(input?.state) ? input.state : {}),
    observations: safeData(plain(input?.observations) ? input.observations : {}),
    ...(plain(input?.flags) ? { flags: safeData(input.flags) } : {}),
  };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string' && value.length > 0))];
}

export function buildMasterSchema(masterInput = {}) {
  const normalized = normalizeInput(masterInput);
  const season = normalized.state?.season;
  const colors = uniqueStrings(normalized.menu.colorsBySeason?.[season]);
  const seasons = uniqueStrings(normalized.menu.seasons);
  const [minimum, maximum] = tensionRange(normalized.menu);
  return {
    type: 'object',
    properties: {
      reason: { type: 'string', pattern: REASON_PATTERN },
      colorId: colors.length ? { type: 'string', enum: colors } : { type: 'string' },
      tension: { type: 'number', minimum, maximum },
      duskColorShift: { type: 'boolean' },
      tempoIntent: { type: 'string', enum: ['hold', 'slower', 'faster'] },
      nextSeason: {
        anyOf: [
          seasons.length ? { type: 'string', enum: seasons } : { type: 'string' },
          { type: 'null' },
        ],
      },
      seasonLength: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      progressionId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: [...MASTER_KEYS],
    additionalProperties: false,
  };
}

export function buildMasterRequest(masterInput) {
  const normalized = normalizeInput(masterInput);
  const schema = buildMasterSchema(masterInput);
  const system = `你是生态世界的季节决策器。只能从当前菜单选择色彩、张力、节奏意图和季节参数。非季末日必须将 nextSeason、seasonLength、progressionId 设为 null。只输出一个符合以下 canonical schema 的 JSON 对象，不要回显输入：${JSON.stringify(schema)}`;
  return {
    model: MASTER_MODEL_DEFAULT,
    temperature: 0,
    max_tokens: MASTER_MAX_TOKENS,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(normalized) },
    ],
    response_format: { type: 'json_object' },
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export function parseMasterResponse(raw, masterInput = {}) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!exactKeys(parsed, MASTER_KEYS)
    || typeof parsed.reason !== 'string' || !REASON_RE.test(parsed.reason)
    || typeof parsed.colorId !== 'string' || !parsed.colorId
    || !finite(parsed.tension)
    || typeof parsed.duskColorShift !== 'boolean'
    || !['hold', 'slower', 'faster'].includes(parsed.tempoIntent)
    || !(parsed.nextSeason === null || typeof parsed.nextSeason === 'string')
    || !(parsed.seasonLength === null || Number.isInteger(parsed.seasonLength))
    || !(parsed.progressionId === null || typeof parsed.progressionId === 'string')) return null;

  const decision = normalizeMasterDecision(parsed, masterInput?.menu, masterInput?.state);
  if (!decision) return null;
  return deepFreeze(structuredClone(decision));
}
