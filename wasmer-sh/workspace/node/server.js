const http = require("node:http");

const host = "0.0.0.0";
const port = Number(process.env.PORT || 8000);

const server = http.createServer((request, response) => {
  const body = request.url === "/health"
    ? JSON.stringify({ ok: true })
    : `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Node.js on Wasmer</title>
    <style>
      body { font: 18px system-ui; max-width: 680px; margin: 12vh auto; padding: 0 24px; color: #20172b; }
      code { color: #7040a0; }
    </style>
  </head>
  <body>
    <h1 id="node-preview">Hello from Node.js!</h1>
    <p><code>${request.method} ${request.url}</code>, served by Edge.js inside WASIX.</p>
    <p><a href="/health">Open the absolute <code>/health</code> route</a></p>
    <p id="node-health">Checking /health…</p>
    <script>
      fetch("/health")
        .then((response) => response.json())
        .then((health) => {
          document.querySelector("#node-health").textContent = health.ok
            ? "/health is ready"
            : "/health failed";
        });
    </script>
  </body>
</html>`;

  response.writeHead(200, {
    "content-type": request.url === "/health"
      ? "application/json; charset=utf-8"
      : "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
});

server.listen(port, host, () => {
  console.log(`Node.js listening on http://localhost:${port}`);
});
