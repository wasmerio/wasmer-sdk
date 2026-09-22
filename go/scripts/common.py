"""Native linker configuration shared by local Go tests and examples."""
from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]


def environment(native: Path, mode: str) -> dict[str, str]:
    native = native.resolve()
    metadata = json.loads((native / "native.json").read_text())
    env = dict(os.environ, CGO_ENABLED="1")
    if mode == "static":
        flags = [str(native / "static/libwasmer_sdk_uniffi.a"), *shlex.split(metadata["static_link_flags"])]
    else:
        flags = ["-L" + str(native / "dynamic"), "-lwasmer_sdk_uniffi", "-Wl,-rpath," + str(native / "dynamic")]
    # cgo's quoted.Split understands double quotes, not shell escape sequences.
    env["CGO_LDFLAGS"] = " ".join(json.dumps(f) for f in flags)
    return env
