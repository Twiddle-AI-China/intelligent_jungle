import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = [
  'scripts/common.sh',
  'scripts/doctor.sh',
  'scripts/setup.sh',
  'scripts/start.sh',
  'scripts/stop.sh',
  'scripts/status.sh',
  'scripts/logs.sh',
  'scripts/verify.sh',
];

function text(relative) {
  return readFileSync(resolve(ROOT, relative), 'utf8');
}

function bashPath() {
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  return existsSync(gitBash) ? gitBash : 'bash';
}

test('发行版提供完整且语法合法的 DGX 生命周期脚本', () => {
  for (const relative of REQUIRED) {
    assert.equal(existsSync(resolve(ROOT, relative)), true, `缺少 ${relative}`);
    const source = text(relative);
    assert.match(source, /^#!\/usr\/bin\/env bash\r?\n/);
    const checked = spawnSync(bashPath(), ['-n', resolve(ROOT, relative)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, `${relative}: ${checked.stderr}`);
  }
});

test('运行路径不再绑定旧服务器目录、用户名或 UID', () => {
  const deployFiles = readdirSync(resolve(ROOT, 'flock-voice-engine/deploy'))
    .filter((name) => name.endsWith('.sh'))
    .map((name) => `flock-voice-engine/deploy/${name}`);
  const runtimeFiles = [
    ...REQUIRED,
    ...deployFiles,
    'flock-voice-engine/deploy/Dockerfile',
    'flock-voice-engine/server/app.py',
    'flock-voice-engine/server/paths.py',
    'flock-voice-engine/server/backends/midibrave_backend.py',
    'flock-voice-engine/server/backends/midibrave_backend_v2.py',
    'flock-voice-engine/server/backends/trajectorybrave_pad.py',
  ];
  const forbidden = [/\/srv\/deploy/, /\/home\/rolf/, /\/data\/model_weights/, /1005:1005/];
  for (const relative of runtimeFiles) {
    const source = text(relative);
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${relative} 仍包含 ${pattern}`);
    }
  }
});

test('start.sh 固定生产音源参数并只挂载当前仓库', () => {
  const start = text('scripts/start.sh');
  for (const fragment of [
    '--gpus all',
    '--add-host host.docker.internal:host-gateway',
    '--cpu-shares 262144',
    'OMP_NUM_THREADS=16',
    'LCS_RUNTIME_CONFIG=/app/config/runtime.json',
    'LCS_STATIC_ROOT=/app/web',
    'LCS_MODEL_DIR=/app/model_weights/midiBrave',
    '/app/server:ro',
    '/app/vendor:ro',
    '/app/assets:ro',
    '/app/model_weights/midiBrave:ro',
    '/app/web:ro',
    '/app/config:ro',
    '/app/scripts:ro',
  ]) {
    assert.ok(start.includes(fragment), `start.sh 缺少 ${fragment}`);
  }
  assert.match(start, /--user\s+"\$\(id -u\):\$\(id -g\)"/);
});

test('setup 只安装神经音源，不捆绑 vLLM 或通用 LLM 权重', () => {
  const setup = text('scripts/setup.sh');
  assert.match(setup, /model_assets\.py[\s\S]*install/);
  assert.match(setup, /assemble_web\.py/);
  assert.match(setup, /docker[\s\S]*build/);
  assert.doesNotMatch(setup, /pip\s+install\s+vllm/i);
  assert.doesNotMatch(setup, /bird_agent.*\.(?:pt|safetensors|gguf)/i);
});

test('Docker 构建上下文以白名单排除模型和 vendor 大文件', () => {
  const relative = 'flock-voice-engine/.dockerignore';
  assert.equal(existsSync(resolve(ROOT, relative)), true, `缺少 ${relative}`);
  const ignore = text(relative);
  assert.match(ignore, /^\*\r?\n/);
  assert.match(ignore, /!server\//);
  assert.match(ignore, /!server\/\*\*/);
  assert.match(ignore, /!deploy\/Dockerfile/);
  assert.doesNotMatch(ignore, /!model_weights|!vendor/);
});
