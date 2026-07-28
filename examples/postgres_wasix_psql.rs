use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command as HostCommand,
    time::Duration,
};

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
        .start()
        .await?;

    // Capture mode retains bounded diagnostics without live readers, so the
    // guest never blocks on an unread pipe and no drain tasks are needed.
    let mut process = sandbox
        .command("postgres")
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
        .current_dir("/")
        .stdin(Stdio::Null)
        .stdout(Stdio::Capture)
        .stderr(Stdio::Capture)
        .spawn()
        .await?;

    // Probe the guest listener through the sandbox's own network policy.
    sandbox.ports().wait(port, Duration::from_secs(30)).await?;

    let (uri, psql_output) = run_psql(psql, port).await?;

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
