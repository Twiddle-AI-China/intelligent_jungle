#!/usr/bin/env node
import { execFile as nodeExecFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const CANDIDATE_CONTAINER = 'flock-runtime-candidate';
const ALLOWED_PATHS = new Set(['/healthz', '/readyz']);
const EXECUTION_TIMEOUT_MILLISECONDS = 5_000;
const MAX_OUTPUT_BYTES = 65_536;

const CONTAINER_PROBE_SOURCE = String.raw`
const http = require('node:http');
const allowedPaths = new Set(['/healthz', '/readyz']);
const path = process.argv[1];
const maxBodyBytes = 60 * 1024;
let request;
let timer;
let settled = false;
function fail() {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { request?.destroy(); } catch {}
  process.stderr.write('CANDIDATE_OPS_READ_FAILED\n');
  process.exitCode = 2;
}
if (!allowedPaths.has(path)) {
  fail();
} else {
  request = http.request({
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: 18090,
    method: 'GET',
    path,
    headers: { Host: '127.0.0.1:18090' },
    localAddress: '127.0.0.1',
    agent: false,
    setHost: false,
  }, (response) => {
    const chunks = [];
    let receivedBytes = 0;
    response.on('error', fail);
    response.on('aborted', fail);
    response.on('data', (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += bytes.length;
      if (receivedBytes > maxBodyBytes) {
        fail();
        return;
      }
      chunks.push(bytes);
    });
    response.on('end', () => {
      if (settled) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks, receivedBytes).toString('utf8'));
        if (!Number.isInteger(response.statusCode)
            || response.statusCode < 100 || response.statusCode > 599
            || body === null || typeof body !== 'object' || Array.isArray(body)) {
          fail();
          return;
        }
        settled = true;
        clearTimeout(timer);
        process.stdout.write(JSON.stringify({ statusCode: response.statusCode, body }) + '\n');
      } catch {
        fail();
      }
    });
  });
  request.on('error', fail);
  timer = setTimeout(fail, 3_000);
  request.end();
}
`.trim();

function assertAllowedPath(path) {
  if (typeof path !== 'string' || !ALLOWED_PATHS.has(path)) {
    throw new Error('CANDIDATE_OPS_PATH_INVALID');
  }
}

export function buildCandidateOpsCommand(path) {
  assertAllowedPath(path);
  return Object.freeze({
    file: 'docker',
    args: Object.freeze([
      'exec',
      CANDIDATE_CONTAINER,
      'node',
      '-e',
      CONTAINER_PROBE_SOURCE,
      '--',
      path,
    ]),
    options: Object.freeze({
      encoding: 'utf8',
      timeout: EXECUTION_TIMEOUT_MILLISECONDS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    }),
  });
}

function parseEnvelope(stdout, stderr) {
  if (typeof stdout !== 'string' || typeof stderr !== 'string'
      || stderr !== '' || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
    throw new Error('CANDIDATE_OPS_READ_FAILED');
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('CANDIDATE_OPS_READ_FAILED');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !Number.isInteger(value.statusCode)
      || value.statusCode < 100 || value.statusCode > 599
      || value.body === null || typeof value.body !== 'object' || Array.isArray(value.body)
      || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'statusCode') || !Object.hasOwn(value, 'body')) {
    throw new Error('CANDIDATE_OPS_READ_FAILED');
  }
  return Object.freeze({ statusCode: value.statusCode, body: value.body });
}

export function readCandidateOps(path, { execFileImpl = nodeExecFile } = {}) {
  const command = buildCandidateOpsCommand(path);
  if (typeof execFileImpl !== 'function') {
    return Promise.reject(new Error('CANDIDATE_OPS_READ_FAILED'));
  }
  return new Promise((resolveRead, rejectRead) => {
    const reject = () => rejectRead(new Error('CANDIDATE_OPS_READ_FAILED'));
    try {
      execFileImpl(command.file, command.args, command.options,
        (error, stdout, stderr) => {
          if (error) {
            reject();
            return;
          }
          try {
            resolveRead(parseEnvelope(stdout, stderr));
          } catch {
            reject();
          }
        });
    } catch {
      reject();
    }
  });
}

async function cli() {
  if (process.argv.length !== 3) throw new Error('CANDIDATE_OPS_PATH_INVALID');
  const value = await readCandidateOps(process.argv[2]);
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  cli().catch(() => {
    process.stderr.write('CANDIDATE_OPS_READ_FAILED\n');
    process.exitCode = 2;
  });
}
