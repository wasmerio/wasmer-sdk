# Changelog

## [0.12.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-js-v0.11.0...wasmer-sdk-js-v0.12.0) (2026-09-08)


### Features

* **js:** add default browser HTTP host ([1c9107d](https://github.com/wasmerio/wasmer-sdk/commit/1c9107d10573428408132e0f4dae08714b156bcf))
* **js:** simplify worker task transport using the Wasmer JS backend's shared module and memory handles, with task-serialization and Python browser regression coverage ([#484](https://github.com/wasmerio/wasmer-sdk/pull/484)).


### Bug Fixes

* **js:** derive cached package artifact from registry ([1e52cbf](https://github.com/wasmerio/wasmer-sdk/commit/1e52cbfdf0f78108060b5fb78161010100235dc4))
* **js:** include the Wasmer worker-sharing fixes for nested Python subprocesses, threads, and dynamically loaded modules ([#484](https://github.com/wasmerio/wasmer-sdk/pull/484)).
