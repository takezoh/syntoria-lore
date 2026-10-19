## Gate verifier

`src/connection-verifier.ts` is adapted from `packages/sdk/src/index.ts` in the sibling
`syntoria-gate` repository, package `@syntoria/gate-sdk` version `0.1.0`. The source package declares
Apache License 2.0. The upstream source SHA-256 is
`c4e0e18c0bc8e7cec6192f1ccaaf3d0ea597b331d3faa15ebbb0e9639a5c23c2`.

This local derivative requires each opaque access token to have exactly one resource audience and
uses provider-neutral names and subject fields for its internal identity and browser-session types.
The Gate-specific claims, endpoints, browser cookie and logout protocol remain the external wire
contract.

The upstream source contains no copyright-holder notice, so this attribution does not add one.
The license text is included in [`LICENSE`](./LICENSE).
