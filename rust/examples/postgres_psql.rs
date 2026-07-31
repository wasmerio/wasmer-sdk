mod support;

use std::{env, ffi::OsString, path::PathBuf, process::Command as HostCommand, time::Duration};

use tokio::io::{AsyncBufReadExt, BufReader};
use wasmer_sdk::{Error, NetworkPolicy, Result, Stdio, Wasmer};

const PORT: u16 = 5432;

#[tokio::main]
async fn main() -> Result<()> {
    let psql = env::var_os("PSQL")
        .or_else(|| env::args_os().nth(1))
        .unwrap_or_else(|| OsString::from("psql"));
    let query = support::fixture("postgres/query.sql");

    let wasmer = Wasmer::new()?;
    let sandbox = wasmer
        .sandboxes()
        .create()
        .package("wasmer/pglite@0.1.0")
        .network(NetworkPolicy::Host)
        .await?;

    let mut postgres = sandbox
        .command("pglite")
        .stdin(Stdio::Null)
        .stdout(Stdio::Capture)
        .stderr(Stdio::Piped)
        .spawn()
        .await?;

    let stderr = postgres.take_stderr().ok_or_else(|| Error::InternalState {
        message: "missing piped PostgreSQL stderr".to_owned(),
    })?;
    wait_for_socket_ready(BufReader::new(stderr).lines()).await?;

    let (uri, psql_output) = run_psql(psql, query).await?;
    let output = postgres.wait().await?.check()?;
    let result = validate_psql(psql_output)?;

    println!("Connected native psql to PostgreSQL running in Wasmer: {uri}");
    print!("{result}");
    if !output.stdout.bytes().is_empty() {
        eprintln!(
            "PostgreSQL stdout:\n{}",
            String::from_utf8_lossy(output.stdout.bytes())
        );
    }
    sandbox.close().await?;
    Ok(())
}

async fn wait_for_socket_ready<R>(mut lines: tokio::io::Lines<BufReader<R>>) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let marker = format!("OLIPHAUNT_WASIX_SOCKET_READY {PORT}");
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(line) = lines.next_line().await? {
            if line.contains(&marker) {
                return Ok::<(), std::io::Error>(());
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "PostgreSQL exited before its socket-ready marker",
        ))
    })
    .await
    .map_err(|_| Error::Timeout {
        operation: "PostgreSQL socket readiness marker".to_owned(),
    })??;
    Ok(())
}

async fn run_psql(psql: OsString, query: PathBuf) -> Result<(String, std::process::Output)> {
    let uri = format!("postgresql://postgres@127.0.0.1:{PORT}/postgres?sslmode=disable");
    tokio::task::spawn_blocking(move || {
        HostCommand::new(psql)
            .args([uri.as_str(), "-X", "-v", "ON_ERROR_STOP=1", "-At", "-f"])
            .arg(query)
            .output()
            .map(|output| (uri, output))
    })
    .await
    .map_err(|error| Error::Task {
        message: format!("native psql task failed: {error}"),
    })?
    .map_err(Error::from)
}

fn validate_psql(output: std::process::Output) -> Result<String> {
    if !output.status.success() {
        return Err(Error::Execution {
            message: format!(
                "psql failed with {}\nstdout:\n{}\nstderr:\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            ),
        });
    }

    let result = String::from_utf8(output.stdout)?;
    if result.contains("wasm32-unknown-wasix") && result.lines().any(|line| line.ends_with("|42")) {
        return Ok(result);
    }

    Err(Error::Execution {
        message: format!(
            "unexpected psql result:\n{result}\npsql stderr:\n{}",
            String::from_utf8_lossy(&output.stderr),
        ),
    })
}
