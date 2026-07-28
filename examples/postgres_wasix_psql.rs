use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command as HostCommand,
    time::Duration,
};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use wasmer_sdk::{Error, NetworkPolicy, PackageSource, Result, Stdio, Wasmer, WasmerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let postgres_wasm = required_file(1, "PostgreSQL WASIX module")?;
    let runtime_root = required_directory(2, "Oliphaunt runtime root")?;
    let pgdata = required_directory(3, "initialized PGDATA")?;
    let psql = required_file(4, "native psql client")?;
    require_file(&pgdata.join("PG_VERSION"), "PG_VERSION")?;
    require_file(&pgdata.join("global/pg_control"), "pg_control")?;

    let port = reserve_loopback_port()?;
    let package_dir = tempfile::TempDir::new()?;
    write_package(package_dir.path(), &postgres_wasm, &runtime_root, &pgdata)?;

    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let sandbox = wasmer
        .sandbox()
        .package(PackageSource::path(package_dir.path()))
        .network(NetworkPolicy::Host)
        .start()
        .await?;

    let mut postgres = sandbox.command("postgres");
    postgres
        .args([
            "--single",
            "-F",
            "-O",
            "-j",
            "-c",
            "io_method=sync",
            "-D",
            "/base",
            "postgres",
        ])
        .env("OLIPHAUNT_WASIX_SOCKET_PORT", port.to_string())
        .env("PREFIX", "/")
        .env("PGDATA", "/base")
        .env("PGUSER", "postgres")
        .env("PGDATABASE", "postgres")
        .env("PGSYSCONFDIR", "/base")
        .env("PGCLIENTENCODING", "UTF8")
        .env("LC_CTYPE", "C.UTF-8")
        .env("TZ", "UTC")
        .env("PGTZ", "UTC")
        .env("PG_COLOR", "never")
        .current_dir("/")
        .stdin(Stdio::Null)
        .stream_bytes(256 * 1024);

    let mut process = postgres.spawn().await?;
    let mut stdout = process.take_stdout().expect("PostgreSQL stdout is piped");
    let stderr = process.take_stderr().expect("PostgreSQL stderr is piped");
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });
    let (stderr, startup_stderr) = wait_until_listening(stderr, port).await?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = stderr;
        let mut bytes = startup_stderr;
        reader.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });

    let (uri, psql_output) = run_psql(psql, port).await?;

    let (process_output, stdout, stderr) = tokio::join!(process.wait(), stdout_task, stderr_task);
    let process_output = process_output?;
    let stdout = stdout.map_err(|error| Error::Task {
        message: format!("PostgreSQL stdout task failed: {error}"),
    })??;
    let stderr = stderr.map_err(|error| Error::Task {
        message: format!("PostgreSQL stderr task failed: {error}"),
    })??;

    process_output.check()?;
    let result = validate_psql(psql_output, &stderr)?;

    println!("connected directly to WASIX PostgreSQL: {uri}");
    print!("{result}");
    if !stdout.is_empty() {
        eprintln!("PostgreSQL stdout:\n{}", String::from_utf8_lossy(&stdout));
    }
    Ok(())
}

async fn run_psql(psql: PathBuf, port: u16) -> Result<(String, std::process::Output)> {
    let uri = format!("postgresql://postgres@127.0.0.1:{port}/postgres?sslmode=disable");
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

fn validate_psql(output: std::process::Output, postgres_stderr: &[u8]) -> Result<String> {
    if !output.status.success() {
        return Err(Error::Execution {
            message: format!(
                "psql failed with {}\nstdout:\n{}\nstderr:\n{}\nPostgreSQL stderr:\n{}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
                String::from_utf8_lossy(postgres_stderr),
            ),
        });
    }

    let result = String::from_utf8(output.stdout)?;
    if result.contains("wasm32-unknown-wasix") && result.lines().any(|line| line.ends_with("|42")) {
        return Ok(result);
    }

    Err(Error::Execution {
        message: format!(
            "unexpected psql result:\n{result}\npsql stderr:\n{}\nPostgreSQL stderr:\n{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(postgres_stderr),
        ),
    })
}

async fn wait_until_listening(
    stderr: wasmer_sdk::ProcessStderr,
    port: u16,
) -> Result<(BufReader<wasmer_sdk::ProcessStderr>, Vec<u8>)> {
    let mut reader = BufReader::new(stderr);
    let mut captured = Vec::new();
    let marker = format!("OLIPHAUNT_WASIX_SOCKET_READY {port}");
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let mut line = String::new();
            let bytes = reader.read_line(&mut line).await?;
            if bytes == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    format!(
                        "PostgreSQL exited before opening its WASIX socket\nstderr:\n{}",
                        String::from_utf8_lossy(&captured)
                    ),
                ));
            }
            captured.extend_from_slice(line.as_bytes());
            if line.trim_end() == marker {
                return Ok(());
            }
        }
    })
    .await
    .map_err(|_| Error::Execution {
        message: format!("timed out waiting for PostgreSQL WASIX socket on port {port}"),
    })??;
    Ok((reader, captured))
}

fn reserve_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn write_package(
    package: &Path,
    postgres_wasm: &Path,
    runtime: &Path,
    pgdata: &Path,
) -> Result<()> {
    let manifest = format!(
        r#"[package]
name = "local/postgres-wasix-socket"
version = "18.4.0"
description = "PostgreSQL WASIX with a guest-owned TCP listener"
entrypoint = "postgres"

[fs]
"/" = "{runtime}"
"/base" = "{pgdata}"

[[module]]
name = "postgres"
source = "{postgres_wasm}"
abi = "wasi"

[[command]]
name = "postgres"
module = "postgres"
runner = "wasi"

[command.annotations.wasi]
exec-name = "/bin/oliphaunt"
"#,
        runtime = toml_path(runtime),
        pgdata = toml_path(pgdata),
        postgres_wasm = toml_path(postgres_wasm),
    );
    std::fs::write(package.join("wasmer.toml"), manifest)?;
    Ok(())
}

fn required_file(index: usize, description: &str) -> Result<PathBuf> {
    let path = argument(index, description)?.canonicalize()?;
    require_file(&path, description)?;
    Ok(path)
}

fn required_directory(index: usize, description: &str) -> Result<PathBuf> {
    let path = argument(index, description)?.canonicalize()?;
    if !path.is_dir() {
        return Err(Error::Initialization {
            message: format!("{description} is not a directory: {}", path.display()),
        });
    }
    Ok(path)
}

fn argument(index: usize, description: &str) -> Result<PathBuf> {
    std::env::args_os()
        .nth(index)
        .map(PathBuf::from)
        .ok_or_else(|| Error::Initialization {
            message: format!(
                "usage: postgres_wasix_psql <postgres.wasm> <runtime-root> \
                 <initialized-pgdata> <psql>; missing {description}"
            ),
        })
}

fn require_file(path: &Path, description: &str) -> Result<()> {
    if path.is_file() {
        Ok(())
    } else {
        Err(Error::Initialization {
            message: format!("{description} is not a file: {}", path.display()),
        })
    }
}

fn toml_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}
