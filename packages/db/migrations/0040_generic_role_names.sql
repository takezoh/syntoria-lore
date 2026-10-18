-- Role names are renamed in place so role OIDs, credentials, grants and
-- security-definer ownership stay attached to the same PostgreSQL roles.
-- The source prefix is supplied only by the explicit migration deployment
-- configuration; historical migration bytes are intentionally untouched.
DO $migration$
DECLARE
  source_prefix text := current_setting('memory.role_source_prefix', true);
  role_suffix text;
  source_name text;
  target_name text;
  source_present boolean;
  target_present boolean;
  routine record;
  policy record;
  definition text;
  policy_sql text;
  routine_schema text;
  routine_owner text;
  owner_had_schema_create boolean;
  role_switched boolean;
BEGIN
  IF source_prefix IS NULL OR source_prefix !~ '^[a-z][a-z0-9_]{0,20}$' THEN
    RAISE EXCEPTION 'A valid role source prefix must be configured for migration 0040';
  END IF;

  FOREACH role_suffix IN ARRAY ARRAY[
    'admin',
    'app',
    'auth_lookup',
    'authority_executor',
    'purge_executor',
    'worker',
    'worker_login',
    'identity'
  ] LOOP
    source_name := source_prefix || '_' || role_suffix;
    target_name := 'memory_' || role_suffix;
    IF length(source_name) > 63 THEN
      RAISE EXCEPTION 'Configured source role name exceeds PostgreSQL limits';
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = source_name
    ) INTO source_present;
    SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = target_name
    ) INTO target_present;

    IF source_present AND target_present THEN
      RAISE EXCEPTION 'Both source and target database roles exist for suffix %', role_suffix;
    END IF;
    IF source_present THEN
      EXECUTE format('ALTER ROLE %I RENAME TO %I', source_name, target_name);
    END IF;

    FOR routine IN
      SELECT p.oid,
        pg_catalog.pg_get_functiondef(p.oid) AS definition,
        n.nspname AS schema_name,
        pg_catalog.pg_get_userbyid(p.proowner) AS owner_name
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prokind IN ('f', 'p')
        AND position(source_name IN p.prosrc) > 0
    LOOP
      definition := replace(routine.definition, source_name, target_name);
      routine_schema := routine.schema_name;
      routine_owner := routine.owner_name;
      owner_had_schema_create := pg_catalog.has_schema_privilege(
        routine_owner, routine_schema, 'CREATE'
      );
      IF NOT owner_had_schema_create THEN
        EXECUTE format('GRANT CREATE ON SCHEMA %I TO %I', routine_schema, routine_owner);
      END IF;
      role_switched := false;
      IF routine_owner <> current_user THEN
        EXECUTE format('SET LOCAL ROLE %I', routine_owner);
        role_switched := true;
      END IF;
      EXECUTE definition;
      IF role_switched THEN
        EXECUTE 'RESET ROLE';
      END IF;
      IF NOT owner_had_schema_create THEN
        EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', routine_schema, routine_owner);
      END IF;
    END LOOP;

    FOR policy IN
      SELECT p.polname, p.polrelid,
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expression,
        pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
      FROM pg_catalog.pg_policy p
      WHERE position(source_name IN coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')) > 0
         OR position(source_name IN coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0
    LOOP
      policy_sql := format('ALTER POLICY %I ON %s', policy.polname, policy.polrelid::regclass);
      IF policy.using_expression IS NOT NULL THEN
        policy_sql := policy_sql || format(
          ' USING (%s)', replace(policy.using_expression, source_name, target_name)
        );
      END IF;
      IF policy.check_expression IS NOT NULL THEN
        policy_sql := policy_sql || format(
          ' WITH CHECK (%s)', replace(policy.check_expression, source_name, target_name)
        );
      END IF;
      EXECUTE policy_sql;
    END LOOP;
  END LOOP;

  FOREACH role_suffix IN ARRAY ARRAY[
    'admin',
    'app',
    'auth_lookup',
    'authority_executor',
    'purge_executor',
    'worker',
    'worker_login',
    'identity'
  ] LOOP
    source_name := source_prefix || '_' || role_suffix;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.prokind IN ('f', 'p') AND position(source_name IN p.prosrc) > 0
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
      WHERE position(source_name IN coalesce(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '')) > 0
         OR position(source_name IN coalesce(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')) > 0
    ) THEN
      RAISE EXCEPTION 'A database routine or policy still contains a source role name';
    END IF;
  END LOOP;

  FOREACH role_suffix IN ARRAY ARRAY[
    'app',
    'auth_lookup',
    'authority_executor',
    'purge_executor',
    'worker'
  ] LOOP
    target_name := 'memory_' || role_suffix;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = target_name
    ) THEN
      RAISE EXCEPTION 'Required target database role is missing for suffix %', role_suffix;
    END IF;
  END LOOP;
END
$migration$;
