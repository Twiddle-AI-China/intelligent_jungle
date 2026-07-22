import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('产品界面隐藏诊断与浏览器 API key，并在总控披露音乐时间', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  for (const forbidden of [
    '设置 / 诊断', 'MiniMax API key', 'id="api-key"', 'id="status"',
    'id="cal-day"', 'id="cal-progress"', 'id="hud-phase"', 'id="chord-name"',
    'debug-log-toggle', 'decision-log', 'local-config.js',
  ]) assert.equal(html.includes(forbidden), false, `产品 HTML 不应出现 ${forbidden}`);
  assert.match(html, /Intelligent Jungle/i);
  assert.match(html, />进入</);
  assert.match(html, /master-day-fact/);
  assert.match(html, /master-chord-fact/);
  assert.match(html, /master-color-fact/);
  const entryCopy = html.slice(html.indexOf('<div class="entry-copy">'), html.indexOf('</div>', html.indexOf('<div class="entry-copy">')));
  assert.equal(/<p>|<small>/.test(entryCopy), false, '入口只保留品牌与进入');
});

test('生产启动路径只读取无密钥的 StepFun runtime 地址', async () => {
  const main = await readFile(new URL('src/main.js', root), 'utf8');
  const runtime = await readFile(new URL('runtime-config.js', root), 'utf8');
  assert.match(main, /LCS_RUNTIME\?\.stepfunBase/);
  assert.match(runtime, /window\.LCS_RUNTIME/);
  assert.match(runtime, /stepfunBase/);
  assert.equal(/api[_-]?key|secret|token/i.test(runtime), false);
  for (const forbidden of [
    'createMinimaxClient', 'createMasterLlmClient', 'lcs_minimax_key',
    'LCS_KEYS', 'apiKeyInput',
  ]) assert.equal(main.includes(forbidden), false, `生产启动路径不应出现 ${forbidden}`);
});

test('进入页直接复用主场景 renderer 的树干枝群，并在入口模式隐藏鸟', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const renderer = await readFile(new URL('src/renderer.js', root), 'utf8');
  const main = await readFile(new URL('src/main.js', root), 'utf8');
  const overlay = html.slice(html.indexOf('<div id="overlay">'), html.indexOf('<div id="guide-overlay"'));
  assert.equal(/entry-tree|trunk-main|branch-pad|bird-/i.test(overlay), false,
    '入口不维护第二套 DOM 拼树或鸟素材');
  assert.match(renderer, /function setEntryMode/);
  assert.match(renderer, /entryMode \? \[\] : snapshot\.birds/);
  assert.match(main, /setEntryMode\?\.\(true\)/);
  assert.match(main, /setEntryMode\?\.\(false\)/);
});

test('总控使用统一事实菜单而非常驻原生时光下拉', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /master-tempo-segments/);
  assert.match(html, /master-beat-fact/);
  assert.match(html, /master-control-toggle/);
  assert.match(html, /<select id="bpm" hidden/);
});

test('音色林地常驻侧边、叶片表达并实时披露潜空间坐标', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const roamer = await readFile(new URL('src/ui/latent-roamer.js', root), 'utf8');
  assert.match(html, /roamer-panel\.is-left/);
  assert.match(html, /roamer-panel\.is-right/);
  assert.match(roamer, /ctx\.ellipse/);
  assert.match(roamer, /X \$\{x\.toFixed\(3\)\} · Y/);
  assert.doesNotMatch(roamer, /fillRect\(cx - size/);
});
