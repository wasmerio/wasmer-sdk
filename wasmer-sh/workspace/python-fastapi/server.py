import os

import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

app = FastAPI(title="FastAPI in your browser")


class Item(BaseModel):
    name: str = Field(min_length=1)
    quantity: int = Field(gt=0)


@app.get("/", response_class=HTMLResponse)
async def index():
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FastAPI on Wasmer</title>
  <style>
    body { font: 18px system-ui; max-width: 760px; margin: 10vh auto; padding: 0 24px; color: #20172b; }
    code { color: #7040a0; }
    li { margin: 12px 0; }
    pre { white-space: pre-wrap; background: #f4f0fa; padding: 16px; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>FastAPI is running in your browser</h1>
  <p>Python, Uvicorn, and Pydantic execute inside WASIX.</p>
  <ul id="checks"><li>Checking API endpoints...</li></ul>
  <pre id="result"></pre>
  <p><a href="/openapi.json">OpenAPI schema</a></p>
  <script>
    async function verify() {
      const checks = [];
      const health = await fetch('/health');
      const status = await health.json();
      checks.push(health.ok && status.ok === true ? 'PASS: GET /health' : 'FAIL: GET /health');
      const valid = await fetch('/items', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'Browser', quantity: '3'})
      });
      const item = await valid.json();
      checks.push(valid.ok && item.quantity === 3 ? 'PASS: Pydantic converts quantity to an integer' : 'FAIL: Pydantic conversion');
      const invalid = await fetch('/items', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'Browser', quantity: 0})
      });
      checks.push(invalid.status === 422 ? 'PASS: Invalid quantity returns HTTP 422' : 'FAIL: Invalid quantity accepted');
      document.querySelector('#checks').replaceChildren(...checks.map(text => {
        const li = document.createElement('li'); li.textContent = text; return li;
      }));
      document.querySelector('#result').textContent = JSON.stringify(item, null, 2);
    }
    verify().catch(error => { document.querySelector('#checks').textContent = 'FAIL: ' + error.message; });
  </script>
</body>
</html>"""


@app.get("/health")
async def health():
    return {"ok": True, "framework": "fastapi"}


@app.post("/items")
async def create_item(item: Item):
    return item


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        loop="asyncio",
        http="h11",
        lifespan="off",
    )
