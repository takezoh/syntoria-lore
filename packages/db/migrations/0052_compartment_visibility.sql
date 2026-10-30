-- Memory compartments, database enforcement (ADR 0006, design unit U6). Every service now sets
-- `app.compartment_ids` through one helper. These restrictive policies combine with the existing
-- permissive tenant and scope policies, so the application and worker roles can read or write a
-- labeled row only when its label is within that context. An unset context is the empty set:
-- only General rows remain visible. Purge, maintenance, export-executor and lookup roles keep
-- their own policies and are not restricted here.

CREATE FUNCTION app.current_compartment_ids()
RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(nullif(current_setting('app.compartment_ids', true), ''), '{}')::uuid[]
$$;
REVOKE ALL ON FUNCTION app.current_compartment_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_compartment_ids() TO memory_app, memory_worker;

-- Rows that carry their own label.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sources', 'observations', 'episodes', 'evidence', 'subjects', 'subject_aliases',
    'memories', 'changesets', 'curation_reviews', 'change_confirmations', 'idempotency_keys',
    'connector_authorizations'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY compartment_visibility ON public.%I AS RESTRICTIVE TO memory_app, memory_worker USING (compartment_ids <@ app.current_compartment_ids()) WITH CHECK (compartment_ids <@ app.current_compartment_ids())',
      table_name
    );
  END LOOP;
END
$$;

-- A version is visible only while its memory is: narrowing a memory hides its whole history.
CREATE POLICY compartment_visibility ON public.memory_versions AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (
    compartment_ids <@ app.current_compartment_ids()
    AND EXISTS (
      SELECT 1 FROM public.memories AS m
      WHERE m.user_id = memory_versions.user_id AND m.scope_id = memory_versions.scope_id
        AND m.id = memory_versions.memory_id
    )
  )
  WITH CHECK (compartment_ids <@ app.current_compartment_ids());

-- A feed event is visible under its label, or, for a narrowing, under the label it narrowed
-- from, so the reader learns that the memory left its allowance.
CREATE POLICY compartment_visibility ON public.change_log AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (
    compartment_ids <@ app.current_compartment_ids()
    OR (previous_compartment_ids IS NOT NULL
      AND previous_compartment_ids <@ app.current_compartment_ids())
  )
  WITH CHECK (compartment_ids <@ app.current_compartment_ids());

-- Links and derived rows follow the rows they connect. Evidence links follow the memory or
-- version only, so a declassified version keeps its withheld evidence.
CREATE POLICY compartment_visibility ON public.memory_subjects AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (
    EXISTS (SELECT 1 FROM public.memories AS m WHERE m.user_id = memory_subjects.user_id
      AND m.scope_id = memory_subjects.scope_id AND m.id = memory_subjects.memory_id)
    AND EXISTS (SELECT 1 FROM public.subjects AS s WHERE s.user_id = memory_subjects.user_id
      AND s.scope_id = memory_subjects.scope_id AND s.id = memory_subjects.subject_id)
  );

CREATE POLICY compartment_visibility ON public.memory_evidence AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (EXISTS (SELECT 1 FROM public.memories AS m WHERE m.user_id = memory_evidence.user_id
    AND m.scope_id = memory_evidence.scope_id AND m.id = memory_evidence.memory_id));

CREATE POLICY compartment_visibility ON public.memory_version_evidence AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (EXISTS (SELECT 1 FROM public.memory_versions AS v
    WHERE v.user_id = memory_version_evidence.user_id
      AND v.scope_id = memory_version_evidence.scope_id
      AND v.memory_id = memory_version_evidence.memory_id
      AND v.revision = memory_version_evidence.revision));

CREATE POLICY compartment_visibility ON public.relations AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (
    EXISTS (SELECT 1 FROM public.memories AS m WHERE m.user_id = relations.user_id
      AND m.scope_id = relations.scope_id AND m.id = relations.from_memory_id)
    AND EXISTS (SELECT 1 FROM public.memories AS m WHERE m.user_id = relations.user_id
      AND m.scope_id = relations.scope_id AND m.id = relations.to_memory_id)
  );

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['embeddings', 'memory_embeddings', 'feedback'] LOOP
    EXECUTE format(
      'CREATE POLICY compartment_visibility ON public.%1$I AS RESTRICTIVE TO memory_app, memory_worker USING (EXISTS (SELECT 1 FROM public.memories AS m WHERE m.user_id = %1$I.user_id AND m.scope_id = %1$I.scope_id AND m.id = %1$I.memory_id))',
      table_name
    );
  END LOOP;
END
$$;

CREATE POLICY compartment_visibility ON public.change_ops AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (EXISTS (SELECT 1 FROM public.changesets AS c WHERE c.user_id = change_ops.user_id
    AND c.scope_id = change_ops.scope_id AND c.id = change_ops.change_set_id));

CREATE POLICY compartment_visibility ON public.capture_jobs AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (EXISTS (SELECT 1 FROM public.sources AS s WHERE s.user_id = capture_jobs.user_id
    AND s.scope_id = capture_jobs.scope_id AND s.id = capture_jobs.source_id));

CREATE POLICY compartment_visibility ON public.capture_job_observations AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (EXISTS (SELECT 1 FROM public.observations AS o
    WHERE o.user_id = capture_job_observations.user_id
      AND o.scope_id = capture_job_observations.scope_id
      AND o.id = capture_job_observations.observation_id));

CREATE POLICY compartment_visibility ON public.user_confirmations AS RESTRICTIVE
  TO memory_app, memory_worker
  USING (NOT EXISTS (
    SELECT 1 FROM unnest(user_confirmations.memory_ids) AS target(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.memories AS m WHERE m.user_id = user_confirmations.user_id
      AND m.scope_id = user_confirmations.scope_id AND m.id = target.id)
  ));

-- A compartment's name is visible only to connections that hold it. Creating a compartment is
-- an insert, which this read policy does not restrict.
CREATE POLICY compartment_visibility ON public.compartments AS RESTRICTIVE FOR SELECT
  TO memory_app, memory_worker
  USING (id = ANY(app.current_compartment_ids()));
