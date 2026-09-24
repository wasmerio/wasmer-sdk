# Changelog

## [0.17.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-js-v0.16.0...wasmer-sdk-js-v0.17.0) (2026-09-24)


### Features

* **swift:** run PostgreSQL on iOS with a native Swift client ([#526](https://github.com/wasmerio/wasmer-sdk/issues/526)) ([654f71e](https://github.com/wasmerio/wasmer-sdk/commit/654f71e388fc35870440dc96b4cc9f5b2d5ba9f8))

## [0.16.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-js-v0.15.0...wasmer-sdk-js-v0.16.0) (2026-09-23)


### Features

* add package loading progress and compact shell loaders ([#519](https://github.com/wasmerio/wasmer-sdk/issues/519)) ([7575413](https://github.com/wasmerio/wasmer-sdk/commit/757541364b16fb2d9fc4eb84f29e0e8224442fdf))


### Bug Fixes

* **shell:** include worker imports in production builds ([#514](https://github.com/wasmerio/wasmer-sdk/issues/514)) ([842f774](https://github.com/wasmerio/wasmer-sdk/commit/842f77425753005a27f18ae21a99a541d5215b86))

## [0.15.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-js-v0.14.0...wasmer-sdk-js-v0.15.0) (2026-09-19)


### Features

* **swift:** bring the shared WasmerSDK API to iOS and add WasmerShell ([#504](https://github.com/wasmerio/wasmer-sdk/issues/504)) ([e8105a8](https://github.com/wasmerio/wasmer-sdk/commit/e8105a8bd0b3a2338e458b1dad4e24ac2cb981b7))


### Bug Fixes

* stabilize terminal sessions and build iOS runtime in CI ([#507](https://github.com/wasmerio/wasmer-sdk/issues/507)) ([5f6d2bf](https://github.com/wasmerio/wasmer-sdk/commit/5f6d2bfc86c1a766f5cc8fe7bbca303d8ac75b6d))

## [0.14.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-js-v0.13.0...wasmer-sdk-js-v0.14.0) (2026-09-17)


### Features

* load raw Wasm and create in-memory packages ([#498](https://github.com/wasmerio/wasmer-sdk/issues/498)) ([40ff997](https://github.com/wasmerio/wasmer-sdk/commit/40ff9973b4c160a5a25fbf082729208d7ef27957))


### Bug Fixes

* **js:** prevent Edge.js shutdown crashes and propagate worker failures ([#497](https://github.com/wasmerio/wasmer-sdk/issues/497)) ([33a176f](https://github.com/wasmerio/wasmer-sdk/commit/33a176ff8aabc7350a24532085787f282304f1e9))
* remove Python extension shim and pin registry package 3.13.20 ([#495](https://github.com/wasmerio/wasmer-sdk/issues/495)) ([c54c38b](https://github.com/wasmerio/wasmer-sdk/commit/c54c38bda0a079b5e8a6f89b84ccf44bff6f047b))

## [0.13.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-js-v0.12.0...wasmer-sdk-js-v0.13.0) (2026-09-13)


### Features

* Got Python fully working on the browser ([42ca9a8](https://github.com/wasmerio/wasmer-sdk/commit/42ca9a80b0ec9d9d0118cbdd59c75cc4c13532c4))

## [0.12.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-js-v0.11.0...wasmer-sdk-js-v0.12.0) (2026-09-08)


### Features

* **js:** add default browser HTTP host ([1c9107d](https://github.com/wasmerio/wasmer-sdk/commit/1c9107d10573428408132e0f4dae08714b156bcf))
* **js:** simplify worker task transport using the Wasmer JS backend's shared module and memory handles, with task-serialization and Python browser regression coverage ([#484](https://github.com/wasmerio/wasmer-sdk/pull/484)).


### Bug Fixes

* **js:** derive cached package artifact from registry ([1e52cbf](https://github.com/wasmerio/wasmer-sdk/commit/1e52cbfdf0f78108060b5fb78161010100235dc4))
* **js:** include the Wasmer worker-sharing fixes for nested Python subprocesses, threads, and dynamically loaded modules ([#484](https://github.com/wasmerio/wasmer-sdk/pull/484)).
