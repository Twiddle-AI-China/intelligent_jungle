// LLM「个性层」：MiniMax 种群 agent（设计 v3.3 §6.2，G7 韧性）。
// 在 deterministic flockPolicy（agent.js）之上做倾向与时机调整；
// LLM 掉线 / 超时 / 输出异常时返回 null，调用方无缝回落代码兜底，循环永不停。
// prompt 只用生态词汇（栖/飞/energy/树健康/虫害/邻树活动）——agent 的世界里没有「音」这个字。
//
// 已探测的 API 事实（2026-07-18）：
// - base URL: https://api.minimaxi.com/v1/chat/completions（OpenAI 兼容，无需 groupId）
// - 模型: abab6.5s-chat；不支持 response_format: json_object（400, code 2013），
//   故用 prompt 强制 JSON + 容错解析（从 content 里抠第一个 {...}）。
// - 响应含 base_resp.status_code（0 为成功），需一并校验。
// - 典型延迟 ~0.5s（小回复），超时设 2s 足够。

const DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1';
const DEFAULT_MODEL = 'abab6.5s-chat';
const DEFAULT_TIMEOUT_MS = 2000;

// 5 条生存规则——与 flockPolicy 的确定性基底一一对应，纯生态词汇。
// 要求只输出一行 JSON，消 CoT；dwellUrge = 归栖倾向（0 全飞，1 全栖）。
const SYSTEM_PROMPT = `你是一小群鸟，住在一棵树上，只在生态世界里行动。根据状态做归栖/起飞的倾向判断，严格遵守 5 条生存规则：
1) 作息：dayPhase 为 night/dusk 倾向归栖，白天倾向起飞。
2) 体力：energy 低要归栖休息，energy 高才多飞。
3) 本职：pest 高说明树需要你停留照料，foliage 差则少压枝、减轻负担。
4) 应答：neighborActivity 高时会被带动多飞一阵；perchFlyRatio 已很高时倾向归栖。
5) 兜底：上面都不突出时保持温和的中性倾向。
只输出一行 JSON，不要任何解释、推理或多余文字：{"dwellUrge": 0到1之间的小数, "reason": "不超过20字的生态理由"}`;

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// 从模型输出里容错地抠出第一个 JSON 对象（模型可能带前后杂文本）。
function extractDecision(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(/\{[^{}]*\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const dwellUrge = Number(parsed.dwellUrge);
  if (!Number.isFinite(dwellUrge)) return null;
  return {
    dwellUrge: clamp(dwellUrge),
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 60) : '',
  };
}

export class MinimaxFlockAgent {
  // apiKey 必须由调用方注入（不从环境/文件读，绝不硬编码）。
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error('MinimaxFlockAgent: apiKey is required');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  // stateJson: 聚合生态状态对象（dayPhase/energy/perchFlyRatio/foliage/pest/neighborActivity 等）。
  // 返回 {dwellUrge: 0..1, reason: string}；任何失败（断网/超时/非 200/输出异常）返回 null。
  async decide(stateJson) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.3,
          max_tokens: 80,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(stateJson ?? {}) },
          ],
        }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      // MiniMax 在 200 时也可能用 base_resp 报错，统一校验。
      if (data?.base_resp && data.base_resp.status_code !== 0) return null;
      const content = data?.choices?.[0]?.message?.content;
      return extractDecision(content);
    } catch {
      // AbortError（超时）、网络错误、JSON 解析错误都走这里 → 代码兜底接管。
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
