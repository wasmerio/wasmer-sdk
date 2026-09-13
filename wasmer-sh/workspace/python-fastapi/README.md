# FastAPI in the browser

Install the dependencies and start the server in the Wasmer shell:

```sh
cd /workspace/python-fastapi
pip install -r requirements.txt
python server.py
```

The preview opens automatically on port 8000. Set `PORT=3000` to use a different
port. Press Ctrl-C to stop the server.

The page checks three things automatically:

- `GET /health` returns a healthy JSON response.
- `POST /items` converts a string quantity to an integer through Pydantic.
- An invalid quantity returns HTTP 422.

All three checks should show **PASS**. The response is displayed on the page;
`/openapi.json` provides the API schema.

This example uses the shell's pip environment and generic extension startup
hook to load the WASIX Pydantic core wheel without copying files. Uvicorn uses
its Python asyncio and h11 implementations. Install plain `uvicorn`, without
its optional `standard` extras, to avoid additional native dependencies.
