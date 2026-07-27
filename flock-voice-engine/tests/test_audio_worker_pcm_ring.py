from server.audio_worker.pcm_ring import WorkerPcmRings
import threading
import time


def test_master_and_split_publish_atomically_and_overflow_latches():
    rings = WorkerPcmRings(capacity_blocks=2)
    assert rings.try_publish(b"m0", b"s0", 0).accepted
    assert rings.try_publish(b"m1", b"s1", 1).accepted
    result = rings.try_publish(b"m2", b"s2", 2)
    assert result.code == "WORKER_PCM_RING_OVERFLOW"
    assert rings.degraded and len(rings.master) == len(rings.split) == 2
    assert rings.try_publish(b"m3", b"s3", 3).code == "WORKER_PCM_RING_STOPPED"


def test_pop_pair_preserves_global_order():
    rings = WorkerPcmRings()
    rings.try_publish(b"master", b"split", 100)
    master, split = rings.pop_pair()
    assert master.render_frame == split.render_frame == 100
    assert rings.headroom_blocks == 8


def test_concurrent_publish_and_pop_never_split_a_pair():
    rings = WorkerPcmRings(capacity_blocks=256)
    done = threading.Event()
    pairs = []

    def produce():
        for frame in range(100):
            assert rings.try_publish(str(frame).encode(), str(frame).encode(), frame).accepted
        done.set()

    def consume():
        while not done.is_set() or rings.master:
            pair = rings.pop_pair()
            if pair:
                pairs.append(pair)
            else:
                time.sleep(0)

    producer = threading.Thread(target=produce)
    consumer = threading.Thread(target=consume)
    producer.start(); consumer.start()
    producer.join(); consumer.join()
    assert [(master.render_frame, split.render_frame) for master, split in pairs] == [(i, i) for i in range(100)]
