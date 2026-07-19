// mvp/src/harmony.js —— 和声层（docs/harmony-season-redesign.md，纯函数，无状态）。
// 季 = 单和弦骨架（低 skeletonBranches 枝整季不动），昼夜 = 高枝色彩档明暗；
// 换季才做家枝最近音级大迁移（voice-leading），日内色彩变化不迁移。
// 本层只有音乐词汇（骨架/色彩/音级/MIDI），不知道生态细节；world 也不知道本层存在——
// 接线在 conductor（agent.js）与 main.js。

import { CONFIG } from './config.js';

// 当季骨架：{ id, root, notes: [5 个 MIDI，按音高升序] }（整季不变；未知季返回 null）
export function skeletonForSeason(season, cfg = CONFIG.harmony) {
  const skeleton = cfg.bySeason[season]?.skeleton;
  return skeleton ? { id: skeleton.id, root: skeleton.root, notes: [...skeleton.notes] } : null;
}

// 当季色彩档菜单：[{ id, notes: [高枝色彩音] }]（只含色彩枝，长度 = 枝数 − skeletonBranches）
export function colorOptions(season, cfg = CONFIG.harmony) {
  return (cfg.bySeason[season]?.colors ?? []).map((color) => ({ id: color.id, notes: [...color.notes] }));
}

// 骨架 + 当日色彩档 → 当日五枝音（harmonicFrame 形状见 docs §3，字段名契约不改）。
// 返回 { id, notes, season, seasonName, skeletonBranches }：低枝取骨架、高枝取色彩档。
export function chordFromFrame(frame, cfg = CONFIG.harmony) {
  const k = cfg.skeletonBranches;
  const notes = [...frame.skeleton.notes.slice(0, k), ...frame.color.notes];
  return {
    id: `${frame.skeleton.id}·${frame.color.id}`,
    notes,
    season: frame.season,
    seasonName: cfg.seasonNames[frame.season] ?? frame.season,
    skeletonBranches: k,
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
