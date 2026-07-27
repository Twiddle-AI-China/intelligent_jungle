class FlockPcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
    this.offset = 0;
    this.bufferedFrames = 0;
    this.primeFrames = 0;
    this.maxBufferedFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'reset') {
        this.blocks = []; this.offset = 0; this.bufferedFrames = 0;
      } else if (data?.type === 'configure') {
        this.primeFrames = data.primeFrames;
        this.maxBufferedFrames = data.maxBufferedFrames;
      } else if (data?.type === 'pcm' && data.samples instanceof Float32Array) {
        const frames = data.samples.length / 2;
        if (!Number.isSafeInteger(frames) || frames <= 0 || this.maxBufferedFrames <= 0
            || this.bufferedFrames + frames > this.maxBufferedFrames) {
          this.blocks = []; this.offset = 0; this.bufferedFrames = 0;
          this.port.postMessage({ type: 'overflow' });
        } else {
          this.blocks.push(data.samples); this.bufferedFrames += frames;
        }
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0]; const right = output[1];
    left.fill(0); right.fill(0);
    if (this.bufferedFrames < this.primeFrames) return true;
    for (let frame = 0; frame < left.length && this.blocks.length > 0; frame += 1) {
      const block = this.blocks[0];
      left[frame] = block[this.offset]; right[frame] = block[this.offset + 1];
      this.offset += 2; this.bufferedFrames -= 1;
      if (this.offset >= block.length) { this.blocks.shift(); this.offset = 0; }
    }
    return true;
  }
}

registerProcessor('flock-pcm-player', FlockPcmPlayerProcessor);
