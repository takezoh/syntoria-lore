ALTER TABLE public.grants
  ADD COLUMN expires_at timestamptz;

CREATE INDEX grants_expiring_idx
  ON public.grants(owner_id, scope_id, principal_id, expires_at)
  WHERE expires_at IS NOT NULL;

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
      AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
    ORDER BY s.id FOR SHARE OF s, g;
END
$$;

REVOKE UPDATE, DELETE ON TABLE public.memory_versions FROM thymesis_app;

CREATE OR REPLACE FUNCTION app.reject_memory_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'memory versions are append-only' USING ERRCODE = '55000';
END
$$;
