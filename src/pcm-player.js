export async function createPcmPlayer(context) {
  if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    await context.audioWorklet.addModule('./src/pcm-player-worklet.js');
    return new AudioWorkletNode(context, 'pcm-ring-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
  }

  if (!context.createScriptProcessor) {
    throw new Error('当前页面需要 HTTPS 才能启用实时音频');
  }

  const capacity = Math.max(16384, Math.round(context.sampleRate * 1.5));
  const left = new Float32Array(capacity);
  const right = new Float32Array(capacity);
  let read = 0;
  let write = 0;
  let available = 0;
  let primed = false;
  let underruns = 0;
  let blocks = 0;
  const node = context.createScriptProcessor(2048, 0, 2);

  node.port = {
    onmessage: null,
    postMessage(data) {
      if (data?.type === 'reset') {
        read = 0;
        write = 0;
        available = 0;
        primed = false;
        return;
      }
      if (!(data instanceof ArrayBuffer)) return;
      const pcm = new Float32Array(data);
      for (let index = 0; index + 1 < pcm.length; index += 2) {
        if (available >= capacity) {
          read = (read + 1) % capacity;
          available -= 1;
        }
        left[write] = pcm[index];
        right[write] = pcm[index + 1];
        write = (write + 1) % capacity;
        available += 1;
      }
    },
  };

  node.onaudioprocess = ({ outputBuffer }) => {
    const outputLeft = outputBuffer.getChannelData(0);
    const outputRight = outputBuffer.getChannelData(1);
    if (!primed && available >= 4096) primed = true;
    for (let index = 0; index < outputLeft.length; index += 1) {
      if (primed && available > 0) {
        outputLeft[index] = left[read];
        outputRight[index] = right[read];
        read = (read + 1) % capacity;
        available -= 1;
      } else {
        outputLeft[index] = 0;
        outputRight[index] = 0;
        if (primed) underruns += 1;
      }
    }
    blocks += 1;
    if (blocks % 2 === 0) {
      node.port.onmessage?.({ data: { type: 'stats', bufferedFrames: available, underruns } });
    }
  };

  return node;
}
