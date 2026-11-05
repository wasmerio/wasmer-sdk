//! Source fixture producer using the existing facade package tests' WEBC writer.
//! No runtime kernel or legacy execution provider is linked into this tool.
use std::{
    collections::BTreeMap,
    error::Error,
    fs,
    path::{Path, PathBuf},
};
use webc::v3::{
    ChecksumAlgorithm, SignatureAlgorithm, Timestamps,
    write::{DirEntry, Directory, FileEntry, Writer},
};

const SELF_EXE: &str = r#"(module
  (import "wasixv2" "readlinkat" (func $readlink (param i32 i32 i32 i32) (result i32)))
  (import "wasixv2" "write" (func $write (param i32 i32 i32) (result i32)))
  (import "wasixv2" "exit_group" (func $exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "/proc/self/exe\00")
  (func (export "_start") (local $n i32)
    (local.set $n (call $readlink (i32.const -100) (i32.const 0) (i32.const 128) (i32.const 1024)))
    (if (i32.lt_s (local.get $n) (i32.const 0)) (then (call $exit (i32.const 91)) unreachable))
    (drop (call $write (i32.const 1) (i32.const 128) (local.get $n)))))"#;

const BUSY: &str = r#"(module
  (import "wasixv2" "getpid" (func $pid (result i32)))
  (memory (export "memory") 1)
  (func (export "_start") (drop (call $pid)) (loop $busy (br $busy))))"#;

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args_os().skip(1);
    let out = PathBuf::from(args.next().ok_or("expected task-owned output directory")?);
    let hello = fs::read(
        args.next()
            .ok_or("expected existing SDK hello.wasm fixture path")?,
    )?;
    if args.next().is_some() {
        return Err("too many fixture producer arguments".into());
    }
    fs::create_dir_all(&out)?;
    let exe = wat::parse_str(SELF_EXE)?;
    let busy = wat::parse_str(BUSY)?;
    let dependency = build(
        serde_json::json!({"package":{"wapm":{"name":"sdk/dependency","version":"1.0.0"}},"commands":{"dep":{"runner":"https://webc.org/runner/wasi","annotations":{"atom":{"name":"main"}}}}}),
        BTreeMap::from([("main", hello.as_slice())]),
        None,
    )?;
    fs::write(out.join("dependency-v3.webc"), dependency)?;
    for version in [2, 3] {
        let package = build(
            serde_json::json!({
              "entrypoint":"hello", "package":{
                "wapm":{"name":"sdk/roots","version":"1.0.0"},
                "fs":[{"volume_name":"root","mount_path":"/"},{"volume_name":"data","host_path":"sub","mount_path":"/data"}]},
              "use":{"dep":"https://example.invalid/dependency.webc"},
              "commands":{
                "hello":{"runner":"https://webc.org/runner/wasi","annotations":{"atom":{"name":"main"},"wasi":{"atom":"main","cwd":"/data","exec-name":"configured","main-args":["package-arg"],"env":["PACKAGE_DEFAULT=archive"]}}},
                "named":{"runner":"https://webc.org/runner/wasi","annotations":{"atom":{"name":"main","dependency":"dep"}}},
                "duplicate":{"runner":"https://webc.org/runner/wasi","annotations":{"atom":{"name":"main"}}}
              }
            }),
            BTreeMap::from([("main", hello.as_slice())]),
            Some(version),
        )?;
        write_version(&out, &format!("roots-v{version}.webc"), package, version)?;
    }
    let script = build(
        serde_json::json!({"entrypoint":"script","commands":{
          "script":{"runner":"https://webc.org/runner/wasi","annotations":{"atom":{"name":"launcher"}}},
          "interpreter":{"runner":"https://webc.org/runner/wasi","annotations":{"atom":{"name":"interpreter"}}}
        }}),
        BTreeMap::from([
            ("launcher", &b"#!/bin/interpreter\n"[..]),
            ("interpreter", exe.as_slice()),
        ]),
        None,
    )?;
    fs::write(out.join("script-v3.webc"), script)?;
    let image = build(
        serde_json::json!({"entrypoint":"exe","commands":{"exe":{"runner":"https://webc.org/runner/wasi","annotations":{"atom":{"name":"main"}}}}}),
        BTreeMap::from([("main", exe.as_slice())]),
        None,
    )?;
    fs::write(out.join("exe-v3.webc"), image)?;
    fs::write(out.join("memory-main.wasm"), &hello)?;
    fs::write(out.join("busy.wasm"), busy)?;
    fs::write(
        out.join("source.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
          "generatedFrom":"fixture-producer/src/main.rs and existing SDK hello.wasm",
          "memory":{"commands":{"duplicate":{"module":"main"}},"files":{"/shared":"memory"}},
          "expected":{"exe":"/bin/exe","script":"/bin/interpreter","hello":"Hello from Swift!\n"}
        }))?,
    )?;
    Ok(())
}

fn build(
    manifest: serde_json::Value,
    atoms: BTreeMap<&str, &[u8]>,
    volumes: Option<u8>,
) -> Result<Vec<u8>, Box<dyn Error>> {
    let manifest = serde_json::from_value(manifest)?;
    let mut writer = Writer::new(ChecksumAlgorithm::Sha256)
        .write_manifest(&manifest)?
        .write_atoms(
            atoms
                .into_iter()
                .map(|(name, bytes)| {
                    Ok((
                        name.parse()?,
                        FileEntry::borrowed(bytes, Timestamps::default()),
                    ))
                })
                .collect::<Result<BTreeMap<_, _>, webc::PathSegmentError>>()?,
        )?;
    if let Some(version) = volumes {
        let root = Directory::new(
            BTreeMap::from([(
                "shared".parse()?,
                DirEntry::File(FileEntry::borrowed(b"archive", Timestamps::default())),
            )]),
            Timestamps::default(),
        );
        writer.write_volume("root", root)?;
        let sub = Directory::new(
            BTreeMap::from([(
                "value".parse()?,
                DirEntry::File(FileEntry::borrowed(b"mounted", Timestamps::default())),
            )]),
            Timestamps::default(),
        );
        // WEBC's v3-to-v2 migration encodes the whole named volume in host_path;
        // v2 has no separate subdirectory field. Keep the fixtures equivalent.
        let data = if version == 2 {
            sub
        } else {
            Directory::new(
                BTreeMap::from([("sub".parse()?, DirEntry::Dir(sub))]),
                Timestamps::default(),
            )
        };
        writer.write_volume("data", data)?;
    }
    Ok(writer.finish(SignatureAlgorithm::None)?.to_vec())
}

fn write_version(
    out: &Path,
    name: &str,
    bytes: Vec<u8>,
    version: u8,
) -> Result<(), Box<dyn Error>> {
    if version == 2 {
        fs::write(out.join(name), webc::migration::v3_to_v2(bytes)?)?;
    } else {
        fs::write(out.join(name), bytes)?;
    }
    Ok(())
}
