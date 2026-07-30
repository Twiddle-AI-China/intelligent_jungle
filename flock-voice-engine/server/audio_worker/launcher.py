"""Fixed audio PID 1 owner; production has no Phase 5 control mount."""
from __future__ import annotations

import json
import hashlib
import os
import queue
import select
import signal
import socket
import stat
import sys
import threading
import time
from pathlib import Path


FAULT_CONTROL_ROOT = Path("/run/flock-phase5-fault-control")
AUDIO_CONTROL_PATH = FAULT_CONTROL_ROOT / "audio-control.sock"
AUDIO_WORKER_SOCKET_PATH = Path("/run/flock-audio/audio.sock")
MAX_CONTROL_LINE_BYTES = 4096


class AudioWorkerLauncherError(RuntimeError):
    pass


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _reject_duplicate_members(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON member")
        value[key] = item
    return value


def _decode_canonical_line(raw: bytes) -> dict:
    if (
        type(raw) is not bytes
        or not raw.endswith(b"\n")
        or len(raw) > MAX_CONTROL_LINE_BYTES
    ):
        raise AudioWorkerLauncherError("AUDIO_FAULT_CONTROL_FRAME_INVALID")
    try:
        value = json.loads(
            raw[:-1].decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_members,
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ValueError("non-finite JSON")
            ),
        )
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise AudioWorkerLauncherError(
            "AUDIO_FAULT_CONTROL_FRAME_INVALID"
        ) from exc
    if type(value) is not dict or _canonical(value) + b"\n" != raw:
        raise AudioWorkerLauncherError("AUDIO_FAULT_CONTROL_FRAME_INVALID")
    return value


def _recv_line(connection: socket.socket) -> bytes:
    value = bytearray()
    while True:
        chunk = connection.recv(min(4096, MAX_CONTROL_LINE_BYTES - len(value)))
        if not chunk:
            raise AudioWorkerLauncherError("AUDIO_FAULT_CONTROL_EOF")
        value.extend(chunk)
        newline = value.find(b"\n")
        if newline >= 0:
            if newline != len(value) - 1:
                raise AudioWorkerLauncherError(
                    "AUDIO_FAULT_CONTROL_FRAME_INVALID"
                )
            return bytes(value)
        if len(value) >= MAX_CONTROL_LINE_BYTES:
            raise AudioWorkerLauncherError(
                "AUDIO_FAULT_CONTROL_FRAME_INVALID"
            )


def _read_fd_line(descriptor: int, timeout_seconds: float) -> bytes:
    """Read one bounded line from the child ack pipe without short-read trust."""
    if (
        type(descriptor) is not int
        or descriptor < 0
        or type(timeout_seconds) not in {int, float}
        or not 0 < timeout_seconds <= 60
    ):
        raise AudioWorkerLauncherError(
            "AUDIO_EPOCH_ROTATION_COMPLETION_INVALID"
        )
    deadline = time.monotonic() + float(timeout_seconds)
    value = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AudioWorkerLauncherError(
                "AUDIO_EPOCH_ROTATION_TIMEOUT"
            )
        ready, _writeable, errors = select.select(
            [descriptor], [], [descriptor], remaining
        )
        if errors or ready != [descriptor]:
            raise AudioWorkerLauncherError(
                "AUDIO_EPOCH_ROTATION_TIMEOUT"
            )
        chunk = os.read(
            descriptor,
            min(4096, MAX_CONTROL_LINE_BYTES - len(value)),
        )
        if not chunk:
            raise AudioWorkerLauncherError(
                "AUDIO_EPOCH_ROTATION_COMPLETION_INVALID"
            )
        value.extend(chunk)
        newline = value.find(b"\n")
        if newline >= 0:
            if newline != len(value) - 1:
                raise AudioWorkerLauncherError(
                    "AUDIO_EPOCH_ROTATION_COMPLETION_INVALID"
                )
            return bytes(value)
        if len(value) >= MAX_CONTROL_LINE_BYTES:
            raise AudioWorkerLauncherError(
                "AUDIO_EPOCH_ROTATION_COMPLETION_INVALID"
            )


def _socket_snapshot(path: Path, expected_mode: int) -> tuple[int, int]:
    value = path.lstat()
    if (
        not stat.S_ISSOCK(value.st_mode)
        or stat.S_IMODE(value.st_mode) != expected_mode
        or value.st_uid != os.geteuid()
        or value.st_gid != os.getegid()
        or value.st_nlink != 1
    ):
        raise AudioWorkerLauncherError("AUDIO_FAULT_CONTROL_SOCKET_INVALID")
    return value.st_dev, value.st_ino


def _control_socket_snapshot(path: Path) -> tuple[int, int]:
    return _socket_snapshot(path, 0o600)


def _planned_audio_epoch(challenge: str) -> str:
    if (
        type(challenge) is not str
        or len(challenge) != 64
        or any(character not in "0123456789abcdef"
               for character in challenge)
    ):
        raise AudioWorkerLauncherError(
            "AUDIO_FAULT_CONTROL_ADMISSION_INVALID"
        )
    return "phase5-" + hashlib.sha256(
        b"audio-epoch\0" + challenge.encode("ascii")
    ).hexdigest()[:32]


def _is_clean_control_eof(expected_sequence: int, error: BaseException) -> bool:
    return (
        expected_sequence == 2
        and type(error) is AudioWorkerLauncherError
        and str(error) == "AUDIO_FAULT_CONTROL_EOF"
    )


def _connect_fault_control() -> tuple[socket.socket, int] | None:
    if not FAULT_CONTROL_ROOT.exists():
        return None
    root = FAULT_CONTROL_ROOT.lstat()
    if (
        not stat.S_ISDIR(root.st_mode)
        or stat.S_IMODE(root.st_mode) != 0o700
        or root.st_uid != os.geteuid()
        or root.st_gid != os.getegid()
    ):
        raise AudioWorkerLauncherError("AUDIO_FAULT_CONTROL_ROOT_INVALID")
    before = _control_socket_snapshot(AUDIO_CONTROL_PATH)
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.connect(str(AUDIO_CONTROL_PATH))
        after = _control_socket_snapshot(AUDIO_CONTROL_PATH)
        if after != before:
            raise AudioWorkerLauncherError("AUDIO_FAULT_CONTROL_SOCKET_ABA")
        return connection, before[1]
    except BaseException:
        connection.close()
        raise


class AudioWorkerLauncher:
    """Own exactly one child and retain its waitpid status."""

    def __init__(self) -> None:
        self.child_pid: int | None = None
        self.last_exited_pid: int | None = None
        self.last_exit_signal: str | None = None
        self._stopping = False
        self._control: socket.socket | None = None
        self._control_error: BaseException | None = None
        self._control_ready = threading.Event()
        self._child_lock = threading.Lock()
        self._crash_pending: tuple[int, int, tuple[int, int]] | None = None
        self._completion_queue: queue.Queue[dict] = queue.Queue(maxsize=1)
        self._epoch_response_fd: int | None = None
        self._epoch_command_fd: int | None = None
        self._planned_audio_epoch: str | None = None
        self._restart_count = 0
        self._supervisor_generation = 1

    def _spawn_child(self) -> int:
        if self.child_pid is not None:
            raise AudioWorkerLauncherError("AUDIO_CHILD_ALREADY_RUNNING")
        response_read_fd, response_write_fd = os.pipe()
        command_read_fd, command_write_fd = os.pipe()
        os.set_inheritable(response_write_fd, True)
        os.set_inheritable(command_read_fd, True)
        pid = os.fork()
        if pid == 0:
            os.close(response_read_fd)
            os.close(command_write_fd)
            environment = dict(os.environ)
            environment["FLOCK_AUDIO_LAUNCHER_ACK_FD"] = str(
                response_write_fd
            )
            environment["FLOCK_AUDIO_LAUNCHER_COMMAND_FD"] = str(
                command_read_fd
            )
            environment["FLOCK_AUDIO_LAUNCHER_RESTART_COUNT"] = str(
                self._restart_count
            )
            environment["FLOCK_AUDIO_LAUNCHER_SUPERVISOR_GENERATION"] = str(
                self._supervisor_generation
            )
            environment["FLOCK_AUDIO_LAUNCHER_LAST_EXITED_PID"] = (
                "" if self.last_exited_pid is None
                else str(self.last_exited_pid)
            )
            environment["FLOCK_AUDIO_LAUNCHER_LAST_EXIT_SIGNAL"] = (
                "" if self.last_exit_signal is None
                else self.last_exit_signal
            )
            os.execve(
                sys.executable,
                [sys.executable, "-u", "-m", "server.audio_worker"],
                environment,
            )
        os.close(response_write_fd)
        os.close(command_read_fd)
        with self._child_lock:
            self.child_pid = pid
            self._epoch_response_fd = response_read_fd
            self._epoch_command_fd = command_write_fd
        return pid

    def _control_loop(self) -> None:
        expected_sequence = 0
        try:
            connected = _connect_fault_control()
            if connected is None:
                self._control_ready.set()
                return
            self._control, listener_inode = connected
            admission = _decode_canonical_line(_recv_line(self._control))
            if (
                set(admission) != {
                    "schemaVersion", "kind", "role", "challenge",
                    "socketInode",
                }
                or admission["schemaVersion"] != 1
                or admission["kind"]
                != "phase5-fault-control-admission"
                or admission["role"] != "audio"
                or type(admission["challenge"]) is not str
                or len(admission["challenge"]) != 64
                or any(character not in "0123456789abcdef"
                       for character in admission["challenge"])
                or admission["socketInode"]
                != listener_inode
            ):
                raise AudioWorkerLauncherError(
                    "AUDIO_FAULT_CONTROL_ADMISSION_INVALID"
                )
            self._control.sendall(_canonical({
                "schemaVersion": 1,
                "kind": "phase5-fault-control-audio-admission-response",
            }) + b"\n")
            enable = _decode_canonical_line(_recv_line(self._control))
            if (
                set(enable) != {
                    "schemaVersion", "kind", "challenge",
                    "signerSpkiSha256",
                }
                or enable["schemaVersion"] != 1
                or enable["kind"]
                != "phase5-audio-control-enable"
                or enable["challenge"] != admission["challenge"]
                or type(enable["signerSpkiSha256"]) is not str
                or len(enable["signerSpkiSha256"]) != 64
                or any(character not in "0123456789abcdef"
                       for character in enable["signerSpkiSha256"])
            ):
                raise AudioWorkerLauncherError(
                    "AUDIO_FAULT_CONTROL_ENABLE_INVALID"
                )
            self._control.sendall(_canonical({
                "schemaVersion": 1,
                "kind": "phase5-audio-control-enabled",
            }) + b"\n")
            self._planned_audio_epoch = _planned_audio_epoch(
                admission["challenge"]
            )
            self._control_ready.set()
            while True:
                command = _decode_canonical_line(_recv_line(self._control))
                if (
                    set(command) != {"schemaVersion", "kind", "sequence"}
                    or command["schemaVersion"] != 1
                    or command["kind"] not in {
                        "phase5-audio-crash-child",
                        "phase5-audio-rotate-epoch",
                    }
                    or type(command["sequence"]) is not int
                    or command["sequence"] != expected_sequence + 1
                ):
                    raise AudioWorkerLauncherError(
                        "AUDIO_FAULT_CONTROL_COMMAND_INVALID"
                    )
                expected_sequence = command["sequence"]
                if command["kind"] == "phase5-audio-crash-child":
                    completion = self._request_child_crash(
                        expected_sequence
                    )
                else:
                    completion = self._request_epoch_rotation(
                        expected_sequence
                    )
                self._control.sendall(_canonical(completion) + b"\n")
        except BaseException as exc:
            if _is_clean_control_eof(expected_sequence, exc):
                control = self._control
                self._control = None
                if control is not None:
                    try:
                        control.close()
                    except OSError:
                        pass
                self._control_ready.set()
                return
            self._control_error = exc
            self._control_ready.set()
            child_pid = self.child_pid
            if child_pid is not None:
                try:
                    os.kill(child_pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def _request_child_crash(self, sequence: int) -> dict:
        with self._child_lock:
            child_pid = self.child_pid
            if child_pid is None or self._crash_pending is not None:
                raise AudioWorkerLauncherError("AUDIO_CHILD_NOT_READY")
            socket_state = _socket_snapshot(AUDIO_WORKER_SOCKET_PATH, 0o660)
            self._crash_pending = (sequence, child_pid, socket_state)
            os.kill(child_pid, signal.SIGKILL)
        try:
            completion = self._completion_queue.get(timeout=30)
        except queue.Empty as exc:
            raise AudioWorkerLauncherError(
                "AUDIO_CHILD_CRASH_TIMEOUT"
            ) from exc
        if completion.get("sequence") != sequence:
            raise AudioWorkerLauncherError(
                "AUDIO_CHILD_CRASH_COMPLETION_INVALID"
            )
        return completion

    def _request_epoch_rotation(self, sequence: int) -> dict:
        with self._child_lock:
            child_pid = self.child_pid
            response_fd = self._epoch_response_fd
            command_fd = self._epoch_command_fd
            target_epoch = self._planned_audio_epoch
            if (
                child_pid is None
                or response_fd is None
                or command_fd is None
                or target_epoch is None
            ):
                raise AudioWorkerLauncherError("AUDIO_CHILD_NOT_READY")
            os.write(command_fd, _canonical({
                "kind": "audio-worker-rotate-epoch",
                "targetAudioEpoch": target_epoch,
            }) + b"\n")
            os.kill(child_pid, signal.SIGUSR1)
        raw = _read_fd_line(response_fd, 30)
        value = _decode_canonical_line(raw)
        if (
            set(value) != {"kind", "beforeAudioEpoch", "afterAudioEpoch"}
            or value["kind"] != "audio-worker-epoch-rotated"
            or type(value["beforeAudioEpoch"]) is not str
            or type(value["afterAudioEpoch"]) is not str
            or value["beforeAudioEpoch"] == value["afterAudioEpoch"]
            or value["afterAudioEpoch"] != target_epoch
        ):
            raise AudioWorkerLauncherError(
                "AUDIO_EPOCH_ROTATION_COMPLETION_INVALID"
            )
        return {
            "schemaVersion": 1,
            "kind": "phase5-audio-rotate-epoch-complete",
            "sequence": sequence,
            "beforeAudioEpoch": value["beforeAudioEpoch"],
            "afterAudioEpoch": value["afterAudioEpoch"],
        }

    def _forward_stop(self, signum, _frame) -> None:
        self._stopping = True
        child_pid = self.child_pid
        if child_pid is not None:
            try:
                os.kill(child_pid, signum)
            except ProcessLookupError:
                pass

    def run(self) -> int:
        signal.signal(signal.SIGTERM, self._forward_stop)
        signal.signal(signal.SIGINT, self._forward_stop)
        child_pid = self._spawn_child()
        control = threading.Thread(
            target=self._control_loop,
            name="flock-phase5-audio-control",
            daemon=True,
        )
        control.start()
        if self._control_error is not None:
            try:
                os.kill(child_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        while True:
            waited_pid, status = os.waitpid(child_pid, 0)
            self.last_exited_pid = waited_pid
            exit_signal = (
                signal.Signals(os.WTERMSIG(status)).name
                if os.WIFSIGNALED(status) else None
            )
            self.last_exit_signal = exit_signal
            with self._child_lock:
                pending = self._crash_pending
                self.child_pid = None
            if (
                pending is not None
                and pending[1] == waited_pid
                and exit_signal == "SIGKILL"
                and not self._stopping
                and self._control_error is None
            ):
                sequence, old_pid, old_socket_state = pending
                if _socket_snapshot(
                        AUDIO_WORKER_SOCKET_PATH, 0o660) != old_socket_state:
                    raise AudioWorkerLauncherError(
                        "AUDIO_WORKER_SOCKET_ABA"
                    )
                AUDIO_WORKER_SOCKET_PATH.unlink()
                old_response_fd = self._epoch_response_fd
                if old_response_fd is not None:
                    os.close(old_response_fd)
                old_command_fd = self._epoch_command_fd
                if old_command_fd is not None:
                    os.close(old_command_fd)
                self._restart_count += 1
                self._supervisor_generation += 1
                child_pid = self._spawn_child()
                deadline = time.monotonic() + 30
                new_socket_state = None
                while time.monotonic() < deadline:
                    try:
                        new_socket_state = _socket_snapshot(
                            AUDIO_WORKER_SOCKET_PATH, 0o660
                        )
                    except (FileNotFoundError, AudioWorkerLauncherError):
                        time.sleep(0.01)
                        continue
                    if new_socket_state != old_socket_state:
                        break
                    new_socket_state = None
                    time.sleep(0.01)
                if new_socket_state is None:
                    raise AudioWorkerLauncherError(
                        "AUDIO_CHILD_RESTART_TIMEOUT"
                    )
                with self._child_lock:
                    self._crash_pending = None
                self._completion_queue.put({
                    "schemaVersion": 1,
                    "kind": "phase5-audio-crash-child-complete",
                    "sequence": sequence,
                    "lastExitedPid": old_pid,
                    "lastExitSignal": "SIGKILL",
                    "newPid": child_pid,
                })
                continue
            if pending is not None:
                raise AudioWorkerLauncherError(
                    "AUDIO_CHILD_CRASH_WITNESS_INVALID"
                )
            if self._control_error is not None and not self._stopping:
                return 2
            if os.WIFSIGNALED(status):
                return 128 + os.WTERMSIG(status)
            return os.WEXITSTATUS(status) if os.WIFEXITED(status) else 2

    def close(self) -> None:
        if self._control is not None:
            try:
                self._control.close()
            except OSError:
                pass
        if self._epoch_response_fd is not None:
            try:
                os.close(self._epoch_response_fd)
            except OSError:
                pass
            self._epoch_response_fd = None
        if self._epoch_command_fd is not None:
            try:
                os.close(self._epoch_command_fd)
            except OSError:
                pass
            self._epoch_command_fd = None


def main() -> int:
    launcher = AudioWorkerLauncher()
    try:
        return launcher.run()
    except (AudioWorkerLauncherError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    finally:
        launcher.close()


if __name__ == "__main__":
    raise SystemExit(main())
