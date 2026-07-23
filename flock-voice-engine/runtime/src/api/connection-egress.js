const OVERFLOW_CODE = 4410;
const OVERFLOW_REASON = 'EGRESS_OVERFLOW';

export function createConnectionEgress({ socket, capacity = 256 }) {
  if (!socket || typeof socket.send !== 'function') {
    throw new Error('EGRESS_SOCKET_REQUIRED');
  }
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error('EGRESS_CAPACITY_INVALID');
  }

  const queue = [];
  let started = false;
  let sending = false;
  let closed = false;

  function close(code, reason) {
    if (closed) return;
    closed = true;
    queue.length = 0;
    socket.close?.(code, reason);
  }

  function pump() {
    if (!started || sending || closed || queue.length === 0) return;
    sending = true;
    const payload = queue.shift();
    try {
      socket.send(payload, (error) => {
        sending = false;
        if (error) {
          close(1011, 'EGRESS_SEND_FAILED');
          return;
        }
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
      queue.push(JSON.stringify(frame));
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
