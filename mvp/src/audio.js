// mvp/src/audio.js —— 音频层。voice 路由完全由 trees[].species 与
// audio.timbres[species].polyphonic 驱动；音区只经 trees[].registerOffset 进入 mapping。

import { CONFIG } from './config.js';
import * as mapping from './mapping.js';

export function createAudioEngine({ config = CONFIG, getChord } = {}) {
  const cfg = config;
  let ctx = null;
  let master = null;
  let filter = null;
  const sustainedVoices = new Map(); // birdId -> { species, oscillators, gain }
  const triggeredVoices = new Map(); // species -> [{ osc, gain }]
  const treeRegister = Object.fromEntries(cfg.trees.map((tree) => [tree.id, tree.registerOffset ?? 0]));
  const treeSpecies = Object.fromEntries(cfg.trees.map((tree) => [tree.id, tree.species]));

  async function start() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = cfg.audio.masterGain;
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cfg.audio.filterBaseHz;
      filter.Q.value = cfg.audio.filterQ;
      filter.connect(master);
      master.connect(ctx.destination);
    }
    await ctx.resume();
  }

  function applyDaylight(daylight) {
    if (!ctx) return;
    const macros = mapping.dayNightAudioMacros(daylight, cfg.audio);
    filter.frequency.setTargetAtTime(macros.filterCutoffHz, ctx.currentTime, 0.5);
    master.gain.setTargetAtTime(cfg.audio.masterGain * macros.gainScale, ctx.currentTime, 0.5);
  }

  function connectTimbre(gain, timbre) {
    const voiceFilter = ctx.createBiquadFilter();
    voiceFilter.type = 'lowpass';
    voiceFilter.frequency.value = cfg.audio.filterBaseHz * (timbre.filterScale ?? 1);
    voiceFilter.Q.value = cfg.audio.filterQ;
    gain.connect(voiceFilter);
    voiceFilter.connect(filter);
    return voiceFilter;
  }

  function stopSustainedVoice(birdId, immediate = false) {
    const voice = sustainedVoices.get(birdId);
    if (!voice) return;
    sustainedVoices.delete(birdId);
    const timbre = cfg.audio.timbres[voice.species];
    const t = ctx.currentTime;
    const release = immediate ? 0.01 : timbre.releaseSeconds;
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
    voice.gain.gain.linearRampToValueAtTime(0, t + release);
    for (const osc of voice.oscillators) osc.stop(t + release + 0.05);
  }

  function startSustainedVoice(species, birdId, { midi, velocity }) {
    const timbre = cfg.audio.timbres[species];
    stopSustainedVoice(birdId, true);
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity * timbre.sustainLevel, t + timbre.attackSeconds);
    connectTimbre(gain, timbre);

    const main = ctx.createOscillator();
    main.type = timbre.oscType;
    main.frequency.value = mapping.midiToFrequency(midi);
    main.connect(gain);
    const oscillators = [main];
    if (timbre.subOscMix > 0) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = mapping.midiToFrequency(midi - 12);
      const subGain = ctx.createGain();
      subGain.gain.value = timbre.subOscMix;
      sub.connect(subGain);
      subGain.connect(gain);
      oscillators.push(sub);
    }
    for (const osc of oscillators) osc.start(t);
    sustainedVoices.set(birdId, { species, oscillators, gain });
  }

  function silenceTriggered(species) {
    const voices = triggeredVoices.get(species) ?? [];
    const t = ctx.currentTime;
    for (const voice of voices) {
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
      voice.gain.gain.linearRampToValueAtTime(0, t + 0.03);
      try { voice.osc.stop(t + 0.08); } catch { /* already stopped */ }
    }
    triggeredVoices.delete(species);
  }

  function triggerVoice(species, { midi, velocity, durationSeconds }) {
    const timbre = cfg.audio.timbres[species];
    silenceTriggered(species); // polyphonic=false：同物种新触发让旧触发让位
    const repeats = Math.max(1, Math.floor(timbre.repeatCount ?? 1));
    const interval = Math.max(0, timbre.repeatIntervalSeconds ?? 0);
    const duration = Math.max(0.01, timbre.noteSeconds ?? durationSeconds ?? timbre.releaseSeconds);
    const voices = [];
    for (let index = 0; index < repeats; index += 1) {
      const t = ctx.currentTime + index * interval;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(velocity * timbre.sustainLevel, t + timbre.attackSeconds);
      gain.gain.exponentialRampToValueAtTime(0.001, t + timbre.attackSeconds + duration);
      connectTimbre(gain, timbre);
      const osc = ctx.createOscillator();
      osc.type = timbre.oscType;
      osc.frequency.value = mapping.midiToFrequency(midi);
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + timbre.attackSeconds + duration + 0.05);
      voices.push({ osc, gain });
    }
    triggeredVoices.set(species, voices);
  }

  // 晨鸣只是全局换景标记，沿用 pad 包络，不参与物种 voice 路由。
  function pluckMark({ midi, velocity, durationSeconds }, when) {
    const timbre = cfg.audio.timbres.pad;
    const t = when ?? ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(velocity, t + timbre.attackSeconds * 0.3);
    gain.gain.linearRampToValueAtTime(0, t + durationSeconds);
    const osc = ctx.createOscillator();
    osc.type = timbre.oscType;
    osc.frequency.value = mapping.midiToFrequency(midi);
    osc.connect(gain);
    gain.connect(filter);
    osc.start(t);
    osc.stop(t + durationSeconds + 0.05);
  }

  function attach(world) {
    world.on('perch', (event) => {
      if (!ctx) return;
      const species = treeSpecies[event.treeId];
      const timbre = cfg.audio.timbres[species];
      if (!timbre) return;
      applyDaylight(world.getSnapshot().daylight);
      const note = mapping.perchToNote(event, getChord(), cfg, treeRegister[event.treeId] ?? 0);
      if (timbre.polyphonic) startSustainedVoice(species, event.birdId, note);
      else triggerVoice(species, { ...note, durationSeconds: timbre.releaseSeconds });
    });
    world.on('unperch', (event) => {
      if (!ctx) return;
      const species = treeSpecies[event.treeId];
      const timbre = cfg.audio.timbres[species];
      if (!timbre?.polyphonic) return; // 触发型音色自然衰减
      mapping.unperchToRelease(event, getChord(), cfg, treeRegister[event.treeId] ?? 0);
      stopSustainedVoice(event.birdId);
    });
    world.on('dawn', () => {
      if (!ctx) return;
      const snapshot = world.getSnapshot();
      applyDaylight(snapshot.daylight);
      const chord = getChord();
      snapshot.birds.filter((bird) => bird.state === 'perched').forEach((bird, index) => {
        pluckMark({
          midi: mapping.noteFromBranch(bird.branchId, chord) + (treeRegister[bird.treeId] ?? 0),
          velocity: cfg.mapping.chorusVelocity,
          durationSeconds: cfg.mapping.chorusNoteSeconds,
        }, ctx.currentTime + index * cfg.mapping.chorusStaggerSeconds);
      });
    });
  }

  function describeVoices() {
    return Object.fromEntries(Object.entries(cfg.audio.timbres).map(([species, timbre]) => [species, { ...timbre }]));
  }

  function getRecordingTap() {
    return ctx && master ? { audioContext: ctx, sourceNode: master } : null;
  }

  return { start, attach, describeVoices, getRecordingTap, isRunning: () => !!ctx && ctx.state === 'running' };
}
