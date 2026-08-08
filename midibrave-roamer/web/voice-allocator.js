/** Stable mapping from active input ids to the selected model's backend rows. */
export class PolyphonicVoiceAllocator {
  constructor() {
    this.assignments = new Map();
  }

  plan(desiredEntries, targetRows) {
    const desired = desiredEntries.slice(0, targetRows.length);
    const desiredById = new Map(desired.map((entry) => [entry.id, entry]));
    const targetRowSet = new Set(targetRows);
    const actions = [];

    for (const [id, sounding] of this.assignments) {
      const entry = desiredById.get(id);
      if (entry && entry.order === sounding.order && targetRowSet.has(sounding.row)) continue;
      actions.push({
        type: targetRowSet.has(sounding.row) ? 'release' : 'panic',
        id,
        row: sounding.row,
      });
      this.assignments.delete(id);
    }

    const usedRows = new Set(Array.from(this.assignments.values(), (sounding) => sounding.row));
    for (const entry of desired) {
      if (this.assignments.has(entry.id)) continue;
      const row = targetRows.find((candidate) => !usedRows.has(candidate));
      if (row === undefined) break;
      const sounding = { id: entry.id, order: entry.order, row };
      this.assignments.set(entry.id, sounding);
      usedRows.add(row);
      actions.push({ type: 'hold', ...sounding, midi: entry.midi, velocity: entry.velocity });
    }
    return actions;
  }
}
