# Next.js application

Install the dependencies and start the development server:

```sh
cd /workspace/next && pnpm i && pnpm dev
```

Next.js listens on port 3000 and opens in the browser preview automatically.
This example uses the Pages Router and Webpack. On its first start, Next.js
downloads the matching `@next/swc-wasm-nodejs` compiler automatically because
WASIX has no native SWC binary. The first start therefore needs network access.
No preparation script or extra compiler dependency is needed.
