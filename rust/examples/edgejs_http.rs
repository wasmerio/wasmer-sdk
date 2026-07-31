mod support;

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    time::Duration,
};

use tokio::io::{AsyncBufReadExt, BufReader};
use wasmer_sdk::{Error, NetworkPolicy, Result, Stdio, Wasmer, WasmerConfig};

const RESPONSE_MARKER: &str = "<h1>Hello from Edge.js!</h1>";

#[tokio::main]
async fn main() -> Result<()> {
    let port = reserve_loopback_port()?;
    let server_js = std::fs::read(support::fixture("edgejs/server.js"))?;
    let wasmer = Wasmer::new(WasmerConfig::default())?;
    let sandbox = wasmer
        .sandboxes()
        .create()
        .package("wasmer/edgejs-quickjs@0.1.0")
        .network(NetworkPolicy::Host)
        .env("PORT", port.to_string())
        .file("server.js", server_js)
        .await?;

    let mut process = sandbox
        .command("edge")
        .arg("/workspace/server.js")
        .stdout(Stdio::Piped)
        .stderr(Stdio::Capture)
        .spawn()
        .await?;

    let stdout = process.take_stdout().ok_or_else(|| Error::InternalState {
        message: "missing piped Edge.js stdout".to_owned(),
    })?;
    wait_for_line(
        BufReader::new(stdout).lines(),
        "Edge.js listening on",
        "Edge.js listening marker",
    )
    .await?;

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

    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if complete_http_response(&bytes)? {
            break;
        }
    }
    let response = String::from_utf8(bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
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

fn complete_http_response(bytes: &[u8]) -> std::io::Result<bool> {
    let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Ok(false);
    };
    let headers = std::str::from_utf8(&bytes[..header_end])
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>())
        })
        .transpose()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?
        .ok_or_else(|| std::io::Error::other("Edge.js response omitted content-length"))?;
    Ok(bytes.len() >= header_end + 4 + content_length)
}

async fn wait_for_line<R>(
    mut lines: tokio::io::Lines<BufReader<R>>,
    marker: &str,
    operation: &str,
) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(line) = lines.next_line().await? {
            if line.contains(marker) {
                return Ok::<(), std::io::Error>(());
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            format!("process exited before {operation}"),
        ))
    })
    .await
    .map_err(|_| Error::Timeout {
        operation: operation.to_owned(),
    })??;
    Ok(())
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
