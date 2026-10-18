CREATE OR REPLACE FUNCTION app.record_empty_deletion_ledger_visibility_head(p_head_generation text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member')
     OR length(p_head_generation) < 16 OR length(p_head_generation) > 256 THEN
    RAISE EXCEPTION 'trusted worker and verified empty ledger head required' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.deletion_requests
      WHERE status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging')) THEN
    RAISE EXCEPTION 'empty ledger cannot supersede pending Forget requests' USING ERRCODE = '55000';
  END IF;
  UPDATE public.deletion_ledger_checkpoint
    SET visible_sequence=0, visible_entry_hash=repeat('0',64),
        visible_head_generation=p_head_generation, updated_at=clock_timestamp()
    WHERE singleton AND visible_sequence=0;
END
$$;
ALTER FUNCTION app.record_empty_deletion_ledger_visibility_head(text) OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.record_empty_deletion_ledger_visibility_head(text) FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.record_empty_deletion_ledger_visibility_head(text) TO thymesis_worker;
