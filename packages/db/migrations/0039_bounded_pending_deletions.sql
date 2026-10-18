CREATE OR REPLACE FUNCTION app.list_pending_deletions(p_limit integer)
RETURNS TABLE(
  owner_id uuid, scope_id uuid, request_id uuid, principal_id uuid, blocked_at timestamptz,
  memory_ids uuid[], source_ids uuid[], subject_ids uuid[], source_locator_hmacs text[], status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'pending deletion limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT dr.owner_id, dr.scope_id, dr.id, dr.principal_id, dr.selector, dr.created_at,
      dr.ledger_next_attempt_at, dr.status
    FROM public.deletion_requests dr
    WHERE dr.status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging')
      AND (dr.ledger_next_attempt_at IS NULL OR dr.ledger_next_attempt_at <= statement_timestamp())
    ORDER BY dr.ledger_next_attempt_at NULLS FIRST, dr.created_at, dr.id
    LIMIT p_limit
  )
  SELECT dr.owner_id, dr.scope_id, dr.id,
    coalesce(dr.principal_id, nullif(dr.selector->>'original_principal_id', '')::uuid), dr.created_at,
    coalesce(array_agg(DISTINCT dt.target_id) FILTER (WHERE dt.target_kind = 'memory'), ARRAY[]::uuid[]),
    coalesce(array_agg(DISTINCT dt.target_id) FILTER (WHERE dt.target_kind = 'source'), ARRAY[]::uuid[]),
    coalesce(array_agg(DISTINCT dt.target_id) FILTER (WHERE dt.target_kind = 'subject'), ARRAY[]::uuid[]),
    coalesce(array_agg(DISTINCT sp.locator_hmac) FILTER (
      WHERE sp.object_kind = 'locator_hmac' AND sp.locator_hmac IS NOT NULL
    ), ARRAY[]::text[]),
    dr.status
  FROM candidates dr
  LEFT JOIN public.deletion_targets dt ON dt.owner_id = dr.owner_id AND dt.scope_id = dr.scope_id
    AND dt.deletion_request_id = dr.id
  LEFT JOIN public.suppressions sp ON sp.owner_id = dr.owner_id AND sp.scope_id = dr.scope_id
    AND sp.deletion_request_id = dr.id
  GROUP BY dr.owner_id, dr.scope_id, dr.id, dr.principal_id, dr.selector, dr.created_at,
    dr.ledger_next_attempt_at, dr.status
  ORDER BY dr.ledger_next_attempt_at NULLS FIRST, dr.created_at, dr.id;
END
$$;
ALTER FUNCTION app.list_pending_deletions(integer) OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.list_pending_deletions(integer) FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.list_pending_deletions(integer) TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.list_pending_deletions()
RETURNS TABLE(
  owner_id uuid, scope_id uuid, request_id uuid, principal_id uuid, blocked_at timestamptz,
  memory_ids uuid[], source_ids uuid[], subject_ids uuid[], source_locator_hmacs text[], status text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM app.list_pending_deletions(100)
$$;
ALTER FUNCTION app.list_pending_deletions() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.list_pending_deletions() FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.list_pending_deletions() TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.has_pending_deletions()
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.deletion_requests dr
    WHERE dr.status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging')
  );
END
$$;
ALTER FUNCTION app.has_pending_deletions() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.has_pending_deletions() FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.has_pending_deletions() TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.defer_pending_deletion(p_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  changed integer;
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.deletion_requests dr
  SET ledger_retry_count = dr.ledger_retry_count + 1,
      ledger_next_attempt_at = clock_timestamp() + make_interval(secs =>
        LEAST(3600, (30 * power(2::numeric, LEAST(dr.ledger_retry_count, 7)))::integer))
  WHERE dr.id = p_request_id
    AND dr.status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$$;
ALTER FUNCTION app.defer_pending_deletion(uuid) OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.defer_pending_deletion(uuid) FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.defer_pending_deletion(uuid) TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.purge_replayed_forgotten_request(
  p_owner_id uuid, p_scope_id uuid, p_request_id uuid, p_principal_id uuid,
  p_sequence bigint, p_entry_hash text, p_head_generation text
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  stored public.deletion_requests%ROWTYPE;
  artifacts record;
  removed integer;
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member')
     OR p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
     OR p_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid THEN
    RAISE EXCEPTION 'verified worker actor context required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO stored FROM public.deletion_requests dr
    WHERE dr.owner_id = p_owner_id AND dr.scope_id = p_scope_id AND dr.id = p_request_id
      AND coalesce(dr.principal_id, nullif(dr.selector->>'original_principal_id', '')::uuid) = p_principal_id
      AND dr.ledger_sequence = p_sequence AND dr.ledger_entry_hash = p_entry_hash
      AND dr.ledger_head_generation = p_head_generation
      AND dr.status IN ('ledger_acked', 'purging') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deletion receipt does not match the durable replay record' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO artifacts
  FROM app.forgotten_source_artifacts(p_owner_id, p_scope_id, p_request_id, p_principal_id);
  PERFORM app.delete_forgotten_memory_versions(
    p_owner_id, p_scope_id, p_request_id, p_principal_id, 'owner', false);
  removed := app.purge_forgotten_request_impl(
    p_owner_id, p_scope_id, p_request_id, p_principal_id, 'owner', false);
  IF EXISTS (SELECT 1 FROM public.deletion_requests dr
    WHERE dr.owner_id = p_owner_id AND dr.scope_id = p_scope_id AND dr.id = p_request_id
      AND dr.status = 'complete') THEN
    PERFORM app.purge_orphaned_forgotten_sources(p_owner_id, p_scope_id, p_request_id,
      p_principal_id, 'owner', artifacts.source_ids, artifacts.observation_ids, false);
  END IF;
  RETURN removed;
END
$$;
ALTER FUNCTION app.purge_replayed_forgotten_request(uuid, uuid, uuid, uuid, bigint, text, text)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.purge_replayed_forgotten_request(uuid, uuid, uuid, uuid, bigint, text, text)
  FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.purge_replayed_forgotten_request(uuid, uuid, uuid, uuid, bigint, text, text)
  TO thymesis_worker;
