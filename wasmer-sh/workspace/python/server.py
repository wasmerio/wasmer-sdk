import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"ok": True}).encode()
            content_type = "application/json; charset=utf-8"
        else:
            body = b"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Python on Wasmer</title>
    <style>
      body { font: 18px system-ui; max-width: 680px; margin: 12vh auto; padding: 0 24px; color: #20172b; }
      code { color: #7040a0; }
    </style>
  </head>
  <body>
    <h1 id="python-preview">Hello from Python!</h1>
    <p>Served by <code>http.server</code> inside WASIX.</p>
    <p id="python-health">Checking /health...</p>
    <script>
      fetch("/health")
        .then((response) => response.json())
        .then((health) => {
          document.querySelector("#python-health").textContent = health.ok
            ? "/health is ready"
            : "/health failed";
        });
    </script>
  </body>
</html>"""
            content_type = "text/html; charset=utf-8"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}", flush=True)


port = int(os.environ.get("PORT", "8000"))
server = HTTPServer(("0.0.0.0", port), Handler)
print(f"Python listening on http://localhost:{port}", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
