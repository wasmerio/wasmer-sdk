"""Package acquisition snapshots and event-loop delivery for native callbacks."""
import asyncio
import threading
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional, Tuple

from . import _native


class PackageLoadPhase(str, Enum):
    RESOLVING = "resolving"
    DOWNLOADING = "downloading"
    LOADING = "loading"
    READY = "ready"


@dataclass(frozen=True)
class DownloadProgress:
    downloaded_bytes: int
    total_bytes: Optional[int]
    percent: Optional[float]


@dataclass(frozen=True)
class PackageProgress:
    id: str
    phase: PackageLoadPhase
    cached: bool
    download: DownloadProgress


@dataclass(frozen=True)
class PackageLoadProgress:
    """Snapshot, not a delta. Download completion does not imply load readiness."""

    phase: PackageLoadPhase
    download: DownloadProgress
    packages: Tuple[PackageProgress, ...]


def _download(value: _native.DownloadProgress) -> DownloadProgress:
    return DownloadProgress(value.downloaded_bytes, value.total_bytes, value.percent)


def _snapshot(value: _native.PackageLoadProgress) -> PackageLoadProgress:
    return PackageLoadProgress(
        PackageLoadPhase(value.phase.name.lower()),
        _download(value.download),
        tuple(
            PackageProgress(p.id, PackageLoadPhase(p.phase.name.lower()), p.cached, _download(p.download))
            for p in value.packages
        ),
    )


class _ProgressObserver(_native.PackageLoadObserver):
    def __init__(self, callback: Callable[[PackageLoadProgress], None]) -> None:
        self._loop = asyncio.get_running_loop()
        self._callback = callback
        self._lock = threading.Lock()
        self._pending = None
        self._scheduled = False
        self._closed = False

    def on_progress(self, progress: _native.PackageLoadProgress) -> None:
        with self._lock:
            if self._closed:
                return
            self._pending = progress
            if not self._scheduled:
                self._scheduled = True
                self._loop.call_soon_threadsafe(self.flush)

    def flush(self) -> None:
        with self._lock:
            pending = self._pending
            self._pending = None
            self._scheduled = False
            if self._closed:
                return
        if pending is not None and self._callback is not None:
            try:
                self._callback(_snapshot(pending))
            except Exception as error:
                self._callback = None
                self._loop.call_exception_handler({
                    "message": "Package progress observer failed", "exception": error,
                })

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._pending = None
        self._callback = None
