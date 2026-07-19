import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder, downloadBlob } from '../src/recorder.js';

class FakeMediaRecorder {
  static instances = [];

  static isTypeSupported(type) {
    return type === 'audio/webm;codecs=opus' || type === 'audio/webm';
  }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType ?? '';
    this.state = 'inactive';
    this.startCalls = 0;
    this.stopCalls = 0;
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    if (this.state !== 'inactive') throw new Error('already active');
    this.state = 'recording';
    this.startCalls += 1;
  }

  stop() {
    if (this.state !== 'recording') throw new Error('not active');
    this.state = 'inactive';
    this.stopCalls += 1;
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['bird-song'], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
}

function fakeGraph() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const destination = { stream: { getTracks: () => [track] } };
  const audioContext = { createMediaStreamDestination: () => destination };
  const sourceNode = {
    connected: [],
    disconnected: [],
    connect(node) { this.connected.push(node); },
    disconnect(node) { this.disconnected.push(node); },
  };
  return { audioContext, sourceNode, destination, track };
}

async function withMediaRecorder(value, run) {
  const original = globalThis.MediaRecorder;
  try {
    if (value === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = value;
    return await run();
  } finally {
    if (original === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = original;
  }
}

test('start/stop 录得 Blob，并优先选择 webm/opus', async () => {
  await withMediaRecorder(FakeMediaRecorder, async () => {
    FakeMediaRecorder.instances.length = 0;
    const graph = fakeGraph();
    const recorder = createRecorder(graph);
    assert.ok(recorder);
    assert.deepEqual(graph.sourceNode.connected, [graph.destination]);
    assert.equal(recorder.start(), true);
    assert.equal(recorder.isRecording(), true);

    const blob = await recorder.stop();
    assert.equal(recorder.isRecording(), false);
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, 'audio/webm;codecs=opus');
    assert.equal(await blob.text(), 'bird-song');
  });
});

test('不支持 MediaRecorder 或 MediaStream destination 时返回 null', async () => {
  await withMediaRecorder(undefined, async () => {
    assert.equal(createRecorder(fakeGraph()), null);
  });
  await withMediaRecorder(FakeMediaRecorder, async () => {
    assert.equal(createRecorder({ audioContext: {}, sourceNode: { connect() {} } }), null);
  });
});

test('重复 start 幂等，不会启动第二条录制', async () => {
  await withMediaRecorder(FakeMediaRecorder, async () => {
    FakeMediaRecorder.instances.length = 0;
    const recorder = createRecorder(fakeGraph());
    assert.equal(recorder.start(), true);
    assert.equal(recorder.start(), false);
    assert.equal(FakeMediaRecorder.instances[0].startCalls, 1);
    await recorder.stop();
  });
});

test('dispose 断开录音 tap、停止媒体轨道且可重复调用', async () => {
  await withMediaRecorder(FakeMediaRecorder, async () => {
    const graph = fakeGraph();
    const recorder = createRecorder(graph);
    recorder.dispose();
    recorder.dispose();
    assert.deepEqual(graph.sourceNode.disconnected, [graph.destination]);
    assert.equal(graph.track.stopped, true);
    assert.equal(recorder.isRecording(), false);
    assert.throws(() => recorder.start(), /disposed/);
  });
});

test('downloadBlob 在无 DOM 的 node 环境安全 no-op', () => {
  assert.equal(downloadBlob(new Blob(['x']), 'x.webm'), false);
});
