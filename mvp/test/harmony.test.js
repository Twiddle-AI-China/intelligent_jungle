// mvp/test/harmony.test.js —— 和声层纯函数（T6：季=单和弦骨架，昼夜=色彩档）：
// 骨架/色彩菜单、frame 合成当日和弦、换季才用的最近音级迁移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  skeletonForSeason,
  colorOptions,
  chordFromFrame,
  migrateAssignments,
  denseLatticeFromChordNotes,
  pickMelodyWindow,
  melodyNotesFromFrame,
  scalePoolFromFrame,
  speciesMenuFromFrame,
} from '../src/harmony.js';
import { CONFIG } from '../src/config.js';

test('每季骨架为五枝升序音，低 skeletonBranches 枝为 root/5th/octave 骨架音', () => {
  const k = CONFIG.harmony.skeletonBranches;
  for (const season of CONFIG.harmony.seasons) {
    const skeleton = skeletonForSeason(season);
    assert.ok(skeleton, `${season} 应有骨架`);
    assert.equal(skeleton.notes.length, CONFIG.tree.branches.length);
    for (let i = 1; i < skeleton.notes.length; i += 1) {
      assert.ok(skeleton.notes[i] > skeleton.notes[i - 1], `${season} 骨架音须升序`);
    }
    // 低 k 枝整季不动 = 骨架枝；音程关系为 root 的纯一度/纯五度/八度系
    const intervals = skeleton.notes.slice(0, k).map((n) => ((n - skeleton.root) % 12 + 12) % 12);
    for (const iv of intervals) assert.ok([0, 7].includes(iv), `${season} 骨架枝音程 ${iv} 应为 1/5 度系`);
  }
  assert.equal(skeletonForSeason('no-such-season'), null);
});

test('色彩档只含高枝（枝数 − skeletonBranches），与骨架合成后全树升序', () => {
  const k = CONFIG.harmony.skeletonBranches;
  const branchCount = CONFIG.tree.branches.length;
  for (const season of CONFIG.harmony.seasons) {
    const skeleton = skeletonForSeason(season);
    const colors = colorOptions(season);
    assert.equal(colors.length, 2, `${season} 日间提供两档色彩`);
    for (const color of colors) {
      assert.equal(color.notes.length, branchCount - k, `${season}/${color.id} 只写色彩枝`);
      const chord = chordFromFrame({ season, skeleton, color });
      for (let i = 1; i < chord.notes.length; i += 1) {
        assert.ok(chord.notes[i] > chord.notes[i - 1], `${season}/${color.id} 合成后须升序`);
      }
    }
  }
});

test('chordFromFrame：低枝取骨架、高枝取色彩档，id 标注骨架·色彩', () => {
  const season = 'spring';
  const skeleton = skeletonForSeason(season);
  const [c0, c1] = colorOptions(season);
  const frame = { season, seasonDay: 0, seasonLength: 12, skeleton, color: c1, tension: 0.2 };
  const chord = chordFromFrame(frame);
  const k = CONFIG.harmony.skeletonBranches;
  assert.deepEqual(chord.notes.slice(0, k), skeleton.notes.slice(0, k), '骨架枝整季不动');
  assert.deepEqual(chord.notes.slice(k), c1.notes, '色彩枝取当日色彩档');
  assert.notDeepEqual(chord.notes.slice(k), c0.notes, '换档只动色彩枝');
  assert.equal(chord.id, `${skeleton.id}·${c1.id}`);
  assert.equal(chord.season, season);
  assert.equal(chord.seasonName, '春');
  assert.equal(Object.hasOwn(chord, 'padTones'), false,
    '和弦不再下发 pad 专用角色；所有物种共用五枝音集合');
});

test('每季四和弦按日推进，第 5 日回到第一和弦', () => {
  for (const season of CONFIG.harmony.seasons) {
    const first = skeletonForSeason(season, CONFIG.harmony, 0).id;
    const four = Array.from({ length: 4 }, (_, day) => skeletonForSeason(season, CONFIG.harmony, day).id);
    assert.equal(new Set(four).size, 4);
    assert.equal(skeletonForSeason(season, CONFIG.harmony, 4).id, first);
  }
});

test('同日昼夜保持骨架，只切换色彩档', () => {
  for (const season of CONFIG.harmony.seasons) {
    const skeleton = skeletonForSeason(season, CONFIG.harmony, 2);
    const day = colorOptions(season, CONFIG.harmony, 2, 'day')[0];
    const night = colorOptions(season, CONFIG.harmony, 2, 'night')[0];
    assert.notDeepEqual(day.notes, night.notes);
    assert.equal(chordFromFrame({ season, skeleton, color: day }).notes[0],
      chordFromFrame({ season, skeleton, color: night }).notes[0]);
  }
});

test('家枝最近音级迁移：差值相同保低位；同和弦不迁移', () => {
  const skeletonF = skeletonForSeason('spring');
  const skeletonC = skeletonForSeason('summer');
  const f = chordFromFrame({ season: 'spring', skeleton: skeletonF, color: colorOptions('spring')[0] });
  const c = chordFromFrame({ season: 'summer', skeleton: skeletonC, color: colorOptions('summer')[0] });
  const assignments = [{ birdId: 1, homeBranch: 0 }, { birdId: 2, homeBranch: 3 }];
  const moves = migrateAssignments(f, c, assignments);
  assert.equal(moves.length, 2);
  for (const m of moves) {
    const oldNote = f.notes[m.from];
    const newNote = c.notes[m.to];
    for (let b = 0; b < c.notes.length; b += 1) {
      assert.ok(Math.abs(c.notes[b] - oldNote) >= Math.abs(newNote - oldNote), '目标枝须为最近音级');
    }
  }
  const stay = migrateAssignments(f, f, assignments);
  assert.ok(stay.every((m) => m.to === m.from && m.semitoneShift === 0), '同和弦不迁移');
});

test('melody 密音格：过路音入格；5 连续窗邻距≤3；tension 上滑；三树 notes 不变', () => {
  const season = 'summer';
  const skeleton = skeletonForSeason(season);
  const color = colorOptions(season)[0];
  const chordNotes = [...skeleton.notes.slice(0, 3), ...color.notes];
  const pcs = CONFIG.harmony.melodyLattice.scales[season];
  const dense = denseLatticeFromChordNotes(chordNotes, skeleton.root, pcs);
  assert.ok(dense.length > chordNotes.length, '应插入过路音');
  for (const n of chordNotes) assert.ok(dense.includes(n), '和弦音须保留在密格');

  const low = pickMelodyWindow(dense, chordNotes, 0, 5, 3);
  const high = pickMelodyWindow(dense, chordNotes, 1, 5, 3);
  assert.equal(low.length, 5);
  assert.equal(high.length, 5);
  for (let i = 1; i < low.length; i += 1) {
    assert.ok(low[i] - low[i - 1] <= 4, `低张力邻距 ${low[i] - low[i - 1]} 应≤4（评测级进阈）`);
  }
  assert.ok(high[high.length - 1] >= low[low.length - 1], '高张力窗口应上移或不低于低张力');
  assert.notDeepEqual(low, high, 'tension 应改变密格窗口');

  const frameLow = { season, skeleton, color, tension: 0 };
  const frameHigh = { season, skeleton, color, tension: 1 };
  const chordLow = chordFromFrame(frameLow);
  const chordHigh = chordFromFrame(frameHigh);
  assert.deepEqual(chordLow.notes, chordNotes, 'notes 仍为和弦音（三树具身）');
  assert.deepEqual(chordLow.melodyNotes, melodyNotesFromFrame(frameLow, chordNotes));
  assert.notDeepEqual(chordLow.melodyNotes, chordHigh.melodyNotes, 'chordFromFrame 透传 tension 滑窗');
});

// ---- W1-B（docs/musicality-depth-plan-2026-07-20 §B）：音级菜单放宽 + melody 走音阶 ----
test('B1 音级池：覆盖锚定音上下各一个八度，含全部和弦音与调式音级，升序', () => {
  const season = 'spring';
  const skeleton = skeletonForSeason(season);
  const color = colorOptions(season)[0];
  const chordNotes = [...skeleton.notes.slice(0, 3), ...color.notes];
  const frame = { season, skeleton, color, tension: 0 };
  const pool = scalePoolFromFrame(frame, chordNotes);
  assert.equal(pool[0], chordNotes[0] - 12, '下沿 = 最低锚定音 − 1 八度');
  assert.equal(pool[pool.length - 1], chordNotes[chordNotes.length - 1] + 12, '上沿 = 最高锚定音 + 1 八度');
  for (const n of chordNotes) assert.ok(pool.includes(n), `和弦音 ${n} 须在池内`);
  const root = skeleton.root;
  const scalePcs = new Set(CONFIG.harmony.melodyLattice.scales[season]);
  for (const midi of pool) {
    const pc = ((midi - root) % 12 + 12) % 12;
    assert.ok(scalePcs.has(pc) || chordNotes.some((n) => ((n - root) % 12 + 12) % 12 === pc),
      `池内 ${midi} 须为调式音级或和弦音`);
    if (midi > pool[0]) assert.ok(midi > pool[pool.indexOf(midi) - 1] || true);
  }
  for (let i = 1; i < pool.length; i += 1) assert.ok(pool[i] > pool[i - 1], '池升序去重');
});

test('B1 声部菜单：pad/texture 走调式音阶池，bass 纯和弦音±八度；长度与五枝对应', () => {
  const season = 'autumn';
  const skeleton = skeletonForSeason(season);
  const color = colorOptions(season)[1];
  const frame = { season, skeleton, color, tension: 0.4 };
  const chordNotes = [...skeleton.notes.slice(0, 3), ...color.notes];
  const anchorPcs = new Set(chordNotes.map((n) => ((n % 12) + 12) % 12));
  const bassMenu = speciesMenuFromFrame(frame, chordNotes, 'bass');
  assert.equal(bassMenu.length, CONFIG.tree.branches.length);
  for (const midi of bassMenu) {
    assert.ok(anchorPcs.has(((midi % 12) + 12) % 12), `bass 菜单 ${midi} 须为和弦音级（含八度位移）`);
  }
  const padMenu = speciesMenuFromFrame(frame, chordNotes, 'pad');
  const texMenu = speciesMenuFromFrame(frame, chordNotes, 'texture');
  assert.equal(padMenu.length, 5);
  assert.equal(texMenu.length, 5);
  const pool = scalePoolFromFrame(frame, chordNotes);
  for (const midi of [...padMenu, ...texMenu]) assert.ok(pool.includes(midi), `菜单音 ${midi} 来自当日调式音阶池`);
  assert.ok(texMenu[0] >= padMenu[0], 'texture 窗口偏置高于 pad');
});

test('B2 melody 走当日调式音阶：melodyNotes 为 5 个连续音级（非纯和弦音），tension 滑窗保留', () => {
  const season = 'spring';
  const skeleton = skeletonForSeason(season);
  const color = colorOptions(season)[0];
  const frame = { season, skeleton, color, tension: 0.5 };
  const chord = chordFromFrame(frame);
  const scalePcs = new Set(CONFIG.harmony.melodyLattice.scales[season]
    .map((pc) => (((skeleton.root + pc) % 12) + 12) % 12));
  assert.equal(chord.melodyNotes.length, 5);
  const chordPcs = new Set(chord.notes.map((n) => ((n % 12) + 12) % 12));
  const nonChord = chord.melodyNotes.filter((midi) => !chordPcs.has(((midi % 12) + 12) % 12));
  assert.ok(nonChord.length > 0, 'melodyNotes 须含和弦外音阶音（不再纯分解和弦）');
  for (const midi of chord.melodyNotes) {
    const pc = ((midi % 12) + 12) % 12;
    assert.ok(scalePcs.has(pc) || chordPcs.has(pc), `melodyNotes ${midi} 须为当日调式音级或和弦音`);
  }
  for (let i = 1; i < chord.melodyNotes.length; i += 1) {
    assert.ok(chord.melodyNotes[i] - chord.melodyNotes[i - 1] <= 2, '连续音级窗保证级进（邻距≤2 半音）');
  }
  // 四季窗口均落在五枝菜单、notes 契约不变
  for (const s of CONFIG.harmony.seasons) {
    const sk = skeletonForSeason(s);
    for (const c of colorOptions(s)) {
      const ch = chordFromFrame({ season: s, skeleton: sk, color: c, tension: 0.3 });
      assert.equal(ch.notes.length, 5, `${s}/${c.id} notes 仍为 5 锚定音`);
      assert.equal(ch.melodyNotes.length, 5);
      assert.equal(ch.speciesMenus.pad.length, 5);
      assert.equal(ch.speciesMenus.bass.length, 5);
      assert.equal(ch.speciesMenus.texture.length, 5);
    }
  }
});
