#!/usr/bin/env python3
"""Measure sandbox creation, runtime startup, and command latency separately.

The benchmark deliberately excludes package/image downloads from timed samples.
Prepare each provider first, then measure new sandboxes and reuse independently.
Raw samples are written as JSON so summaries can be regenerated without reruns.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import platform
import statistics
import subprocess
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable


RUNTIMES = {
    "python": {
        "wasmer_package": "python/python@=3.13.18",
        "wasmer_command": ("python", ["-c", "pass"]),
        "docker_image": "python:3.13.5-slim",
        "docker_command": ["python", "-c", "pass"],
        "modal_image": "python:3.13.5-slim",
        "modal_command": ["python", "-c", "pass"],
        "e2b_command": "python3 -c pass",
    },
    "node": {
        "wasmer_package": "wasmer/edgejs@=0.2.0",
        "wasmer_command": ("node", ["-e", ""]),
        "docker_image": "node:24-slim",
        "docker_command": ["node", "-e", ""],
        "modal_image": "node:24-slim",
        "modal_command": ["node", "-e", ""],
        "e2b_command": "node -e ''",
    },
    "php": {
        "wasmer_package": "php/php-32",
        "wasmer_command": ("php", ["-r", ";"]),
        "docker_image": "php:8.3-cli",
        "docker_command": ["php", "-r", ";"],
        "modal_image": "php:8.3-cli",
        "modal_command": ["php", "-r", ";"],
        "e2b_command": "php -r ';'",
    },
}


@dataclass
class Sample:
    provider: str
    suite: str
    condition: str
    runtime: str | None
    index: int
    duration_ms: float | None
    ok: bool
    note: str | None = None


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def elapsed_ms(start: float) -> float:
    return (time.perf_counter() - start) * 1000.0


def percentile(values: list[float], probability: float) -> float:
    """Linear percentile, equivalent to NumPy's default interpolation."""
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def checked(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        **kwargs,
    )


async def repeat(
    samples: list[Sample],
    *,
    provider: str,
    suite: str,
    condition: str,
    runtime: str | None,
    count: int,
    operation: Callable[[], Awaitable[None]],
) -> None:
    for index in range(count):
        start = time.perf_counter()
        try:
            await operation()
        except Exception as error:  # retain failed samples in the raw data
            samples.append(
                Sample(
                    provider,
                    suite,
                    condition,
                    runtime,
                    index,
                    elapsed_ms(start),
                    False,
                    f"{type(error).__name__}: {error}",
                )
            )
        else:
            samples.append(
                Sample(
                    provider,
                    suite,
                    condition,
                    runtime,
                    index,
                    elapsed_ms(start),
                    True,
                )
            )


async def benchmark_wasmer(count: int, cache_root: Path) -> tuple[list[Sample], dict[str, str]]:
    from wasmer_sdk import Wasmer

    samples: list[Sample] = []
    wasmer = Wasmer(cache_root=cache_root)
    packages: dict[str, Any] = {}
    for runtime, spec in RUNTIMES.items():
        packages[runtime] = await wasmer.packages.load(spec["wasmer_package"])
    tools = await wasmer.packages.load("wasmer/coreutils@=1.0.25")
    postgres = await wasmer.packages.load("wasmer/pglite@=0.1.0")

    # Force compilation before samples. Disk package acquisition and compilation
    # are preparation, not sandbox creation or CPython startup.
    warm = await wasmer.sandboxes.create(packages=[*packages.values(), tools])
    await warm.command(tools.command("true")).run()
    for runtime, spec in RUNTIMES.items():
        command, args = spec["wasmer_command"]
        try:
            await warm.command(command, args).run()
        except Exception:
            # Capability mismatches are retained as failed timed samples below.
            # One unavailable runtime must not suppress the other measurements.
            pass
    await warm.close()

    async def create() -> None:
        sandbox = await wasmer.sandboxes.create(packages=[packages["python"]])
        await sandbox.close()

    postgres_sandbox = await wasmer.sandboxes.create(
        packages=[postgres], network="host"
    )

    postgres_port = 54_320

    async def postgres_startup() -> None:
        nonlocal postgres_port
        postgres_port += 1
        port = postgres_port
        process = await postgres_sandbox.command(
            "pglite", env={"OLIPHAUNT_WASIX_SOCKET_PORT": str(port)}
        ).spawn(
            stdout="discard", stderr="pipe"
        )
        assert process.stderr is not None
        try:
            async def ready() -> None:
                async for line in process.stderr.lines():
                    if f"OLIPHAUNT_WASIX_SOCKET_READY {port}" in line:
                        return
                raise RuntimeError("pglite exited before its readiness marker")

            await asyncio.wait_for(ready(), timeout=30)
        finally:
            await process.kill()
            await process.wait()

    await repeat(
        samples,
        provider="wasmer",
        suite="application_startup",
        condition="server_ready_existing_sandbox",
        runtime="postgres",
        count=count,
        operation=postgres_startup,
    )
    await postgres_sandbox.close()

    await repeat(
        samples,
        provider="wasmer",
        suite="sandbox_creation",
        condition="new_sandbox_warm_artifact_cache",
        runtime=None,
        count=count,
        operation=create,
    )

    reusable = await wasmer.sandboxes.create(packages=[tools])

    async def command() -> None:
        await reusable.command("true").run()

    await repeat(
        samples,
        provider="wasmer",
        suite="command_latency",
        condition="existing_sandbox",
        runtime=None,
        count=count,
        operation=command,
    )
    await reusable.close()

    for runtime, spec in RUNTIMES.items():
        command_name, args = spec["wasmer_command"]

        async def startup(
            package: Any = packages[runtime],
            executable: str = command_name,
            arguments: list[str] = args,
        ) -> None:
            sandbox = await wasmer.sandboxes.create(packages=[package])
            try:
                # The timer in repeat begins before this sandbox creation. Record
                # a second suite below to isolate just the process startup.
                await sandbox.command(executable, arguments).run()
            finally:
                await sandbox.close()

        await repeat(
            samples,
            provider="wasmer",
            suite="end_to_end",
            condition="new_sandbox_warm_artifact_cache",
            runtime=runtime,
            count=count,
            operation=startup,
        )

        sandbox = await wasmer.sandboxes.create(packages=[packages[runtime]])

        async def process_startup(
            executable: str = command_name,
            arguments: list[str] = args,
            active: Any = sandbox,
        ) -> None:
            await active.command(executable, arguments).run()

        await repeat(
            samples,
            provider="wasmer",
            suite="application_startup",
            condition="new_process_existing_sandbox",
            runtime=runtime,
            count=count,
            operation=process_startup,
        )
        await sandbox.close()

    await wasmer.close()
    return samples, {
        "cache_root": str(cache_root.resolve()),
        "command_package": tools.id,
        "python_package": packages["python"].id,
        "node_package": packages["node"].id,
        "php_package": packages["php"].id,
        "postgres_package": postgres.id,
    }


class DockerContainer:
    def __init__(self, image: str) -> None:
        result = checked(
            ["docker", "run", "--detach", "--rm", "--entrypoint", "tail", image, "-f", "/dev/null"]
        )
        self.id = result.stdout.strip()

    def run(self, command: list[str]) -> None:
        checked(["docker", "exec", self.id, *command])

    def close(self) -> None:
        subprocess.run(["docker", "rm", "--force", self.id], capture_output=True)


async def benchmark_docker(count: int) -> tuple[list[Sample], dict[str, str]]:
    samples: list[Sample] = []
    postgres_image = "postgres:17-alpine"
    images = sorted(
        {str(spec["docker_image"]) for spec in RUNTIMES.values()}
        | {postgres_image}
    )
    for image in images:
        await asyncio.to_thread(checked, ["docker", "pull", image])

    async def create() -> None:
        container = await asyncio.to_thread(DockerContainer, RUNTIMES["python"]["docker_image"])
        await asyncio.to_thread(container.close)

    await repeat(
        samples,
        provider="docker",
        suite="sandbox_creation",
        condition="new_container_warm_image_cache",
        runtime=None,
        count=count,
        operation=create,
    )

    reusable = await asyncio.to_thread(DockerContainer, RUNTIMES["python"]["docker_image"])

    async def command() -> None:
        await asyncio.to_thread(reusable.run, ["true"])

    await repeat(
        samples,
        provider="docker",
        suite="command_latency",
        condition="existing_container",
        runtime=None,
        count=count,
        operation=command,
    )
    await asyncio.to_thread(reusable.close)

    async def end_to_end() -> None:
        container = await asyncio.to_thread(
            DockerContainer, RUNTIMES["python"]["docker_image"]
        )
        try:
            await asyncio.to_thread(
                container.run, RUNTIMES["python"]["docker_command"]
            )
        finally:
            await asyncio.to_thread(container.close)

    await repeat(
        samples,
        provider="docker",
        suite="end_to_end",
        condition="new_container_warm_image_cache",
        runtime="python",
        count=count,
        operation=end_to_end,
    )

    versions: dict[str, str] = {}
    for runtime, spec in RUNTIMES.items():
        container = await asyncio.to_thread(DockerContainer, spec["docker_image"])

        async def startup(active: DockerContainer = container, command_line: list[str] = spec["docker_command"]) -> None:
            await asyncio.to_thread(active.run, command_line)

        await repeat(
            samples,
            provider="docker",
            suite="application_startup",
            condition="new_process_existing_container",
            runtime=runtime,
            count=count,
            operation=startup,
        )
        version_command = {
            "python": ["python", "--version"],
            "node": ["node", "--version"],
            "php": ["php", "--version"],
        }[runtime]
        result = await asyncio.to_thread(
            checked, ["docker", "exec", container.id, *version_command]
        )
        versions[runtime] = (result.stdout or result.stderr).splitlines()[0]
        await asyncio.to_thread(container.close)

    volume = f"wasmer-sdk-benchmark-postgres-{os.getpid()}"
    await asyncio.to_thread(checked, ["docker", "volume", "create", volume])
    initializer: str | None = None
    postgres_container: DockerContainer | None = None
    try:
        initializer = (
            await asyncio.to_thread(
                checked,
                [
                    "docker",
                    "run",
                    "--detach",
                    "--rm",
                    "-e",
                    "POSTGRES_HOST_AUTH_METHOD=trust",
                    "-v",
                    f"{volume}:/var/lib/postgresql/data",
                    postgres_image,
                ],
            )
        ).stdout.strip()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            ready = subprocess.run(
                ["docker", "exec", initializer, "pg_isready", "-U", "postgres"],
                capture_output=True,
            )
            if ready.returncode == 0:
                break
            await asyncio.sleep(0.05)
        else:
            raise RuntimeError("Docker PostgreSQL initialization timed out")
        await asyncio.to_thread(
            checked, ["docker", "stop", "--time", "10", initializer]
        )
        initializer = None

        result = await asyncio.to_thread(
            checked,
            [
                "docker",
                "run",
                "--detach",
                "--rm",
                "--entrypoint",
                "tail",
                "-v",
                f"{volume}:/var/lib/postgresql/data",
                postgres_image,
                "-f",
                "/dev/null",
            ],
        )
        postgres_container = DockerContainer.__new__(DockerContainer)
        postgres_container.id = result.stdout.strip()

        async def postgres_startup() -> None:
            await asyncio.to_thread(
                checked,
                [
                    "docker",
                    "exec",
                    "--detach",
                    "--user",
                    "postgres",
                    postgres_container.id,
                    "postgres",
                    "-D",
                    "/var/lib/postgresql/data",
                    "-k",
                    "/tmp",
                    "-c",
                    "listen_addresses=",
                ],
            )
            deadline = time.monotonic() + 30
            try:
                while time.monotonic() < deadline:
                    ready = subprocess.run(
                        [
                            "docker",
                            "exec",
                            postgres_container.id,
                            "pg_isready",
                            "-h",
                            "/tmp",
                            "-U",
                            "postgres",
                        ],
                        capture_output=True,
                    )
                    if ready.returncode == 0:
                        return
                    await asyncio.sleep(0.02)
                raise RuntimeError("Docker PostgreSQL readiness timed out")
            finally:
                subprocess.run(
                    [
                        "docker",
                        "exec",
                        "--user",
                        "postgres",
                        postgres_container.id,
                        "pg_ctl",
                        "-D",
                        "/var/lib/postgresql/data",
                        "-m",
                        "fast",
                        "stop",
                    ],
                    capture_output=True,
                )

        await repeat(
            samples,
            provider="docker",
            suite="application_startup",
            condition="server_ready_existing_container_warm_data",
            runtime="postgres",
            count=count,
            operation=postgres_startup,
        )
    finally:
        if initializer is not None:
            subprocess.run(
                ["docker", "rm", "--force", initializer], capture_output=True
            )
        if postgres_container is not None:
            await asyncio.to_thread(postgres_container.close)
        subprocess.run(["docker", "volume", "rm", volume], capture_output=True)

    return samples, versions


async def benchmark_modal(
    count: int, region: str, *, v2: bool = False
) -> tuple[list[Sample], dict[str, str]]:
    import modal

    samples: list[Sample] = []
    provider = "modal-v2" if v2 else "modal"
    create_sandbox = (
        modal.Sandbox._experimental_create if v2 else modal.Sandbox.create
    )
    app = await asyncio.to_thread(
        modal.App.lookup, "wasmer-sdk-sandbox-benchmark", create_if_missing=True
    )
    images = {
        runtime: modal.Image.from_registry(str(spec["modal_image"]))
        for runtime, spec in RUNTIMES.items()
    }

    def new_sandbox(runtime: str = "python") -> Any:
        return create_sandbox(
            app=app, image=images[runtime], timeout=300, region=region
        )

    def close(sandbox: Any) -> None:
        sandbox.terminate(wait=False)
        sandbox.detach()

    # An untimed create resolves/builds the image before measuring allocation.
    warm = await asyncio.to_thread(new_sandbox)
    await asyncio.to_thread(close, warm)

    async def create() -> None:
        sandbox = await asyncio.to_thread(new_sandbox)
        await asyncio.to_thread(close, sandbox)

    await repeat(
        samples,
        provider=provider,
        suite="sandbox_creation",
        condition=f"new_sandbox_cached_image_{region}",
        runtime=None,
        count=count,
        operation=create,
    )

    reusable = await asyncio.to_thread(new_sandbox)

    async def command() -> None:
        def run() -> None:
            process = reusable.exec("true")
            process.wait()
            if process.returncode != 0:
                raise RuntimeError(f"true exited {process.returncode}")

        await asyncio.to_thread(run)

    await repeat(
        samples,
        provider=provider,
        suite="command_latency",
        condition=f"existing_sandbox_client_to_{region}",
        runtime=None,
        count=count,
        operation=command,
    )
    await asyncio.to_thread(close, reusable)

    async def end_to_end() -> None:
        sandbox = await asyncio.to_thread(new_sandbox)
        try:
            def run() -> None:
                process = sandbox.exec(*RUNTIMES["python"]["modal_command"])
                process.wait()
                if process.returncode != 0:
                    raise RuntimeError(f"python exited {process.returncode}")

            await asyncio.to_thread(run)
        finally:
            await asyncio.to_thread(close, sandbox)

    await repeat(
        samples,
        provider=provider,
        suite="end_to_end",
        condition=f"new_sandbox_cached_image_{region}",
        runtime="python",
        count=count,
        operation=end_to_end,
    )

    versions: dict[str, str] = {
        "region": region,
        "backend": "v2" if v2 else "v1",
    }
    for runtime, spec in RUNTIMES.items():
        sandbox = await asyncio.to_thread(new_sandbox, runtime)

        async def startup(active: Any = sandbox, command_line: list[str] = spec["modal_command"]) -> None:
            def run() -> None:
                process = active.exec(*command_line)
                process.wait()
                if process.returncode != 0:
                    raise RuntimeError(f"runtime exited {process.returncode}")

            await asyncio.to_thread(run)

        await repeat(
            samples,
            provider=provider,
            suite="application_startup",
            condition="new_process_existing_sandbox",
            runtime=runtime,
            count=count,
            operation=startup,
        )
        await asyncio.to_thread(close, sandbox)

    postgres_image = modal.Image.from_registry("postgres:17-alpine")
    postgres_sandbox = await asyncio.to_thread(
        lambda: create_sandbox(
            "sleep",
            "300",
            app=app,
            image=postgres_image,
            timeout=300,
            region=region,
            memory=1024,
        )
    )
    try:
        def initialize_postgres() -> None:
            process = postgres_sandbox.exec(
                "sh",
                "-lc",
                "mkdir -p /tmp/pgdata && chown postgres:postgres /tmp/pgdata && "
                "gosu postgres initdb -D /tmp/pgdata -A trust",
            )
            process.stdout.read()
            process.stderr.read()
            process.wait()
            if process.returncode != 0:
                raise RuntimeError(f"initdb exited {process.returncode}")

        await asyncio.to_thread(initialize_postgres)

        async def postgres_startup() -> None:
            process = await asyncio.to_thread(
                postgres_sandbox.exec,
                "gosu",
                "postgres",
                "postgres",
                "-D",
                "/tmp/pgdata",
                "-k",
                "/tmp",
                "-c",
                "listen_addresses=",
            )
            deadline = time.monotonic() + 30
            try:
                while time.monotonic() < deadline:
                    def ready() -> bool:
                        probe = postgres_sandbox.exec(
                            "pg_isready", "-h", "/tmp", "-U", "postgres"
                        )
                        probe.wait()
                        return probe.returncode == 0

                    if await asyncio.to_thread(ready):
                        return
                    await asyncio.sleep(0.02)
                raise RuntimeError("Modal PostgreSQL readiness timed out")
            finally:
                def stop() -> None:
                    stopper = postgres_sandbox.exec(
                        "gosu",
                        "postgres",
                        "pg_ctl",
                        "-D",
                        "/tmp/pgdata",
                        "-m",
                        "fast",
                        "stop",
                    )
                    stopper.wait()
                    process.wait()

                await asyncio.to_thread(stop)

        await repeat(
            samples,
            provider=provider,
            suite="application_startup",
            condition="server_ready_existing_sandbox_warm_data",
            runtime="postgres",
            count=count,
            operation=postgres_startup,
        )
    finally:
        await asyncio.to_thread(close, postgres_sandbox)
    return samples, versions


async def benchmark_e2b(count: int, template: str | None) -> tuple[list[Sample], dict[str, str]]:
    from e2b import Sandbox

    samples: list[Sample] = []

    def new_sandbox() -> Any:
        return Sandbox.create(template=template, timeout=300)

    warm = await asyncio.to_thread(new_sandbox)
    await asyncio.to_thread(warm.kill)

    async def create() -> None:
        sandbox = await asyncio.to_thread(new_sandbox)
        await asyncio.to_thread(sandbox.kill)

    await repeat(
        samples,
        provider="e2b",
        suite="sandbox_creation",
        condition="new_sandbox_provider_template_cache",
        runtime=None,
        count=count,
        operation=create,
    )

    reusable = await asyncio.to_thread(new_sandbox)

    async def command() -> None:
        result = await asyncio.to_thread(reusable.commands.run, "true")
        if result.exit_code != 0:
            raise RuntimeError(f"true exited {result.exit_code}")

    await repeat(
        samples,
        provider="e2b",
        suite="command_latency",
        condition="existing_sandbox_remote_round_trip",
        runtime=None,
        count=count,
        operation=command,
    )

    async def end_to_end() -> None:
        sandbox = await asyncio.to_thread(new_sandbox)
        try:
            result = await asyncio.to_thread(
                sandbox.commands.run, RUNTIMES["python"]["e2b_command"]
            )
            if result.exit_code != 0:
                raise RuntimeError(f"python exited {result.exit_code}")
        finally:
            await asyncio.to_thread(sandbox.kill)

    await repeat(
        samples,
        provider="e2b",
        suite="end_to_end",
        condition="new_sandbox_provider_template_cache",
        runtime="python",
        count=count,
        operation=end_to_end,
    )

    versions: dict[str, str] = {"template": template or "base"}
    for runtime, spec in RUNTIMES.items():
        executable = str(spec["e2b_command"]).split()[0]
        probe = await asyncio.to_thread(
            reusable.commands.run,
            f"command -v {executable} >/dev/null 2>&1 || echo MISSING",
        )
        if "MISSING" in probe.stdout:
            samples.append(
                Sample(
                    "e2b",
                    "application_startup",
                    "runtime_unavailable_in_template",
                    runtime,
                    0,
                    None,
                    False,
                    f"{runtime} is absent from E2B template {template or 'base'}",
                )
            )
            continue

        async def startup(command_line: str = str(spec["e2b_command"])) -> None:
            result = await asyncio.to_thread(reusable.commands.run, command_line)
            if result.exit_code != 0:
                raise RuntimeError(f"runtime exited {result.exit_code}")

        await repeat(
            samples,
            provider="e2b",
            suite="application_startup",
            condition="new_process_existing_sandbox",
            runtime=runtime,
            count=count,
            operation=startup,
        )
    postgres_probe = await asyncio.to_thread(
        reusable.commands.run,
        "command -v pg_config >/dev/null 2>&1 || echo MISSING",
    )
    if "MISSING" in postgres_probe.stdout:
        samples.append(
            Sample(
                "e2b",
                "application_startup",
                "runtime_unavailable_in_template",
                "postgres",
                0,
                None,
                False,
                f"postgres is absent from E2B template {template or 'base'}",
            )
        )
    else:
        async def postgres_startup() -> None:
            process = await asyncio.to_thread(
                reusable.commands.run,
                "$(pg_config --bindir)/postgres -D /opt/pgdata -k /tmp "
                "-c listen_addresses=",
                background=True,
                user="postgres",
            )
            deadline = time.monotonic() + 30
            try:
                while time.monotonic() < deadline:
                    probe = await asyncio.to_thread(
                        reusable.commands.run,
                        "pg_isready -h /tmp -U postgres >/dev/null 2>&1 && "
                        "echo READY || echo WAIT",
                    )
                    if "READY" in probe.stdout:
                        return
                    await asyncio.sleep(0.02)
                raise RuntimeError("E2B PostgreSQL readiness timed out")
            finally:
                await asyncio.to_thread(
                    reusable.commands.run,
                    "$(pg_config --bindir)/pg_ctl -D /opt/pgdata -m fast stop",
                    user="postgres",
                )
                await asyncio.to_thread(process.wait)

        await repeat(
            samples,
            provider="e2b",
            suite="application_startup",
            condition="server_ready_existing_sandbox_warm_data",
            runtime="postgres",
            count=count,
            operation=postgres_startup,
        )
    await asyncio.to_thread(reusable.kill)
    return samples, versions


def summarize(samples: Iterable[Sample]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str, str | None], list[Sample]] = {}
    for sample in samples:
        key = (sample.provider, sample.suite, sample.condition, sample.runtime)
        groups.setdefault(key, []).append(sample)
    summary: list[dict[str, Any]] = []
    for key, group in sorted(groups.items()):
        values = [sample.duration_ms for sample in group if sample.ok and sample.duration_ms is not None]
        summary.append(
            {
                "provider": key[0],
                "suite": key[1],
                "condition": key[2],
                "runtime": key[3],
                "n": len(values),
                "failures": len(group) - len(values),
                "p50_ms": round(statistics.median(values), 3) if values else None,
                "p95_ms": round(percentile(values, 0.95), 3) if values else None,
                "min_ms": round(min(values), 3) if values else None,
                "max_ms": round(max(values), 3) if values else None,
            }
        )
    return summary


def markdown(summary: list[dict[str, Any]]) -> str:
    lines = [
        "| Provider | Suite | Condition | Runtime | n | failures | p50 ms | p95 ms |",
        "|---|---|---|---:|---:|---:|---:|---:|",
    ]
    for row in summary:
        rendered = {**row, "runtime": row["runtime"] or "—"}
        lines.append(
            "| {provider} | {suite} | {condition} | {runtime} | {n} | {failures} | {p50_ms} | {p95_ms} |".format(
                **rendered
            )
        )
    return "\n".join(lines) + "\n"


async def main() -> None:
    started_at = now()
    benchmark_started = time.perf_counter()
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--providers",
        default="wasmer,docker,modal,e2b",
        help="comma-separated provider list",
    )
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--cache-root", type=Path, default=Path(".wasmer"))
    parser.add_argument("--modal-region", default="us-west")
    parser.add_argument("--e2b-template", default=os.environ.get("E2B_BENCHMARK_TEMPLATE"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.samples < 2:
        parser.error("--samples must be at least 2")

    providers = [value.strip() for value in args.providers.split(",") if value.strip()]
    all_samples: list[Sample] = []
    details: dict[str, Any] = {}
    runners = {
        "wasmer": lambda: benchmark_wasmer(args.samples, args.cache_root),
        "docker": lambda: benchmark_docker(args.samples),
        "modal": lambda: benchmark_modal(args.samples, args.modal_region),
        "modal-v2": lambda: benchmark_modal(
            args.samples, args.modal_region, v2=True
        ),
        "e2b": lambda: benchmark_e2b(args.samples, args.e2b_template),
    }
    for provider in providers:
        if provider not in runners:
            parser.error(f"unknown provider: {provider}")
        print(f"[{provider}] running", flush=True)
        provider_samples, provider_details = await runners[provider]()
        all_samples.extend(provider_samples)
        details[provider] = provider_details
        print(f"[{provider}] complete", flush=True)

    result = {
        "started_at": started_at,
        "completed_at": now(),
        "duration_seconds": round(time.perf_counter() - benchmark_started, 3),
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "samples_per_group": args.samples,
        "providers": details,
        "samples": [asdict(sample) for sample in all_samples],
        "summary": summarize(all_samples),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    args.output.with_suffix(".md").write_text(markdown(result["summary"]))
    print(args.output)


if __name__ == "__main__":
    asyncio.run(main())
