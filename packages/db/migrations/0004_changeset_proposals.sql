ALTER TABLE changesets
  ADD COLUMN status text NOT NULL DEFAULT 'committed'
    CHECK (status IN ('proposed', 'committed', 'rejected')),
  ADD COLUMN proposal jsonb,
  ADD COLUMN proposal_hash text,
  ADD COLUMN proposal_idempotency_key text,
  ADD COLUMN committed_at timestamptz;

UPDATE changesets SET committed_at = created_at WHERE status = 'committed';

ALTER TABLE changesets
  ADD CONSTRAINT changesets_proposal_object_check
    CHECK (proposal IS NULL OR jsonb_typeof(proposal) = 'object'),
  ADD CONSTRAINT changesets_proposal_hash_check
    CHECK (proposal_hash IS NULL OR proposal_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT changesets_proposal_state_check
    CHECK ((status = 'proposed' AND proposal IS NOT NULL AND proposal_hash IS NOT NULL AND proposal_idempotency_key IS NOT NULL AND committed_at IS NULL)
        OR (status = 'committed' AND proposal IS NULL AND committed_at IS NOT NULL)
        OR (status = 'rejected' AND committed_at IS NULL)),
  ADD CONSTRAINT changesets_proposal_idempotency_key_check
    CHECK (proposal_idempotency_key IS NULL OR length(proposal_idempotency_key) BETWEEN 1 AND 256);

CREATE UNIQUE INDEX changesets_proposal_idempotency_idx
  ON changesets(owner_id, scope_id, principal_id, proposal_idempotency_key)
  WHERE proposal_idempotency_key IS NOT NULL;
