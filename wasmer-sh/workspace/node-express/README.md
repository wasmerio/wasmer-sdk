# Express server

Install the declared dependency and start the server:

```sh
pnpm i && pnpm run start
```

The example serves HTML at `/`, JSON at `/api/hello`, and a readiness response
at `/health`. It listens on port 8000 by default; set `PORT` to change it.

The pnpm configuration copies dependencies into a hoisted layout so this same
example also works with WasmerShell's Native and OPFS storage.
