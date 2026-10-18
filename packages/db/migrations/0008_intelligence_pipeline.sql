CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE connector_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('chat', 'document', 'tool_result', 'episode')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 512),
  enabled boolean NOT NULL DEFAULT false,
  consent boolean NOT NULL DEFAULT false,
  rights_status text NOT NULL DEFAULT 'revoked' CHECK (rights_status IN ('granted', 'revoked')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, source_kind, external_id),
  FOREIGN KEY (owner_id, scope_id) REFERENCES scopes(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, created_by) REFERENCES principals(owner_id, id),
  CHECK (NOT enabled OR (consent AND rights_status = 'granted'))
);

ALTER TABLE observations
  ADD COLUMN canonical_locator text,
  ADD COLUMN source_kind text,
  ADD COLUMN prompt_generation text NOT NULL DEFAULT 'curator-v1';

UPDATE observations AS o
SET canonical_locator = o.locator, source_kind = s.kind
FROM sources AS s
WHERE s.owner_id = o.owner_id AND s.scope_id = o.scope_id AND s.id = o.source_id
  AND o.canonical_locator IS NULL;
ALTER TABLE observations ALTER COLUMN canonical_locator SET NOT NULL;
ALTER TABLE observations ALTER COLUMN source_kind SET NOT NULL;
ALTER TABLE observations ADD CONSTRAINT observations_source_kind_check
  CHECK (source_kind IN ('chat', 'document', 'tool_result', 'episode'));
CREATE UNIQUE INDEX observations_canonical_dedupe_idx
  ON observations(owner_id, scope_id, source_id, source_revision, canonical_locator, content_hash);

CREATE OR REPLACE FUNCTION app.reject_observation_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'source observations are immutable' USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER observations_immutable
BEFORE UPDATE ON observations
FOR EACH ROW EXECUTE FUNCTION app.reject_observation_update();
REVOKE UPDATE ON TABLE observations FROM thymesis_app;

ALTER TABLE evidence
  ADD COLUMN observation_id uuid,
  ADD COLUMN span_start integer,
  ADD COLUMN span_end integer,
  ADD CONSTRAINT evidence_observation_fk
    FOREIGN KEY (owner_id, scope_id, observation_id)
    REFERENCES observations(owner_id, scope_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT evidence_observation_span_check
    CHECK ((observation_id IS NULL AND span_start IS NULL AND span_end IS NULL)
      OR (observation_id IS NOT NULL AND span_start >= 0 AND span_end > span_start));
CREATE UNIQUE INDEX evidence_observation_span_idx
  ON evidence(owner_id, scope_id, observation_id, span_start, span_end, lineage_root)
  WHERE observation_id IS NOT NULL;

ALTER TABLE capture_jobs
  ADD COLUMN principal_id uuid,
  ADD COLUMN actor_kind text,
  ADD COLUMN request_hash text,
  ADD COLUMN prompt_generation text NOT NULL DEFAULT 'curator-v1',
  ADD COLUMN model_id text NOT NULL DEFAULT 'local-fake-v1',
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN auth_epochs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(auth_epochs) = 'object'),
  ADD COLUMN token_scope_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  ADD COLUMN authorized_capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN review_id uuid,
  ADD CONSTRAINT capture_jobs_principal_fk FOREIGN KEY (owner_id, principal_id)
    REFERENCES principals(owner_id, id),
  ADD CONSTRAINT capture_jobs_actor_kind_check
    CHECK (actor_kind IS NULL OR actor_kind IN ('owner', 'client', 'connector', 'curator')),
  ADD CONSTRAINT capture_jobs_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX capture_jobs_dedupe_idx
  ON capture_jobs(owner_id, scope_id, source_id, request_hash)
  WHERE request_hash IS NOT NULL;

CREATE TABLE capture_requests (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope_id, principal_id, operation_id),
  UNIQUE (owner_id, scope_id, principal_id, idempotency_key),
  FOREIGN KEY (owner_id, principal_id) REFERENCES principals(owner_id, id),
  FOREIGN KEY (owner_id, scope_id, job_id) REFERENCES capture_jobs(owner_id, scope_id, id)
    ON DELETE CASCADE
);

CREATE TABLE capture_job_observations (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  job_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (owner_id, scope_id, job_id, ordinal),
  UNIQUE (owner_id, scope_id, job_id, observation_id),
  FOREIGN KEY (owner_id, scope_id, job_id) REFERENCES capture_jobs(owner_id, scope_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (owner_id, scope_id, observation_id) REFERENCES observations(owner_id, scope_id, id)
    ON DELETE CASCADE
);

CREATE TABLE curation_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  job_id uuid NOT NULL,
  change_set_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'approved', 'rejected', 'stale')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  rationale text NOT NULL DEFAULT '',
  candidate_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(candidate_summary) = 'object'),
  evidence_anchors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_anchors) = 'array'),
  expected_revisions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(expected_revisions) = 'object'),
  decision_reason text,
  decision_by uuid,
  decision_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, job_id),
  UNIQUE (owner_id, scope_id, id),
  FOREIGN KEY (owner_id, scope_id, job_id) REFERENCES capture_jobs(owner_id, scope_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (owner_id, scope_id, change_set_id) REFERENCES changesets(owner_id, scope_id, id),
  FOREIGN KEY (owner_id, decision_by) REFERENCES principals(owner_id, id)
);

CREATE TABLE owner_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  review_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  confirmation_type text NOT NULL CHECK (confirmation_type IN ('owner_statement')),
  memory_ids uuid[] NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, id),
  FOREIGN KEY (owner_id, scope_id, review_id) REFERENCES curation_reviews(owner_id, scope_id, id),
  FOREIGN KEY (owner_id, principal_id) REFERENCES principals(owner_id, id)
);

ALTER TABLE outbox
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN lease_token uuid,
  ADD COLUMN dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0);
CREATE INDEX outbox_dispatch_ready_idx
  ON outbox(created_at) WHERE delivered_at IS NULL;
CREATE UNIQUE INDEX outbox_capture_once_idx
  ON outbox(owner_id, scope_id, event_type, aggregate_id)
  WHERE event_type = 'capture.accepted';
CREATE INDEX curation_reviews_held_idx
  ON curation_reviews(owner_id, scope_id, created_at, id) WHERE status = 'held';

CREATE TABLE memory_embeddings (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  model text NOT NULL,
  dimension integer NOT NULL CHECK (dimension BETWEEN 1 AND 2000),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope_id, memory_id, revision, model, dimension),
  FOREIGN KEY (owner_id, scope_id, memory_id) REFERENCES memories(owner_id, scope_id, id)
    ON DELETE CASCADE,
  CHECK (vector_dims(embedding) = dimension)
);
CREATE INDEX memory_embeddings_model_dimension_idx
  ON memory_embeddings(owner_id, scope_id, model, dimension, memory_id, revision);
CREATE INDEX memory_embeddings_hnsw_cosine_1536_idx
  ON memory_embeddings USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WHERE dimension = 1536;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'connector_authorizations', 'capture_requests', 'capture_job_observations',
    'curation_reviews', 'owner_confirmations', 'memory_embeddings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON public.%I USING (owner_id = nullif(current_setting(''app.owner_id'', true), '''')::uuid AND scope_id = ANY(coalesce(nullif(current_setting(''app.scope_ids'', true), ''''), ''{}'')::uuid[])) WITH CHECK (owner_id = nullif(current_setting(''app.owner_id'', true), '''')::uuid AND scope_id = ANY(coalesce(nullif(current_setting(''app.scope_ids'', true), ''''), ''{}'')::uuid[]))',
      table_name
    );
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  connector_authorizations, capture_requests, capture_job_observations,
  curation_reviews, owner_confirmations, memory_embeddings TO thymesis_app;
GRANT EXECUTE ON FUNCTION app.reject_observation_update() TO thymesis_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'thymesis_worker') THEN
    CREATE ROLE thymesis_worker NOLOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
  END IF;
END
$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO thymesis_worker;
GRANT USAGE ON SCHEMA public, app TO thymesis_worker;
GRANT EXECUTE ON FUNCTION app.lock_actor_access(uuid, uuid, text, uuid[]) TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.claim_capture_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE(
  job_id uuid, owner_id uuid, scope_id uuid, source_id uuid, principal_id uuid, actor_kind text,
  attempt integer, state text, lease_token uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker database role required' USING ERRCODE = '42501';
  END IF;
  IF p_lease_seconds < 10 OR p_lease_seconds > 1800 THEN
    RAISE EXCEPTION 'lease duration is out of range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    UPDATE public.capture_jobs AS j
      SET state = 'processing', attempt = j.attempt + 1,
          lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
          lease_token = p_lease_token, updated_at = clock_timestamp()
      WHERE j.id = p_job_id
        AND j.attempt < j.max_attempts
        AND ((j.state IN ('accepted', 'failed') AND coalesce(j.next_retry_at, '-infinity') <= clock_timestamp())
          OR (j.state = 'processing' AND j.lease_until <= clock_timestamp()))
      RETURNING j.id, j.owner_id, j.scope_id, j.source_id, j.principal_id, j.actor_kind,
        j.attempt, j.state, j.lease_token;
END
$$;

CREATE OR REPLACE FUNCTION app.capture_job_status(p_job_id uuid)
RETURNS TABLE(state text, review_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT j.state, j.review_id FROM public.capture_jobs AS j
  WHERE j.id = p_job_id AND pg_has_role(session_user, 'thymesis_worker', 'member')
$$;

CREATE OR REPLACE FUNCTION app.due_capture_job_ids(p_limit integer DEFAULT 100)
RETURNS TABLE(job_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker database role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'job sweep limit is out of range' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT j.id FROM public.capture_jobs j
    WHERE j.attempt < j.max_attempts
      AND ((j.state = 'accepted' AND coalesce(j.next_retry_at, '-infinity') <= clock_timestamp())
        OR (j.state = 'failed' AND coalesce(j.next_retry_at, '-infinity') <= clock_timestamp())
        OR (j.state = 'processing' AND j.lease_until <= clock_timestamp()))
    ORDER BY j.created_at LIMIT p_limit;
END
$$;

CREATE OR REPLACE FUNCTION app.claim_outbox_events(
  p_lease_token uuid,
  p_limit integer DEFAULT 50,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE(owner_id uuid, scope_id uuid, event_id uuid, event_type text, payload jsonb, lease_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker database role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit < 1 OR p_limit > 500 OR p_lease_seconds < 10 OR p_lease_seconds > 1800 THEN
    RAISE EXCEPTION 'outbox claim bounds are invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH ready AS (
      SELECT o.owner_id, o.scope_id, o.id FROM public.outbox o
      WHERE o.event_type = 'capture.accepted' AND o.delivered_at IS NULL
        AND (o.lease_until IS NULL OR o.lease_until <= clock_timestamp())
      ORDER BY o.created_at FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    UPDATE public.outbox o SET lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      lease_token = p_lease_token, dispatch_attempts = o.dispatch_attempts + 1, attempts = o.attempts + 1
    FROM ready r WHERE o.owner_id = r.owner_id AND o.scope_id = r.scope_id AND o.id = r.id
    RETURNING o.owner_id, o.scope_id, o.id, o.event_type, o.payload, o.lease_token;
END
$$;

CREATE OR REPLACE FUNCTION app.complete_outbox_event(p_event_id uuid, p_lease_token uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed integer;
BEGIN
  IF NOT pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker database role required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.outbox SET delivered_at = clock_timestamp(), lease_until = NULL, lease_token = NULL
    WHERE id = p_event_id AND lease_token = p_lease_token AND delivered_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

CREATE OR REPLACE FUNCTION app.retry_outbox_event(p_event_id uuid, p_lease_token uuid, p_retry_seconds integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE changed integer;
BEGIN
  IF NOT pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker database role required' USING ERRCODE = '42501';
  END IF;
  IF p_retry_seconds < 1 OR p_retry_seconds > 86400 THEN
    RAISE EXCEPTION 'outbox retry delay is out of range' USING ERRCODE = '22023';
  END IF;
  UPDATE public.outbox SET lease_until = clock_timestamp() + make_interval(secs => p_retry_seconds), lease_token = NULL
    WHERE id = p_event_id AND lease_token = p_lease_token AND delivered_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;

REVOKE ALL ON FUNCTION app.claim_capture_job(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.capture_job_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.due_capture_job_ids(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_outbox_events(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_outbox_event(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.retry_outbox_event(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_capture_job(uuid, uuid, integer) TO thymesis_worker;
GRANT EXECUTE ON FUNCTION app.capture_job_status(uuid) TO thymesis_worker;
GRANT EXECUTE ON FUNCTION app.due_capture_job_ids(integer) TO thymesis_worker;
GRANT EXECUTE ON FUNCTION app.claim_outbox_events(uuid, integer, integer) TO thymesis_worker;
GRANT EXECUTE ON FUNCTION app.complete_outbox_event(uuid, uuid) TO thymesis_worker;
GRANT EXECUTE ON FUNCTION app.retry_outbox_event(uuid, uuid, integer) TO thymesis_worker;
