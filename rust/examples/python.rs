use wasmer_sdk::{Result, Wasmer, WasmerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let python = wasmer.packages().load("python/python@3.13.5").await?;
    let sandbox = wasmer.sandboxes().create().package(python.clone()).await?;

    let output = sandbox
        .command(python)
        .args(["-c", "print(sum(range(10)))"])
        .output()
        .await?;

    println!("{}", output.text()?);
    Ok(())
}
