ALTER TABLE sources ADD COLUMN IF NOT EXISTS lineage_root uuid;

ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_authority_check;
ALTER TABLE memories ADD CONSTRAINT memories_authority_check
  CHECK (authority IN ('owner_decision', 'owner_preference', 'owner_assertion', 'third_party_claim', 'observed_state', 'ai_proposal'));

ALTER TABLE memory_versions DROP CONSTRAINT IF EXISTS memory_versions_authority_check;
ALTER TABLE memory_versions ADD CONSTRAINT memory_versions_authority_check
  CHECK (authority IN ('owner_decision', 'owner_preference', 'owner_assertion', 'third_party_claim', 'observed_state', 'ai_proposal'));
