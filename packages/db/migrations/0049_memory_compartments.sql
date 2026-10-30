-- Memory compartments, schema only (ADR 0006, design unit U1). A compartment is one of the
-- user's confidentiality obligations; a label is the set of compartments a recipient needs.
-- This migration adds the compartments, the per-connection allowances and their history, and a
-- label on every table that stores memory, observation or source text. It changes no behavior:
-- existing and new rows are labeled with the reserved Unclassified compartment until the write
-- path sets labels, and no policy reads labels yet.

-- A label is canonical when it is one-dimensional, sorted, free of duplicates and nulls, and
-- bounded. The empty label is General.
CREATE FUNCTION app.is_canonical_compartment_label(label uuid[])
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT label IS NOT NULL
    AND coalesce(array_ndims(label), 1) = 1
    AND cardinality(label) <= 32
    AND array_position(label, NULL) IS NULL
    AND label = ARRAY(SELECT DISTINCT item FROM unnest(label) AS item ORDER BY item)
$$;

REVOKE ALL ON FUNCTION app.is_canonical_compartment_label(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_canonical_compartment_label(uuid[])
  TO memory_app, memory_worker, memory_purge_executor, memory_authority_executor;

CREATE TABLE public.compartments (
  user_id uuid NOT NULL REFERENCES public.users(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 100),
  reserved boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_by_client_id text CHECK (length(created_by_client_id) BETWEEN 1 AND 4096),
  created_by_connection_id text CHECK (length(created_by_connection_id) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, normalized_name),
  FOREIGN KEY (user_id, created_by) REFERENCES public.principals(user_id, id),
  -- Only the fixed Unclassified ID is reserved, and it is never created by a principal.
  CHECK (reserved = (id = '00000000-0000-4000-8000-000000000001'::uuid)),
  CHECK (NOT reserved OR created_by IS NULL)
);

-- Every existing user receives the reserved compartment that labels its earlier records.
INSERT INTO public.compartments (user_id, id, name, normalized_name, reserved)
SELECT id, '00000000-0000-4000-8000-000000000001'::uuid, 'Unclassified', 'unclassified', true
FROM public.users;

-- Every new user receives it in the same transaction. The context is set only for the insert and
-- then restored, so the trigger satisfies row-level security without leaking a user context.
CREATE FUNCTION app.create_reserved_compartment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_user text := current_setting('app.user_id', true);
BEGIN
  PERFORM set_config('app.user_id', NEW.id::text, true);
  INSERT INTO public.compartments (user_id, id, name, normalized_name, reserved)
  VALUES (NEW.id, '00000000-0000-4000-8000-000000000001'::uuid, 'Unclassified', 'unclassified', true);
  PERFORM set_config('app.user_id', coalesce(previous_user, ''), true);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app.create_reserved_compartment() FROM PUBLIC;
CREATE TRIGGER users_reserved_compartment
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION app.create_reserved_compartment();

-- The compartments one Gate connection may receive and write. A connection without a row has
-- General only. The epoch binds cursors and replays to one version of the allowance.
CREATE TABLE public.connection_allowances (
  user_id uuid NOT NULL REFERENCES public.users(id),
  external_issuer text NOT NULL CHECK (length(external_issuer) BETWEEN 1 AND 2048),
  external_subject text NOT NULL CHECK (length(external_subject) BETWEEN 1 AND 512),
  connection_id text NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 4096),
  compartment_ids uuid[] NOT NULL CHECK (app.is_canonical_compartment_label(compartment_ids)),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, external_issuer, external_subject, connection_id)
);

-- Append-only record of every allowance change, with the requesting connection and approval.
CREATE TABLE public.connection_allowance_events (
  user_id uuid NOT NULL REFERENCES public.users(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  external_issuer text NOT NULL CHECK (length(external_issuer) BETWEEN 1 AND 2048),
  external_subject text NOT NULL CHECK (length(external_subject) BETWEEN 1 AND 512),
  connection_id text NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 4096),
  change text NOT NULL CHECK (change IN ('create_compartment', 'narrow', 'widen')),
  previous_compartment_ids uuid[] NOT NULL
    CHECK (app.is_canonical_compartment_label(previous_compartment_ids)),
  compartment_ids uuid[] NOT NULL CHECK (app.is_canonical_compartment_label(compartment_ids)),
  epoch bigint NOT NULL CHECK (epoch > 0),
  requested_by uuid NOT NULL,
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 4096),
  approval text NOT NULL CHECK (approval IN ('none', 'policy', 'person')),
  confirmation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, requested_by) REFERENCES public.principals(user_id, id),
  -- Only widening needs an approval, and an approval names its confirmation.
  CHECK ((change = 'widen') = (approval <> 'none')),
  CHECK ((approval = 'none') = (confirmation_id IS NULL))
);

CREATE INDEX connection_allowance_events_connection_idx
  ON public.connection_allowance_events(user_id, external_issuer, external_subject, connection_id, created_at);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['compartments', 'connection_allowances', 'connection_allowance_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_user ON public.%I USING (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) WITH CHECK (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', table_name);
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON public.compartments TO memory_app;
GRANT SELECT ON public.compartments TO memory_worker;
GRANT SELECT, INSERT, UPDATE (compartment_ids, epoch, updated_at)
  ON public.connection_allowances TO memory_app;
GRANT SELECT, INSERT ON public.connection_allowance_events TO memory_app;

-- Labels on every table that stores memory, observation or source text, or a response or
-- summary containing it. Tables whose visibility follows a labeled parent (links, relations,
-- embeddings, feedback, change operations, capture bookkeeping) get no column. The constant
-- default labels existing rows without rewriting them and keeps the current service working.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sources', 'observations', 'episodes', 'evidence', 'subjects', 'subject_aliases',
    'memories', 'memory_versions', 'changesets', 'change_log', 'curation_reviews',
    'change_confirmations', 'idempotency_keys'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN compartment_ids uuid[] NOT NULL DEFAULT ''{00000000-0000-4000-8000-000000000001}''::uuid[] CONSTRAINT %I CHECK (app.is_canonical_compartment_label(compartment_ids))',
      table_name,
      table_name || '_compartment_ids_canonical'
    );
  END LOOP;
END
$$;
