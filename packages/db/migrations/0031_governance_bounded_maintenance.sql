GRANT SELECT ON public.owners, public.scopes, public.principals, public.grants,
  public.memories, public.sources, public.observations, public.episodes,
  public.evidence, public.memory_evidence, public.memory_version_evidence,
  public.suppressions, public.deletion_targets, public.scope_retention_policies
  TO thymesis_purge_executor;
GRANT INSERT ON public.deletion_requests, public.deletion_targets,
  public.suppressions, public.audit_events TO thymesis_purge_executor;

CREATE OR REPLACE FUNCTION app.list_due_retention_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE(
  owner_id uuid,
  scope_id uuid,
  principal_id uuid,
  target_kind text,
  target_id uuid,
  source_kind text,
  external_id text,
  revision text,
  locators text[],
  source_material jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'retention candidate limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH memory_candidates AS (
    SELECT p.owner_id, p.scope_id, p.updated_by AS principal_id,
      'memory'::text AS target_kind, m.id AS target_id,
      NULL::text AS source_kind, NULL::text AS external_id, NULL::text AS revision,
      ARRAY[]::text[] AS locators,
      coalesce((
        SELECT jsonb_agg(DISTINCT jsonb_build_object(
          'kind', s.kind, 'external_id', s.external_id, 'revision', s.revision, 'locator', related.locator
        ))
        FROM (
          SELECT e.source_id, e.locator
          FROM public.memory_evidence me
          JOIN public.evidence e ON e.owner_id=me.owner_id AND e.scope_id=me.scope_id AND e.id=me.evidence_id
          WHERE me.owner_id=m.owner_id AND me.scope_id=m.scope_id AND me.memory_id=m.id
          UNION
          SELECT e.source_id, e.locator
          FROM public.memory_version_evidence me
          JOIN public.evidence e ON e.owner_id=me.owner_id AND e.scope_id=me.scope_id AND e.id=me.evidence_id
          WHERE me.owner_id=m.owner_id AND me.scope_id=m.scope_id AND me.memory_id=m.id
        ) related
        JOIN public.sources s ON s.owner_id=m.owner_id AND s.scope_id=m.scope_id AND s.id=related.source_id
      ), '[]'::jsonb) AS source_material,
      m.recorded_at AS due_at
    FROM public.scope_retention_policies p
    JOIN public.memories m ON m.owner_id=p.owner_id AND m.scope_id=p.scope_id
    WHERE p.memory_days IS NOT NULL
      AND m.recorded_at <= clock_timestamp() - make_interval(days => p.memory_days)
      AND NOT EXISTS (SELECT 1 FROM public.suppressions sp WHERE sp.owner_id=m.owner_id
        AND sp.scope_id=m.scope_id AND sp.object_kind='memory' AND sp.object_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM public.deletion_targets dt
        WHERE dt.owner_id=m.owner_id AND dt.scope_id=m.scope_id
          AND dt.target_kind='memory' AND dt.target_id=m.id)
  ), source_candidates AS (
    SELECT p.owner_id, p.scope_id, p.updated_by AS principal_id,
      'source'::text AS target_kind, s.id AS target_id,
      s.kind AS source_kind, s.external_id, s.revision,
      coalesce((SELECT array_agg(DISTINCT locator ORDER BY locator) FROM (
        SELECT o.locator FROM public.observations o WHERE o.owner_id=s.owner_id
          AND o.scope_id=s.scope_id AND o.source_id=s.id
        UNION SELECT e.locator FROM public.evidence e WHERE e.owner_id=s.owner_id
          AND e.scope_id=s.scope_id AND e.source_id=s.id
      ) all_locators), ARRAY[]::text[]) AS locators,
      '[]'::jsonb AS source_material,
      s.created_at AS due_at
    FROM public.scope_retention_policies p
    JOIN public.sources s ON s.owner_id=p.owner_id AND s.scope_id=p.scope_id
    WHERE (EXISTS (SELECT 1 FROM public.observations o WHERE o.owner_id=s.owner_id
        AND o.scope_id=s.scope_id AND o.source_id=s.id)
      OR EXISTS (SELECT 1 FROM public.evidence e WHERE e.owner_id=s.owner_id
        AND e.scope_id=s.scope_id AND e.source_id=s.id)
      OR EXISTS (SELECT 1 FROM public.episodes ep WHERE ep.owner_id=s.owner_id
        AND ep.scope_id=s.scope_id AND ep.source_id=s.id))
      AND p.observation_days IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.observations o WHERE o.owner_id=s.owner_id
        AND o.scope_id=s.scope_id AND o.source_id=s.id
        AND o.captured_at > clock_timestamp() - make_interval(days => p.observation_days))
      AND NOT EXISTS (SELECT 1 FROM public.evidence e WHERE e.owner_id=s.owner_id
        AND e.scope_id=s.scope_id AND e.source_id=s.id
        AND e.captured_at > clock_timestamp() - make_interval(days => p.observation_days))
      AND NOT EXISTS (SELECT 1 FROM public.episodes ep WHERE ep.owner_id=s.owner_id
        AND ep.scope_id=s.scope_id AND ep.source_id=s.id
        AND ep.recorded_at > clock_timestamp() - make_interval(days => p.observation_days))
      AND NOT EXISTS (SELECT 1 FROM public.suppressions sp WHERE sp.owner_id=s.owner_id
        AND sp.scope_id=s.scope_id AND sp.object_kind='source' AND sp.object_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM public.deletion_targets dt
        WHERE dt.owner_id=s.owner_id AND dt.scope_id=s.scope_id
          AND dt.target_kind='source' AND dt.target_id=s.id)
  ), candidates AS (
    SELECT * FROM memory_candidates UNION ALL SELECT * FROM source_candidates
  )
  SELECT c.owner_id, c.scope_id, c.principal_id, c.target_kind, c.target_id,
    c.source_kind, c.external_id, c.revision, c.locators, c.source_material
  FROM candidates c ORDER BY c.due_at, c.owner_id, c.scope_id, c.target_kind, c.target_id
  LIMIT p_limit;
END
$$;
ALTER FUNCTION app.list_due_retention_candidates(integer) OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.list_due_retention_candidates(integer) FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.list_due_retention_candidates(integer) TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.enqueue_retention_deletion(
  p_request_id uuid,
  p_owner_id uuid,
  p_scope_id uuid,
  p_principal_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_locator_hmacs text[],
  p_source_hmacs text[]
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  policy_row public.scope_retention_policies%ROWTYPE;
  target_source public.sources%ROWTYPE;
  blocked_at timestamptz := clock_timestamp();
  selector jsonb;
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  IF p_target_kind NOT IN ('memory', 'source')
     OR cardinality(coalesce(p_locator_hmacs, ARRAY[]::text[])) > 10000
     OR cardinality(coalesce(p_source_hmacs, ARRAY[]::text[])) > 10000
     OR EXISTS (SELECT 1 FROM unnest(coalesce(p_locator_hmacs, ARRAY[]::text[])) h WHERE h !~ '^[0-9a-f]{64}$')
     OR EXISTS (SELECT 1 FROM unnest(coalesce(p_source_hmacs, ARRAY[]::text[])) h WHERE h !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid retention deletion target' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO policy_row FROM public.scope_retention_policies p
    WHERE p.owner_id=p_owner_id AND p.scope_id=p_scope_id AND p.updated_by=p_principal_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.scopes s WHERE s.owner_id=p_owner_id AND s.id=p_scope_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_target_kind='memory' THEN
    IF policy_row.memory_days IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.memories m WHERE m.owner_id=p_owner_id AND m.scope_id=p_scope_id
        AND m.id=p_target_id AND m.recorded_at <= blocked_at - make_interval(days => policy_row.memory_days)
    ) OR EXISTS (SELECT 1 FROM public.suppressions sp WHERE sp.owner_id=p_owner_id
        AND sp.scope_id=p_scope_id AND sp.object_kind='memory' AND sp.object_id=p_target_id) THEN
      RETURN false;
    END IF;
    selector := jsonb_build_object('memory_ids', jsonb_build_array(p_target_id), 'source_ids', '[]'::jsonb,
      'original_principal_id', p_principal_id);
  ELSE
    SELECT * INTO target_source FROM public.sources s
      WHERE s.owner_id=p_owner_id AND s.scope_id=p_scope_id AND s.id=p_target_id;
    IF NOT FOUND OR policy_row.observation_days IS NULL
       OR NOT (EXISTS (SELECT 1 FROM public.observations o WHERE o.owner_id=p_owner_id
         AND o.scope_id=p_scope_id AND o.source_id=p_target_id)
         OR EXISTS (SELECT 1 FROM public.evidence e WHERE e.owner_id=p_owner_id
           AND e.scope_id=p_scope_id AND e.source_id=p_target_id)
         OR EXISTS (SELECT 1 FROM public.episodes ep WHERE ep.owner_id=p_owner_id
           AND ep.scope_id=p_scope_id AND ep.source_id=p_target_id))
       OR EXISTS (SELECT 1 FROM public.observations o WHERE o.owner_id=p_owner_id
         AND o.scope_id=p_scope_id AND o.source_id=p_target_id
         AND o.captured_at > blocked_at - make_interval(days => policy_row.observation_days))
       OR EXISTS (SELECT 1 FROM public.evidence e WHERE e.owner_id=p_owner_id
         AND e.scope_id=p_scope_id AND e.source_id=p_target_id
         AND e.captured_at > blocked_at - make_interval(days => policy_row.observation_days))
       OR EXISTS (SELECT 1 FROM public.episodes ep WHERE ep.owner_id=p_owner_id
         AND ep.scope_id=p_scope_id AND ep.source_id=p_target_id
         AND ep.recorded_at > blocked_at - make_interval(days => policy_row.observation_days))
       OR EXISTS (SELECT 1 FROM public.suppressions sp WHERE sp.owner_id=p_owner_id
         AND sp.scope_id=p_scope_id AND sp.object_kind='source' AND sp.object_id=p_target_id) THEN
      RETURN false;
    END IF;
    selector := jsonb_build_object('memory_ids', '[]'::jsonb, 'source_ids', jsonb_build_array(p_target_id),
      'original_principal_id', p_principal_id);
  END IF;

  INSERT INTO public.deletion_requests(id, owner_id, scope_id, principal_id, selector, reason_code,
    status, created_at)
  VALUES (p_request_id, p_owner_id, p_scope_id, p_principal_id, selector,
    'retention_expired', 'ledger_pending', blocked_at);
  INSERT INTO public.deletion_targets(owner_id, scope_id, deletion_request_id, target_kind, target_id)
  VALUES (p_owner_id, p_scope_id, p_request_id, p_target_kind, p_target_id);
  INSERT INTO public.suppressions(owner_id, scope_id, deletion_request_id, object_kind, object_id, locator_hmac)
  SELECT p_owner_id, p_scope_id, p_request_id, p_target_kind, p_target_id, NULL
  UNION ALL SELECT p_owner_id, p_scope_id, p_request_id, 'locator_hmac', NULL, h
    FROM unnest(coalesce(p_locator_hmacs, ARRAY[]::text[]) || coalesce(p_source_hmacs, ARRAY[]::text[])) h;
  UPDATE public.scopes SET deletion_epoch=deletion_epoch+1 WHERE owner_id=p_owner_id AND id=p_scope_id;
  INSERT INTO public.audit_events(owner_id, scope_id, principal_id, event_type, request_id, object_id, metadata)
  VALUES (p_owner_id, p_scope_id, p_principal_id, 'memory.retention_expired', p_request_id, p_target_id,
    jsonb_build_object('target_kind', p_target_kind, 'status', 'ledger_pending'));
  RETURN true;
END
$$;
ALTER FUNCTION app.enqueue_retention_deletion(uuid, uuid, uuid, uuid, text, uuid, text[], text[])
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.enqueue_retention_deletion(uuid, uuid, uuid, uuid, text, uuid, text[], text[])
  FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.enqueue_retention_deletion(uuid, uuid, uuid, uuid, text, uuid, text[], text[])
  TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.hold_queued_feedback_reassessments(p_limit integer DEFAULT 100)
RETURNS integer
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
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'feedback candidate limit must be between 1 and 500' USING ERRCODE = '22023';
  END IF;
  WITH candidates AS (
    SELECT f.id FROM public.feedback_reassessments f WHERE f.state='queued'
    ORDER BY f.created_at, f.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.feedback_reassessments f SET state='held'
  FROM candidates c WHERE f.id=c.id AND f.state='queued';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$$;
ALTER FUNCTION app.hold_queued_feedback_reassessments(integer) OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.hold_queued_feedback_reassessments(integer) FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.hold_queued_feedback_reassessments(integer) TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.list_index_maintenance_actors(p_limit integer DEFAULT 25)
RETURNS TABLE(owner_id uuid, scope_id uuid, principal_id uuid, auth_epoch bigint, capabilities text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  IF p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'index actor limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT s.owner_id, s.id, p.id, s.auth_epoch, g.capabilities
  FROM public.scopes s JOIN public.grants g ON g.owner_id=s.owner_id AND g.scope_id=s.id
  JOIN public.principals p ON p.owner_id=g.owner_id AND p.id=g.principal_id
  WHERE p.active AND p.actor_kind='owner' AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
    AND ('write'=ANY(g.capabilities) OR 'admin'=ANY(g.capabilities))
    AND EXISTS (SELECT 1 FROM public.memories m WHERE m.owner_id=s.owner_id AND m.scope_id=s.id
      AND m.committed_revision > m.indexed_revision)
  ORDER BY s.owner_id, s.id, p.id LIMIT p_limit;
END
$$;
ALTER FUNCTION app.list_index_maintenance_actors(integer) OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.list_index_maintenance_actors(integer) FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.list_index_maintenance_actors(integer) TO thymesis_worker;
