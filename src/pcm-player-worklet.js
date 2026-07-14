class PcmRingPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = Math.max(16384, Math.round(sampleRate * 1.5));
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.primed = false;
    this.underruns = 0;
    this.blocks = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'reset') {
        this.read = 0; this.write = 0; this.available = 0; this.primed = false;
        return;
      }
      if (!(data instanceof ArrayBuffer)) return;
      const pcm = new Float32Array(data);
      for (let index = 0; index + 1 < pcm.length; index += 2) {
        if (this.available >= this.capacity) {
          this.read = (this.read + 1) % this.capacity;
          this.available -= 1;
        }
        this.left[this.write] = pcm[index];
        this.right[this.write] = pcm[index + 1];
        this.write = (this.write + 1) % this.capacity;
        this.available += 1;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    if (!this.primed && this.available >= 4096) this.primed = true;
    for (let index = 0; index < left.length; index += 1) {
      if (this.primed && this.available > 0) {
        left[index] = this.left[this.read];
        right[index] = this.right[this.read];
        this.read = (this.read + 1) % this.capacity;
        this.available -= 1;
      } else {
        left[index] = 0;
        right[index] = 0;
        if (this.primed) this.underruns += 1;
      }
    }
    this.blocks += 1;
    if (this.blocks % 32 === 0) {
      this.port.postMessage({ type: 'stats', bufferedFrames: this.available, underruns: this.underruns });
    }
    return true;
  }
}

registerProcessor('pcm-ring-player', PcmRingPlayer);
