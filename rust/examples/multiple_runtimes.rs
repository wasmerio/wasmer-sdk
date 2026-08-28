use wasmer_sdk::{Result, Sandbox, Wasmer};

#[tokio::main]
async fn main() -> Result<()> {
    let wasmer = Wasmer::new()?;
    let sandbox = wasmer
        .sandboxes()
        .create()
        .package("python/python@=3.13.5")
        .package("wasmer/edgejs-quickjs")
        .package("php/php-32")
        .await?;

    run(&sandbox, "echo", &["hello from shell tools"]).await?;
    run(&sandbox, "python", &["-c", "print('hello from Python')"]).await?;
    run(
        &sandbox,
        "edge",
        &["-e", r#"console.log("hello from Edge.js")"#],
    )
    .await?;
    run(&sandbox, "php", &["-r", "echo 'hello from PHP';"]).await?;
    Ok(())
}

async fn run(sandbox: &Sandbox, command: &str, args: &[&str]) -> Result<()> {
    let output = sandbox
        .command(command)
        .args(args.iter().copied())
        .run()
        .await?;
    println!("{}", output.text()?.trim());
    Ok(())
}
