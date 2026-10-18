DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'thymesis_auth_lookup') THEN
    CREATE ROLE thymesis_auth_lookup NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT SELECT ON principals, scopes, grants TO thymesis_auth_lookup;
GRANT UPDATE (id) ON principals, scopes TO thymesis_auth_lookup;
GRANT UPDATE (created_at) ON grants TO thymesis_auth_lookup;

ALTER FUNCTION app.resolve_principal(text, text) OWNER TO thymesis_auth_lookup;

CREATE OR REPLACE FUNCTION app.lock_actor_access(
  p_owner_id uuid,
  p_principal_id uuid,
  p_actor_kind text,
  p_scope_ids uuid[]
)
RETURNS TABLE(scope_id uuid, auth_epoch bigint, capabilities text[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR NOT p_scope_ids <@ coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[] THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public.principals AS p
    WHERE p.owner_id = p_owner_id AND p.id = p_principal_id
      AND p.active AND p.actor_kind = p_actor_kind
    FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
    SELECT s.id, s.auth_epoch, g.capabilities
    FROM public.scopes AS s
    JOIN public.grants AS g ON g.owner_id = s.owner_id AND g.scope_id = s.id
    WHERE s.owner_id = p_owner_id AND g.principal_id = p_principal_id
      AND s.id = ANY(p_scope_ids)
    ORDER BY s.id FOR SHARE OF s, g;
END
$$;

ALTER FUNCTION app.lock_actor_access(uuid, uuid, text, uuid[]) OWNER TO thymesis_auth_lookup;
REVOKE ALL ON FUNCTION app.lock_actor_access(uuid, uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_actor_access(uuid, uuid, text, uuid[]) TO thymesis_app;
