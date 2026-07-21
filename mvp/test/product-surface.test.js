import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('产品界面隐藏诊断、精确日时和浏览器 API key 配置', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  for (const forbidden of [
    '设置 / 诊断', 'MiniMax API key', 'id="api-key"', 'id="status"',
    'id="cal-day"', 'id="cal-progress"', 'id="hud-phase"', 'id="chord-name"',
    'debug-log-toggle', 'decision-log', 'local-config.js',
  ]) assert.equal(html.includes(forbidden), false, `产品 HTML 不应出现 ${forbidden}`);
  assert.match(html, /Intelligent Jungle/i);
  assert.match(html, />进入（启用音频）</);
});

test('生产启动路径只读取无密钥的 StepFun runtime 地址', async () => {
  const main = await readFile(new URL('src/main.js', root), 'utf8');
  assert.match(main, /LCS_RUNTIME\?\.stepfunBase/);
  for (const forbidden of [
    'createMinimaxClient', 'createMasterLlmClient', 'lcs_minimax_key',
    'LCS_KEYS', 'apiKeyInput',
  ]) assert.equal(main.includes(forbidden), false, `生产启动路径不应出现 ${forbidden}`);
});

test('进入页复用 botanical 与树干枝群，且没有鸟素材', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const overlay = html.slice(html.indexOf('<div id="overlay">'), html.indexOf('<div id="guide-overlay"'));
  assert.match(overlay, /botanical|entry-tree|trunk-main/);
  assert.match(overlay, /branch-pad-right-v2/);
  assert.equal(/bird-/i.test(overlay), false);
});
