# Wasmer shell workspace

These examples run entirely inside your browser with Wasmer and WASIX.

| Example | Start it |
| --- | --- |
| Node.js HTTP server | `cd node && node server.js` |
| Express | `cd node-express && pnpm i && node server.js` |
| Next.js | `cd next && pnpm i && pnpm dev` |
| Python HTTP server | `cd python && python server.py` |
| PHP site | `cd php && php -S 0.0.0.0:8000 -t .` |

Starting a server opens its site beside the terminal. Press Ctrl-C to stop it
and return to Bash.

Wasmer package data is cached by the browser for faster future starts.
