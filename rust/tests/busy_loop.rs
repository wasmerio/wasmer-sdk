//! A guest that never calls into the runtime must still stop when it is
//! killed or times out (wasmer-sdk#556).
#![cfg(unix)]

use std::time::{Duration, Instant};

use tempfile::TempDir;
use wasmer_sdk::{CacheConfig, ExitReason, Result, Wasmer, WasmerConfig};

const SPIN_WAT: &str = r#"
(module
  (import "wasi_snapshot_preview1" "proc_exit" (func (param i32)))
  (memory (export "memory") 1)
  (func (export "_start") (loop $spin (br $spin))))
"#;

// Both cases share one test: a concurrent test's spinning guest would show up
// in this process's CPU time.
#[tokio::test(flavor = "multi_thread")]
async fn kill_and_timeout_stop_a_guest_that_never_calls_the_runtime() -> Result<()> {
    let state = TempDir::new().expect("create SDK state directory");
    let client = Wasmer::with_config(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })?;
    let package = client
        .packages()
        .load(wat::parse_str(SPIN_WAT).expect("compile WAT"))
        .await?;
    let sandbox = client.sandboxes().create().package(package.clone()).await?;

    let output = sandbox
        .command(package.clone())
        .timeout(Duration::from_millis(100))
        .output()
        .await?;
    assert_eq!(output.reason, ExitReason::TimedOut);
    assert_eq!(output.status.code(), 137);
    assert_idle("after the timeout").await;

    let mut process = sandbox.command(package).spawn().await?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    process.kill()?;
    let output = tokio::time::timeout(Duration::from_secs(5), process.wait())
        .await
        .expect("killed process completes")?;
    assert_eq!(output.reason, ExitReason::Terminated);
    assert_eq!(output.status.code(), 137);
    assert_idle("after kill()").await;

    sandbox.close().await?;
    Ok(())
}

/// Assert that this process is not still running a guest.
async fn assert_idle(when: &str) {
    // Let the interrupt land before measuring.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (cpu, started) = (process_cpu_seconds(), Instant::now());
    tokio::time::sleep(Duration::from_secs(2)).await;
    let cores = (process_cpu_seconds() - cpu) / started.elapsed().as_secs_f64();
    assert!(cores < 0.5, "the guest still uses {cores:.2} cores {when}");
}

/// CPU time used by this process, in seconds.
fn process_cpu_seconds() -> f64 {
    #[cfg(target_os = "linux")]
    {
        // utime and stime are fields 14 and 15, in clock ticks of 1/100 s.
        let stat = std::fs::read_to_string("/proc/self/stat").expect("read /proc/self/stat");
        let fields: Vec<&str> = stat
            .rsplit_once(')')
            .expect("stat has a command name")
            .1
            .split_whitespace()
            .collect();
        let ticks: f64 = fields[11..13]
            .iter()
            .map(|field| field.parse::<f64>().expect("tick count"))
            .sum();
        ticks / 100.0
    }
    #[cfg(not(target_os = "linux"))]
    {
        // `ps` prints [[hh:]mm:]ss.cc.
        let output = std::process::Command::new("ps")
            .args(["-o", "cputime=", "-p", &std::process::id().to_string()])
            .output()
            .expect("run ps");
        String::from_utf8(output.stdout)
            .expect("ps output is UTF-8")
            .trim()
            .split(':')
            .fold(0.0, |total, part| {
                total * 60.0 + part.parse::<f64>().expect("CPU time component")
            })
    }
}
