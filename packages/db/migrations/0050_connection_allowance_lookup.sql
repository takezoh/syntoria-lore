-- Authentication reads a connection's compartment allowance the way it reads the identity
-- binding: through a function owned by the lookup role, so the read does not depend on the
-- caller's tenant context. Commit revalidation runs in transactions that may have no context,
-- and a context-dependent read there would silently see no allowance (ADR 0006, unit U2).
GRANT SELECT ON public.compartments, public.connection_allowances TO memory_auth_lookup;
GRANT UPDATE (updated_at) ON public.connection_allowances TO memory_auth_lookup;

-- The allowance of one connection, limited to compartments that exist, held until commit.
-- No row means the connection has General only.
CREATE FUNCTION app.lock_connection_allowance(
  p_user_id uuid,
  p_external_issuer text,
  p_external_subject text,
  p_connection_id text
)
RETURNS TABLE(epoch bigint, compartment_ids uuid[])
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.epoch,
    ARRAY(
      SELECT c.id FROM public.compartments AS c
      WHERE c.user_id = a.user_id AND c.id = ANY(a.compartment_ids)
      ORDER BY c.id
    )
  FROM public.connection_allowances AS a
  WHERE a.user_id = p_user_id
    AND a.external_issuer = p_external_issuer
    AND a.external_subject = p_external_subject
    AND a.connection_id = p_connection_id
  FOR SHARE OF a
$$;

ALTER FUNCTION app.lock_connection_allowance(uuid, text, text, text) OWNER TO memory_auth_lookup;
REVOKE ALL ON FUNCTION app.lock_connection_allowance(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_connection_allowance(uuid, text, text, text) TO memory_app;
