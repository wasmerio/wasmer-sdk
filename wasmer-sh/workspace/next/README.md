# Next.js application

Install the dependencies and start the development server:

```sh
cd /workspace/next && pnpm i && pnpm dev
```

Next.js listens on port 3000 and opens in the browser preview automatically.
This example uses the Pages Router and Webpack, with the matching unmodified
`@next/swc-wasm-nodejs` package because WASIX has no native SWC binary.
