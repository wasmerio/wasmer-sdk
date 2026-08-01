const express = require("express");

const app = express();
const host = "0.0.0.0";
const port = Number(process.env.PORT || 8000);

app.get("/", (request, response) => {
  response.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Express on Wasmer</title>
    <style>
      body { font: 18px system-ui; max-width: 680px; margin: 12vh auto; padding: 0 24px; color: #20172b; }
      code { color: #7040a0; }
    </style>
  </head>
  <body>
    <h1>Hello from Express!</h1>
    <p><code>${request.method} ${request.path}</code>, served by Edge.js inside WASIX.</p>
    <p id="message">Loading the API response…</p>
    <script>
      fetch("/api/hello")
        .then((response) => response.json())
        .then(({ message }) => {
          document.querySelector("#message").textContent = message;
        });
    </script>
  </body>
</html>`);
});

app.get("/api/hello", (_request, response) => {
  response.json({ message: "Express can reach this JSON route." });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.listen(port, host, () => {
  console.log(`Express listening on http://localhost:${port}`);
});
