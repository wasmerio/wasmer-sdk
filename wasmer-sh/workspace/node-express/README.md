# Express server

Install the declared dependency and start the server:

```sh
cd /workspace/node-express && pnpm i && pnpm run start
```

The example serves HTML at `/`, JSON at `/api/hello`, and a readiness response
at `/health`. It listens on port 8000 by default; set `PORT` to change it.