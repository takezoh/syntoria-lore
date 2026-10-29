# Lore development guidance

Write all documentation, code comments, schema descriptions and example annotations in English. Respond to the user in their requested language.

Read [README.md](README.md), [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/development.md](docs/development.md); the development guide maps each concern to the document or source that owns its contract. Confirm behavioral claims against implementation and tests.

Keep user pages focused on what someone can do and expect, implementation behavior in architecture and technical references, dated observations in evaluation records under `docs/eval/`, and the reasoning for a decision in an ADR under `docs/adr/`, written from [its template](docs/adr/template.md). Do not turn an old test or release result into a current product guarantee. [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md) is historical.

REST and MCP are adapters over the same domain packages; do not implement memory policy in an adapter. Authority comes from the authenticated principal and the controlled confirmation path, never from request fields or model output.

Migrations are forward-only: never edit an applied migration, and review a new one with the [migration review template](docs/templates/migration-review.md). After changing the REST contract, regenerate `docs/api/openapi.json` with `npm run openapi:export`.

For code changes, run `npm run verify:local`; it needs a PostgreSQL integration database (`TEST_ADMIN_URL` and `TEST_APP_URL`) and fails without one. Documentation-only changes require language and local-link checks, `npm run secret:scan` and `git diff --check`. Do not claim hosted acceptance, extraction quality or recall quality from local deterministic providers or document validation.

Do not delete identity bindings or rewrite identity, memory or deletion-ledger data as an operational shortcut. Change admissions and approval policies only through the reviewed identity-mapping tool, and keep production identifiers out of the repository as described in [Deployment identifiers](#deployment-identifiers).

## Deployment identifiers

Never commit actual deployment identifiers: not in tracked files, commit messages, test fixtures, examples, documentation, evidence and release records, or generated artifacts. They include GCP project IDs and numbers, service account emails, Cloud Run and other service URLs (`*.run.app`), Artifact Registry paths, Cloud Storage bucket names, production and personal domains and hostnames, redirect registrations, private site URLs, and provider account or endpoint identifiers such as Neon or Cloudflare. They are not secrets, but they map the production environment and the repositories can be public.

- Keep real values in ignored local files (`.local/cloud/deployment.json` and `.local/cloud/iam-contract.json`; render manifests and build configuration outside the repository or under `.local/`) and inject them when rendering or running. Do not hard-code them in scripts, templates or tests.
- In tracked files use only synthetic placeholders: project `example-project`, project number `123456789012` and domains under `example.com` or `example.test`.
- Before committing, check the staged diff, new files and the commit message for such values, including values copied from command output, cloud readbacks or hosted verification.
- If one has been committed, do not push. Report it instead: removing it requires rewriting history and a force push.
