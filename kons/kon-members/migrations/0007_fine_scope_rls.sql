-- 0007 — Fine scopes open row security the way they open the route
-- ============================================================================
-- Idempotent: policies are dropped and recreated by name.
--
-- An agent key with only a fine scope (`kon:members:list-members`) passed the operation check but
-- row security on `members` and `member_access` only knew `member:view|create|update|delete`,
-- `members:*`, `kon:members:*` and `admin`: the list came back empty and records answered 404.
-- Each fine scope now opens the rows its operation touches, through the core's
-- `kitsuden_agent_can_in_kon` (a denial of the scope or of the whole kon still wins):
--
--   members        read: list-members, get-member        write: gift-access (marks the member comped)
--   member_access  read: get-member                      write: gift-access, revoke-access
--
-- The rest of each policy is the same as 0006. `member_signins` and `member_sessions` stay system-only.

DO $$
DECLARE
  base CONSTANT text :=
    '((COALESCE(current_setting(''app.current_user_role''::text, true), ''''::text) = ''''::text) '
    || 'AND (COALESCE(current_setting(''app.current_user_id''::text, true), ''''::text) = ''''::text)) '
    || 'OR kitsuden_effective_staff(''members''::text) '
    || 'OR kitsuden_agent_can_in_kon(''members''::text, ''member:view''::text) '
    || 'OR kitsuden_agent_can_in_kon(''members''::text, ''member:create''::text) '
    || 'OR kitsuden_agent_can_in_kon(''members''::text, ''member:update''::text) '
    || 'OR kitsuden_agent_can_in_kon(''members''::text, ''member:delete''::text)';
  members_reads CONSTANT text :=
    'kitsuden_agent_can_in_kon(''members''::text, ''kon:members:list-members''::text) '
    || 'OR kitsuden_agent_can_in_kon(''members''::text, ''kon:members:get-member''::text)';
  members_writes CONSTANT text :=
    'kitsuden_agent_can_in_kon(''members''::text, ''kon:members:gift-access''::text)';
  access_reads CONSTANT text :=
    'kitsuden_agent_can_in_kon(''members''::text, ''kon:members:get-member''::text)';
  access_writes CONSTANT text :=
    'kitsuden_agent_can_in_kon(''members''::text, ''kon:members:gift-access''::text) '
    || 'OR kitsuden_agent_can_in_kon(''members''::text, ''kon:members:revoke-access''::text)';
  t record;
  everyone text;
  writers text;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('members', members_reads, members_writes),
    ('member_access', access_reads, access_writes)
  ) AS v(tbl, reads, writes) LOOP
    writers := format('(%s) OR %s', base, t.writes);
    everyone := format('(%s) OR %s OR %s', base, t.reads, t.writes);

    -- Who may write (and read): the team, the broad scopes and the fine scopes that write.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_allow', t.tbl);
    EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL USING (%s) WITH CHECK (%s)',
      t.tbl || '_allow', t.tbl, writers, writers);

    -- Fine scopes that only read.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_fine_reads', t.tbl);
    EXECUTE format('CREATE POLICY %I ON %I AS PERMISSIVE FOR SELECT USING (%s)',
      t.tbl || '_fine_reads', t.tbl, t.reads);

    -- The restrictive gate: nobody outside this list, whatever another policy says.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tbl || '_team_only', t.tbl);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)',
      t.tbl || '_team_only', t.tbl, everyone, everyone);
  END LOOP;
END $$;

-- The default free tier was seeded with a Spanish name. Rename it only where nobody changed it.
UPDATE member_tiers SET name = 'Free', updated_at = now() WHERE id = 'tier_free' AND name = 'Gratis';
