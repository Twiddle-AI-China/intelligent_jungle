// mvp/src/harmony.js —— 和声层（docs/harmony-season-redesign.md，纯函数，无状态）。
// 季 = 单和弦骨架（低 skeletonBranches 枝整季不动），昼夜 = 高枝色彩档明暗；
// 换季才做家枝最近音级大迁移（voice-leading），日内色彩变化不迁移。
// 本层只有音乐词汇（骨架/色彩/音级/MIDI），不知道生态细节；world 也不知道本层存在——
// 接线在 conductor（agent.js）与 main.js。

import { CONFIG } from './config.js';

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

// 当季骨架：{ id, root, notes: [5 个 MIDI，按音高升序] }（整季不变；未知季返回 null）
export function skeletonForSeason(season, cfg = CONFIG.harmony) {
  const skeleton = cfg.bySeason[season]?.skeleton;
  return skeleton ? { id: skeleton.id, root: skeleton.root, notes: [...skeleton.notes] } : null;
}

// 当季色彩档菜单：[{ id, notes: [高枝色彩音] }]（只含色彩枝，长度 = 枝数 − skeletonBranches）
export function colorOptions(season, cfg = CONFIG.harmony) {
  return (cfg.bySeason[season]?.colors ?? []).map((color) => ({ id: color.id, notes: [...color.notes] }));
}

/**
 * 在相邻和弦音之间插入调式过路音，得到升序密音格（含全部和弦音）。
 * 每缝最多插 maxPassing 个（默认 2）：均匀取距，避免塞满音阶导致级进过饱和。
 */
export function denseLatticeFromChordNotes(chordNotes, root, pitchClasses, maxPassing = 2) {
  const sorted = [...new Set((chordNotes ?? []).filter(Number.isFinite))].sort((a, b) => a - b);
  if (sorted.length < 2) return sorted.slice();
  const pcs = new Set((pitchClasses ?? []).map((pc) => ((Number(pc) % 12) + 12) % 12));
  const rootMidi = Number.isFinite(Number(root)) ? Number(root) : sorted[0];
  const cap = Math.max(0, Math.floor(Number(maxPassing)) || 0);
  const dense = new Set(sorted);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const lo = sorted[i];
    const hi = sorted[i + 1];
    if (hi - lo <= 4) continue; // 缝已是级进宽，不必再插
    const candidates = [];
    for (let midi = lo + 1; midi < hi; midi += 1) {
      const pc = ((midi - rootMidi) % 12 + 12) % 12;
      if (pcs.has(pc)) candidates.push(midi);
    }
    if (!candidates.length || cap === 0) continue;
    if (candidates.length <= cap) {
      for (const midi of candidates) dense.add(midi);
      continue;
    }
    // 均匀挑 cap 个：把缝分成 cap+1 段，取最接近分割点的候选
    for (let k = 1; k <= cap; k += 1) {
      const target = lo + (hi - lo) * (k / (cap + 1));
      let best = candidates[0];
      let bestDist = Math.abs(best - target);
      for (const midi of candidates) {
        const d = Math.abs(midi - target);
        if (d < bestDist) { best = midi; bestDist = d; }
      }
      dense.add(best);
    }
  }
  return [...dense].sort((a, b) => a - b);
}

/**
 * 从密音格取 windowSize 个连续音。
 * 低 tension：偏骨架音重合（守低区）；高 tension：偏高音区（色彩/过路音更多入选）。
 */
export function pickMelodyWindow(denseLattice, chordNotes, tension = 0, windowSize = 5, skeletonCount = 3) {
  const dense = Array.isArray(denseLattice) ? denseLattice : [];
  const size = Math.max(1, Math.floor(Number(windowSize)) || 5);
  if (dense.length <= size) return dense.slice();
  const chord = (chordNotes ?? []).filter(Number.isFinite);
  const chordSet = new Set(chord);
  const skCount = Math.max(0, Math.floor(Number(skeletonCount)) || 0);
  const skeletonSet = new Set(chord.slice(0, skCount));
  const t = clamp01(tension);
  const maxStart = dense.length - size;
  const loMidi = dense[0];
  const hiMidi = dense[dense.length - 1];
  const span = Math.max(1, hiMidi - loMidi);
  let bestStart = 0;
  let bestScore = -Infinity;
  for (let start = 0; start <= maxStart; start += 1) {
    let chordOverlap = 0;
    let skeletonOverlap = 0;
    let sum = 0;
    for (let i = 0; i < size; i += 1) {
      const midi = dense[start + i];
      sum += midi;
      if (chordSet.has(midi)) chordOverlap += 1;
      if (skeletonSet.has(midi)) skeletonOverlap += 1;
    }
    const meanNorm = ((sum / size) - loMidi) / span;
    // 低张力：骨架重合优先；高张力：音区上移优先（过路/色彩更多进入窗口）
    const score = (1 - t) * (skeletonOverlap * 2 + chordOverlap) + t * (meanNorm * size + chordOverlap * 0.25);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return dense.slice(bestStart, bestStart + size);
}

/**
 * 由 frame/和弦生成 melody 专属 5 音密格（option-1 A）。
 * pad/bass/texture 仍用 chord.notes；仅 mapping 在 species=melody 时读返回值。
 */
export function melodyNotesFromFrame(frame, chordNotes, cfg = CONFIG.harmony) {
  const latticeCfg = cfg.melodyLattice ?? {};
  const season = frame?.season;
  const root = frame?.skeleton?.root;
  const pcs = latticeCfg.scales?.[season] ?? [0, 2, 4, 5, 7, 9, 11];
  const maxPassing = latticeCfg.maxPassingPerGap ?? 2;
  const dense = denseLatticeFromChordNotes(chordNotes, root, pcs, maxPassing);
  const windowSize = latticeCfg.windowSize ?? 5;
  const skeletonCount = cfg.skeletonBranches ?? 3;
  return pickMelodyWindow(dense, chordNotes, frame?.tension, windowSize, skeletonCount);
}

// 骨架 + 当日色彩档 → 当日五枝音（harmonicFrame 形状见 docs §3，字段名契约不改）。
// 返回 { id, notes, melodyNotes, season, seasonName, skeletonBranches }：
// notes = 和弦音（三树共用）；melodyNotes = melody 密音格（张力滑窗）。
export function chordFromFrame(frame, cfg = CONFIG.harmony) {
  const k = cfg.skeletonBranches;
  const notes = [...frame.skeleton.notes.slice(0, k), ...frame.color.notes];
  return {
    id: `${frame.skeleton.id}·${frame.color.id}`,
    notes,
    melodyNotes: melodyNotesFromFrame(frame, notes, cfg),
    season: frame.season,
    seasonName: cfg.seasonNames[frame.season] ?? frame.season,
    skeletonBranches: k,
    tension: Number.isFinite(Number(frame.tension)) ? Number(frame.tension) : 0,
  };
}

// 家枝最近音级迁移：和弦从 oldChord 换到 newChord 时，每只鸟的家枝搬到
// 「自己旧枝音高在新和弦里的最近音级」所在的枝（差值相同则保低位）。
// 只在换季日调用（色彩档日变不触发）。输入 assignments: [{birdId, homeBranch}]；
// 返回 [{birdId, from, to, semitoneShift}]。
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
