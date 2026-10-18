CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'thymesis_app') THEN
    EXECUTE 'CREATE ROLE thymesis_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT';
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid GENERATED ALWAYS AS (id) STORED UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE scopes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  auth_epoch bigint NOT NULL DEFAULT 1 CHECK (auth_epoch > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, id),
  UNIQUE (id)
);

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner', 'client', 'connector', 'curator')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (issuer, subject),
  UNIQUE (owner_id, id)
);

CREATE TABLE grants (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  capabilities text[] NOT NULL CHECK (
    cardinality(capabilities) > 0 AND capabilities <@ ARRAY['read', 'write', 'admin']::text[]
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope_id, principal_id),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, principal_id) REFERENCES principals(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  canonical_name text NOT NULL CHECK (length(canonical_name) BETWEEN 1 AND 256),
  normalized_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, id),
  UNIQUE (owner_id, scope_id, normalized_name),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE subject_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  alias text NOT NULL CHECK (length(alias) BETWEEN 1 AND 256),
  normalized_alias text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT '-infinity',
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  FOREIGN KEY (owner_id, scope_id, subject_id) REFERENCES subjects(owner_id, scope_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (
    owner_id WITH =,
    scope_id WITH =,
    normalized_alias WITH =,
    tstzrange(valid_from, coalesce(valid_to, 'infinity'::timestamptz), '[)') WITH &&
  )
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('chat', 'document', 'tool_result', 'episode', 'explicit_remember')),
  external_id text NOT NULL,
  revision text NOT NULL,
  rights_status text NOT NULL CHECK (rights_status IN ('granted', 'revoked')),
  consent boolean NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, id),
  UNIQUE (owner_id, scope_id, kind, external_id, revision),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_revision text NOT NULL,
  speaker text,
  event_time timestamptz,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locator text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  lineage_root uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, id),
  FOREIGN KEY (owner_id, scope_id, source_id) REFERENCES sources(owner_id, scope_id, id) ON DELETE CASCADE
);

CREATE TABLE episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  source_id uuid NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  occurred_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'captured' CHECK (status IN ('captured', 'processed', 'held', 'failed')),
  UNIQUE (owner_id, scope_id, id),
  FOREIGN KEY (owner_id, scope_id, source_id) REFERENCES sources(owner_id, scope_id, id) ON DELETE CASCADE
);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_revision text NOT NULL,
  locator text NOT NULL,
  span text,
  speaker text,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_time timestamptz,
  lineage_root uuid,
  snippet text,
  snippet_allowed boolean NOT NULL DEFAULT false,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, id),
  UNIQUE (owner_id, scope_id, source_id, source_revision, locator, content_hash),
  FOREIGN KEY (owner_id, scope_id, source_id) REFERENCES sources(owner_id, scope_id, id) ON DELETE CASCADE
);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fact', 'decision', 'preference', 'hypothesis', 'experience', 'procedure')),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 10000),
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  actor_kind text NOT NULL CHECK (actor_kind IN ('owner', 'client', 'connector', 'curator')),
  authority text NOT NULL CHECK (authority IN ('owner_decision', 'owner_preference', 'third_party_claim', 'observed_state', 'ai_proposal')),
  epistemic_status text NOT NULL CHECK (epistemic_status IN ('asserted', 'observed', 'inferred', 'proposed')),
  contested boolean NOT NULL DEFAULT false,
  lifecycle text NOT NULL CHECK (lifecycle IN ('candidate', 'active', 'superseded', 'retracted', 'forgotten')),
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  committed_revision integer NOT NULL DEFAULT 1 CHECK (committed_revision > 0),
  indexed_revision integer NOT NULL DEFAULT 0 CHECK (indexed_revision >= 0),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  UNIQUE (owner_id, scope_id, id),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, created_by) REFERENCES principals(owner_id, id)
);

CREATE TABLE memory_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  kind text NOT NULL,
  statement text NOT NULL,
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'),
  actor_kind text NOT NULL,
  authority text NOT NULL,
  epistemic_status text NOT NULL,
  contested boolean NOT NULL,
  lifecycle text NOT NULL,
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL,
  superseded_at timestamptz,
  changed_by uuid NOT NULL,
  change_set_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, memory_id, revision),
  FOREIGN KEY (owner_id, scope_id, memory_id) REFERENCES memories(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, changed_by) REFERENCES principals(owner_id, id)
);

CREATE TABLE memory_subjects (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  PRIMARY KEY (owner_id, scope_id, memory_id, subject_id),
  FOREIGN KEY (owner_id, scope_id, memory_id) REFERENCES memories(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, scope_id, subject_id) REFERENCES subjects(owner_id, scope_id, id) ON DELETE CASCADE
);

CREATE TABLE memory_evidence (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  PRIMARY KEY (owner_id, scope_id, memory_id, evidence_id),
  FOREIGN KEY (owner_id, scope_id, memory_id) REFERENCES memories(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, scope_id, evidence_id) REFERENCES evidence(owner_id, scope_id, id) ON DELETE CASCADE
);

CREATE TABLE relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  from_memory_id uuid NOT NULL,
  to_memory_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('supersedes', 'supports', 'contradicts', 'related_to', 'same_subject', 'depends_on_context')),
  context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_memory_id <> to_memory_id),
  UNIQUE (owner_id, scope_id, from_memory_id, to_memory_id, relation),
  FOREIGN KEY (owner_id, scope_id, from_memory_id) REFERENCES memories(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, scope_id, to_memory_id) REFERENCES memories(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, created_by) REFERENCES principals(owner_id, id)
);

CREATE TABLE changesets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  request_id uuid NOT NULL,
  operation_count integer NOT NULL CHECK (operation_count > 0),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, id),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, principal_id) REFERENCES principals(owner_id, id)
);

CREATE TABLE change_ops (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  change_set_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  op text NOT NULL,
  memory_id uuid,
  memory_revision integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (owner_id, scope_id, change_set_id, ordinal),
  FOREIGN KEY (owner_id, scope_id, change_set_id) REFERENCES changesets(owner_id, scope_id, id) ON DELETE CASCADE
);

CREATE TABLE scope_offsets (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope_id),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  change_set_id uuid NOT NULL,
  op text NOT NULL,
  memory_id uuid,
  memory_revision integer,
  tombstone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, seq),
  FOREIGN KEY (owner_id, scope_id, change_set_id) REFERENCES changesets(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  UNIQUE (owner_id, scope_id, id),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE capture_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  source_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('accepted', 'processing', 'held', 'committed', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_retry_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, id),
  FOREIGN KEY (owner_id, scope_id, source_id) REFERENCES sources(owner_id, scope_id, id) ON DELETE CASCADE
);

CREATE TABLE idempotency_keys (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  change_set_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope_id, principal_id, idempotency_key),
  FOREIGN KEY (owner_id, scope_id, change_set_id) REFERENCES changesets(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, principal_id) REFERENCES principals(owner_id, id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal_id uuid,
  event_type text NOT NULL,
  request_id uuid NOT NULL,
  object_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  selector jsonb NOT NULL CHECK (jsonb_typeof(selector) = 'object'),
  reason_code text NOT NULL,
  status text NOT NULL DEFAULT 'suppressed' CHECK (status IN ('suppressed', 'purging', 'complete', 'failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (owner_id, scope_id, id),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, principal_id) REFERENCES principals(owner_id, id)
);

CREATE TABLE suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  deletion_request_id uuid NOT NULL,
  object_kind text NOT NULL,
  object_id uuid,
  locator_hmac text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, object_kind, object_id, locator_hmac),
  FOREIGN KEY (owner_id, scope_id, deletion_request_id) REFERENCES deletion_requests(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE
);

CREATE TABLE embeddings (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL,
  model text NOT NULL,
  dimension integer NOT NULL CHECK (dimension > 0),
  vector real[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope_id, memory_id, revision, model),
  CHECK (cardinality(vector) = dimension),
  FOREIGN KEY (owner_id, scope_id, memory_id) REFERENCES memories(owner_id, scope_id, id) ON DELETE CASCADE
);

CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  feedback_type text NOT NULL CHECK (feedback_type IN ('useful', 'incorrect', 'stale', 'not_relevant')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (owner_id, scope_id, memory_id) REFERENCES memories(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, principal_id) REFERENCES principals(owner_id, id)
);

CREATE TABLE export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('accepted', 'processing', 'ready', 'expired', 'failed')),
  deletion_epoch bigint NOT NULL,
  artifact_key text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, principal_id) REFERENCES principals(owner_id, id)
);

CREATE OR REPLACE FUNCTION app.resolve_principal(p_issuer text, p_subject text)
RETURNS TABLE(owner_id uuid, principal_id uuid, actor_kind text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.owner_id, p.id, p.actor_kind
  FROM public.principals AS p
  WHERE p.issuer = p_issuer AND p.subject = p_subject AND p.active
$$;

REVOKE ALL ON FUNCTION app.resolve_principal(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_principal(text, text) TO thymesis_app;

CREATE OR REPLACE FUNCTION app.bump_scope_epoch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_owner uuid;
  affected_scope uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_owner := OLD.owner_id;
    affected_scope := OLD.scope_id;
  ELSE
    affected_owner := NEW.owner_id;
    affected_scope := NEW.scope_id;
  END IF;
  UPDATE public.scopes SET auth_epoch = auth_epoch + 1
  WHERE owner_id = affected_owner AND id = affected_scope;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER grants_bump_epoch
AFTER INSERT OR UPDATE OR DELETE ON grants
FOR EACH ROW EXECUTE FUNCTION app.bump_scope_epoch();

CREATE TRIGGER sources_bump_epoch
AFTER UPDATE OF rights_status, consent ON sources
FOR EACH ROW WHEN (OLD.rights_status IS DISTINCT FROM NEW.rights_status OR OLD.consent IS DISTINCT FROM NEW.consent)
EXECUTE FUNCTION app.bump_scope_epoch();

CREATE OR REPLACE FUNCTION app.reject_memory_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('app.purge_mode', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'memory versions are append-only' USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER memory_versions_append_only
BEFORE UPDATE OR DELETE ON memory_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_memory_version_mutation();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'grants', 'subjects', 'subject_aliases', 'sources', 'observations', 'episodes', 'evidence',
    'memories', 'memory_versions', 'memory_subjects', 'memory_evidence', 'relations', 'changesets',
    'change_ops', 'scope_offsets', 'change_log', 'outbox', 'capture_jobs', 'idempotency_keys',
    'audit_events', 'deletion_requests', 'suppressions', 'embeddings', 'feedback', 'export_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON public.%I USING (owner_id = nullif(current_setting(''app.owner_id'', true), '''')::uuid AND scope_id = ANY(coalesce(nullif(current_setting(''app.scope_ids'', true), ''''), ''{}'')::uuid[])) WITH CHECK (owner_id = nullif(current_setting(''app.owner_id'', true), '''')::uuid AND scope_id = ANY(coalesce(nullif(current_setting(''app.scope_ids'', true), ''''), ''{}'')::uuid[]))',
      table_name
    );
  END LOOP;
  ALTER TABLE public.scopes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.scopes FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_scope ON public.scopes
    USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid AND id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]))
    WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid AND id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]));
  FOREACH table_name IN ARRAY ARRAY['owners', 'principals'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_owner ON public.%I USING (owner_id = nullif(current_setting(''app.owner_id'', true), '''')::uuid) WITH CHECK (owner_id = nullif(current_setting(''app.owner_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$$;

CREATE INDEX memories_scope_lifecycle_idx ON memories(owner_id, scope_id, lifecycle, id);
CREATE INDEX memories_valid_time_idx ON memories(owner_id, scope_id, valid_from, valid_to);
CREATE INDEX memories_statement_trgm_idx ON memories USING gin (statement gin_trgm_ops);
CREATE INDEX memories_context_trgm_idx ON memories USING gin ((context::text) gin_trgm_ops);
CREATE INDEX evidence_source_idx ON evidence(owner_id, scope_id, source_id, source_revision);
CREATE INDEX change_log_scope_seq_idx ON change_log(owner_id, scope_id, seq);
CREATE INDEX outbox_pending_idx ON outbox(created_at) WHERE delivered_at IS NULL;
CREATE INDEX capture_jobs_ready_idx ON capture_jobs(next_retry_at, created_at) WHERE state IN ('accepted', 'failed');
CREATE INDEX audit_events_created_idx ON audit_events(owner_id, scope_id, created_at DESC);

GRANT USAGE ON SCHEMA public, app TO thymesis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO thymesis_app;
REVOKE INSERT, UPDATE, DELETE ON owners, principals, scopes, grants FROM thymesis_app;
GRANT USAGE ON SCHEMA app TO thymesis_app;
GRANT EXECUTE ON FUNCTION app.resolve_principal(text, text) TO thymesis_app;
REVOKE ALL ON TABLE schema_migrations FROM thymesis_app;

