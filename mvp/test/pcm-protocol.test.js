import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { parseAudioFrameV1 } from '../src/pcm-protocol.js';

const HEADER_BYTES = 32;
const U64_MAX = (1n << 64n) - 1n;
const GOLDEN_HEX =
  '464c4b3101002000070000000900000000100000000000000200000002000100'
  + '000000000000003f000000bf0000803f';
const GOLDEN_CURSOR = Object.freeze({
  streamRevision: 7,
  blockSeq: 9,
  startFrame: 4096n,
});
const AUDIO_WS_V1_GOLDEN =
  '464c4b3101002000020000000300000008070605040302010200000002000100'
  + '000000000000003f000000bf0000803f';

function goldenBytes() {
  return Uint8Array.from(Buffer.from(GOLDEN_HEX, 'hex'));
}

function goldenBuffer() {
  return goldenBytes().buffer;
}

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function expectAudioError(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error?.name, 'Error');
    assert.equal(error?.code, code);
    assert.equal(error?.message, code);
    return true;
  });
}

function crossRealmBufferSource({
  shared = false,
  view = false,
  dataView: asDataView = false,
} = {}) {
  const bytes = JSON.stringify([...goldenBytes()]);
  const constructorName = shared ? 'SharedArrayBuffer' : 'ArrayBuffer';
  return runInNewContext(`(() => {
    const buffer = new ${constructorName}(${goldenBytes().byteLength});
    new Uint8Array(buffer).set(${bytes});
    return ${
  asDataView
    ? 'new DataView(buffer)'
    : view
      ? 'new Uint8Array(buffer)'
      : 'buffer'
};
  })()`);
}

test('独立 FLK1 golden 按 little-endian 解出冻结头与独立 samples', () => {
  const parsed = parseAudioFrameV1(goldenBuffer(), GOLDEN_CURSOR);

  assert.deepEqual(parsed.header, {
    headerVersion: 1,
    flags: 0,
    headerBytes: 32,
    streamRevision: 7,
    blockSeq: 9,
    startFrame: 4096n,
    frameCount: 2,
    channels: 2,
    format: 1,
  });
  assert.deepEqual([...parsed.samples], [0, 0.5, -0.5, 1]);
  assert.equal(parsed.samples.constructor, Float32Array);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.header), true);
  assert.equal(Object.isFrozen(parsed.samples), false);
  assert.throws(() => {
    parsed.header.blockSeq = 10;
  }, TypeError);
});

test('browser parser independently matches the public Audio WS v1 fixed golden', () => {
  const parsed = parseAudioFrameV1(Buffer.from(AUDIO_WS_V1_GOLDEN, 'hex'), {
    streamRevision: 2, blockSeq: 3, startFrame: 0x0102030405060708n,
  });
  assert.deepEqual([...parsed.samples], [0, .5, -.5, 1]);
  assert.equal(parsed.header.frameCount, 2);
});

test('每个固定头字段都必须精确匹配 FLK1 v1', () => {
  const attacks = [
    ['magic', (view) => view.setUint8(0, 0), 'AUDIO_BAD_MAGIC'],
    ['headerVersion', (view) => view.setUint8(4, 2), 'AUDIO_VERSION_UNSUPPORTED'],
    ['flags', (view) => view.setUint8(5, 1), 'AUDIO_FLAGS_UNSUPPORTED'],
    ['headerBytes', (view) => view.setUint16(6, 31, true), 'AUDIO_HEADER_BYTES_INVALID'],
    ['channels', (view) => view.setUint16(28, 1, true), 'AUDIO_CHANNELS_UNSUPPORTED'],
    ['format', (view) => view.setUint16(30, 2, true), 'AUDIO_FORMAT_UNSUPPORTED'],
  ];

  for (const [name, mutate, code] of attacks) {
    const bytes = goldenBytes();
    mutate(dataView(bytes));
    expectAudioError(
      () => parseAudioFrameV1(bytes, GOLDEN_CURSOR),
      code,
      name,
    );
  }
});

test('所有 0..31 byte 短头都稳定拒绝且不构造越界 DataView', () => {
  for (let length = 0; length < HEADER_BYTES; length += 1) {
    expectAudioError(
      () => parseAudioFrameV1(new ArrayBuffer(length), GOLDEN_CURSOR),
      'AUDIO_HEADER_TOO_SHORT',
    );
  }
});

test('payload 少一字节、多一字节与 huge frameCount short input 都拒绝', () => {
  const bytes = goldenBytes();
  expectAudioError(
    () => parseAudioFrameV1(bytes.subarray(0, bytes.byteLength - 1), GOLDEN_CURSOR),
    'AUDIO_LENGTH_MISMATCH',
  );

  const trailing = new Uint8Array(bytes.byteLength + 1);
  trailing.set(bytes);
  expectAudioError(
    () => parseAudioFrameV1(trailing, GOLDEN_CURSOR),
    'AUDIO_LENGTH_MISMATCH',
  );

  const huge = goldenBytes();
  dataView(huge).setUint32(24, 0xffff_ffff, true);
  expectAudioError(
    () => parseAudioFrameV1(huge, GOLDEN_CURSOR),
    'AUDIO_LENGTH_MISMATCH',
  );
});

test('frameCount=0 即使长度精确也 fail closed', () => {
  const headerOnly = goldenBytes().slice(0, HEADER_BYTES);
  dataView(headerOnly).setUint32(24, 0, true);
  expectAudioError(
    () => parseAudioFrameV1(headerOnly, GOLDEN_CURSOR),
    'AUDIO_FRAME_COUNT_INVALID',
  );
});

test('普通 ArrayBuffer 的精确 subview、unaligned DataView 与 Buffer 都可解析', () => {
  const source = goldenBytes();

  const surrounded = new Uint8Array(source.byteLength + 11);
  surrounded.fill(0xa5);
  surrounded.set(source, 3);
  const precise = surrounded.subarray(3, 3 + source.byteLength);
  assert.deepEqual(
    [...parseAudioFrameV1(precise, GOLDEN_CURSOR).samples],
    [0, 0.5, -0.5, 1],
  );
  assert.deepEqual(
    [...parseAudioFrameV1(
      new DataView(surrounded.buffer, 3, source.byteLength),
      GOLDEN_CURSOR,
    ).samples],
    [0, 0.5, -0.5, 1],
  );

  const nodeBuffer = Buffer.concat([
    Buffer.from([0xde, 0xad, 0xbe]),
    Buffer.from(source),
    Buffer.from([0xef]),
  ]).subarray(3, 3 + source.byteLength);
  assert.deepEqual(
    [...parseAudioFrameV1(nodeBuffer, GOLDEN_CURSOR).samples],
    [0, 0.5, -0.5, 1],
  );
});

test('跨 realm 的 raw ArrayBuffer 与 view 都按普通 AB 解析', () => {
  const raw = crossRealmBufferSource();
  const view = crossRealmBufferSource({ view: true });
  const foreignDataView = crossRealmBufferSource({ dataView: true });

  assert.deepEqual(
    [...parseAudioFrameV1(raw, GOLDEN_CURSOR).samples],
    [0, 0.5, -0.5, 1],
  );
  assert.deepEqual(
    [...parseAudioFrameV1(view, GOLDEN_CURSOR).samples],
    [0, 0.5, -0.5, 1],
  );
  assert.deepEqual(
    [...parseAudioFrameV1(foreignDataView, GOLDEN_CURSOR).samples],
    [0, 0.5, -0.5, 1],
  );
});

test('view 的 byteLength 是协议边界，不能借用 backing buffer 的尾部', () => {
  const source = goldenBytes();
  const backing = new Uint8Array(source.byteLength + 8);
  backing.set(source, 4);
  const truncated = new Uint8Array(
    backing.buffer,
    4,
    source.byteLength - 1,
  );
  expectAudioError(
    () => parseAudioFrameV1(truncated, GOLDEN_CURSOR),
    'AUDIO_LENGTH_MISMATCH',
  );
});

test('TypedArray 自有 buffer 不能把 SAB backing 伪装成普通 AB', () => {
  const shared = new SharedArrayBuffer(goldenBytes().byteLength);
  const view = new Uint8Array(shared);
  view.set(goldenBytes());
  Object.defineProperty(view, 'buffer', {
    configurable: true,
    value: goldenBuffer(),
  });

  expectAudioError(
    () => parseAudioFrameV1(view, GOLDEN_CURSOR),
    'AUDIO_SHARED_BUFFER_UNSUPPORTED',
  );
});

test('TypedArray 自有 byteLength 不能借用实际 view 边界外的 payload', () => {
  const bytes = goldenBytes();
  const headerOnly = new Uint8Array(
    bytes.buffer,
    bytes.byteOffset,
    HEADER_BYTES,
  );
  Object.defineProperty(headerOnly, 'byteLength', {
    configurable: true,
    value: bytes.byteLength,
  });

  expectAudioError(
    () => parseAudioFrameV1(headerOnly, GOLDEN_CURSOR),
    'AUDIO_LENGTH_MISMATCH',
  );
});

test('TypedArray 自有 buffer getter 不会被 parser 观察', () => {
  const view = goldenBytes();
  let observed = 0;
  Object.defineProperty(view, 'buffer', {
    configurable: true,
    get() {
      observed += 1;
      throw new Error('hostile buffer getter');
    },
  });

  assert.deepEqual(
    [...parseAudioFrameV1(view, GOLDEN_CURSOR).samples],
    [0, 0.5, -0.5, 1],
  );
  assert.equal(observed, 0);
});

test('TypedArray 自有 byteOffset getter 不会被 parser 观察', () => {
  const view = goldenBytes();
  let observed = 0;
  Object.defineProperty(view, 'byteOffset', {
    configurable: true,
    get() {
      observed += 1;
      throw new Error('hostile byteOffset getter');
    },
  });

  assert.deepEqual(
    [...parseAudioFrameV1(view, GOLDEN_CURSOR).samples],
    [0, 0.5, -0.5, 1],
  );
  assert.equal(observed, 0);
});

test('TypedArray 自有 Symbol byteLength 不泄漏 native TypeError', () => {
  const view = goldenBytes();
  Object.defineProperty(view, 'byteLength', {
    configurable: true,
    value: Symbol('hostile byteLength'),
  });

  assert.deepEqual(
    [...parseAudioFrameV1(view, GOLDEN_CURSOR).samples],
    [0, 0.5, -0.5, 1],
  );
});

test('DataView 自有 metadata getter 不会被 parser 观察', () => {
  const view = dataView(goldenBytes());
  const observed = [];
  for (const property of ['buffer', 'byteOffset', 'byteLength']) {
    Object.defineProperty(view, property, {
      configurable: true,
      get() {
        observed.push(property);
        throw new Error(`hostile DataView ${property} getter`);
      },
    });
  }

  assert.deepEqual(
    [...parseAudioFrameV1(view, GOLDEN_CURSOR).samples],
    [0, 0.5, -0.5, 1],
  );
  assert.deepEqual(observed, []);
});

test('拒绝非 buffer、SharedArrayBuffer 及其 view', () => {
  for (const value of [null, undefined, {}, [], 'FLK1']) {
    expectAudioError(
      () => parseAudioFrameV1(value, GOLDEN_CURSOR),
      'AUDIO_INPUT_INVALID',
    );
  }

  const shared = new SharedArrayBuffer(goldenBytes().byteLength);
  new Uint8Array(shared).set(goldenBytes());
  expectAudioError(
    () => parseAudioFrameV1(shared, GOLDEN_CURSOR),
    'AUDIO_SHARED_BUFFER_UNSUPPORTED',
  );
  expectAudioError(
    () => parseAudioFrameV1(new Uint8Array(shared), GOLDEN_CURSOR),
    'AUDIO_SHARED_BUFFER_UNSUPPORTED',
  );
});

test('跨 realm SharedArrayBuffer 的 raw 与 view 都稳定拒绝', () => {
  const raw = crossRealmBufferSource({ shared: true });
  const view = crossRealmBufferSource({ shared: true, view: true });

  expectAudioError(
    () => parseAudioFrameV1(raw, GOLDEN_CURSOR),
    'AUDIO_SHARED_BUFFER_UNSUPPORTED',
  );
  expectAudioError(
    () => parseAudioFrameV1(view, GOLDEN_CURSOR),
    'AUDIO_SHARED_BUFFER_UNSUPPORTED',
  );
});

test('prototype 被改为 null 的 SharedArrayBuffer 仍按内部 brand 拒绝', () => {
  const shared = new SharedArrayBuffer(goldenBytes().byteLength);
  const view = new Uint8Array(shared);
  view.set(goldenBytes());
  Object.setPrototypeOf(shared, null);

  expectAudioError(
    () => parseAudioFrameV1(shared, GOLDEN_CURSOR),
    'AUDIO_SHARED_BUFFER_UNSUPPORTED',
  );
  expectAudioError(
    () => parseAudioFrameV1(view, GOLDEN_CURSOR),
    'AUDIO_SHARED_BUFFER_UNSUPPORTED',
  );
});

test('ArrayBuffer Proxy 与 revoked input Proxy 不泄漏 native TypeError', () => {
  const proxied = new Proxy(goldenBuffer(), {});
  expectAudioError(
    () => parseAudioFrameV1(proxied, GOLDEN_CURSOR),
    'AUDIO_INPUT_INVALID',
  );

  const revoked = Proxy.revocable(goldenBuffer(), {});
  revoked.revoke();
  expectAudioError(
    () => parseAudioFrameV1(revoked.proxy, GOLDEN_CURSOR),
    'AUDIO_INPUT_INVALID',
  );
});

test('detached ArrayBuffer、TypedArray view 与 DataView 都稳定拒绝', () => {
  const detachedBuffer = goldenBuffer();
  structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
  expectAudioError(
    () => parseAudioFrameV1(detachedBuffer, GOLDEN_CURSOR),
    'AUDIO_INPUT_INVALID',
  );

  const secondBuffer = goldenBuffer();
  const detachedView = new Uint8Array(secondBuffer);
  structuredClone(secondBuffer, { transfer: [secondBuffer] });
  expectAudioError(
    () => parseAudioFrameV1(detachedView, GOLDEN_CURSOR),
    'AUDIO_INPUT_INVALID',
  );

  const dataViewBuffer = goldenBuffer();
  const detachedDataView = new DataView(dataViewBuffer);
  structuredClone(dataViewBuffer, { transfer: [dataViewBuffer] });
  expectAudioError(
    () => parseAudioFrameV1(detachedDataView, GOLDEN_CURSOR),
    'AUDIO_INPUT_INVALID',
  );
});

test('expectedCursor 必填且三个字段不做类型转换或 u32/u64 wrapping', () => {
  const invalidCursors = [
    undefined,
    null,
    {},
    [],
    { streamRevision: 7, blockSeq: 9 },
    { streamRevision: '7', blockSeq: 9, startFrame: 4096n },
    { streamRevision: 7n, blockSeq: 9, startFrame: 4096n },
    { streamRevision: -1, blockSeq: 9, startFrame: 4096n },
    { streamRevision: 0x1_0000_0000, blockSeq: 9, startFrame: 4096n },
    { streamRevision: 7.5, blockSeq: 9, startFrame: 4096n },
    { streamRevision: Number.NaN, blockSeq: 9, startFrame: 4096n },
    { streamRevision: Number.POSITIVE_INFINITY, blockSeq: 9, startFrame: 4096n },
    { streamRevision: 7, blockSeq: '9', startFrame: 4096n },
    { streamRevision: 7, blockSeq: -1, startFrame: 4096n },
    { streamRevision: 7, blockSeq: 0x1_0000_0000, startFrame: 4096n },
    { streamRevision: 7, blockSeq: 9.5, startFrame: 4096n },
    { streamRevision: 7, blockSeq: 9, startFrame: 4096 },
    { streamRevision: 7, blockSeq: 9, startFrame: '4096' },
    { streamRevision: 7, blockSeq: 9, startFrame: -1n },
    { streamRevision: 7, blockSeq: 9, startFrame: U64_MAX + 1n },
  ];

  for (const cursor of invalidCursors) {
    expectAudioError(
      () => parseAudioFrameV1(goldenBuffer(), cursor),
      'AUDIO_CURSOR_INVALID',
    );
  }
});

test('revoked expectedCursor Proxy 在 shape/Array.isArray 边界内稳定拒绝', () => {
  const revoked = Proxy.revocable({
    streamRevision: 7,
    blockSeq: 9,
    startFrame: 4096n,
  }, {});
  revoked.revoke();

  expectAudioError(
    () => parseAudioFrameV1(goldenBuffer(), revoked.proxy),
    'AUDIO_CURSOR_INVALID',
  );
});

test('expectedCursor 的 gap、duplicate 与任一字段不等均为 discontinuity', () => {
  const mismatches = [
    { streamRevision: 6, blockSeq: 9, startFrame: 4096n },
    { streamRevision: 8, blockSeq: 9, startFrame: 4096n },
    { streamRevision: 7, blockSeq: 8, startFrame: 4096n },
    { streamRevision: 7, blockSeq: 10, startFrame: 4096n },
    { streamRevision: 7, blockSeq: 9, startFrame: 4095n },
    { streamRevision: 7, blockSeq: 9, startFrame: 4097n },
  ];

  for (const cursor of mismatches) {
    expectAudioError(
      () => parseAudioFrameV1(goldenBuffer(), cursor),
      'AUDIO_DISCONTINUITY',
    );
  }
});

test('startFrame + frameCount 超过 u64 拒绝，恰好到 u64 max 可接受', () => {
  const overflow = goldenBytes();
  dataView(overflow).setBigUint64(16, U64_MAX, true);
  expectAudioError(
    () => parseAudioFrameV1(overflow, {
      streamRevision: 7,
      blockSeq: 9,
      startFrame: U64_MAX,
    }),
    'AUDIO_CURSOR_OVERFLOW',
  );

  const boundary = goldenBytes();
  dataView(boundary).setBigUint64(16, U64_MAX - 2n, true);
  const parsed = parseAudioFrameV1(boundary, {
    streamRevision: 7,
    blockSeq: 9,
    startFrame: U64_MAX - 2n,
  });
  assert.equal(parsed.header.startFrame, U64_MAX - 2n);
});

test('samples 是 little-endian 独立副本，源复用或突变不会改变结果', () => {
  const source = goldenBytes();
  const parsed = parseAudioFrameV1(source, GOLDEN_CURSOR);
  source.fill(0xff, HEADER_BYTES);
  assert.deepEqual([...parsed.samples], [0, 0.5, -0.5, 1]);
});

test('协议未冻结 NaN/Infinity 拒绝规则，parser 保留 f32 位值', () => {
  const source = goldenBytes();
  const view = dataView(source);
  view.setFloat32(HEADER_BYTES, Number.NaN, true);
  view.setFloat32(HEADER_BYTES + 4, Number.POSITIVE_INFINITY, true);
  view.setFloat32(HEADER_BYTES + 8, Number.NEGATIVE_INFINITY, true);

  const parsed = parseAudioFrameV1(source, GOLDEN_CURSOR);
  assert.equal(Number.isNaN(parsed.samples[0]), true);
  assert.equal(parsed.samples[1], Number.POSITIVE_INFINITY);
  assert.equal(parsed.samples[2], Number.NEGATIVE_INFINITY);
});
