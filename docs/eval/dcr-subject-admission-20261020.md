# DCR-only subject admission: local verification

Date: 2026-10-20 UTC. Source: working tree based on main
`656396a219dbfdb180b5c36a4ec49427cd24e9b2`; this record accompanies the change.

## Contract

Lore accepts online Gate-approved dynamically registered public clients. Local
admission keys the immutable issuer and subject, preserving the existing user,
principal and actor kind, scope set, capability ceiling, live grants and commit-time
binding/principal locks. No fixed public-client allowlist or compatibility path is
retained. Confidential resource introspection credentials remain separate.

Migration 0043 rejects differing active authority rather than unioning policies.
Equivalent active rows consolidate; inactive duplicates never contribute authority,
and a subject with only inactive rows stays inactive. Deployment must fence the API
through the schema and image cutover; image-only rollback is incompatible.

## Executed evidence

- `npm ci`: frozen dependency installation succeeded without dependency changes.
- `npm run build`, `npm run typecheck`, `npm run lint`, and `npm run format:check`: passed.
- `npm run test:unit`: 14 files, 88 tests passed; zero failed or skipped.
- Real PostgreSQL with pgvector, isolated loopback instance:
  `vitest run tests/core.postgres.test.ts`: 34 tests passed, zero failed or skipped.
  This includes arbitrary dynamic client admission, unchanged read-only capability
  bounds, blocking concurrent binding revocation under SHARE locks, inactive
  binding rejection, and final Gate revocation/outage rollback.
- `scripts/test-subject-admission-migration.ts`: passed on a disposable database.
  Equivalent active policies consolidate, a differing inactive policy contributes
  nothing, inactive-only subjects remain inactive, and conflicting active policies
  abort with all original rows preserved.
- `scripts/test-user-identity-migration.ts`: passed. Existing user/principal/scope
  IDs, grants, memory, receipt/hash, cursor, table identity and forced RLS survive
  applying the current migration set twice.
- `scripts/testing/verify-gate-integration.mjs`: passed against the actual sibling
  Gate service, Firestore Emulator and real PostgreSQL. The harness registers its
  exact callback through DCR, explicitly approves OAuth, exchanges resource tokens,
  writes/reads through Lore REST and official MCP clients, rejects cookies and
  removed callback/session routes, fails closed on Gate outage, and rejects a
  revoked actual OAuth grant.

The actual-Gate harness's external GitHub exchange is synthetic. These results do
not establish hosted DNS, managed Firestore, Cloud Run, Neon, actual GitHub sign-in,
or a real user's MCP-host acceptance. No production operation is claimed here.
The complete `npm run test:integration` chain also passed: 34 PostgreSQL tests, distinct snapshot restore with deletion-ledger reconciliation, fresh-database portability with preserved provenance and downgraded authority, existing identity migration, and subject-admission migration. No test failed or skipped in the final run. Initial attempts stopped on missing test-environment variables; supplying the declared CI role prefix and synthetic portability/HMAC keys resolved those prerequisites. `npm audit --audit-level=high` returned zero vulnerabilities; its first sandbox attempt failed DNS and the network-enabled retry succeeded.

The dev:implement runtime could not open its formal unit because its production
composition source was unavailable. Native delegated implementation and concrete
checks above are reported separately; no formal runtime success is claimed.
