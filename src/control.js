// 接管状态机：controller ∈ {AGENT, USER} × view ∈ {SCORE, INSTRUMENT(flockId)}。
// 「接管不是切换模式，而是把缰绳从 agent 手里拿过来；松手可以还回去」——
// 所以这里只有所有权与视图，没有别的模式开关。agent 命令一律在 bar 边界生效。

export const AGENT = 'AGENT';
export const USER = 'USER';

export function createControlState() {
  return {
    view: { name: 'score', flockId: null },
    master: AGENT,
    flocks: new Map(),
    pendingAgentCommands: [],
  };
}

export function controllerOf(state, flockId) {
  return state.flocks.get(flockId) ?? AGENT;
}

export function takeover(state, flockId) {
  state.flocks.set(flockId, USER);
  return USER;
}

// 交还：agent 恢复控制，以当前 pattern 为新基础（状态机不回滚任何内容）。
export function release(state, flockId) {
  state.flocks.set(flockId, AGENT);
  return AGENT;
}

export function takeoverMaster(state) { state.master = USER; return USER; }
export function releaseMaster(state) { state.master = AGENT; return AGENT; }

// 双击下潜隐含接管；返回编排层后缰绳仍在用户手里，直到显式交还。
export function diveIn(state, flockId) {
  takeover(state, flockId);
  state.view = { name: 'instrument', flockId };
  return state.view;
}

export function returnToScore(state) {
  state.view = { name: 'score', flockId: null };
  return state.view;
}

export function inInstrument(state, flockId = null) {
  if (state.view.name !== 'instrument') return false;
  return flockId === null || state.view.flockId === flockId;
}

// Agent 命令闸门：用户接管的对象对 agent 静默（不报错——G7 韧性要求界面永不因 agent 出错）。
export function agentMayControl(state, target, flockId = null) {
  if (target === 'master') return state.master === AGENT;
  return controllerOf(state, flockId) === AGENT;
}

// 结构变化节拍化：agent 命令先排队，bar 边界统一放行。
// 入队时不判权限，出队时判——接管发生在排队之后也必须拦住。
export function queueAgentCommand(state, command) {
  state.pendingAgentCommands.push(command);
  return state.pendingAgentCommands.length;
}

export function drainAgentCommands(state) {
  const commands = state.pendingAgentCommands;
  state.pendingAgentCommands = [];
  return commands.filter((command) => (
    command.target === 'master'
      ? agentMayControl(state, 'master')
      : agentMayControl(state, 'flock', command.objectId)
  ));
}
