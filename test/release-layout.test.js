import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = resolve(ROOT, 'config/model-assets.json');
const NOTICE_PATH = resolve(ROOT, 'THIRD_PARTY_NOTICES.md');

const EXPECTED_ASSETS = new Map([
  ['bass_latest.pt', [98_348_246, '3b507d98d898022ac27175048094fb48b31f70aad77b9c452b69b3ed32a39165']],
  ['lead_latest.pt', [98_338_102, '90d2b33316bbdcda7d1d35280f8c9c06a80b57499b7db26daef2c3ab587f10e9']],
  ['pluck_latest.pt', [98_338_102, '7176c0a84fd179c70d669867f77b741a64237c27c90b782232b28bc1343ca0ab']],
  ['trajectorybrave-pad-v1-step-035000.pt', [101_808_480, '644bf99d2463af136e2819b780657d9502bbbb7b2f0f055a4a9c7da46c7f4b1b']],
]);

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

test('神经音源 Release 清单固定四个生产权重及其校验值', () => {
  assert.equal(existsSync(MANIFEST_PATH), true, '缺少 config/model-assets.json');
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.releaseTag, 'neural-audio-v1');
  assert.equal(
    manifest.baseUrl,
    'https://github.com/Twiddle-AI-China/intelligent_jungle/releases/download/neural-audio-v1',
  );
  assert.equal(manifest.assets.length, EXPECTED_ASSETS.size);
  for (const asset of manifest.assets) {
    const expected = EXPECTED_ASSETS.get(asset.filename);
    assert.ok(expected, `清单出现未知权重 ${asset.filename}`);
    assert.deepEqual([asset.bytes, asset.sha256], expected);
  }
});

test('第三方来源说明覆盖三个生产 vendor 快照', () => {
  assert.equal(existsSync(NOTICE_PATH), true, '缺少 THIRD_PARTY_NOTICES.md');
  const notice = readFileSync(NOTICE_PATH, 'utf8');
  for (const name of ['midibrave', 'midibrave-v2', 'trajectorybrave']) {
    assert.match(notice, new RegExp(`\\b${name}\\b`, 'i'));
  }
  assert.match(notice, /2026-07-22/);
});

test('Git 只保留运行必需资源，不跟踪权重与 vendor 二进制产物', () => {
  const tracked = git('ls-files').split(/\r?\n/).filter(Boolean);
  const forbidden = tracked.filter((path) => (
    path.startsWith('flock-voice-engine/vendor/')
    && (
      /(^|\/)__pycache__(\/|$)/.test(path)
      || /(^|\/)fixtures\/generated(\/|$)/.test(path)
      || /\.(?:pt|wav|npz|pyc)$/i.test(path)
    )
  ));
  assert.deepEqual(forbidden, []);

  for (const prefix of [
    'flock-voice-engine/vendor/midibrave/',
    'flock-voice-engine/vendor/midibrave-v2/',
    'flock-voice-engine/vendor/trajectorybrave/',
  ]) {
    assert.ok(tracked.some((path) => path.startsWith(prefix)), `${prefix} 没有受跟踪源码`);
  }

  const weight = 'flock-voice-engine/model_weights/midiBrave/bass_latest.pt';
  assert.equal(spawnSync('git', ['check-ignore', '-q', weight], { cwd: ROOT }).status, 0);
  const checksum = 'flock-voice-engine/model_weights/midiBrave/SHA256SUMS';
  assert.notEqual(spawnSync('git', ['check-ignore', '-q', checksum], { cwd: ROOT }).status, 0);

  for (const filename of ['bass.npy', 'lead.npy', 'pad.npy', 'pluck.npy']) {
    const path = `flock-voice-engine/assets/timbre/voice_defaults/${filename}`;
    assert.notEqual(spawnSync('git', ['check-ignore', '-q', path], { cwd: ROOT }).status, 0);
    assert.ok(tracked.includes(path), `${path} 必须进入发行源码树`);
  }
});

test('公开发行版包含本地 LLM、云端 LLM 与 DGX 部署手册', () => {
  for (const relative of [
    'docs/deployment.md',
    'docs/local-llm.md',
    'docs/cloud-llm.md',
    '.env.example',
  ]) {
    assert.equal(existsSync(resolve(ROOT, relative)), true, `缺少 ${relative}`);
  }
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  for (const command of ['./scripts/setup.sh', './scripts/start.sh', './scripts/verify.sh']) {
    assert.ok(readme.includes(command), `README 缺少 ${command}`);
  }
  assert.match(readme, /vLLM[\s\S]*不(?:包含|捆绑)/i);
  assert.match(readme, /config\/runtime\.json/);
});

test('受跟踪文本不含凭证形状或非示例 env 文件', () => {
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  const envFiles = tracked.filter((path) => /(^|\/)\.env(?:\.|$)/.test(path));
  assert.deepEqual(envFiles, ['.env.example']);

  const patterns = [
    ['GitHub token', /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/g],
    ['Hugging Face token', /\bhf_[A-Za-z0-9]{20,}\b/g],
    ['OpenAI-style secret', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
    ['private key', /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/g],
    ['embedded bearer', /Authorization\s*[:=]\s*["']?Bearer\s+(?!test-)[A-Za-z0-9._-]{20,}/gi],
  ];
  const findings = [];
  for (const relative of tracked) {
    const buffer = readFileSync(resolve(ROOT, relative));
    if (buffer.includes(0)) continue;
    const source = buffer.toString('utf8');
    for (const [label, pattern] of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) findings.push(`${relative}: ${label}`);
    }
  }
  assert.deepEqual(findings, []);
});

test('浏览器配置只包含同源 Agent 路径', () => {
  const browserConfig = [
    textFile('mvp/runtime-config.js'),
    textFile('mvp/runtime-config.example.js'),
    textFile('scripts/assemble_web.py'),
  ].join('\n');
  assert.match(browserConfig, /\/api\/agent/);
  for (const forbidden of [/192\.168\./, /:8081\b/, /LCS_AGENT_API_KEY/, /Bearer\s+/i]) {
    assert.doesNotMatch(browserConfig, forbidden);
  }
});

function textFile(relative) {
  return readFileSync(resolve(ROOT, relative), 'utf8');
}
