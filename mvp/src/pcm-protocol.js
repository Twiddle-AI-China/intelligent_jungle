const AUDIO_HEADER_BYTES = 32;
const AUDIO_CHANNELS = 2;
const AUDIO_FORMAT_F32LE = 1;
const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const arrayBufferByteLength =
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const sharedBufferByteLength =
  typeof SharedArrayBuffer === 'undefined'
    ? null
    : Object.getOwnPropertyDescriptor(
      SharedArrayBuffer.prototype,
      'byteLength',
    ).get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer =
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const typedArrayByteOffset =
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayByteLength =
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const dataViewBuffer =
  Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const dataViewByteOffset =
  Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;
const dataViewByteLength =
  Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;

function audioError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function classifyBufferBrand(value) {
  try {
    return {
      kind: 'array-buffer',
      byteLength: arrayBufferByteLength.call(value),
    };
  } catch {
    // 继续检查 SharedArrayBuffer 内部槽。
  }
  if (sharedBufferByteLength !== null) {
    try {
      return {
        kind: 'shared-array-buffer',
        byteLength: sharedBufferByteLength.call(value),
      };
    } catch {
      // 不是有对应内部槽的 raw buffer。
    }
  }
  return null;
}

function readViewMetadata(value) {
  try {
    return {
      buffer: typedArrayBuffer.call(value),
      byteOffset: typedArrayByteOffset.call(value),
      byteLength: typedArrayByteLength.call(value),
    };
  } catch {
    return {
      buffer: dataViewBuffer.call(value),
      byteOffset: dataViewByteOffset.call(value),
      byteLength: dataViewByteLength.call(value),
    };
  }
}

function normalizeBufferSource(value) {
  let buffer;
  let byteOffset;
  let byteLength;
  let shared = false;
  let valid = false;
  try {
    const directBrand = classifyBufferBrand(value);
    if (directBrand?.kind === 'shared-array-buffer') {
      shared = true;
    } else if (directBrand?.kind === 'array-buffer') {
      buffer = value;
      byteOffset = 0;
      byteLength = directBrand.byteLength;
      valid = true;
    } else if (ArrayBuffer.isView(value)) {
      ({ buffer, byteOffset, byteLength } = readViewMetadata(value));
      const backingBrand = classifyBufferBrand(buffer);
      if (backingBrand?.kind === 'shared-array-buffer') {
        shared = true;
      } else if (backingBrand?.kind === 'array-buffer') {
        valid = true;
      }
    }
  } catch {
    // Proxy、revoked Proxy 与 detached DataView getter 都统一进入稳定错误边界。
    throw audioError('AUDIO_INPUT_INVALID');
  }
  if (shared) throw audioError('AUDIO_SHARED_BUFFER_UNSUPPORTED');
  if (!valid) throw audioError('AUDIO_INPUT_INVALID');

  // Detached ArrayBuffer 的 byteLength 会退化为 0；构造零长度 view 可稳定区分它和
  // 合法的空 buffer，同时不在校验短头前创建 DataView。
  try {
    new Uint8Array(buffer, byteOffset, 0);
  } catch {
    throw audioError('AUDIO_INPUT_INVALID');
  }

  if (byteLength < AUDIO_HEADER_BYTES) {
    throw audioError('AUDIO_HEADER_TOO_SHORT');
  }
  return { buffer, byteOffset, byteLength };
}

function validU32(value) {
  return Number.isInteger(value)
    && !Object.is(value, -0)
    && value >= 0
    && value <= U32_MAX;
}

function readExpectedCursor(expectedCursor) {
  let streamRevision;
  let blockSeq;
  let startFrame;
  try {
    if (
      expectedCursor === null
      || typeof expectedCursor !== 'object'
      || Array.isArray(expectedCursor)
    ) {
      throw audioError('AUDIO_CURSOR_INVALID');
    }
    streamRevision = expectedCursor.streamRevision;
    blockSeq = expectedCursor.blockSeq;
    startFrame = expectedCursor.startFrame;
  } catch {
    throw audioError('AUDIO_CURSOR_INVALID');
  }

  if (
    !validU32(streamRevision)
    || !validU32(blockSeq)
    || typeof startFrame !== 'bigint'
    || startFrame < 0n
    || startFrame > U64_MAX
  ) {
    throw audioError('AUDIO_CURSOR_INVALID');
  }
  return { streamRevision, blockSeq, startFrame };
}

function validateMagic(view) {
  if (
    view.getUint8(0) !== 0x46
    || view.getUint8(1) !== 0x4c
    || view.getUint8(2) !== 0x4b
    || view.getUint8(3) !== 0x31
  ) {
    throw audioError('AUDIO_BAD_MAGIC');
  }
}

/**
 * 解析公共 Audio WS v1 的单个 FLK1 binary frame。
 *
 * expectedCursor 是 ready/discontinuity 指定的“下一块精确游标”，不是上一块游标。
 * 本函数只解析独立 frame，不推断缺块，也不拼接 payload。
 */
export function parseAudioFrameV1(bufferSource, expectedCursor) {
  const cursor = readExpectedCursor(expectedCursor);
  const source = normalizeBufferSource(bufferSource);
  const view = new DataView(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  );

  validateMagic(view);
  const headerVersion = view.getUint8(4);
  if (headerVersion !== 1) {
    throw audioError('AUDIO_VERSION_UNSUPPORTED');
  }
  const flags = view.getUint8(5);
  if (flags !== 0) {
    throw audioError('AUDIO_FLAGS_UNSUPPORTED');
  }
  const headerBytes = view.getUint16(6, true);
  if (headerBytes !== AUDIO_HEADER_BYTES) {
    throw audioError('AUDIO_HEADER_BYTES_INVALID');
  }

  const streamRevision = view.getUint32(8, true);
  const blockSeq = view.getUint32(12, true);
  const startFrame = view.getBigUint64(16, true);
  const frameCount = view.getUint32(24, true);
  const channels = view.getUint16(28, true);
  const format = view.getUint16(30, true);

  if (frameCount === 0) {
    throw audioError('AUDIO_FRAME_COUNT_INVALID');
  }
  if (channels !== AUDIO_CHANNELS) {
    throw audioError('AUDIO_CHANNELS_UNSUPPORTED');
  }
  if (format !== AUDIO_FORMAT_F32LE) {
    throw audioError('AUDIO_FORMAT_UNSUPPORTED');
  }

  const sampleCount = frameCount * channels;
  const totalBytes = headerBytes + sampleCount * Float32Array.BYTES_PER_ELEMENT;
  if (source.byteLength !== totalBytes) {
    throw audioError('AUDIO_LENGTH_MISMATCH');
  }
  if (startFrame + BigInt(frameCount) > U64_MAX) {
    throw audioError('AUDIO_CURSOR_OVERFLOW');
  }
  if (
    cursor.streamRevision !== streamRevision
    || cursor.blockSeq !== blockSeq
    || cursor.startFrame !== startFrame
  ) {
    throw audioError('AUDIO_DISCONTINUITY');
  }

  // 不能把源 buffer 的 Float32Array view 直接交给播放器：它可能 unaligned、被 transfer，
  // 或在下一次网络读取时复用。逐个 little-endian 读取到独立数组。
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getFloat32(
      headerBytes + index * Float32Array.BYTES_PER_ELEMENT,
      true,
    );
  }

  const header = Object.freeze({
    headerVersion,
    flags,
    headerBytes,
    streamRevision,
    blockSeq,
    startFrame,
    frameCount,
    channels,
    format,
  });
  return Object.freeze({ header, samples });
}
