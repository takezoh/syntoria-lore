-- Records which Gate client registration wrote each changeset. Provenance only:
-- no authorization rule reads it. Existing rows keep NULL because their client is unknown.
ALTER TABLE public.changesets
  ADD COLUMN client_id text
    CONSTRAINT changesets_client_id_check
    CHECK (client_id IS NULL OR (length(client_id) BETWEEN 1 AND 4096 AND client_id !~ '[[:cntrl:]]'));
