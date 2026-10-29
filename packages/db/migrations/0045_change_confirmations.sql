-- A protected change that waits for the person's approval at Gate. The row stores the exact
-- operation, the summary shown at Gate and the hash binding both. It is approved once, then
-- executed under an idempotency key derived from its ID; resolution clears the stored content.
CREATE TABLE public.change_confirmations (
  user_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  id uuid NOT NULL,
  requested_by uuid NOT NULL,
  gate_subject text NOT NULL CHECK (length(gate_subject) BETWEEN 1 AND 512),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 4096),
  connection_id text NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 4096),
  gate_audience text NOT NULL CHECK (length(gate_audience) BETWEEN 1 AND 2048),
  operation text NOT NULL CHECK (operation IN (
    'commit_changeset', 'forget', 'decide_review', 'change_source_rights',
    'change_scope_grant', 'set_retention_policy'
  )),
  payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object'),
  summary jsonb CHECK (summary IS NULL OR jsonb_typeof(summary) = 'object'),
  change_hash text NOT NULL CHECK (change_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  memory_ids uuid[] NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  gate_confirmation_id text NOT NULL CHECK (gate_confirmation_id ~ '^[A-Za-z0-9_-]{43}$'),
  gate_url text NOT NULL CHECK (length(gate_url) BETWEEN 1 AND 4096),
  status text NOT NULL CHECK (status IN (
    'pending', 'approved', 'committed', 'denied', 'expired', 'cancelled', 'failed'
  )),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_at timestamptz,
  resolved_at timestamptz,
  PRIMARY KEY (user_id, scope_id, id),
  FOREIGN KEY (user_id, scope_id) REFERENCES public.scopes(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, requested_by) REFERENCES public.principals(user_id, id),
  CHECK ((status IN ('pending', 'approved')) = (resolved_at IS NULL)),
  CHECK ((status IN ('approved', 'committed')) = (approved_at IS NOT NULL) OR status = 'failed'),
  CHECK (status NOT IN ('pending', 'approved') OR (payload IS NOT NULL AND summary IS NOT NULL)),
  CHECK (status IN ('pending', 'approved') OR (payload IS NULL AND summary IS NULL))
);

CREATE UNIQUE INDEX change_confirmations_idempotency_idx
  ON public.change_confirmations(user_id, requested_by, idempotency_key);
CREATE UNIQUE INDEX change_confirmations_pending_request_idx
  ON public.change_confirmations(user_id, requested_by, request_hash) WHERE status = 'pending';
CREATE INDEX change_confirmations_memory_idx
  ON public.change_confirmations USING gin (memory_ids) WHERE status IN ('pending', 'approved');

ALTER TABLE public.change_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.change_confirmations
  USING (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
  )
  WITH CHECK (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[])
  );

REVOKE ALL ON public.change_confirmations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.change_confirmations TO memory_app;
-- Every role that suppresses memories, directly or through SECURITY DEFINER governance functions,
-- needs exactly what the cancellation trigger below updates. Row-level security still applies.
GRANT SELECT, UPDATE (status, resolved_at, payload, summary, response)
  ON public.change_confirmations TO memory_worker, memory_purge_executor, memory_authority_executor;

-- Suppressing a memory, through Forget or retention, ends every unfinished confirmation that
-- shows it, so no stored summary keeps forgotten text. An approved Forget is the one exception:
-- it is the change being applied.
CREATE FUNCTION app.cancel_confirmations_for_suppressed_memory()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.change_confirmations
     SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE 'failed' END,
         response = CASE WHEN status = 'pending' THEN NULL ELSE
           '{"error":{"code":"memory_forgotten","message":"A memory in this change was forgotten"}}'::jsonb
         END,
         resolved_at = clock_timestamp(), payload = NULL, summary = NULL
   WHERE user_id = NEW.user_id AND scope_id = NEW.scope_id AND memory_ids @> ARRAY[NEW.object_id]
     AND (status = 'pending' OR (status = 'approved' AND operation <> 'forget'));
  RETURN NULL;
END
$$;

CREATE TRIGGER suppressions_cancel_change_confirmations
AFTER INSERT ON public.suppressions
FOR EACH ROW WHEN (NEW.object_kind = 'memory' AND NEW.object_id IS NOT NULL)
EXECUTE FUNCTION app.cancel_confirmations_for_suppressed_memory();
