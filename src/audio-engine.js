// 轻量 Web Audio 合成器：每群一个 Voice（oscillator + filter + gain + delay），
// boids 8D 关系映射到合成器参数（filter cutoff/resonance/detune/delay feedback），
// MIDI/键盘直接触发 oscillator。server 端只跑 transport/pattern 调度，PCM 生成在浏览器。
// 后面上了 Spark 再切回 neural decoder，映射契约不变。

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// 8D 关系 → 合成器参数（与 neural 的「8D 关系→latent」契约对齐）：
//   compactness → filter cutoff（越紧越亮）
//   alignment → detune spread（越齐越单音）
//   expansion → delay feedback（越散越空间感）
//   motionEnergy → oscillator level
//   circulation → filter resonance
//   turbulence → noise mix（黑客松不用，先 0）
//   interFlockPressure → pan（已有）
//   obstaclePressure → distortion（黑客松不用，先 0）
const RELATION_TO_SYNTH = {
  filterCutoff: (relations) => 200 + (relations[0] * 0.5 + 0.5) * 3800, // 200Hz - 4kHz
  filterResonance: (relations) => 0.5 + (relations[4] * 0.5 + 0.5) * 8, // Q 0.5 - 8.5
  detuneSpread: (relations) => (1 - (relations[1] * 0.5 + 0.5)) * 50, // 0 - 50 cents
  delayFeedback: (relations) => (relations[2] * 0.5 + 0.5) * 0.4, // 0 - 0.4
  oscillatorLevel: (relations) => 0.3 + (relations[3] * 0.5 + 0.5) * 0.7, // 0.3 - 1.0
};

class SynthVoice {
  constructor(context, destination, objectId) {
    this.context = context;
    this.objectId = objectId;
    this.oscillator = context.createOscillator();
    this.oscillator.type = 'sawtooth';
    this.filter = context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 800;
    this.filter.Q.value = 1;
    this.gain = context.createGain();
    this.gain.gain.value = 0;
    this.delay = context.createDelay(1);
    this.delay.delayTime.value = 0.25;
    this.delayFeedback = context.createGain();
    this.delayFeedback.gain.value = 0.2;
    this.delayWet = context.createGain();
    this.delayWet.gain.value = 0.15;
    this.pan = context.createStereoPanner();
    // 链：osc → filter → gain → pan → destination
    //                ↓
    //              delay → delayFeedback → delay（自循环）→ delayWet → destination
    this.oscillator.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(this.pan);
    this.pan.connect(destination);
    this.gain.connect(this.delay);
    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.delay.connect(this.delayWet);
    this.delayWet.connect(destination);
    this.oscillator.start();
    this.currentMidi = 60;
    this.envelope = 0;
    this.triggered = false;
  }

  setMidi(midi) {
    this.currentMidi = midi;
    this.oscillator.frequency.setTargetAtTime(440 * 2 ** ((midi - 69) / 12), this.context.currentTime, 0.01);
  }

  setTimbre(relations) {
    const now = this.context.currentTime;
    this.filter.frequency.setTargetAtTime(RELATION_TO_SYNTH.filterCutoff(relations), now, 0.05);
    this.filter.Q.setTargetAtTime(RELATION_TO_SYNTH.filterResonance(relations), now, 0.05);
    this.oscillator.detune.setTargetAtTime(RELATION_TO_SYNTH.detuneSpread(relations), now, 0.05);
    this.delayFeedback.gain.setTargetAtTime(RELATION_TO_SYNTH.delayFeedback(relations), now, 0.05);
    this.baseLevel = RELATION_TO_SYNTH.oscillatorLevel(relations);
  }

  setPan(pan) {
    this.pan.pan.setTargetAtTime(clamp(pan, -1, 1), this.context.currentTime, 0.02);
  }

  trigger(velocity = 0.8, durationSeconds = 0.5) {
    const now = this.context.currentTime;
    const level = (this.baseLevel ?? 0.7) * clamp(velocity, 0.1, 1);
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(level, now + 0.01); // attack
    this.gain.gain.exponentialRampToValueAtTime(0.001, now + durationSeconds); // decay
    this.triggered = true;
    this.envelope = level;
  }

  release() {
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setTargetAtTime(0, now, 0.1);
    this.envelope = 0;
  }

  setMuted(muted) {
    this.muted = muted;
    if (muted) this.release();
  }
}

export class PerceptualWebAudioEngine {
  constructor() {
    this.context = null;
    this.masterGain = null;
    this.voices = new Map(); // objectId → SynthVoice
    this.mode = 'offline';
    this.transport = null;
    this.voiceOverrides = new Map();
    this.timbreBases = new Map();
    this.voiceStates = [];
    this.lastWorld = null;
    this.lastControlSent = 0;
    // 客户端 transport（server 只发 pattern/chord/transport 配置，不发 PCM）。
    this.clientTransport = { bpm: 82, beatsPerBar: 4, loopBars: 4, playing: false, startTime: 0 };
    this.patterns = new Map(); // objectId → [{beat, midi, durBeats, vel}]
    this.chord = { rootMidi: 48, quality: 'minor' };
    this.lastTriggerBeats = new Map(); // `${objectId}-${beatIndex}` → last triggered beat
  }

  setVoiceOverride(objectId, override) {
    if (override) this.voiceOverrides.set(objectId, override);
    else this.voiceOverrides.delete(objectId);
  }

  setTransport({ bpm, beatsPerBar, loopBars, playing }) {
    this.clientTransport = { ...this.clientTransport, bpm, beatsPerBar, loopBars, playing };
    if (playing && !this.clientTransport.startTime) {
      this.clientTransport.startTime = this.context?.currentTime ?? 0;
    }
    // 通知 UI transport 变了（UI 轮询 this.transport）。
    this.transport = this.getTransportState();
  }

  setChord(rootMidi, quality) {
    this.chord = { rootMidi, quality };
  }

  setPattern(objectId, notes) {
    this.patterns.set(objectId, (notes ?? []).map((note) => ({ beat: note.beat, midi: note.midi, durBeats: note.durBeats, vel: note.vel })));
  }

  getTransportState() {
    if (!this.context || !this.clientTransport.playing) return null;
    const elapsed = this.context.currentTime - this.clientTransport.startTime;
    const beatsPerSecond = this.clientTransport.bpm / 60;
    const totalBeats = elapsed * beatsPerSecond;
    const loopBeats = this.clientTransport.beatsPerBar * this.clientTransport.loopBars;
    return {
      beat: totalBeats % loopBeats,
      loopBeats,
      bar: Math.floor((totalBeats % loopBeats) / this.clientTransport.beatsPerBar),
      bpm: this.clientTransport.bpm,
      playing: this.clientTransport.playing,
      chordRootMidi: this.chord.rootMidi,
      chordQuality: this.chord.quality,
    };
  }

  async start(objects) {
    if (this.context) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('当前浏览器不提供 Web Audio AudioContext');
      this.context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = 0.7;
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -10;
      compressor.knee.value = 12;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.12;
      this.masterGain.connect(compressor).connect(this.context.destination);
      for (const voice of objects) this.ensureVoice(voice.id);
      this.mode = 'web-audio-synth';
      if (this.context.state !== 'running') await this.context.resume();
    } catch (error) {
      this.mode = 'audio-error';
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  ensureVoice(objectId) {
    if (!this.voices.has(objectId)) {
      this.voices.set(objectId, new SynthVoice(this.context, this.masterGain, objectId));
    }
    return this.voices.get(objectId);
  }

  ensureVoiceStates(count) {
    while (this.voiceStates.length < count) {
      this.voiceStates.push({ muted: false, solo: false });
    }
  }

  assignDefaultDecoders() {
    // 合成器模式下没有 decoder 选择，保留接口兼容。
  }

  update(world) {
    this.lastWorld = world;
    this.ensureVoiceStates(world.objects.length);
    if (this.mode !== 'web-audio-synth') return;
    const now = performance.now();
    if (now - this.lastControlSent < 30) return; // 30 Hz 控制帧
    this.lastControlSent = now;
    this.transport = this.getTransportState();
    const anySolo = this.voiceStates.some((state) => state.solo);
    for (let index = 0; index < world.objects.length; index += 1) {
      const voice = world.objects[index];
      const synthVoice = this.ensureVoice(voice.id);
      const override = this.voiceOverrides.get(voice.id);
      const relations = (override?.relationState ?? this.timbreBases.get(voice.id) ?? voice.relationState).slice(0, 8);
      synthVoice.setTimbre(relations);
      synthVoice.setPan(clamp(voice.pan, -1, 1));
      const muted = this.voiceStates[index]?.muted ?? false;
      const audible = !muted && (!anySolo || (this.voiceStates[index]?.solo ?? false));
      synthVoice.setMuted(!audible);
      // Pattern 触发：检查 transport.beat 是否跨过任何 note 的 beat。
      if (this.transport && audible) {
        const pattern = override?.notes ?? this.patterns.get(voice.id) ?? [];
        for (let noteIndex = 0; noteIndex < pattern.length; noteIndex += 1) {
          const note = pattern[noteIndex];
          const key = `${voice.id}-${noteIndex}`;
          const lastBeat = this.lastTriggerBeats.get(key) ?? -1;
          const currentBeat = this.transport.beat;
          // 检测 beat 回卷：currentBeat < lastBeat 说明 loop 重新开始。
          const wrapped = currentBeat < lastBeat;
          const triggered = (lastBeat < note.beat && currentBeat >= note.beat) || (wrapped && (note.beat >= lastBeat || currentBeat >= note.beat));
          if (triggered) {
            synthVoice.setMidi(note.midi);
            synthVoice.trigger(note.vel, note.durBeats / (this.transport.bpm / 60));
            this.lastTriggerBeats.set(key, currentBeat);
          }
        }
      }
      // 下潜时的实时键盘触发（override.noteGroups）。
      if (override?.noteGroups?.length) {
        for (const group of override.noteGroups) {
          if (group.triggerSerial !== synthVoice.lastTriggerSerial) {
            synthVoice.setMidi(60 + group.pitchSemitones);
            synthVoice.trigger(group.triggerStrength, group.durationSeconds);
            synthVoice.lastTriggerSerial = group.triggerSerial;
          }
        }
      }
    }
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
    const count = Math.max(this.voiceStates.length, this.lastWorld?.objects.length ?? 0);
    return Array.from({ length: count }, (_, index) => {
      const voice = this.lastWorld?.objects[index];
      const synthVoice = voice ? this.voices.get(voice.id) : null;
      return {
        index,
        objectId: voice?.id ?? index,
        db: synthVoice?.envelope ? 20 * Math.log10(synthVoice.envelope) : -140,
        muted: this.voiceStates[index]?.muted ?? false,
        solo: this.voiceStates[index]?.solo ?? false,
      };
    });
  }

  get running() {
    return this.context?.state === 'running' && this.mode === 'web-audio-synth';
  }

  get label() {
    if (this.mode === 'web-audio-synth') return 'Web Audio 轻量合成器 · 4 Voice';
    if (this.mode === 'audio-error') return `合成器失败 · 已静音${this.loadError ? ` · ${this.loadError}` : ''}`;
    return '声音离线';
  }
}
