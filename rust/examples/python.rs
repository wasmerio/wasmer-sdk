mod support;

use wasmer_sdk::{Result, Wasmer};

#[tokio::main]
async fn main() -> Result<()> {
    let source = std::fs::read(support::fixture("python/hello.py"))?;
    let wasmer = Wasmer::new()?;
    let sandbox = wasmer
        .sandboxes()
        .create()
        .package("python/python@=3.13.5")
        .file("hello.py", source)
        .await?;

    let output = sandbox
        .command("python")
        .arg("/workspace/hello.py")
        .run()
        .await?;

    println!("{}", output.text()?.trim());
    Ok(())
}
