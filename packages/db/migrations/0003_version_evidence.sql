CREATE TABLE memory_version_evidence (
  owner_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  revision integer NOT NULL,
  evidence_id uuid NOT NULL,
  support_role text NOT NULL DEFAULT 'supports' CHECK (support_role IN ('supports', 'contradicts')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, scope_id, memory_id, revision, evidence_id),
  FOREIGN KEY (owner_id, scope_id, memory_id, revision)
    REFERENCES memory_versions(owner_id, scope_id, memory_id, revision) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, scope_id, evidence_id)
    REFERENCES evidence(owner_id, scope_id, id) ON DELETE CASCADE
);

-- Historical evidence timing was not recorded before this migration. Attach the known
-- current evidence only to each memory's current revision; do not invent earlier history.
INSERT INTO memory_version_evidence(owner_id, scope_id, memory_id, revision, evidence_id)
SELECT me.owner_id, me.scope_id, me.memory_id, m.revision, me.evidence_id
FROM memory_evidence AS me
JOIN memories AS m ON m.owner_id = me.owner_id AND m.scope_id = me.scope_id AND m.id = me.memory_id
JOIN memory_versions AS v ON v.owner_id = m.owner_id AND v.scope_id = m.scope_id
  AND v.memory_id = m.id AND v.revision = m.revision
ON CONFLICT DO NOTHING;

ALTER TABLE memory_version_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_version_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON memory_version_evidence
  USING (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]))
  WITH CHECK (owner_id = nullif(current_setting('app.owner_id', true), '')::uuid
    AND scope_id = ANY(coalesce(nullif(current_setting('app.scope_ids', true), ''), '{}')::uuid[]));

GRANT SELECT, INSERT, UPDATE, DELETE ON memory_version_evidence TO thymesis_app;
