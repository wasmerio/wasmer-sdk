#!/usr/bin/env python3
"""Exercise the actual Node proxy, Go module ZIP, installer and both link modes."""
from __future__ import annotations

import argparse
import functools
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", required=True, type=Path)
    args = parser.parse_args()
    assets = args.assets.resolve()
    version = (PACKAGE / "version.txt").read_text().strip()
    module = "go.wasmer.io/sdk"
    info = json.loads((assets / f"v{version}.info").read_text())
    go = shutil.which("go")
    node = shutil.which("node")
    if not go or not node:
        parser.error("Go and Node.js must be on PATH")
    target = "-".join(subprocess.check_output([go, "env", "GOOS", "GOARCH"], text=True).split())
    archive = assets / f"wasmer-sdk-go-{version}-{target}.tar.gz"
    with tempfile.TemporaryDirectory(prefix="wasmer-go-consumer-") as temporary:
        work = Path(temporary)
        release_root = work / "releases"
        tag = release_root / f"wasmer-sdk-go-v{version}"
        tag.mkdir(parents=True)
        for ext in ("info", "mod", "zip"):
            shutil.copy2(assets / f"v{version}.{ext}", tag)
        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *_):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(release_root)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        index = {"schema": 1, "module": module, "latest": "v" + version, "versions": {
            "v" + version: {"time": info["Time"], "source_sha": "a" * 40, "sha256": {
                ext: hashlib.sha256((assets / f"v{version}.{ext}").read_bytes()).hexdigest() for ext in ("info", "mod", "zip")
            }}}}
        index_file = work / "versions.json"
        index_file.write_text(json.dumps(index))
        javascript = (f"import {{ createProxy }} from {json.dumps((PACKAGE / 'proxy/server.mjs').as_uri())}; "
                      "const server = createProxy({indexFile: process.argv[1], releaseBase: process.argv[2]}); "
                      "server.listen(0, '127.0.0.1', () => console.log(server.address().port));")
        proxy = subprocess.Popen([node, "--input-type=module", "-e", javascript, str(index_file),
                                  f"http://127.0.0.1:{server.server_port}/"], stdout=subprocess.PIPE, text=True)
        try:
            port = proxy.stdout.readline().strip()
            if not port.isdigit():
                raise RuntimeError("Node module proxy did not start")
            consumer = work / "consumer"
            consumer.mkdir()
            env = dict(os.environ, GOPROXY=f"http://127.0.0.1:{port}/mod", GOSUMDB="off",
                       GOMODCACHE=str(work / "modules"), GOPATH=str(work / "gopath"), GOWORK="off",
                       GOTOOLCHAIN="local", WASMER_SDK_NATIVE_CACHE=str(work / "native"),
                       PATH=str(Path(go).parent) + os.pathsep + "/usr/bin:/bin:/usr/sbin:/sbin")
            # GOSUMDB=off is scoped to this unpublished local fixture, never user setup.
            env.pop("CGO_LDFLAGS", None)
            def run(command: list[str], **kwargs):
                print("+", " ".join(command), flush=True)
                return subprocess.run(command, cwd=consumer, env=env, check=True, **kwargs)
            run([go, "mod", "init", "example.org/consumer"])
            run([go, "get", f"{module}@v{version}"])
            helper = [go, "run", f"{module}/cmd/wasmer-sdk@v{version}"]
            run([*helper, "install", "--archive", str(archive)])
            fixture = PACKAGE.parent / "swift/Tests/WasmerSDKTests/Fixtures/hello.wasm"
            shutil.copy2(fixture, consumer / "hello.wasm")
            (consumer / "main.go").write_text('''package main
import ("fmt"; "os"; wasmer "go.wasmer.io/sdk")
func main() {
 w,e := wasmer.New(wasmer.Options{}); if e != nil { panic(e) }; defer w.Close()
 b,e := os.ReadFile(os.Args[1]); if e != nil { panic(e) }
 p,e := w.Packages.LoadBytes(b); if e != nil { panic(e) }
 s,e := w.Sandboxes.Create(wasmer.SandboxOptions{Packages:[]*wasmer.Package{p}}); if e != nil { panic(e) }
 out,e := s.Command("main").Run(wasmer.RunOptions{}); if e != nil { panic(e) }
 fmt.Print(out.Stdout.Text())
}
''')
            # Compile the pure-Go helper once, then verify offline operation too.
            run([go, "build", "-o", str(work / "helper"), f"{module}/cmd/wasmer-sdk"])
            env.update(GOPROXY="off", GOSUMDB="off")
            run([str(work / "helper"), "install"])
            for mode in ("static", "dynamic"):
                run([str(work / "helper"), "exec", "--link", mode, "--", go, "build", "-o", mode, "."])
                completed = run([str(consumer / mode), "hello.wasm"], capture_output=True, text=True)
                if "Hello from Swift!" not in completed.stdout:
                    raise RuntimeError(f"{mode} consumer produced unexpected output: {completed.stdout}")
            # Validate a deployable dynamic layout, independent of cache paths.
            installed = next((work / "native" / version / target).iterdir())
            deployment = work / "deployment"
            deployment.mkdir()
            shutil.copytree(installed / "dynamic", deployment / "lib")
            rpath = "@executable_path/lib" if target.startswith("darwin") else "$ORIGIN/lib"
            env["CGO_ENABLED"] = "1"
            env["CGO_LDFLAGS"] = " ".join(json.dumps(flag) for flag in [
                "-L" + str(installed / "dynamic"), "-lwasmer_sdk_uniffi", "-Wl,-rpath," + rpath,
            ])
            run([go, "build", "-o", str(deployment / "dynamic"), "."])
            (work / "native").rename(work / "hidden-native-cache")
            for binary in (deployment / "dynamic", consumer / "static"):
                result = run([str(binary), "hello.wasm"], capture_output=True, text=True)
                if "Hello from Swift!" not in result.stdout:
                    raise RuntimeError("deployed executable could not run independently of the native cache")
            run([go, "mod", "verify"])
            print("Release consumer passed: clean module/native caches, no Rust, offline reuse, static and dynamic execution")
        finally:
            proxy.terminate()
            proxy.wait(timeout=10)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
