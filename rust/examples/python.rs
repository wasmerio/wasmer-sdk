mod support;

use wasmer_sdk::{Result, Wasmer, WasmerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let source = std::fs::read(support::fixture("python/hello.py"))?;
    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let sandbox = wasmer
        .sandboxes()
        .create()
        .package("python/python@3.13.5")
        .file("hello.py", source)
        .await?;

    let output = sandbox
        .command("python")
        .arg("/workspace/hello.py")
        .output()
        .await?;

    println!("{}", output.text()?.trim());
    Ok(())
}
