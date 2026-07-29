import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCandidateOpsCommand,
  readCandidateOps,
} from '../../tools/lib/candidate-ops.mjs';

test('candidate ops command is fixed to docker exec and internal loopback HTTP', () => {
  const command = buildCandidateOpsCommand('/readyz');
  assert.equal(command.file, 'docker');
  assert.deepEqual(command.args.slice(0, 4), [
    'exec',
    'flock-runtime-candidate',
    'node',
    '-e',
  ]);
  assert.deepEqual(command.args.slice(5), ['--', '/readyz']);
  assert.deepEqual(command.options, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 65_536,
    windowsHide: true,
  });
  const probeSource = command.args[4];
  assert.match(probeSource, /hostname: '127\.0\.0\.1'/);
  assert.match(probeSource, /port: 8090/);
  assert.match(probeSource, /localAddress: '127\.0\.0\.1'/);
  assert.match(probeSource, /Host: '127\.0\.0\.1:8090'/);
  assert.doesNotMatch(probeSource, /origin|sec-fetch|18090|4193/i);

  for (const path of ['/api/v1/bootstrap', '/readyz?probe=1', '/healthz/', '', null]) {
    assert.throws(() => buildCandidateOpsCommand(path), /CANDIDATE_OPS_PATH_INVALID/);
  }
});

test('candidate ops reader parses only one bounded JSON envelope from the fixed command', async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, '{"statusCode":200,"body":{"workerReady":true}}\n', '');
  };
  const result = await readCandidateOps('/readyz', { execFileImpl });
  assert.deepEqual(result, { statusCode: 200, body: { workerReady: true } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'docker');
  assert.equal(calls[0].args[0], 'exec');
  assert.equal(calls[0].args[1], 'flock-runtime-candidate');
});

test('candidate ops reader fails closed on stderr, malformed output or execution failure', async () => {
  for (const outcome of [
    { error: null, stdout: '{"statusCode":200,"body":{}}\n', stderr: 'warning\n' },
    { error: null, stdout: '{}\n', stderr: '' },
    { error: null, stdout: '{"statusCode":200,"body":{}}\ntrailing', stderr: '' },
    { error: new Error('spawn failed'), stdout: '', stderr: '' },
  ]) {
    const execFileImpl = (_file, _args, _options, callback) => {
      callback(outcome.error, outcome.stdout, outcome.stderr);
    };
    await assert.rejects(
      readCandidateOps('/healthz', { execFileImpl }),
      /CANDIDATE_OPS_READ_FAILED/,
    );
  }
});
