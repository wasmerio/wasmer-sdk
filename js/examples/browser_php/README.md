# PHP browser server

This example starts PHP's development server as a WASIX process, exposes port
8080 through `@wasmer/sdk/service-worker`, and renders the result in an
iframe. Absolute guest URLs remain attached to the same sandbox server.

Build the SDK first, then run the example:

```console
cd js
npm run build
cd examples/browser_php
npm install
npm run dev
```

The Vite configuration emits the service worker at the origin root and adds
the cross-origin isolation headers required by the Wasmer worker runtime.
