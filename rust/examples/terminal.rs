use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wasmer_sdk::{Result, TerminalOptions, Wasmer};

#[tokio::main]
async fn main() -> Result<()> {
    let wasmer = Wasmer::new()?;
    let sandbox = wasmer.sandboxes().create().package("wasmer/bash").await?;
    let mut process = sandbox
        .command("bash")
        .args(["--noprofile", "--norc", "-i"])
        .terminal(TerminalOptions::default())
        .spawn()
        .await?;

    let mut stdin = process.take_stdin().expect("terminal stdin");
    let mut stdout = process.take_stdout().expect("terminal stdout");
    let mut stderr = process.take_stderr().expect("terminal stderr");
    let output = async move {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    };
    let errors = async move {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    };

    stdin
        .write_all(b"echo 'hello from the terminal'\rexit\r")
        .await?;
    stdin.close().await?;
    let (output, errors, status) = tokio::join!(output, errors, process.wait());
    status?.check()?;
    print!("{}", String::from_utf8_lossy(&output?));
    eprint!("{}", String::from_utf8_lossy(&errors?));
    Ok(())
}
