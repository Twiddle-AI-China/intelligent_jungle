import { providerFailure, providerOk } from './contracts.js';
import {
  buildMasterRequest,
  MASTER_MODEL_DEFAULT,
  parseMasterResponse,
} from './master-prompt.js';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const MASTER_CAPABILITY_PROBE = 'flock-master-json-v1';

function endpoint(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
}

function httpFailure(status) {
  return providerFailure({
    status: 'http_error', code: `HTTP_${status}`,
    retryable: status === 408 || status === 429 || status >= 500,
    httpStatus: status,
  });
}

function networkFailure(error) {
  const rawCode = error?.name === 'AbortError' ? 'ABORTED' : error?.code;
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode)
    ? rawCode : 'NETWORK_ERROR';
  return providerFailure({ status: 'network_error', code, retryable: true });
}

function completionContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : null;
}

export function createDeepSeekMasterProvider({
  fetchImpl = globalThis.fetch,
  baseUrl = DEEPSEEK_BASE_URL,
  model = MASTER_MODEL_DEFAULT,
  apiKey,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('DEEPSEEK_FETCH_REQUIRED');
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw new Error('DEEPSEEK_API_KEY_REQUIRED');
  const selectedModel = typeof model === 'string' && model.trim() ? model.trim() : MASTER_MODEL_DEFAULT;
  const url = endpoint(baseUrl);

  async function invoke(body, { signal } = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ ...body, model: selectedModel }),
        signal,
      });
    } catch (error) {
      return { failure: networkFailure(error), content: null, httpStatus: null };
    }
    const status = Number(response?.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      return {
        failure: providerFailure({
          status: 'network_error', code: 'INVALID_HTTP_RESPONSE', retryable: true,
        }),
        content: null,
        httpStatus: null,
      };
    }
    if (!response.ok) return { failure: httpFailure(status), content: null, httpStatus: status };
    let payload;
    try { payload = await response.json(); } catch {
      return { failure: null, content: null, httpStatus: status };
    }
    return { failure: null, content: completionContent(payload), httpStatus: status };
  }

  async function request(masterInput, options = {}) {
    let body;
    try { body = buildMasterRequest(masterInput); } catch {
      return providerFailure({ status: 'invalid_output', code: 'INVALID_INPUT', retryable: false });
    }
    const result = await invoke(body, options);
    if (result.failure) return result.failure;
    const value = parseMasterResponse(result.content, masterInput);
    return value === null
      ? providerFailure({
        status: 'invalid_output', code: 'INVALID_OUTPUT', retryable: false,
        httpStatus: result.httpStatus,
      })
      : providerOk(value, result.httpStatus);
  }

  async function probeCapabilities(options = {}) {
    const schema = {
      type: 'object',
      properties: { probe: { type: 'string', enum: [MASTER_CAPABILITY_PROBE] } },
      required: ['probe'],
      additionalProperties: false,
    };
    const result = await invoke({
      model: selectedModel,
      temperature: 0,
      max_tokens: 32,
      messages: [
        {
          role: 'system',
          content: `Return only JSON matching this canonical schema:${JSON.stringify(schema)}`,
        },
        { role: 'user', content: JSON.stringify({ probe: MASTER_CAPABILITY_PROBE }) },
      ],
      response_format: { type: 'json_object' },
    }, options);
    if (result.failure) return result.failure;
    let parsed;
    try { parsed = JSON.parse(result.content); } catch { parsed = null; }
    const valid = parsed !== null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && Object.getPrototypeOf(parsed) === Object.prototype
      && Object.keys(parsed).length === 1
      && parsed.probe === MASTER_CAPABILITY_PROBE;
    return valid
      ? providerOk({ probe: MASTER_CAPABILITY_PROBE }, result.httpStatus)
      : providerFailure({
        status: 'invalid_output', code: 'INVALID_OUTPUT', retryable: false,
        httpStatus: result.httpStatus,
      });
  }

  return Object.freeze({ probeCapabilities, request });
}
