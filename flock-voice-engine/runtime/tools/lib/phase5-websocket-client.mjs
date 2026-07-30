import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  if (body.length > MAX_MESSAGE_BYTES) throw fail('PHASE5_WS_FRAME_TOO_LARGE');
  const lengthBytes = body.length < 126 ? 0 : body.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (lengthBytes === 0 ? body.length : lengthBytes === 2 ? 126 : 127);
  if (lengthBytes === 2) header.writeUInt16BE(body.length, 2);
  if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(body.length), 2);
  const maskOffset = 2 + lengthBytes;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, masked]);
}

export default class Phase5WebSocket extends EventEmitter {
  static OPEN = OPEN;
  static CLOSED = CLOSED;

  constructor(address, { origin, headers = {} } = {}) {
    super();
    this.readyState = 0;
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentBytes = 0;
    this._fragmentOpcode = null;
    this._closeCode = 1006;
    this._closeReason = Buffer.alloc(0);
    this._closeEmitted = false;
    this._sentClose = false;
    this._connect(address, origin, headers);
  }

  _connect(address, origin, extraHeaders) {
    let url;
    try {
      url = new URL(address);
    } catch (error) {
      queueMicrotask(() => this.emit('error', error));
      return;
    }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
      queueMicrotask(() => this.emit('error', fail('PHASE5_WS_URL_INVALID')));
      return;
    }
    const key = randomBytes(16).toString('base64');
    const transport = url.protocol === 'wss:' ? https : http;
    const request = transport.request({
      protocol: url.protocol === 'wss:' ? 'https:' : 'http:',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'wss:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...(origin ? { Origin: origin } : {}),
        ...extraHeaders,
      },
    });
    request.once('response', (response) => {
      response.resume();
      this.emit('error', fail('PHASE5_WS_UPGRADE_REJECTED'));
    });
    request.once('error', (error) => this.emit('error', error));
    request.once('upgrade', (response, socket, head) => {
      const expected = createHash('sha1').update(key + GUID).digest('base64');
      if (response.statusCode !== 101
          || String(response.headers.upgrade).toLowerCase() !== 'websocket'
          || response.headers['sec-websocket-accept'] !== expected
          || response.headers['sec-websocket-protocol'] !== undefined
          || response.headers['sec-websocket-extensions'] !== undefined) {
        socket.destroy();
        this.emit('error', fail('PHASE5_WS_UPGRADE_INVALID'));
        return;
      }
      this._socket = socket;
      this.readyState = OPEN;
      socket.on('data', (chunk) => this._consume(chunk));
      socket.once('error', (error) => this.emit('error', error));
      socket.once('close', () => this._emitClose());
      this.emit('open');
      if (head.length > 0) this._consume(head);
    });
    request.end();
  }

  _emitClose() {
    this.readyState = CLOSED;
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit('close', this._closeCode, this._closeReason);
  }

  _protocolFailure() {
    if (this.readyState === OPEN) {
      try { this._writeClose(1002, 'PROTOCOL_ERROR'); } catch {}
    }
    this._socket?.destroy();
    this.emit('error', fail('PHASE5_WS_PROTOCOL_INVALID'));
  }

  _consume(chunk) {
    if (this.readyState === CLOSED) return;
    this._buffer = Buffer.concat([this._buffer, Buffer.from(chunk)]);
    try {
      while (this._buffer.length >= 2) {
        const first = this._buffer[0];
        const second = this._buffer[1];
        const final = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        if ((first & 0x70) !== 0 || (second & 0x80) !== 0) throw fail('frame');
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (this._buffer.length < 4) return;
          length = this._buffer.readUInt16BE(2);
          if (length < 126) throw fail('frame');
          offset = 4;
        } else if (length === 127) {
          if (this._buffer.length < 10) return;
          const large = this._buffer.readBigUInt64BE(2);
          if (large <= 0xffffn || large > BigInt(MAX_MESSAGE_BYTES)) throw fail('frame');
          length = Number(large);
          offset = 10;
        }
        if (length > MAX_MESSAGE_BYTES || this._buffer.length < offset + length) return;
        const payload = this._buffer.subarray(offset, offset + length);
        this._buffer = this._buffer.subarray(offset + length);
        this._handleFrame(final, opcode, payload);
      }
    } catch {
      this._protocolFailure();
    }
  }

  _handleFrame(final, opcode, payload) {
    if (opcode >= 8) {
      if (!final || payload.length > 125) throw fail('frame');
      if (opcode === 8) {
        if (payload.length === 1) throw fail('frame');
        if (payload.length >= 2) {
          this._closeCode = payload.readUInt16BE(0);
          this._closeReason = Buffer.from(payload.subarray(2));
        } else {
          this._closeCode = 1005;
        }
        if (!this._sentClose) this._socket.write(frame(8, payload));
        this.readyState = CLOSING;
        this._socket.end();
        return;
      }
      if (opcode === 9) this._socket.write(frame(10, payload));
      else if (opcode !== 10) throw fail('frame');
      return;
    }
    if (opcode === 0) {
      if (this._fragmentOpcode === null) throw fail('frame');
    } else if (opcode === 1 || opcode === 2) {
      if (this._fragmentOpcode !== null) throw fail('frame');
      this._fragmentOpcode = opcode;
    } else {
      throw fail('frame');
    }
    this._fragments.push(Buffer.from(payload));
    this._fragmentBytes += payload.length;
    if (this._fragmentBytes > MAX_MESSAGE_BYTES) throw fail('frame');
    if (!final) return;
    const message = Buffer.concat(this._fragments, this._fragmentBytes);
    const binary = this._fragmentOpcode === 2;
    this._fragments = [];
    this._fragmentBytes = 0;
    this._fragmentOpcode = null;
    this.emit('message', message, binary);
  }

  send(value) {
    if (this.readyState !== OPEN) throw fail('PHASE5_WS_NOT_OPEN');
    const binary = Buffer.isBuffer(value) || ArrayBuffer.isView(value)
      || value instanceof ArrayBuffer;
    this._socket.write(frame(binary ? 2 : 1,
      binary ? Buffer.from(value) : Buffer.from(String(value), 'utf8')));
  }

  _writeClose(code, reason) {
    const reasonBytes = Buffer.from(reason, 'utf8');
    if (!Number.isInteger(code) || reasonBytes.length > 123) {
      throw fail('PHASE5_WS_CLOSE_INVALID');
    }
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this._socket.write(frame(8, payload));
    this._sentClose = true;
    this.readyState = CLOSING;
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    if (this.readyState !== OPEN) {
      this.terminate();
      return;
    }
    this._writeClose(code, reason);
  }

  terminate() {
    this._socket?.destroy();
    if (this._socket === null) this._emitClose();
  }
}
