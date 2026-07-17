// 下潜后的单群实时会话：群内相对运动（8D 关系）驱动 timbre latent，
// 键盘/MIDI 接管显式音高，录音环记录 loop 相对拍点供返回时回写 pattern。
// 音高在发声一刻就量化到当前和弦（和声安全），所以回放与演奏必然一致（G5）。

import { createEcosystem, setGuideTarget, stepEcosystem } from './boids.js';
import { quantizeToChord } from '../score.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const MAX_RECORDED_NOTES = 32;
// 后端 C 的移调链只保证 C4±6 半音；后端 A/B 落地后放宽。
const PITCH_CLIP_SEMITONES = 6;

export class LiveInstrumentSession {
  constructor({ flockId, chord, loopBeats = 16, seed = 73 }) {
    this.flockId = flockId;
    this.chord = chord;
    this.loopBeats = loopBeats;
    this.ecosystem = createEcosystem({ seed: seed + flockId * 131 });
    this.held = new Map();
    this.recording = [];
    this.triggerSerial = 0;
    this.triggerStrength = 0;
    this.currentGroup = null;
  }

  setChord(chord) { this.chord = chord; }

  guide(x, y, active = true) {
    setGuideTarget(this.ecosystem, active ? { x, y } : null);
  }

  step(dt) { stepEcosystem(this.ecosystem, dt); }

  noteOn(key, midi, velocity, beat) {
    const quantized = quantizeToChord(Math.round(midi), this.chord);
    this.held.set(String(key), { midi: quantized, velocity: clamp(velocity, 0.05, 1), startBeat: beat });
    this.triggerSerial += 1;
    this.triggerStrength = clamp(velocity, 0.05, 1);
    this.currentGroup = {
      id: 0,
      pitchSemitones: clamp(quantized - 60, -PITCH_CLIP_SEMITONES, PITCH_CLIP_SEMITONES),
      durationSeconds: 0.9,
      strength: this.triggerStrength,
      x: this.ecosystem.centroid.x,
      triggerSerial: this.triggerSerial,
      triggerStrength: this.triggerStrength,
    };
    return quantized;
  }

  noteOff(key, beat) {
    const entry = this.held.get(String(key));
    if (!entry) return false;
    this.held.delete(String(key));
    if (Number.isFinite(entry.startBeat) && Number.isFinite(beat)) {
      const durBeats = ((beat - entry.startBeat) % this.loopBeats + this.loopBeats) % this.loopBeats;
      this.recording.push({ beat: entry.startBeat, midi: entry.midi, durBeats, vel: entry.velocity });
      if (this.recording.length > MAX_RECORDED_NOTES * 2) this.recording.splice(0, this.recording.length - MAX_RECORDED_NOTES * 2);
    }
    if (this.held.size > 0) {
      const latest = Array.from(this.held.values()).at(-1);
      this.currentGroup = { ...this.currentGroup, pitchSemitones: clamp(latest.midi - 60, -PITCH_CLIP_SEMITONES, PITCH_CLIP_SEMITONES) };
    }
    return true;
  }

  // 「保留乐句」：同一格点同音高后弹的覆盖先弹的，最多带走 MAX_RECORDED_NOTES 个音。
  takeRecording(quantize) {
    const quantized = quantize(this.recording, this.loopBeats);
    const byCell = new Map();
    for (const note of quantized) byCell.set(`${note.beat}:${note.midi}`, note);
    const notes = Array.from(byCell.values()).sort((a, b) => a.beat - b.beat || a.midi - b.midi).slice(0, MAX_RECORDED_NOTES);
    this.recording = [];
    return notes;
  }

  discardRecording() { this.recording = []; }

  // 发给 audio engine 的该群覆盖控制：关系来自下潜生态，音高来自键盘。
  controlOverride() {
    return {
      relationState: this.ecosystem.relationState.slice(0, 8),
      noteGroups: this.currentGroup ? [{ ...this.currentGroup }] : [],
      pitchSemitones: this.currentGroup?.pitchSemitones ?? 0,
      triggerSerial: this.triggerSerial,
      triggerStrength: this.triggerStrength,
    };
  }
}
