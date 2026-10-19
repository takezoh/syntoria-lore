CREATE TABLE public.external_identity_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_issuer text NOT NULL CHECK (length(external_issuer) BETWEEN 1 AND 2048),
  external_subject text NOT NULL CHECK (length(external_subject) BETWEEN 1 AND 512),
  external_client_id text NOT NULL CHECK (length(external_client_id) BETWEEN 1 AND 256),
  user_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  scope_ids uuid[] NOT NULL CHECK (
    cardinality(scope_ids) BETWEEN 1 AND 100 AND array_position(scope_ids, NULL) IS NULL
  ),
  capability_ceiling text[] NOT NULL CHECK (
    cardinality(capability_ceiling) BETWEEN 1 AND 3 AND
    capability_ceiling <@ ARRAY['read', 'write', 'admin']::text[]
  ),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (external_issuer, external_subject, external_client_id),
  FOREIGN KEY (user_id, principal_id) REFERENCES public.principals(user_id, id)
);

CREATE INDEX external_identity_bindings_principal_idx
  ON public.external_identity_bindings(user_id, principal_id);

ALTER TABLE public.external_identity_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_identity_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY external_identity_bindings_user_policy
  ON public.external_identity_bindings
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

REVOKE ALL ON public.external_identity_bindings FROM PUBLIC;
REVOKE ALL ON public.external_identity_bindings FROM memory_app;
GRANT SELECT ON public.external_identity_bindings TO memory_auth_lookup;
GRANT UPDATE (updated_at) ON public.external_identity_bindings TO memory_auth_lookup;

CREATE FUNCTION app.lock_external_identity_binding(
  p_external_issuer text,
  p_external_subject text,
  p_external_client_id text
)
RETURNS TABLE(
  user_id uuid,
  principal_id uuid,
  actor_kind text,
  scope_ids uuid[],
  capability_ceiling text[]
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.user_id, b.principal_id, p.actor_kind, b.scope_ids, b.capability_ceiling
  FROM public.external_identity_bindings AS b
  JOIN public.principals AS p
    ON p.user_id = b.user_id AND p.id = b.principal_id
  WHERE b.external_issuer = p_external_issuer
    AND b.external_subject = p_external_subject
    AND b.external_client_id = p_external_client_id
    AND b.active
    AND p.active
  FOR SHARE OF b, p
$$;

ALTER FUNCTION app.lock_external_identity_binding(text, text, text)
  OWNER TO memory_auth_lookup;
REVOKE ALL ON FUNCTION app.lock_external_identity_binding(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_external_identity_binding(text, text, text)
  TO memory_app;
