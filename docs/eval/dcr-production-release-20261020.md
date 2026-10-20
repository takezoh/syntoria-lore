# DCR production release

## Outcome

Gate, Weave and Lore serve their DCR-compatible revisions at 100% traffic.
Gate registers public OAuth clients dynamically; fixed `weave-mcp` and `lore-mcp`
IDs are rejected. Existing fixed-client installations must register through DCR
and obtain personal approval again. Registration alone grants no data access.

The user's follow-up deployment request authorized production work and explicitly
included Lore when its shared-Gate dependency was identified. This release record
is separate from the implementation change's original production-deployment non-goal.
Private origins, identity values and credential payloads are not included here.

## Source and artifacts

| Service | Source commit | Active revision | Image digest |
| --- | --- | --- | --- |
| Gate | `1533873d27cae31bb5e033ee280e7c60aa6e2113` | `gate-api-dcr-1533873` | `sha256:917665fd1c5c636275599a3011a4819564efa109adeba120dfc0daec422f84b8` |
| Weave | `0d13da8305ff7e1138f13084e1617f569f2c59e9` | `weave-api-dcr-0d13da8-live` | `sha256:4ff2da65b28807ecfdb91ba8282dceca59950bdd2580758050eaa7d91961d17e` |
| Lore | `921e9c0126b7e5fa900b28301e061b3f4af5016c` | `lore-api-dcr-921e9c0` | `sha256:9c7a2668c7c5f74362cc0007d26efc17f36e3457b266aa2cadef56eb0398125d` |

Gate and Weave digests identify OCI indexes. Their runtime platform manifests are
`sha256:380986069ba5b13775f1f707d24afe5c1f538c1d41dece3ea8e3789b0db5360a`
and `sha256:3ffab045bc2c32e4bfd24590f487047ce66ff1c03e708934aa3182b3bb55ff58`,
respectively. Lore Cloud Build `fb707388-ec95-4f1a-8f4c-73a74df07363` succeeded.
Lore's frozen build-context manifest SHA-256 is `265caa813a9ab65f288150fd385f18e7fb907700bdeddd3613ea2acc6eaf8dd9`.

## Migrations and preservation

- Weave migration `0004_subject_only_identity.sql` completed through execution
  `weave-migrator-dnb4r` on 2026-10-19. At cutover, hashes for 84 actions and all
  associated state, receipts and admitted subjects matched the pre-migration
  snapshot. Cloud backup executions before and after migration succeeded.
- Lore migration `0043_subject_identity_admission.sql` completed through execution
  `lore-neon-migrate-dz7qj` on 2026-10-20; apply and reapply succeeded. The API was
  fenced with manual zero instances, routed to the new image, then returned to
  automatic scaling after schema and preservation checks passed. Old tags were removed.
- Lore's 42 unaffected public tables retained identical logical row hashes; the
  periodic deletion-ledger checkpoint timestamp was excluded from comparison.
  The prior 42 migration records, public RLS policies and effective active
  issuer/subject authority hashes were unchanged. Two client bindings became one
  active subject binding; the inactive duplicate contributed no authority.
- The two affected Lore binding rows were copied and equality-checked inside a
  private Neon backup schema with no runtime-role access. This was a targeted
  authorization backup, not a full database snapshot or restore rehearsal.
- Existing service identities and secret versions were retained. API and worker
  IAM were unchanged; the Lore worker's image, configuration and traffic were unchanged.
  DNS, Cloud Tasks and memory data were not modified.

## Hosted checks

The final public-HTTPS probes passed on 2026-10-20:

- Canonical Gate discovery advertises its canonical registration endpoint and
  PKCE S256. DCR returns 201 for a public client with the ChatGPT callback, without
  a client secret. OAuth initiation accepts that callback for Weave MCP and both
  Lore MCP resources. Remote-fetch metadata is rejected. Retired fixed IDs return 400.
- Lore readiness returns 200. API requests with no credential, cookie only or an
  invalid bearer return 401. Both MCP resources advertise the expected issuer and
  exact audience; unauthenticated/invalid-bearer POSTs return 401 and GET returns
  405. Removed callback/session routes return 404.
- Weave health, canonical MCP metadata, invalid bearer/session rejection, trusted
  browser preflight and untrusted-origin rejection passed after Gate cutover.
- Lore final readback matched its post-migration data, policy and authority hashes.

## Limits

Hosted personal GitHub login, connection approval, token exchange and successful
MCP-host data operations have not been exercised by these deployment probes.
The local actual-Gate/Firestore/PostgreSQL tests cover the positive DCR path with a
synthetic GitHub exchange; that is separate evidence. Full database restore and
managed PITR acceptance remain outside this release. Initial probes against an
idle Gate observed a fail-closed 503 during cold start; warm retries and final
post-cutover checks passed. This release does not establish an availability SLO.

Do not perform image-only rollback across either changed identity schema. Use a
compatible forward fix or an explicitly planned coherent restore.
