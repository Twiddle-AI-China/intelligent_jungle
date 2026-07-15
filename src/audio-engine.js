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
    this.decodeMs = 0;
  }

  async start(objects) {
    if (this.context) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    this.mode = 'connecting';
    this.ensureVoiceStates(objects.length);
    try {
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
      const socket = new WebSocket(`${protocol}//${window.location.host}/decoder`);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      const timeout = window.setTimeout(() => reject(new Error('BRAVE decoder connection timed out')), 15000);
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('BRAVE decoder WebSocket failed'));
      };
      socket.onclose = () => {
        if (this.mode === 'brave-realtime') {
          this.mode = 'audio-error';
          this.loadError = 'BRAVE decoder connection closed';
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
          this.mode = 'brave-realtime';
          resolve();
        } else if (message.type === 'telemetry') {
          this.telemetry = message.voices ?? [];
          this.decodeMs = message.decodeMs ?? 0;
        } else if (message.type === 'error') {
          this.loadError = message.message;
        }
      };
    });
  }

  ensureVoiceStates(count) {
    while (this.voiceStates.length < count) this.voiceStates.push({ muted: false, solo: false });
  }

  update(world) {
    this.lastWorld = world;
    if (this.mode !== 'brave-realtime' || this.socket?.readyState !== WebSocket.OPEN) return;
    this.ensureVoiceStates(world.objects.length);
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
        latentPosition: voice.latentPosition.slice(0, 4),
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

  getVoiceDiagnostics() {
    const count = Math.max(this.voiceStates.length, this.telemetry.length);
    return Array.from({ length: count }, (_, index) => ({
      index,
      objectId: this.lastWorld?.objects[index]?.id ?? index,
      rms: this.telemetry[index]?.rms ?? 0,
      db: this.telemetry[index]?.db ?? -140,
      peak: 0,
      muted: this.voiceStates[index]?.muted ?? false,
      solo: this.voiceStates[index]?.solo ?? false,
    }));
  }

  get running() {
    return this.context?.state === 'running' && this.mode === 'brave-realtime';
  }

  get label() {
    if (this.mode === 'brave-realtime') return `BRAVE 实时 decoder · 4D latent · ${this.modelSha?.slice(0, 8)}`;
    if (this.mode === 'connecting') return '正在连接 BRAVE 实时 decoder';
    if (this.mode === 'audio-error') return `BRAVE 实时 decoder 失败 · 已静音${this.loadError ? ` · ${this.loadError}` : ''}`;
    return '声音离线';
  }

  get facts() {
    return {
      mode: this.mode,
      liveDecoder: this.mode === 'brave-realtime',
      mapping: 'boids-direct-4d',
      xyLatentProjection: true,
      xyLatentDimensions: [0, 1],
      velocityLatentDimensions: [2, 3],
      latentControlDimensions: 4,
      modelSha: this.modelSha,
      loadError: this.loadError,
      activeVoices: this.lastWorld?.objects.length ?? 0,
      decodeMs: this.decodeMs,
      bufferedFrames: this.workletStats.bufferedFrames,
      underruns: this.workletStats.underruns,
    };
  }
}
