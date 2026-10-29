-- Every approved Gate connection of one person can act as a single non-user principal.
-- That connection principal holds no grants of its own: it reads them from the user principal
-- it acts for, so revoking or expiring the person's grant applies to every connection at once.
-- While a binding names no connection principal, connections keep acting as the binding's principal.
ALTER TABLE public.principals
  ADD COLUMN acts_for_principal_id uuid,
  ADD CONSTRAINT principals_acts_for_fkey
    FOREIGN KEY (user_id, acts_for_principal_id) REFERENCES public.principals(user_id, id),
  ADD CONSTRAINT principals_acts_for_check
    CHECK (acts_for_principal_id IS NULL OR (acts_for_principal_id <> id AND actor_kind <> 'user'));

ALTER TABLE public.external_identity_bindings
  ADD COLUMN connection_principal_id uuid,
  ADD CONSTRAINT external_identity_bindings_connection_principal_fkey
    FOREIGN KEY (user_id, connection_principal_id) REFERENCES public.principals(user_id, id),
  ADD CONSTRAINT external_identity_bindings_connection_principal_check
    CHECK (connection_principal_id IS NULL OR connection_principal_id <> principal_id);

CREATE OR REPLACE FUNCTION app.lock_actor_access(
  p_user_id uuid,
  p_principal_id uuid,
  p_actor_kind text,
  p_scope_ids uuid[]
)
RETURNS TABLE(scope_id uuid, auth_epoch bigint, capabilities text[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_grant_principal_id uuid;
BEGIN
  IF p_user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid
     OR NOT p_scope_ids <@ coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[] THEN
    RETURN;
  END IF;
  SELECT coalesce(p.acts_for_principal_id, p.id) INTO v_grant_principal_id
    FROM public.principals AS p
    WHERE p.user_id = p_user_id AND p.id = p_principal_id
      AND p.active AND p.actor_kind = p_actor_kind
    FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_grant_principal_id <> p_principal_id THEN
    PERFORM 1 FROM public.principals AS parent
      WHERE parent.user_id = p_user_id AND parent.id = v_grant_principal_id
        AND parent.active AND parent.actor_kind = 'user'
      FOR SHARE;
    IF NOT FOUND THEN RETURN; END IF;
  END IF;
  RETURN QUERY
    SELECT s.id, s.auth_epoch, g.capabilities
    FROM public.scopes AS s
    JOIN public.grants AS g ON g.user_id = s.user_id AND g.scope_id = s.id
    WHERE s.user_id = p_user_id AND g.principal_id = v_grant_principal_id
      AND s.id = ANY(p_scope_ids)
      AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
    ORDER BY s.id FOR SHARE OF s, g;
END
$$;

DROP FUNCTION app.lock_external_identity_binding(text, text);
CREATE FUNCTION app.lock_external_identity_binding(p_external_issuer text, p_external_subject text)
RETURNS TABLE(
  user_id uuid, principal_id uuid, actor_kind text, scope_ids uuid[], capability_ceiling text[],
  user_principal_id uuid
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  -- A named connection principal must be an active non-user principal acting for the binding's
  -- principal; otherwise no row is returned and the connection is refused.
  SELECT b.user_id, acting.id, acting.actor_kind, b.scope_ids, b.capability_ceiling, b.principal_id
  FROM public.external_identity_bindings b
  JOIN public.principals p ON p.user_id = b.user_id AND p.id = b.principal_id
  JOIN public.principals acting
    ON acting.user_id = b.user_id AND acting.id = coalesce(b.connection_principal_id, b.principal_id)
  WHERE b.external_issuer = p_external_issuer AND b.external_subject = p_external_subject
    AND b.active AND p.active AND acting.active
    AND (b.connection_principal_id IS NULL
      OR (acting.actor_kind <> 'user' AND acting.acts_for_principal_id = b.principal_id))
  FOR SHARE OF b, p, acting
$$;
ALTER FUNCTION app.lock_external_identity_binding(text, text) OWNER TO memory_auth_lookup;
REVOKE ALL ON FUNCTION app.lock_external_identity_binding(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_external_identity_binding(text, text) TO memory_app;
