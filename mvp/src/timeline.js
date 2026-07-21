// Phase 2 决策时间线面板（只读历史列表）。
// 挂载：const panel = createTimelinePanel({ container }); panel.appendDecision(entry)。
// entry = { day, actor:'flock'|'master', flockId?, source:'rule'|'llm'|'external',
//           action, reason, score? }。
// 渲染只消费 formatDecisionRow 的输出，分组/裁剪是可单测的纯函数；
// 无 DOM（node 测试）时 createTimelinePanel 返回 null，不 throw。
// 颜色严格三 token：paper #F2EAD8 / ink #2E3E8F / accent #E75C26；夜间反转由外层负责。

export const TOKENS = Object.freeze({
  paper: '#F2EAD8',
  ink: '#2E3E8F',
  accent: '#E75C26',
});

export const SOURCE_BADGES = Object.freeze({
  rule: '规则',
  llm: 'LLM',
  external: '外部',
});

const REASON_LIMIT = 60;

function truncateReason(reason, limit = REASON_LIMIT) {
  const text = reason == null ? '' : String(reason);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function actorLabel(entry) {
  if (entry?.actor === 'master') return 'master';
  if (entry?.actor === 'flock') {
    return entry.flockId != null ? `flock·${entry.flockId}` : 'flock';
  }
  return entry?.actor != null ? String(entry.actor) : '—';
}

/**
 * 行渲染数据：badge 徽标文字、title「actor + action」、
 * reasonShort（超 60 字截断加省略号）与 reasonFull（点击展开用）。
 */
export function formatDecisionRow(entry = {}) {
  const badge = SOURCE_BADGES[entry.source] ?? (entry.source != null ? String(entry.source) : SOURCE_BADGES.rule);
  const action = entry.action != null ? String(entry.action) : '—';
  const reasonFull = entry.reason == null ? '' : String(entry.reason);
  return {
    badge,
    title: `${actorLabel(entry)} ${action}`,
    reasonShort: truncateReason(reasonFull),
    reasonFull,
  };
}

/**
 * 把一条决策并入按天分组的历史（days 的元素为 { day, entries: [...] }，
 * 天数按到达顺序非递减）。同一天进同一个组；组数超过 maxDays 时裁掉最老的天。
 * 返回新的 days 数组，不改入参。
 */
export function appendToDays(days, entry, maxDays = 14) {
  const list = Array.isArray(days) ? days : [];
  const day = Number.isFinite(Number(entry?.day)) ? Number(entry.day) : 0;
  const last = list[list.length - 1];
  const next = last && last.day === day
    ? [...list.slice(0, -1), { day, entries: [...last.entries, entry] }]
    : [...list, { day, entries: [entry] }];
  const cap = Math.max(1, Number.isFinite(Number(maxDays)) ? Math.floor(Number(maxDays)) : 14);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function isNearScrollBottom({ scrollHeight = 0, scrollTop = 0, clientHeight = 0 } = {}, threshold = 24) {
  return Number(scrollHeight) - Number(scrollTop) - Number(clientHeight) <= Math.max(0, Number(threshold) || 0);
}

const STYLE_ID = 'lcs-timeline-style';

function injectStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.lcs-timeline { background: transparent; color: var(--ink, ${TOKENS.ink});
  font: 11px/1.5 ui-monospace, Menlo, monospace; padding: 0; overflow-y: visible; height: auto;
  box-sizing: border-box; }
.lcs-timeline-day { margin-bottom: 8px; }
.lcs-timeline-day:last-child { margin-bottom: 0; }
.lcs-timeline-dayhead { font-weight: 700; font-size: 10px; letter-spacing: 0.06em;
  color: var(--accent, ${TOKENS.accent});
  border-bottom: 1px solid var(--ink, ${TOKENS.ink});
  padding-bottom: 2px; margin-bottom: 4px; }
.lcs-timeline-row { display: flex; gap: 6px; align-items: baseline;
  padding: 2px 0; flex-wrap: wrap; }
.lcs-timeline-badge { flex: none; border: 1px solid var(--ink, ${TOKENS.ink});
  padding: 0 4px; font-size: 10px; letter-spacing: 0.04em; }
.lcs-timeline-badge-llm { background: var(--accent, ${TOKENS.accent});
  color: var(--paper, ${TOKENS.paper});
  border-color: var(--accent, ${TOKENS.accent}); }
.lcs-timeline-title { flex: none; white-space: nowrap; font-weight: 600; }
.lcs-timeline-reason { opacity: 0.65; cursor: pointer;
  overflow-wrap: anywhere; max-width: 100%;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lcs-timeline-empty { opacity: 0.55; font-size: 10px; }
.lcs-timeline-new { position: sticky; bottom: 0; margin: 5px 0 0 auto; display: block;
  border: 1px solid var(--accent, ${TOKENS.accent}); color: var(--accent, ${TOKENS.accent});
  background: var(--paper, ${TOKENS.paper}); font: inherit; font-weight: 700; cursor: pointer; }
.lcs-timeline-new[hidden] { display: none; }
`;
  doc.head.appendChild(style);
}

/**
 * 创建决策时间线面板。无 document 或无 container 时返回 null（不 throw），
 * 方便 node 环境与未挂载页面安全引用本模块。
 */
export function createTimelinePanel({ container, maxDays = 14 } = {}) {
  if (typeof document === 'undefined') return null;
  if (!container || typeof container.appendChild !== 'function') return null;

  injectStyle(document);

  const root = document.createElement('div');
  root.className = 'lcs-timeline';
  container.appendChild(root);
  const newButton = document.createElement('button');
  newButton.type = 'button';
  newButton.className = 'lcs-timeline-new';
  newButton.textContent = '↓ 新决策';
  newButton.hidden = true;
  container.appendChild(newButton);

  let days = [];

  function render() {
    root.textContent = '';
    if (days.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'lcs-timeline-empty';
      empty.textContent = '（暂无决策记录）';
      root.appendChild(empty);
      return;
    }
    // 旧→新：最新决策稳定落在底部，便于自然阅读与自动跟随。
    for (const group of days) {
      const dayEl = document.createElement('div');
      dayEl.className = 'lcs-timeline-day';

      const head = document.createElement('div');
      head.className = 'lcs-timeline-dayhead';
      head.textContent = `第 ${group.day} 天`;
      dayEl.appendChild(head);

      for (const entry of group.entries) {
        const row = formatDecisionRow(entry);
        const rowEl = document.createElement('div');
        rowEl.className = 'lcs-timeline-row';

        const badge = document.createElement('span');
        badge.className = entry?.source === 'llm'
          ? 'lcs-timeline-badge lcs-timeline-badge-llm'
          : 'lcs-timeline-badge';
        badge.textContent = row.badge;
        rowEl.appendChild(badge);

        const title = document.createElement('span');
        title.className = 'lcs-timeline-title';
        title.textContent = row.title;
        rowEl.appendChild(title);

        const reason = document.createElement('span');
        reason.className = 'lcs-timeline-reason';
        reason.textContent = row.reasonShort;
        if (row.reasonFull !== row.reasonShort) {
          let expanded = false;
          reason.addEventListener('click', () => {
            const follow = isNearScrollBottom(container);
            expanded = !expanded;
            reason.textContent = expanded ? row.reasonFull : row.reasonShort;
            if (follow) container.scrollTop = container.scrollHeight;
          });
        }
        rowEl.appendChild(reason);

        dayEl.appendChild(rowEl);
      }
      root.appendChild(dayEl);
    }
  }

  function appendDecision(entry) {
    const follow = days.length === 0 || isNearScrollBottom(container);
    days = appendToDays(days, entry, maxDays);
    render();
    if (follow) {
      container.scrollTop = container.scrollHeight;
      newButton.hidden = true;
    } else {
      newButton.hidden = false;
    }
  }

  newButton.addEventListener('click', () => {
    container.scrollTop = container.scrollHeight;
    newButton.hidden = true;
  });
  container.addEventListener('scroll', () => {
    if (isNearScrollBottom(container)) newButton.hidden = true;
  }, { passive: true });

  render();

  return Object.freeze({
    appendDecision,
    /** 只读快照，供调试/外层接线核对。 */
    snapshot: () => days.map((g) => ({ day: g.day, entries: [...g.entries] })),
  });
}
