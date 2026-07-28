# Universal Wasmer SDK

This repository is the design and implementation workspace for a universal SDK
for running Wasmer packages from Rust, Python, JavaScript, Swift, and additional
host languages.

The work is intentionally split into three phases:

| Phase | Status | Deliverable |
| --- | --- | --- |
| 1. Architecture | Complete (draft for review) | [Architecture](docs/phase-1/architecture.md) and [decision log](docs/phase-1/decisions.md) |
| 2. SDK and developer experience | Complete (draft for review) | [SDK design and migration](docs/phase-2/sdk-design.md), [sandbox SDK comparison](docs/phase-2/sandbox-sdk-comparison.md), [cache design](docs/phase-2/cache-design.md), [examples](docs/phase-2/examples.md), and [decision log](docs/phase-2/decisions.md) |
| 3. Implementation and proofs of concept | Not started | Rust implementation plus browser, Node.js, Python, and Swift proofs of concept |

Phase 1 defines the system boundaries and feasibility constraints. Phase 2
defines the proposed public API and developer experience. Phase 3 will validate
and implement that contract; until then, the Phase 2 snippets are design
proposals rather than a published API.
