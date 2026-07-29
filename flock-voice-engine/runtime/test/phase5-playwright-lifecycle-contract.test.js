import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('./e2e/phase5-local.spec.js', import.meta.url),
  'utf8',
);

test('phase5 maintenance leases heartbeat and have failure-safe idempotent disposal', () => {
  assert.match(source, /MAINTENANCE_HEARTBEAT_MS\s*=\s*750/);
  assert.match(source, /command\('legacy\.heartbeat'/);
  assert.match(source, /heartbeatFailure\s*=\s*new Error/);
  assert.match(source, /if \(priorFailure !== null\) throw priorFailure/);
  assert.match(source, /function failPending\(/);
  assert.match(source, /socket\.on\('error',[\s\S]*failPending/);
  assert.match(source, /socket\.on\('close',[\s\S]*failPending/);
  assert.match(source, /registerDisposer\(lease\.release\)/);
  assert.match(source, /finally\s*\{[\s\S]*disposerScope\.dispose\(\)/);
});

test('phase5 new UI evidence requires the actual close/release and public AGENT state', () => {
  assert.match(source, /\[data-latent-close="true"\]/);
  assert.match(source, /waitForBrowserCommandResult\([\s\S]*'control\.release'/);
  assert.match(source, /waitForPublicOwner\([\s\S]*'melody'[\s\S]*'AGENT'/);
  assert.match(source, /releaseAccepted:\s*newUiReleaseResult\.accepted\s*===\s*true[\s\S]*newUiReleaseResult\.released\s*===\s*true/);
  const releaseResult = source.search(
    /waitForBrowserCommandResult\(\s*page,\s*'control\.release'/,
  );
  const publicAgent = source.search(/waitForPublicOwner\(page,\s*'melody',\s*'AGENT'/);
  const acceptedEvidence = source.search(
    /releaseAccepted:\s*newUiReleaseResult\.accepted\s*===\s*true/,
  );
  assert.ok(releaseResult >= 0 && publicAgent > releaseResult && acceptedEvidence > publicAgent);
});

test('phase5 evidence projects readyz and segments bounded HTTP/WS lifecycles', () => {
  assert.match(source, /READY_EVIDENCE_FIELDS\s*=\s*Object\.freeze\(\[/);
  assert.match(source, /SURFACE_ENTRY_PATHS\s*=\s*Object\.freeze\(\{\s*demo:\s*'\/demo\.html',\s*tracks:\s*'\/tracks\.html',\s*'new-ui':\s*'\/'/);
  assert.match(source, /canonicalJson,\s*projectSurfaceTransports,\s*validateLeaseEvidence/);
  assert.match(source, /function projectReadyEvidence\(/);
  assert.match(source, /responseStatus/);
  assert.match(source, /redirectedFrom/);
  assert.match(source, /redirectedTo/);
  assert.match(source, /framesSent/);
  assert.match(source, /framesReceived/);
  assert.match(source, /assertSurfaceTransport\(/);
  assert.match(source, /waitForSurfaceSocketsClosed\(/);
  assert.match(source, /evidence:\s*\(\)\s*=>\s*projectSurfaceTransports\(/);
  assert.match(source, /surfaceTrace\.evidence\(\)/);
  assert.match(source, /surfaceEntryPaths:\s*SURFACE_ENTRY_PATHS/);
  assert.match(source, /allowedHttpPaths:\s*new Set\(\[\.\.\.STATIC_PATHS,\s*\.\.\.RUNTIME_PATHS\]\)/);
  assert.match(source, /Buffer\.from\(canonicalJson\(readyEvidence\)\)/);
  assert.match(source, /Buffer\.from\(canonicalJson\(leaseEvidence\)\)/);
  assert.match(source, /validateLeaseEvidence\(leaseEvidence\)/);
  assert.doesNotMatch(source, /surfaceTrace\.snapshot\(\)/);
  assert.doesNotMatch(source, /snapshot:\s*\(\)/);
});

test('phase5 raw HTTP assertions reject request and response URL credentials', () => {
  assert.match(source, /const responseUrl = new URL\(request\.responseUrl\)/);
  assert.match(source, /expect\(url\.username,\s*request\.rawUrl\)\.toBe\(''\)/);
  assert.match(source, /expect\(url\.password,\s*request\.rawUrl\)\.toBe\(''\)/);
  assert.match(
    source,
    /expect\(responseUrl\.username,\s*request\.responseUrl\)\.toBe\(''\)/,
  );
  assert.match(
    source,
    /expect\(responseUrl\.password,\s*request\.responseUrl\)\.toBe\(''\)/,
  );
});
