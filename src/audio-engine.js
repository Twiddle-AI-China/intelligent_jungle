const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const endpointTargetRms = 0.1;

function measureBufferRms(buffer) {
  let sum = 0;
  let count = 0;
  const stride = 8;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index += stride) {
      sum += samples[index] * samples[index];
      count += 1;
    }
  }
  return Math.sqrt(sum / Math.max(1, count));
}

function endpointTrim(rms) {
  return clamp(endpointTargetRms / Math.max(rms, 1e-4), 0.4, 3);
}

export class PerceptualWebAudioEngine {
  constructor() {
    this.context = null;
    this.voices = [];
    this.mode = 'offline';
    this.modelSha = null;
    this.master = null;
    this.texturePairs = [];
    this.loadError = null;
  }

  async start(objects) {
    if (this.context) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContext();
    const master = this.context.createGain();
    const compressor = this.context.createDynamicsCompressor();
    master.gain.value = 0.56 / Math.sqrt(objects.length);
    this.master = master;
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
      this.texturePairs = (manifest.voices ?? []).map((pair) => ({ low: bufferByName.get(pair.low), high: bufferByName.get(pair.high) }));
      this.voices = objects.map((object, index) => {
        const pair = this.texturePairs[index];
        const low = pair?.low ?? buffers[(index * 2) % buffers.length];
        const high = pair?.high ?? buffers[(index * 2 + 1) % buffers.length];
        if (!low || !high) throw new Error(`texture pair ${index} is incomplete`);
        return this.createTextureVoice(object, index, low, high, master);
      });
      return;
    } catch (error) {
      this.mode = 'audio-error';
      this.loadError = error instanceof Error ? error.message : String(error);
      this.voices = [];
    }
  }

  createTextureVoice(object, index, lowBuffer, highBuffer, master) {
    const sourceA = this.context.createBufferSource();
    const sourceB = this.context.createBufferSource();
    const blendA = this.context.createGain();
    const blendB = this.context.createGain();
    const color = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const panner = this.context.createStereoPanner();
    const analyser = this.context.createAnalyser();
    const mixGain = this.context.createGain();
    const lowRms = measureBufferRms(lowBuffer);
    const highRms = measureBufferRms(highBuffer);
    const lowTrim = endpointTrim(lowRms);
    const highTrim = endpointTrim(highRms);
    sourceA.buffer = lowBuffer;
    sourceB.buffer = highBuffer;
    sourceA.loop = true;
    sourceB.loop = true;
    sourceA.connect(blendA).connect(color);
    sourceB.connect(blendB).connect(color);
    color.connect(gain).connect(panner).connect(mixGain).connect(analyser).connect(master);
    blendA.gain.value = Math.cos(object.brightness * Math.PI * 0.5) * lowTrim;
    blendB.gain.value = Math.sin(object.brightness * Math.PI * 0.5) * highTrim;
    gain.gain.value = 0.001;
    color.type = 'lowpass';
    color.Q.value = 1.2;
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.65;
    const offset = (index * 0.731) % Math.max(0.01, Math.min(sourceA.buffer.duration, sourceB.buffer.duration) - 0.01);
    sourceA.start(0, offset);
    sourceB.start(0, offset);
    return {
      kind: 'texture', objectId: object.id, sourceA, sourceB, blendA, blendB,
      color, gain, panner, analyser, mixGain, lowRms, highRms, lowTrim, highTrim,
      muted: false, solo: false, samples: new Float32Array(analyser.fftSize),
    };
  }

  update(world) {
    if (!this.context) return;
    this.master.gain.setTargetAtTime(0.56 / Math.sqrt(Math.max(1, world.objects.length)), this.context.currentTime, 0.08);
    while (this.mode === 'brave-textures' && this.voices.length < world.objects.length && this.voices.length < 6) {
      const index = this.voices.length;
      const object = world.objects[index];
      const pair = this.texturePairs[index];
      if (!pair?.low || !pair?.high) break;
      this.voices.push(this.createTextureVoice(object, index, pair.low, pair.high, this.master));
    }
    const now = this.context.currentTime;
    world.objects.forEach((object, index) => {
      const voice = this.voices[index];
      if (!voice) return;
      const cutoff = 260 * 2 ** (object.brightness * 4.7);
      const pulseEnvelope = 0.018 + object.pulse * object.energy * 0.14;
      const blend = clamp(object.brightness);
      voice.blendA.gain.setTargetAtTime(Math.cos(blend * Math.PI * 0.5) * voice.lowTrim, now, 0.12);
      voice.blendB.gain.setTargetAtTime(Math.sin(blend * Math.PI * 0.5) * voice.highTrim, now, 0.12);
      const rate = 2 ** (clamp(object.perceptualVelocity[0] * 8, -0.12, 0.12));
      voice.sourceA.playbackRate.setTargetAtTime(rate, now, 0.12);
      voice.sourceB.playbackRate.setTargetAtTime(rate, now, 0.12);
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
    if (this.mode === 'brave-textures') return `BRAVE 离线纹理播放器 · 非实时 · ${this.modelSha?.slice(0, 8)}`;
    if (this.mode === 'audio-error') return `声音素材加载失败 · 已静音${this.loadError ? ` · ${this.loadError}` : ''}`;
    return '声音离线';
  }

  setVoiceMuted(index, muted) {
    const voice = this.voices[index];
    if (!voice) return false;
    voice.muted = Boolean(muted);
    this.refreshVoiceMix();
    return voice.muted;
  }

  setVoiceSolo(index, solo) {
    const voice = this.voices[index];
    if (!voice) return false;
    voice.solo = Boolean(solo);
    this.refreshVoiceMix();
    return voice.solo;
  }

  refreshVoiceMix() {
    if (!this.context) return;
    const anySolo = this.voices.some((voice) => voice.solo);
    for (const voice of this.voices) {
      const audible = !voice.muted && (!anySolo || voice.solo);
      voice.mixGain.gain.setTargetAtTime(audible ? 1 : 0, this.context.currentTime, 0.015);
    }
  }

  getVoiceDiagnostics() {
    return this.voices.map((voice, index) => {
      voice.analyser.getFloatTimeDomainData(voice.samples);
      let sum = 0;
      let peak = 0;
      for (const sample of voice.samples) {
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      const signalRms = Math.sqrt(sum / voice.samples.length);
      const effectiveGain = voice.mixGain.gain.value;
      const rms = signalRms * effectiveGain;
      return {
        index,
        objectId: voice.objectId,
        rms,
        db: rms > 1e-7 ? 20 * Math.log10(rms) : -140,
        peak: peak * effectiveGain,
        muted: voice.muted,
        solo: voice.solo,
        lowSourceRms: voice.lowRms,
        highSourceRms: voice.highRms,
      };
    });
  }

  get facts() {
    return {
      mode: this.mode,
      liveDecoder: false,
      xyLatentProjection: false,
      modelSha: this.modelSha,
      loadError: this.loadError,
      activeVoices: this.voices.length,
    };
  }
}

// Contract for the next stage. A decoder implementation must accept stable,
// interpretable control frames; raw latent vectors must remain behind the adapter.
export class DecoderAdapter {
  async initialize() { throw new Error('DecoderAdapter is not implemented yet'); }
  renderControlFrame(_objects, _time) { throw new Error('DecoderAdapter is not implemented yet'); }
  async dispose() {}
}
