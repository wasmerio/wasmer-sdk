//! Regenerate the small, offline WebAssembly fixtures used by `swift test`.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../swift/Tests/WasmerSDKTests/Fixtures");
    for name in ["hello", "fail", "echo"] {
        let bytes = wat::parse_file(directory.join(format!("{name}.wat")))?;
        std::fs::write(directory.join(format!("{name}.wasm")), bytes)?;
    }
    Ok(())
}
