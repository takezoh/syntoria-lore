-- A Gate connection always acts for the person as a non-user principal, so what an AI does is
-- never recorded as the person. Whether a protected change it requests is applied at once or
-- waits for the person's approval at Gate is a separate per-binding approval policy:
-- 'auto' applies it and records that the policy approved it, 'gate' asks the person each time.
ALTER TABLE public.external_identity_bindings
  ADD COLUMN approval_policy text NOT NULL DEFAULT 'auto'
    CONSTRAINT external_identity_bindings_approval_policy_check
    CHECK (approval_policy IN ('auto', 'gate'));

-- Bindings of a user principal that still let connections act as the person receive their
-- connection principal, reusing one an earlier disable left behind when it still acts for them.
ALTER TABLE public.principals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.external_identity_bindings NO FORCE ROW LEVEL SECURITY;

INSERT INTO public.principals (user_id, issuer, subject, actor_kind, acts_for_principal_id)
SELECT b.user_id, 'urn:syntoria:lore:connection', 'binding:' || b.id::text, 'client', b.principal_id
FROM public.external_identity_bindings AS b
JOIN public.principals AS p ON p.user_id = b.user_id AND p.id = b.principal_id
WHERE b.connection_principal_id IS NULL AND p.actor_kind = 'user'
ON CONFLICT (issuer, subject) DO NOTHING;

UPDATE public.external_identity_bindings AS b
   SET connection_principal_id = c.id, updated_at = clock_timestamp()
  FROM public.principals AS p, public.principals AS c
 WHERE b.connection_principal_id IS NULL
   AND p.user_id = b.user_id AND p.id = b.principal_id AND p.actor_kind = 'user'
   AND c.user_id = b.user_id AND c.issuer = 'urn:syntoria:lore:connection'
   AND c.subject = 'binding:' || b.id::text
   AND c.actor_kind = 'client' AND c.active AND c.acts_for_principal_id = b.principal_id;

ALTER TABLE public.principals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.external_identity_bindings FORCE ROW LEVEL SECURITY;

-- A binding resolves only to a non-user acting principal. One left with a user principal and no
-- usable connection principal is refused instead of acting as the person.
DROP FUNCTION app.lock_external_identity_binding(text, text);
CREATE FUNCTION app.lock_external_identity_binding(p_external_issuer text, p_external_subject text)
RETURNS TABLE(
  user_id uuid, principal_id uuid, actor_kind text, scope_ids uuid[], capability_ceiling text[],
  user_principal_id uuid, approval_policy text
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT b.user_id, acting.id, acting.actor_kind, b.scope_ids, b.capability_ceiling, b.principal_id,
         b.approval_policy
  FROM public.external_identity_bindings b
  JOIN public.principals p ON p.user_id = b.user_id AND p.id = b.principal_id
  JOIN public.principals acting
    ON acting.user_id = b.user_id AND acting.id = coalesce(b.connection_principal_id, b.principal_id)
  WHERE b.external_issuer = p_external_issuer AND b.external_subject = p_external_subject
    AND b.active AND p.active AND acting.active AND acting.actor_kind <> 'user'
    AND (b.connection_principal_id IS NULL OR acting.acts_for_principal_id = b.principal_id)
  FOR SHARE OF b, p, acting
$$;
ALTER FUNCTION app.lock_external_identity_binding(text, text) OWNER TO memory_auth_lookup;
REVOKE ALL ON FUNCTION app.lock_external_identity_binding(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_external_identity_binding(text, text) TO memory_app;

-- A protected change approved by the binding's policy is recorded beside those the person approved
-- at Gate. It has no Gate confirmation and is never pending.
ALTER TABLE public.change_confirmations
  ADD COLUMN approval text NOT NULL DEFAULT 'person'
    CONSTRAINT change_confirmations_approval_check CHECK (approval IN ('person', 'policy')),
  ALTER COLUMN gate_confirmation_id DROP NOT NULL,
  ALTER COLUMN gate_url DROP NOT NULL,
  ADD CONSTRAINT change_confirmations_gate_check
    CHECK ((approval = 'person') = (gate_confirmation_id IS NOT NULL AND gate_url IS NOT NULL)),
  ADD CONSTRAINT change_confirmations_policy_status_check
    CHECK (approval = 'person' OR status <> 'pending');
