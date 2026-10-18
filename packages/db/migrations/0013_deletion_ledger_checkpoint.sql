CREATE TABLE public.deletion_ledger_checkpoint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  entry_hash text NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  head_generation text NOT NULL CHECK (length(head_generation) BETWEEN 16 AND 256),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.deletion_ledger_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deletion_ledger_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_executor_only ON public.deletion_ledger_checkpoint
  USING (current_user = 'thymesis_purge_executor')
  WITH CHECK (current_user = 'thymesis_purge_executor');
INSERT INTO public.deletion_ledger_checkpoint(singleton, sequence, entry_hash, head_generation)
VALUES (true, 0, repeat('0', 64), 'uninitialized-local-ledger');
GRANT SELECT, INSERT, UPDATE ON public.deletion_ledger_checkpoint TO thymesis_purge_executor;

CREATE OR REPLACE FUNCTION app.deletion_ledger_checkpoint()
RETURNS TABLE(sequence bigint, entry_hash text, head_generation text, pending_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login') THEN
    RAISE EXCEPTION 'application or worker login required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT cp.sequence, cp.entry_hash, cp.head_generation,
    (SELECT count(*) FROM public.deletion_requests dr
      WHERE dr.status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging'))
  FROM public.deletion_ledger_checkpoint cp WHERE cp.singleton;
END
$$;
ALTER FUNCTION app.deletion_ledger_checkpoint() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.deletion_ledger_checkpoint() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.deletion_ledger_checkpoint() TO thymesis_app, thymesis_worker;

CREATE OR REPLACE FUNCTION app.record_deletion_ledger_checkpoint(
  p_sequence bigint, p_entry_hash text, p_head_generation text
)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_checkpoint public.deletion_ledger_checkpoint%ROWTYPE;
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member')
     OR p_sequence < 0 OR p_entry_hash !~ '^[0-9a-f]{64}$'
     OR length(p_head_generation) < 16 OR length(p_head_generation) > 256 THEN
    RAISE EXCEPTION 'verified worker ledger head required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.deletion_requests dr
    WHERE dr.status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging')) THEN
    RAISE EXCEPTION 'pending deletions prevent ledger checkpoint advancement' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO current_checkpoint FROM public.deletion_ledger_checkpoint
    WHERE singleton FOR UPDATE;
  IF p_sequence < current_checkpoint.sequence THEN
    RAISE EXCEPTION 'ledger checkpoint cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF p_sequence = current_checkpoint.sequence AND current_checkpoint.head_generation <> 'uninitialized-local-ledger'
     AND (p_entry_hash <> current_checkpoint.entry_hash OR p_head_generation <> current_checkpoint.head_generation) THEN
    RAISE EXCEPTION 'same-sequence ledger checkpoint conflicts' USING ERRCODE = '23505';
  END IF;
  UPDATE public.deletion_ledger_checkpoint SET sequence = p_sequence, entry_hash = p_entry_hash,
    head_generation = p_head_generation, updated_at = clock_timestamp() WHERE singleton;
END
$$;
ALTER FUNCTION app.record_deletion_ledger_checkpoint(bigint, text, text) OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.record_deletion_ledger_checkpoint(bigint, text, text) FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.record_deletion_ledger_checkpoint(bigint, text, text) TO thymesis_worker;
