const http = require("node:http");

const host = "127.0.0.1";
const port = Number(process.env.PORT);

const server = http.createServer((request, response) => {
  const body = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Wasmer SDK</title></head>
  <body>
    <h1>Hello from Edge.js!</h1>
    <p>${request.method} ${request.url}</p>
  </body>
</html>
`;

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
});

server.listen(port, host, () => {
  console.log(`Edge.js listening on http://${host}:${port}`);
});
