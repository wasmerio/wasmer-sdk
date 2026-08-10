const http = require("node:http");

const host = "127.0.0.1";
const port = Number(process.env.PORT);

const server = http.createServer((request, response) => {
  const padding = "x".repeat(Number(process.env.RESPONSE_BYTES || 0));
  const body = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Wasmer SDK</title></head>
  <body>
    <h1>Hello from Edge.js!</h1>
    <p>${request.method} ${request.url}</p><p>${padding}</p>
  </body>
</html>
`;

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  // Exercise the native stream writev path used by framework responses.
  // A synchronous submission must return 0 while completion remains async.
  const split = Math.floor(body.length / 2);
  response.cork();
  response.write(body.slice(0, split));
  response.end(body.slice(split));
});

server.listen(port, host, () => {
  console.log(`Edge.js listening on http://${host}:${port}`);
});
