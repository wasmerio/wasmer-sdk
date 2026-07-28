use std::{env, path::PathBuf};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use wasmer_sdk::{NetworkPolicy, PackageSource, Result, Stdio, Wasmer, WasmerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let package = args
        .next()
        .map(PathBuf::from)
        .expect("usage: socket_server <package-directory> <command> [args...]");
    let command = args
        .next()
        .and_then(|value| value.into_string().ok())
        .expect("usage: socket_server <package-directory> <command> [args...]");
    let command_args = args
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();

    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let sandbox = wasmer
        .sandbox()
        .package(PackageSource::path(package))
        .network(NetworkPolicy::Host)
        .start()
        .await?;

    // Stdout stays piped because the ready line is read live; stderr uses
    // capture mode so no drain task is needed for diagnostics.
    let mut process = sandbox
        .command(command)
        .args(command_args)
        .stdin(Stdio::Null)
        .stderr(Stdio::Capture)
        .spawn()
        .await?;
    let stdout = process.take_stdout().expect("piped stdout");
    let mut stdout = BufReader::new(stdout);
    let mut ready = String::new();
    stdout.read_line(&mut ready).await?;
    println!("{}", ready.trim_end());

    let output_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });

    let output = process.wait().await?;
    let remaining_stdout = output_task.await.expect("stdout reader task")?;
    if !remaining_stdout.is_empty() {
        print!("{}", String::from_utf8_lossy(&remaining_stdout));
    }
    if !output.stderr.bytes().is_empty() {
        eprint!("{}", String::from_utf8_lossy(output.stderr.bytes()));
    }
    output.check()?;
    sandbox.close().await?;
    Ok(())
}
