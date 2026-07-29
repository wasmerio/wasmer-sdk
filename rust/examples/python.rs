use wasmer_sdk::{Result, Wasmer, WasmerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let python = wasmer.load_package("python/python@3.13.5").await?;
    let sandbox = wasmer.sandbox().package(python.clone()).start().await?;

    let output = sandbox
        .command(python)
        .args(["-c", "print(sum(range(10)))"])
        .output()
        .await?;

    println!("{}", output.text()?);
    Ok(())
}
