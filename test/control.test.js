import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT, USER, agentMayControl, controllerOf, createControlState, diveIn, drainAgentCommands, inInstrument, queueAgentCommand, release, releaseMaster, returnToScore, takeover, takeoverMaster } from '../src/control.js';

test('flocks default to agent control; takeover and release flip the reins', () => {
  const state = createControlState();
  assert.equal(controllerOf(state, 2), AGENT);
  takeover(state, 2);
  assert.equal(controllerOf(state, 2), USER);
  assert.equal(controllerOf(state, 1), AGENT, 'other flocks unaffected');
  release(state, 2);
  assert.equal(controllerOf(state, 2), AGENT);
});

test('master has its own rein', () => {
  const state = createControlState();
  assert.ok(agentMayControl(state, 'master'));
  takeoverMaster(state);
  assert.ok(!agentMayControl(state, 'master'));
  assert.ok(agentMayControl(state, 'flock', 0), 'flock reins independent of master');
  releaseMaster(state);
  assert.ok(agentMayControl(state, 'master'));
});

test('dive-in implies takeover; return keeps the user holding the rein', () => {
  const state = createControlState();
  diveIn(state, 3);
  assert.ok(inInstrument(state, 3));
  assert.ok(!inInstrument(state, 1));
  assert.equal(controllerOf(state, 3), USER);
  returnToScore(state);
  assert.ok(!inInstrument(state));
  assert.equal(controllerOf(state, 3), USER, 'rein returns only on explicit release');
});

test('queued agent commands are filtered by ownership at drain time', () => {
  const state = createControlState();
  queueAgentCommand(state, { target: 'flock', objectId: 0, op: 'setPattern' });
  queueAgentCommand(state, { target: 'flock', objectId: 1, op: 'setPattern' });
  queueAgentCommand(state, { target: 'master', op: 'setTempo' });
  takeover(state, 1);
  takeoverMaster(state);
  const allowed = drainAgentCommands(state);
  assert.equal(allowed.length, 1, 'user-held flock and master are silenced for the agent');
  assert.equal(allowed[0].objectId, 0);
  assert.equal(state.pendingAgentCommands.length, 0, 'queue empties on drain');
});

// §2.5 at_bar：命令等到绝对小节号到期才放行，未到期留在队列里。
test('at_bar commands wait for their bar; plain commands drain immediately', () => {
  const state = createControlState();
  queueAgentCommand(state, { target: 'flock', objectId: 0, op: 'setAnchor', atBar: 17 });
  queueAgentCommand(state, { target: 'master', op: 'setTempo' });
  let due = drainAgentCommands(state, 12);
  assert.equal(due.length, 1, 'plain command drains at the next bar boundary');
  assert.equal(due[0].op, 'setTempo');
  assert.equal(state.pendingAgentCommands.length, 1, 'future command stays queued');
  due = drainAgentCommands(state, 16);
  assert.equal(due.length, 0, 'still not due');
  due = drainAgentCommands(state, 17);
  assert.equal(due.length, 1, 'released exactly at at_bar');
  assert.equal(due[0].op, 'setAnchor');
  assert.equal(state.pendingAgentCommands.length, 0);
});

test('at_bar commands are ownership-filtered when they come due', () => {
  const state = createControlState();
  queueAgentCommand(state, { target: 'flock', objectId: 2, op: 'setRegister', atBar: 4 });
  takeover(state, 2);
  const due = drainAgentCommands(state, 4);
  assert.equal(due.length, 0, 'user-held flock silenced at due time');
  assert.equal(state.pendingAgentCommands.length, 0, 'due command leaves the queue even when silenced');
});

test('at_bar commands wait when no bar clock is available', () => {
  const state = createControlState();
  queueAgentCommand(state, { target: 'flock', objectId: 0, op: 'setDensity', atBar: 8 });
  queueAgentCommand(state, { target: 'master', op: 'setTempo' });
  const due = drainAgentCommands(state);
  assert.equal(due.length, 1, 'clock-less drain still releases plain commands');
  assert.equal(due[0].op, 'setTempo');
  assert.equal(state.pendingAgentCommands.length, 1, 'at_bar command keeps waiting');
});
