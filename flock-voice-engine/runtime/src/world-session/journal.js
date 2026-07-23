export function createJournal({ capacity = 256 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error('JOURNAL_CAPACITY_INVALID');
  }

  const records = [];

  return Object.freeze({
    append(record) {
      records.push(structuredClone(record));
      if (records.length > capacity) {
        records.splice(0, records.length - capacity);
      }
    },

    replayAfter(lastEventSeq, lastRevision) {
      const replay = records.filter((record) => (
        record.eventSeq > lastEventSeq
      ));
      if (!replay.length) return [];
      if (
        replay[0].eventSeq !== lastEventSeq + 1
        || replay[0].baseRevision !== lastRevision
      ) {
        return null;
      }
      for (let index = 1; index < replay.length; index += 1) {
        if (
          replay[index].eventSeq !== replay[index - 1].eventSeq + 1
          || replay[index].baseRevision !== replay[index - 1].resultRevision
        ) {
          return null;
        }
      }
      return structuredClone(replay);
    },

    clear() {
      records.length = 0;
    },
  });
}
