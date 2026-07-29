use std::{path::PathBuf, process::Command as HostCommand, time::Duration};

use tokio::io::{AsyncBufReadExt, BufReader};
use wasmer_sdk::{Error, NetworkPolicy, Result, Stdio, Wasmer, WasmerConfig};

const PORT: u16 = 5432;

#[tokio::main]
async fn main() -> Result<()> {
    let psql = required_file(1, "native psql client")?;

    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let pglite = wasmer.packages().load("wasmer/pglite@0.1.0").await?;
    let sandbox = wasmer
        .sandboxes()
        .create()
        .package(pglite.clone())
        .network(NetworkPolicy::Host)
        .await?;

    let mut process = sandbox
        .command(pglite)
        .stdin(Stdio::Null)
        .stdout(Stdio::Capture)
        .stderr(Stdio::Piped)
        .spawn()
        .await?;

    let stderr = process.take_stderr().ok_or_else(|| Error::InternalState {
        message: "missing piped PostgreSQL stderr".to_owned(),
    })?;
    wait_for_socket_ready(BufReader::new(stderr).lines()).await?;

    let (uri, psql_output) = run_psql(psql).await?;
    let output = process.wait().await?.check()?;
    let result = validate_psql(psql_output)?;

    println!("connected directly to WASIX PostgreSQL: {uri}");
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

async fn run_psql(psql: PathBuf) -> Result<(String, std::process::Output)> {
    let uri = format!("postgresql://postgres@127.0.0.1:{PORT}/postgres?sslmode=disable");
    tokio::task::spawn_blocking(move || {
        HostCommand::new(psql)
            .args([
                &uri,
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "-At",
                "-c",
                "select version(), 40 + 2 as answer;",
            ])
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

fn required_file(index: usize, description: &str) -> Result<PathBuf> {
    let path = argument(index, description)?.canonicalize()?;
    if path.is_file() {
        Ok(path)
    } else {
        Err(Error::Initialization {
            message: format!("{description} is not a file: {}", path.display()),
        })
    }
}

fn argument(index: usize, description: &str) -> Result<PathBuf> {
    std::env::args_os()
        .nth(index)
        .map(PathBuf::from)
        .ok_or_else(|| Error::Initialization {
            message: format!("usage: postgres_wasix_psql <psql>; missing {description}"),
        })
}
