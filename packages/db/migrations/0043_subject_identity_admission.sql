-- A Gate-approved connection is admitted by immutable subject, independently of
-- its dynamically registered client. Never merge differing effective authority.
LOCK TABLE public.external_identity_bindings IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.external_identity_bindings a
    JOIN public.external_identity_bindings b
      ON a.external_issuer = b.external_issuer
     AND a.external_subject = b.external_subject AND a.id <> b.id
    WHERE a.active AND b.active AND (
      a.user_id <> b.user_id OR a.principal_id <> b.principal_id OR
      NOT (a.scope_ids @> b.scope_ids AND a.scope_ids <@ b.scope_ids) OR
      NOT (a.capability_ceiling @> b.capability_ceiling AND a.capability_ceiling <@ b.capability_ceiling)
    )
  ) THEN
    RAISE EXCEPTION 'Conflicting active subject authority; explicit operator resolution required';
  END IF;
END $$;
-- Keep an active admission when one exists. Inactive-only subjects stay inactive;
-- no inactive policy contributes permissions to the retained admission.
DELETE FROM public.external_identity_bindings b
USING (
  SELECT id, row_number() OVER (
    PARTITION BY external_issuer, external_subject
    ORDER BY active DESC, created_at, id
  ) AS ordinal FROM public.external_identity_bindings
) ranked
WHERE b.id = ranked.id AND ranked.ordinal > 1;
DROP FUNCTION app.lock_external_identity_binding(text, text, text);
ALTER TABLE public.external_identity_bindings DROP COLUMN external_client_id;
ALTER TABLE public.external_identity_bindings
  ADD UNIQUE (external_issuer, external_subject);
CREATE FUNCTION app.lock_external_identity_binding(p_external_issuer text, p_external_subject text)
RETURNS TABLE(user_id uuid, principal_id uuid, actor_kind text, scope_ids uuid[], capability_ceiling text[])
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.user_id, b.principal_id, p.actor_kind, b.scope_ids, b.capability_ceiling
  FROM public.external_identity_bindings b
  JOIN public.principals p ON p.user_id = b.user_id AND p.id = b.principal_id
  WHERE b.external_issuer = p_external_issuer AND b.external_subject = p_external_subject
    AND b.active AND p.active
  FOR SHARE OF b, p
$$;
ALTER FUNCTION app.lock_external_identity_binding(text, text) OWNER TO memory_auth_lookup;
REVOKE ALL ON FUNCTION app.lock_external_identity_binding(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_external_identity_binding(text, text) TO memory_app;
