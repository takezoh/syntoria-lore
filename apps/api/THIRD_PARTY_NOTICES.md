## Gate verifier

`src/gate.ts` is adapted from `packages/auth/src/connection-verifier.ts` of the removed PostgreSQL implementation, which was itself adapted from `packages/sdk/src/index.ts` in the sibling `syntoria-gate` repository, package `@syntoria/gate-sdk` version `0.1.0`. The source package declares Apache License 2.0. The upstream source SHA-256 is `9c914ef0e0e4116b55ec46b97ec9f64e85f9549e7f156f5b3bb22fbc993490d0`.

This local derivative verifies opaque bearer tokens by online introspection only, without browser-session handling. It requires exactly one resource audience equal to the configured MCP resource URL, a Bearer token type, `gate_approved`, the configured issuer, an unexpired token, a connection ID and a client ID matching any authorized party, and it returns provider-neutral principal fields. The Gate-specific claims and introspection endpoint remain the external wire contract.

The upstream source contains no copyright-holder notice, so this attribution does not add one. The license text is included in [`LICENSE`](./LICENSE).
