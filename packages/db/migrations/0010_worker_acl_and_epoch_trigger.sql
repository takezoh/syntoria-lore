CREATE OR REPLACE FUNCTION app.bump_scope_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_owner uuid;
  affected_scope uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_owner := OLD.owner_id;
    affected_scope := OLD.scope_id;
  ELSE
    affected_owner := NEW.owner_id;
    affected_scope := NEW.scope_id;
  END IF;
  UPDATE public.scopes SET auth_epoch = auth_epoch + 1
  WHERE owner_id = affected_owner AND id = affected_scope;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.bump_scope_epoch() FROM PUBLIC, thymesis_app, thymesis_worker;

REVOKE INSERT, UPDATE, DELETE ON owners, principals, scopes, grants FROM thymesis_worker;
REVOKE UPDATE, DELETE ON memory_versions, observations, sources FROM thymesis_worker;
REVOKE INSERT, UPDATE, DELETE ON connector_authorizations, owner_confirmations FROM thymesis_worker;
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM thymesis_worker;
