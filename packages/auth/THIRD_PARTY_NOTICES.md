## Gate verifier

`src/connection-verifier.ts` is adapted from `packages/sdk/src/index.ts` in the sibling
`syntoria-gate` repository, package `@syntoria/gate-sdk` version `0.1.0`. The source package declares
Apache License 2.0. The upstream source SHA-256 is
`9c914ef0e0e4116b55ec46b97ec9f64e85f9549e7f156f5b3bb22fbc993490d0`.

This local derivative requires each opaque access token to have exactly one resource audience and
uses provider-neutral names and subject fields for its internal identity. It includes bearer verification only, without browser-session handling. The Gate-specific claims and introspection endpoint remain the external wire contract. Public clients are dynamically registered; a required introspected client ID and matching optional authorized party are verified.

The upstream source contains no copyright-holder notice, so this attribution does not add one.
The license text is included in [`LICENSE`](./LICENSE).
