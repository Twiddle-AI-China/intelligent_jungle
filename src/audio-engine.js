// 轻量 Web Audio 合成器：每群一个 Voice（oscillator + filter + gain + delay），
// boids 8D 关系映射到合成器参数（filter cutoff/resonance/detune/delay feedback），
// MIDI/键盘直接触发 oscillator。server 端只跑 transport/pattern 调度，PCM 生成在浏览器。
// 后面上了 Spark 再切回 neural decoder，映射契约不变。

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

// 8D 关系 → 合成器参数（戏剧性映射，让运动明显可听）：
//   compactness → filter cutoff 100-6kHz + waveshaper drive
//   alignment → detune 0-100 cents + 第二 oscillator 失谐
//   expansion → delay feedback 0-0.6 + delay time 0.1-0.5s
//   motionEnergy → oscillator level + sub oscillator mix
//   circulation → filter resonance Q 0.5-12
//   turbulence → noise mix（黑客松不用，先 0）
//   interFlockPressure → pan（已有）
//   obstaclePressure → distortion（黑客松不用，先 0）
const RELATION_TO_SYNTH = {
  filterCutoff: (relations) => 100 + (relations[0] * 0.5 + 0.5) ** 2 * 5900, // 100Hz - 6kHz，指数曲线
  filterResonance: (relations) => 0.5 + (relations[4] * 0.5 + 0.5) * 11.5, // Q 0.5 - 12
  detuneSpread: (relations) => (1 - (relations[1] * 0.5 + 0.5)) * 100, // 0 - 100 cents
  delayFeedback: (relations) => (relations[2] * 0.5 + 0.5) * 0.6, // 0 - 0.6
  delayTime: (relations) => 0.1 + (relations[2] * 0.5 + 0.5) * 0.4, // 0.1 - 0.5s
  oscillatorLevel: (relations) => 0.2 + (relations[3] * 0.5 + 0.5) * 0.8, // 0.2 - 1.0
  subOscMix: (relations) => (1 - (relations[0] * 0.5 + 0.5)) * 0.4, // 松散时 sub 更多
};

class SynthVoice {
  constructor(context, destination, objectId) {
    this.context = context;
    this.objectId = objectId;
    // 主 oscillator + sub oscillator（低八度，松散时混入）。
    this.oscillator = context.createOscillator();
    this.oscillator.type = 'sawtooth';
    this.subOsc = context.createOscillator();
    this.subOsc.type = 'sine';
    this.subGain = context.createGain();
    this.subGain.gain.value = 0;
    // 高次谐波 osc（繁茂度的「丰润度」载体）。
    this.harmOsc = context.createOscillator();
    this.harmOsc.type = 'triangle';
    this.harmGain = context.createGain();
    this.harmGain.gain.value = 0;
    // 噪声源（虫害的「杂质」载体）。
    this.noise = this._makeNoise();
    this.noiseGain = context.createGain();
    this.noiseGain.gain.value = 0;
    this.filter = context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 800;
    this.filter.Q.value = 1;
    this.gain = context.createGain();
    this.gain.gain.value = 0;
    // 声部丰润度：混响发送（简化为长反馈 delay 的湿声）。
    this.reverbSend = context.createGain();
    this.reverbSend.gain.value = 0.1;
    this.delay = context.createDelay(1);
    this.delay.delayTime.value = 0.25;
    this.delayFeedback = context.createGain();
    this.delayFeedback.gain.value = 0.2;
    this.delayWet = context.createGain();
    this.delayWet.gain.value = 0.2;
    this.pan = context.createStereoPanner();
    // 镜头混音焦点增益（mixFromCamera 的输出）。
    this.focusGain = context.createGain();
    this.focusGain.gain.value = 1;
    // 链：osc → filter → gain → pan → focusGain → destination
    //     subOsc → subGain ↗   harmOsc → harmGain ↗   noise → noiseGain ↗
    this.oscillator.connect(this.filter);
    this.subOsc.connect(this.subGain);
    this.subGain.connect(this.filter);
    this.harmOsc.connect(this.harmGain);
    this.harmGain.connect(this.filter);
    this.noise.connect(this.noiseGain);
    this.noiseGain.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(this.pan);
    this.pan.connect(this.focusGain);
    this.focusGain.connect(destination);
    this.gain.connect(this.delay);
    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.delay.connect(this.delayWet);
    this.delayWet.connect(destination);
    // 混响发送：gain → reverbSend → 共享 convolver（由 engine 挂到 destination）。
    this.gain.connect(this.reverbSend);
    this.oscillator.start();
    this.subOsc.start();
    this.harmOsc.start();
    this.noise.start();
    this.currentMidi = 60;
    this.envelope = 0;
    this.triggered = false;
  }

  _makeNoise() {
    const length = this.context.sampleRate * 1.5;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    return source;
  }

  setMidi(midi) {
    this.currentMidi = midi;
    const freq = 440 * 2 ** ((midi - 69) / 12);
    this.oscillator.frequency.setTargetAtTime(freq, this.context.currentTime, 0.01);
    this.subOsc.frequency.setTargetAtTime(freq / 2, this.context.currentTime, 0.01);
    this.harmOsc.frequency.setTargetAtTime(freq * 2.01, this.context.currentTime, 0.01);
  }

  setTimbre(relations) {
    const now = this.context.currentTime;
    this.filter.frequency.setTargetAtTime(RELATION_TO_SYNTH.filterCutoff(relations), now, 0.05);
    this.filter.Q.setTargetAtTime(RELATION_TO_SYNTH.filterResonance(relations), now, 0.05);
    this.oscillator.detune.setTargetAtTime(RELATION_TO_SYNTH.detuneSpread(relations), now, 0.05);
    this.subGain.gain.setTargetAtTime(RELATION_TO_SYNTH.subOscMix(relations), now, 0.05);
    this.delayFeedback.gain.setTargetAtTime(RELATION_TO_SYNTH.delayFeedback(relations), now, 0.05);
    this.delay.delayTime.setTargetAtTime(RELATION_TO_SYNTH.delayTime(relations), now, 0.05);
    this.baseLevel = RELATION_TO_SYNTH.oscillatorLevel(relations);
  }

  // 生态中间属性（映射层输出）：richness=繁茂度丰润度，impurity=虫害杂质。
  setEco(eco) {
    if (!eco) return;
    const now = this.context.currentTime;
    if (eco.richness) {
      this.reverbSend.gain.setTargetAtTime(eco.richness.reverbSend, now, 0.1);
      this.harmGain.gain.setTargetAtTime(eco.richness.harmonicGain * 0.18, now, 0.1);
    }
    if (eco.impurity) {
      this.noiseGain.gain.setTargetAtTime(eco.impurity.noiseMix * 0.12, now, 0.1);
      this.harmOsc.detune.setTargetAtTime(eco.impurity.detuneCents, now, 0.1);
    }
    // 客音符：host 树上有串门客鸟时，音色做轻微偏移（更亮、略失谐），让串门可辨。
    if (eco.guest) {
      this.filter.frequency.setTargetAtTime(this.filter.frequency.value * 1.22, now, 0.1);
      this.oscillator.detune.setTargetAtTime(this.oscillator.detune.value + 18, now, 0.1);
    }
  }

  setFocus(gainValue) {
    this.focusGain.gain.setTargetAtTime(gainValue, this.context.currentTime, 0.08);
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
      // 全局亮度（昼夜/健康 → filter macro）与 lofi（健康 → 降采样感）。
      this.masterFilter = this.context.createBiquadFilter();
      this.masterFilter.type = 'lowpass';
      this.masterFilter.frequency.value = 18000;
      this.lofi = this._makeLofi();
      this.lofiGain = this.context.createGain();
      this.lofiGain.gain.value = 0; // lofi mix
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -10;
      compressor.knee.value = 12;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.12;
      this.masterGain.connect(this.masterFilter);
      this.masterFilter.connect(compressor);
      compressor.connect(this.context.destination);
      // lofi 并联：masterFilter → lofi → lofiGain → destination
      this.masterFilter.connect(this.lofi);
      this.lofi.connect(this.lofiGain);
      this.lofiGain.connect(this.context.destination);
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

  _makeLofi() {
    // lofi 近似：waveshaper 做位深压碎 + 低通做带宽限制。
    const shaper = this.context.createWaveShaper();
    const curve = new Float32Array(256);
    const bits = 5;
    const steps = 2 ** bits;
    for (let i = 0; i < 256; i += 1) {
      const x = (i / 255) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    shaper.curve = curve;
    const lp = this.context.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3800;
    shaper.connect(lp);
    const input = this.context.createGain();
    input.connect(shaper);
    // 暴露一个可连接的输入节点，输出取 lp。
    input._output = lp;
    return input;
  }

  // 全局宏：昼夜/健康 → filter 亮度与 lofi mix。
  setMasterMacros({ brightness, lofiMix, filterMacro }) {
    if (!this.context) return;
    const now = this.context.currentTime;
    const b = Math.max(0.2, Math.min(1, brightness ?? 1)) * Math.max(0.3, Math.min(1, filterMacro ?? 1));
    this.masterFilter.frequency.setTargetAtTime(400 + b * 17600, now, 0.15);
    this.lofiGain.gain.setTargetAtTime(Math.max(0, Math.min(0.7, lofiMix ?? 0)) * 0.8, now, 0.15);
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
    // 兼容：新结构 world.flocks，旧结构 world.objects。
    const flocks = world.flocks ?? world.objects ?? [];
    this.ensureVoiceStates(flocks.length);
    if (this.mode !== 'web-audio-synth') return;
    const now = performance.now();
    if (now - this.lastControlSent < 30) return; // 30 Hz 控制帧
    this.lastControlSent = now;
    this.transport = this.getTransportState();
    const anySolo = this.voiceStates.some((state) => state.solo);
    for (let index = 0; index < flocks.length; index += 1) {
      const voice = flocks[index];
      const synthVoice = this.ensureVoice(voice.id);
      const override = this.voiceOverrides.get(voice.id);
      const relations = (override?.relationState ?? this.timbreBases.get(voice.id) ?? voice.relationState).slice(0, 8);
      synthVoice.setTimbre(relations);
      if (override?.eco) synthVoice.setEco(override.eco);
      if (Number.isFinite(override?.focusGain)) synthVoice.setFocus(override.focusGain);
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
