CREATE OR REPLACE FUNCTION app.forgotten_source_artifacts(
  p_owner_id uuid,
  p_scope_id uuid,
  p_request_id uuid,
  p_principal_id uuid
)
RETURNS TABLE(source_ids uuid[], observation_ids uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login')
     OR p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
     OR p_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid THEN
    RAISE EXCEPTION 'purge actor context is invalid' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH target_memories AS (
    SELECT dt.target_id AS id FROM public.deletion_targets dt
    WHERE dt.owner_id = p_owner_id AND dt.scope_id = p_scope_id
      AND dt.deletion_request_id = p_request_id AND dt.target_kind = 'memory'
  ), target_sources AS (
    SELECT dt.target_id AS id FROM public.deletion_targets dt
    WHERE dt.owner_id = p_owner_id AND dt.scope_id = p_scope_id
      AND dt.deletion_request_id = p_request_id AND dt.target_kind = 'source'
  ), target_evidence AS (
    SELECT DISTINCT e.id, e.source_id, e.source_revision, e.locator, e.observation_id
    FROM public.evidence e
    WHERE e.owner_id = p_owner_id AND e.scope_id = p_scope_id AND (
      e.source_id IN (SELECT id FROM target_sources)
      OR EXISTS (SELECT 1 FROM public.memory_evidence me
        WHERE me.owner_id = e.owner_id AND me.scope_id = e.scope_id
          AND me.evidence_id = e.id AND me.memory_id IN (SELECT id FROM target_memories))
      OR EXISTS (SELECT 1 FROM public.memory_version_evidence mve
        WHERE mve.owner_id = e.owner_id AND mve.scope_id = e.scope_id
          AND mve.evidence_id = e.id AND mve.memory_id IN (SELECT id FROM target_memories))
    )
  ), affected_sources AS (
    SELECT id FROM target_sources
    UNION SELECT source_id FROM target_evidence
  ), affected_observations AS (
    SELECT DISTINCT o.id FROM public.observations o
    WHERE o.owner_id = p_owner_id AND o.scope_id = p_scope_id AND (
      o.source_id IN (SELECT id FROM target_sources)
      OR EXISTS (SELECT 1 FROM target_evidence te WHERE
        (te.observation_id = o.id OR
          (te.source_id = o.source_id AND te.source_revision = o.source_revision AND te.locator = o.locator))
      )
    )
  )
  SELECT
    coalesce((SELECT array_agg(DISTINCT id ORDER BY id) FROM affected_sources), ARRAY[]::uuid[]),
    coalesce((SELECT array_agg(DISTINCT id ORDER BY id) FROM affected_observations), ARRAY[]::uuid[]);
END
$$;
ALTER FUNCTION app.forgotten_source_artifacts(uuid, uuid, uuid, uuid)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.forgotten_source_artifacts(uuid, uuid, uuid, uuid)
  FROM PUBLIC, thymesis_app, thymesis_worker;

CREATE OR REPLACE FUNCTION app.purge_orphaned_forgotten_sources(
  p_owner_id uuid,
  p_scope_id uuid,
  p_request_id uuid,
  p_principal_id uuid,
  p_actor_kind text,
  p_source_ids uuid[],
  p_observation_ids uuid[],
  p_require_current_admin boolean
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  authorized_count integer;
  removed_count integer := 0;
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login')
     OR p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
     OR p_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid
     OR p_actor_kind <> 'owner' THEN
    RAISE EXCEPTION 'purge actor context is invalid' USING ERRCODE = '42501';
  END IF;
  IF p_require_current_admin THEN
    SELECT count(*) INTO authorized_count
    FROM app.lock_actor_access(p_owner_id, p_principal_id, p_actor_kind, ARRAY[p_scope_id]::uuid[]) AS access
    WHERE access.scope_id = p_scope_id AND 'admin' = ANY(access.capabilities);
    IF authorized_count <> 1 THEN
      RAISE EXCEPTION 'current owner admin grant is required for purge' USING ERRCODE = '42501';
    END IF;
  ELSIF session_user <> 'thymesis_worker_login'
        OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'verified worker login is required for replay purge' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.deletion_requests dr
    WHERE dr.owner_id = p_owner_id AND dr.scope_id = p_scope_id AND dr.id = p_request_id
      AND coalesce(dr.principal_id, nullif(dr.selector->>'original_principal_id', '')::uuid) = p_principal_id
      AND dr.ledger_sequence IS NOT NULL AND dr.ledger_entry_hash IS NOT NULL
      AND dr.ledger_head_generation IS NOT NULL AND dr.status = 'complete') THEN
    RAISE EXCEPTION 'completed deletion receipt is required for artifact cleanup' USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.observations o
  WHERE o.owner_id = p_owner_id AND o.scope_id = p_scope_id
    AND o.id = ANY(coalesce(p_observation_ids, ARRAY[]::uuid[]));
  DELETE FROM public.sources s
  WHERE s.owner_id = p_owner_id AND s.scope_id = p_scope_id
    AND s.id = ANY(coalesce(p_source_ids, ARRAY[]::uuid[]))
    AND NOT EXISTS (SELECT 1 FROM public.evidence e
      WHERE e.owner_id = s.owner_id AND e.scope_id = s.scope_id AND e.source_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM public.observations o
      WHERE o.owner_id = s.owner_id AND o.scope_id = s.scope_id AND o.source_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM public.episodes ep
      WHERE ep.owner_id = s.owner_id AND ep.scope_id = s.scope_id AND ep.source_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM public.capture_jobs cj
      WHERE cj.owner_id = s.owner_id AND cj.scope_id = s.scope_id AND cj.source_id = s.id);
  GET DIAGNOSTICS removed_count = ROW_COUNT;
  RETURN removed_count;
END
$$;
ALTER FUNCTION app.purge_orphaned_forgotten_sources(uuid, uuid, uuid, uuid, text, uuid[], uuid[], boolean)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.purge_orphaned_forgotten_sources(uuid, uuid, uuid, uuid, text, uuid[], uuid[], boolean)
  FROM PUBLIC, thymesis_app, thymesis_worker;

CREATE OR REPLACE FUNCTION app.purge_forgotten_request(
  p_owner_id uuid, p_scope_id uuid, p_request_id uuid, p_principal_id uuid, p_actor_kind text
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  authorized_count integer;
  artifacts record;
  removed integer;
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login')
     OR p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
     OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
     OR p_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid
     OR p_actor_kind <> 'owner' THEN
    RAISE EXCEPTION 'purge actor context is invalid' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO authorized_count
  FROM app.lock_actor_access(p_owner_id, p_principal_id, p_actor_kind, ARRAY[p_scope_id]::uuid[]) AS access
  WHERE access.scope_id = p_scope_id AND 'admin' = ANY(access.capabilities);
  IF authorized_count <> 1 THEN
    RAISE EXCEPTION 'current owner admin grant is required for purge' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO artifacts
  FROM app.forgotten_source_artifacts(p_owner_id, p_scope_id, p_request_id, p_principal_id);
  PERFORM app.delete_forgotten_memory_versions(
    p_owner_id, p_scope_id, p_request_id, p_principal_id, p_actor_kind, true);
  removed := app.purge_forgotten_request_impl(p_owner_id, p_scope_id, p_request_id,
    p_principal_id, p_actor_kind, true);
  PERFORM app.purge_orphaned_forgotten_sources(p_owner_id, p_scope_id, p_request_id,
    p_principal_id, p_actor_kind, artifacts.source_ids, artifacts.observation_ids, true);
  RETURN removed;
END
$$;
ALTER FUNCTION app.purge_forgotten_request(uuid, uuid, uuid, uuid, text)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.purge_forgotten_request(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_forgotten_request(uuid, uuid, uuid, uuid, text)
  TO thymesis_app, thymesis_worker;

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
  removed := app.purge_forgotten_request_impl(p_owner_id, p_scope_id, p_request_id,
    p_principal_id, 'owner', false);
  PERFORM app.purge_orphaned_forgotten_sources(p_owner_id, p_scope_id, p_request_id,
    p_principal_id, 'owner', artifacts.source_ids, artifacts.observation_ids, false);
  RETURN removed;
END
$$;
ALTER FUNCTION app.purge_replayed_forgotten_request(uuid, uuid, uuid, uuid, bigint, text, text)
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.purge_replayed_forgotten_request(uuid, uuid, uuid, uuid, bigint, text, text)
  FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.purge_replayed_forgotten_request(uuid, uuid, uuid, uuid, bigint, text, text)
  TO thymesis_worker;
