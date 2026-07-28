use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    time::Duration,
};

use wasmer_sdk::{Error, NetworkPolicy, Result, Stdio, Wasmer, WasmerConfig};

const SERVER_JS: &[u8] = include_bytes!("edgejs-http/server.js");
const RESPONSE_MARKER: &str = "<h1>Hello from Edge.js!</h1>";

#[tokio::main]
async fn main() -> Result<()> {
    let port = reserve_loopback_port()?;
    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let edgejs = wasmer.load_package("wasmer/edgejs-quickjs@0.1.0").await?;
    let sandbox = wasmer
        .sandbox()
        .package(edgejs.clone())
        .network(NetworkPolicy::Host)
        .env("PORT", port.to_string())
        .file("server.js", SERVER_JS)
        .start()
        .await?;

    // Capture mode keeps bounded diagnostics available from `wait()` without
    // live readers or drain tasks.
    let mut process = sandbox
        .command(edgejs)
        .arg("/workspace/server.js")
        .stdout(Stdio::Capture)
        .stderr(Stdio::Capture)
        .spawn()
        .await?;

    sandbox.ports().wait(port, Duration::from_secs(30)).await?;

    let response = match fetch_hello(port).await {
        Ok(response) => response,
        Err(error) => {
            process.kill()?;
            let output = process.wait().await?;
            return Err(Error::Execution {
                message: format!(
                    "{error}\nEdge.js stdout:\n{}\nEdge.js stderr:\n{}",
                    String::from_utf8_lossy(output.stdout.bytes()),
                    String::from_utf8_lossy(output.stderr.bytes()),
                ),
            });
        }
    };

    process.terminate(Duration::from_secs(2)).await?;
    let output = process.wait().await?;

    println!("GET http://127.0.0.1:{port}/hello");
    println!("{}", response_body(&response)?);
    if !output.stdout.bytes().is_empty() {
        eprintln!(
            "Edge.js stdout:\n{}",
            String::from_utf8_lossy(output.stdout.bytes())
        );
    }
    if !output.stderr.bytes().is_empty() {
        eprintln!(
            "Edge.js stderr:\n{}",
            String::from_utf8_lossy(output.stderr.bytes())
        );
    }
    sandbox.close().await?;
    Ok(())
}

async fn fetch_hello(port: u16) -> Result<String> {
    tokio::task::spawn_blocking(move || fetch_once(port))
        .await
        .map_err(|error| Error::Task {
            message: format!("HTTP client task failed: {error}"),
        })?
        .map_err(Error::from)
}

fn fetch_once(port: u16) -> std::io::Result<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    stream.write_all(b"GET /hello HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    if !response.starts_with("HTTP/1.1 200") && !response.starts_with("HTTP/1.0 200") {
        return Err(std::io::Error::other(format!(
            "Edge.js returned a non-200 response: {response}"
        )));
    }
    if !response.contains(RESPONSE_MARKER) {
        return Err(std::io::Error::other(
            "Edge.js returned an unexpected response",
        ));
    }
    Ok(response)
}

fn response_body(response: &str) -> Result<&str> {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .ok_or_else(|| Error::Execution {
            message: "Edge.js returned a malformed HTTP response".to_owned(),
        })
}

fn reserve_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}
