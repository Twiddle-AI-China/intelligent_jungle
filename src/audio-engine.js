const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12);
const SCALE = [0, 2, 3, 5, 7, 9, 10];

export class PerceptualWebAudioEngine {
  constructor() {
    this.context = null;
    this.voices = [];
    this.mode = 'offline';
    this.modelSha = null;
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

    try {
      const response = await fetch('./mvp-assets/manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`texture manifest ${response.status}`);
      const manifest = await response.json();
      if (!manifest.automated_render_safety_passed || manifest.files.length < objects.length * 2) throw new Error('texture bank is incomplete or unsafe');
      const buffers = await Promise.all(manifest.files.map(async (file) => {
        const audioResponse = await fetch(`./mvp-assets/${file}`);
        if (!audioResponse.ok) throw new Error(`texture ${file} ${audioResponse.status}`);
        return this.context.decodeAudioData(await audioResponse.arrayBuffer());
      }));
      this.modelSha = manifest.model_sha256;
      this.mode = 'brave-textures';
      const bufferByName = new Map(manifest.files.map((file, index) => [file, buffers[index]]));
      this.voices = objects.map((object, index) => {
        const pair = manifest.voices?.[index];
        const low = pair ? bufferByName.get(pair.low) : buffers[(index * 2) % buffers.length];
        const high = pair ? bufferByName.get(pair.high) : buffers[(index * 2 + 1) % buffers.length];
        if (!low || !high) throw new Error(`texture pair ${index} is incomplete`);
        return this.createTextureVoice(object, index, low, high, master);
      });
      return;
    } catch {
      this.mode = 'oscillator-fallback';
    }

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
      return { kind: 'oscillator', oscillator, color, gain, panner };
    });
  }

  createTextureVoice(object, index, lowBuffer, highBuffer, master) {
    const sourceA = this.context.createBufferSource();
    const sourceB = this.context.createBufferSource();
    const blendA = this.context.createGain();
    const blendB = this.context.createGain();
    const color = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const panner = this.context.createStereoPanner();
    sourceA.buffer = lowBuffer;
    sourceB.buffer = highBuffer;
    sourceA.loop = true;
    sourceB.loop = true;
    sourceA.connect(blendA).connect(color);
    sourceB.connect(blendB).connect(color);
    color.connect(gain).connect(panner).connect(master);
    blendA.gain.value = 1 - object.brightness;
    blendB.gain.value = object.brightness;
    gain.gain.value = 0.001;
    color.type = 'lowpass';
    color.Q.value = 1.2;
    const offset = (index * 0.731) % Math.max(0.01, Math.min(sourceA.buffer.duration, sourceB.buffer.duration) - 0.01);
    sourceA.start(0, offset);
    sourceB.start(0, offset);
    return { kind: 'texture', sourceA, sourceB, blendA, blendB, color, gain, panner };
  }

  update(world) {
    if (!this.context) return;
    const now = this.context.currentTime;
    world.objects.forEach((object, index) => {
      const voice = this.voices[index];
      if (!voice) return;
      const register = Math.round(clamp(object.pitchRegister, -2, 2));
      const degree = Number.isFinite(object.pitchClass) ? object.pitchClass : SCALE[object.id % SCALE.length];
      const note = 43 + degree + register * 12;
      const cutoff = 260 * 2 ** (object.brightness * 4.7);
      const pulseEnvelope = 0.018 + object.pulse * object.energy * 0.14;
      if (voice.kind === 'oscillator') voice.oscillator.frequency.setTargetAtTime(midiToHz(note), now, 0.045);
      else {
        const blend = clamp(object.brightness);
        voice.blendA.gain.setTargetAtTime(1 - blend, now, 0.12);
        voice.blendB.gain.setTargetAtTime(blend, now, 0.12);
        const rate = 2 ** (clamp(object.perceptualVelocity[0] * 8, -0.12, 0.12));
        voice.sourceA.playbackRate.setTargetAtTime(rate, now, 0.12);
        voice.sourceB.playbackRate.setTargetAtTime(rate, now, 0.12);
      }
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

  get label() {
    if (this.mode === 'brave-textures') return `BRAVE 神经声音 · ${this.modelSha?.slice(0, 8)}`;
    if (this.mode === 'oscillator-fallback') return 'Web Audio 替身声源';
    return '声音离线';
  }
}

// Contract for the next stage. A decoder implementation must accept stable,
// interpretable control frames; raw latent vectors must remain behind the adapter.
export class DecoderAdapter {
  async initialize() { throw new Error('DecoderAdapter is not implemented yet'); }
  renderControlFrame(_objects, _time) { throw new Error('DecoderAdapter is not implemented yet'); }
  async dispose() {}
}
