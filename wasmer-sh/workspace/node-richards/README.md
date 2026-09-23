# Richards.js

A dependency-free JavaScript CPU benchmark that simulates an operating-system
task scheduler. Both wasmer.sh and the iOS WasmerShell run this same file with
the same Edge.js package. Select **Richards.js** under **Node.js**, then run:

```sh
node richards.js
```

The default runs one warm-up batch followed by five timed samples, each with
1,000 complete Richards iterations. Every iteration verifies the original
expected counts: 2,322 queued packets and 928 held tasks. A mismatch fails the
command instead of reporting a successful benchmark.

Output includes each sample's milliseconds, the median, the range,
milliseconds per iteration, and iterations per second. Lower time is better;
higher throughput is better. These are elapsed times, not an Octane score.

## Compare runs

Use identical arguments on each platform. Increase the iteration count for
longer samples, or the sample count to see more variation:

```sh
node richards.js 10000 7
node richards.js --help
```

Only the workload and its correctness checks are timed. Package downloads,
process startup, script loading, warm-up, and terminal output are excluded.
The loop does no filesystem or network I/O, so changing workspace storage
does not change the work being measured. This measures one JavaScript CPU
workload, not package installation, server startup, or overall SDK performance.

Keep the app or browser in the foreground, use the same power mode, close
other heavy workloads, and record the device, browser/iOS version, and runtime
line with the results. Simulator results measure your Mac, not an iPhone's CPU.

For a native Node.js baseline, run this same file with Node on your computer.
That is a different execution path from Edge.js inside wasmer.sh or WasmerShell.
The benchmark does not start a server or open a preview.

## Source and license

The scheduler is from [V8's Octane Richards benchmark](https://github.com/chromium/octane/blob/570ad1ccfe86e3eecba0636c8f932ac08edec517/richards.js),
originally written by Martin Richards in BCPL. The upstream algorithm and
correctness checks are unchanged; the Octane suite registration is replaced
with a small command-line timing runner. Its BSD license is retained at the
top of `richards.js`.
