const DEFAULT_PRIORITIES = Object.freeze({
  manual: 20,
  computer: 30,
  midi: 30,
});

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Pure input-state arbitration. It deliberately knows nothing about Web MIDI,
 * AudioContext, models, or latent motion: those are separate owners.
 *
 * Higher-priority sources win. Sources at the same priority use last-note
 * priority, so releasing the newest key naturally resumes the previous one.
 */
export class PolyphonicInputRouter {
  constructor(priorities = DEFAULT_PRIORITIES, maxVoices = 4) {
    this.priorities = { ...DEFAULT_PRIORITIES, ...priorities };
    this.maxVoices = Math.max(1, Number(maxVoices) | 0);
    this.entries = new Map();
    this.order = 0;
  }

  press(id, input) {
    const kind = String(input.kind || 'manual');
    const entry = {
      id: String(id),
      kind,
      midi: finite(input.midi, 60),
      velocity: Math.max(0, Math.min(1, finite(input.velocity, 0.8))),
      priority: finite(input.priority, this.priorities[kind] ?? 0),
      order: ++this.order,
      deviceId: input.deviceId == null ? null : String(input.deviceId),
      channel: input.channel == null ? null : Number(input.channel),
    };
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    return entry;
  }

  release(id) {
    return this.entries.delete(String(id));
  }

  clearWhere(predicate) {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (!predicate(entry)) continue;
      this.entries.delete(id);
      changed = true;
    }
    return changed;
  }

  clear() {
    const changed = this.entries.size > 0;
    this.entries.clear();
    return changed;
  }

  has(id) {
    return this.entries.has(String(id));
  }

  active() {
    if (!this.entries.size) return [];
    const highestPriority = Math.max(...Array.from(this.entries.values(), (entry) => entry.priority));
    return Array.from(this.entries.values())
      .filter((entry) => entry.priority === highestPriority)
      .sort((left, right) => left.order - right.order)
      .slice(-this.maxVoices);
  }

  current() {
    return this.active().at(-1) ?? null;
  }
}

export { DEFAULT_PRIORITIES };
