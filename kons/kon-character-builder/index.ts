/**
 * @kitsuden/kon-character-builder
 * ============================================================================
 *
 * Character builders defined by DATA. A game's definition (slots,
 * options, budgets, formulas) is content; the engine is the same for
 * all. Setting up a new game's builder is uploading its definition.
 */

import {
  can,
  defineKonSdk,
  repo,
  operationsRouter,
  type AuthzUser,
  type AnyOperation,
} from "@kitsuden/engine";
import { FormulaError } from "@kitsuden/kon-formulas";
import { readDatasetCatalog, type KonContext } from "@kitsuden/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import { isBuilderTeam } from "./character-builder.policy.js";
import {
  datasetSlots,
  optionsFromEntries,
  withDatasetOptions,
} from "./character-builder.dataset.js";
import {
  compileBuilder,
  computeStats,
  decodeBuild,
  encodeBuild,
  isLinkBuilder,
  isValidLink,
  linkBuildProblem,
  subjectOfBuild,
  validateBuild,
  type Build,
  type BuilderDefinition,
  type SlotOption,
} from "./character-builder.engine.js";
import {
  builderBuildVotes,
  builderBuilds,
  builderDefinitions,
  type BuilderBuildRow,
} from "./character-builder.schema.js";
import {
  ANY_ACCOUNT,
  Row,
  KON_ID,
  Obj,
  ParamBuild,
  CodeParam,
  ParamSlug,
  query,
  registry,
  onTheResource,
  text,
} from "./operations.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./character-builder.engine.js";
export * from "./character-builder.schema.js";

/**
 * Build limits (an earlier audit): `/definitions/:slug/compute` is
 * anonymous and accepted any size; each fake id added a warning to the
 * response, and a 10 MB body returned tens of MB (quadratic with
 * groups). No real planner comes near this.
 */
const MAX_SLOTS = 100;
const MAX_IDS_PER_SLOT = 100;
const fewKeys = (max: number) => (o: Record<string, unknown>) => Object.keys(o).length <= max;

const BuildSchema = z.object({
  selections: z
    .record(z.string().max(120), z.array(z.string().max(200)).max(MAX_IDS_PER_SLOT))
    .refine(fewKeys(MAX_SLOTS), { message: `At most ${MAX_SLOTS} slots` }),
  attributes: z
    .record(z.string().max(120), z.number())
    .refine(fewKeys(MAX_SLOTS), { message: `At most ${MAX_SLOTS} attributes` })
    .optional(),
  /** The address that opens the build; its shape is checked by `isValidLink` */
  link: z.string().max(4001).optional(),
  label: z.string().max(80).optional(),
});

/** How many builds a person stores in a single planner */
const MAX_PER_PLANNER = 100;
/**
 * How many they store in TOTAL, and how many new ones per window.
 *
 * The per-planner cap limited nothing: "link" planners
 * are `link:<key>:<route>` and the path is written by the client, so each
 * invented path was a new planner with another 100. With public sign-up,
 * one account could fill the table (and the galleries) endlessly. The window is
 * generous on purpose: on sign-in, whatever is stored in the browser is uploaded all at once.
 */
export const MAX_BUILDS = { total: 1000, perWindow: 60, windowMs: 10 * 60_000 };
const VISIBILITY_WEIGHT = { private: 0, unlisted: 1, public: 2 } as const;
type Visibility = keyof typeof VISIBILITY_WEIGHT;

const SaveBuild = z.object({
  builderId: z.string().min(1).max(260),
  name: z.string().min(1).max(80).optional(),
  build: BuildSchema,
  visibility: z.enum(["private", "unlisted", "public"]).optional(),
});

/**
 * What its owner can change on an already saved build. Publishing is this:
 * setting `visibility` to `public`. Without this route, a build saved as private
 * could never come out — and saving as public at first forces a decision
 * before it is finished.
 */
const EditBuild = z.object({
  name: z.string().min(1).max(80).optional(),
  visibility: z.enum(["private", "unlisted", "public"]).optional(),
});

/**
 * The bodies of `/definitions` and `/definitions/validate`. They are only PUBLISHED
 * (OpenAPI, MCP): the handler validates them, and it answers its usual 400s
 * ("`slug` and `definition` are required") AFTER checking permission. If
 * the SDK validated them, an account without a role would get a 422 instead of its 403.
 */
const BuilderDefinitionValue = z
  .record(z.string(), z.unknown())
  .describe(
    "Builder definition: id, name, baseStats, slots (with options or optionsFrom a dataset), budgets and derived formulas"
  );
const ValidateDefinition = z
  .object({ definition: BuilderDefinitionValue.optional() })
  .passthrough()
  .optional();
const PublishDefinition = z
  .object({
    slug: z.string().optional().describe("Required. The builder's slug (upsert key)"),
    definition: BuilderDefinitionValue.optional().describe("Required. Compiled before saving"),
    published: z
      .string()
      .optional()
      .describe("draft | published. Anything else keeps the current state (a new one is a draft)"),
  })
  .passthrough()
  .optional();

/** `PUT /definitions` answers 201 on create and 200 on rewrite. */
const PUBLISH_OUTPUT = {
  schema: z.object({ data: Row }),
  otherStatuses: [201 as const],
  description: "Rewritten (200) or created (201)",
};

/** `POST /builds` answers 201 on create and 200 if that build was already saved. */
const SAVE_OUTPUT = {
  status: 201 as const,
  schema: z.object({ data: Row }),
  otherStatuses: [200 as const],
  description: "Created (201), or the same build already saved and updated (200)",
};

const PublicBuild = Row.extend({ voted: z.boolean() });

export function builderOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const db = ctx.db.instance;
  // What is done on behalf of others (other people's votes, the counter of a build
  // that is not yours): the asker's RLS does not allow it, and that is fine. It goes
  // as system, and ALWAYS after `can()`.
  const asSystem = ctx.db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

  /**
   * ── WHO REACHES EACH ROUTE (before, `app.use` by prefix) ───────────────
   *
   * Definitions are read without a session (the builder lives on a public
   * page); writing them requires a role. But READING also has to know
   * who is asking: with authentication skipped, `c.get("user")` was always
   * `null` and not even the author could open their draft. That is why reads
   * are `access: "optional"` (`optionalAuth`: resolves the session if there is one and
   * requires none), and not `"publico"`.
   *
   * COMPUTING does not require a session either: an anonymous visitor got a 401 when clicking
   * any option, so the website's builder served nobody without an
   * account. Computing writes nothing; which definition can be computed is
   * decided by the route with the same policy as reading.
   *
   * The build GALLERY, likewise: read without a session, and `optional` because the
   * list marks what YOU have voted and lets authors see their private builds.
   * Saving, editing, deleting and voting require a session (`access: "session"`).
   */

  /**
   * The definition with its datasets' options already inserted.
   * ==========================================================================
   *
   * It is called in ALL the places that compile — serve, compute and save —
   * and not in just one. If computing resolved the dataset and saving did not, a
   * perfectly valid build would be rejected on save with "that option
   * does not exist": the user would have chosen something the validator cannot see.
   *
   * The user is passed to `readDatasetCatalog`, which applies `checkReadAccess`.
   * On the compute route, which is public, that means only public
   * datasets get in — and that is right: an open builder cannot serve
   * as a peephole into a restricted catalog.
   *
   * An unreadable dataset does NOT bring the builder down: the slot keeps its
   * hand-written options and says which one failed. A whole builder down because
   * someone changed a dataset's permissions is worse than an incomplete one that
   * explains itself.
   */
  async function resolveDefinition(definition: BuilderDefinition, user: AuthzUser | null) {
    const slots = datasetSlots(definition);
    if (!slots.length) return { definition, sources: [] as unknown[] };

    const resolved = new Map<string, SlotOption[]>();
    const sources: {
      slot: string;
      dataset: string | null;
      options: number;
      skipped: number;
      error?: string;
    }[] = [];

    for (const slot of slots) {
      const source = slot.optionsFrom!;
      const catalog = await readDatasetCatalog(ctx.db.instance, source.datasetId, user as never);
      if (!catalog) {
        sources.push({
          slot: slot.id,
          dataset: null,
          options: 0,
          skipped: 0,
          error: "does not exist or you cannot read it",
        });
        continue;
      }
      const { options, skipped } = optionsFromEntries(
        catalog.entries,
        source,
        catalog.imageField
      );
      resolved.set(slot.id, options);
      sources.push({
        slot: slot.id,
        dataset: catalog.dataset.name,
        options: options.length,
        skipped: skipped.length,
      });
    }

    return { definition: withDatasetOptions(definition, resolved), sources };
  }

  /**
   * The definitions that can be embedded.
   * ==========================================================================
   *
   * ── WHY IT DID NOT EXIST, AND WHY IT IS NEEDED ──────────────────────────
   *
   * Definitions could be created (`PUT /definitions`) and read by slug,
   * but there was no way to know WHICH ones exist. With that, putting a builder on a
   * page meant remembering the slug by heart and typing it — and a misspelled slug
   * gives no error: the page is saved and comes out empty.
   *
   * It is the same family as the tier list without a catalog: you can start the
   * work and there is no way to continue it.
   *
   * It only returns what is PUBLISHED except to whoever can edit. A draft that
   * showed up in the selector could be embedded, and the page would be empty
   * for the reader without saying why.
   */
  app.get(
    "/definitions",
    {
      id: "list-definitions",
      summary: "List character builder definitions",
      description:
        "The builders that can be embedded in a page, by name: id, slug, name and published state. The public sees only published ones; the editorial team (or an agent with the kon's scope) also sees drafts. Use the slug with get-definition.",
      access: "optional",
      output: {
        schema: z.object({
          data: z.array(
            z.object({ id: z.string(), slug: z.string(), name: z.string(), published: z.string() })
          ),
        }),
      },
    },
    async (c) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      const staff = isBuilderTeam(user);

      const rows = await repo(builderDefinitions, { db })
        .filter(staff ? {} : { published: "published" })
        .orderBy("name")
        .all();

      // Only what a selector needs: the whole definition is formulas and
      // catalogs, and they are not needed here.
      return c.json({
        data: rows.map((f) => ({
          id: f.id,
          slug: f.slug,
          name: f.name,
          published: f.published,
        })),
      });
    }
  );

  app.get(
    "/definitions/:slug",
    {
      id: "get-definition",
      summary: "Read a character builder definition",
      description:
        "The builder definition (slots, options, budgets, formulas) with the options of its dataset-backed slots already filled in. `meta.datasets` says, per slot, which dataset fed it and whether it could be read. A draft is a 404 unless you can edit builders.",
      access: "optional",
      input: { params: ParamSlug },
      output: {
        schema: z
          .object({
            data: Row,
            meta: z.object({ datasets: z.array(Obj) }).optional(),
          })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const [row] = await repo(builderDefinitions, { db })
        .filter({ slug: c.req.param("slug") })
        .all();
      if (!row) return c.json({ error: "Not found" }, 404);

      const user = (c.get("user") ?? null) as AuthzUser | null;

      /**
       * A draft is not public. **404 and not 403**: a 403 confirms that slug
       * exists, and slugs are readable ("builder-armas-1-3"), so with a 403
       * you can guess what is about to come out by trying URLs. From the outside, a draft
       * has to be indistinguishable from something that does not exist.
       */
      if (!(await can(user, "view", row, "builder"))) {
        return c.json({ error: "Not found" }, 404);
      }
      const { definition, sources } = await resolveDefinition(row.definition, user);
      // `sources` is always present when there are datasets: if a slot comes out empty, this says
      // whether it was because the dataset could not be read or because it had no rows.
      return c.json({
        data: { ...row, definition },
        ...(sources.length ? { meta: { datasets: sources } } : {}),
      });
    }
  );

  /** Publishes a definition. It compiles first: a broken builder is not served. */
  /**
   * Compiles a definition WITHOUT saving it.
   *
   * The editor uses it to say "this formula does not compile" while typing,
   * instead of letting the author discover the error on pressing save and losing
   * their place. It is the same call the create makes, without the write.
   */
  app.post(
    "/definitions/validate",
    {
      id: "validate-definition",
      summary: "Check that a builder definition compiles",
      description:
        "Compiles a builder definition WITHOUT saving it. Answers 200 with `ok: true`, or 200 with `ok: false` and the formula error (not compiling is an answer, not a failed request). 400 if `definition` is missing. Any signed-in account.",
      access: "session",
      permission: ANY_ACCOUNT,
      readOnly: true,
      // The body and its 400 belong to the handler, as before the SDK.
      input: { body: ValidateDefinition, validatesHandler: true },
      output: {
        schema: z.object({ ok: z.boolean(), error: z.string().optional() }),
      },
    },
    async (c) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!(await can(user, "create", {}, "builder"))) return c.json({ error: "Forbidden" }, 403);

      const body = (await c.req.json().catch(() => null)) as {
        definition?: BuilderDefinition;
      } | null;
      if (!body?.definition) return c.json({ error: "`definition` is required" }, 400);

      try {
        compileBuilder(body.definition);
        return c.json({ ok: true });
      } catch (err) {
        const message = err instanceof FormulaError ? err.message : "Invalid definition";
        // 200 and not 422: for the editor "does not compile" is an ANSWER, not a
        // request failure. With a 4xx every keystroke would paint a network error.
        return c.json({ ok: false, error: message });
      }
    }
  );

  app.put(
    "/definitions",
    {
      id: "publish-definition",
      summary: "Create or rewrite a character builder definition",
      description:
        "Upsert by slug of the site's official builder: 201 when it creates it, 200 when it rewrites it. The definition is compiled first (422 with the formula error). `published` sets draft/published; omitted, a new definition is a draft and an existing one keeps its state. Admin/editor, or an agent with builder:publishDefinition. 400 if `slug` or `definition` is missing.",
      access: "session",
      permission: onTheResource("publishDefinition"),
      // Rewrites a game's public builder in one go.
      sensitive: true,
      // The body and its 400 belong to the handler: permission is checked BEFORE, as before the SDK.
      input: { body: PublishDefinition, validatesHandler: true },
      output: PUBLISH_OUTPUT,
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, _input, h) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!(await can(user, "create", {}, "builder"))) return c.json({ error: "Forbidden" }, 403);

      /**
       * A DEFINITION is editorial: it is the site's official builder. `can(create)`
       * lets any session through because that rule is the one for each user's BUILDS;
       * here any account with the `user` role could create or overwrite
       * the published builder.
       */
      // Through the policy (`publishDefinition`), not by hand-checked role: with a role
      // checked by hand an agent with `admin` or `builder:*` could not publish the builder
      // that it could maintain in maps or formulas (phase D).
      // `h.can` = that policy plus the SDK's fine-grained scopes
      // (`kon:character-builder:publish-definition`, `character-builder:*`).
      if (!(await h.can({}))) {
        return c.json({ error: "Only administration or editing can publish a builder" }, 403);
      }

      const body = (await c.req.json().catch(() => null)) as {
        slug?: string;
        definition?: BuilderDefinition;
        /** `draft` | `published`. See the note below. */
        published?: string;
      } | null;
      if (!body?.slug || !body.definition) {
        return c.json({ error: "`slug` and `definition` are required" }, 400);
      }

      try {
        compileBuilder(body.definition);
      } catch (err) {
        const message = err instanceof FormulaError ? err.message : "Invalid definition";
        return c.json({ error: message }, 422);
      }

      const [existing] = await repo(builderDefinitions, { db }).filter({ slug: body.slug }).all();

      /**
       * ── THE STATE IS NO LONGER FORCED ───────────────────────────────────────
       *
       * It used to set `published: "published"` fixed, so ANY save
       * published. With that the `published` column existed and was useless:
       * there was no way to leave a definition half-done without it going
       * public, and building a builder is work of several sessions.
       *
       * Worse with the visibility check just added: the only way to
       * have a draft was not to save, which is the worst way to have one.
       *
       * Now whoever saves decides, and if they say nothing what was there is KEPT —
       * an already published definition is not unpublished on its own when a
       * formula is fixed, and a new one is born as a draft.
       */
      const status =
        body.published === "published" || body.published === "draft"
          ? body.published
          : (existing?.published ?? "draft");

      const values = {
        slug: body.slug,
        name: body.definition.name,
        definition: body.definition,
        published: status,
      };
      const row = existing
        ? (
            await repo(builderDefinitions, { db })
              .filter({ id: existing.id })
              .update({ ...values, updatedAt: new Date() })
          )[0]
        : await repo(builderDefinitions, { db }).create(values);

      return c.json({ data: row }, existing ? 200 : 201);
    }
  );

  /**
   * Calculates a build. Public: it is the builder's operation, and behind a
   * login nobody would use it.
   *
   * It returns the WARNINGS along with the stats: "you have 3 points left over" does not
   * invalidate the build but whoever is putting it together wants to see it.
   */
  app.post(
    "/definitions/:slug/compute",
    {
      id: "compute-build",
      summary: "Compute the stats of a build",
      description:
        "Validates a build (selections per slot, attributes) against a published builder and returns its stats, the non-blocking warnings (`issues`, e.g. unspent points) and its share `code`. 422 with `issues` if the build breaks a rule. No session needed; a draft builder is a 404 unless you can edit builders. Saves nothing.",
      access: "optional",
      readOnly: true,
      input: { params: ParamSlug, body: BuildSchema },
      output: {
        schema: z.object({ data: Obj, issues: z.array(Obj), code: z.string() }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const [row] = await repo(builderDefinitions, { db })
        .filter({ slug: c.req.param("slug") })
        .all();
      if (!row) return c.json({ error: "Not found" }, 404);

      const user = (c.get("user") ?? null) as AuthzUser | null;

      // A draft is not computed from outside: 404, as in reading, so that
      // trying slugs does not reveal what is about to come out
      if (!(await can(user, "view", row, "builder"))) {
        return c.json({ error: "Not found" }, 404);
      }

      const build = input.body as z.infer<typeof BuildSchema>;

      try {
        const { definition } = await resolveDefinition(row.definition, user);
        const compiled = compileBuilder(definition);
        const issues = validateBuild(compiled, build);
        const errors = issues.filter((i) => i.level === "error");
        if (errors.length > 0) return c.json({ error: "Invalid build", issues }, 422);

        return c.json({
          data: computeStats(compiled, build),
          issues,
          code: encodeBuild(row.id, build),
        });
      } catch (err) {
        const message = err instanceof FormulaError ? err.message : "Could not calculate";
        return c.json({ error: message }, 422);
      }
    }
  );

  /** Opens a build from its shared code. Never 500: the code arrives from a chat. */
  app.get(
    "/decode/:code",
    {
      id: "open-build-code",
      summary: "Decode a build share code",
      description:
        "Decodes a build share code into the builder id and the build (selections, attributes) it carries. 400 if the code is unreadable. Public: the code usually comes from a chat or a link.",
      access: "public",
      input: { params: CodeParam },
      output: { schema: z.object({ data: Obj }) },
    },
    (c) => {
      const decoded = decodeBuild(c.req.param("code"));
      if (!decoded.ok) return c.json({ error: decoded.reason }, 400);
      return c.json({ data: decoded });
    }
  );

  app.post(
    "/builds",
    {
      id: "save-build",
      summary: "Save a build to your account",
      description:
        "Saves a build (against a builder definition id, or a link planner `link:<game>:<path>` whose build lives in `build.link`). It is validated against the definition first (422 with `issues`). Saving the same build again updates it (200) instead of creating another, and never unpublishes it. `visibility`: private (default), unlisted (opens by link) or public (in the gallery). 404 if the builder does not exist or is a draft; 409 at 100 builds per planner or 1000 in total; 429 if too many new builds in a row. Any signed-in account.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: SaveBuild },
      output: SAVE_OUTPUT,
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!(await can(user, "create", {}, "builder"))) return c.json({ error: "Forbidden" }, 403);

      const data = input.body as z.infer<typeof SaveBuild>;
      let build: Build;
      let code: string;
      let subject: string | null = null;

      if (isLinkBuilder(data.builderId)) {
        // A planner that stores its build in the address: there is no definition
        const problem = linkBuildProblem(data.builderId, data.build);
        if (problem)
          return c.json(
            { error: "Invalid build", issues: [{ level: "error", message: problem }] },
            422
          );
        build = {
          selections: {},
          link: data.build.link,
          ...(data.build.label ? { label: data.build.label } : {}),
        };
        code = data.build.link!;
      } else {
        const definition = await repo(builderDefinitions, { db }).find(data.builderId);
        // A DRAFT does not exist for whoever cannot see it: saving against it
        // confirmed the id exists and hung builds off something unpublished.
        if (!definition || !(await can(user, "view", definition, "builder"))) {
          return c.json({ error: "That builder does not exist" }, 404);
        }

        // It is validated against the definition BEFORE saving: a saved invalid
        // build would blow up on opening, far from where it was created.
        const { definition: resolvedOne } = await resolveDefinition(definition.definition, user);
        const compiled = compileBuilder(resolvedOne);
        const errors = validateBuild(compiled, data.build).filter((i) => i.level === "error");
        if (errors.length > 0) return c.json({ error: "Invalid build", issues: errors }, 422);

        build = {
          selections: data.build.selections,
          ...(data.build.attributes ? { attributes: data.build.attributes } : {}),
          // The link is only a shortcut to open it: if it is malformed, out it goes
          ...(isValidLink(data.build.link) ? { link: data.build.link } : {}),
          ...(data.build.label ? { label: data.build.label } : {}),
        };
        code = encodeBuild(data.builderId, build);
        // Whose it is, for the gallery. The SERVER decides, reading the build
        // against its definition: if the client sent it, anyone could
        // hang their build on another entry's page.
        subject = subjectOfBuild(compiled, build);
      }

      const requested: Visibility = data.visibility ?? "private";

      /**
       * The SAME build saved twice is one, not two: pressing "Save" and
       * then "Publish" (or saving again under another name) updates the one that
       * was already there. And saving never UNPUBLISHES: if it was already public, it stays so.
       */
      if (user?.id) {
        const [already] = await db
          .select()
          .from(builderBuilds)
          .where(
            and(
              eq(builderBuilds.ownerId, user.id),
              eq(builderBuilds.builderId, data.builderId),
              eq(builderBuilds.code, code)
            )
          )
          .limit(1);
        if (already) {
          const actual = (
            already.visibility in VISIBILITY_WEIGHT ? already.visibility : "private"
          ) as Visibility;
          const visibility =
            VISIBILITY_WEIGHT[requested] > VISIBILITY_WEIGHT[actual] ? requested : actual;
          const [rowValue] = await db
            .update(builderBuilds)
            .set({
              ...(data.name ? { name: data.name } : {}),
              build,
              visibility,
              ...(visibility === "public" && !already.publishedAt ? { publishedAt: new Date() } : {}),
              updatedAt: new Date(),
            })
            .where(eq(builderBuilds.id, already.id))
            .returning();
          return c.json({ data: rowValue });
        }

        const [{ total }] = await db
          .select({ total: sql<number>`count(*)::int` })
          .from(builderBuilds)
          .where(
            and(eq(builderBuilds.ownerId, user.id), eq(builderBuilds.builderId, data.builderId))
          );
        if (total >= MAX_PER_PLANNER) {
          return c.json(
            {
              error: `You already have ${MAX_PER_PLANNER} builds in this planner: delete some`,
            },
            409
          );
        }

        const [{ all, recent }] = await db
          .select({
            all: sql<number>`count(*)::int`,
            recent: sql<number>`(count(*) filter (where ${builderBuilds.createdAt} > ${new Date(Date.now() - MAX_BUILDS.windowMs)}))::int`,
          })
          .from(builderBuilds)
          .where(eq(builderBuilds.ownerId, user.id));
        if (Number(all) >= MAX_BUILDS.total) {
          return c.json(
            { error: `You already have ${MAX_BUILDS.total} saved builds: delete some` },
            409
          );
        }
        if (Number(recent) >= MAX_BUILDS.perWindow && user.role !== "admin") {
          c.header("Retry-After", "600");
          return c.json({ error: "Too many new builds in a row. Wait a few minutes." }, 429);
        }
      }

      const row = await repo(builderBuilds, { db }).create({
        builderId: data.builderId,
        // With no name, what summarizes it ("Barbarian"); saving it again with no name does not overwrite it
        name: data.name ?? build.label ?? "My build",
        build,
        code,
        subject,
        publishedAt: requested === "public" ? new Date() : null,
        visibility: requested,
        ownerId: user?.id ?? null,
      });

      return c.json({ data: row }, 201);
    }
  );

  /**
   * "My builds": the asker's in a planner, private ones included
   * ==========================================================================
   *
   * It is what makes saving with an account follow you to another browser. It goes BEFORE
   * `/builds/:id`: in Hono the first matching route wins, and `mine` would
   * be taken for an id.
   */
  app.get(
    "/builds/mine",
    {
      id: "list-my-builds",
      summary: "List your saved builds in a planner",
      description:
        "Your own builds (private ones included) in the planner `builder` (a definition id or `link:<game>:<path>`), most recently updated first, up to 100. 401 without a session, 400 without `builder`.",
      // `optional` and not `session`: the 401 "A session is required" belongs to the handler.
      access: "optional",
      input: {
        query: query({ builder: text("Required. Planner id (definition id or link:…)") }),
      },
      output: { schema: z.object({ docs: z.array(Row) }) },
      errors: ["KITSUDEN_E_UNAUTHENTICATED"],
    },
    async (c) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!user?.id) return c.json({ error: "A session is required" }, 401);
      const builderId = c.req.query("builder");
      if (!builderId) return c.json({ error: "`builder` is missing" }, 400);

      const rows: BuilderBuildRow[] = await db
        .select()
        .from(builderBuilds)
        .where(and(eq(builderBuilds.ownerId, user.id), eq(builderBuilds.builderId, builderId)))
        .orderBy(desc(builderBuilds.updatedAt))
        .limit(MAX_PER_PLANNER);
      return c.json({ docs: rows });
    }
  );

  /**
   * A build, as seen by WHOEVER IS NOT ITS OWNER.
   *
   * Without `ownerId`: it is a person's id, and a public gallery has no
   * reason to hand out its users' ids to anyone who asks for the list. Its
   * owner and an admin do receive it, since for them it is not someone else's data.
   */
  const forOutside = (build: BuilderBuildRow, user: AuthzUser | null) => {
    const its = user?.role === "admin" || (Boolean(build.ownerId) && build.ownerId === user?.id);
    if (its) return build;
    const { ownerId: _ownerId, ...rest } = build;
    return rest;
  };

  /**
   * The GALLERY: a subject's public builds, most voted first
   * ==========================================================================
   *
   * `GET /builds?builder=<id>&subject=<slug>` is the "all of Infergon's
   * builds" page. Only `public`: an `unlisted` build opens by its link and
   * appears in no list — that is what it means.
   *
   * Without `subject` it returns the whole builder's, which is the builds front page.
   * The order is votes and, on a tie, the most recent: without the second criterion
   * those tied at zero come out in a different order on each visit.
   */
  app.get(
    "/builds",
    {
      id: "list-builds",
      summary: "List the public builds of a planner (the gallery)",
      description:
        "The PUBLIC builds of planner `builder`, optionally of one `subject` (e.g. one character), most voted first and then most recent; `limit` 1-100 (24 by default). Each one says whether you voted it (`voted`). No session needed. 400 without `builder`.",
      access: "optional",
      input: {
        query: query({
          builder: text("Required. Planner id (definition id or link:…)"),
          subject: text("Only the builds of this subject (slug)"),
          limit: text("How many, up to 100 (24 by default)"),
        }),
      },
      output: { schema: z.object({ docs: z.array(PublicBuild) }) },
    },
    async (c) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      const builderId = c.req.query("builder");
      const subject = c.req.query("subject");
      const limit = Math.min(Number(c.req.query("limit") ?? 24) || 24, 100);
      if (!builderId) return c.json({ error: "`builder` is missing" }, 400);

      const conditions = [
        eq(builderBuilds.builderId, builderId),
        eq(builderBuilds.visibility, "public"),
      ];
      if (subject) conditions.push(eq(builderBuilds.subject, subject));

      // The type, by hand: `ctx.db.instance` arrives untyped and without this every `.map`
      // over the result is an implicit `any` that TypeScript rejects
      const rows: BuilderBuildRow[] = await db
        .select()
        .from(builderBuilds)
        .where(and(...conditions))
        .orderBy(desc(builderBuilds.votes), desc(builderBuilds.publishedAt))
        .limit(limit);

      /**
       * What the viewer has voted, in ONE query and not one per build: the vote
       * button has to come out already pressed, or whoever comes back votes twice and sees
       * that nothing happens.
       */
      const mine = new Set<string>();
      if (user?.id && rows.length > 0) {
        const votes = await db
          .select({ buildId: builderBuildVotes.buildId })
          .from(builderBuildVotes)
          .where(
            and(
              eq(builderBuildVotes.voterId, user.id),
              inArray(
                builderBuildVotes.buildId,
                rows.map((f) => f.id)
              )
            )
          );
        for (const v of votes) mine.add(v.buildId);
      }

      return c.json({
        docs: rows.map((f) => ({ ...forOutside(f, user), voted: mine.has(f.id) })),
      });
    }
  );

  /** A build by its id. Who can see it is decided by the policy, not the route. */
  app.get(
    "/builds/:id",
    {
      id: "get-build",
      summary: "Read a saved build",
      description:
        "One build by id, with `voted` (whether you voted it). Public and unlisted builds are readable by anyone; a private one only by its owner (anyone else gets 404).",
      access: "optional",
      input: { params: ParamBuild },
      output: { schema: z.object({ data: PublicBuild }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      const build = await repo(builderBuilds, { db }).find(c.req.param("id"));
      if (!build) return c.json({ error: "That build does not exist" }, 404);
      if (!(await can(user, "view", build, "builder"))) return c.json({ error: "Not found" }, 404);

      const voted = user?.id
        ? (
            await db
              .select({ buildId: builderBuildVotes.buildId })
              .from(builderBuildVotes)
              .where(
                and(eq(builderBuildVotes.buildId, build.id), eq(builderBuildVotes.voterId, user.id))
              )
              .limit(1)
          ).length > 0
        : false;

      return c.json({ data: { ...forOutside(build, user), voted } });
    }
  );

  /**
   * PUBLISHING is this: setting `visibility` to `public`. Also renaming.
   *
   * The publication date is set the FIRST time it is made public and is not
   * touched afterward: if it were recalculated on every edit, fixing a typo
   * would push the build to the top of the list.
   */
  app.patch(
    "/builds/:id",
    {
      id: "update-build",
      summary: "Rename or publish one of your builds",
      description:
        "Changes the name and/or the visibility of a build. Publishing is setting `visibility: public` (the publication date is set the first time only). Only its owner or an admin: anyone else gets 403.",
      access: "session",
      permission: onTheResource("update"),
      input: { params: ParamBuild, body: EditBuild },
      output: { schema: z.object({ data: Row }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input, h) => {
      const build = await repo(builderBuilds, { db }).find(c.req.param("id"));
      if (!build) return c.json({ error: "That build does not exist" }, 404);
      if (!(await h.can(build))) return c.json({ error: "Forbidden" }, 403);

      const data = input.body as z.infer<typeof EditBuild>;
      const publishesNow = data.visibility === "public" && !build.publishedAt;

      const [rowValue] = await db
        .update(builderBuilds)
        .set({
          ...(data.name ? { name: data.name } : {}),
          ...(data.visibility ? { visibility: data.visibility } : {}),
          ...(publishesNow ? { publishedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(builderBuilds.id, build.id))
        .returning();

      return c.json({ data: rowValue });
    }
  );

  app.delete(
    "/builds/:id",
    {
      id: "delete-build",
      summary: "Delete one of your builds",
      description:
        "Deletes a build and its votes. Only its owner or an admin: anyone else gets 403. Cannot be undone.",
      access: "session",
      permission: onTheResource("delete"),
      input: { params: ParamBuild },
      output: { schema: z.object({ data: z.object({ id: z.string() }) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, _input, h) => {
      const build = await repo(builderBuilds, { db }).find(c.req.param("id"));
      if (!build) return c.json({ error: "That build does not exist" }, 404);
      if (!(await h.can(build))) return c.json({ error: "Forbidden" }, 403);

      // The build's votes belong to OTHER people: with its owner's RLS only
      // their own would be deleted and the rest would be left orphaned.
      await asSystem(() =>
        db.delete(builderBuildVotes).where(eq(builderBuildVotes.buildId, build.id))
      );
      await db.delete(builderBuilds).where(eq(builderBuilds.id, build.id));
      return c.json({ data: { id: build.id } });
    }
  );

  /**
   * Voting and removing the vote, with the same call: the button is one.
   *
   * The row's counter is recalculated by COUNTING the table, not by adding one: two
   * simultaneous votes on the same build would overwrite each other, and the number that orders the
   * gallery would start lying without anyone noticing.
   */
  app.post(
    "/builds/:id/vote",
    {
      id: "vote-build",
      summary: "Vote or unvote a build",
      description:
        "Toggles your vote on a build (the same call votes and removes the vote) and returns the recounted total and whether you now vote it. 404 if the build does not exist or you cannot see it, 409 if it is private. Any signed-in account.",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamBuild },
      output: {
        schema: z.object({
          data: z.object({ id: z.string(), votes: z.number().int(), voted: z.boolean() }),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT", "KITSUDEN_E_UNAUTHENTICATED"],
    },
    async (c) => {
      const user = (c.get("user") ?? null) as AuthzUser | null;
      if (!user?.id) return c.json({ error: "A session is required to vote" }, 401);

      const build = await repo(builderBuilds, { db }).find(c.req.param("id"));
      if (!build) return c.json({ error: "That build does not exist" }, 404);
      if (!(await can(user, "view", build, "builder"))) return c.json({ error: "Not found" }, 404);
      if (build.visibility === "private")
        return c.json({ error: "That build is not published" }, 409);

      const deleted = await db
        .delete(builderBuildVotes)
        .where(and(eq(builderBuildVotes.buildId, build.id), eq(builderBuildVotes.voterId, user.id)))
        .returning({ buildId: builderBuildVotes.buildId });
      const voted = deleted.length === 0;
      if (voted) {
        // Two simultaneous clicks both arrive with no vote to delete: the second
        // collided with the primary key and a 500 came out. Voting is still one.
        await db
          .insert(builderBuildVotes)
          .values({ buildId: build.id, voterId: user.id })
          .onConflictDoNothing();
      }

      // Counting other people's votes and writing to someone else's build: as system. With the
      // voter's RLS, the count would see only their vote and the update would not
      // touch any row (with no error: the counter stayed as it was).
      const total = await asSystem(async () => {
        const [{ total }] = await db
          .select({ total: sql<number>`count(*)::int` })
          .from(builderBuildVotes)
          .where(eq(builderBuildVotes.buildId, build.id));
        await db.update(builderBuilds).set({ votes: total }).where(eq(builderBuilds.id, build.id));
        return total;
      });

      return c.json({ data: { id: build.id, votes: total, voted } });
    }
  );

  return app.ops;
}

export function createKonBuilder(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, builderOperations(ctx), ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`builderOperations`), with its OpenAPI, its MCP tool and its fine-grained scope
 * `kon:character-builder:<id>`.
 */
export const kon = defineKonSdk({
  // "Builder" alone was confused with "Page Builder" (`kon-blocks`), which is the one
  // that lays out pages. This one is the CHARACTER build engine. The `name` already
  // said "Character Builder" from the start; what was misaligned was the
  // identity — id, package and folder— and that is what was renamed.
  id: KON_ID,
  name: "Character Builder",
  version: manifest.version,
  description: "Data-defined character builders: validation, stats and build codes",
  icon: "Hammer",
  mountPath: "/api/builder",
  operations: (ctx: KonContext) => builderOperations(ctx),

  tables: konTables,

  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "tools",
    views: manifest.admin.views.map((v) => ({
      id: v.id,
      type: v.type as "grid" | "element",
      title: v.title,
      table: v.table,
      element: v.element,
      src: v.src,
    })),
  },

  dependencies: { kons: ["kon-formulas"], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("🔨 Builder ready — data-defined definitions, versioned build codes");
    },
  },
});

export default kon;
