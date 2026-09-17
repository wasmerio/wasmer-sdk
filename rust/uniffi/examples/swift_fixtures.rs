//! Regenerate offline Swift fixtures and the package fixture shared by all bindings.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../swift/Tests/WasmerSDKTests/Fixtures");
    for name in ["hello", "fail", "echo"] {
        let bytes = wat::parse_file(directory.join(format!("{name}.wat")))?;
        std::fs::write(directory.join(format!("{name}.wasm")), bytes)?;
    }
    let shared =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/package-files");
    let bytes = wat::parse_file(shared.with_extension("wat"))?;
    std::fs::write(shared.with_extension("wasm"), &bytes)?;
    std::fs::write(directory.join("package-files.wasm"), bytes)?;
    Ok(())
}
