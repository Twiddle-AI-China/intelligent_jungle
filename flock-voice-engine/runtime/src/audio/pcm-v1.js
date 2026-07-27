const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;

function validU32(value) {
  return Number.isInteger(value) && value >= 0 && value <= U32_MAX && !Object.is(value, -0);
}
export function encodeAudioFrameV1(header, samples) {
  if (!header || !validU32(header.streamRevision) || !validU32(header.blockSeq)
      || typeof header.startFrame !== 'bigint' || header.startFrame < 0n
      || header.startFrame > U64_MAX || !validU32(header.frameCount) || header.frameCount === 0
      || header.channels !== 2 || header.format !== 1) throw new Error('AUDIO_HEADER_INVALID');
  const payload = Buffer.isBuffer(samples) ? samples : null;
  const sampleCount = header.frameCount * 2;
  if ((payload && payload.length !== sampleCount * 4)
      || (!payload && (!(samples instanceof Float32Array) || samples.length !== sampleCount))) {
    throw new Error('AUDIO_LENGTH_MISMATCH');
  }
  if (header.startFrame + BigInt(header.frameCount) > U64_MAX) {
    throw new Error('AUDIO_CURSOR_OVERFLOW');
  }
  const out = Buffer.allocUnsafe(32 + sampleCount * 4);
  out.write('FLK1', 0, 'ascii');
  out.writeUInt8(1, 4); out.writeUInt8(0, 5); out.writeUInt16LE(32, 6);
  out.writeUInt32LE(header.streamRevision, 8); out.writeUInt32LE(header.blockSeq, 12);
  out.writeBigUInt64LE(header.startFrame, 16); out.writeUInt32LE(header.frameCount, 24);
  out.writeUInt16LE(2, 28); out.writeUInt16LE(1, 30);
  if (payload) payload.copy(out, 32);
  else for (let index = 0; index < samples.length; index += 1) out.writeFloatLE(samples[index], 32 + index * 4);
  return out;
}
