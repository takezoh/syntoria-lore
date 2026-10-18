ALTER TABLE public.deletion_requests
  ADD COLUMN ledger_retry_count integer NOT NULL DEFAULT 0
    CHECK (ledger_retry_count >= 0),
  ADD COLUMN ledger_next_attempt_at timestamptz;

CREATE INDEX deletion_requests_worker_pending_idx
  ON public.deletion_requests(ledger_next_attempt_at NULLS FIRST, created_at, id)
  WHERE status IN ('suppressed', 'ledger_pending', 'ledger_acked', 'purging');
