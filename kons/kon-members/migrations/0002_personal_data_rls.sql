-- 0002 — Database wall for members' personal data
-- ============================================================================
-- Idempotent: DROP POLICY IF EXISTS before every CREATE.
--
-- WHY
--
-- `members` is the business's mailing list, and `member_sessions` /
-- `member_signins` are access keys (hashed). Until now only the kon's routes
-- protected them: any generic surface that some day let a normal session read
-- tables (`/api/items`, the explorer, GraphQL… it already happened with all
-- three) would have served them whole, because they had no RLS. Account
-- sign-up is public: "has a session" does not mean "is on the team".
--
-- WHO GETS THROUGH
--
-- The context is set by `withTransactionalRLS()` on the routes that mount it:
-- `app.current_user_role` = the account's role, or `anonymous`.
--
--   · No context ('' or NULL): the system itself. The kon's routes, the
--     migrations and the payment webhooks run like this, and they have to keep
--     working. It is the same criterion as the rest of the repo's policies.
--   · `admin` / `editor`: the team, which is who manages members in the panel
--     (the kon's `member` policy says the same).
--   · Any other role, `anonymous` included: NOTHING.
--
-- WATCH OUT for `anonymous`: in the repo's ownership policies, an anonymous user
-- with a context carries `current_user_id = ''`, which is the system hatch, and
-- gets through. Here the ROLE is checked, and for anonymous users it is NOT empty.
--
-- Sessions and magic links are not readable even by the team: only by the system.
--
-- RESTRICTIVE, on top of the permissive one: Postgres combines (OR) the
-- permissive policies, so a more open policy that someone adds tomorrow to one
-- of these tables would open it completely. A restrictive one is ALWAYS enforced (AND).

DO $$
DECLARE
  t RECORD;
  quien TEXT;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('members',         'equipo'),
      ('member_access',   'equipo'),
      ('member_signins',  'sistema'),
      ('member_sessions', 'sistema')
    ) AS x(tabla, alcance)
  LOOP
    IF to_regclass('public.' || t.tabla) IS NULL THEN
      CONTINUE;
    END IF;

    quien := CASE t.alcance
      WHEN 'equipo' THEN
        $Q$coalesce(current_setting('app.current_user_role', true), '') IN ('', 'admin', 'editor')$Q$
      ELSE
        $Q$coalesce(current_setting('app.current_user_role', true), '') = ''$Q$
    END;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tabla);
    -- Without FORCE, if the app role owns the table it is exempt.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tabla);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tabla || '_permitir', t.tabla);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t.tabla || '_permitir', t.tabla, quien, quien);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t.tabla || '_solo_' || t.alcance, t.tabla);
    EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      t.tabla || '_solo_' || t.alcance, t.tabla, quien, quien);
  END LOOP;
END $$;
