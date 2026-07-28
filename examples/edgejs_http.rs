use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    time::{Duration, Instant},
};

use tokio::io::AsyncReadExt;
use wasmer_sdk::{Error, NetworkPolicy, Result, Wasmer, WasmerConfig};

const SERVER_JS: &[u8] = include_bytes!("edgejs-http/server.js");
const RESPONSE_MARKER: &str = "<h1>Hello from Edge.js!</h1>";

#[tokio::main]
async fn main() -> Result<()> {
    let port = reserve_loopback_port()?;
    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let edgejs = wasmer.load_package("wasmer/edgejs-quickjs").await?;
    let sandbox = wasmer
        .sandbox()
        .package(edgejs.clone())
        .network(NetworkPolicy::Host)
        .file("server.js", SERVER_JS)
        .start()
        .await?;

    let mut server = sandbox.command(edgejs);
    server
        .arg("/workspace/server.js")
        .env("PORT", port.to_string());

    let mut process = server.spawn().await?;
    let stdout = drain(process.take_stdout().expect("Edge.js stdout is piped"));
    let stderr = drain(process.take_stderr().expect("Edge.js stderr is piped"));

    let response = match wait_for_site(port).await {
        Ok(response) => response,
        Err(error) => {
            process.kill()?;
            let _ = process.wait().await;
            let (stdout, stderr) = tokio::join!(finish_drain(stdout), finish_drain(stderr));
            return Err(Error::Execution {
                message: format!(
                    "{error}\nEdge.js stdout:\n{}\nEdge.js stderr:\n{}",
                    String::from_utf8_lossy(&stdout?),
                    String::from_utf8_lossy(&stderr?),
                ),
            });
        }
    };

    process.terminate(Duration::from_secs(2)).await?;
    let _ = process.wait().await?;
    let (stdout, stderr) = tokio::join!(finish_drain(stdout), finish_drain(stderr));
    let stdout = stdout?;
    let stderr = stderr?;

    println!("GET http://127.0.0.1:{port}/hello");
    println!("{}", response_body(&response)?);
    if !stdout.is_empty() {
        eprintln!("Edge.js stdout:\n{}", String::from_utf8_lossy(&stdout));
    }
    if !stderr.is_empty() {
        eprintln!("Edge.js stderr:\n{}", String::from_utf8_lossy(&stderr));
    }
    Ok(())
}

fn drain<R>(mut reader: R) -> tokio::task::JoinHandle<Result<Vec<u8>>>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        Ok(bytes)
    })
}

async fn finish_drain(task: tokio::task::JoinHandle<Result<Vec<u8>>>) -> Result<Vec<u8>> {
    task.await.map_err(|error| Error::Task {
        message: format!("stream task failed: {error}"),
    })?
}

async fn wait_for_site(port: u16) -> Result<String> {
    tokio::task::spawn_blocking(move || fetch_until_ready(port))
        .await
        .map_err(|error| Error::Task {
            message: format!("HTTP client task failed: {error}"),
        })?
        .map_err(Error::from)
}

fn fetch_until_ready(port: u16) -> std::io::Result<String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last_error = None;

    while Instant::now() < deadline {
        match fetch_once(port) {
            Ok(response) if response.contains(RESPONSE_MARKER) => return Ok(response),
            Ok(_) => {
                last_error = Some(std::io::Error::other(
                    "Edge.js returned an unexpected response",
                ));
            }
            Err(error) => last_error = Some(error),
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "timed out waiting for Edge.js",
        )
    }))
}

fn fetch_once(port: u16) -> std::io::Result<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(1))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    stream.write_all(b"GET /hello HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    if !response.starts_with("HTTP/1.1 200") && !response.starts_with("HTTP/1.0 200") {
        return Err(std::io::Error::other(format!(
            "Edge.js returned a non-200 response: {response}"
        )));
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
