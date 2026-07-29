use std::{
    io::Read,
    net::TcpListener,
    time::{Duration, Instant},
};

use tempfile::TempDir;
use wasmer_sdk::{CacheConfig, Error, NetworkPolicy, Result, Wasmer, WasmerConfig};

#[tokio::test(flavor = "multi_thread")]
async fn port_wait_uses_one_wall_clock_timeout() -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve test port");
    let port = listener.local_addr().expect("reserved address").port();
    drop(listener);

    let state = TempDir::new().expect("create SDK state directory");
    let client = Wasmer::new(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })?;
    let sandbox = client
        .sandbox()
        .network(NetworkPolicy::Host)
        .start()
        .await?;

    let started = Instant::now();
    let error = sandbox
        .ports()
        .wait(port, Duration::from_millis(120))
        .await
        .expect_err("an unopened port must time out");

    assert!(matches!(error, Error::Timeout { .. }));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "port probing exceeded its wall-clock budget"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn successful_port_wait_opens_and_closes_a_real_connection() -> Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test server");
    let port = listener.local_addr().expect("server address").port();
    let accepted = std::thread::spawn(move || {
        let (mut connection, _) = listener.accept().expect("accept readiness probe");
        let mut byte = [0_u8; 1];
        connection
            .read(&mut byte)
            .expect("observe readiness probe closing")
    });

    let state = TempDir::new().expect("create SDK state directory");
    let client = Wasmer::new(WasmerConfig {
        cache: CacheConfig {
            root: state.path().join(".wasmer"),
        },
        output_bytes: 1024,
    })?;
    let sandbox = client
        .sandbox()
        .network(NetworkPolicy::Host)
        .start()
        .await?;

    sandbox.ports().wait(port, Duration::from_secs(1)).await?;
    assert_eq!(accepted.join().expect("readiness server thread"), 0);
    Ok(())
}
