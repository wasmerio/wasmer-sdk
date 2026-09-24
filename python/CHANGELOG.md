# Changelog

## [0.5.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-python-v0.4.0...wasmer-sdk-python-v0.5.0) (2026-09-24)


### Features

* **swift:** run PostgreSQL on iOS with a native Swift client ([#526](https://github.com/wasmerio/wasmer-sdk/issues/526)) ([654f71e](https://github.com/wasmerio/wasmer-sdk/commit/654f71e388fc35870440dc96b4cc9f5b2d5ba9f8))

## [0.4.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-python-v0.3.0...wasmer-sdk-python-v0.4.0) (2026-09-23)


### Features

* add package loading progress and compact shell loaders ([#519](https://github.com/wasmerio/wasmer-sdk/issues/519)) ([7575413](https://github.com/wasmerio/wasmer-sdk/commit/757541364b16fb2d9fc4eb84f29e0e8224442fdf))

## [0.3.0](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-python-v0.2.1...wasmer-sdk-python-v0.3.0) (2026-09-17)


### Features

* load raw Wasm and create in-memory packages ([#498](https://github.com/wasmerio/wasmer-sdk/issues/498)) ([40ff997](https://github.com/wasmerio/wasmer-sdk/commit/40ff9973b4c160a5a25fbf082729208d7ef27957))
* **swift:** add macOS SDK and component release artifacts ([#496](https://github.com/wasmerio/wasmer-sdk/issues/496)) ([90a5ac0](https://github.com/wasmerio/wasmer-sdk/commit/90a5ac018bb7a7f7436ea91a29af0d898266f9af))


### Bug Fixes

* remove Python extension shim and pin registry package 3.13.20 ([#495](https://github.com/wasmerio/wasmer-sdk/issues/495)) ([c54c38b](https://github.com/wasmerio/wasmer-sdk/commit/c54c38bda0a079b5e8a6f89b84ccf44bff6f047b))

## [0.2.1](https://github.com/wasmerio/wasmer-sdk/compare/wasmer-sdk-python-v0.2.0...wasmer-sdk-python-v0.2.1) (2026-09-13)


### Documentation

* **python:** use verified production Python package ([50491ec](https://github.com/wasmerio/wasmer-sdk/commit/50491ecc10840bb932f2163406983330f5145ce4))

## [0.2.0](https://github.com/wasmerio/wasmer-sdk/compare/v0.1.2...wasmer-sdk-python-v0.2.0) (2026-09-08)

This is the next PyPI feature release after 0.1.2. The earlier GitHub-only
0.2.0 and 0.3.0 releases did not reach PyPI; their tags remain unchanged.
Python releases now use the `wasmer-sdk-python-v<version>` tag prefix;
the older `wasmer-sdk-v<version>` tags belong to historical JavaScript releases.

### Features

* **python:** support Edge.js with V8, including the features from the previously unpublished releases ([4dfd435](https://github.com/wasmerio/wasmer-sdk/commit/4dfd435d3504b6ccd1d501e1867a2dfd6ec66a6c)).

### Bug Fixes

* **python:** use custom V8 build 11.9.9, fixing the Linux ARM64 `__isoc23_strtoll` import failure and including the shared-library TLS and atomic-linking fixes ([#485](https://github.com/wasmerio/wasmer-sdk/pull/485)).

## GitHub-only attempt: [0.3.0](https://github.com/wasmerio/wasmer-sdk/compare/v0.2.0...v0.3.0) (2026-09-03; not published to PyPI)


### Features

* **python:** support Edge.js with V8 ([4dfd435](https://github.com/wasmerio/wasmer-sdk/commit/4dfd435d3504b6ccd1d501e1867a2dfd6ec66a6c))
* **python:** support Edge.js with V8 ([2b04351](https://github.com/wasmerio/wasmer-sdk/commit/2b04351e9106ef9a871accfd29c3bd5facbe0104))


### Bug Fixes

* **python:** check command failures by default ([fbe71f9](https://github.com/wasmerio/wasmer-sdk/commit/fbe71f95ee1a259a5b8ef7bd0306077defb0b78f))


### Documentation

* **python:** add multi-runtime sandbox example ([8bf0e85](https://github.com/wasmerio/wasmer-sdk/commit/8bf0e858d055cad09bfece1638cc2a97cf4189be))
* **python:** deduplicate 0.1.3 release note ([52b7989](https://github.com/wasmerio/wasmer-sdk/commit/52b7989a0e8104187eea918789fa2fdc04e9c1d7))
* **python:** document supported wheel platforms ([0570177](https://github.com/wasmerio/wasmer-sdk/commit/0570177964a388646964b6542294e6fe4538f929))
* **python:** explain exact package version pins ([9cafd66](https://github.com/wasmerio/wasmer-sdk/commit/9cafd666e8f6b2d44dbe3fa70ddfb8e7e52b360e))
* **python:** explain exact package version pins ([59109dc](https://github.com/wasmerio/wasmer-sdk/commit/59109dc74871f4e6fa4df46f452aab0fd436cfa9))
* **python:** simplify multi-runtime example ([7dd44a4](https://github.com/wasmerio/wasmer-sdk/commit/7dd44a462d1061b1c9925f40bc9da6c302ce8873))

## GitHub-only attempt: [0.2.0](https://github.com/wasmerio/wasmer-sdk/compare/v0.1.4...v0.2.0) (2026-09-02; not published to PyPI)


### Features

* **python:** support Edge.js with V8 ([4dfd435](https://github.com/wasmerio/wasmer-sdk/commit/4dfd435d3504b6ccd1d501e1867a2dfd6ec66a6c))
* **python:** support Edge.js with V8 ([2b04351](https://github.com/wasmerio/wasmer-sdk/commit/2b04351e9106ef9a871accfd29c3bd5facbe0104))


### Bug Fixes

* **python:** check command failures by default ([fbe71f9](https://github.com/wasmerio/wasmer-sdk/commit/fbe71f95ee1a259a5b8ef7bd0306077defb0b78f))


### Documentation

* **python:** add multi-runtime sandbox example ([8bf0e85](https://github.com/wasmerio/wasmer-sdk/commit/8bf0e858d055cad09bfece1638cc2a97cf4189be))
* **python:** deduplicate 0.1.3 release note ([52b7989](https://github.com/wasmerio/wasmer-sdk/commit/52b7989a0e8104187eea918789fa2fdc04e9c1d7))
* **python:** document supported wheel platforms ([0570177](https://github.com/wasmerio/wasmer-sdk/commit/0570177964a388646964b6542294e6fe4538f929))
* **python:** explain exact package version pins ([9cafd66](https://github.com/wasmerio/wasmer-sdk/commit/9cafd666e8f6b2d44dbe3fa70ddfb8e7e52b360e))
* **python:** explain exact package version pins ([59109dc](https://github.com/wasmerio/wasmer-sdk/commit/59109dc74871f4e6fa4df46f452aab0fd436cfa9))
* **python:** simplify multi-runtime example ([7dd44a4](https://github.com/wasmerio/wasmer-sdk/commit/7dd44a462d1061b1c9925f40bc9da6c302ce8873))

## GitHub-only attempt: [0.1.4](https://github.com/wasmerio/wasmer-sdk/compare/v0.1.3...v0.1.4) (2026-09-02; not published to PyPI)


### Features

* **python:** support Edge.js with V8 ([4dfd435](https://github.com/wasmerio/wasmer-sdk/commit/4dfd435d3504b6ccd1d501e1867a2dfd6ec66a6c))


### Bug Fixes

* **python:** support AArch64 C char ABI ([d1c7a97](https://github.com/wasmerio/wasmer-sdk/commit/d1c7a978a9a21625722e32c06c379975f016eb53))
* **python:** check command failures by default ([fbe71f9](https://github.com/wasmerio/wasmer-sdk/commit/fbe71f95ee1a259a5b8ef7bd0306077defb0b78f))


### Documentation

* **python:** add multi-runtime sandbox example ([8bf0e85](https://github.com/wasmerio/wasmer-sdk/commit/8bf0e858d055cad09bfece1638cc2a97cf4189be))
* **python:** deduplicate 0.1.3 release note ([52b7989](https://github.com/wasmerio/wasmer-sdk/commit/52b7989a0e8104187eea918789fa2fdc04e9c1d7))
* **python:** document supported wheel platforms ([0570177](https://github.com/wasmerio/wasmer-sdk/commit/0570177964a388646964b6542294e6fe4538f929))
* **python:** explain exact package version pins ([9cafd66](https://github.com/wasmerio/wasmer-sdk/commit/9cafd666e8f6b2d44dbe3fa70ddfb8e7e52b360e))
* **python:** explain exact package version pins ([59109dc](https://github.com/wasmerio/wasmer-sdk/commit/59109dc74871f4e6fa4df46f452aab0fd436cfa9))
* **python:** simplify multi-runtime example ([7dd44a4](https://github.com/wasmerio/wasmer-sdk/commit/7dd44a462d1061b1c9925f40bc9da6c302ce8873))

## GitHub-only attempt: [0.1.3](https://github.com/wasmerio/wasmer-sdk/compare/v0.1.2...v0.1.3) (2026-09-01; not published to PyPI)


### Documentation

* **python:** explain exact package version pins ([59109dc](https://github.com/wasmerio/wasmer-sdk/commit/59109dc74871f4e6fa4df46f452aab0fd436cfa9))

## [0.1.2](https://github.com/wasmerio/wasmer-sdk/compare/v0.1.1...v0.1.2) (2026-07-31)


### Bug Fixes

* **python:** check command failures by default ([fbe71f9](https://github.com/wasmerio/wasmer-sdk/commit/fbe71f95ee1a259a5b8ef7bd0306077defb0b78f))

## [0.1.1](https://github.com/wasmerio/wasmer-sdk/compare/v0.1.0...v0.1.1) (2026-07-30)


### Documentation

* **python:** add multi-runtime sandbox example ([8bf0e85](https://github.com/wasmerio/wasmer-sdk/commit/8bf0e858d055cad09bfece1638cc2a97cf4189be))
* **python:** simplify multi-runtime example ([7dd44a4](https://github.com/wasmerio/wasmer-sdk/commit/7dd44a462d1061b1c9925f40bc9da6c302ce8873))

## 0.1.0 (2026-07-29)


### Documentation

* **python:** document supported wheel platforms ([0570177](https://github.com/wasmerio/wasmer-sdk/commit/0570177964a388646964b6542294e6fe4538f929))
