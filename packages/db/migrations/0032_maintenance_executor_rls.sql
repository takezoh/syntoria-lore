DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'scopes', 'principals', 'grants', 'sources', 'observations', 'episodes', 'evidence',
    'memories', 'memory_evidence', 'memory_version_evidence', 'scope_retention_policies',
    'feedback_reassessments', 'audit_events'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY governance_maintenance_executor ON public.%I USING (current_user = ''thymesis_purge_executor'') WITH CHECK (current_user = ''thymesis_purge_executor'')',
      table_name
    );
  END LOOP;
END
$$;
