ALTER TABLE public.export_jobs
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_hash text,
  ADD CONSTRAINT export_jobs_idempotency_key_check
    CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 256),
  ADD CONSTRAINT export_jobs_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX export_jobs_idempotency_idx
  ON public.export_jobs(owner_id, scope_id, principal_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION app.list_pending_export_jobs()
RETURNS TABLE(export_id uuid, owner_id uuid, scope_id uuid, principal_id uuid, deletion_epoch bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY WITH candidates AS (
    SELECT ej.id FROM public.export_jobs ej WHERE ej.state = 'accepted'
    ORDER BY ej.created_at, ej.id FOR UPDATE SKIP LOCKED LIMIT 100
  ), claimed AS (
    UPDATE public.export_jobs ej SET state = 'processing'
    FROM candidates c WHERE ej.id = c.id
    RETURNING ej.id, ej.owner_id, ej.scope_id, ej.principal_id, ej.deletion_epoch, ej.created_at
  ) SELECT claimed.id, claimed.owner_id, claimed.scope_id, claimed.principal_id, claimed.deletion_epoch
    FROM claimed ORDER BY claimed.created_at, claimed.id;
END
$$;
ALTER FUNCTION app.list_pending_export_jobs() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.list_pending_export_jobs() FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.list_pending_export_jobs() TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.finish_export_job(
  p_export_id uuid, p_owner_id uuid, p_scope_id uuid, p_principal_id uuid,
  p_expected_deletion_epoch bigint, p_artifact_key text, p_expires_at timestamptz, p_succeeded boolean
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  current_epoch bigint;
  authorized_count integer;
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('app.owner_id', p_owner_id::text, true);
  PERFORM pg_catalog.set_config('app.scope_ids', ARRAY[p_scope_id]::text, true);
  PERFORM pg_catalog.set_config('app.principal_id', p_principal_id::text, true);
  SELECT s.deletion_epoch INTO current_epoch FROM public.scopes s
    WHERE s.owner_id = p_owner_id AND s.id = p_scope_id FOR UPDATE;
  IF NOT FOUND OR current_epoch <> p_expected_deletion_epoch THEN RETURN false; END IF;
  IF p_succeeded THEN
    SELECT count(*) INTO authorized_count
      FROM app.lock_actor_access(p_owner_id, p_principal_id, 'owner', ARRAY[p_scope_id]::uuid[]) AS access
      WHERE access.scope_id = p_scope_id AND 'admin' = ANY(access.capabilities);
    IF authorized_count <> 1 OR p_artifact_key !~ '^[0-9a-f-]{36}\.bundle$' THEN RETURN false; END IF;
  END IF;
  UPDATE public.export_jobs SET state = CASE WHEN p_succeeded THEN 'ready' ELSE 'failed' END,
    artifact_key = CASE WHEN p_succeeded THEN p_artifact_key ELSE NULL END,
    expires_at = CASE WHEN p_succeeded THEN p_expires_at ELSE NULL END
    WHERE id = p_export_id AND owner_id = p_owner_id AND scope_id = p_scope_id
      AND principal_id = p_principal_id AND state IN ('accepted', 'processing')
      AND deletion_epoch = p_expected_deletion_epoch;
  RETURN FOUND;
END
$$;
ALTER FUNCTION app.finish_export_job(uuid, uuid, uuid, uuid, bigint, text, timestamptz, boolean)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.finish_export_job(uuid, uuid, uuid, uuid, bigint, text, timestamptz, boolean)
  FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.finish_export_job(uuid, uuid, uuid, uuid, bigint, text, timestamptz, boolean)
  TO thymesis_worker;

ALTER TABLE public.memory_versions ADD COLUMN origin_provenance jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(origin_provenance) = 'object');
ALTER TABLE public.memories ADD COLUMN import_provenance jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(import_provenance) = 'object');
