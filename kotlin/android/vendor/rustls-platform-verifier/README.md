# Android certificate verifier

`CertificateVerifier.kt` is from rustls-platform-verifier **v/0.7.0**, commit
[`996b1c9`](https://github.com/rustls/rustls-platform-verifier/blob/996b1c903491641b17b3c9afb65d1352f6fc6b76/android/rustls-platform-verifier/src/main/java/org/rustls/platformverifier/CertificateVerifier.kt).
It matches the JNI interface of the locked Rust 0.7.0 / Android helper 0.1.1
dependencies. Both upstream licenses are included. The build rejects dependency
version changes until this copy is reviewed.

Local changes:

- Define the upstream production setting `BuildConfig.TEST = false`. Test trust
  overrides and test-only verification bypasses are never enabled.
- When no OCSP response is stapled, prefer CRLs and disable fallback to OCSP.
  Android otherwise treats a missing OCSP responder as a hard revocation failure
  even for valid public certificates that publish CRLs. See upstream
  [issue #221](https://github.com/rustls/rustls-platform-verifier/issues/221) and
  [PR #179](https://github.com/rustls/rustls-platform-verifier/pull/179).
  Stapled OCSP responses still follow the upstream verification path. Chain,
  validity and EKU checks are unchanged, as is Rust's hostname verification.
  The upstream soft-failure policy for unavailable revocation data is retained.

`TlsVerifierTest` checks rejection of untrusted, expired and malformed
certificates. Its optional network test checks the Wasmer CDN chain. Remove this copy once an upstream release fixes the
compatibility issue, restoring its matching Android artifact.
