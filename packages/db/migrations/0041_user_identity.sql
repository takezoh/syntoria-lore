-- User identity names change in place. UUIDs, grants, authority provenance,
-- signed cursor v1 fields and separately governed deletion-ledger bytes do not.
-- Function and policy definitions are captured from the installed schema so a
-- forward migration preserves the exact preceding fixes and effective grants.
CREATE TEMP TABLE migration_user_functions ON COMMIT DROP AS
SELECT p.oid, p.oid::regprocedure::text AS signature,
  pg_get_functiondef(p.oid) AS definition, pg_get_userbyid(p.proowner) AS db_owner,
  coalesce(p.proacl, acldefault('f', p.proowner)) AS privileges
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='app' AND p.prokind='f';

CREATE TEMP TABLE migration_user_triggers ON COMMIT DROP AS
SELECT t.oid AS trigger_oid,t.tgrelid, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE NOT t.tgisinternal AND n.nspname='app';

CREATE TEMP TABLE migration_user_policies ON COMMIT DROP AS
SELECT p.oid AS policy_oid,p.polrelid, p.polname, p.polpermissive, p.polcmd, p.polroles,
  pg_get_expr(p.polqual,p.polrelid) AS using_expression,
  pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';

CREATE TEMP TABLE migration_user_checks ON COMMIT DROP AS
SELECT c.conrelid, c.conname, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname='public' AND c.contype='c' AND position('owner' IN pg_get_constraintdef(c.oid))>0;

CREATE FUNCTION pg_temp.user_provenance(value jsonb) RETURNS jsonb
LANGUAGE plpgsql STRICT AS $codec$
DECLARE result jsonb; item record;
BEGIN
  IF jsonb_typeof(value)<>'object' THEN RETURN value; END IF;
  result:='{}'::jsonb;
  FOR item IN SELECT * FROM jsonb_each(value) LOOP
    IF item.key IN ('actor_kind','authority','confirmation','confirmation_type','origin_actor_kind','origin_authority') THEN
      result:=result || jsonb_build_object(item.key, CASE item.value
        WHEN '"owner"'::jsonb THEN '"user"'::jsonb
        WHEN '"owner_decision"'::jsonb THEN '"user_decision"'::jsonb
        WHEN '"owner_preference"'::jsonb THEN '"user_preference"'::jsonb
        WHEN '"owner_assertion"'::jsonb THEN '"user_assertion"'::jsonb
        WHEN '"owner_statement"'::jsonb THEN '"user_statement"'::jsonb ELSE item.value END);
    ELSIF item.key='origin_owner_id' THEN result:=result || jsonb_build_object('origin_user_id',item.value);
    ELSE result:=result || jsonb_build_object(item.key,item.value); END IF;
  END LOOP;
  RETURN result;
END $codec$;

CREATE FUNCTION pg_temp.user_definition(value text) RETURNS text LANGUAGE sql AS $codec$
 SELECT replace(replace(replace(replace(replace(replace(replace(replace(
 value,'owner_id','user_id'),'public.owners','public.users'),'FROM owners','FROM users'),
 'owner_confirmations','user_confirmations'),'''owner''','''user'''),
 'owner_decision','user_decision'),'owner_preference','user_preference'),'owner_assertion','user_assertion')
$codec$;

DO $migration$
DECLARE item record; role_entry record; statement text; definition text;
  role_names text; command_name text; signature text; had_create boolean;
BEGIN
  -- Refuse unexpected dependants instead of allowing CASCADE to remove them.
  IF EXISTS (
    SELECT 1 FROM pg_depend d JOIN migration_user_functions f ON f.oid=d.refobjid
    WHERE d.refclassid='pg_proc'::regclass AND d.deptype='n'
      AND NOT (d.classid='pg_proc'::regclass AND d.objid IN (SELECT oid FROM migration_user_functions))
      AND NOT (d.classid='pg_trigger'::regclass AND d.objid IN (SELECT trigger_oid FROM migration_user_triggers))
      AND NOT (d.classid='pg_policy'::regclass AND d.objid IN (SELECT policy_oid FROM migration_user_policies))
  ) THEN RAISE EXCEPTION 'Unexpected dependency on application functions'; END IF;

  FOR item IN SELECT * FROM migration_user_policies LOOP
    EXECUTE format('DROP POLICY %I ON %s',item.polname,item.polrelid::regclass);
  END LOOP;
  FOR item IN SELECT * FROM migration_user_triggers LOOP
    EXECUTE format('DROP TRIGGER %I ON %s',item.tgname,item.tgrelid::regclass);
  END LOOP;
  FOR item IN SELECT * FROM migration_user_checks LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.conrelid::regclass,item.conname);
  END LOOP;
  FOR item IN SELECT * FROM migration_user_functions LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || item.signature || ' CASCADE';
  END LOOP;
  FOR item IN
    SELECT c.oid,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relkind='r' AND a.attname='owner_id' AND NOT a.attisdropped
  LOOP EXECUTE format('ALTER TABLE %s RENAME COLUMN owner_id TO user_id',item.oid::regclass); END LOOP;
  ALTER TABLE public.owners RENAME TO users;
  ALTER TABLE public.owner_confirmations RENAME TO user_confirmations;
  FOR item IN
    SELECT c.oid,c.relname,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
  LOOP
    IF item.relforcerowsecurity THEN EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY',item.oid::regclass); END IF;
    FOR role_entry IN SELECT a.attname,t.typname FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
      WHERE a.attrelid=item.oid AND a.attnum>0 AND NOT a.attisdropped
        AND (a.attname IN ('actor_kind','authority','confirmation','confirmation_type') OR (item.relname,a.attname) IN (('changesets','response'),('idempotency_keys','response'),('memories','import_provenance'),('memory_versions','origin_provenance')))
    LOOP
      IF role_entry.typname='jsonb' THEN
        EXECUTE format('UPDATE %s SET %I=pg_temp.user_provenance(%I) WHERE %I IS DISTINCT FROM pg_temp.user_provenance(%I)',item.oid::regclass,role_entry.attname,role_entry.attname,role_entry.attname,role_entry.attname);
      ELSE
        EXECUTE format('UPDATE %s SET %I=CASE %I WHEN %L THEN %L WHEN %L THEN %L WHEN %L THEN %L WHEN %L THEN %L WHEN %L THEN %L ELSE %I END WHERE %I IN (%L,%L,%L,%L,%L)',
          item.oid::regclass,role_entry.attname,role_entry.attname,'owner','user','owner_decision','user_decision','owner_preference','user_preference','owner_assertion','user_assertion','owner_statement','user_statement',role_entry.attname,role_entry.attname,'owner','owner_decision','owner_preference','owner_assertion','owner_statement');
      END IF;
    END LOOP;
    IF item.relforcerowsecurity THEN EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',item.oid::regclass); END IF;
  END LOOP;
  FOR item IN SELECT * FROM migration_user_checks LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item.conrelid::regclass,replace(item.conname,'owner','user'),replace(pg_temp.user_definition(item.definition),'owner_statement','user_statement'));
  END LOOP;

  -- Body checking is deferred until all mutually-referencing routines exist.
  PERFORM set_config('check_function_bodies','off',true);
  FOR item IN SELECT * FROM migration_user_functions ORDER BY oid LOOP
    definition := replace(pg_temp.user_definition(item.definition),'owner_statement','user_statement');
    EXECUTE definition;
    signature := replace(item.signature,'owner_id','user_id');
    EXECUTE 'REVOKE ALL ON FUNCTION ' || signature || ' FROM PUBLIC';
    FOR role_entry IN SELECT * FROM aclexplode(item.privileges) LOOP
      role_names := CASE WHEN role_entry.grantee=0 THEN 'PUBLIC'
        ELSE quote_ident(pg_get_userbyid(role_entry.grantee)) END;
      EXECUTE 'GRANT ' || role_entry.privilege_type || ' ON FUNCTION ' || signature ||
        ' TO ' || role_names || CASE WHEN role_entry.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END;
    END LOOP;
    had_create := has_schema_privilege(item.db_owner,'app','CREATE');
    IF NOT had_create THEN EXECUTE format('GRANT CREATE ON SCHEMA app TO %I',item.db_owner); END IF;
    EXECUTE 'ALTER FUNCTION ' || signature || ' OWNER TO ' || quote_ident(item.db_owner);
    IF NOT had_create THEN EXECUTE format('REVOKE CREATE ON SCHEMA app FROM %I',item.db_owner); END IF;
  END LOOP;
  FOR item IN SELECT * FROM migration_user_triggers LOOP
    EXECUTE pg_temp.user_definition(item.definition);
    IF item.tgenabled='D' THEN command_name:='DISABLE';
    ELSIF item.tgenabled='A' THEN command_name:='ENABLE ALWAYS';
    ELSIF item.tgenabled='R' THEN command_name:='ENABLE REPLICA'; ELSE command_name:='ENABLE'; END IF;
    EXECUTE format('ALTER TABLE %s %s TRIGGER %I',item.tgrelid::regclass,command_name,item.tgname);
  END LOOP;
  FOR item IN SELECT * FROM migration_user_policies LOOP
    SELECT string_agg(CASE WHEN id=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(id)) END,',')
      INTO role_names FROM unnest(item.polroles) id;
    command_name:=CASE item.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
      WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END;
    statement:=format('CREATE POLICY %I ON %s AS %s FOR %s TO %s',item.polname,item.polrelid::regclass,
      CASE WHEN item.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,command_name,role_names);
    IF item.using_expression IS NOT NULL THEN
      statement:=statement || ' USING (' || pg_temp.user_definition(item.using_expression) || ')'; END IF;
    IF item.check_expression IS NOT NULL THEN
      statement:=statement || ' WITH CHECK (' || pg_temp.user_definition(item.check_expression) || ')'; END IF;
    EXECUTE statement;
  END LOOP;
END
$migration$;
