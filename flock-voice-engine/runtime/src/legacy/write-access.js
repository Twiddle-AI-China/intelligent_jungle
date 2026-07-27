export function createLegacyWriteAccess() {
  let decoderSessionId = null;
  let suspended = false;
  return Object.freeze({
    rejectWrites() { decoderSessionId = null; suspended = false; },
    suspendWrites() { suspended = true; },
    resumeExactGeneration(value) {
      if (decoderSessionId !== value) return false;
      suspended = false;
      return true;
    },
    allowExactGeneration(value) { decoderSessionId = value; suspended = false; },
    isAllowed(value) { return !suspended && decoderSessionId !== null && value === decoderSessionId; },
    getStatus: () => Object.freeze({ decoderSessionId, suspended }),
  });
}
