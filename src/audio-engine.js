const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export class PerceptualWebAudioEngine {
  constructor() {
    this.context = null;
    this.node = null;
    this.socket = null;
    this.mode = 'offline';
    this.modelSha = null;
    this.loadError = null;
    this.voiceStates = [];
    this.telemetry = [];
    this.workletStats = { bufferedFrames: 0, underruns: 0 };
    this.lastWorld = null;
    this.lastControlSent = 0;
    this.renderMs = 0;
    this.modelId = 'ensemble';
    this.models = [];
    this.latentSize = 0;
    this.samplesPerFrame = 0;
  }

  async discoverModels() {
    const response = await fetch('/api/decoder-status');
    if (!response.ok) throw new Error(`decoder status ${response.status}`);
    const status = await response.json();
    this.models = status.models ?? [];
    return this.models;
  }

  async start(objects) {
    if (this.context) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('当前浏览器不提供 Web Audio AudioContext');
      this.context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
      this.mode = 'connecting';
      if (!this.models.length) await this.discoverModels();
      this.ensureVoiceStates(objects.length);
      await this.context.audioWorklet.addModule('./src/pcm-player-worklet.js');
      this.node = new AudioWorkletNode(this.context, 'pcm-ring-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -10;
      compressor.knee.value = 12;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.12;
      this.node.connect(compressor).connect(this.context.destination);
      this.node.port.onmessage = ({ data }) => {
        if (data?.type === 'stats') {
          this.workletStats = data;
          if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({
              type: 'buffer',
              bufferedFrames: data.bufferedFrames,
              underruns: data.underruns,
            }));
          }
        }
      };
      await this.connectDecoder();
      if (this.context.state !== 'running') await this.context.resume();
    } catch (error) {
      this.mode = 'audio-error';
      this.loadError = error instanceof Error ? error.message : String(error);
      this.socket?.close();
      this.node?.disconnect();
    }
  }

  connectDecoder() {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/decoder?model=ensemble`);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const timeout = window.setTimeout(() => reject(new Error('neural decoder connection timed out')), 15000);
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('neural decoder WebSocket failed'));
      };
      socket.onclose = () => {
        if (this.socket === socket && this.mode === 'neural-realtime') {
          this.mode = 'audio-error';
          this.loadError = 'neural decoder connection closed';
        }
      };
      socket.onmessage = ({ data }) => {
        if (data instanceof ArrayBuffer) {
          this.node?.port.postMessage(data, [data]);
          return;
        }
        const message = JSON.parse(data);
        if (message.type === 'ready') {
          window.clearTimeout(timeout);
          this.modelSha = message.modelSha256;
          this.modelId = message.modelId;
          this.latentSize = message.latentSize;
          this.samplesPerFrame = message.samplesPerFrame;
          if (message.models?.length) this.models = message.models;
          this.mode = 'neural-realtime';
          resolve();
        } else if (message.type === 'telemetry') {
          this.telemetry = message.voices ?? [];
          this.renderMs = message.renderMs ?? 0;
        } else if (message.type === 'error') {
          this.loadError = message.message;
        }
      };
    });
  }

  ensureVoiceStates(count) {
    while (this.voiceStates.length < count) {
      const index = this.voiceStates.length;
      this.voiceStates.push({ muted: false, solo: false, decoderId: this.models[index % Math.max(1, this.models.length)]?.id ?? 'brave-16d' });
    }
  }

  assignDefaultDecoders(world) {
    this.lastWorld = world;
    this.ensureVoiceStates(world.objects.length);
    if (this.models.length) this.voiceStates.forEach((state, index) => { state.decoderId = this.models[index % this.models.length].id; });
  }

  update(world) {
    this.lastWorld = world;
    this.ensureVoiceStates(world.objects.length);
    if (this.mode !== 'neural-realtime' || this.socket?.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - this.lastControlSent < 30) return;
    this.lastControlSent = now;
    const anySolo = this.voiceStates.some((state) => state.solo);
    this.socket.send(JSON.stringify({
      type: 'control',
      time: world.time,
      harmonicCenter: world.harmonicCenter,
      voices: world.objects.slice(0, 6).map((voice, index) => ({
        objectId: voice.id,
        species: voice.speciesId,
        decoderId: this.voiceStates[index]?.decoderId ?? this.models[index % Math.max(1, this.models.length)]?.id ?? 'brave-16d',
        relationState: voice.relationState.slice(0, 8),
        latentStep: world.config.latentStep,
        noteGroups: voice.noteGroups.map((group) => ({
          id: group.id,
          pitchSemitones: group.pitchSemitones,
          durationSeconds: group.durationSeconds,
          strength: group.strength,
          x: group.x,
          triggerSerial: group.triggerSerial,
          triggerStrength: group.triggerStrength,
        })),
        pitchSemitones: voice.pitchSemitones,
        triggerSerial: voice.triggerSerial,
        triggerStrength: voice.triggerStrength,
        pan: clamp(voice.pan, -1, 1),
        energy: clamp(voice.energy),
        muted: this.voiceStates[index]?.muted ?? false,
        solo: anySolo && (this.voiceStates[index]?.solo ?? false),
      })),
    }));
  }

  async toggle() {
    if (!this.context || this.mode === 'audio-error') return false;
    if (this.context.state === 'running') await this.context.suspend();
    else await this.context.resume();
    return this.context.state === 'running';
  }

  setVoiceMuted(index, muted) {
    this.ensureVoiceStates(index + 1);
    this.voiceStates[index].muted = Boolean(muted);
    this.lastControlSent = 0;
    if (this.lastWorld) this.update(this.lastWorld);
    return this.voiceStates[index].muted;
  }

  setVoiceSolo(index, solo) {
    this.ensureVoiceStates(index + 1);
    this.voiceStates[index].solo = Boolean(solo);
    this.lastControlSent = 0;
    if (this.lastWorld) this.update(this.lastWorld);
    return this.voiceStates[index].solo;
  }

  setVoiceDecoder(index, decoderId) {
    if (!this.models.some((model) => model.id === decoderId)) return false;
    this.ensureVoiceStates(index + 1);
    this.voiceStates[index].decoderId = decoderId;
    this.lastControlSent = 0;
    if (this.lastWorld) this.update(this.lastWorld);
    return true;
  }

  getVoiceDiagnostics() {
    const count = Math.max(this.voiceStates.length, this.telemetry.length);
    return Array.from({ length: count }, (_, index) => ({
      index,
      objectId: this.lastWorld?.objects[index]?.id ?? index,
      rms: this.telemetry[index]?.rms ?? 0,
      db: this.telemetry[index]?.db ?? -140,
      peak: 0,
      noteGroups: this.telemetry[index]?.noteGroups ?? this.lastWorld?.objects[index]?.noteGroups?.length ?? 1,
      latentRemaining: this.telemetry[index]?.latentRemaining ?? 0,
      muted: this.voiceStates[index]?.muted ?? false,
      solo: this.voiceStates[index]?.solo ?? false,
      decoderId: this.telemetry[index]?.decoderId ?? this.voiceStates[index]?.decoderId ?? 'brave-16d',
    }));
  }

  get running() {
    return this.context?.state === 'running' && this.mode === 'neural-realtime';
  }

  get label() {
    if (this.mode === 'neural-realtime') return `3 decoders ensemble · Voice 独立路由 · ${this.modelSha?.slice(0, 8)}`;
    if (this.mode === 'connecting') return `正在连接 ${this.modelId}`;
    if (this.mode === 'audio-error') return `神经 decoder 失败 · 已静音${this.loadError ? ` · ${this.loadError}` : ''}`;
    return '声音离线';
  }

  get facts() {
    return {
      mode: this.mode,
      liveDecoder: this.mode === 'neural-realtime',
      mapping: 'boids-relations-8d',
      xyLatentProjection: false,
      relationDimensions: 8,
      latentControlDimensions: this.latentSize,
      modelId: this.modelId,
      samplesPerFrame: this.samplesPerFrame,
      pitchControl: true,
      pulseTrigger: true,
      modelSha: this.modelSha,
      loadError: this.loadError,
      activeVoices: this.lastWorld?.objects.length ?? 0,
      renderMs: this.renderMs,
      bufferedFrames: this.workletStats.bufferedFrames,
      underruns: this.workletStats.underruns,
    };
  }
}
