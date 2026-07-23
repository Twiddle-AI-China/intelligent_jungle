import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOCOL_VERSION,
  ROOT_REPLACE_PATH,
  rootReplacePatch,
} from '../src/protocol/v1.js';
import { createJournal } from '../src/world-session/journal.js';

function record(eventSeq, baseRevision, resultRevision, value = eventSeq) {
  return {
    eventSeq,
    baseRevision,
    resultRevision,
    patch: rootReplacePatch({ value }),
    domainEvents: [{ name: 'changed', payload: { value } }],
  };
}

test('builds the frozen v1 root-replacement shape without sharing input state', () => {
  const snapshot = { nested: { value: 1 } };
  const patch = rootReplacePatch(snapshot);
  snapshot.nested.value = 99;

  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(ROOT_REPLACE_PATH, '');
  assert.deepEqual(patch, [{
    op: 'replace',
    path: '',
    value: { nested: { value: 1 } },
  }]);
});

test('replays only a complete contiguous event and revision chain', () => {
  const journal = createJournal({ capacity: 4 });
  journal.append(record(1, 0, 1));
  journal.append(record(2, 1, 2));

  const replay = journal.replayAfter(0, 0);
  assert.deepEqual(replay.map(({ eventSeq }) => eventSeq), [1, 2]);
  replay[0].patch[0].value.value = 99;
  assert.equal(journal.replayAfter(0, 0)[0].patch[0].value.value, 1);

  assert.equal(journal.replayAfter(0, 7), null);
});

test('returns null instead of a partial replay after a capacity gap', () => {
  const journal = createJournal({ capacity: 2 });
  journal.append(record(1, 0, 1));
  journal.append(record(2, 1, 2));
  journal.append(record(3, 2, 3));

  assert.equal(journal.replayAfter(0, 0), null);
  assert.deepEqual(
    journal.replayAfter(1, 1).map(({ eventSeq }) => eventSeq),
    [2, 3],
  );
});

test('detects an internal event or revision discontinuity', () => {
  const eventGap = createJournal({ capacity: 4 });
  eventGap.append(record(1, 0, 1));
  eventGap.append(record(3, 1, 2));
  assert.equal(eventGap.replayAfter(0, 0), null);

  const revisionGap = createJournal({ capacity: 4 });
  revisionGap.append(record(1, 0, 1));
  revisionGap.append(record(2, 4, 5));
  assert.equal(revisionGap.replayAfter(0, 0), null);
});
