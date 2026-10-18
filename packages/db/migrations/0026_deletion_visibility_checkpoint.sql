ALTER TABLE public.deletion_ledger_checkpoint
  ADD COLUMN visible_sequence bigint NOT NULL DEFAULT 0 CHECK (visible_sequence >= 0),
  ADD COLUMN visible_entry_hash text NOT NULL DEFAULT repeat('0', 64)
    CHECK (visible_entry_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN visible_head_generation text NOT NULL DEFAULT 'uninitialized-local-ledger'
    CHECK (length(visible_head_generation) BETWEEN 16 AND 256);
UPDATE public.deletion_ledger_checkpoint SET visible_sequence=sequence,
  visible_entry_hash=entry_hash, visible_head_generation=head_generation WHERE singleton;

CREATE TABLE public.deletion_ledger_visibility_items (
  sequence bigint PRIMARY KEY CHECK (sequence > 0),
  request_id uuid NOT NULL UNIQUE,
  entry_hash text NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  head_generation text NOT NULL CHECK (length(head_generation) BETWEEN 16 AND 256),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.deletion_ledger_visibility_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deletion_ledger_visibility_items FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_ledger_visibility_executor ON public.deletion_ledger_visibility_items
  USING (current_user = 'thymesis_purge_executor')
  WITH CHECK (current_user = 'thymesis_purge_executor');
GRANT SELECT, INSERT ON public.deletion_ledger_visibility_items TO thymesis_purge_executor;
GRANT UPDATE ON public.deletion_ledger_checkpoint TO thymesis_purge_executor;

DROP FUNCTION app.deletion_ledger_checkpoint();
CREATE FUNCTION app.deletion_ledger_checkpoint()
RETURNS TABLE(
  sequence bigint, entry_hash text, head_generation text, pending_count bigint,
  visible_sequence bigint, visible_entry_hash text, visible_head_generation text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login') THEN
    RAISE EXCEPTION 'application or worker login required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT cp.sequence, cp.entry_hash, cp.head_generation,
    (SELECT count(*) FROM public.deletion_requests dr
      WHERE dr.status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging')),
    cp.visible_sequence, cp.visible_entry_hash, cp.visible_head_generation
  FROM public.deletion_ledger_checkpoint cp WHERE cp.singleton;
END
$$;
ALTER FUNCTION app.deletion_ledger_checkpoint() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.deletion_ledger_checkpoint() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.deletion_ledger_checkpoint() TO thymesis_app, thymesis_worker;

CREATE OR REPLACE FUNCTION app.record_deletion_ledger_visibility_item(
  p_request_id uuid, p_owner_id uuid, p_scope_id uuid, p_principal_id uuid,
  p_sequence bigint, p_entry_hash text, p_head_generation text,
  p_memory_ids uuid[], p_source_ids uuid[], p_subject_ids uuid[], p_locator_hmacs text[]
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  authorized_count integer;
  request_row public.deletion_requests%ROWTYPE;
  scope_present boolean;
  request_memories uuid[];
  request_sources uuid[];
  request_subjects uuid[];
  suppressed_memories uuid[];
  suppressed_sources uuid[];
  suppressed_hmacs text[];
  wanted_memories uuid[];
  wanted_sources uuid[];
  wanted_subjects uuid[];
  wanted_hmacs text[];
  existing_item public.deletion_ledger_visibility_items%ROWTYPE;
  checkpoint public.deletion_ledger_checkpoint%ROWTYPE;
  next_item public.deletion_ledger_visibility_items%ROWTYPE;
BEGIN
  IF p_sequence < 1 OR p_entry_hash !~ '^[0-9a-f]{64}$'
     OR length(p_head_generation) < 16 OR length(p_head_generation) > 256
     OR cardinality(p_locator_hmacs) > 100000 THEN
    RAISE EXCEPTION 'verified ledger visibility receipt required' USING ERRCODE = '42501';
  END IF;
  IF session_user = 'thymesis_app' THEN
    IF p_owner_id IS DISTINCT FROM nullif(current_setting('app.owner_id', true), '')::uuid
       OR p_scope_id <> ALL(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
       OR p_principal_id IS DISTINCT FROM nullif(current_setting('app.principal_id', true), '')::uuid THEN
      RAISE EXCEPTION 'owner visibility actor context is invalid' USING ERRCODE = '42501';
    END IF;
    SELECT count(*) INTO authorized_count
    FROM app.lock_actor_access(p_owner_id, p_principal_id, 'owner', ARRAY[p_scope_id]::uuid[]) AS access
    WHERE access.scope_id = p_scope_id AND 'admin' = ANY(access.capabilities);
    IF authorized_count <> 1 THEN
      RAISE EXCEPTION 'current Owner admin grant is required for visibility receipt' USING ERRCODE = '42501';
    END IF;
  ELSIF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'application Owner or worker ledger authority required' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.scopes WHERE owner_id=p_owner_id AND id=p_scope_id)
    INTO scope_present;
  IF scope_present THEN
    SELECT * INTO request_row FROM public.deletion_requests dr
    WHERE dr.owner_id=p_owner_id AND dr.scope_id=p_scope_id AND dr.id=p_request_id
      AND coalesce(dr.principal_id, nullif(dr.selector->>'original_principal_id', '')::uuid)=p_principal_id;
    IF NOT FOUND OR request_row.status NOT IN ('ledger_pending', 'ledger_acked', 'purging', 'complete')
       OR (request_row.ledger_sequence IS NOT NULL AND
         (request_row.ledger_sequence <> p_sequence OR request_row.ledger_entry_hash <> p_entry_hash
          OR request_row.ledger_head_generation <> p_head_generation)) THEN
      RAISE EXCEPTION 'matching persisted deletion suppression is required' USING ERRCODE = '55000';
    END IF;

    SELECT coalesce(array_agg(dt.target_id ORDER BY dt.target_id) FILTER (WHERE dt.target_kind='memory'), ARRAY[]::uuid[]),
      coalesce(array_agg(dt.target_id ORDER BY dt.target_id) FILTER (WHERE dt.target_kind='source'), ARRAY[]::uuid[]),
      coalesce(array_agg(dt.target_id ORDER BY dt.target_id) FILTER (WHERE dt.target_kind='subject'), ARRAY[]::uuid[])
      INTO request_memories, request_sources, request_subjects
    FROM public.deletion_targets dt WHERE dt.owner_id=p_owner_id AND dt.scope_id=p_scope_id
      AND dt.deletion_request_id=p_request_id;
    SELECT coalesce(array_agg(sp.object_id ORDER BY sp.object_id) FILTER (WHERE sp.object_kind='memory'), ARRAY[]::uuid[]),
      coalesce(array_agg(sp.object_id ORDER BY sp.object_id) FILTER (WHERE sp.object_kind='source'), ARRAY[]::uuid[]),
      coalesce(array_agg(sp.locator_hmac ORDER BY sp.locator_hmac) FILTER (WHERE sp.locator_hmac IS NOT NULL), ARRAY[]::text[])
      INTO suppressed_memories, suppressed_sources, suppressed_hmacs
    FROM public.suppressions sp WHERE sp.owner_id=p_owner_id AND sp.scope_id=p_scope_id
      AND sp.deletion_request_id=p_request_id;

    SELECT coalesce(array_agg(DISTINCT value ORDER BY value), ARRAY[]::uuid[]) INTO wanted_memories
      FROM unnest(coalesce(p_memory_ids, ARRAY[]::uuid[])) AS value;
    SELECT coalesce(array_agg(DISTINCT value ORDER BY value), ARRAY[]::uuid[]) INTO wanted_sources
      FROM unnest(coalesce(p_source_ids, ARRAY[]::uuid[])) AS value;
    SELECT coalesce(array_agg(DISTINCT value ORDER BY value), ARRAY[]::uuid[]) INTO wanted_subjects
      FROM unnest(coalesce(p_subject_ids, ARRAY[]::uuid[])) AS value;
    SELECT coalesce(array_agg(DISTINCT value ORDER BY value), ARRAY[]::text[]) INTO wanted_hmacs
      FROM unnest(coalesce(p_locator_hmacs, ARRAY[]::text[])) AS value;
    IF request_memories IS DISTINCT FROM wanted_memories
       OR request_sources IS DISTINCT FROM wanted_sources
       OR request_subjects IS DISTINCT FROM wanted_subjects
       OR suppressed_memories IS DISTINCT FROM wanted_memories
       OR suppressed_sources IS DISTINCT FROM wanted_sources
       OR suppressed_hmacs IS DISTINCT FROM wanted_hmacs THEN
      RAISE EXCEPTION 'ledger visibility receipt does not match stored suppressions' USING ERRCODE = '55000';
    END IF;
  ELSIF session_user <> 'thymesis_worker_login' THEN
    RAISE EXCEPTION 'only worker replay may acknowledge an absent restored scope' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.deletion_ledger_visibility_items(sequence, request_id, entry_hash, head_generation)
  VALUES (p_sequence, p_request_id, p_entry_hash, p_head_generation)
  ON CONFLICT (sequence) DO NOTHING;
  SELECT * INTO existing_item FROM public.deletion_ledger_visibility_items WHERE sequence=p_sequence;
  IF existing_item.request_id <> p_request_id OR existing_item.entry_hash <> p_entry_hash
     OR existing_item.head_generation <> p_head_generation THEN
    RAISE EXCEPTION 'ledger visibility sequence conflicts with the durable record' USING ERRCODE = '23505';
  END IF;

  SELECT * INTO checkpoint FROM public.deletion_ledger_checkpoint WHERE singleton FOR UPDATE;
  LOOP
    SELECT * INTO next_item FROM public.deletion_ledger_visibility_items
      WHERE sequence=checkpoint.visible_sequence + 1;
    EXIT WHEN NOT FOUND;
    UPDATE public.deletion_ledger_checkpoint SET visible_sequence=next_item.sequence,
      visible_entry_hash=next_item.entry_hash, visible_head_generation=next_item.head_generation,
      updated_at=clock_timestamp() WHERE singleton RETURNING * INTO checkpoint;
  END LOOP;
END
$$;
ALTER FUNCTION app.record_deletion_ledger_visibility_item(uuid, uuid, uuid, uuid, bigint, text, text, uuid[], uuid[], uuid[], text[])
  OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.record_deletion_ledger_visibility_item(uuid, uuid, uuid, uuid, bigint, text, text, uuid[], uuid[], uuid[], text[])
  FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.record_deletion_ledger_visibility_item(uuid, uuid, uuid, uuid, bigint, text, text, uuid[], uuid[], uuid[], text[])
  TO thymesis_app, thymesis_worker;
