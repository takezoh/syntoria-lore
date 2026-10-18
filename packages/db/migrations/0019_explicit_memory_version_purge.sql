CREATE OR REPLACE FUNCTION app.delete_forgotten_memory_versions(
  p_owner_id uuid, p_scope_id uuid, p_request_id uuid, p_principal_id uuid,
  p_actor_kind text, p_require_current_admin boolean
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  authorized_count integer;
  target_memory_ids uuid[];
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login')
     OR p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
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
  IF NOT EXISTS (SELECT 1 FROM public.deletion_requests dr
    WHERE dr.owner_id = p_owner_id AND dr.scope_id = p_scope_id AND dr.id = p_request_id
      AND coalesce(dr.principal_id, nullif(dr.selector->>'original_principal_id', '')::uuid) = p_principal_id
      AND dr.ledger_sequence IS NOT NULL AND dr.ledger_entry_hash IS NOT NULL
      AND dr.ledger_head_generation IS NOT NULL AND dr.status IN ('ledger_acked', 'purging')) THEN
    RAISE EXCEPTION 'deletion request has no durable ledger receipt' USING ERRCODE = '55000';
  END IF;
  SELECT coalesce(array_agg(dt.target_id), ARRAY[]::uuid[]) INTO target_memory_ids
  FROM public.deletion_targets dt
  WHERE dt.owner_id = p_owner_id AND dt.scope_id = p_scope_id
    AND dt.deletion_request_id = p_request_id AND dt.target_kind = 'memory';
  DELETE FROM public.memory_versions mv
  WHERE mv.owner_id = p_owner_id AND mv.scope_id = p_scope_id
    AND mv.memory_id = ANY(target_memory_ids);
END
$$;
ALTER FUNCTION app.delete_forgotten_memory_versions(uuid, uuid, uuid, uuid, text, boolean)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.delete_forgotten_memory_versions(uuid, uuid, uuid, uuid, text, boolean)
  FROM PUBLIC, thymesis_app, thymesis_worker;
GRANT EXECUTE ON FUNCTION app.delete_forgotten_memory_versions(uuid, uuid, uuid, uuid, text, boolean)
  TO thymesis_purge_executor;

CREATE OR REPLACE FUNCTION app.purge_forgotten_request(
  p_owner_id uuid, p_scope_id uuid, p_request_id uuid, p_principal_id uuid, p_actor_kind text
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  PERFORM app.delete_forgotten_memory_versions(
    p_owner_id, p_scope_id, p_request_id, p_principal_id, p_actor_kind, true);
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
  PERFORM app.delete_forgotten_memory_versions(
    p_owner_id, p_scope_id, p_request_id, p_principal_id, 'owner', false);
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
