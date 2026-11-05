/**
 * No public read returns unpublished content
 * ============================================================================
 *
 * ── THE LESSON, WHICH IS WHAT MATTERS ──────────────────────────────────────
 *
 * This was fixed once and considered closed. `GET /api/blog` was closed,
 * `GET /api/blog?status=draft` was checked and it was reported that the leak was
 * resolved. **It was open on four other routes.** Measured afterwards, against the
 * real installation and without any cookie:
 *
 *     GET /api/blog/slug/<slug>              → the entire draft
 *     GET /api/blog/<id>                     → the entire draft
 *     GET /api/blog/seo/<slug>?preview=true  → the entire draft
 *     GET /api/blog/geo/<slug>?preview=true  → the entire draft
 *     GET /api/games?status=draft            → the entire draft
 *     GET /api/games/slug/<slug>             → the entire draft
 *
 * Verifying the door you just fixed says nothing about the others. That is why
 * this test does not look at "the route that was fixed" but at **all the ones that read
 * content**, and fails when a new one appears without the check.
 *
 * ── THE WORST WAS NOT THE OVERSIGHT ────────────────────────────────────────
 *
 * `seo` and `geo` DID check the status — and announced how to skip it in
 * the error message itself: "Add ?preview=true to see unpublished posts". Without
 * asking for a session. A URL parameter is not a credential.
 *
 * ── WHY 404 AND NOT 403 ────────────────────────────────────────────────────
 *
 * A 403 confirms the resource exists. With slugs —which are the title— the
 * editorial calendar is guessed by trying URLs. From outside, a draft has to be
 * indistinguishable from something that does not exist.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { withoutComments } from "../../.kitsuden/tests/unit/helpers/comments";
import { sourceOperations } from "./helpers/source-operations";

const ROOT = join(__dirname, "..", "..");
const BLOG = join(ROOT, "kons", "kon-blog", "src", "routes.ts");
const GAMES = join(ROOT, "kons", "kon-games", "games.routes.ts");
const ESPORTS = join(ROOT, "kons", "kon-esports", "esports.routes.ts");
const ESPORTS_POLICY = join(ROOT, "kons", "kon-esports", "esports.policy.ts");
const BUILDER = join(ROOT, "kons", "kon-character-builder", "index.ts");
const BUILDER_POLICY = join(ROOT, "kons", "kon-character-builder", "character-builder.policy.ts");

/** The `GET` handlers of a routes file, chopped up. */
function publicReads(source: string, variable: string) {
  const re = new RegExp(`${variable}\\.get\\(\\s*"([^"]*)"`, "g");
  const marks = [...source.matchAll(re)].map((m) => ({ pattern: m[1], index: m.index! }));

  return marks.map((m, i) => ({
    pattern: m.pattern,
    body: source.slice(m.index, marks[i + 1]?.index ?? source.length),
  }));
}

describe("kon-blog: public reads filter out what is unpublished", () => {
  const source = withoutComments(readFileSync(BLOG, "utf-8"));
  // The blog is an SDK kon: its routes are declared operations.
  const routes = sourceOperations(source)
    .filter((o) => o.method === "GET")
    .map((o) => ({ pattern: o.route, body: o.body }));

  /**
   * The ones that return post content. They are enumerated so that adding a new one
   * forces an explicit decision on whether it goes in the list — which is precisely the
   * decision that was skipped the first time.
   */
  const THAT_READ_POSTS = ["/", "/slug/:slug", "/seo/:slug", "/geo/:slug", "/:id"];

  it("all the read routes were found", () => {
    const foundOnes = routes.map((r) => r.pattern);
    const absent = THAT_READ_POSTS.filter((p) => !foundOnes.includes(p));

    expect(
      absent,
      `These routes were not located in the file: ${absent.join(", ")}. ` +
        `If they were renamed, update the list; if they disappeared, remove them. ` +
        `What cannot happen is for the test to look at an empty set and pass.`
    ).toEqual([]);
  });

  for (const pattern of THAT_READ_POSTS) {
    it(`\`GET ${pattern}\` checks who is asking`, () => {
      const route = routes.find((r) => r.pattern === pattern);
      expect(route, `could not find GET ${pattern}`).toBeDefined();

      const body = route!.body;

      // 1. It knows who is asking (`access: "optional"` mounts `optionalAuth`).
      expect(
        body.includes('access: "optional"') || body.includes("optionalAuth"),
        `GET ${pattern} does not go through \`optionalAuth\`, so it cannot know whether ` +
          `whoever asks has the right to see drafts.`
      ).toBe(true);

      // 2. And it decides with the common function, not with a rule of its own.
      expect(
        /hiddenForThisVisitor|canViewUnpublished/.test(body),
        `GET ${pattern} does not consult the permission. Every handler that invents its ` +
          `own check is one more door to close separately — and that ` +
          `is how four were left open.`
      ).toBe(true);
    });
  }

  it("`?preview=true` is not a credential", () => {
    /**
     * Before, writing it in the URL was enough. Now it must be accompanied by
     * the permission check in the SAME expression.
     */
    for (const m of source.matchAll(/const isPreview = [^;]+;/g)) {
      expect(
        m[0].includes("canViewUnpublished"),
        `«${m[0].trim()}» accepts the parameter without looking at who sends it. ` +
          `A preview is a panel function, not a magic word.`
      ).toBe(true);
    }
  });

  it("a hidden draft answers 404, not 403", () => {
    const hidden = source.slice(
      source.indexOf("function hiddenForThisVisitor"),
      source.indexOf("function hiddenForThisVisitor") + 400
    );
    expect(hidden.length, "the permission function was not found").toBeGreaterThan(0);

    for (const pattern of ["/slug/:slug", "/:id"]) {
      const route = routes.find((r) => r.pattern === pattern)!;
      const chunk = route.body.slice(route.body.indexOf("hiddenForThisVisitor"));
      const cut = chunk.slice(0, 200);

      expect(
        cut.includes("404"),
        `GET ${pattern} must answer 404 when hiding a draft: a 403 ` +
          `confirms it exists, and with the slug the editorial calendar is guessed.`
      ).toBe(true);
    }
  });
});

describe("kon-games: public reads use their policy", () => {
  const source = withoutComments(readFileSync(GAMES, "utf-8"));
  const routes = publicReads(source, "gamesRoutes");

  /**
   * Games already had the right piece —`can(user, "view", …)` with 404— used
   * only in `/:id`. The other two reads ignored it. Nothing had to be
   * invented: what was needed was to use what was already there.
   */
  for (const pattern of ["/", "/slug/:slug", "/:id"]) {
    it(`\`GET ${pattern}\` goes through the policy`, () => {
      const route = routes.find((r) => r.pattern === pattern);
      expect(route, `could not find GET ${pattern}`).toBeDefined();

      expect(
        route!.body.includes("can("),
        `GET ${pattern} does not consult \`can(user, "view", …)\`. The kon's policy ` +
          `already defines who sees a draft; repeating the rule in each handler ` +
          `is how they end up diverging.`
      ).toBe(true);
    });
  }

  it("the URL's `status` is not used as is", () => {
    const list = routes.find((r) => r.pattern === "/")!.body;

    expect(
      /const status = c\.req\.query\("status"\) \|\| "published"/.test(list),
      "`?status=` cannot go straight into the query: the safe default made " +
        "the route look correct as long as nobody wrote another value."
    ).toBe(false);
  });
});

describe("kon-esports: draft tournaments are not public", () => {
  const source = withoutComments(readFileSync(ESPORTS, "utf-8"));
  const policy = withoutComments(readFileSync(ESPORTS_POLICY, "utf-8"));

  /**
   * ── WHAT WAS ESCAPING ─────────────────────────────────────────────────────
   *
   * `esports_tournaments` has a `Draft` status and the two public reads did not
   * look at it. Measured by creating a draft tournament and asking without a session:
   *
   *     GET /api/esports/tournaments               → returned it
   *     GET /api/esports/tournaments?status=Draft  → returned it
   *     GET /api/esports/tournaments/<id>          → returned it
   *
   * All three. A half-built tournament —title, rules, prize, dates— was
   * readable from outside before being announced.
   *
   * It is the third time this family appears: blog, games and now esports.
   * That is why the guardian asks the same thing in all three.
   */
  it("the policy defines who can see a draft", () => {
    expect(
      /view:\s*\(user, resource\)/.test(policy) || /\bview:/.test(policy),
      "the esports policy must declare a `view` rule: without it, each " +
        "handler invents its own criterion and one is left without it."
    ).toBe(true);

    expect(policy).toContain("Draft");
  });

  it("both tournament reads consult the policy", () => {
    // It is anchored on something UNIQUE to the tournaments list: `const search` appears
    // in the players one too, and cutting at the first one analyzed the
    // wrong handler — a badly placed cut makes the guardian look
    // where it should not and fail (or pass) for the wrong reason.
    const list = source.slice(source.indexOf("ilike(tournaments.title"));
    const listBody = list.slice(0, list.indexOf("app.post"));

    expect(
      listBody.includes('"view"'),
      "the tournaments list must ask the policy before accepting the " +
        "`?status=` that comes in the URL."
    ).toBe(true);

    // The `get-tournament` operation (kon SDK), up to the next route.
    const byId = source.slice(source.indexOf('id: "get-tournament"'));
    const bodyId = byId.slice(0, byId.indexOf("app.patch("));

    expect(
      bodyId.includes('"view"'),
      "`GET /tournaments/:id` must check the status before returning " + "the tournament."
    ).toBe(true);

    expect(
      bodyId.includes("404"),
      "a hidden draft answers 404, not 403: a 403 confirms it exists and " +
        "that lets the calendar be guessed by trying ids."
    ).toBe(true);
  });

  it("the `?status=` is not used as is", () => {
    expect(
      /const filtro272 = eqEnum\(tournaments\.status, status\)/.test(source),
      "the status requested in the URL cannot reach the query directly without " +
        "looking at who is asking."
    ).toBe(false);
  });
});

describe("kon-character-builder: a draft definition is not public", () => {
  const source = withoutComments(readFileSync(BUILDER, "utf-8"));
  const policy = withoutComments(readFileSync(BUILDER_POLICY, "utf-8"));

  /**
   * ── THE FOURTH TIME ───────────────────────────────────────────────────────
   *
   * `builder_definitions.published` has existed from the start (`draft` |
   * `published`) and `GET /definitions/:slug` NEVER looked at it: it returned the
   * entire row —formulas, slots, data— just by knowing the slug.
   *
   * The policy made it worse by saying it out loud:
   *
   *     «Without `visibility` it is a definition: editorial and public»
   *
   * So the rule was written, reviewed and wrong. Blog, games,
   * esports and builder: four kons, the same oversight.
   */
  it("the policy distinguishes definition from build, and looks at the status", () => {
    expect(
      policy.includes('item.published === "published"'),
      "an unpublished definition is seen only by whoever can edit it."
    ).toBe(true);
  });

  it("the public read consults the policy", () => {
    // The routes are SDK operations: they are located by their declared `id`.
    const route = source.slice(
      source.indexOf('id: "get-definition"'),
      source.indexOf('id: "validate-definition"')
    );

    expect(route.length, "GET /definitions/:slug was not found").toBeGreaterThan(0);
    expect(route).toContain('can(user, "view"');

    expect(
      route.includes("404"),
      "a hidden draft answers 404, not 403: a 403 confirms the slug " +
        "exists, and with readable slugs what is about to come out is guessed."
    ).toBe(true);
  });

  it("saving does not publish unless asked", () => {
    /**
     * ── THE STATE THAT WAS FORCED ─────────────────────────────────────────
     *
     * `PUT /definitions` wrote `published: "published"` FIXED, so
     * any save published. With that the column existed and was useless:
     * building a builder is work of several sessions and the only way to
     * have a draft was not to save — the worst way to have one.
     *
     * And closing the leak above made it worse: the visibility check
     * started protecting a state that was impossible to reach.
     */
    const high = source.slice(
      source.indexOf('id: "publish-definition"'),
      source.indexOf('id: "compute-build"')
    );

    expect(high.length, "the definition creation was not found").toBeGreaterThan(0);

    expect(
      /published: "published",/.test(high),
      "the status cannot be written fixed: it makes saving a draft impossible."
    ).toBe(false);

    /**
     * And if nothing is said, it is KEPT: fixing a formula of something already
     * published cannot unpublish it by surprise.
     */
    expect(high).toContain("existing?.published");
  });

  it("a definition can be checked without saving it", () => {
    /**
     * Without this, the author finds out a formula does not compile when pressing save
     * — and loses the place where they were. The route answers 200 with `ok: false`
     * instead of a 4xx: for the editor "does not compile" is an answer, not a
     * request failure, and with a 4xx every check would draw a network
     * error.
     */
    expect(source).toMatch(/app\.post\(\s*"\/definitions\/validate"/);

    const validate = source.slice(
      source.indexOf('id: "validate-definition"'),
      source.indexOf('id: "publish-definition"')
    );

    expect(validate).toContain("compileBuilder");
    expect(
      /return c\.json\(\{ ok: false, error: message \}\);/.test(validate),
      "\"does not compile\" must arrive as a 200 response, not as an HTTP error."
    ).toBe(true);
  });

  it("the read knows who is asking", () => {
    /**
     * The middleware did `return next()` on GETs, skipping the whole
     * authentication. With that `c.get("user")` is always `null` and the
     * permission is evaluated against an anonymous user EVEN with a session: not even the author
     * could open their own draft. A guardian that looks without seeing.
     */
    // SDK operations: `access: "optional"` is `optionalAuth` (it resolves the
    // session if there is one); `"publico"` would not look at it.
    for (const id of ["list-definitions", "get-definition", "compute-build"]) {
      const from = source.indexOf(`id: "${id}"`);
      expect(from, id).toBeGreaterThan(-1);
      expect(
        /access: "(\w+)"/.exec(source.slice(from))?.[1],
        "without `optionalAuth` on the reads, the permission check is always " +
          "made against an anonymous visitor."
      ).toBe("optional");
    }
  });
});
