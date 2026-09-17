use bytes::Bytes;
use tempfile::TempDir;
use wasmer_sdk::{
    CacheConfig, PackageCommandDefinition, PackageDefinition, Result, Wasmer, WasmerConfig,
};

const HELLO: &str = r#"(module
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 32) "hello")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 32))
    (i32.store (i32.const 4) (i32.const 5))
    (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))"#;

fn definition(wat: &str) -> PackageDefinition {
    PackageDefinition {
        modules: [("app".into(), wat::parse_str(wat).unwrap().into())].into(),
        commands: [(
            "hello".into(),
            PackageCommandDefinition {
                module: "app".into(),
            },
        )]
        .into(),
        ..PackageDefinition::default()
    }
}

fn client() -> (Wasmer, TempDir) {
    let dir = TempDir::new().unwrap();
    let client = Wasmer::with_config(WasmerConfig {
        cache: CacheConfig {
            root: dir.path().to_owned(),
        },
        ..WasmerConfig::default()
    })
    .unwrap();
    (client, dir)
}

#[tokio::test(flavor = "multi_thread")]
async fn created_packages_run_through_existing_selectors_and_installation() -> Result<()> {
    let (client, _dir) = client();
    let package = client.packages().create(definition(HELLO)).await?;
    assert_eq!(package.commands(), ["hello"]);
    assert_eq!(package.entrypoint().as_deref(), Some("hello"));
    let sandbox = client.sandboxes().create().package(package.clone()).await?;
    assert_eq!(
        sandbox.command(package.clone()).run().await?.text()?,
        "hello"
    );
    assert_eq!(
        sandbox
            .command(package.command("hello")?)
            .run()
            .await?
            .text()?,
        "hello"
    );
    let second = client.sandboxes().create().await?;
    second.install_package(package).await?;
    assert_eq!(second.command("hello").run().await?.text()?, "hello");
    second.close().await?;
    sandbox.close().await?;
    client.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn bundled_files_have_private_writable_overlays() -> Result<()> {
    let (client, _dir) = client();
    let mut input = definition(include_str!("fixtures/package-files.wat"));
    input
        .files
        .insert("/data/input.txt".into(), Bytes::from_static(b"original"));
    let package = client.packages().create(input).await?;
    let a = client.sandboxes().create().package(package.clone()).await?;
    let b = client.sandboxes().create().package(package.clone()).await?;
    for sandbox in [&a, &b, &a] {
        assert_eq!(
            sandbox.command(package.clone()).run().await?.text()?,
            "original"
        );
    }
    a.close().await?;
    b.close().await?;
    client.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_preserve_arguments_environment_and_compile_errors() -> Result<()> {
    let (client, _dir) = client();
    let input = definition(
        r#"(module
      (import "wasi_snapshot_preview1" "args_sizes_get" (func $as (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "args_get" (func $ag (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "environ_sizes_get" (func $es (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "environ_get" (func $eg (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $w (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (func $print
        (i32.store (i32.const 8) (i32.const 512))
        (i32.store (i32.const 12) (i32.load (i32.const 4)))
        (drop (call $w (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 16))))
      (func (export "_start")
        (drop (call $as (i32.const 0) (i32.const 4)))
        (drop (call $ag (i32.const 100) (i32.const 512)))
        (call $print)
        (drop (call $es (i32.const 0) (i32.const 4)))
        (drop (call $eg (i32.const 100) (i32.const 512)))
        (call $print)))"#,
    );
    let package = client.packages().create(input).await?;
    let sandbox = client.sandboxes().create().package(package).await?;
    let output = sandbox
        .command("hello")
        .arg("world")
        .env("SDK_TEST", "value")
        .run()
        .await?
        .text()?;
    assert!(output.starts_with("hello\0world\0"), "{output:?}");
    assert!(output.contains("SDK_TEST=value\0"), "{output:?}");
    let invalid = client
        .packages()
        .create(definition(
            "(module (memory (export \"memory\") 1) (func (export \"_start\") (i32.const 1)))",
        ))
        .await?;
    sandbox.install_package(invalid.clone()).await?;
    assert_eq!(
        sandbox.command(invalid).run().await.unwrap_err().code(),
        "EXECUTION_ERROR"
    );
    sandbox.close().await?;
    client.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_covers_commands_entrypoints_modules_and_files() -> Result<()> {
    let (client, _dir) = client();
    let base = definition(HELLO);
    let original = client.packages().create(base.clone()).await?;
    let mut explicit = base.clone();
    explicit.entrypoint = Some("hello".into());
    assert_eq!(
        original.id(),
        client.packages().create(explicit).await?.id()
    );
    let mut renamed = base.clone();
    renamed.commands = [(
        "other".into(),
        PackageCommandDefinition {
            module: "app".into(),
        },
    )]
    .into();
    let mut changed_module = base.clone();
    changed_module.modules.insert(
        "app".into(),
        wat::parse_str(HELLO.replace("hello", "world"))
            .unwrap()
            .into(),
    );
    let mut changed_files = base.clone();
    changed_files
        .files
        .insert("/data/input.txt".into(), Bytes::from_static(b"one"));
    for changed in [renamed, changed_module, changed_files] {
        assert_ne!(original.id(), client.packages().create(changed).await?.id());
    }
    let mut multiple = base;
    multiple.commands.insert(
        "alias".into(),
        PackageCommandDefinition {
            module: "app".into(),
        },
    );
    let ambiguous = client.packages().create(multiple.clone()).await?;
    let sandbox = client
        .sandboxes()
        .create()
        .package(ambiguous.clone())
        .await?;
    assert_eq!(
        sandbox
            .command(ambiguous.clone())
            .run()
            .await
            .unwrap_err()
            .code(),
        "PACKAGE_HAS_NO_ENTRYPOINT"
    );
    assert_eq!(sandbox.command("alias").run().await?.text()?, "hello");
    multiple.entrypoint = Some("alias".into());
    let selected = client.packages().create(multiple).await?;
    assert_ne!(ambiguous.id(), selected.id());
    sandbox.install_package(selected.clone()).await?;
    assert_eq!(sandbox.command(selected).run().await?.text()?, "hello");
    assert_eq!(
        sandbox.command("hello").run().await.unwrap_err().code(),
        "COMMAND_AMBIGUOUS"
    );
    sandbox.close().await?;
    client.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_invalid_definitions_and_closed_clients() -> Result<()> {
    let (client, _dir) = client();
    let mut invalid = Vec::new();
    invalid.push(PackageDefinition::default());
    let mut missing = definition(HELLO);
    missing.commands.get_mut("hello").unwrap().module = "missing".into();
    invalid.push(missing);
    let mut entrypoint = definition(HELLO);
    entrypoint.entrypoint = Some("missing".into());
    invalid.push(entrypoint);
    for name in ["", "..", "a/b", "a\0b"] {
        let mut input = definition(HELLO);
        input.commands = [(
            name.into(),
            PackageCommandDefinition {
                module: "app".into(),
            },
        )]
        .into();
        invalid.push(input);
    }
    for path in [
        "relative",
        "/../escape",
        "/a/./b",
        "/a//b",
        "/",
        "/a\\b",
        "/a\0b",
    ] {
        let mut input = definition(HELLO);
        input.files.insert(path.into(), Bytes::new());
        invalid.push(input);
    }
    let mut conflict = definition(HELLO);
    conflict.files = [("/a".into(), Bytes::new()), ("/a/b".into(), Bytes::new())].into();
    invalid.push(conflict);
    for input in invalid {
        assert_eq!(
            client.packages().create(input).await.unwrap_err().code(),
            "INVALID_ARGUMENT"
        );
    }
    for module in [
        vec![],
        b"not wasm".to_vec(),
        b"\0asm\x0d\0\x01\0".to_vec(),
        wat::parse_str("(module)").unwrap(),
    ] {
        let mut input = definition(HELLO);
        input.modules.insert("app".into(), module.into());
        assert_eq!(
            client.packages().create(input).await.unwrap_err().code(),
            "PACKAGE_LOAD_FAILED"
        );
    }
    client.shutdown().await?;
    assert_eq!(
        client
            .packages()
            .create(definition(HELLO))
            .await
            .unwrap_err()
            .code(),
        "CLIENT_CLOSED"
    );
    Ok(())
}
