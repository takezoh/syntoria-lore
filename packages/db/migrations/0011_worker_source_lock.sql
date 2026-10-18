CREATE OR REPLACE FUNCTION app.lock_source_for_share(p_source_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  locked_id uuid;
BEGIN
  SELECT s.id INTO locked_id
  FROM public.sources AS s
  WHERE s.owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND s.scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
    AND s.id = p_source_id
  FOR SHARE;
  RETURN locked_id IS NOT NULL;
END
$$;

REVOKE ALL ON FUNCTION app.lock_source_for_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_source_for_share(uuid) TO thymesis_app, thymesis_worker;
