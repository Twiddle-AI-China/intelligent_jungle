// mvp/test/mapping.test.js —— 映射层纯函数：力度三档、驻留→时值、枝→音高（当日和弦）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteFromBranch,
  midiToFrequency,
  velocityFromPerchCount,
  durationFromDwell,
  dayNightAudioMacros,
  perchToNote,
  padVoicingAssignments,
  pitchBranchIdFromEvent,
  unperchToRelease,
} from '../src/mapping.js';
import { CONFIG } from '../src/config.js';
import { chordFromFrame, colorOptions, skeletonForSeason } from '../src/harmony.js';

// 当日和弦夹具：Am = A3 C4 E4 A4 C5（harmony.js 的 spring[3]）
const AM = { id: 'Am', notes: [57, 60, 64, 69, 72], season: 'spring', seasonName: '春' };

test('力度三档：同枝 1/2/3+ 只 → solo/duet/choir，0 只不发声', () => {
  assert.equal(velocityFromPerchCount(0), 0);
  assert.equal(velocityFromPerchCount(1), CONFIG.mapping.velocitySolo);
  assert.equal(velocityFromPerchCount(2), CONFIG.mapping.velocityDuet);
  assert.equal(velocityFromPerchCount(3), CONFIG.mapping.velocityChoir);
  assert.equal(velocityFromPerchCount(7), CONFIG.mapping.velocityChoir);
  assert.ok(CONFIG.mapping.velocitySolo < CONFIG.mapping.velocityDuet);
  assert.ok(CONFIG.mapping.velocityDuet < CONFIG.mapping.velocityChoir);
});

test('驻留→时值：夹在最短可闻与最长时值之间', () => {
  assert.equal(durationFromDwell(0), 0);
  assert.equal(durationFromDwell(-1), 0);
  assert.equal(durationFromDwell(0.01), CONFIG.mapping.dwellMinAudible);
  assert.equal(durationFromDwell(2.5), 2.5);
  assert.equal(durationFromDwell(999), CONFIG.mapping.dwellMaxDuration);
});

test('枝→音高：取当日和弦对应枝位的音，越界夹取', () => {
  assert.equal(noteFromBranch(0, AM), 57); // A3
  assert.equal(noteFromBranch(1, AM), 60); // C4
  assert.equal(noteFromBranch(2, AM), 64); // E4
  assert.equal(noteFromBranch(3, AM), 69); // A4
  assert.equal(noteFromBranch(4, AM), 72); // C5
  assert.equal(noteFromBranch(99, AM), 72);
  assert.equal(midiToFrequency(69), 440);
});

test('melody 走 melodyNotes；其它声部仍走 chord.notes', () => {
  const chord = {
    ...AM,
    melodyNotes: [60, 62, 64, 65, 67],
  };
  assert.equal(noteFromBranch(1, chord, 'melody'), 62);
  assert.equal(noteFromBranch(1, chord, 'pad'), 60);
  assert.equal(noteFromBranch(1, chord, 'bass'), 60);
  assert.equal(noteFromBranch(1, chord), 60, '缺省 species 保持旧契约=和弦音');
  const perch = perchToNote({ birdId: 0, treeId: 'melody', branchId: 1, perchedOnBranch: 1 }, chord);
  assert.equal(perch.midi, 62);
  const padPerch = perchToNote({ birdId: 0, treeId: 'pad', branchId: 1, perchedOnBranch: 1 }, chord);
  assert.equal(padPerch.midi, 60);
});

test('W1-B：speciesMenus 存在时 pad/bass/texture 走放宽菜单，缺省回退 chord.notes', () => {
  const chord = {
    ...AM,
    speciesMenus: {
      pad: [41, 45, 48, 53, 57],
      bass: [29, 36, 41, 45, 48],
      texture: [60, 62, 64, 67, 69],
    },
  };
  assert.equal(noteFromBranch(0, chord, 'pad'), 41, 'pad 走 speciesMenus.pad');
  assert.equal(noteFromBranch(4, chord, 'bass'), 48, 'bass 走 speciesMenus.bass');
  assert.equal(noteFromBranch(2, chord, 'texture'), 64, 'texture 走 speciesMenus.texture');
  assert.equal(noteFromBranch(0, chord), 57, '缺省 species 仍走 chord.notes（旧契约）');
  assert.equal(noteFromBranch(0, chord, 'melody'), 57, 'melody 无 melodyNotes 时回退 notes');
  const partial = { ...AM, speciesMenus: { pad: [41, 45, 48, 53, 57] } };
  assert.equal(noteFromBranch(0, partial, 'bass'), 57, '菜单缺的声部回退 chord.notes');
});

test('事件→发声指令契约：perch 给 {midi, velocity}，unperch 给 {midi, durationSeconds}', () => {
  const note = perchToNote({ birdId: 0, branchId: 2, perchedOnBranch: 2 }, AM);
  assert.deepEqual(note, { midi: 64, velocity: CONFIG.mapping.velocityDuet });
  const rel = unperchToRelease({ birdId: 0, branchId: 2, dwellTime: 0.1 }, AM);
  assert.equal(rel.midi, 64);
  assert.equal(rel.durationSeconds, CONFIG.mapping.dwellMinAudible);
});

test('Sequence v2 发声只读 pitchBranchId；stepIndex 只表示时间且 0–4 branchId 兼容', () => {
  const first = perchToNote({
    treeId: 'bass', branchId: 0, pitchBranchId: 0, stepIndex: 0, perchedOnBranch: 1,
  }, AM);
  const later = perchToNote({
    treeId: 'bass', branchId: 0, pitchBranchId: 0, stepIndex: 15, perchedOnBranch: 1,
  }, AM);
  assert.equal(first.midi, AM.notes[0], '显式音高枝 0 = 根音，时间位不改音高');
  assert.equal(later.midi, first.midi, '同一音高枝沿时间轴外移，音高保持不变');

  const legacy = perchToNote({ treeId: 'bass', branchId: 4, perchedOnBranch: 1 }, AM);
  assert.equal(legacy.midi, AM.notes[4], '没有 pitchBranchId 时仍兼容统一音高枝');
  assert.equal(pitchBranchIdFromEvent({ pitchBranchId: 2, branchId: 0 }), 2);
  assert.equal(pitchBranchIdFromEvent({ branchId: 3 }), 3);

  const release = unperchToRelease({
    treeId: 'melody', branchId: 0, pitchBranchId: 3, stepIndex: 7, dwellTime: 2,
  }, { ...AM, melodyNotes: [60, 62, 64, 65, 67] });
  assert.equal(release.midi, 65);
  assert.equal(release.durationSeconds, 2);
});

test('pad 聚合落位严格枝=note：同枝同音，换和弦只作本枝最近八度连接', () => {
  const perches = [
    { birdId: 0, branchId: 0, perchedOnBranch: 2 },
    { birdId: 1, branchId: 0, perchedOnBranch: 2 },
    { birdId: 2, branchId: 2, perchedOnBranch: 1 },
  ];
  const first = padVoicingAssignments(perches, AM, { minMidi: 52, maxMidi: 76 });
  assert.equal(first.length, 3);
  assert.equal(first[0].midi, first[1].midi, '同枝两鸟诚实发同一枝音，不补写和弦角色');
  assert.equal(first[0].midi % 12, AM.notes[0] % 12);
  assert.equal(first[2].midi % 12, AM.notes[2] % 12);
  assert.ok(first.every((entry) => entry.midi >= 52 && entry.midi <= 76), '限制在 pad 低—中音区');
  const previous = new Map(first.map((entry) => [entry.birdId, entry.midi]));
  const nextChord = { ...AM, notes: [55, 60, 64, 67, 72] };
  const next = padVoicingAssignments(perches, nextChord, { minMidi: 52, maxMidi: 76, previous });
  assert.ok(next.every((entry) => Math.abs(entry.midi - previous.get(entry.birdId)) <= 7),
    '换色彩时选择最近八度，形成缓慢内部移动而非大跳');
  const rootCluster = padVoicingAssignments(perches.map((entry) => ({ ...entry, branchId: 0 })), AM, {
    minMidi: CONFIG.audio.timbres.pad.voicingRange[0],
    maxMidi: CONFIG.audio.timbres.pad.voicingRange[1],
  });
  assert.equal(new Set(rootCluster.map((entry) => entry.midi)).size, 1,
    '三鸟同枝允许塌成同音，这是诚实生态结果');
});

test('pad 撤路线 A：任意家枝分布均逐鸟回声本枝，跨帧八度稳定', () => {
  const skeleton = skeletonForSeason('spring');
  const [natural, , , ninth] = colorOptions('spring');
  const chord = chordFromFrame({ season: 'spring', skeleton, color: natural, tension: 0 });
  const perches = [
    { birdId: 9, branchId: 0, perchedOnBranch: 1 },
    { birdId: 3, branchId: 2, perchedOnBranch: 2 },
    { birdId: 7, branchId: 2, perchedOnBranch: 2 },
  ];
  const options = {
    minMidi: CONFIG.audio.timbres.pad.voicingRange[0],
    maxMidi: CONFIG.audio.timbres.pad.voicingRange[1],
  };
  // W1-B 新契约：枝 i 发当日放宽菜单（speciesMenus.pad）第 i 音（±八度连接），不再锚定纯和弦音。
  const menu = chord.speciesMenus.pad;
  assert.equal(menu.length, 5, 'pad 菜单与五枝一一对应');
  const first = padVoicingAssignments(perches, chord, options);
  assert.deepEqual(first.map((entry) => entry.midi), [menu[2], menu[2], menu[0]],
    '枝 {0,2,2} 诚实发当日菜单第 0/2 音，不凭空补其它音');
  assert.deepEqual(first.map((entry) => entry.role), ['branch-2', 'branch-2', 'branch-0']);
  assert.equal(new Set(first.filter((entry) => entry.branchId === 2)
    .map((entry) => entry.midi)).size, 1, '同枝同音：同枝多鸟塌成同音是诚实生态结果');

  const previous = new Map(first.map((entry) => [entry.birdId, { midi: entry.midi, role: entry.role }]));
  const stable = padVoicingAssignments([...perches].reverse(), chord, { ...options, previous });
  assert.deepEqual(stable.map(({ birdId, midi, role }) => ({ birdId, midi, role })),
    first.map(({ birdId, midi, role }) => ({ birdId, midi, role })), '输入顺序变化不扰动长驻鸟角色');

  const ninthChord = chordFromFrame({ season: 'spring', skeleton, color: ninth, tension: 0.3 });
  const changed = padVoicingAssignments(perches, ninthChord, { ...options, previous });
  assert.deepEqual(changed.map((entry) => entry.role), first.map((entry) => entry.role), '换色彩不改物理枝角色');
  for (const entry of changed) {
    assert.equal(entry.midi % 12, noteFromBranch(entry.branchId, ninthChord, 'pad') % 12,
      '换色彩后仍诚实发当日菜单本枝音（仅八度连接），不凭空进别的音级');
  }

  const colorBird = [{ birdId: 12, branchId: 3, perchedOnBranch: 1 }];
  const beforeColor = padVoicingAssignments(colorBird, chord, options)[0];
  const afterColor = padVoicingAssignments(colorBird, ninthChord, options)[0];
  assert.equal(beforeColor.midi % 12, noteFromBranch(3, chord, 'pad') % 12);
  assert.equal(afterColor.midi % 12, noteFromBranch(3, ninthChord, 'pad') % 12,
    '只有鸟真栖在色彩枝，色彩档变化才进入 pad');
});

test('昼夜音频宏：白天更亮更响，夜晚更闷更轻', () => {
  const day = dayNightAudioMacros(1);
  const night = dayNightAudioMacros(0);
  assert.ok(day.filterCutoffHz > night.filterCutoffHz);
  assert.ok(day.gainScale > night.gainScale);
});

test('bass 与其他声部共用 0–4 音高枝', () => {
  assert.equal(noteFromBranch(0, AM, 'bass'), AM.notes[0], '低枝=根音');
  assert.equal(noteFromBranch(1, AM, 'bass'), AM.notes[1]);
  assert.equal(noteFromBranch(2, AM, 'bass'), AM.notes[2]);
  const withMenu = {
    ...AM,
    speciesMenus: { bass: [29, 36, 41, 45, 48] },
  };
  assert.equal(noteFromBranch(0, withMenu, 'bass'), 29, '低枝走菜单根');
  assert.equal(noteFromBranch(4, withMenu, 'bass'), 48);
});
