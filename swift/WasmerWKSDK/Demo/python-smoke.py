"""Executed by Wasmer's Python guest, shared by the native and browser probes."""
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

label = sys.argv[1]
native = Path("/native")
value = (native / "input.txt").read_text()
print(f"python:{label}", flush=True)

# Exercise dynamic imports, a Python thread, and native I/O from that thread.
result = []


def work():
    import zlib
    import _hashlib

    assert zlib.decompress(zlib.compress(value.encode())).decode() == value
    assert _hashlib.openssl_sha256(b"abc").hexdigest() == (
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
    result.append((native / "input.txt").read_text())


thread = threading.Thread(target=work)
thread.start()
thread.join(20)
assert not thread.is_alive(), "Python thread did not finish"
assert result == [value], result
print("thread:ok", flush=True)

child = subprocess.run(
    [sys.executable, "-c", "print('child:ok')"],
    capture_output=True,
    text=True,
    check=True,
    timeout=20,
)
assert child.stdout == "child:ok\n", child
print(child.stdout, end="", flush=True)
time.sleep(0.01)

payload = bytes([0, 128, 255, 10])
(native / "python-bytes.bin").write_bytes(payload)
assert (native / "python-bytes.bin").read_bytes() == payload
assert Path("/readonly/input.txt").read_text() == value
try:
    Path("/readonly/blocked.txt").write_text("must fail")
except PermissionError:
    pass
else:
    raise AssertionError("Read-only mount accepted a write")

report = {"label": label, "input": value, "version": sys.version, "thread": "ok", "child": "ok"}
(native / "python-output.json").write_text(json.dumps(report))
print("native-files:ok", flush=True)
