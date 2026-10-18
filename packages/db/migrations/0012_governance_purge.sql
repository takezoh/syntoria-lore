ALTER TABLE public.scopes
  ADD COLUMN deletion_epoch bigint NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0);
ALTER TABLE public.deletion_requests ALTER COLUMN principal_id DROP NOT NULL;

ALTER TABLE public.deletion_requests
  DROP CONSTRAINT deletion_requests_status_check,
  ADD CONSTRAINT deletion_requests_status_check CHECK (
    status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging', 'complete', 'failed')
  ),
  ADD COLUMN ledger_sequence bigint,
  ADD COLUMN ledger_entry_hash text,
  ADD COLUMN ledger_head_generation text,
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_hash text,
  ADD CONSTRAINT deletion_requests_ledger_hash_check
    CHECK (ledger_entry_hash IS NULL OR ledger_entry_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT deletion_requests_idempotency_check
    CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 256),
  ADD CONSTRAINT deletion_requests_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX deletion_requests_idempotency_idx
  ON public.deletion_requests(owner_id, scope_id, principal_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE public.deletion_targets (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  deletion_request_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('memory', 'source', 'subject')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope_id, deletion_request_id, target_kind, target_id),
  FOREIGN KEY (owner_id, scope_id, deletion_request_id)
    REFERENCES public.deletion_requests(owner_id, scope_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, scope_id) REFERENCES public.scopes(owner_id, id) ON DELETE CASCADE
);

ALTER TABLE public.deletion_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deletion_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.deletion_targets
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]))
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]));

CREATE INDEX deletion_requests_pending_ledger_idx
  ON public.deletion_requests(created_at, id) WHERE status IN ('suppressed', 'ledger_pending');
CREATE INDEX deletion_requests_pending_purge_idx
  ON public.deletion_requests(created_at, id) WHERE status IN ('ledger_acked', 'purging');
CREATE INDEX suppressions_locator_hmac_idx
  ON public.suppressions(owner_id, scope_id, locator_hmac)
  WHERE object_kind = 'locator_hmac' AND locator_hmac IS NOT NULL;

CREATE TABLE public.scope_retention_policies (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  observation_days integer NOT NULL CHECK (observation_days BETWEEN 1 AND 36500),
  memory_days integer CHECK (memory_days BETWEEN 1 AND 36500),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope_id),
  FOREIGN KEY (owner_id, scope_id) REFERENCES public.scopes(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, updated_by) REFERENCES public.principals(owner_id, id)
);

CREATE TABLE public.feedback_reassessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  feedback_id uuid NOT NULL REFERENCES public.feedback(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'proposed', 'held', 'complete', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_id, scope_id, feedback_id),
  FOREIGN KEY (owner_id, scope_id, memory_id) REFERENCES public.memories(owner_id, scope_id, id) ON DELETE CASCADE
);

CREATE TABLE public.portability_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  bundle_hash text NOT NULL CHECK (bundle_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'processing', 'complete', 'held', 'failed')),
  id_map jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(id_map) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (owner_id, scope_id, principal_id, idempotency_key),
  FOREIGN KEY (owner_id, scope_id) REFERENCES public.scopes(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, principal_id) REFERENCES public.principals(owner_id, id)
);

ALTER TABLE public.scope_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scope_retention_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.scope_retention_policies
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]))
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]));
ALTER TABLE public.feedback_reassessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_reassessments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.feedback_reassessments
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]))
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]));
ALTER TABLE public.portability_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portability_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.portability_imports
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]))
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'thymesis_purge_executor') THEN
    CREATE ROLE thymesis_purge_executor NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app TO thymesis_purge_executor;
GRANT SELECT, DELETE ON public.deletion_requests, public.deletion_targets,
  public.suppressions, public.memories, public.sources, public.subjects, public.subject_aliases,
  public.memory_subjects, public.curation_reviews,
  public.owner_confirmations, public.capture_jobs, public.outbox, public.changesets, public.change_ops,
  public.idempotency_keys, public.connector_authorizations, public.export_jobs,
  public.feedback_reassessments, public.evidence, public.observations,
  public.memory_evidence, public.memory_version_evidence, public.memory_embeddings,
  public.embeddings TO thymesis_purge_executor;
GRANT UPDATE ON public.deletion_requests, public.scopes, public.changesets,
  public.idempotency_keys, public.export_jobs TO thymesis_purge_executor;
GRANT EXECUTE ON FUNCTION app.lock_actor_access(uuid, uuid, text, uuid[])
  TO thymesis_purge_executor;

CREATE POLICY deletion_requests_purge_executor ON public.deletion_requests
  USING (current_user = 'thymesis_purge_executor');
CREATE POLICY deletion_targets_purge_executor ON public.deletion_targets
  USING (current_user = 'thymesis_purge_executor')
  WITH CHECK (current_user = 'thymesis_purge_executor');
CREATE POLICY suppressions_purge_executor ON public.suppressions
  USING (current_user = 'thymesis_purge_executor')
  WITH CHECK (current_user = 'thymesis_purge_executor');
GRANT SELECT, INSERT ON public.deletion_targets, public.scope_retention_policies,
  public.feedback_reassessments, public.portability_imports TO thymesis_app;
GRANT SELECT, INSERT, UPDATE ON public.scope_retention_policies,
  public.feedback_reassessments, public.portability_imports TO thymesis_worker;
GRANT SELECT, INSERT, UPDATE ON public.deletion_targets TO thymesis_app, thymesis_worker;

CREATE OR REPLACE FUNCTION app.reject_memory_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'thymesis_purge_executor'
     AND EXISTS (
       SELECT 1 FROM public.deletion_targets AS dt
       JOIN public.deletion_requests AS dr
         ON dr.owner_id = dt.owner_id AND dr.scope_id = dt.scope_id AND dr.id = dt.deletion_request_id
       WHERE dt.owner_id = OLD.owner_id AND dt.scope_id = OLD.scope_id
         AND dt.target_kind = 'memory' AND dt.target_id = OLD.memory_id
         AND dr.status IN ('ledger_acked', 'purging')
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'memory versions are append-only' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION app.purge_forgotten_request_impl(
  p_owner_id uuid,
  p_scope_id uuid,
  p_request_id uuid,
  p_principal_id uuid,
  p_actor_kind text,
  p_require_current_admin boolean
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  request_row public.deletion_requests%ROWTYPE;
  authorized_count integer;
  removed_count integer := 0;
  memory_ids uuid[];
  source_ids uuid[];
  subject_ids uuid[];
  evidence_ids uuid[];
  affected_changeset_ids uuid[];
  affected_review_ids uuid[];
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login') THEN
    RAISE EXCEPTION 'purge is only callable by application or worker login' USING ERRCODE = '42501';
  END IF;
  IF p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
     OR p_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid
     OR p_actor_kind <> 'owner' THEN
    RAISE EXCEPTION 'purge actor context is invalid' USING ERRCODE = '42501';
  END IF;
  IF p_require_current_admin THEN
    SELECT count(*) INTO authorized_count
    FROM app.lock_actor_access(p_owner_id, p_principal_id, p_actor_kind, ARRAY[p_scope_id]::uuid[]) AS access
    WHERE access.scope_id = p_scope_id AND 'admin' = ANY(access.capabilities);
    IF authorized_count <> 1 THEN
      RAISE EXCEPTION 'current owner admin grant is required for purge' USING ERRCODE = '42501';
    END IF;
  ELSIF session_user <> 'thymesis_worker_login' THEN
    RAISE EXCEPTION 'ledger replay purge requires the worker login' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO request_row FROM public.deletion_requests
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND id = p_request_id
    AND coalesce(principal_id, nullif(selector->>'original_principal_id', '')::uuid) = p_principal_id FOR UPDATE;
  IF NOT FOUND OR request_row.ledger_sequence IS NULL OR request_row.ledger_entry_hash IS NULL
     OR request_row.status NOT IN ('ledger_acked', 'purging') THEN
    RAISE EXCEPTION 'deletion request has no durable ledger receipt' USING ERRCODE = '55000';
  END IF;

  UPDATE public.deletion_requests SET status = 'purging'
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND id = p_request_id;
  SELECT coalesce(array_agg(target_id) FILTER (WHERE target_kind = 'memory'), ARRAY[]::uuid[]),
         coalesce(array_agg(target_id) FILTER (WHERE target_kind = 'source'), ARRAY[]::uuid[]),
         coalesce(array_agg(target_id) FILTER (WHERE target_kind = 'subject'), ARRAY[]::uuid[])
    INTO memory_ids, source_ids, subject_ids
  FROM public.deletion_targets
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND deletion_request_id = p_request_id;

  SELECT coalesce(array_agg(DISTINCT e.id), ARRAY[]::uuid[])
    INTO evidence_ids
  FROM public.evidence AS e
  WHERE e.owner_id = p_owner_id AND e.scope_id = p_scope_id AND (
    e.source_id = ANY(source_ids)
    OR EXISTS (SELECT 1 FROM public.memory_evidence me
      WHERE me.owner_id = e.owner_id AND me.scope_id = e.scope_id
        AND me.evidence_id = e.id AND me.memory_id = ANY(memory_ids))
    OR EXISTS (SELECT 1 FROM public.memory_version_evidence mve
      WHERE mve.owner_id = e.owner_id AND mve.scope_id = e.scope_id
        AND mve.evidence_id = e.id AND mve.memory_id = ANY(memory_ids))
  );

  SELECT coalesce(array_agg(DISTINCT cs.id), ARRAY[]::uuid[]) INTO affected_changeset_ids
  FROM public.changesets AS cs
  WHERE cs.owner_id = p_owner_id AND cs.scope_id = p_scope_id AND (
    EXISTS (SELECT 1 FROM public.change_ops AS op WHERE op.owner_id = cs.owner_id
      AND op.scope_id = cs.scope_id AND op.change_set_id = cs.id AND op.memory_id = ANY(memory_ids))
    OR EXISTS (SELECT 1 FROM public.curation_reviews AS cr JOIN public.capture_jobs AS cj
      ON cj.owner_id = cr.owner_id AND cj.scope_id = cr.scope_id AND cj.id = cr.job_id
      WHERE cr.owner_id = cs.owner_id AND cr.scope_id = cs.scope_id
        AND cr.change_set_id = cs.id AND cj.source_id = ANY(source_ids))
  );
  SELECT coalesce(array_agg(DISTINCT cr.id), ARRAY[]::uuid[]) INTO affected_review_ids
  FROM public.curation_reviews AS cr
  JOIN public.capture_jobs AS cj ON cj.owner_id = cr.owner_id AND cj.scope_id = cr.scope_id
    AND cj.id = cr.job_id
  WHERE cr.owner_id = p_owner_id AND cr.scope_id = p_scope_id
    AND (cr.change_set_id = ANY(affected_changeset_ids) OR cj.source_id = ANY(source_ids));

  -- Proposal, review, checkpoint and idempotency responses can retain source text.
  UPDATE public.changesets AS cs SET
    status = CASE WHEN cs.status = 'proposed' THEN 'rejected' ELSE cs.status END,
    proposal = NULL, proposal_hash = NULL, proposal_idempotency_key = NULL,
    proposal_response = NULL,
    response = jsonb_build_object('redacted', true, 'reason', 'forgotten'),
    committed_at = CASE WHEN cs.status = 'committed' THEN cs.committed_at ELSE NULL END
  WHERE cs.owner_id = p_owner_id AND cs.scope_id = p_scope_id AND cs.id = ANY(affected_changeset_ids);
  DELETE FROM public.idempotency_keys AS ik USING public.changesets cs
    WHERE ik.owner_id = p_owner_id AND ik.scope_id = p_scope_id AND ik.change_set_id = cs.id
      AND cs.owner_id = ik.owner_id AND cs.scope_id = ik.scope_id
      AND cs.id = ANY(affected_changeset_ids);
  DELETE FROM public.owner_confirmations oc USING public.curation_reviews cr
    WHERE oc.owner_id = cr.owner_id AND oc.scope_id = cr.scope_id AND oc.review_id = cr.id
      AND cr.owner_id = p_owner_id AND cr.scope_id = p_scope_id
      AND (oc.memory_ids && memory_ids OR cr.id = ANY(affected_review_ids) OR EXISTS (
        SELECT 1 FROM public.capture_jobs cj
        WHERE cj.owner_id = cr.owner_id AND cj.scope_id = cr.scope_id
          AND cj.id = cr.job_id AND cj.source_id = ANY(source_ids)
      ));
  UPDATE public.capture_jobs cj SET checkpoint = '{}'::jsonb, state = 'failed',
      last_error_code = 'forgotten', updated_at = clock_timestamp()
    WHERE cj.owner_id = p_owner_id AND cj.scope_id = p_scope_id
      AND EXISTS (SELECT 1 FROM public.curation_reviews cr WHERE cr.owner_id = cj.owner_id
        AND cr.scope_id = cj.scope_id AND cr.job_id = cj.id AND cr.id = ANY(affected_review_ids));
  DELETE FROM public.curation_reviews cr
    WHERE cr.owner_id = p_owner_id AND cr.scope_id = p_scope_id AND cr.id = ANY(affected_review_ids);
  DELETE FROM public.capture_jobs WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND source_id = ANY(source_ids);
  DELETE FROM public.outbox WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND aggregate_id = ANY(source_ids || memory_ids);
  UPDATE public.export_jobs SET state = 'expired', artifact_key = NULL, expires_at = clock_timestamp()
    WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND state IN ('accepted', 'processing', 'ready');
  DELETE FROM public.feedback_reassessments WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND memory_id = ANY(memory_ids);
  DELETE FROM public.memories WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND id = ANY(memory_ids);
  GET DIAGNOSTICS removed_count = ROW_COUNT;
  DELETE FROM public.evidence AS e
    WHERE e.owner_id = p_owner_id AND e.scope_id = p_scope_id AND e.id = ANY(evidence_ids)
      AND NOT EXISTS (SELECT 1 FROM public.memory_evidence me
        WHERE me.owner_id = e.owner_id AND me.scope_id = e.scope_id AND me.evidence_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM public.memory_version_evidence mve
        WHERE mve.owner_id = e.owner_id AND mve.scope_id = e.scope_id AND mve.evidence_id = e.id);
  DELETE FROM public.observations AS o
    WHERE o.owner_id = p_owner_id AND o.scope_id = p_scope_id
      AND o.source_id = ANY(source_ids);
  DELETE FROM public.observations AS o
    WHERE o.owner_id = p_owner_id AND o.scope_id = p_scope_id
      AND EXISTS (SELECT 1 FROM public.evidence e WHERE e.owner_id = p_owner_id
        AND e.scope_id = p_scope_id AND e.id = ANY(evidence_ids)
        AND e.source_id = o.source_id AND e.source_revision = o.source_revision
        AND e.locator = o.locator)
      AND NOT EXISTS (SELECT 1 FROM public.evidence e WHERE e.owner_id = o.owner_id
        AND e.scope_id = o.scope_id AND e.source_id = o.source_id
        AND e.source_revision = o.source_revision AND e.locator = o.locator);
  DELETE FROM public.sources WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND id = ANY(source_ids);
  DELETE FROM public.subjects AS sub
    WHERE sub.owner_id = p_owner_id AND sub.scope_id = p_scope_id AND sub.id = ANY(subject_ids)
      AND NOT EXISTS (SELECT 1 FROM public.memory_subjects ms WHERE ms.owner_id = sub.owner_id
        AND ms.scope_id = sub.scope_id AND ms.subject_id = sub.id);

  UPDATE public.deletion_requests SET status = 'complete', completed_at = clock_timestamp()
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND id = p_request_id;
  RETURN removed_count;
END
$$;

ALTER FUNCTION app.purge_forgotten_request_impl(uuid, uuid, uuid, uuid, text, boolean)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.purge_forgotten_request_impl(uuid, uuid, uuid, uuid, text, boolean)
  FROM PUBLIC, thymesis_app, thymesis_worker;

CREATE OR REPLACE FUNCTION app.purge_forgotten_request(
  p_owner_id uuid, p_scope_id uuid, p_request_id uuid, p_principal_id uuid, p_actor_kind text
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  RETURN app.purge_forgotten_request_impl(p_owner_id, p_scope_id, p_request_id,
    p_principal_id, p_actor_kind, true);
END
$$;
ALTER FUNCTION app.purge_forgotten_request(uuid, uuid, uuid, uuid, text) OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.purge_forgotten_request(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_forgotten_request(uuid, uuid, uuid, uuid, text)
  TO thymesis_app, thymesis_worker;

CREATE OR REPLACE FUNCTION app.purge_replayed_forgotten_request(
  p_owner_id uuid, p_scope_id uuid, p_request_id uuid, p_principal_id uuid,
  p_sequence bigint, p_entry_hash text, p_head_generation text
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  stored public.deletion_requests%ROWTYPE;
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member')
     OR p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
     OR p_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified worker actor context required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO stored FROM public.deletion_requests dr
    WHERE dr.owner_id = p_owner_id AND dr.scope_id = p_scope_id AND dr.id = p_request_id
      AND coalesce(dr.principal_id, nullif(dr.selector->>'original_principal_id', '')::uuid) = p_principal_id
      AND dr.ledger_sequence = p_sequence AND dr.ledger_entry_hash = p_entry_hash
      AND dr.ledger_head_generation = p_head_generation
      AND dr.status IN ('ledger_acked', 'purging') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deletion receipt does not match the durable replay record' USING ERRCODE = '55000';
  END IF;
  RETURN app.purge_forgotten_request_impl(p_owner_id, p_scope_id, p_request_id,
    p_principal_id, 'owner', false);
END
$$;
ALTER FUNCTION app.purge_replayed_forgotten_request(uuid, uuid, uuid, uuid, bigint, text, text)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.purge_replayed_forgotten_request(uuid, uuid, uuid, uuid, bigint, text, text)
  FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.purge_replayed_forgotten_request(uuid, uuid, uuid, uuid, bigint, text, text)
  TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.ack_deletion_ledger(
  p_owner_id uuid,
  p_scope_id uuid,
  p_request_id uuid,
  p_principal_id uuid,
  p_sequence bigint,
  p_entry_hash text,
  p_head_generation text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  request_row public.deletion_requests%ROWTYPE;
  authorized_count integer;
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member')
     OR p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
     OR p_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid
     OR p_sequence < 1 OR p_entry_hash !~ '^[0-9a-f]{64}$' OR length(p_head_generation) < 16 THEN
    RAISE EXCEPTION 'ledger receipt context is invalid' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO request_row FROM public.deletion_requests
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND id = p_request_id
    AND coalesce(principal_id, nullif(selector->>'original_principal_id', '')::uuid) = p_principal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deletion request not found' USING ERRCODE = 'P0002';
  END IF;
  IF request_row.ledger_sequence IS NOT NULL THEN
    IF request_row.ledger_sequence = p_sequence AND request_row.ledger_entry_hash = p_entry_hash
       AND request_row.ledger_head_generation = p_head_generation THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'deletion request already has a different ledger receipt' USING ERRCODE = '23505';
  END IF;
  IF request_row.status NOT IN ('suppressed', 'ledger_pending') THEN
    RAISE EXCEPTION 'deletion request is not awaiting a ledger receipt' USING ERRCODE = '55000';
  END IF;
  UPDATE public.deletion_requests SET status = 'ledger_acked', ledger_sequence = p_sequence,
    ledger_entry_hash = p_entry_hash, ledger_head_generation = p_head_generation
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND id = p_request_id;
END
$$;
ALTER FUNCTION app.ack_deletion_ledger(uuid, uuid, uuid, uuid, bigint, text, text)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.ack_deletion_ledger(uuid, uuid, uuid, uuid, bigint, text, text)
  FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.ack_deletion_ledger(uuid, uuid, uuid, uuid, bigint, text, text)
  TO thymesis_worker;
REVOKE UPDATE ON public.deletion_requests FROM thymesis_app, thymesis_worker;

CREATE OR REPLACE FUNCTION app.manage_scope_grant(
  p_owner_id uuid,
  p_scope_id uuid,
  p_actor_principal_id uuid,
  p_target_principal_id uuid,
  p_capabilities text[],
  p_expires_at timestamptz,
  p_revoke boolean
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  authorized_count integer;
BEGIN
  IF session_user <> 'thymesis_app'
     OR p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
     OR p_actor_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid THEN
    RAISE EXCEPTION 'grant actor context is invalid' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO authorized_count
  FROM app.lock_actor_access(p_owner_id, p_actor_principal_id, 'owner', ARRAY[p_scope_id]::uuid[]) AS access
  WHERE access.scope_id = p_scope_id AND 'admin' = ANY(access.capabilities);
  IF authorized_count <> 1 THEN
    RAISE EXCEPTION 'current owner admin grant is required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.principals WHERE owner_id = p_owner_id AND id = p_target_principal_id AND active) THEN
    RAISE EXCEPTION 'grant principal not found' USING ERRCODE = '42501';
  END IF;
  IF p_revoke THEN
    DELETE FROM public.grants WHERE owner_id = p_owner_id AND scope_id = p_scope_id
      AND principal_id = p_target_principal_id;
  ELSE
    IF cardinality(p_capabilities) = 0 OR NOT p_capabilities <@ ARRAY['read', 'write', 'admin']::text[] THEN
      RAISE EXCEPTION 'grant capabilities are invalid' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.grants(owner_id, scope_id, principal_id, capabilities, expires_at)
      VALUES (p_owner_id, p_scope_id, p_target_principal_id, p_capabilities, p_expires_at)
      ON CONFLICT (owner_id, scope_id, principal_id) DO UPDATE SET
        capabilities = EXCLUDED.capabilities, expires_at = EXCLUDED.expires_at,
        updated_at = clock_timestamp();
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'thymesis_authority_executor') THEN
    CREATE ROLE thymesis_authority_executor NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public, app TO thymesis_authority_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grants TO thymesis_authority_executor;
GRANT SELECT ON public.scopes, public.principals TO thymesis_authority_executor;
GRANT UPDATE ON public.scopes TO thymesis_authority_executor;
GRANT EXECUTE ON FUNCTION app.lock_actor_access(uuid, uuid, text, uuid[])
  TO thymesis_authority_executor;
ALTER FUNCTION app.manage_scope_grant(uuid, uuid, uuid, uuid, text[], timestamptz, boolean)
  OWNER TO thymesis_authority_executor;
REVOKE ALL ON FUNCTION app.manage_scope_grant(uuid, uuid, uuid, uuid, text[], timestamptz, boolean)
  FROM PUBLIC, thymesis_worker;
GRANT EXECUTE ON FUNCTION app.manage_scope_grant(uuid, uuid, uuid, uuid, text[], timestamptz, boolean)
  TO thymesis_app;

CREATE OR REPLACE FUNCTION app.list_pending_deletions()
RETURNS TABLE(
  owner_id uuid, scope_id uuid, request_id uuid, principal_id uuid, blocked_at timestamptz,
  memory_ids uuid[], source_ids uuid[], subject_ids uuid[], source_locator_hmacs text[], status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT dr.owner_id, dr.scope_id, dr.id,
    coalesce(dr.principal_id, nullif(dr.selector->>'original_principal_id', '')::uuid), dr.created_at,
    coalesce(array_agg(DISTINCT dt.target_id) FILTER (WHERE dt.target_kind = 'memory'), ARRAY[]::uuid[]),
    coalesce(array_agg(DISTINCT dt.target_id) FILTER (WHERE dt.target_kind = 'source'), ARRAY[]::uuid[]),
    coalesce(array_agg(DISTINCT dt.target_id) FILTER (WHERE dt.target_kind = 'subject'), ARRAY[]::uuid[]),
    coalesce(array_agg(DISTINCT sp.locator_hmac) FILTER (WHERE sp.object_kind = 'locator_hmac' AND sp.locator_hmac IS NOT NULL), ARRAY[]::text[]),
    dr.status
  FROM public.deletion_requests dr
  LEFT JOIN public.deletion_targets dt ON dt.owner_id = dr.owner_id AND dt.scope_id = dr.scope_id
    AND dt.deletion_request_id = dr.id
  LEFT JOIN public.suppressions sp ON sp.owner_id = dr.owner_id AND sp.scope_id = dr.scope_id
    AND sp.deletion_request_id = dr.id
  WHERE dr.status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging')
  GROUP BY dr.owner_id, dr.scope_id, dr.id
  ORDER BY min(dr.created_at), dr.id;
END
$$;
ALTER FUNCTION app.list_pending_deletions() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.list_pending_deletions() FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.list_pending_deletions() TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.replay_deletion_ledger_entry(
  p_request_id uuid, p_owner_id uuid, p_scope_id uuid, p_principal_id uuid,
  p_blocked_at timestamptz, p_memory_ids uuid[], p_source_ids uuid[], p_subject_ids uuid[], p_locator_hmacs text[],
  p_sequence bigint, p_entry_hash text, p_head_generation text
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_hash text;
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member')
     OR p_sequence < 1 OR p_entry_hash !~ '^[0-9a-f]{64}$'
     OR length(p_head_generation) < 16 OR cardinality(p_locator_hmacs) > 100000 THEN
    RAISE EXCEPTION 'trusted worker and verified ledger receipt required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('app.owner_id', p_owner_id::text, true);
  PERFORM pg_catalog.set_config('app.scope_ids', ARRAY[p_scope_id]::text, true);
  PERFORM pg_catalog.set_config('app.principal_id', p_principal_id::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.scopes WHERE owner_id = p_owner_id AND id = p_scope_id) THEN
    RETURN false;
  END IF;
  SELECT ledger_entry_hash INTO existing_hash FROM public.deletion_requests
    WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND id = p_request_id;
  IF existing_hash IS NOT NULL AND existing_hash <> p_entry_hash THEN
    RAISE EXCEPTION 'ledger replay conflicts with deletion request' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.deletion_requests(id, owner_id, scope_id, principal_id, selector, reason_code,
      status, created_at, ledger_sequence, ledger_entry_hash, ledger_head_generation)
    VALUES (p_request_id, p_owner_id, p_scope_id,
      CASE WHEN EXISTS (SELECT 1 FROM public.principals WHERE owner_id=p_owner_id AND id=p_principal_id)
        THEN p_principal_id ELSE NULL END,
      jsonb_build_object('memory_ids', p_memory_ids, 'source_ids', p_source_ids, 'subject_ids', p_subject_ids,
        'original_principal_id', p_principal_id),
      'user_requested', 'ledger_acked', p_blocked_at, p_sequence, p_entry_hash, p_head_generation)
    ON CONFLICT (owner_id, scope_id, id) DO UPDATE SET status = 'ledger_acked',
      ledger_sequence = EXCLUDED.ledger_sequence, ledger_entry_hash = EXCLUDED.ledger_entry_hash,
      ledger_head_generation = EXCLUDED.ledger_head_generation;
  INSERT INTO public.deletion_targets(owner_id, scope_id, deletion_request_id, target_kind, target_id)
    SELECT p_owner_id, p_scope_id, p_request_id, 'memory', unnest(p_memory_ids)
    ON CONFLICT DO NOTHING;
  INSERT INTO public.deletion_targets(owner_id, scope_id, deletion_request_id, target_kind, target_id)
    SELECT p_owner_id, p_scope_id, p_request_id, 'source', unnest(p_source_ids)
    ON CONFLICT DO NOTHING;
  INSERT INTO public.deletion_targets(owner_id, scope_id, deletion_request_id, target_kind, target_id)
    SELECT p_owner_id, p_scope_id, p_request_id, 'subject', unnest(p_subject_ids)
    ON CONFLICT DO NOTHING;
  INSERT INTO public.suppressions(owner_id, scope_id, deletion_request_id, object_kind, object_id)
    SELECT p_owner_id, p_scope_id, p_request_id, 'memory', unnest(p_memory_ids)
    ON CONFLICT DO NOTHING;
  INSERT INTO public.suppressions(owner_id, scope_id, deletion_request_id, object_kind, object_id)
    SELECT p_owner_id, p_scope_id, p_request_id, 'source', unnest(p_source_ids)
    ON CONFLICT DO NOTHING;
  INSERT INTO public.suppressions(owner_id, scope_id, deletion_request_id, object_kind, locator_hmac)
    SELECT p_owner_id, p_scope_id, p_request_id, 'locator_hmac', unnest(p_locator_hmacs)
    ON CONFLICT DO NOTHING;
  UPDATE public.scopes SET deletion_epoch = deletion_epoch + 1
    WHERE owner_id = p_owner_id AND id = p_scope_id;
  RETURN true;
END
$$;
ALTER FUNCTION app.replay_deletion_ledger_entry(uuid, uuid, uuid, uuid, timestamptz, uuid[], uuid[], uuid[], text[], bigint, text, text)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.replay_deletion_ledger_entry(uuid, uuid, uuid, uuid, timestamptz, uuid[], uuid[], uuid[], text[], bigint, text, text)
  FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.replay_deletion_ledger_entry(uuid, uuid, uuid, uuid, timestamptz, uuid[], uuid[], uuid[], text[], bigint, text, text)
  TO thymesis_worker;
