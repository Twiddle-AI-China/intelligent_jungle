import { providerFailure, providerOk } from './contracts.js';
import { buildSpeciesRequest, parseSpeciesResponse } from './species-prompt.js';

export const SPECIES_BASE_URL = 'http://127.0.0.1:8081/v1';

function endpoint(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
}

function httpFailure(status) {
  return providerFailure({
    status: 'http_error',
    code: `HTTP_${status}`,
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

export function createSpeciesProvider({ fetchImpl = globalThis.fetch, baseUrl = SPECIES_BASE_URL } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('SPECIES_FETCH_REQUIRED');
  const url = endpoint(baseUrl);

  async function request(flockInput, { signal } = {}) {
    let body;
    try { body = buildSpeciesRequest(flockInput); } catch {
      return providerFailure({
        status: 'invalid_output', code: 'INVALID_INPUT', retryable: false,
      });
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      return networkFailure(error);
    }
    const status = Number(response?.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      return providerFailure({
        status: 'network_error', code: 'INVALID_HTTP_RESPONSE', retryable: true,
      });
    }
    if (!response.ok) return httpFailure(status);

    let payload;
    try { payload = await response.json(); } catch {
      return providerFailure({
        status: 'invalid_output', code: 'INVALID_OUTPUT', retryable: false, httpStatus: status,
      });
    }
    const value = parseSpeciesResponse(completionContent(payload), flockInput);
    return value === null
      ? providerFailure({
        status: 'invalid_output', code: 'INVALID_OUTPUT', retryable: false, httpStatus: status,
      })
      : providerOk(value, status);
  }

  return Object.freeze({ request });
}
