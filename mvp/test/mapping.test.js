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
  unperchToRelease,
} from '../src/mapping.js';
import { CONFIG } from '../src/config.js';

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

test('事件→发声指令契约：perch 给 {midi, velocity}，unperch 给 {midi, durationSeconds}', () => {
  const note = perchToNote({ birdId: 0, branchId: 2, perchedOnBranch: 2 }, AM);
  assert.deepEqual(note, { midi: 64, velocity: CONFIG.mapping.velocityDuet });
  const rel = unperchToRelease({ birdId: 0, branchId: 2, dwellTime: 0.1 }, AM);
  assert.equal(rel.midi, 64);
  assert.equal(rel.durationSeconds, CONFIG.mapping.dwellMinAudible);
});

test('昼夜音频宏：白天更亮更响，夜晚更闷更轻', () => {
  const day = dayNightAudioMacros(1);
  const night = dayNightAudioMacros(0);
  assert.ok(day.filterCutoffHz > night.filterCutoffHz);
  assert.ok(day.gainScale > night.gainScale);
});
