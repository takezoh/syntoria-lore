ALTER TABLE public.export_jobs ADD COLUMN claim_token uuid;

DROP FUNCTION app.list_pending_export_jobs();
CREATE FUNCTION app.list_pending_export_jobs()
RETURNS TABLE(
  export_id uuid, owner_id uuid, scope_id uuid, principal_id uuid,
  deletion_epoch bigint, claim_token uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY WITH candidates AS (
    SELECT ej.id FROM public.export_jobs ej
    WHERE ej.state = 'accepted'
       OR (ej.state = 'processing' AND
         (ej.claimed_until IS NULL OR ej.claimed_until <= clock_timestamp()))
    ORDER BY ej.created_at, ej.id FOR UPDATE SKIP LOCKED LIMIT 100
  ), claimed AS (
    UPDATE public.export_jobs ej SET state = 'processing',
      claim_token = gen_random_uuid(), claimed_until = clock_timestamp() + interval '5 minutes'
    FROM candidates c WHERE ej.id = c.id
    RETURNING ej.id, ej.owner_id, ej.scope_id, ej.principal_id,
      ej.deletion_epoch, ej.claim_token, ej.created_at
  ) SELECT claimed.id, claimed.owner_id, claimed.scope_id, claimed.principal_id,
      claimed.deletion_epoch, claimed.claim_token FROM claimed ORDER BY claimed.created_at, claimed.id;
END
$$;
ALTER FUNCTION app.list_pending_export_jobs() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.list_pending_export_jobs() FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.list_pending_export_jobs() TO thymesis_worker;

DROP FUNCTION app.finish_export_job(uuid, uuid, uuid, uuid, bigint, text, timestamptz, boolean);
CREATE FUNCTION app.finish_export_job(
  p_export_id uuid, p_owner_id uuid, p_scope_id uuid, p_principal_id uuid,
  p_expected_deletion_epoch bigint, p_artifact_key text, p_expires_at timestamptz,
  p_succeeded boolean, p_claim_token uuid
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
  IF p_claim_token IS NULL THEN RETURN false; END IF;
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
    IF authorized_count <> 1 OR
       p_artifact_key !~ ('^' || p_export_id::text || '\.[0-9a-f-]{36}\.bundle$') THEN
      RETURN false;
    END IF;
  END IF;
  UPDATE public.export_jobs SET state = CASE WHEN p_succeeded THEN 'ready' ELSE 'failed' END,
    artifact_key = CASE WHEN p_succeeded THEN p_artifact_key ELSE NULL END,
    expires_at = CASE WHEN p_succeeded THEN p_expires_at ELSE NULL END,
    claimed_until = NULL, claim_token = NULL
    WHERE id = p_export_id AND owner_id = p_owner_id AND scope_id = p_scope_id
      AND principal_id = p_principal_id AND state = 'processing'
      AND deletion_epoch = p_expected_deletion_epoch
      AND claim_token = p_claim_token AND claimed_until > clock_timestamp();
  RETURN FOUND;
END
$$;
ALTER FUNCTION app.finish_export_job(uuid, uuid, uuid, uuid, bigint, text, timestamptz, boolean, uuid)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.finish_export_job(uuid, uuid, uuid, uuid, bigint, text, timestamptz, boolean, uuid)
  FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.finish_export_job(uuid, uuid, uuid, uuid, bigint, text, timestamptz, boolean, uuid)
  TO thymesis_worker;

ALTER TABLE public.governance_file_deletions
  DROP CONSTRAINT governance_file_deletions_artifact_key_check,
  ADD CONSTRAINT governance_file_deletions_artifact_key_check
    CHECK (artifact_key ~ '^[0-9a-f-]{36}(\.[0-9a-f-]{36})?\.bundle$');

CREATE OR REPLACE FUNCTION app.expire_export_jobs()
RETURNS TABLE(artifact_key text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY UPDATE public.export_jobs ej
    SET state = 'expired', artifact_key = NULL, claimed_until = NULL, claim_token = NULL,
        expires_at = coalesce(ej.expires_at, clock_timestamp())
    WHERE ej.state IN ('accepted', 'processing', 'ready')
      AND (ej.expires_at <= clock_timestamp() OR NOT EXISTS (
        SELECT 1 FROM public.scopes s WHERE s.owner_id = ej.owner_id
          AND s.id = ej.scope_id AND s.deletion_epoch = ej.deletion_epoch))
    RETURNING ej.artifact_key;
END
$$;
ALTER FUNCTION app.expire_export_jobs() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.expire_export_jobs() FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.expire_export_jobs() TO thymesis_worker;
