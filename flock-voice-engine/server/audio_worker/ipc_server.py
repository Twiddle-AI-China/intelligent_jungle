"""单 runtime UDS listener 及 worker handshake。"""
from __future__ import annotations

import json
import os
import socket
import stat
from pathlib import Path
from typing import Any

from .framing import FrameDecoder, FrameKind, encode_frame


class IpcServerError(RuntimeError):
    pass


class IpcServer:
    def __init__(self, socket_path: str | Path, identity: dict[str, Any]):
        self.socket_path = Path(socket_path)
        self.identity = dict(identity)
        self._listener: socket.socket | None = None
        self._active: socket.socket | None = None
        self._socket_identity: tuple[int, int] | None = None

    def preflight(self) -> None:
        directory = self.socket_path.parent
        try:
            value = directory.stat()
        except OSError as exc:
            raise IpcServerError("AUDIO_SOCKET_PREFLIGHT_FAILED") from exc
        expected_uid = os.geteuid() if hasattr(os, "geteuid") else value.st_uid
        allowed_gids = set(os.getgroups()) if hasattr(os, "getgroups") else {value.st_gid}
        if hasattr(os, "getegid"):
            allowed_gids.add(os.getegid())
        if (not stat.S_ISDIR(value.st_mode) or stat.S_IMODE(value.st_mode) != 0o770
                or value.st_uid != expected_uid or value.st_gid not in allowed_gids):
            raise IpcServerError("AUDIO_SOCKET_PREFLIGHT_FAILED")
        if self.socket_path.exists() or self.socket_path.is_symlink():
            raise IpcServerError("AUDIO_SOCKET_PREFLIGHT_FAILED")

    def listen_without_loading_model(self) -> None:
        self.preflight()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(self.socket_path))
        os.chmod(self.socket_path, 0o660)
        value = self.socket_path.lstat()
        self._socket_identity = (value.st_dev, value.st_ino)
        listener.listen(1)
        self._listener = listener

    def accept_identity(self, timeout: float = 5.0) -> socket.socket:
        if self._active is not None:
            raise IpcServerError("AUDIO_RUNTIME_CONNECTION_EXISTS")
        assert self._listener is not None
        self._listener.settimeout(timeout)
        connection, _ = self._listener.accept()
        connection.settimeout(timeout)
        try:
            connection.sendall(encode_frame(FrameKind.JSON, {"type": "worker.hello", "identity": self.identity}))
            decoder = FrameDecoder()
            while True:
                data = connection.recv(65536)
                if not data:
                    decoder.eof()
                    raise IpcServerError("RUNTIME_IDENTITY_MISSING")
                for frame in decoder.feed(data):
                    if frame.kind is not FrameKind.JSON:
                        raise IpcServerError("RUNTIME_IDENTITY_INVALID")
                    message = json.loads(frame.body)
                    if message != {"type": "runtime.identity.accepted", "identity": self.identity}:
                        raise IpcServerError("RUNTIME_IDENTITY_MISMATCH")
                    connection.settimeout(None)
                    self._active = connection
                    return connection
        except Exception:
            connection.close()
            raise

    def disconnect(self) -> None:
        if self._active is not None:
            self._active.close()
            self._active = None

    def close(self) -> None:
        self.disconnect()
        if self._listener is not None:
            self._listener.close()
            self._listener = None
        try:
            value = self.socket_path.lstat()
            if self._socket_identity == (value.st_dev, value.st_ino) and stat.S_ISSOCK(value.st_mode):
                self.socket_path.unlink()
        except FileNotFoundError:
            pass
        self._socket_identity = None
