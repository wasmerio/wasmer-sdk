# Sandbox latency benchmark

This benchmark keeps four costs separate:

1. artifact acquisition (package download, image pull, or image build), which is
   performed before timed samples;
2. creation of a new, ready-to-execute sandbox;
3. startup of a guest runtime process in an existing sandbox; and
4. command round-trip latency through an existing sandbox.

This distinction matters for Wasmer in particular. With `.wasmer` populated,
`sandboxes.create()` constructs an isolated execution context without downloading
or compiling the package. The first command and each guest process launch are
therefore reported independently.

## Run

Create an isolated benchmark environment and authenticate remote providers using
process environment variables. Do not put API keys in this directory.

```sh
uv venv --python 3.13 .venv-benchmark
uv pip install --python .venv-benchmark/bin/python \
  -r benchmarks/sandboxes/requirements.txt

PYTHONPATH=python/src \
MODAL_TOKEN_ID="$MODAL_TOKEN_ID" \
MODAL_TOKEN_SECRET="$MODAL_TOKEN_SECRET" \
E2B_API_KEY="$E2B_API_KEY" \
.venv-benchmark/bin/python benchmarks/sandboxes/benchmark.py \
  --samples 30 \
  --cache-root .wasmer \
  --output artifacts/sandbox-benchmarks/results.json
```

Run providers independently with `--providers wasmer,docker`, `--providers
modal`, `--providers modal-v2`, or `--providers e2b`. Modal is pinned to
`us-west` by default. `modal-v2` selects Modal's beta V2 sandbox backend and is
reported independently from the standard backend.

E2B does not expose region selection in the SDK used by this benchmark, so its
result is reported as provider-selected. The stock E2B base template contains
Python and Node.js but not PHP or PostgreSQL. Build the reproducible multi-runtime
template, then select it for the benchmark:

```sh
E2B_API_KEY="$E2B_API_KEY" \
  .venv-benchmark/bin/python \
  benchmarks/sandboxes/build_e2b_template.py

E2B_BENCHMARK_TEMPLATE=wasmer-sdk-runtime-benchmark \
  E2B_API_KEY="$E2B_API_KEY" \
  .venv-benchmark/bin/python benchmarks/sandboxes/benchmark.py \
  --providers e2b --samples 30 \
  --output artifacts/sandbox-benchmarks/e2b.json
```

The JSON contains every raw sample, environment metadata, and a generated
summary. A Markdown table is written beside it. Failed or unavailable runtime
probes remain in the raw data and are never silently removed.

## Interpreting cold and warm

- **New/cold sandbox:** a newly allocated isolation boundary, after artifacts are
  locally or provider-side cached.
- **Warm/reused sandbox:** a command sent through an already running sandbox.
- **Runtime startup:** a new Python, Node.js, or PHP process in an existing
  sandbox. This excludes sandbox creation but includes the provider's command
  transport and process spawn.
- **End to end:** creation plus runtime startup plus command completion.

An empty artifact cache is an acquisition benchmark, not a sandbox-creation
benchmark. It should be reported separately because registry bandwidth and image
size otherwise dominate the result.
