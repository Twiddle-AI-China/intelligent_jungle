// mvp/src/harmony.js —— 和声层（§3.5.1，纯函数，无状态）。
// 昼夜交替 = 和弦进行走一步；季节 = 色彩变体；家枝迁移 = 最近音级（voice-leading）。
// 本层只有音乐词汇（和弦/音级/MIDI），不知道生态细节；world 也不知道本层存在——
// 接线在 conductor（agent.js）与 main.js。

import { CONFIG } from './config.js';

// 第 N 天（day ≥ 1）的季节索引与季节名
export function seasonForDay(day, cfg = CONFIG.harmony) {
  const idx = Math.floor((day - 1) / cfg.seasonDays) % cfg.seasons.length;
  return { index: idx, id: cfg.seasons[idx], name: cfg.seasonNames[cfg.seasons[idx]] };
}

// 第 N 天的当日和弦：{ id, notes: [5 个 MIDI，按音高升序], season }
export function chordForDay(day, cfg = CONFIG.harmony) {
  const season = seasonForDay(day, cfg);
  const prog = cfg.progressions[season.id];
  const chord = prog[(day - 1) % prog.length];
  return {
    id: chord.id,
    notes: chord.intervals.map((i) => chord.root + i),
    season: season.id,
    seasonName: season.name,
  };
}

// 家枝最近音级迁移：和弦从 oldChord 换到 newChord 时，每只鸟的家枝搬到
// 「自己旧枝音高在新和弦里的最近音级」所在的枝（差值相同则保低位）。
// 输入 assignments: [{birdId, homeBranch}]；返回 [{birdId, from, to, semitoneShift}]。
export function migrateAssignments(oldChord, newChord, assignments) {
  return assignments.map(({ birdId, homeBranch }) => {
    const oldNote = oldChord.notes[homeBranch];
    let to = homeBranch;
    let best = Infinity;
    for (let b = 0; b < newChord.notes.length; b += 1) {
      const d = Math.abs(newChord.notes[b] - oldNote);
      if (d < best) { best = d; to = b; }
    }
    return { birdId, from: homeBranch, to, semitoneShift: newChord.notes[to] - oldNote };
  });
}

// transport 显示：相位 → 第几小节.第几拍（一昼夜 = barsPerDay × beatsPerBar）。
export function transportFromPhase(phase, cfg = CONFIG.tempo) {
  const beats = cfg.barsPerDay * cfg.beatsPerBar;
  const idx = Math.floor((((phase % 1) + 1) % 1) * beats) % beats;
  return {
    bar: Math.floor(idx / cfg.beatsPerBar) + 1,
    beat: (idx % cfg.beatsPerBar) + 1,
  };
}
