// Browser recording boundary for the MVP audio graph. No UI or audio-engine state lives here.

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

function preferredMimeType(MediaRecorderClass) {
  if (typeof MediaRecorderClass.isTypeSupported !== 'function') return '';
  return MIME_CANDIDATES.find((type) => MediaRecorderClass.isTypeSupported(type)) ?? '';
}

/**
 * Attach a recorder tap to an audio graph.
 *
 * Integration: pass the live AudioContext and the audio engine's final GainNode as
 * `sourceNode`. The tap is additive: `sourceNode.connect(destination)` does not replace
 * the existing speaker connection. Returns null when browser recording is unavailable.
 * A repeated `start()` while already recording is idempotent and returns false.
 */
export function createRecorder({ audioContext, sourceNode } = {}) {
  const MediaRecorderClass = globalThis.MediaRecorder;
  if (typeof MediaRecorderClass !== 'function') return null;
  if (typeof audioContext?.createMediaStreamDestination !== 'function') return null;
  if (typeof sourceNode?.connect !== 'function') return null;

  let destination;
  let mediaRecorder;
  try {
    destination = audioContext.createMediaStreamDestination();
    if (!destination?.stream) return null;
    sourceNode.connect(destination);
    const mimeType = preferredMimeType(MediaRecorderClass);
    mediaRecorder = mimeType
      ? new MediaRecorderClass(destination.stream, { mimeType })
      : new MediaRecorderClass(destination.stream);
  } catch {
    try { if (destination) sourceNode.disconnect?.(destination); } catch { /* best effort */ }
    return null;
  }

  let chunks = [];
  let recording = false;
  let disposed = false;
  let pendingStop = null;

  mediaRecorder.ondataavailable = (event) => {
    if (event?.data && event.data.size > 0) chunks.push(event.data);
  };

  mediaRecorder.onstop = () => {
    recording = false;
    if (!pendingStop) return;
    const { resolve } = pendingStop;
    pendingStop = null;
    resolve(new Blob(chunks, { type: mediaRecorder.mimeType || preferredMimeType(MediaRecorderClass) }));
  };

  mediaRecorder.onerror = (event) => {
    recording = false;
    if (!pendingStop) return;
    const { reject } = pendingStop;
    pendingStop = null;
    reject(event?.error ?? new Error('MediaRecorder failed'));
  };

  function start() {
    if (disposed) throw new Error('Recorder has been disposed');
    if (recording) return false;
    if (pendingStop) throw new Error('Recorder is still stopping');
    chunks = [];
    try {
      mediaRecorder.start();
      recording = true;
      return true;
    } catch (error) {
      recording = false;
      throw error;
    }
  }

  function stop() {
    if (pendingStop) return pendingStop.promise;
    if (!recording) return Promise.reject(new Error('Recorder is not recording'));

    let resolveStop;
    let rejectStop;
    const promise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    pendingStop = { promise, resolve: resolveStop, reject: rejectStop };
    recording = false;
    try {
      mediaRecorder.stop();
    } catch (error) {
      pendingStop = null;
      rejectStop(error);
    }
    return promise;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (recording) {
      recording = false;
      try { mediaRecorder.stop(); } catch { /* best effort */ }
    }
    try { sourceNode.disconnect?.(destination); } catch { /* already disconnected */ }
    try {
      for (const track of destination.stream.getTracks?.() ?? []) track.stop?.();
    } catch { /* best effort */ }
  }

  return Object.freeze({
    start,
    stop,
    isRecording: () => recording,
    dispose,
  });
}

/** Download a recorded Blob in browsers; intentionally does nothing without a DOM. */
export function downloadBlob(blob, filename = 'recording.webm') {
  const documentObject = globalThis.document;
  const urlApi = globalThis.URL;
  if (!blob || typeof documentObject?.createElement !== 'function') return false;
  if (typeof urlApi?.createObjectURL !== 'function' || typeof urlApi?.revokeObjectURL !== 'function') return false;

  const url = urlApi.createObjectURL(blob);
  try {
    const anchor = documentObject.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    documentObject.body?.append?.(anchor);
    anchor.click();
    anchor.remove?.();
    return true;
  } finally {
    urlApi.revokeObjectURL(url);
  }
}
