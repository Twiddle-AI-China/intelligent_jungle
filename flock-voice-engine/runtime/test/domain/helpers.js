// mvp/test/helpers.js —— 测试共享工具（非测试文件，node --test 不直接收集）。

// 确定性伪随机（mulberry32），供需要「自然随机但可复现」的用例
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 把 world 快进到指定（第 N 天的）相位；仅支持顺流推进
export function advanceTo(world, day, phase) {
  const target = (day - 1) + phase; // day 从 1 起
  const guard = 10 * 24 * 60 * 60 * 30; // 防死循环上限
  let n = 0;
  for (;;) {
    const s = world.getSnapshot();
    const now = (s.day - 1) + s.phase;
    if (now >= target || n > guard) return s;
    world.tick(1 / 30);
    n += 1;
  }
}
