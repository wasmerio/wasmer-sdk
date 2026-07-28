from __future__ import annotations

import math
import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Iterable,
    Mapping,
    Optional,
    Union,
)

from . import _native

BytesLike = Union[bytes, bytearray, memoryview]
FileContents = Union[str, BytesLike]
PackageSource = Union[str, os.PathLike[str], BytesLike, "Package"]
CommandSelector = Union[str, "Package", "CommandRef"]

_UINT64_MAX = (1 << 64) - 1
_DEFAULT_CHUNK_BYTES = 64 * 1024


class WasmerError(Exception):
    """An SDK failure with a machine-readable, currently provisional code."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code

    @classmethod
    def is_error(cls, error: BaseException, code: Optional[str] = None) -> bool:
        return isinstance(error, cls) and (code is None or error.code == code)


class ExitReason(str, Enum):
    EXITED = "exited"
    TERMINATED = "terminated"
    TIMEOUT = "timeout"
    UNKNOWN = "unknown"


class NetworkPolicy(str, Enum):
    DISABLED = "disabled"
    HOST = "host"


@dataclass(frozen=True)
class CapturedOutput:
    bytes: bytes
    truncated: bool

    def text(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        return self.bytes.decode(encoding, errors)


@dataclass(frozen=True)
class Output:
    exit_code: int
    reason: ExitReason
    stdout: CapturedOutput
    stderr: CapturedOutput

    @property
    def ok(self) -> bool:
        return self.reason is ExitReason.EXITED and self.exit_code == 0

    def check(self) -> "Output":
        if not self.ok:
            raise ProcessExitError(self)
        return self

    def text(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        self.check()
        return self.stdout.text(encoding, errors)


class ProcessExitError(Exception):
    def __init__(self, output: Output) -> None:
        self.output = output
        super().__init__(_describe_exit(output))

    @property
    def code(self) -> str:
        if self.output.reason is ExitReason.TIMEOUT:
            return "TIMEOUT"
        if self.output.reason is ExitReason.TERMINATED:
            return "PROCESS_TERMINATED"
        return "PROCESS_EXITED"


@dataclass(frozen=True)
class FileStat:
    kind: str
    size: int


@dataclass(frozen=True)
class DirectoryEntry:
    name: str
    kind: str
    size: int


class Wasmer:
    """Shared entry point for package loading and sandbox creation."""

    def __init__(
        self,
        *,
        cache_root: Optional[Union[str, os.PathLike[str]]] = None,
        output_bytes: int = 16 * 1024 * 1024,
    ) -> None:
        output_bytes = _integer("output_bytes", output_bytes, 0, _UINT64_MAX)
        options = _native.ClientOptions(
            cache_root=None if cache_root is None else os.fspath(cache_root),
            output_bytes=output_bytes,
        )
        self._core = _sync(lambda: _native.WasmerCore(options))

    async def load_package(self, source: PackageSource) -> Package:
        if isinstance(source, Package):
            return source
        if isinstance(source, str):
            core = await _async(self._core.load_package_registry(source))
        elif isinstance(source, os.PathLike):
            core = await _async(self._core.load_package_path(os.fspath(source)))
        elif isinstance(source, (bytes, bytearray, memoryview)):
            core = await _async(self._core.load_package_bytes(bytes(source)))
        else:
            raise WasmerError(
                "package source must be a registry string, pathlib path, bytes, or Package",
                "INVALID_PACKAGE_SOURCE",
            )
        return Package(core)

    async def create_sandbox(
        self,
        *,
        packages: Iterable[PackageSource] = (),
        files: Optional[Mapping[str, FileContents]] = None,
        env: Optional[Mapping[str, str]] = None,
        network: Union[NetworkPolicy, str] = NetworkPolicy.DISABLED,
        shell: Optional[CommandSelector] = None,
    ) -> Sandbox:
        resolved = [await self.load_package(source) for source in packages]
        encoded_files = {
            path: _bytes(contents) for path, contents in (files or {}).items()
        }
        core = await _async(
            self._core.create_sandbox(
                [package._core for package in resolved],
                encoded_files,
                dict(env or {}),
                _network_mode(network),
            )
        )
        return Sandbox(self, core, shell=shell)

    async def close(self) -> None:
        await _async(self._core.close())

    async def __aenter__(self) -> "Wasmer":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()


class Package:
    def __init__(self, core: _native.PackageCore) -> None:
        self._core = core

    @property
    def id(self) -> str:
        return self._core.id()

    @property
    def commands(self) -> tuple[str, ...]:
        return tuple(self._core.commands())

    @property
    def entrypoint(self) -> Optional[str]:
        return self._core.entrypoint()

    def command(self, name: str) -> CommandRef:
        return CommandRef(self, _sync(lambda: self._core.command(name)))


class CommandRef:
    def __init__(self, package: Package, core: _native.CommandRefCore) -> None:
        self.package = package
        self._core = core

    @property
    def name(self) -> str:
        return self._core.name()


class Sandbox:
    def __init__(
        self,
        wasmer: Wasmer,
        core: _native.SandboxCore,
        *,
        shell: Optional[CommandSelector] = None,
    ) -> None:
        self.wasmer = wasmer
        self._core = core
        self._shell = shell
        self.fs = SandboxFileSystem(core.filesystem())
        self.ports = Ports(core.ports())

    def command(
        self,
        selector: CommandSelector,
        args: Iterable[str] = (),
        *,
        cwd: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
    ) -> Command:
        arguments = list(args)
        environment = dict(env or {})
        if isinstance(selector, CommandRef):
            core = self._core.command_ref(
                selector._core, arguments, cwd, environment
            )
        elif isinstance(selector, Package):
            core = self._core.command_package(
                selector._core, arguments, cwd, environment
            )
        elif isinstance(selector, str):
            core = self._core.command_name(selector, arguments, cwd, environment)
        else:
            raise WasmerError(
                "command selector must be a command name, Package, or CommandRef",
                "INVALID_ARGUMENT",
            )
        return Command(core)

    def shell(
        self,
        script: str,
        *,
        cwd: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
    ) -> Command:
        if self._shell is None:
            raise WasmerError(
                "no shell is configured for this sandbox",
                "SHELL_NOT_CONFIGURED",
            )
        return self.command(self._shell, ["-c", script], cwd=cwd, env=env)

    async def install_package(
        self,
        source: PackageSource,
        *,
        as_shell: Optional[str] = None,
    ) -> Package:
        if isinstance(source, Package):
            core = await _async(self._core.install_package_ref(source._core))
        elif isinstance(source, str):
            core = await _async(self._core.install_package_registry(source))
        elif isinstance(source, os.PathLike):
            core = await _async(
                self._core.install_package_path(os.fspath(source))
            )
        elif isinstance(source, (bytes, bytearray, memoryview)):
            core = await _async(
                self._core.install_package_bytes(bytes(source))
            )
        else:
            raise WasmerError(
                "package source must be a registry string, pathlib path, bytes, or Package",
                "INVALID_PACKAGE_SOURCE",
            )
        package = Package(core)
        if as_shell is not None:
            self._shell = package.command(as_shell)
        return package

    async def close(self) -> None:
        await _async(self._core.close())

    async def __aenter__(self) -> "Sandbox":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()


class Command:
    def __init__(self, core: _native.CommandCore) -> None:
        self._core = core

    async def run(
        self,
        *,
        stdin: Optional[FileContents] = None,
        timeout: Optional[float] = None,
        output_bytes: Optional[int] = None,
        check: bool = False,
    ) -> Output:
        core_output = await _async(
            self._core.run(
                _native.RunOptions(
                    input=None if stdin is None else _bytes(stdin),
                    timeout_ms=_timeout_ms(timeout),
                    output_bytes=_optional_integer(
                        "output_bytes", output_bytes, 0, _UINT64_MAX
                    ),
                )
            )
        )
        output = _output(core_output)
        return output.check() if check else output

    async def spawn(
        self,
        *,
        timeout: Optional[float] = None,
        output_bytes: Optional[int] = None,
        stdin: str = "closed",
        stdout: str = "pipe",
        stderr: str = "pipe",
    ) -> Process:
        input_mode = {
            "closed": _native.InputMode.CLOSED,
            "pipe": _native.InputMode.PIPE,
        }.get(stdin)
        if input_mode is None:
            raise WasmerError(
                "`stdin` must be 'closed' or 'pipe'", "INVALID_ARGUMENT"
            )
        modes = {
            "pipe": _native.OutputMode.PIPE,
            "capture": _native.OutputMode.CAPTURE,
            "discard": _native.OutputMode.DISCARD,
        }
        if stdout not in modes or stderr not in modes:
            raise WasmerError(
                "`stdout` and `stderr` must be 'pipe', 'capture', or 'discard'",
                "INVALID_ARGUMENT",
            )
        core = await _async(
            self._core.spawn(
                _native.SpawnOptions(
                    timeout_ms=_timeout_ms(timeout),
                    output_bytes=_optional_integer(
                        "output_bytes", output_bytes, 0, _UINT64_MAX
                    ),
                    stdin=input_mode,
                    stdout=modes[stdout],
                    stderr=modes[stderr],
                )
            )
        )
        return Process(core)


class Process:
    def __init__(self, core: _native.ProcessCore) -> None:
        self._core = core
        self.stdin = WritableBytes(core) if core.has_stdin() else None
        self.stdout = (
            ReadableBytes(core.read_stdout) if core.has_stdout() else None
        )
        self.stderr = (
            ReadableBytes(core.read_stderr) if core.has_stderr() else None
        )

    @property
    def id(self) -> int:
        return self._core.id()

    async def wait(self, *, check: bool = False) -> Output:
        output = _output(await _async(self._core.wait()))
        return output.check() if check else output

    async def terminate(self, *, grace_period: float = 1.0) -> None:
        timeout_ms = _timeout_ms(grace_period, "grace_period")
        assert timeout_ms is not None
        await _async(self._core.terminate(timeout_ms))

    async def kill(self) -> None:
        _sync(self._core.kill)


class WritableBytes:
    def __init__(self, core: _native.ProcessCore) -> None:
        self._core = core

    async def write(self, data: FileContents) -> None:
        await _async(self._core.write_stdin(_bytes(data)))

    async def close(self) -> None:
        await _async(self._core.close_stdin())


class ReadableBytes:
    def __init__(
        self,
        read: Callable[[int], Awaitable[Optional[bytes]]],
    ) -> None:
        self._read = read

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._chunks()

    async def _chunks(self) -> AsyncIterator[bytes]:
        while True:
            chunk = await _async(self._read(_DEFAULT_CHUNK_BYTES))
            if chunk is None:
                return
            yield chunk

    async def lines(
        self,
        encoding: str = "utf-8",
        errors: str = "strict",
    ) -> AsyncIterator[str]:
        import codecs

        decoder = codecs.getincrementaldecoder(encoding)(errors=errors)
        pending = ""
        async for chunk in self:
            pending += decoder.decode(chunk)
            while "\n" in pending:
                line, pending = pending.split("\n", 1)
                yield line[:-1] if line.endswith("\r") else line
        pending += decoder.decode(b"", final=True)
        if pending:
            yield pending


class SandboxFileSystem:
    def __init__(self, core: _native.FileSystemCore) -> None:
        self._core = core

    async def write(self, path: str, contents: FileContents) -> None:
        await _async(self._core.write(path, _bytes(contents)))

    async def write_text(self, path: str, text: str) -> None:
        await self.write(path, text)

    async def read(self, path: str) -> bytes:
        return await _async(self._core.read(path))

    async def read_text(
        self,
        path: str,
        encoding: str = "utf-8",
        errors: str = "strict",
    ) -> str:
        return (await self.read(path)).decode(encoding, errors)

    async def mkdir(self, path: str, *, recursive: bool = False) -> None:
        await _async(self._core.mkdir(path, recursive))

    async def read_dir(self, path: str) -> tuple[DirectoryEntry, ...]:
        entries = await _async(self._core.read_dir(path))
        return tuple(
            DirectoryEntry(
                name=entry.name,
                kind=_file_kind(entry.kind),
                size=entry.size,
            )
            for entry in entries
        )

    async def stat(self, path: str) -> FileStat:
        stat = await _async(self._core.stat(path))
        return FileStat(kind=_file_kind(stat.kind), size=stat.size)

    async def remove(self, path: str, *, recursive: bool = False) -> None:
        await _async(self._core.remove(path, recursive))

    async def rename(self, source: str, destination: str) -> None:
        await _async(self._core.rename(source, destination))


class Ports:
    def __init__(self, core: _native.PortsCore) -> None:
        self._core = core

    async def wait(self, port: int, *, timeout: float = 30.0) -> None:
        port = _integer("port", port, 1, 65_535)
        timeout_ms = _timeout_ms(timeout)
        assert timeout_ms is not None
        await _async(self._core.wait(port, timeout_ms))


async def _async(awaitable: Awaitable[Any]) -> Any:
    try:
        return await awaitable
    except _native.SdkError as error:
        raise WasmerError(error.message, error.code) from error


def _sync(work: Callable[[], Any]) -> Any:
    try:
        return work()
    except _native.SdkError as error:
        raise WasmerError(error.message, error.code) from error


def _bytes(value: FileContents) -> bytes:
    return value.encode() if isinstance(value, str) else bytes(value)


def _timeout_ms(
    seconds: Optional[float],
    name: str = "timeout",
) -> Optional[int]:
    if seconds is None:
        return None
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
        raise WasmerError(
            f"`{name}` must be a finite non-negative number",
            "INVALID_ARGUMENT",
        )
    if not math.isfinite(seconds) or seconds < 0:
        raise WasmerError(
            f"`{name}` must be a finite non-negative number",
            "INVALID_ARGUMENT",
        )
    milliseconds = seconds * 1000
    if milliseconds > _UINT64_MAX:
        raise WasmerError(f"`{name}` is too large", "INVALID_ARGUMENT")
    return int(milliseconds)


def _integer(name: str, value: int, minimum: int, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < minimum
        or value > maximum
    ):
        raise WasmerError(
            f"`{name}` must be an integer between {minimum} and {maximum}, inclusive",
            "INVALID_ARGUMENT",
        )
    return value


def _optional_integer(
    name: str,
    value: Optional[int],
    minimum: int,
    maximum: int,
) -> Optional[int]:
    return None if value is None else _integer(name, value, minimum, maximum)


def _network_mode(value: Union[NetworkPolicy, str]) -> _native.NetworkMode:
    try:
        policy = value if isinstance(value, NetworkPolicy) else NetworkPolicy(value)
    except ValueError as error:
        raise WasmerError(
            "`network` must be 'disabled' or 'host'", "INVALID_ARGUMENT"
        ) from error
    return (
        _native.NetworkMode.HOST
        if policy is NetworkPolicy.HOST
        else _native.NetworkMode.DISABLED
    )


def _output(value: _native.ProcessOutput) -> Output:
    reasons = {
        _native.ProcessExitReason.EXITED: ExitReason.EXITED,
        _native.ProcessExitReason.TERMINATED: ExitReason.TERMINATED,
        _native.ProcessExitReason.TIMEOUT: ExitReason.TIMEOUT,
        _native.ProcessExitReason.UNKNOWN: ExitReason.UNKNOWN,
    }
    return Output(
        exit_code=value.exit_code,
        reason=reasons[value.reason],
        stdout=CapturedOutput(value.stdout, value.stdout_truncated),
        stderr=CapturedOutput(value.stderr, value.stderr_truncated),
    )


def _file_kind(value: _native.FileKind) -> str:
    return "directory" if value is _native.FileKind.DIRECTORY else "file"


def _describe_exit(output: Output) -> str:
    if output.reason is ExitReason.TERMINATED:
        base = "process was terminated before completing"
    elif output.reason is ExitReason.TIMEOUT:
        base = "process timed out"
    else:
        base = f"process exited unsuccessfully with status {output.exit_code}"
    excerpt = output.stderr.bytes[-512:].decode("utf-8", "replace").strip()
    return f"{base}\nstderr: {excerpt}" if excerpt else base
