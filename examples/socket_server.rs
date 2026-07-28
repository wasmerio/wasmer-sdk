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

    let mut process = sandbox
        .command(command)
        .args(command_args)
        .stdin(Stdio::Null)
        .spawn()
        .await?;
    let stdout = process.take_stdout().expect("piped stdout");
    let mut stderr = process.take_stderr().expect("piped stderr");
    let mut stdout = BufReader::new(stdout);
    let mut ready = String::new();
    stdout.read_line(&mut ready).await?;
    println!("{}", ready.trim_end());

    let output_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });
    let error_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    });

    let output = process.wait().await?;
    let remaining_stdout = output_task.await.expect("stdout reader task")?;
    let stderr = error_task.await.expect("stderr reader task")?;
    if !remaining_stdout.is_empty() {
        print!("{}", String::from_utf8_lossy(&remaining_stdout));
    }
    if !stderr.is_empty() {
        eprint!("{}", String::from_utf8_lossy(&stderr));
    }
    output.check()?;
    Ok(())
}
