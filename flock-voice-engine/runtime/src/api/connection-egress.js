const OVERFLOW_CODE = 4410;
const OVERFLOW_REASON = 'EGRESS_OVERFLOW';

export function createConnectionEgress({ socket, capacity = 256,
  onStateChange = null, onDelivered = null }) {
  if (!socket || typeof socket.send !== 'function') {
    throw new Error('EGRESS_SOCKET_REQUIRED');
  }
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error('EGRESS_CAPACITY_INVALID');
  }
  if (!(onStateChange === null || typeof onStateChange === 'function')) {
    throw new Error('EGRESS_OBSERVER_INVALID');
  }
  if (!(onDelivered === null || typeof onDelivered === 'function')) {
    throw new Error('EGRESS_OBSERVER_INVALID');
  }

  const queue = [];
  let started = false;
  let sending = false;
  let closed = false;
  let closeCode = null;
  let closeReason = null;

  function observe() {
    if (onStateChange === null) return;
    onStateChange(Object.freeze({
      capacityEntries: capacity,
      queuedEntries: queue.length,
      inFlight: sending,
      closed,
      closeCode,
      closeReason,
    }));
  }

  function close(code, reason) {
    if (closed) return;
    closed = true;
    closeCode = code;
    closeReason = reason;
    queue.length = 0;
    try { observe(); } catch { /* the owned recorder already failed closed */ }
    socket.close?.(code, reason);
  }

  function pump() {
    if (!started || sending || closed || queue.length === 0) return;
    sending = true;
    const entry = queue.shift();
    try { observe(); } catch { close(1011, 'EGRESS_OBSERVER_FAILED'); return; }
    try {
      socket.send(entry.wire, (error) => {
        sending = false;
        if (error) {
          close(1011, 'EGRESS_SEND_FAILED');
          return;
        }
        try {
          onDelivered?.(entry.frame);
          observe();
        } catch { close(1011, 'EGRESS_OBSERVER_FAILED'); return; }
        queueMicrotask(pump);
      });
    } catch {
      sending = false;
      close(1011, 'EGRESS_SEND_FAILED');
    }
  }

  return Object.freeze({
    enqueue(frame) {
      if (closed) return false;
      if (queue.length + (sending ? 1 : 0) >= capacity) {
        close(OVERFLOW_CODE, OVERFLOW_REASON);
        return false;
      }
      queue.push({ wire: JSON.stringify(frame), frame });
      try { observe(); } catch { close(1011, 'EGRESS_OBSERVER_FAILED'); return false; }
      if (started) queueMicrotask(pump);
      return true;
    },

    startWriter() {
      if (closed || started) return;
      started = true;
      pump();
    },

    close,
  });
}
