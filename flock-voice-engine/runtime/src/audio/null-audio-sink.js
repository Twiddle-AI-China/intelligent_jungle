export function createNullAudioSink() {
  let acceptedCommandCount = 0;
  return Object.freeze({
    accept(commands) {
      acceptedCommandCount += Array.isArray(commands) ? commands.length : 0;
    },
    getStatus() {
      return Object.freeze({
        mode: 'null',
        acceptedCommandCount,
        pcmFrameCount: 0,
      });
    },
  });
}
