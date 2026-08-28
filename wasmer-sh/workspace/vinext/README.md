# Vinext application

Install the dependencies and start the development server:

```sh
cd /workspace/vinext && pnpm i && pnpm dev
```

Vinext listens on port 3000 and opens in the browser preview automatically.
This example uses its lightweight Pages Router path on top of Vite. On EdgeJS,
Rolldown selects its official `wasm32-wasi` fallback through the normal Node
loader.
