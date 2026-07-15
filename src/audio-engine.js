export const DEFAULT_EFFECT_CONFIG = Object.freeze({ delayMix: 0.12, reverbMix: 0.14 });
export const DEFAULT_FEATURE_CONFIG = Object.freeze({ pitchShift: true, delay: true, reverb: true });

export class XYLatentAudioEngine {
  constructor() {
    this.context = null;
    this.node = null;
    this.socket = null;
    this.mode = 'offline';
    this.modelSha = null;
    this.loadError = null;
    this.telemetry = {};
    this.workletStats = { bufferedFrames: 0, underruns: 0 };
    this.lastControlSent = 0;
    this.modelId = 'fsl10k-16d';
    this.models = [];
    this.latentSize = 0;
    this.samplesPerFrame = 0;
    this.effects = { ...DEFAULT_EFFECT_CONFIG };
    this.features = { ...DEFAULT_FEATURE_CONFIG };
    this.effectNodes = null;
  }

  async discoverModels() {
    const response = await fetch('/api/decoder-status');
    if (!response.ok) throw new Error(`decoder status ${response.status}`);
    const status = await response.json();
    this.models = status.models ?? [];
    this.modelId = status.defaultModel ?? this.modelId;
    return this.models;
  }

  async start(engine) {
    if (this.context) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('当前浏览器不提供 Web Audio AudioContext');
      this.context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
      this.mode = 'connecting';
      if (!this.models.length) await this.discoverModels();
      await this.context.audioWorklet.addModule('./src/pcm-player-worklet.js');
      this.node = new AudioWorkletNode(this.context, 'pcm-ring-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -10;
      compressor.knee.value = 12;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.12;
      const dry = this.context.createGain();
      const delay = this.context.createDelay(1); const delayWet = this.context.createGain(); const feedback = this.context.createGain();
      const reverb = this.context.createConvolver(); const reverbWet = this.context.createGain();
      delay.delayTime.value = 0.31; feedback.gain.value = 0.28;
      reverb.buffer = this.createReverbImpulse(0.85, 2.8);
      this.node.connect(dry).connect(compressor);
      this.node.connect(delay); delay.connect(feedback).connect(delay); delay.connect(delayWet).connect(compressor);
      this.node.connect(reverb).connect(reverbWet).connect(compressor);
      compressor.connect(this.context.destination);
      this.effectNodes = { dry, delayWet, reverbWet };
      this.applyEffects();
      this.node.port.onmessage = ({ data }) => {
        if (data?.type !== 'stats') return;
        this.workletStats = data;
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'buffer', bufferedFrames: data.bufferedFrames, underruns: data.underruns }));
      };
      await this.connectDecoder();
      if (this.context.state !== 'running') await this.context.resume();
      this.update(engine, true);
    } catch (error) {
      this.mode = 'audio-error';
      this.loadError = error instanceof Error ? error.message : String(error);
      this.socket?.close();
      this.node?.disconnect();
    }
  }

  createReverbImpulse(seconds, decay) {
    const length = Math.round(this.context.sampleRate * seconds);
    const buffer = this.context.createBuffer(2, length, this.context.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      let noise = channel ? 0x9e3779b9 : 0x243f6a88;
      for (let index = 0; index < length; index += 1) {
        noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
        data[index] = (noise / 4294967296 * 2 - 1) * ((1 - index / length) ** decay);
      }
    }
    return buffer;
  }

  setEffectControl(key, value) {
    if (!(key in DEFAULT_EFFECT_CONFIG)) return false;
    this.effects[key] = Math.max(0, Math.min(0.6, Number(value)));
    this.applyEffects();
    return this.effects[key];
  }

  setFeatureToggle(key, enabled) {
    if (!(key in DEFAULT_FEATURE_CONFIG)) return false;
    this.features[key] = Boolean(enabled);
    this.applyEffects();
    return this.features[key];
  }

  applyEffects() {
    if (!this.effectNodes) return;
    const now = this.context.currentTime;
    this.effectNodes.delayWet.gain.setTargetAtTime(this.features.delay ? this.effects.delayMix : 0, now, 0.02);
    this.effectNodes.reverbWet.gain.setTargetAtTime(this.features.reverb ? this.effects.reverbMix : 0, now, 0.02);
  }

  connectDecoder() {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/decoder?model=${encodeURIComponent(this.modelId)}`);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const timeout = window.setTimeout(() => reject(new Error('neural decoder connection timed out')), 15000);
      socket.onerror = () => { window.clearTimeout(timeout); reject(new Error('neural decoder WebSocket failed')); };
      socket.onclose = () => {
        if (this.socket === socket && this.mode === 'neural-realtime') { this.mode = 'audio-error'; this.loadError = 'neural decoder connection closed'; }
      };
      socket.onmessage = ({ data }) => {
        if (data instanceof ArrayBuffer) { this.node?.port.postMessage(data, [data]); return; }
        const message = JSON.parse(data);
        if (message.type === 'ready') {
          window.clearTimeout(timeout);
          this.modelSha = message.modelSha256;
          this.modelId = message.modelId;
          this.latentSize = message.latentSize;
          this.samplesPerFrame = message.samplesPerFrame;
          this.mode = 'neural-realtime';
          resolve();
        } else if (message.type === 'telemetry') {
          this.telemetry = message.voices?.[0] ?? {};
        } else if (message.type === 'error') this.loadError = message.message;
      };
    });
  }

  update(engine, force = false) {
    if (this.mode !== 'neural-realtime' || this.socket?.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (!force && now - this.lastControlSent < 16) return;
    this.lastControlSent = now;
    this.socket.send(JSON.stringify({
      type: 'control',
      voices: [{
        objectId: 0,
        decoderId: this.modelId,
        relationState: engine.relationState ?? Array(8).fill(0),
        gate: true,
        gateSerial: engine.gateSerial,
        velocity: engine.velocity,
        pitchSemitones: this.features.pitchShift ? engine.pitchSemitones : 0,
        notes: this.features.pitchShift ? Array.from(engine.heldNotes.entries()).slice(-3).map(([id, note], index) => ({ id: index === 0 ? 'voice' : id, pitchSemitones: Math.max(-12, Math.min(12, note.note - 60)), velocity: note.velocity })) : [],
        ...engine.config,
      }],
    }));
  }

  async toggle() {
    if (!this.context || this.mode === 'audio-error') return false;
    if (this.context.state === 'running') await this.context.suspend(); else await this.context.resume();
    return this.context.state === 'running';
  }

  get running() { return this.context?.state === 'running' && this.mode === 'neural-realtime'; }
  get label() {
    if (this.mode === 'neural-realtime') return `${this.modelId} · flock 8D→real-latent atlas · ${this.modelSha?.slice(0, 8)}`;
    if (this.mode === 'connecting') return `正在连接 ${this.modelId}`;
    if (this.mode === 'audio-error') return `神经 decoder 失败 · 已静音${this.loadError ? ` · ${this.loadError}` : ''}`;
    return '声音离线';
  }
  get facts() {
    return {
      mode: this.mode,
      liveDecoder: this.mode === 'neural-realtime',
      mapping: 'flock-relations-to-real-corpus-atlas',
      latentControlDimensions: this.latentSize,
      modelId: this.modelId,
      samplesPerFrame: this.samplesPerFrame,
      pitchControl: this.features.pitchShift ? 'post-decoder-keyboard-semitones' : 'post-decoder-pitch-bypassed',
      gateControl: 'eternal-drone-with-midi-or-computer-keyboard-pitch',
      activeVoices: 1,
      bufferedFrames: this.workletStats.bufferedFrames,
      underruns: this.workletStats.underruns,
    };
  }
}

// Compatibility name for small external probes; behavior is the new XY engine.
export const PerceptualWebAudioEngine = XYLatentAudioEngine;
