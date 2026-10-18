GRANT INSERT ON public.deletion_requests TO thymesis_purge_executor;
ALTER POLICY deletion_requests_purge_executor ON public.deletion_requests
  WITH CHECK (current_user = 'thymesis_purge_executor');

CREATE OR REPLACE FUNCTION app.purge_forgotten_request_impl(
  p_owner_id uuid,
  p_scope_id uuid,
  p_request_id uuid,
  p_principal_id uuid,
  p_actor_kind text,
  p_require_current_admin boolean
)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  request_row public.deletion_requests%ROWTYPE;
  authorized_count integer;
  removed_count integer := 0;
  target_memory_ids uuid[];
  source_ids uuid[];
  subject_ids uuid[];
  evidence_ids uuid[];
  affected_changeset_ids uuid[];
  affected_review_ids uuid[];
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login') THEN
    RAISE EXCEPTION 'purge is only callable by application or worker login' USING ERRCODE = '42501';
  END IF;
  IF p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
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
  ELSIF session_user <> 'thymesis_worker_login' THEN
    RAISE EXCEPTION 'ledger replay purge requires the worker login' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO request_row FROM public.deletion_requests
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND id = p_request_id
    AND coalesce(principal_id, nullif(selector->>'original_principal_id', '')::uuid) = p_principal_id FOR UPDATE;
  IF NOT FOUND OR request_row.ledger_sequence IS NULL OR request_row.ledger_entry_hash IS NULL
     OR request_row.status NOT IN ('ledger_acked', 'purging') THEN
    RAISE EXCEPTION 'deletion request has no durable ledger receipt' USING ERRCODE = '55000';
  END IF;

  UPDATE public.deletion_requests SET status = 'purging'
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND id = p_request_id;
  SELECT coalesce(array_agg(target_id) FILTER (WHERE target_kind = 'memory'), ARRAY[]::uuid[]),
         coalesce(array_agg(target_id) FILTER (WHERE target_kind = 'source'), ARRAY[]::uuid[]),
         coalesce(array_agg(target_id) FILTER (WHERE target_kind = 'subject'), ARRAY[]::uuid[])
    INTO target_memory_ids, source_ids, subject_ids
  FROM public.deletion_targets
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND deletion_request_id = p_request_id;

  SELECT coalesce(array_agg(DISTINCT e.id), ARRAY[]::uuid[])
    INTO evidence_ids
  FROM public.evidence AS e
  WHERE e.owner_id = p_owner_id AND e.scope_id = p_scope_id AND (
    e.source_id = ANY(source_ids)
    OR EXISTS (SELECT 1 FROM public.memory_evidence me
      WHERE me.owner_id = e.owner_id AND me.scope_id = e.scope_id
        AND me.evidence_id = e.id AND me.memory_id = ANY(target_memory_ids))
    OR EXISTS (SELECT 1 FROM public.memory_version_evidence mve
      WHERE mve.owner_id = e.owner_id AND mve.scope_id = e.scope_id
        AND mve.evidence_id = e.id AND mve.memory_id = ANY(target_memory_ids))
  );

  SELECT coalesce(array_agg(DISTINCT cs.id), ARRAY[]::uuid[]) INTO affected_changeset_ids
  FROM public.changesets AS cs
  WHERE cs.owner_id = p_owner_id AND cs.scope_id = p_scope_id AND (
    EXISTS (SELECT 1 FROM public.change_ops AS op WHERE op.owner_id = cs.owner_id
      AND op.scope_id = cs.scope_id AND op.change_set_id = cs.id AND op.memory_id = ANY(target_memory_ids))
    OR EXISTS (SELECT 1 FROM public.curation_reviews AS cr JOIN public.capture_jobs AS cj
      ON cj.owner_id = cr.owner_id AND cj.scope_id = cr.scope_id AND cj.id = cr.job_id
      WHERE cr.owner_id = cs.owner_id AND cr.scope_id = cs.scope_id
        AND cr.change_set_id = cs.id AND cj.source_id = ANY(source_ids))
  );
  SELECT coalesce(array_agg(DISTINCT cr.id), ARRAY[]::uuid[]) INTO affected_review_ids
  FROM public.curation_reviews AS cr
  JOIN public.capture_jobs AS cj ON cj.owner_id = cr.owner_id AND cj.scope_id = cr.scope_id
    AND cj.id = cr.job_id
  WHERE cr.owner_id = p_owner_id AND cr.scope_id = p_scope_id
    AND (cr.change_set_id = ANY(affected_changeset_ids) OR cj.source_id = ANY(source_ids));

  UPDATE public.changesets AS cs SET
    status = CASE WHEN cs.status = 'proposed' THEN 'rejected' ELSE cs.status END,
    proposal = NULL, proposal_hash = NULL, proposal_idempotency_key = NULL,
    proposal_response = NULL,
    response = jsonb_build_object('redacted', true, 'reason', 'forgotten'),
    committed_at = CASE WHEN cs.status = 'committed' THEN cs.committed_at ELSE NULL END
  WHERE cs.owner_id = p_owner_id AND cs.scope_id = p_scope_id AND cs.id = ANY(affected_changeset_ids);
  DELETE FROM public.idempotency_keys AS ik USING public.changesets cs
    WHERE ik.owner_id = p_owner_id AND ik.scope_id = p_scope_id AND ik.change_set_id = cs.id
      AND cs.owner_id = ik.owner_id AND cs.scope_id = ik.scope_id
      AND cs.id = ANY(affected_changeset_ids);
  DELETE FROM public.owner_confirmations oc USING public.curation_reviews cr
    WHERE oc.owner_id = cr.owner_id AND oc.scope_id = cr.scope_id AND oc.review_id = cr.id
      AND cr.owner_id = p_owner_id AND cr.scope_id = p_scope_id
      AND (oc.memory_ids && target_memory_ids OR cr.id = ANY(affected_review_ids) OR EXISTS (
        SELECT 1 FROM public.capture_jobs cj
        WHERE cj.owner_id = cr.owner_id AND cj.scope_id = cr.scope_id
          AND cj.id = cr.job_id AND cj.source_id = ANY(source_ids)
      ));
  UPDATE public.capture_jobs cj SET checkpoint = '{}'::jsonb, state = 'failed',
      last_error_code = 'forgotten', updated_at = clock_timestamp()
    WHERE cj.owner_id = p_owner_id AND cj.scope_id = p_scope_id
      AND EXISTS (SELECT 1 FROM public.curation_reviews cr WHERE cr.owner_id = cj.owner_id
        AND cr.scope_id = cj.scope_id AND cr.job_id = cj.id AND cr.id = ANY(affected_review_ids));
  DELETE FROM public.curation_reviews cr
    WHERE cr.owner_id = p_owner_id AND cr.scope_id = p_scope_id AND cr.id = ANY(affected_review_ids);
  DELETE FROM public.capture_jobs WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND source_id = ANY(source_ids);
  DELETE FROM public.outbox WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND aggregate_id = ANY(source_ids || target_memory_ids);
  UPDATE public.export_jobs SET state = 'expired', artifact_key = NULL, expires_at = clock_timestamp()
    WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND state IN ('accepted', 'processing', 'ready');
  DELETE FROM public.feedback_reassessments WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND memory_id = ANY(target_memory_ids);
  DELETE FROM public.memories WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND id = ANY(target_memory_ids);
  GET DIAGNOSTICS removed_count = ROW_COUNT;
  DELETE FROM public.evidence AS e
    WHERE e.owner_id = p_owner_id AND e.scope_id = p_scope_id AND e.id = ANY(evidence_ids)
      AND NOT EXISTS (SELECT 1 FROM public.memory_evidence me
        WHERE me.owner_id = e.owner_id AND me.scope_id = e.scope_id AND me.evidence_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM public.memory_version_evidence mve
        WHERE mve.owner_id = e.owner_id AND mve.scope_id = e.scope_id AND mve.evidence_id = e.id);
  DELETE FROM public.observations AS o
    WHERE o.owner_id = p_owner_id AND o.scope_id = p_scope_id
      AND o.source_id = ANY(source_ids);
  DELETE FROM public.observations AS o
    WHERE o.owner_id = p_owner_id AND o.scope_id = p_scope_id
      AND EXISTS (SELECT 1 FROM public.evidence e WHERE e.owner_id = p_owner_id
        AND e.scope_id = p_scope_id AND e.id = ANY(evidence_ids)
        AND e.source_id = o.source_id AND e.source_revision = o.source_revision
        AND e.locator = o.locator)
      AND NOT EXISTS (SELECT 1 FROM public.evidence e WHERE e.owner_id = o.owner_id
        AND e.scope_id = o.scope_id AND e.source_id = o.source_id
        AND e.source_revision = o.source_revision AND e.locator = o.locator);
  DELETE FROM public.sources WHERE owner_id = p_owner_id AND scope_id = p_scope_id
    AND id = ANY(source_ids);
  DELETE FROM public.subjects AS sub
    WHERE sub.owner_id = p_owner_id AND sub.scope_id = p_scope_id AND sub.id = ANY(subject_ids)
      AND NOT EXISTS (SELECT 1 FROM public.memory_subjects ms WHERE ms.owner_id = sub.owner_id
        AND ms.scope_id = sub.scope_id AND ms.subject_id = sub.id);

  UPDATE public.deletion_requests SET status = 'complete', completed_at = clock_timestamp()
  WHERE owner_id = p_owner_id AND scope_id = p_scope_id AND id = p_request_id;
  RETURN removed_count;
END
$$;
ALTER FUNCTION app.purge_forgotten_request_impl(uuid, uuid, uuid, uuid, text, boolean)
  OWNER TO thymesis_purge_executor;
