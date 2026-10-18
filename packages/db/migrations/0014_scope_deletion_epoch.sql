CREATE OR REPLACE FUNCTION app.advance_scope_deletion_epoch(
  p_owner_id uuid, p_scope_id uuid, p_actor_principal_id uuid, p_actor_kind text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  authorized_count integer;
BEGIN
  IF session_user <> 'thymesis_app'
     OR p_actor_kind <> 'owner'
     OR p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR p_actor_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid
     OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]) THEN
    RAISE EXCEPTION 'owner scope context required' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO authorized_count
  FROM app.lock_actor_access(p_owner_id, p_actor_principal_id, p_actor_kind, ARRAY[p_scope_id]::uuid[]) AS access
  WHERE access.scope_id = p_scope_id AND 'admin' = ANY(access.capabilities);
  IF authorized_count <> 1 THEN
    RAISE EXCEPTION 'current owner admin grant is required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.scopes SET auth_epoch = auth_epoch + 1, deletion_epoch = deletion_epoch + 1
    WHERE owner_id = p_owner_id AND id = p_scope_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope not found' USING ERRCODE = 'P0002'; END IF;
END
$$;
ALTER FUNCTION app.advance_scope_deletion_epoch(uuid, uuid, uuid, text) OWNER TO thymesis_authority_executor;
REVOKE ALL ON FUNCTION app.advance_scope_deletion_epoch(uuid, uuid, uuid, text) FROM PUBLIC, thymesis_worker;
GRANT EXECUTE ON FUNCTION app.advance_scope_deletion_epoch(uuid, uuid, uuid, text) TO thymesis_app;
