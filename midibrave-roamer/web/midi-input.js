function channelKey(deviceId, channel) {
  return `${deviceId}\u0000${channel}`;
}

function noteId(deviceId, channel, note) {
  return `midi:${deviceId}:${channel}:${note}`;
}

/** Translate raw Web MIDI messages into normalized router operations. */
export class MidiInputController {
  constructor(router, { normalizeMidi = Number } = {}) {
    this.router = router;
    this.normalizeMidi = normalizeMidi;
    this.sustainChannels = new Set();
    this.deferredNoteOffs = new Map();
  }

  handleMessage(deviceId, bytes) {
    const [status, data1, data2 = 0] = bytes;
    const command = status & 0xf0;
    const channel = status & 0x0f;
    const key = channelKey(deviceId, channel);
    const id = noteId(deviceId, channel, data1);

    if (command === 0x90 && data2 > 0) {
      this.deferredNoteOffs.delete(id);
      this.router.press(id, {
        kind: 'midi',
        midi: this.normalizeMidi(data1),
        velocity: data2 / 127,
        deviceId,
        channel,
      });
      return true;
    }
    if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      if (this.sustainChannels.has(key)) {
        this.deferredNoteOffs.set(id, key);
        return false;
      }
      return this.router.release(id);
    }
    if (command !== 0xb0) return false;
    if (data1 === 64) {
      if (data2 >= 64) {
        this.sustainChannels.add(key);
        return false;
      }
      this.sustainChannels.delete(key);
      return this.releaseDeferred(key);
    }
    if (data1 === 120 || data1 === 123) return this.panicChannel(deviceId, channel);
    if (data1 === 121) {
      this.sustainChannels.delete(key);
      return this.releaseDeferred(key);
    }
    return false;
  }

  releaseDeferred(key) {
    let changed = false;
    for (const [id, noteKey] of this.deferredNoteOffs) {
      if (noteKey !== key) continue;
      this.deferredNoteOffs.delete(id);
      changed = this.router.release(id) || changed;
    }
    return changed;
  }

  panicChannel(deviceId, channel) {
    const key = channelKey(deviceId, channel);
    this.sustainChannels.delete(key);
    for (const [id, noteKey] of this.deferredNoteOffs) {
      if (noteKey === key) this.deferredNoteOffs.delete(id);
    }
    return this.router.clearWhere((entry) => entry.kind === 'midi'
      && entry.deviceId === deviceId && entry.channel === channel);
  }

  disconnectMissing(connectedIds) {
    let changed = this.router.clearWhere((entry) => entry.kind === 'midi'
      && !connectedIds.has(entry.deviceId));
    for (const key of Array.from(this.sustainChannels)) {
      if (!connectedIds.has(key.split('\u0000', 1)[0])) this.sustainChannels.delete(key);
    }
    for (const [id, key] of this.deferredNoteOffs) {
      if (!connectedIds.has(key.split('\u0000', 1)[0])) this.deferredNoteOffs.delete(id);
    }
    return changed;
  }

  releaseAll() {
    this.clearState();
    return this.router.clearWhere((entry) => entry.kind === 'midi');
  }

  clearState() {
    this.sustainChannels.clear();
    this.deferredNoteOffs.clear();
  }
}

export { channelKey, noteId };
