# Django in the browser

Install Django and start the example in the Wasmer shell:

```sh
cd /workspace/python-django
pip install -r requirements.txt
python server.py
```

The preview opens automatically on port 8000. Use `PORT=3000 python server.py`
for another port. Press Ctrl-C to stop the server.

The page uses Django's template engine and provides a greeting form backed by
`/api/hello`. It automatically checks the health endpoint, the greeting response,
and HTTP 400 validation of an empty name. All three checks should show **PASS**.

This is a single-file example with no database, migrations, or admin setup.
It uses the shell's pip configuration. Django's development server runs without
a reloader or request threads to keep the browser example simple. These demo
settings are for the browser sandbox, not production deployment.
