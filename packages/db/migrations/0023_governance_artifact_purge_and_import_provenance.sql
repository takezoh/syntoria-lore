ALTER TABLE public.portability_imports
  ADD COLUMN request_hash text,
  ADD COLUMN response jsonb,
  ADD CONSTRAINT portability_import_request_hash_check
    CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT portability_import_response_check
    CHECK (response IS NULL OR jsonb_typeof(response) = 'object');

ALTER TABLE public.sources ADD COLUMN origin_lineage_root uuid;
ALTER TABLE public.observations ADD COLUMN origin_lineage_root uuid;
ALTER TABLE public.evidence ADD COLUMN origin_lineage_root uuid;

CREATE TABLE public.governance_file_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  artifact_key text NOT NULL UNIQUE CHECK (artifact_key ~ '^[0-9a-f-]{36}\.bundle$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'deleting', 'deleted')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  FOREIGN KEY (owner_id, scope_id) REFERENCES public.scopes(owner_id, id) ON DELETE CASCADE
);
ALTER TABLE public.governance_file_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.governance_file_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY governance_file_deletions_executor ON public.governance_file_deletions
  USING (current_user = 'thymesis_purge_executor')
  WITH CHECK (current_user = 'thymesis_purge_executor');

GRANT USAGE ON SCHEMA app, public TO thymesis_purge_executor;
GRANT SELECT, INSERT, UPDATE ON public.governance_file_deletions TO thymesis_purge_executor;

CREATE OR REPLACE FUNCTION app.queue_export_artifact_deletion()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user NOT IN ('thymesis_app', 'thymesis_worker_login') THEN
    RAISE EXCEPTION 'artifact purge is only callable by application or worker login' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.governance_file_deletions(owner_id, scope_id, artifact_key)
  VALUES (OLD.owner_id, OLD.scope_id, OLD.artifact_key)
  ON CONFLICT (artifact_key) DO NOTHING;
  RETURN NEW;
END
$$;
ALTER FUNCTION app.queue_export_artifact_deletion() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.queue_export_artifact_deletion() FROM PUBLIC, thymesis_app, thymesis_worker;
CREATE TRIGGER export_artifact_delete_queue
  AFTER UPDATE OF artifact_key ON public.export_jobs
  FOR EACH ROW WHEN (OLD.artifact_key IS NOT NULL AND NEW.artifact_key IS NULL)
  EXECUTE FUNCTION app.queue_export_artifact_deletion();

CREATE OR REPLACE FUNCTION app.defer_forget_completion_until_files_deleted()
RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'complete' AND EXISTS (
    SELECT 1 FROM public.governance_file_deletions q
    WHERE q.owner_id = NEW.owner_id AND q.scope_id = NEW.scope_id AND q.state <> 'deleted'
  ) THEN
    NEW.status := 'purging';
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
ALTER FUNCTION app.defer_forget_completion_until_files_deleted() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.defer_forget_completion_until_files_deleted() FROM PUBLIC, thymesis_app, thymesis_worker;
CREATE TRIGGER deletion_request_file_purge_gate
  BEFORE UPDATE OF status ON public.deletion_requests
  FOR EACH ROW EXECUTE FUNCTION app.defer_forget_completion_until_files_deleted();

CREATE OR REPLACE FUNCTION app.claim_governance_file_deletions()
RETURNS TABLE(id uuid, owner_id uuid, scope_id uuid, artifact_key text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY WITH candidates AS (
    SELECT q.id FROM public.governance_file_deletions q
    WHERE q.state = 'queued' OR (q.state = 'deleting' AND q.lease_until <= clock_timestamp())
    ORDER BY q.created_at, q.id FOR UPDATE SKIP LOCKED LIMIT 100
  ), claimed AS (
    UPDATE public.governance_file_deletions q SET state = 'deleting', attempts = attempts + 1,
      lease_until = clock_timestamp() + interval '5 minutes', last_error = NULL
    FROM candidates c WHERE q.id = c.id
    RETURNING q.id, q.owner_id, q.scope_id, q.artifact_key
  ) SELECT claimed.id, claimed.owner_id, claimed.scope_id, claimed.artifact_key FROM claimed;
END
$$;
ALTER FUNCTION app.claim_governance_file_deletions() OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.claim_governance_file_deletions() FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.claim_governance_file_deletions() TO thymesis_worker;

CREATE OR REPLACE FUNCTION app.ack_governance_file_deletion(p_id uuid, p_artifact_key text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  affected_owner uuid;
  affected_scope uuid;
BEGIN
  IF session_user <> 'thymesis_worker_login'
     OR NOT pg_catalog.pg_has_role(session_user, 'thymesis_worker', 'member') THEN
    RAISE EXCEPTION 'worker login required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.governance_file_deletions q
    SET state = 'deleted', deleted_at = coalesce(deleted_at, clock_timestamp()), lease_until = NULL
    WHERE q.id = p_id AND q.artifact_key = p_artifact_key AND q.state <> 'deleted'
    RETURNING q.owner_id, q.scope_id INTO affected_owner, affected_scope;
  IF NOT FOUND THEN
    RETURN EXISTS (SELECT 1 FROM public.governance_file_deletions q
      WHERE q.id = p_id AND q.artifact_key = p_artifact_key AND q.state = 'deleted');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.governance_file_deletions q
    WHERE q.owner_id = affected_owner AND q.scope_id = affected_scope AND q.state <> 'deleted') THEN
    UPDATE public.deletion_requests SET status = 'complete', completed_at = clock_timestamp()
      WHERE owner_id = affected_owner AND scope_id = affected_scope AND status = 'purging';
  END IF;
  RETURN true;
END
$$;
ALTER FUNCTION app.ack_governance_file_deletion(uuid, text) OWNER TO thymesis_purge_executor;
REVOKE ALL ON FUNCTION app.ack_governance_file_deletion(uuid, text) FROM PUBLIC, thymesis_app;
GRANT EXECUTE ON FUNCTION app.ack_governance_file_deletion(uuid, text) TO thymesis_worker;
