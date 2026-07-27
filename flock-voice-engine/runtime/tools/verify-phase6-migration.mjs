#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'acorn';
import * as walk from 'acorn-walk';
import { buildFixedProductionGraph } from './production-graph-config.mjs';

const POSIX = (value) => value.split(sep).join('/');
const HEX64 = /^[0-9a-f]{64}$/;
const INVENTORY_ROOTS = Object.freeze([
  Object.freeze({ path: 'mvp/src', kind: 'source' }),
  Object.freeze({ path: 'flock-voice-engine/client', kind: 'legacy-client' }),
  Object.freeze({ path: 'mvp/test', kind: 'test' }),
  Object.freeze({ path: 'flock-voice-engine/runtime/src/legacy', kind: 'legacy-runtime' }),
  Object.freeze({ path: 'flock-voice-engine/runtime/test/legacy', kind: 'test' }),
]);
const REFERENCE_TEST_ROOTS = Object.freeze(['flock-voice-engine/runtime/test']);
const LITERAL_FILES = Object.freeze([
  Object.freeze({ path: 'flock-voice-engine/server/app.py', kind: 'source' }),
  Object.freeze({ path: 'flock-voice-engine/deploy/docker-run.sh', kind: 'legacy-deploy' }),
  Object.freeze({ path: 'flock-voice-engine/runtime/src/api/legacy-routes.js', kind: 'legacy-runtime' }),
]);
const DOMAIN_TEST_FILES = new Set([
  'world.test.js', 'sequence.test.js', 'economy.test.js', 'harmony.test.js',
  'harmony-frame.test.js', 'mapping.test.js', 'jungle.test.js', 'agent.test.js',
  'daycycle.test.js', 'master-policy.test.js', 'survival-actions.test.js',
  'conductor-characterization.test.js', 'deterministic-rng.test.js',
  'simulation-checkpoint-schema.test.js', 'sequence-checkpoint.test.js',
  'world-checkpoint.test.js', 'deterministic-conductor.test.js',
  'simulation-checkpoint.test.js',
]);
const RETIRED_TEST_REPLACEMENTS = new Map([
  ...[...DOMAIN_TEST_FILES].map((name) => [`mvp/test/${name}`,
    `flock-voice-engine/runtime/test/domain/${name}`]),
  ['mvp/test/audio.test.js', 'flock-voice-engine/runtime/test/audio/audio-planner.test.js'],
  ['mvp/test/backend-owner-boundary.test.js',
    'flock-voice-engine/runtime/test/security/production-bundle-boundary.test.js'],
  ['mvp/test/ecological-latent.test.js', 'flock-voice-engine/runtime/test/latent/relations.test.js'],
  ['mvp/test/eval-harness.test.js', 'flock-voice-engine/runtime/test/integration/phase34-shadow.test.js'],
  ['mvp/test/latent-roamer-control.test.js', 'flock-voice-engine/runtime/test/latent/latent-runtime.test.js'],
  ['mvp/test/latent-roamer-panel.test.js', 'flock-voice-engine/runtime/test/candidate-surface.test.js'],
  ['mvp/test/llm-client.test.js', 'flock-voice-engine/runtime/test/agents/contracts.test.js'],
  ['mvp/test/llm-integration.test.js', 'flock-voice-engine/runtime/test/integration/agent-composition.test.js'],
  ['mvp/test/llm-openai-client.test.js', 'flock-voice-engine/runtime/test/agents/providers.test.js'],
  ['mvp/test/llm-scheduler.test.js', 'flock-voice-engine/runtime/test/agents/provider-runner.test.js'],
  ['mvp/test/long-horizon-evolution.test.js', 'flock-voice-engine/runtime/test/integration/phase34-shadow.test.js'],
  ['mvp/test/master-external.test.js', 'flock-voice-engine/runtime/test/agents/contracts.test.js'],
  ['mvp/test/master-llm.test.js', 'flock-voice-engine/runtime/test/agents/prompts.test.js'],
  ['mvp/test/mix-agent.test.js', 'flock-voice-engine/runtime/test/agents/contracts.test.js'],
  ['mvp/test/pipeline.test.js', 'flock-voice-engine/runtime/test/integration/agent-composition.test.js'],
  ['mvp/test/survival-shadow.test.js', 'flock-voice-engine/runtime/test/domain/survival-actions.test.js'],
  ['flock-voice-engine/runtime/test/legacy/audio-owner.test.js',
    'flock-voice-engine/runtime/test/audio/audio-control-barrier.test.js'],
  ['flock-voice-engine/runtime/test/legacy/decoder-session.test.js',
    'flock-voice-engine/runtime/test/control/lease-manager.test.js'],
  ['flock-voice-engine/runtime/test/legacy/legacy-adapter.integration.test.js',
    'flock-voice-engine/runtime/test/audio/audio-fanout.integration.test.js'],
]);
const RETIRED_SUPPORT = new Set([
  'mvp/test/helpers.js', 'mvp/test/eval/harness.js',
  'mvp/test/fixtures/conductor-golden.js', 'mvp/test/fixtures/conductor-scenario.js',
  'mvp/test/fixtures/checkpoint-owner.js',
]);

function fail(code, detail = '') {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fileDigest = (root, path) => digest(readFileSync(resolve(root, path)));

function validateLiteralPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.endsWith('/')
      || path.includes('\\') || path.includes('//') || path.includes('*') || path.includes('?')
      || path.includes('[') || path.includes(']')
      || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('PHASE6_NON_LITERAL_PATH', String(path));
  }
  return path;
}

function discoverTree(root, path) {
  const base = resolve(root, path);
  if (!statSync(base).isDirectory()) fail('PHASE6_INVENTORY_ROOT_INVALID', path);
  const seenReal = new Set();
  const result = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const item = lstatSync(absolute);
      if (item.isSymbolicLink()) fail('PHASE6_INVENTORY_SYMLINK', POSIX(relative(root, absolute)));
      const real = realpathSync(absolute);
      if (seenReal.has(real)) fail('PHASE6_INVENTORY_REALPATH_ALIAS', POSIX(relative(root, absolute)));
      seenReal.add(real);
      if (item.isDirectory()) visit(absolute);
      else if (item.isFile()) result.push(POSIX(relative(root, absolute)));
      else fail('PHASE6_INVENTORY_NODE_INVALID', POSIX(relative(root, absolute)));
    }
  };
  visit(base);
  return result.sort();
}

function extractTestNames(root, path) {
  if (!path.endsWith('.test.js')) return [];
  let ast;
  try { ast = parse(readFileSync(resolve(root, path), 'utf8'),
    { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch { fail('PHASE6_TEST_PARSE_FAILED', path); }
  const names = []; const nonRunnable = new Set();
  walk.simple(ast, { CallExpression(node) {
    const direct = node.callee?.type === 'Identifier' && ['test', 'it'].includes(node.callee.name);
    const member = node.callee?.type === 'MemberExpression'
      && node.callee.object?.type === 'Identifier' && node.callee.object.name === 'test';
    if (!direct && !member) return;
    const first = node.arguments[0];
    let name;
    if (first?.type === 'Literal' && typeof first.value === 'string') name = first.value;
    else if (first?.type === 'TemplateLiteral' && first.expressions.length === 0) {
      name = first.quasis[0].value.cooked ?? first.quasis[0].value.raw;
    } else fail('PHASE6_NON_LITERAL_TEST_NAME', path);
    names.push(name);
    const memberName = node.callee?.type === 'MemberExpression'
      && !node.callee.computed ? node.callee.property?.name : null;
    const options = node.arguments[1];
    const disabledOption = options?.type === 'ObjectExpression' && options.properties.some((property) =>
      ['skip', 'todo'].includes(property.key?.name ?? property.key?.value)
        && property.value?.type === 'Literal' && Boolean(property.value.value));
    if (['skip', 'todo'].includes(memberName) || disabledOption) nonRunnable.add(name);
  } });
  if (!names.length) fail('PHASE6_TEST_FILE_EMPTY', path);
  if (new Set(names).size !== names.length) fail('PHASE6_DUPLICATE_TEST_NAME', path);
  return { names, nonRunnable };
}

function moduleReferencesRetired(root, path, retiredPaths, memo = new Map(), active = new Set()) {
  if (memo.has(path)) return memo.get(path);
  if (active.has(path)) return false;
  active.add(path);
  let ast;
  try { ast = parse(readFileSync(resolve(root, path), 'utf8'),
    { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch { fail('PHASE6_REFERENCE_TEST_PARSE_FAILED', path); }
  const strings = []; const imports = [];
  walk.full(ast, (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value);
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
      strings.push(node.quasis[0].value.cooked ?? node.quasis[0].value.raw);
    }
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration'
        || node.type === 'ExportAllDeclaration') && typeof node.source?.value === 'string') {
      imports.push(node.source.value);
    }
  });
  let found = strings.some((value) => [...retiredPaths].some((retired) => value.includes(retired)));
  if (!found) {
    for (const specifier of imports.filter((value) => value.startsWith('.'))) {
      const candidate = POSIX(relative(root, resolve(dirname(resolve(root, path)), specifier)));
      if (retiredPaths.has(candidate)) { found = true; break; }
      if (candidate.startsWith('..') || !candidate.endsWith('.js')) continue;
      try {
        if (statSync(resolve(root, candidate)).isFile()
            && moduleReferencesRetired(root, candidate, retiredPaths, memo, active)) {
          found = true; break;
        }
      } catch { /* unresolved imports are handled by their owning test/tool gates */ }
    }
  }
  active.delete(path); memo.set(path, found); return found;
}

function isRequiredRetiredSource(path) {
  if (path.startsWith('flock-voice-engine/client/')) return true;
  if (path.startsWith('flock-voice-engine/runtime/src/legacy/')
      || path === 'flock-voice-engine/runtime/src/api/legacy-routes.js') return true;
  if (path === 'flock-voice-engine/server/app.py'
      || path === 'flock-voice-engine/deploy/docker-run.sh') return true;
  if (path.startsWith('mvp/src/llm/') || path.startsWith('mvp/src/master/')) return true;
  return new Set([
    'mvp/src/main.js', 'mvp/src/world.js', 'mvp/src/agent.js', 'mvp/src/audio.js',
    'mvp/src/ecological-latent.js', 'mvp/src/config.js', 'mvp/src/sequence.js',
    'mvp/src/economy.js', 'mvp/src/harmony.js', 'mvp/src/mapping.js',
    'mvp/src/jungle.js', 'mvp/src/deterministic-conductor.js',
    'mvp/src/deterministic-rng.js', 'mvp/src/simulation-checkpoint.js',
    'mvp/src/mix-agent.js', 'mvp/src/survival-actions.js', 'mvp/src/survival-shadow.js',
    'mvp/src/ui/latent-roamer-legacy.js',
  ]).has(path);
}

function replacementForSource(path, domainMap) {
  if (domainMap.has(path)) return domainMap.get(path);
  if (path === 'mvp/src/main.js') return 'flock-voice-engine/runtime/src/index.js';
  if (path === 'mvp/src/agent.js') return 'flock-voice-engine/runtime/src/simulation-runtime.js';
  if (path === 'mvp/src/audio.js') return 'flock-voice-engine/runtime/src/audio/audio-planner.js';
  if (path === 'mvp/src/ecological-latent.js') return 'flock-voice-engine/runtime/src/latent/latent-runtime.js';
  if (path === 'mvp/src/mix-agent.js') return 'flock-voice-engine/runtime/src/agents/agent-orchestrator.js';
  if (path === 'mvp/src/survival-shadow.js') return 'flock-voice-engine/runtime/src/domain/survival-actions.js';
  if (path === 'mvp/src/ui/latent-roamer-legacy.js') return 'mvp/src/ui/latent-roamer.js';
  if (path.startsWith('mvp/src/llm/') || path.startsWith('mvp/src/master/')) {
    return 'flock-voice-engine/runtime/src/agents/agent-orchestrator.js';
  }
  if (path.startsWith('flock-voice-engine/client/')) return 'mvp/src/server-main.js';
  if (path === 'flock-voice-engine/runtime/src/api/legacy-routes.js') {
    return 'flock-voice-engine/runtime/src/api/bootstrap.js';
  }
  if (path === 'flock-voice-engine/runtime/src/legacy/audio-owner.js') {
    return 'flock-voice-engine/runtime/src/audio/audio-planner.js';
  }
  if (path === 'flock-voice-engine/runtime/src/legacy/decoder-adapter.js') {
    return 'flock-voice-engine/runtime/src/api/audio-ws.js';
  }
  if (path === 'flock-voice-engine/runtime/src/legacy/decoder-session-registry.js') {
    return 'flock-voice-engine/runtime/src/audio/audio-client-writer.js';
  }
  if (path === 'flock-voice-engine/runtime/src/legacy/write-access.js') {
    return 'flock-voice-engine/runtime/src/audio/audio-control-barrier.js';
  }
  if (path === 'flock-voice-engine/server/app.py') {
    return 'flock-voice-engine/server/audio_worker/__main__.py';
  }
  if (path === 'flock-voice-engine/deploy/docker-run.sh') {
    return 'flock-voice-engine/deploy/release.sh';
  }
  fail('PHASE6_REPLACEMENT_MISSING', path);
}

function sourceKind(path, rootKinds) {
  if (path === 'flock-voice-engine/server/app.py') return 'source';
  if (path === 'flock-voice-engine/deploy/docker-run.sh') return 'legacy-deploy';
  if (path === 'flock-voice-engine/runtime/src/api/legacy-routes.js') return 'legacy-runtime';
  if (path.startsWith('flock-voice-engine/runtime/test/')) return 'test';
  const root = [...rootKinds.keys()].find((value) => path.startsWith(`${value}/`));
  if (!root) fail('PHASE6_INVENTORY_PATH_UNCLASSIFIED', path);
  return rootKinds.get(root);
}

function readJson(root, path, code) {
  try { return JSON.parse(readFileSync(resolve(root, path), 'utf8')); }
  catch { fail(code, path); }
}

function readBoundJson(root, path, code) {
  const absolute = resolve(root, path);
  let bytes; let sidecar;
  try { bytes = readFileSync(absolute); sidecar = readFileSync(`${absolute}.sha256`, 'ascii'); }
  catch { fail(code, path); }
  const sha256 = digest(bytes);
  if (sidecar !== `${sha256}  ${absolute.split(sep).at(-1)}\n`) fail(code, path);
  let value;
  try { value = JSON.parse(bytes); } catch { fail(code, path); }
  if (bytes.toString('utf8') !== canonicalJson(value)) fail(code, path);
  return { value, sha256 };
}

function assertDomainLedger(domain) {
  if (domain?.schemaVersion !== 2 || domain.behaviorOwner !== 'runtime/src'
      || domain.candidateMode !== 'authoritative' || domain.deleteByPhase !== 6
      || !Array.isArray(domain.files) || !domain.files.length) fail('PHASE6_DOMAIN_LEDGER_INVALID');
  const map = new Map();
  for (const item of domain.files) {
    validateLiteralPath(item.source); validateLiteralPath(item.candidate);
    if (item.sourceStatus !== 'retired' || item.candidateStatus !== 'retained'
        || item.retireAfterGate !== 'phase6' || map.has(item.source)
        || item.source === item.candidate) fail('PHASE6_DOMAIN_LEDGER_INVALID');
    map.set(item.source, item.candidate);
  }
  return map;
}

function buildInventory(root) {
  const rootKinds = new Map(INVENTORY_ROOTS.map((item) => [item.path, item.kind]));
  const basePaths = [...INVENTORY_ROOTS.flatMap((item) => discoverTree(root, item.path)),
    ...LITERAL_FILES.map((item) => item.path)].sort();
  const retiredReferences = new Set(basePaths.filter((path) => isRequiredRetiredSource(path)
    || RETIRED_TEST_REPLACEMENTS.has(path) || RETIRED_SUPPORT.has(path)
    || path.startsWith('flock-voice-engine/runtime/test/legacy/')));
  const referenceMemo = new Map();
  const legacyReferenceTests = REFERENCE_TEST_ROOTS.flatMap((referenceRoot) =>
    discoverTree(root, referenceRoot).filter((path) => path.endsWith('.test.js')
      && !path.startsWith('flock-voice-engine/runtime/test/legacy/')
      && moduleReferencesRetired(root, path, retiredReferences, referenceMemo)));
  const paths = [...basePaths, ...legacyReferenceTests].sort();
  if (new Set(paths).size !== paths.length) fail('PHASE6_DUPLICATE_INVENTORY_PATH');
  return { rootKinds, paths, referenceTests: new Set(legacyReferenceTests) };
}

function validateSourceLedger(root, ledger, domainMap) {
  if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.inventoryRoots)
      || canonicalJson(ledger.inventoryRoots) !== canonicalJson(INVENTORY_ROOTS)
      || canonicalJson(ledger.referenceTestRoots) !== canonicalJson(REFERENCE_TEST_ROOTS)
      || !Array.isArray(ledger.literalFiles)
      || canonicalJson(ledger.literalFiles) !== canonicalJson(LITERAL_FILES)
      || !Array.isArray(ledger.files)) fail('PHASE6_SOURCE_LEDGER_INVALID');
  const { rootKinds, paths } = buildInventory(root);
  const entries = new Map();
  for (const item of ledger.files) {
    validateLiteralPath(item.path);
    if (entries.has(item.path) || !['retired', 'retained'].includes(item.status)
        || item.kind !== sourceKind(item.path, rootKinds)) fail('PHASE6_SOURCE_LEDGER_INVALID');
    const intendedTestReplacement = RETIRED_TEST_REPLACEMENTS.get(item.path);
    const exactTestCoverage = intendedTestReplacement && item.path.endsWith('.test.js')
      && extractTestNames(root, item.path).names.every((name) => {
        const replacement = extractTestNames(root, intendedTestReplacement);
        return replacement.names.includes(name) && !replacement.nonRunnable.has(name);
      });
    const requiredRetired = isRequiredRetiredSource(item.path)
      || exactTestCoverage || RETIRED_SUPPORT.has(item.path);
    if ((item.status === 'retired') !== requiredRetired) fail('PHASE6_SOURCE_STATUS_INVALID', item.path);
    if (item.status === 'retired') {
      validateLiteralPath(item.replacementPath);
      if (item.replacementOwner !== 'server' || item.retireAfterGate !== 'phase6'
          || item.replacementPath === item.path
          || !statSync(resolve(root, item.replacementPath)).isFile()) {
        fail('PHASE6_SOURCE_REPLACEMENT_INVALID', item.path);
      }
    } else if (typeof item.reason !== 'string' || !item.reason.trim()) {
      fail('PHASE6_RETAIN_REASON_REQUIRED', item.path);
    }
    entries.set(item.path, item);
  }
  if (canonicalJson([...entries.keys()].sort()) !== canonicalJson(paths)) {
    fail('PHASE6_SOURCE_INVENTORY_INCOMPLETE');
  }
  for (const [source, candidate] of domainMap) {
    const item = entries.get(source);
    if (!item || item.status !== 'retired' || item.replacementPath !== candidate) {
      fail('PHASE6_DOMAIN_SOURCE_LEDGER_MISMATCH', source);
    }
  }
  return entries;
}

function validateTestLedger(root, ledger, sourceEntries) {
  const roots = ['mvp/test', 'flock-voice-engine/runtime/test/legacy'];
  if (ledger?.schemaVersion !== 1 || canonicalJson(ledger.inventoryRoots) !== canonicalJson(roots)
      || canonicalJson(ledger.referenceTestRoots) !== canonicalJson(REFERENCE_TEST_ROOTS)
      || !Array.isArray(ledger.tests)) fail('PHASE6_TEST_LEDGER_INVALID');
  const expected = [];
  for (const [path, source] of sourceEntries) {
    if (source.kind !== 'test' || !path.endsWith('.test.js')) continue;
    for (const testName of extractTestNames(root, path).names) expected.push(`${path}\0${testName}`);
  }
  const actual = new Set(); const coverageIds = new Set(); const replacementFiles = new Set();
  for (const item of ledger.tests) {
    const key = `${item?.legacyTest?.path}\0${item?.legacyTest?.testName}`;
    if (actual.has(key) || coverageIds.has(item.coverageId)
        || typeof item.coverageId !== 'string' || !/^[a-z0-9][a-z0-9._-]+$/.test(item.coverageId)) {
      fail('PHASE6_TEST_LEDGER_DUPLICATE');
    }
    actual.add(key); coverageIds.add(item.coverageId);
    const source = sourceEntries.get(item.legacyTest.path);
    if (!source || source.kind !== 'test' || item.status !== source.status) {
      fail('PHASE6_TEST_SOURCE_STATUS_MISMATCH', item.legacyTest.path);
    }
    if (item.status === 'retired') {
      if (item.retireAfterReplacement !== true || !item.replacementTest) {
        fail('PHASE6_TEST_REPLACEMENT_INVALID', item.legacyTest.path);
      }
      const replacementPath = validateLiteralPath(item.replacementTest.path);
      const replacement = extractTestNames(root, replacementPath);
      if (!replacement.names.includes(item.replacementTest.testName)
          || replacement.nonRunnable.has(item.replacementTest.testName)
          || item.replacementTest.testName !== item.legacyTest.testName) {
        fail('PHASE6_REPLACEMENT_TEST_NOT_FOUND', replacementPath);
      }
      replacementFiles.add(replacementPath);
    } else if (typeof item.reason !== 'string' || !item.reason.trim()) {
      fail('PHASE6_TEST_RETAIN_REASON_REQUIRED', item.legacyTest.path);
    }
  }
  if (canonicalJson([...actual].sort()) !== canonicalJson(expected.sort())) {
    fail('PHASE6_TEST_INVENTORY_INCOMPLETE');
  }
  if (replacementFiles.size) {
    const result = spawnSync(process.execPath, ['--test', ...[...replacementFiles].sort()],
      { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) fail('PHASE6_REPLACEMENT_TEST_FAILED', result.stderr || result.stdout);
  }
  return ledger.tests;
}

function validateDomainTestLedger(root, ledger, sourceEntries, testEntries) {
  const sections = ['suites', 'supportFiles', 'testSources', 'adapters'];
  if (ledger?.schemaVersion !== 2 || ledger.normalization !== 'none-byte-for-byte'
      || sections.some((name) => !Array.isArray(ledger[name]))) {
    fail('PHASE6_DOMAIN_TEST_LEDGER_INVALID');
  }
  const seen = new Set();
  const testBySource = new Map();
  for (const item of testEntries) {
    const list = testBySource.get(item.legacyTest.path) ?? [];
    list.push(item); testBySource.set(item.legacyTest.path, list);
  }
  for (const section of sections) {
    for (const item of ledger[section]) {
      validateLiteralPath(item.source); validateLiteralPath(item.candidate);
      const key = `${section}\0${item.source}`;
      const source = sourceEntries.get(item.source);
      const expectedKeys = ['source', 'candidate', 'sourceStatus', 'candidateStatus',
        'retireAfterGate', ...(section === 'testSources' ? ['mode'] : []),
        ...(section === 'adapters' ? ['kind'] : [])].sort();
      if (Object.keys(item).sort().join(',') !== expectedKeys.join(',')
          || seen.has(key) || !source || source.status !== 'retired'
          || item.sourceStatus !== 'retired' || item.candidateStatus !== 'retained'
          || item.retireAfterGate !== 'phase6' || item.source === item.candidate
          || !statSync(resolve(root, item.candidate)).isFile()) {
        fail('PHASE6_DOMAIN_TEST_LEDGER_INVALID', item.source);
      }
      seen.add(key);
      if (section === 'suites') {
        const mapped = testBySource.get(item.source) ?? [];
        if (!mapped.length || mapped.some((test) => test.status !== 'retired'
            || test.replacementTest.path !== item.candidate
            || test.replacementTest.testName !== test.legacyTest.testName)) {
          fail('PHASE6_DOMAIN_TEST_LEDGER_MISMATCH', item.source);
        }
      }
    }
  }
  for (const source of sourceEntries.values()) {
    if (source.status === 'retired' && source.kind === 'test'
        && source.path.endsWith('.test.js')
        && source.replacementPath.startsWith('flock-voice-engine/runtime/test/domain/')
        && !seen.has(`suites\0${source.path}`)) {
      fail('PHASE6_DOMAIN_TEST_LEDGER_MISMATCH', source.path);
    }
  }
}

function validateStabilityEvidence(stability) {
  if (!stability || !HEX64.test(stability.sha256)
      || stability.value?.schemaVersion !== 1 || stability.value.status !== 'allowed'
      || stability.value.allowed !== true
      || stability.value.successfulServerOwnerUpgrades < 1
      || !HEX64.test(stability.value.currentReleaseManifestSha256)
      || !HEX64.test(stability.value.previousReleaseManifestSha256)) {
    fail('PHASE6_STABILITY_RECORD_INVALID');
  }
}

function assertGraphExcludesRetired(root, sourceEntries, graphBuilder) {
  const graph = graphBuilder(root);
  const retired = new Set([...sourceEntries.values()].filter((item) => item.status === 'retired')
    .map((item) => item.path));
  for (const path of graph.files) if (retired.has(path)) fail('PHASE6_PRODUCTION_GRAPH_RETAINS_SOURCE', path);
  if (!graph.files.includes('flock-voice-engine/server/backend_factory.py')
      || graph.files.includes('flock-voice-engine/server/app.py')) fail('PHASE6_PYTHON_GRAPH_INVALID');
  return graph;
}

export function generateLedgers(root, domain) {
  const domainMap = assertDomainLedger(domain);
  const { rootKinds, paths, referenceTests } = buildInventory(root);
  const sourceFiles = paths.map((path) => {
    const kind = sourceKind(path, rootKinds);
    const intendedTestReplacement = RETIRED_TEST_REPLACEMENTS.get(path);
    const exactTestCoverage = intendedTestReplacement && path.endsWith('.test.js')
      && extractTestNames(root, path).names.every((name) => {
        const replacement = extractTestNames(root, intendedTestReplacement);
        return replacement.names.includes(name) && !replacement.nonRunnable.has(name);
      });
    const requiredRetired = isRequiredRetiredSource(path) || exactTestCoverage
      || RETIRED_SUPPORT.has(path);
    if (!requiredRetired) return { path, kind, currentOwner: kind === 'test' ? 'test' : 'browser',
      status: 'retained', reason: intendedTestReplacement
        ? 'semantic replacement test-name coverage is pending; legacy regression remains active'
        : referenceTests.has(path)
          ? 'retired dependency reference must be migrated before Phase 6'
        : 'high-value server-owned view, protocol, or product regression coverage' };
    let replacementPath;
    if (kind === 'test') replacementPath = RETIRED_TEST_REPLACEMENTS.get(path)
      ?? (path.startsWith('flock-voice-engine/runtime/test/legacy/')
        ? RETIRED_TEST_REPLACEMENTS.get(path) : 'flock-voice-engine/runtime/test/domain/helpers.js');
    else replacementPath = replacementForSource(path, domainMap);
    return { path, kind, currentOwner: kind === 'test' ? 'test' : 'browser', replacementPath,
      replacementOwner: 'server', status: 'retired', retireAfterGate: 'phase6' };
  });
  const sourceByPath = new Map(sourceFiles.map((item) => [item.path, item]));
  const tests = [];
  for (const item of sourceFiles) {
    if (item.kind !== 'test' || !item.path.endsWith('.test.js')) continue;
    const names = extractTestNames(root, item.path).names;
    const replacementPath = item.status === 'retired' ? item.replacementPath : null;
    for (const testName of names) {
      const coverageId = `legacy.${digest(`${item.path}\0${testName}`).slice(0, 20)}`;
      if (item.status === 'retired') tests.push({ legacyTest: { path: item.path, testName },
        coverageId, status: 'retired', retireAfterReplacement: true,
        replacementTest: { path: replacementPath,
          testName } });
      else tests.push({ legacyTest: { path: item.path, testName }, coverageId,
        status: 'retained', reason: 'high-value regression remains active after Phase 6' });
    }
  }
  return {
    source: { schemaVersion: 1, inventoryRoots: INVENTORY_ROOTS,
      referenceTestRoots: REFERENCE_TEST_ROOTS, literalFiles: LITERAL_FILES,
      files: sourceFiles },
    test: { schemaVersion: 1,
      inventoryRoots: ['mvp/test', 'flock-voice-engine/runtime/test/legacy'],
      referenceTestRoots: REFERENCE_TEST_ROOTS, tests },
    sourceByPath,
  };
}

export function verifyMigration({ root, sourceLedger, testLedger, domainLedger,
  domainTestLedger, stabilityRecord, graphBuilder = buildFixedProductionGraph }) {
  const stabilityEvidence = readBoundJson(root, stabilityRecord, 'PHASE6_STABILITY_RECORD_INVALID');
  validateStabilityEvidence(stabilityEvidence);
  const domainMap = assertDomainLedger(domainLedger);
  const sourceEntries = validateSourceLedger(root, sourceLedger, domainMap);
  const tests = validateTestLedger(root, testLedger, sourceEntries);
  validateDomainTestLedger(root, domainTestLedger, sourceEntries, tests);
  const graph = assertGraphExcludesRetired(root, sourceEntries, graphBuilder);
  const referenceTests = buildInventory(root).referenceTests;
  const pendingTests = [...sourceEntries.values()].filter((item) => item.kind === 'test'
    && item.status === 'retained'
    && (RETIRED_TEST_REPLACEMENTS.has(item.path)
      || item.path.startsWith('flock-voice-engine/runtime/test/legacy/')
      || referenceTests.has(item.path)));
  if (pendingTests.length) fail('PHASE6_TEST_REPLACEMENTS_PENDING', pendingTests[0].path);
  const retiredPaths = [...new Set([
    ...[...sourceEntries.values()].filter((item) => item.status === 'retired').map((item) => item.path),
    ...tests.filter((item) => item.status === 'retired').map((item) => item.legacyTest.path),
  ])].sort();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { schemaVersion: 1, kind: 'phase6-validated-removal-manifest', head,
    paths: retiredPaths,
    sourceLedgerSha256: digest(canonicalJson(sourceLedger)),
    testLedgerSha256: digest(canonicalJson(testLedger)),
    domainLedgerSha256: digest(canonicalJson(domainLedger)),
    domainTestLedgerSha256: digest(canonicalJson(domainTestLedger)),
    stabilityRecordSha256: stabilityEvidence.sha256, productionGraphSha256: graph.sha256 };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) fail('PHASE6_ARGUMENTS_INVALID');
    const name = key.slice(2);
    if (name === 'initialize-ledgers') result[name] = true;
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) result[name] = argv[++index];
    else fail('PHASE6_ARGUMENTS_INVALID');
  }
  return result;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  if (!args['domain-ledger']) fail('PHASE6_ARGUMENTS_INVALID');
  const domain = readJson(root, args['domain-ledger'], 'PHASE6_DOMAIN_LEDGER_INVALID');
  if (args['initialize-ledgers']) {
    if (!args['source-ledger'] || !args['test-ledger']) fail('PHASE6_ARGUMENTS_INVALID');
    const generated = generateLedgers(root, domain);
    writeFileSync(resolve(root, args['source-ledger']), `${JSON.stringify(generated.source, null, 2)}\n`,
      { flag: 'wx' });
    writeFileSync(resolve(root, args['test-ledger']), `${JSON.stringify(generated.test, null, 2)}\n`,
      { flag: 'wx' });
    return;
  }
  for (const key of ['source-ledger', 'test-ledger', 'domain-test-ledger', 'stability-record', 'output']) {
    if (!args[key]) fail('PHASE6_ARGUMENTS_INVALID');
  }
  const source = readJson(root, args['source-ledger'], 'PHASE6_SOURCE_LEDGER_INVALID');
  const tests = readJson(root, args['test-ledger'], 'PHASE6_TEST_LEDGER_INVALID');
  const domainTests = readJson(root, args['domain-test-ledger'], 'PHASE6_DOMAIN_TEST_LEDGER_INVALID');
  const manifest = verifyMigration({ root, sourceLedger: source, testLedger: tests,
    domainLedger: domain, domainTestLedger: domainTests,
    stabilityRecord: args['stability-record'] });
  writeFileSync(resolve(root, args.output), `${canonicalJson(manifest)}\n`, { flag: 'wx' });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
