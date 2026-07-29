import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  _createPhase5CandidateCaptureOwner,
} from '../../src/capture/phase5-candidate-capture-owner.js';
import {
  createPhase5CaptureBootstrapProtocol,
} from '../../src/capture/phase5-capture-bootstrap-protocol.js';
import {
  createPhase5CaptureChannelProtocol,
} from '../../src/capture/phase5-capture-channel-protocol.js';
import {
  createPhase5CandidateCaptureFinalizer,
} from '../../src/capture/phase5-capture-finalizer.js';
import {
  decodePhase5CaptureCanonicalLine,
  encodePhase5CaptureCanonicalLine,
} from '../../src/capture/capture-wire.js';

const RELEASE = Object.freeze({
  releaseManifestSha256: '1'.repeat(64),
  releaseRevision: '2'.repeat(40),
  sourceManifestSha256: '3'.repeat(64),
  audioArtifactSha256: '4'.repeat(64),
});
const GEOMETRY = Object.freeze({
  sampleRate: 44_100,
  blockFrames: 4_096,
  poolSize: 5,
  rowVoices: Object.freeze([
    'bass',
    'pad',
    'lead',
    'pluck',
    'pad',
  ]),
});
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const CHALLENGE = '5'.repeat(64);
const CAPTURE_NONCE = '6'.repeat(64);
const RECEIPT_CHALLENGE = '7'.repeat(64);

const flush = () => new Promise((resolve) => {
  setImmediate(resolve);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function request() {
  return {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-bootstrap-request',
    identity: {
      runId: RUN_ID,
      challenge: CHALLENGE,
      release: { ...RELEASE },
      geometry: {
        ...GEOMETRY,
        rowVoices: [...GEOMETRY.rowVoices],
      },
      profile: {
        clients: 4,
        slowClient: 4,
        durationMinutes: 30,
        speciesEndpoint: 'http://127.0.0.1:8081/v1',
        speciesModel: 'bird_agent',
      },
    },
    captureNonce: CAPTURE_NONCE,
  };
}

function line(value, maximum = 4096) {
  return encodePhase5CaptureCanonicalLine(value, maximum);
}

class FakePeer extends EventEmitter {
  constructor({ autoFlush = true } = {}) {
    super();
    this.autoFlush = autoFlush;
    this.destroyed = false;
    this.paused = false;
    this.writes = [];
    this.pendingFlush = null;
  }

  pause() {
    this.paused = true;
    return this;
  }

  resume() {
    this.paused = false;
    return this;
  }

  write(bytes, callback) {
    this.writes.push(Buffer.from(bytes));
    if (this.autoFlush) {
      queueMicrotask(() => callback?.());
    } else {
      this.pendingFlush = callback;
    }
    return this;
  }

  end(bytes, callback) {
    this.writes.push(Buffer.from(bytes));
    if (this.autoFlush) {
      queueMicrotask(() => callback?.());
    } else {
      this.pendingFlush = callback;
    }
    return this;
  }

  flushWrite() {
    const callback = this.pendingFlush;
    this.pendingFlush = null;
    callback?.();
  }

  destroy() {
    this.destroyed = true;
    return this;
  }
}

function fixture({
  peer = new FakePeer(),
  startCaptureServer = null,
} = {}) {
  const deadlines = [];
  const cancelled = [];
  const captureCloses = [];
  const serverTerminal = deferred();
  const defaultStartCaptureServer = async ({ protocol, signal }) => {
    if (signal.aborted) throw new Error('CAPTURE_START_ABORTED');
    return Object.freeze({
      getAdmissionBytes: () => protocol.getAdmissionBytes(),
      waitForTerminal: () => serverTerminal.promise,
      async close() {
        captureCloses.push('close');
        serverTerminal.resolve('closed');
        try {
          protocol.handleFinalizeRequestBytes(Buffer.alloc(0));
        } catch {
          // The empty request deliberately seals the finalizer.
        }
      },
    });
  };
  const owner = _createPhase5CandidateCaptureOwner({
    trustedRelease: { ...RELEASE },
    trustedGeometry: {
      ...GEOMETRY,
      rowVoices: [...GEOMETRY.rowVoices],
    },
    connectBootstrap: () => peer,
    createBootstrapProtocol:
      (options) => createPhase5CaptureBootstrapProtocol(options),
    createFinalizer:
      (options) => createPhase5CandidateCaptureFinalizer(options),
    createCaptureProtocol:
      (options) => createPhase5CaptureChannelProtocol(options),
    startCaptureServer:
      startCaptureServer ?? defaultStartCaptureServer,
    createAbortController: () => new AbortController(),
    scheduleTimeout(callback, milliseconds) {
      const token = { callback, milliseconds };
      deadlines.push(token);
      return token;
    },
    cancelTimeout(token) {
      cancelled.push(token);
    },
  });
  return {
    owner,
    peer,
    deadlines,
    cancelled,
    captureCloses,
    serverTerminal,
  };
}

async function waitForAdmission(value) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (value.peer.writes.length > 0) return value.peer.writes[0];
    await flush();
  }
  throw new Error('ADMISSION_NOT_WRITTEN');
}

function ackFor(admissionBytes) {
  return line({
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission-ack',
    admissionSha256: createHash('sha256')
      .update(admissionBytes)
      .digest('hex'),
    receiptChallenge: RECEIPT_CHALLENGE,
  }, 256);
}

function receiptFor(admissionBytes) {
  return {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission-receipt',
    admissionSha256: createHash('sha256')
      .update(admissionBytes)
      .digest('hex'),
    receiptChallenge: RECEIPT_CHALLENGE,
  };
}

test('one absolute deadline gates admission, fresh ACK receipt, and close',
    async () => {
      const value = fixture();
      const starting = value.owner.start();
      const requestBytes = line(request());
      value.peer.emit('data', requestBytes.subarray(0, 73));
      value.peer.emit('data', requestBytes.subarray(73));
      const admissionBytes = await waitForAdmission(value);
      const admission = decodePhase5CaptureCanonicalLine(
        admissionBytes,
        4096,
      );

      assert.equal(admission.runId, RUN_ID);
      assert.equal(admission.challenge, CHALLENGE);
      assert.equal(admission.captureNonce, CAPTURE_NONCE);
      assert.equal(value.deadlines.length, 1);
      assert.equal(value.deadlines[0].milliseconds, 5_000);
      value.peer.emit('data', ackFor(admissionBytes));
      await flush();
      assert.equal(value.peer.writes.length, 2);
      assert.deepEqual(
        decodePhase5CaptureCanonicalLine(value.peer.writes[1], 256),
        receiptFor(admissionBytes),
      );
      let settled = false;
      void starting.then(() => {
        settled = true;
      });
      await flush();
      assert.equal(settled, false);

      value.peer.emit('close', false);
      assert.equal(await starting, true);
      assert.equal(value.cancelled.length, 1);
      assert.deepEqual(Object.keys(value.owner).sort(), [
        'close',
        'start',
        'waitForFailure',
      ]);
      assert.equal(Object.isFrozen(value.owner), true);
      assert.equal(await value.owner.close(), true);
      assert.deepEqual(value.captureCloses, ['close']);
    });

test('request and ACK trickle never renew the single deadline',
    async () => {
      const value = fixture();
      const starting = value.owner.start();
      const requestBytes = line(request());
      for (const byte of requestBytes) {
        value.peer.emit('data', Buffer.from([byte]));
      }
      const admissionBytes = await waitForAdmission(value);
      for (const byte of ackFor(admissionBytes)) {
        value.peer.emit('data', Buffer.from([byte]));
      }
      assert.equal(value.deadlines.length, 1);

      value.deadlines[0].callback();
      await assert.rejects(
        starting,
        /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
      );
      assert.equal(value.peer.destroyed, true);
      assert.deepEqual(value.captureCloses, ['close']);
    });

test('pipelined bytes after the request consume the owner before admission',
    async () => {
      const value = fixture();
      const starting = value.owner.start();
      value.peer.emit('data', Buffer.concat([
        line(request()),
        Buffer.from('tail'),
      ]));

      await assert.rejects(
        starting,
        /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
      );
      assert.deepEqual(value.peer.writes, []);
      assert.equal(value.peer.destroyed, true);
    });

test('admission write must flush before ACK receipt and close can succeed',
    async () => {
      const peer = new FakePeer({ autoFlush: false });
      const value = fixture({ peer });
      const starting = value.owner.start();
      peer.emit('data', line(request()));
      const admissionBytes = await waitForAdmission(value);
      peer.emit('data', ackFor(admissionBytes));
      peer.emit('end');
      peer.emit('close', false);

      await assert.rejects(
        starting,
        /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
      );
      assert.equal(peer.destroyed, true);
      assert.deepEqual(value.captureCloses, ['close']);
    });

test('valid ACK receipt without a clean full close remains subject to timeout',
    async () => {
      for (const terminal of ['no-close', 'error-close']) {
        const value = fixture();
        const starting = value.owner.start();
        value.peer.emit('data', line(request()));
        const admissionBytes = await waitForAdmission(value);
        value.peer.emit('data', ackFor(admissionBytes));
        if (terminal === 'error-close') {
          value.peer.emit('close', true);
        } else {
          value.deadlines[0].callback();
        }
        await assert.rejects(
          starting,
          /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
        );
        assert.deepEqual(value.captureCloses, ['close']);
      }
    });

test('close during listener startup aborts and owns a late listener',
    async () => {
      const startup = deferred();
      let observedSignal;
      let lateCloseCalls = 0;
      const value = fixture({
        startCaptureServer: ({ signal }) => {
          observedSignal = signal;
          return startup.promise;
        },
      });
      const starting = value.owner.start();
      value.peer.emit('data', line(request()));
      await flush();

      const closing = value.owner.close();
      assert.equal(observedSignal.aborted, true);
      startup.resolve(Object.freeze({
        getAdmissionBytes() {
          throw new Error('LATE_LISTENER_MUST_NOT_PUBLISH');
        },
        waitForTerminal() {
          return Promise.resolve('closed');
        },
        async close() {
          lateCloseCalls += 1;
        },
      }));
      assert.equal(await closing, true);
      await assert.rejects(
        starting,
        /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
      );
      assert.equal(lateCloseCalls, 1);
      assert.deepEqual(value.peer.writes, []);
    });

test('capture listener terminal before bootstrap completion fails startup',
    async () => {
      for (const terminal of ['failure', 'premature-success']) {
        const value = fixture();
        const starting = value.owner.start();
        value.peer.emit('data', line(request()));
        await waitForAdmission(value);

        if (terminal === 'failure') {
          value.serverTerminal.reject(new Error('listener failed'));
        } else {
          value.serverTerminal.resolve('completed');
        }

        await assert.rejects(
          starting,
          /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
        );
        assert.equal(value.peer.destroyed, true);
        assert.deepEqual(value.captureCloses, ['close']);
      }
    });

test('capture listener failure or unexplained close reaches lifecycle',
    async () => {
      for (const terminal of ['failure', 'closed']) {
        const value = fixture();
        const failure = value.owner.waitForFailure();
        const starting = value.owner.start();
        value.peer.emit('data', line(request()));
        const admissionBytes = await waitForAdmission(value);
        value.peer.emit('data', ackFor(admissionBytes));
        await flush();
        value.peer.emit('close', false);
        assert.equal(await starting, true);

        if (terminal === 'failure') {
          value.serverTerminal.reject(new Error('listener failed'));
        } else {
          value.serverTerminal.resolve('closed');
        }
        await assert.rejects(
          failure,
          /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
        );
        assert.equal(await value.owner.close(), true);
      }
    });

test('successful one-shot capture completion is not a process failure',
    async () => {
      const value = fixture();
      const failure = value.owner.waitForFailure();
      const starting = value.owner.start();
      value.peer.emit('data', line(request()));
      const admissionBytes = await waitForAdmission(value);
      value.peer.emit('data', ackFor(admissionBytes));
      await flush();
      value.peer.emit('close', false);
      assert.equal(await starting, true);

      value.serverTerminal.resolve('completed');
      assert.equal(await failure, false);
      assert.equal(await value.owner.close(), true);
    });

test('start and close synchronously claim their once-only state',
    async () => {
      const value = fixture();
      assert.equal(
        value.owner.waitForFailure(),
        value.owner.waitForFailure(),
      );
      assert.throws(
        () => value.owner.waitForFailure('unexpected'),
        /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
      );
      const starting = value.owner.start();
      assert.throws(
        () => value.owner.start(),
        /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
      );
      const closing = value.owner.close();
      assert.equal(value.owner.close(), closing);
      assert.equal(await closing, true);
      await assert.rejects(
        starting,
        /PHASE5_CANDIDATE_CAPTURE_OWNER_REQUIRED/,
      );
    });
