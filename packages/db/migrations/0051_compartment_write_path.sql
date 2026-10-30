-- Memory compartments, write path (ADR 0006, design units U3 and U5). The service now sets a
-- label on every row it writes, so new rows must carry one explicitly. This migration also
-- records how each version's label was set, lets the feed tell a reader that a memory left its
-- allowance, keys subject names by label, lets an allowance change commit in the transaction
-- that makes it, and adds the definer functions that must not depend on the caller's context.

-- How a version's label was set. Existing versions predate labels.
ALTER TABLE public.memory_versions
  ADD COLUMN label_origin text NOT NULL DEFAULT 'legacy'
  CONSTRAINT memory_versions_label_origin_check CHECK (label_origin IN (
    'legacy', 'explicit', 'default', 'held', 'inherited', 'derived', 'reclassified', 'relaxed',
    'imported'
  ));
ALTER TABLE public.memory_versions ALTER COLUMN label_origin DROP DEFAULT;

-- A narrowing event keeps the label it narrowed from, so a reader that lost the memory can be
-- told so without seeing anything else.
ALTER TABLE public.change_log
  ADD COLUMN previous_compartment_ids uuid[]
  CONSTRAINT change_log_previous_compartment_ids_canonical CHECK (
    previous_compartment_ids IS NULL OR app.is_canonical_compartment_label(previous_compartment_ids)
  );

-- A configured source carries the label its captured observations receive. Existing
-- configurations are Unclassified, like every earlier record.
ALTER TABLE public.connector_authorizations
  ADD COLUMN compartment_ids uuid[] NOT NULL DEFAULT '{00000000-0000-4000-8000-000000000001}'::uuid[]
  CONSTRAINT connector_authorizations_compartment_ids_canonical
  CHECK (app.is_canonical_compartment_label(compartment_ids));

-- Every new row needs an explicit label from now on.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sources', 'observations', 'episodes', 'evidence', 'subjects', 'subject_aliases',
    'memories', 'memory_versions', 'changesets', 'change_log', 'curation_reviews',
    'change_confirmations', 'idempotency_keys', 'connector_authorizations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN compartment_ids DROP DEFAULT', table_name);
  END LOOP;
END
$$;

-- A stable text key for a canonical label, usable in indexes and exclusion constraints.
CREATE FUNCTION app.compartment_key(label uuid[])
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$ SELECT array_to_string(label, ',') $$;

REVOKE ALL ON FUNCTION app.compartment_key(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.compartment_key(uuid[])
  TO memory_app, memory_worker, memory_purge_executor, memory_authority_executor;

-- The same person or project can exist under different labels without revealing either.
ALTER TABLE public.subjects DROP CONSTRAINT subjects_owner_id_scope_id_normalized_name_key;
CREATE UNIQUE INDEX subjects_label_name_idx
  ON public.subjects(user_id, scope_id, compartment_ids, normalized_name);
ALTER TABLE public.subject_aliases
  DROP CONSTRAINT subject_aliases_owner_id_scope_id_normalized_alias_tstzran_excl;
ALTER TABLE public.subject_aliases
  ADD CONSTRAINT subject_aliases_label_alias_excl EXCLUDE USING gist (
    user_id WITH =,
    scope_id WITH =,
    (app.compartment_key(compartment_ids)) WITH =,
    normalized_alias WITH =,
    tstzrange(valid_from, coalesce(valid_to, 'infinity'::timestamptz), '[)') WITH &&
  );

-- An allowance change records its transaction, so the commit revalidation of the connection
-- that changed it accepts the new epoch it wrote itself.
ALTER TABLE public.connection_allowances ADD COLUMN changed_by_transaction xid8;
GRANT UPDATE (changed_by_transaction) ON public.connection_allowances TO memory_app;

DROP FUNCTION app.lock_connection_allowance(uuid, text, text, text);
CREATE FUNCTION app.lock_connection_allowance(
  p_user_id uuid,
  p_external_issuer text,
  p_external_subject text,
  p_connection_id text
)
RETURNS TABLE(epoch bigint, compartment_ids uuid[], changed_here boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a.epoch,
    ARRAY(
      SELECT c.id FROM public.compartments AS c
      WHERE c.user_id = a.user_id AND c.id = ANY(a.compartment_ids)
      ORDER BY c.id
    ),
    a.changed_by_transaction IS NOT DISTINCT FROM pg_current_xact_id()
  FROM public.connection_allowances AS a
  WHERE a.user_id = p_user_id
    AND a.external_issuer = p_external_issuer
    AND a.external_subject = p_external_subject
    AND a.connection_id = p_connection_id
  FOR SHARE OF a
$$;
ALTER FUNCTION app.lock_connection_allowance(uuid, text, text, text) OWNER TO memory_auth_lookup;
REVOKE ALL ON FUNCTION app.lock_connection_allowance(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_connection_allowance(uuid, text, text, text) TO memory_app;

-- Every compartment of the user, for worker and system work, which needs the explicit list
-- before any compartment context exists.
CREATE FUNCTION app.user_compartment_ids(p_user_id uuid)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(array_agg(c.id ORDER BY c.id), '{}'::uuid[])
  FROM public.compartments AS c WHERE c.user_id = p_user_id
$$;
ALTER FUNCTION app.user_compartment_ids(uuid) OWNER TO memory_auth_lookup;
REVOKE ALL ON FUNCTION app.user_compartment_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.user_compartment_ids(uuid) TO memory_app, memory_worker;

-- Compartments named by a request to widen an allowance. The caller already named them, so the
-- answer reveals only whether those names exist.
CREATE FUNCTION app.resolve_compartment_names(p_user_id uuid, p_normalized_names text[])
RETURNS TABLE(id uuid, name text, normalized_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.name, c.normalized_name FROM public.compartments AS c
  WHERE c.user_id = p_user_id AND c.normalized_name = ANY(p_normalized_names)
  ORDER BY c.id
$$;
ALTER FUNCTION app.resolve_compartment_names(uuid, text[]) OWNER TO memory_auth_lookup;
REVOKE ALL ON FUNCTION app.resolve_compartment_names(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_compartment_names(uuid, text[]) TO memory_app;

-- Whether any evidence of a version, including evidence the reader cannot see, is denied by
-- current source rights or Forget. A declassified version must still disappear when a withheld
-- source is revoked.
GRANT SELECT ON public.memory_version_evidence, public.evidence, public.sources,
  public.suppressions TO memory_auth_lookup;
CREATE FUNCTION app.version_rights_denied(
  p_user_id uuid,
  p_scope_id uuid,
  p_memory_id uuid,
  p_revision integer
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memory_version_evidence AS mve
    JOIN public.evidence AS e
      ON e.user_id = mve.user_id AND e.scope_id = mve.scope_id AND e.id = mve.evidence_id
    JOIN public.sources AS s
      ON s.user_id = e.user_id AND s.scope_id = e.scope_id AND s.id = e.source_id
    WHERE mve.user_id = p_user_id AND mve.scope_id = p_scope_id
      AND mve.memory_id = p_memory_id AND mve.revision = p_revision
      AND (s.rights_status <> 'granted' OR NOT s.consent
        OR EXISTS (SELECT 1 FROM public.suppressions AS sp
          WHERE sp.user_id = s.user_id AND sp.scope_id = s.scope_id
            AND sp.object_id IN (p_memory_id, s.id, e.id)))
  )
$$;
ALTER FUNCTION app.version_rights_denied(uuid, uuid, uuid, integer) OWNER TO memory_auth_lookup;
REVOKE ALL ON FUNCTION app.version_rights_denied(uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.version_rights_denied(uuid, uuid, uuid, integer)
  TO memory_app, memory_worker;

-- A connection can ask for a wider allowance; the binding's approval policy decides it.
ALTER TABLE public.change_confirmations DROP CONSTRAINT change_confirmations_operation_check;
ALTER TABLE public.change_confirmations ADD CONSTRAINT change_confirmations_operation_check
  CHECK (operation IN (
    'commit_changeset', 'forget', 'decide_review', 'change_source_rights', 'change_scope_grant',
    'set_retention_policy', 'configure_source', 'change_connection_allowance'
  ));
