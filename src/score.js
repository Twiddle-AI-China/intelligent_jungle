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

// 声部音域带 = 相对 master 和弦根音的半音偏移（PRD §4 音域分配：各声部占据
// 不重叠的频段；换根音时整个带随根音移调，和弦内音关系不变——和声安全）。
// 换算成绝对 midi 一律走 bandForChord。后端 B（decode_pitch）已在 realtime
// server 落地，音域不再受后端 C「C4±6 移调链」的限制，故按角色音区拉开：
//   bass     低吟：根音下方八度~五度（Bass 低音域带）
//   support  和鸣：根音~上方五度（Chord-Pad 中低，根音恒在带内）
//   ornament 飞羽：上方五度~九度（Lead/Texture 中高~高，弱节奏）
export const ROLE_BANDS = Object.freeze({
  bass: { lo: -12, hi: -7 },
  support: { lo: 0, hi: 7 },
  ornament: { lo: 7, hi: 14 },
});

// 相对音域带 → 当前和弦下的绝对 midi 区间（夹在画布纵轴 PITCH_AXIS 内）。
export function bandForChord(chord, role) {
  const offsets = ROLE_BANDS[role] ?? ROLE_BANDS.support;
  return {
    loMidi: clamp(chord.rootMidi + offsets.lo, PITCH_AXIS.loMidi, PITCH_AXIS.hiMidi),
    hiMidi: clamp(chord.rootMidi + offsets.hi, PITCH_AXIS.loMidi, PITCH_AXIS.hiMidi),
  };
}

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

// dy 约定「向上为正」：屏幕 y 向下增大而音高向上增大（见 midiToY），调用方把
// 屏幕位移翻号后传入。直接映射：鸟/拖拽越向上（y 越小），音越高。
export function yToMidiDrift(dy) {
  return dy * (PITCH_AXIS.hiMidi - PITCH_AXIS.loMidi);
}

// 角色化的默认乐句：完整的和弦内音阶（小三=1,♭3,5；大七=1,3,5,7），
// 跨音域带的多个八度，按角色节奏型排布——用户能弹出完整旋律，不是只有 3 个音。
export function defaultPattern(role, chord, loopBeats = 16) {
  const band = bandForChord(chord, role);
  const tones = chordTones(chord, band.loMidi, band.hiMidi);
  if (!tones.length) return [];
  const notes = [];
  if (role === 'bass') {
    // Bass：根音为主，五音点缀，每 2 拍一个音。
    for (let beat = 0; beat < loopBeats; beat += 2) {
      const degree = beat % 8 === 0 ? 0 : beat % 8 === 4 ? 1 : beat % 8 === 6 ? 2 : 0;
      notes.push({ beat, midi: tones[degree % tones.length], durBeats: 1.8, vel: 0.85 });
    }
  } else if (role === 'ornament') {
    // Ornament：完整音阶上下行，每拍一个音，弱起。
    for (let beat = 0; beat < loopBeats; beat += 1) {
      const index = beat % (tones.length * 2 - 2);
      const toneIndex = index < tones.length ? index : tones.length * 2 - 2 - index;
      notes.push({ beat, midi: tones[toneIndex], durBeats: 0.4, vel: 0.5 });
    }
  } else {
    // Support（Chord-Pad）：和弦内音阶分解，每 1.5 拍一个音。
    for (let beat = 0; beat < loopBeats; beat += 1.5) {
      const index = Math.floor(beat / 1.5) % tones.length;
      notes.push({ beat, midi: tones[index], durBeats: 1.2, vel: 0.65 });
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
    // drift.dy 是屏幕位移（向下为正），翻号成「向上为正」再映射音高。
    const midiDrift = yToMidiDrift(-drift.dy);
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

export const BEAT_GRID = 0.25; // 16 步 / 4 拍小节

export function quantizeBeat(beat, loopBeats = 16, grid = BEAT_GRID) {
  const snapped = Math.round(beat / grid) * grid;
  return ((snapped % loopBeats) + loopBeats) % loopBeats;
}

function clampMidiToBand(midi, band) {
  return Math.max(band.loMidi, Math.min(band.hiMidi, midi));
}

// 接管拖拽：pattern 整体平移。X 平移=时间偏移（步进网格），Y 平移=移调，
// 落点始终量化回和弦内音并夹在该声部音域带内——和声安全对用户同样生效。
export function shiftPattern(pattern, beatOffset, semitoneOffset, chord, band, loopBeats = 16) {
  const snappedBeats = Math.round(beatOffset / BEAT_GRID) * BEAT_GRID;
  const semitones = Math.round(semitoneOffset);
  return pattern.map((note) => ({
    ...note,
    beat: quantizeBeat(note.beat + snappedBeats, loopBeats),
    midi: quantizeToChord(clampMidiToBand(note.midi + semitones, band), chord),
  }));
}

// 拖动单个音符：只改该音符的 beat/音级，同样过和弦量化与音域带。
export function moveNote(pattern, index, beat, midi, chord, band, loopBeats = 16) {
  return pattern.map((note, i) => (i === index ? {
    ...note,
    beat: quantizeBeat(beat, loopBeats),
    midi: quantizeToChord(clampMidiToBand(Math.round(midi), band), chord),
  } : note));
}

// 录音环最简版：只做时间步进量化。音高在演奏时已经过和弦量化（听到什么
// 回放就是什么，G5），这里不再改写 midi，也不回写任何音色基点。
export function quantizeRecording(events, loopBeats = 16) {
  return events
    .filter((event) => Number.isFinite(event.beat) && Number.isFinite(event.midi))
    .map((event) => ({
      beat: quantizeBeat(event.beat, loopBeats),
      midi: Math.round(event.midi),
      durBeats: Math.max(BEAT_GRID, Math.round((event.durBeats ?? BEAT_GRID) / BEAT_GRID) * BEAT_GRID),
      vel: Math.max(0.05, Math.min(1, event.vel ?? 0.8)),
    }))
    .sort((a, b) => a.beat - b.beat || a.midi - b.midi);
}

export function patternsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((note, index) => {
    const other = b[index];
    return Math.abs(note.beat - other.beat) < 1e-6 && note.midi === other.midi
      && Math.abs(note.durBeats - other.durBeats) < 1e-6 && Math.abs(note.vel - other.vel) < 1e-6;
  });
}
