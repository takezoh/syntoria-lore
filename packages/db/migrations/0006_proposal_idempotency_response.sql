ALTER TABLE changesets ADD COLUMN proposal_response jsonb;
UPDATE changesets SET proposal_response = response WHERE status = 'proposed';
ALTER TABLE changesets ADD CONSTRAINT changesets_proposal_response_check
  CHECK (proposal_response IS NULL OR jsonb_typeof(proposal_response) = 'object');
ALTER TABLE changesets ADD CONSTRAINT changesets_proposed_response_required_check
  CHECK (status <> 'proposed' OR proposal_response IS NOT NULL);
