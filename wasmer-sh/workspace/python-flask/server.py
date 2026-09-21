import os

from flask import Flask, jsonify, request

app = Flask(__name__)


@app.get("/")
def index():
    return """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flask on Wasmer</title>
<style>body { font: 18px system-ui; max-width: 720px; margin: 10vh auto; padding: 0 24px; }</style>
<h1>Hello from Flask</h1>
<p>This app runs inside Wasmer. Edit server.py to make it your own.</p>
<p><a href="/api/hello?name=Wasmer">Try the greeting API</a> · <a href="/health">Health check</a></p>
</html>"""


@app.get("/api/hello")
def hello():
    name = request.args.get("name", "World").strip()
    if not name or len(name) > 80:
        return jsonify(error="Name must contain 1 to 80 characters."), 400
    return jsonify(message=f"Hello, {name}!")


@app.get("/health")
def health():
    return jsonify(ok=True, framework="flask")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")),
            use_reloader=False, threaded=False)
