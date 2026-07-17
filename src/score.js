// 编排层乐谱：乐谱是 anchor 集合，鸟群是它的活体渲染。
// anchor 定义音符的格点位置；鸟群围绕 anchor 飞行，实际漂移在微变化
// 预算内转成 swing 与和弦色彩借音——变化来自可见的运动，不注入随机数。

export const CHORD_QUALITIES = Object.freeze({
  minor: [0, 3, 7],
  major: [0, 4, 7],
  minor7: [0, 3, 7, 10],
  major7: [0, 4, 7, 11],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
});

// 画布纵轴的全局音高范围；各声部音域带取其子区间。
export const PITCH_AXIS = Object.freeze({ loMidi: 36, hiMidi: 84 });

// 后端 C 的移调链只保证 C4±6 半音，音域带先收在它附近；
// 后端 A/B 的真 pitch conditioning 落地后再放宽。
export const ROLE_BANDS = Object.freeze({
  bass: { loMidi: 54, hiMidi: 60 },
  support: { loMidi: 57, hiMidi: 66 },
  ornament: { loMidi: 62, hiMidi: 70 },
});

export const DEFAULT_BUDGET = Object.freeze({
  swingBeats: 0.125,      // ±1/32 音符（4/4 下 1 beat 的 1/8）
  borrowSemitones: 1.2,   // 群心纵向漂移超过此半音数才借相邻和弦音
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function chordTones(chord, loMidi, hiMidi) {
  const intervals = CHORD_QUALITIES[chord.quality] ?? CHORD_QUALITIES.minor;
  const tones = [];
  for (let midi = Math.ceil(loMidi); midi <= Math.floor(hiMidi); midi += 1) {
    const pitchClass = ((midi - chord.rootMidi) % 12 + 12) % 12;
    if (intervals.includes(pitchClass)) tones.push(midi);
  }
  return tones;
}

// 与 server 端 sequencer.quantize_to_chord 同规则：最近和弦音，平局向下。
export function quantizeToChord(midi, chord) {
  const intervals = CHORD_QUALITIES[chord.quality] ?? CHORD_QUALITIES.minor;
  const pitchClass = ((midi - chord.rootMidi) % 12 + 12) % 12;
  let best = intervals[0]; let bestDistance = Infinity;
  for (const tone of intervals) {
    const up = (tone - pitchClass + 12) % 12;
    const down = (pitchClass - tone + 12) % 12;
    const distance = Math.min(up, down);
    if (distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) < 1e-9 && tone < best)) {
      best = tone; bestDistance = distance;
    }
  }
  const up = (best - pitchClass + 12) % 12;
  const down = (pitchClass - best + 12) % 12;
  return Math.round(clamp(up < down ? midi + up : midi - down, 0, 127));
}

export function midiToY(midi) {
  return 1 - (clamp(midi, PITCH_AXIS.loMidi, PITCH_AXIS.hiMidi) - PITCH_AXIS.loMidi) / (PITCH_AXIS.hiMidi - PITCH_AXIS.loMidi);
}

export function yToMidiDrift(dy) {
  return -dy * (PITCH_AXIS.hiMidi - PITCH_AXIS.loMidi);
}

// 角色化的极简默认乐句：确定性生成，agent/用户之后覆写。
export function defaultPattern(role, chord, loopBeats = 16) {
  const band = ROLE_BANDS[role] ?? ROLE_BANDS.support;
  const tones = chordTones(chord, band.loMidi, band.hiMidi);
  if (!tones.length) return [];
  const notes = [];
  if (role === 'bass') {
    for (let beat = 0; beat < loopBeats; beat += 4) {
      notes.push({ beat, midi: tones[0], durBeats: 0.9, vel: 0.9 });
      notes.push({ beat: beat + 2.5, midi: tones[Math.min(1, tones.length - 1)], durBeats: 0.45, vel: 0.6 });
    }
  } else if (role === 'ornament') {
    for (let beat = 1; beat < loopBeats; beat += 3) {
      const index = ((tones.length - 1 - Math.floor(beat / 3)) % tones.length + tones.length) % tones.length;
      notes.push({ beat, midi: tones[index], durBeats: 0.3, vel: 0.5 });
    }
  } else {
    for (let beat = 0; beat < loopBeats; beat += 2) {
      notes.push({ beat, midi: tones[Math.floor(beat / 2) % tones.length], durBeats: 1.6, vel: 0.7 });
    }
  }
  return notes;
}

export function anchorsForPattern(pattern, loopBeats = 16) {
  return pattern.map((note) => ({
    ...note,
    x: (note.beat % loopBeats) / loopBeats,
    y: midiToY(note.midi),
  }));
}

// 微变化预算：把每个 anchor 附近鸟群的实际漂移折算成演奏偏差。
// drifts[i] = {dx, dy}（画布归一化坐标，anchor i 周边鸟的均值偏移）。
export function performPattern(anchors, drifts, chord, loopBeats = 16, budget = DEFAULT_BUDGET) {
  return anchors.map((anchor, index) => {
    const drift = drifts[index] ?? { dx: 0, dy: 0 };
    const swing = clamp(drift.dx * loopBeats, -budget.swingBeats, budget.swingBeats);
    let midi = anchor.midi;
    const midiDrift = yToMidiDrift(drift.dy);
    if (Math.abs(midiDrift) >= budget.borrowSemitones) {
      const direction = midiDrift > 0 ? 1 : -1;
      let candidate = midi + direction;
      while (candidate > PITCH_AXIS.loMidi && candidate < PITCH_AXIS.hiMidi
        && quantizeToChord(candidate, chord) === midi) candidate += direction;
      midi = quantizeToChord(candidate, chord);
    }
    const beat = ((anchor.beat + swing) % loopBeats + loopBeats) % loopBeats;
    return { beat, midi, durBeats: anchor.durBeats, vel: anchor.vel };
  });
}

export function patternsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((note, index) => {
    const other = b[index];
    return Math.abs(note.beat - other.beat) < 1e-6 && note.midi === other.midi
      && Math.abs(note.durBeats - other.durBeats) < 1e-6 && Math.abs(note.vel - other.vel) < 1e-6;
  });
}
