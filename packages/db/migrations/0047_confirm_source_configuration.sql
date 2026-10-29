-- Enabling or disabling a capture source changes the person's consent, so a connection requests
-- it through a Gate confirmation like other protected changes.
ALTER TABLE public.change_confirmations
  DROP CONSTRAINT change_confirmations_operation_check,
  ADD CONSTRAINT change_confirmations_operation_check CHECK (operation IN (
    'commit_changeset', 'forget', 'decide_review', 'change_source_rights',
    'change_scope_grant', 'set_retention_policy', 'configure_source'
  ));
