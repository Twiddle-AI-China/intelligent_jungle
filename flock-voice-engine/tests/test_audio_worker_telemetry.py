import math

from server.audio_worker.telemetry_queue import TelemetryQueue


def sample(**updates):
    value = {"workerReady": True, "recovering": False, "pcmHeadroomBlocks": 8, "queueDepth": 0,
             "renderP50Ms": 1.0, "renderP95Ms": 2.0, "renderP99Ms": 3.0,
             "blockDurationMs": 92.8, "recentUnderruns": 0, "unifiedMemoryFreeBytes": 100,
             "lateFrames": 0, "degraded": False,
             "rowMasterContributionPeakAbs": [0.1] * 5}
    value.update({"appliedCommandSeq": 0, "lastReplaceAppliedCommandSeq": 0})
    value["unifiedMemoryFreeBytes"] = str(value["unifiedMemoryFreeBytes"])
    value.update(updates)
    return value


def test_invalid_or_nan_sample_cannot_claim_health():
    queue = TelemetryQueue()
    assert not queue.offer({"workerReady": True})
    assert not queue.offer(sample(renderP99Ms=math.nan))
    assert queue.peek() is None


def test_capacity_coalesces_and_degraded_latches_until_ack():
    queue = TelemetryQueue(capacity=2)
    queue.offer(sample(queueDepth=1))
    queue.offer(sample(queueDepth=2))
    queue.offer(sample(queueDepth=3))
    degraded = sample(degraded=True, degradedReason="WORKER_PCM_RING_OVERFLOW")
    queue.offer(degraded)
    assert queue.peek()["degraded"] is True
    queue.acknowledge(degraded)
    assert queue.peek()["degraded"] is False
