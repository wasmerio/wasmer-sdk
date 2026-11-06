"""Compile a fixture, then execute it with a consumer that links no compiler."""
import argparse
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", default="1.99.1")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    cargo = ["cargo", "+" + args.toolchain]
    base = ["--locked", "-p", "wasmer-sdk"]
    runtime = ["--no-default-features", "--features", "sys-runtime"]
    tree = subprocess.check_output(
        cargo + ["tree"] + base + runtime + ["--edges", "normal,build,dev"],
        cwd=root, text=True,
    )
    for compiler in ("cranelift", "llvm", "singlepass"):
        assert "wasmer-compiler-" + compiler not in tree, tree
    with tempfile.TemporaryDirectory(prefix="sdk-precompiled-") as cache:
        example = ["--example", "precompiled"]
        subprocess.run(cargo + ["run"] + base + example + ["--", "compile", cache], cwd=root, check=True)
        subprocess.run(cargo + ["run"] + base + runtime + example + ["--", "run", cache], cwd=root, check=True)
    print("PASS compiler-free dependency graph and precompiled execution")


if __name__ == "__main__":
    main()
