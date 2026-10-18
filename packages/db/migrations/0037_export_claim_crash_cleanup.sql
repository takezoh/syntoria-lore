CREATE OR REPLACE FUNCTION app.queue_expired_export_cleanup()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login')
     OR (session_user = 'thymesis_worker_login'
         AND NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member')) THEN
    RAISE EXCEPTION 'export cleanup is only callable by application or worker login'
      USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.governance_file_deletions(owner_id, scope_id, artifact_key)
  VALUES (OLD.owner_id, OLD.scope_id, OLD.id::text || '.bundle')
  ON CONFLICT (artifact_key) DO NOTHING;
  RETURN NEW;
END
$$;
ALTER FUNCTION app.queue_expired_export_cleanup() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.queue_expired_export_cleanup() FROM PUBLIC, thymesis_app, thymesis_worker;

CREATE TRIGGER export_expiry_job_cleanup_queue
  AFTER UPDATE OF state ON public.export_jobs
  FOR EACH ROW WHEN (OLD.state <> 'expired' AND NEW.state = 'expired')
  EXECUTE FUNCTION app.queue_expired_export_cleanup();
