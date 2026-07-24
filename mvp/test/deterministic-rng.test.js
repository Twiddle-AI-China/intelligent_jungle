import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCanonicalSeed,
  createDeterministicRng,
  deriveConductorSeed,
  DETERMINISTIC_RNG_ALGORITHM,
} from '../src/deterministic-rng.js';

const UINT32_MODULUS = 1n << 32n;
const MULBERRY_INCREMENT = 0x6D2B79F5;

function expectedState(seed, drawCount) {
  return Number(
    (BigInt(seed) + BigInt(drawCount) * BigInt(MULBERRY_INCREMENT))
      % UINT32_MODULUS,
  );
}

function assertErrorCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.message, code);
    return true;
  });
}

test('mulberry32-v1 固定向量与四次游标完全一致', () => {
  assert.equal(DETERMINISTIC_RNG_ALGORITHM, 'mulberry32-v1');
  const rng = createDeterministicRng(7);

  assert.deepEqual(
    [rng(), rng(), rng(), rng()],
    [
      0.011704753153026104,
      0.06195825757458806,
      0.97690763277933,
      0.6990287057124078,
    ],
  );
  assert.deepEqual(rng.exportState(), { state: 3031295963, drawCount: 4 });
});

test('canonical root seed 只接受非负零 uint32，派生 seed 使用冻结 XOR', () => {
  assert.equal(assertCanonicalSeed(0), 0);
  assert.equal(assertCanonicalSeed(7), 7);
  assert.equal(assertCanonicalSeed(0xffff_ffff), 0xffff_ffff);
  assert.equal(deriveConductorSeed(7), (7 ^ 0x9e3779b9) >>> 0);

  for (const seed of [
    -0,
    -1,
    1.5,
    '7',
    0x1_0000_0000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assertErrorCode(
      () => assertCanonicalSeed(seed),
      'INVALID_DETERMINISTIC_RNG_SEED',
    );
    assertErrorCode(
      () => deriveConductorSeed(seed),
      'INVALID_DETERMINISTIC_RNG_SEED',
    );
  }
});

test('构造器先校验 seed，再校验精确 state/drawCount own-key 状态', () => {
  assertErrorCode(
    () => createDeterministicRng('7', {}),
    'INVALID_DETERMINISTIC_RNG_SEED',
  );

  const invalidStates = [
    {},
    { state: 7 },
    { drawCount: 0 },
    { state: 7, drawCount: 0, extra: true },
    [],
    { state: -1, drawCount: 0 },
    { state: 0x1_0000_0000, drawCount: 0 },
    { state: 7.5, drawCount: 0 },
    { state: '7', drawCount: 0 },
    { state: 7, drawCount: -1 },
    { state: 7, drawCount: 0.5 },
    { state: 7, drawCount: '0' },
    { state: 7, drawCount: Number.MAX_SAFE_INTEGER + 1 },
  ];
  const symbolExtra = { state: 7, drawCount: 0 };
  symbolExtra[Symbol('extra')] = true;
  invalidStates.push(symbolExtra);
  const nonEnumerableExtra = { state: 7, drawCount: 0 };
  Object.defineProperty(nonEnumerableExtra, 'extra', { value: true });
  invalidStates.push(nonEnumerableExtra);
  for (const restoredState of invalidStates) {
    assertErrorCode(
      () => createDeterministicRng(7, restoredState),
      'INVALID_DETERMINISTIC_RNG_STATE',
    );
  }

  const inherited = Object.create({ state: 7, drawCount: 0 });
  assertErrorCode(
    () => createDeterministicRng(7, inherited),
    'INVALID_DETERMINISTIC_RNG_STATE',
  );

  let getterCalls = 0;
  const accessorState = {};
  Object.defineProperties(accessorState, {
    state: {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('must not invoke restored-state getter');
      },
    },
    drawCount: { enumerable: true, value: 0 },
  });
  assertErrorCode(
    () => createDeterministicRng(7, accessorState),
    'INVALID_DETERMINISTIC_RNG_STATE',
  );
  assert.equal(getterCalls, 0);
});

test('恢复游标必须与 seed 和 drawCount 的 BigInt 关系一致', () => {
  const resumed = createDeterministicRng(7, {
    state: 3663131633,
    drawCount: 2,
  });
  assert.equal(resumed(), 0.97690763277933);
  assert.deepEqual(resumed.exportState(), {
    state: expectedState(7, 3),
    drawCount: 3,
  });

  assertErrorCode(
    () => createDeterministicRng(7, {
      state: 3663131633,
      drawCount: 1,
    }),
    'INVALID_DETERMINISTIC_RNG_STATE',
  );
  assertErrorCode(
    () => createDeterministicRng(8, {
      state: 3663131633,
      drawCount: 2,
    }),
    'INVALID_DETERMINISTIC_RNG_STATE',
  );
});

test('接近 MAX_SAFE_INTEGER 的游标无浮点精度丢失', () => {
  const drawCount = Number.MAX_SAFE_INTEGER - 1;
  const rng = createDeterministicRng(7, {
    state: expectedState(7, drawCount),
    drawCount,
  });

  rng();
  assert.deepEqual(rng.exportState(), {
    state: expectedState(7, Number.MAX_SAFE_INTEGER),
    drawCount: Number.MAX_SAFE_INTEGER,
  });
});

test('MAX_SAFE_INTEGER 后的下一次 draw fail-closed 且不部分推进', () => {
  const drawCount = Number.MAX_SAFE_INTEGER;
  const rng = createDeterministicRng(7, {
    state: expectedState(7, drawCount),
    drawCount,
  });
  const before = rng.exportState();

  assertErrorCode(
    () => rng(),
    'INVALID_DETERMINISTIC_RNG_STATE',
  );
  assert.deepEqual(rng.exportState(), before);
});

test('导出状态冻结且不能反向改写 RNG closure', () => {
  const rng = createDeterministicRng(7);
  rng();
  const exported = rng.exportState();

  assert.equal(Object.isFrozen(exported), true);
  assert.throws(() => {
    exported.state = 0;
  }, TypeError);
  rng();
  assert.deepEqual(exported, {
    state: expectedState(7, 1),
    drawCount: 1,
  });
  assert.deepEqual(rng.exportState(), {
    state: expectedState(7, 2),
    drawCount: 2,
  });
});
