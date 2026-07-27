import test from 'node:test';
import assert from 'node:assert/strict';

import { latentRoamerControlState } from '../src/ui/latent-roamer-legacy.js';

test('音色林地入口对已配置神经声部始终可见，并表达异步连接状态', () => {
  assert.deepEqual(
    latentRoamerControlState({ configured: true, connected: false, focused: false }),
    {
      hidden: false,
      disabled: true,
      label: '音色林地 · 连接中…',
      takesOver: false,
    },
  );
});

test('AGENT 神经声部显示接管入口，USER 神经声部显示直接入口', () => {
  assert.deepEqual(
    latentRoamerControlState({ configured: true, connected: true, focused: false }),
    {
      hidden: false,
      disabled: false,
      label: '进入音色林地（接管）',
      takesOver: true,
    },
  );
  assert.deepEqual(
    latentRoamerControlState({ configured: true, connected: true, focused: true }),
    {
      hidden: false,
      disabled: false,
      label: '进入音色林地',
      takesOver: false,
    },
  );
});

test('texture/drums 等未绑定神经音源的声部不显示音色林地入口', () => {
  assert.deepEqual(
    latentRoamerControlState({ configured: false, connected: true, focused: true }),
    { hidden: true, disabled: true, label: '', takesOver: false },
  );
});
