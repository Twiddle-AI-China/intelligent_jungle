const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12);
const SCALE = [0, 2, 3, 5, 7, 9, 10];

export class PerceptualWebAudioEngine {
  constructor() {
    this.context = null;
    this.voices = [];
  }

  async start(objects) {
    if (this.context) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContext();
    const master = this.context.createGain();
    const compressor = this.context.createDynamicsCompressor();
    master.gain.value = 0.56 / Math.sqrt(objects.length);
    compressor.threshold.value = -18;
    compressor.knee.value = 16;
    compressor.ratio.value = 5;
    master.connect(compressor).connect(this.context.destination);

    this.voices = objects.map((object) => {
      const oscillator = this.context.createOscillator();
      const color = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      const panner = this.context.createStereoPanner();
      oscillator.type = object.id % 3 === 0 ? 'triangle' : 'sawtooth';
      color.type = 'lowpass';
      color.Q.value = 2.4;
      gain.gain.value = 0.001;
      oscillator.connect(color).connect(gain).connect(panner).connect(master);
      oscillator.start();
      return { oscillator, color, gain, panner };
    });
  }

  update(world) {
    if (!this.context) return;
    const now = this.context.currentTime;
    world.objects.forEach((object, index) => {
      const voice = this.voices[index];
      const register = Math.round(clamp(object.pitchRegister, -2, 2));
      const degree = Number.isFinite(object.pitchClass) ? object.pitchClass : SCALE[object.id % SCALE.length];
      const note = 43 + degree + register * 12;
      const cutoff = 260 * 2 ** (object.brightness * 4.7);
      const pulseEnvelope = 0.018 + object.pulse * object.energy * 0.14;
      voice.oscillator.frequency.setTargetAtTime(midiToHz(note), now, 0.045);
      voice.color.frequency.setTargetAtTime(cutoff, now, 0.07);
      voice.color.Q.setTargetAtTime(1.2 + object.energy * 7, now, 0.08);
      voice.gain.gain.setTargetAtTime(pulseEnvelope, now, object.pulse > 0.75 ? 0.008 : 0.12);
      const pan = object.pan < 0 || object.pan > 1 ? object.pan : object.pan * 2 - 1;
      voice.panner.pan.setTargetAtTime(clamp(pan, -1, 1), now, 0.08);
    });
  }

  async toggle() {
    if (!this.context) return false;
    if (this.context.state === 'running') await this.context.suspend();
    else await this.context.resume();
    return this.context.state === 'running';
  }

  get running() {
    return this.context?.state === 'running';
  }
}

// Contract for the next stage. A decoder implementation must accept stable,
// interpretable control frames; raw latent vectors must remain behind the adapter.
export class DecoderAdapter {
  async initialize() { throw new Error('DecoderAdapter is not implemented yet'); }
  renderControlFrame(_objects, _time) { throw new Error('DecoderAdapter is not implemented yet'); }
  async dispose() {}
}
