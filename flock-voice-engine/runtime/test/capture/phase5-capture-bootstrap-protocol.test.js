import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  MAX_PHASE5_CAPTURE_BOOTSTRAP_ACK_BYTES,
  MAX_PHASE5_CAPTURE_BOOTSTRAP_REQUEST_BYTES,
  createPhase5CaptureBootstrapProtocol,
} from '../../src/capture/phase5-capture-bootstrap-protocol.js';

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
const PROFILE = Object.freeze({
  clients: 4,
  slowClient: 4,
  durationMinutes: 30,
  speciesEndpoint: 'http://127.0.0.1:8081/v1',
  speciesModel: 'bird_agent',
});
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const CHALLENGE = '5'.repeat(64);
const CAPTURE_NONCE = '6'.repeat(64);
const RECEIPT_CHALLENGE = '7'.repeat(64);
const SPKI_BASE64 =
  'MCowBQYDK2VwAyEAb0aAWQv8xav2fgaG1jjaMotHemDd5XS/HGup0cz1cMI=';
const SPKI_SHA256 = createHash('sha256')
  .update(Buffer.from(SPKI_BASE64, 'base64'))
  .digest('hex');

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(value[key])}`
  )).join(',')}}`;
}

function line(value) {
  return Buffer.from(`${canonical(value)}\n`, 'utf8');
}

function identity() {
  return {
    runId: RUN_ID,
    challenge: CHALLENGE,
    release: { ...RELEASE },
    geometry: {
      ...GEOMETRY,
      rowVoices: [...GEOMETRY.rowVoices],
    },
    profile: { ...PROFILE },
  };
}

function request() {
  return {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-bootstrap-request',
    identity: identity(),
    captureNonce: CAPTURE_NONCE,
  };
}

function admission() {
  return {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission',
    runId: RUN_ID,
    challenge: CHALLENGE,
    captureNonce: CAPTURE_NONCE,
    signerSpkiSha256: SPKI_SHA256,
    trustedSignerSpkiDerBase64: SPKI_BASE64,
  };
}

function ack(admissionBytes = line(admission())) {
  return {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission-ack',
    admissionSha256: createHash('sha256')
      .update(admissionBytes)
      .digest('hex'),
    receiptChallenge: RECEIPT_CHALLENGE,
  };
}

function receipt(admissionBytes = line(admission())) {
  return {
    schemaVersion: 1,
    kind: 'phase5-candidate-capture-admission-receipt',
    admissionSha256: createHash('sha256')
      .update(admissionBytes)
      .digest('hex'),
    receiptChallenge: RECEIPT_CHALLENGE,
  };
}

function protocol() {
  return createPhase5CaptureBootstrapProtocol({
    trustedRelease: { ...RELEASE },
    trustedGeometry: {
      ...GEOMETRY,
      rowVoices: [...GEOMETRY.rowVoices],
    },
  });
}

function rejected(operation) {
  assert.throws(
    operation,
    /PHASE5_CAPTURE_BOOTSTRAP_PROTOCOL_REQUIRED/,
  );
}

test('canonical bootstrap owns identity and gates the exact admission-line ACK',
    () => {
      const value = protocol();
      const requestBytes = line(request());
      const accepted = value.acceptBootstrapRequestBytes(requestBytes);
      requestBytes.fill(0);

      assert.deepEqual(accepted, {
        identity: identity(),
        captureNonce: CAPTURE_NONCE,
      });
      assert.equal(Object.isFrozen(accepted), true);
      assert.equal(Object.isFrozen(accepted.identity), true);
      assert.equal(Object.isFrozen(accepted.identity.release), true);
      assert.equal(Object.isFrozen(accepted.identity.geometry), true);
      assert.equal(
        Object.isFrozen(accepted.identity.geometry.rowVoices),
        true,
      );
      assert.equal(Object.isFrozen(accepted.identity.profile), true);

      const admissionBytes = line(admission());
      const bound = value.bindAdmissionBytes(admissionBytes);
      assert.deepEqual(bound, {
        admission: admission(),
        admissionSha256: createHash('sha256')
          .update(admissionBytes)
          .digest('hex'),
      });
      assert.equal(Object.isFrozen(bound), true);
      assert.equal(Object.isFrozen(bound.admission), true);
      assert.deepEqual(
        value.acceptAdmissionAckBytes(line(ack(admissionBytes))),
        line(receipt(admissionBytes)),
      );
      for (const operation of [
        () => value.acceptBootstrapRequestBytes(line(request())),
        () => value.bindAdmissionBytes(admissionBytes),
        () => value.acceptAdmissionAckBytes(line(ack(admissionBytes))),
      ]) {
        rejected(operation);
      }
      assert.deepEqual(Object.keys(value).sort(), [
        'abort',
        'acceptAdmissionAckBytes',
        'acceptBootstrapRequestBytes',
        'bindAdmissionBytes',
      ]);
      assert.equal(Object.isFrozen(value), true);
    });

test('admission digest includes the unique trailing LF', () => {
  const value = protocol();
  value.acceptBootstrapRequestBytes(line(request()));
  const admissionBytes = line(admission());
  const bound = value.bindAdmissionBytes(admissionBytes);

  assert.notEqual(
    bound.admissionSha256,
    createHash('sha256')
      .update(admissionBytes.subarray(0, admissionBytes.length - 1))
      .digest('hex'),
  );
  const wrong = ack(admissionBytes);
  wrong.admissionSha256 = createHash('sha256')
    .update(admissionBytes.subarray(0, admissionBytes.length - 1))
    .digest('hex');
  rejected(() => value.acceptAdmissionAckBytes(line(wrong)));
});

test('trusted release, geometry, and fixed profile must all match exactly',
    () => {
      const mutations = [
        (value) => {
          value.identity.release.releaseRevision = '9'.repeat(40);
        },
        (value) => {
          value.identity.geometry.blockFrames = 2_048;
        },
        (value) => {
          value.identity.geometry.rowVoices[4] = 'lead';
        },
        (value) => {
          value.identity.profile.durationMinutes = 29;
        },
        (value) => {
          value.identity.profile.speciesEndpoint =
            'http://127.0.0.1:9999/v1';
        },
        (value) => {
          value.identity.hidden = true;
        },
      ];
      for (const mutate of mutations) {
        const candidate = request();
        mutate(candidate);
        const value = protocol();
        rejected(() => value.acceptBootstrapRequestBytes(line(candidate)));
        rejected(() => (
          value.acceptBootstrapRequestBytes(line(request()))
        ));
      }
    });

test('bootstrap request rejects every non-canonical or ambiguous line once',
    () => {
      const valid = line(request());
      const variants = [
        valid.subarray(0, valid.length - 1),
        Buffer.concat([valid, Buffer.from('\n')]),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
        Buffer.concat([Buffer.from(' '), valid]),
        Buffer.concat([valid, Buffer.from('tail')]),
        Buffer.from(
          `{"schemaVersion":1,"schemaVersion":1,"kind":`
          + `"phase5-candidate-capture-bootstrap-request"}\n`,
        ),
        Buffer.from([0xff, 0x0a]),
        Buffer.alloc(
          MAX_PHASE5_CAPTURE_BOOTSTRAP_REQUEST_BYTES + 1,
          0x61,
        ),
      ];
      for (const bytes of variants) {
        const value = protocol();
        rejected(() => value.acceptBootstrapRequestBytes(bytes));
        rejected(() => (
          value.acceptBootstrapRequestBytes(line(request()))
        ));
      }
    });

test('malformed or cross-bound admission consumes the second stage',
    () => {
      const mutations = [
        (value) => {
          value.runId = '223e4567-e89b-42d3-a456-426614174000';
        },
        (value) => {
          value.challenge = '7'.repeat(64);
        },
        (value) => {
          value.captureNonce = '8'.repeat(64);
        },
        (value) => {
          value.signerSpkiSha256 = '9'.repeat(64);
        },
        (value) => {
          value.hidden = true;
        },
      ];
      for (const mutate of mutations) {
        const candidate = admission();
        mutate(candidate);
        const value = protocol();
        value.acceptBootstrapRequestBytes(line(request()));
        rejected(() => value.bindAdmissionBytes(line(candidate)));
        rejected(() => value.bindAdmissionBytes(line(admission())));
      }
    });

test('ACK is canonical, bounded, stage-bound, and once-only', () => {
  const admissionBytes = line(admission());
  const variants = [
    (() => {
      const value = ack(admissionBytes);
      value.admissionSha256 = '0'.repeat(64);
      return line(value);
    })(),
    (() => {
      const value = ack(admissionBytes);
      value.kind = 'phase5-candidate-capture-admission';
      return line(value);
    })(),
    (() => {
      const value = ack(admissionBytes);
      value.receiptChallenge = 'not-a-controller-challenge';
      return line(value);
    })(),
    Buffer.concat([line(ack(admissionBytes)), Buffer.from('\n')]),
    Buffer.alloc(
      MAX_PHASE5_CAPTURE_BOOTSTRAP_ACK_BYTES + 1,
      0x61,
    ),
  ];
  for (const bytes of variants) {
    const value = protocol();
    value.acceptBootstrapRequestBytes(line(request()));
    value.bindAdmissionBytes(admissionBytes);
    rejected(() => value.acceptAdmissionAckBytes(bytes));
    rejected(() => (
      value.acceptAdmissionAckBytes(line(ack(admissionBytes)))
    ));
  }

  const outOfOrder = protocol();
  rejected(() => (
    outOfOrder.acceptAdmissionAckBytes(line(ack(admissionBytes)))
  ));
});

test('abort is idempotent and seals every incomplete stage', () => {
  for (const setup of [
    () => protocol(),
    () => {
      const value = protocol();
      value.acceptBootstrapRequestBytes(line(request()));
      return value;
    },
    () => {
      const value = protocol();
      value.acceptBootstrapRequestBytes(line(request()));
      value.bindAdmissionBytes(line(admission()));
      return value;
    },
  ]) {
    const value = setup();
    assert.equal(value.abort(), true);
    assert.equal(value.abort(), true);
    rejected(() => value.acceptBootstrapRequestBytes(line(request())));
    rejected(() => value.bindAdmissionBytes(line(admission())));
    rejected(() => (
      value.acceptAdmissionAckBytes(line(ack()))
    ));
  }
});

test('constructor rejects mutable-shape tricks before protocol state exists',
    () => {
      const valid = {
        trustedRelease: { ...RELEASE },
        trustedGeometry: {
          ...GEOMETRY,
          rowVoices: [...GEOMETRY.rowVoices],
        },
      };
      for (const candidate of [
        {},
        { ...valid, hidden: true },
        {
          ...valid,
          trustedRelease: new Proxy({ ...RELEASE }, {}),
        },
        {
          ...valid,
          trustedGeometry: {
            ...GEOMETRY,
            rowVoices: new Proxy([...GEOMETRY.rowVoices], {}),
          },
        },
      ]) {
        rejected(() => createPhase5CaptureBootstrapProtocol(candidate));
      }
    });
