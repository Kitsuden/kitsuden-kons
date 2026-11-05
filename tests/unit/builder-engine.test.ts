/**
 * Builder engine — validation, computation and build codes
 * ============================================================================
 *
 * What is pinned: that an invalid build is never computed, that the stats pipeline
 * has a FIXED order, and that a code shared in a chat —truncated,
 * tampered with, from another version— never takes the builder down.
 */

import { describe, expect, test } from "vitest";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
} from "../../kons/kon-character-builder/character-builder.engine";

const DEFINITION: BuilderDefinition = {
  id: "test-rpg",
  name: "Test RPG",
  baseStats: { atk_base: 100, def_base: 50, atk_flat: 0, atk_pct: 0 },
  slots: [
    {
      id: "weapon",
      name: "Arma",
      capacity: 1,
      required: true,
      options: [
        { id: "sword", name: "Espada", modifiers: [{ stat: "atk_flat", value: 50 }] },
        {
          id: "bow",
          name: "Arco",
          modifiers: [{ stat: "atk_pct", value: 20 }],
          excludes: ["heavy-armor"],
        },
      ],
    },
    {
      id: "armor",
      name: "Armadura",
      capacity: 1,
      options: [
        { id: "heavy-armor", name: "Pesada", modifiers: [{ stat: "def_base", value: 100 }] },
      ],
    },
    {
      id: "talents",
      name: "Talentos",
      capacity: 3,
      options: [
        { id: "t1", name: "Fuerza", modifiers: [{ stat: "atk_pct", value: 10 }], cost: 2 },
        { id: "t2", name: "Precisión", modifiers: [{ stat: "atk_flat", value: 20 }], cost: 3 },
        {
          id: "t3",
          name: "Maestría",
          modifiers: [{ stat: "atk_pct", value: 30 }],
          cost: 5,
          requires: ["t1"],
        },
      ],
    },
  ],
  budgets: [{ id: "talent-points", name: "Puntos de talento", total: 5, slots: ["talents"] }],
  derived: [{ name: "atk_final", formula: "(atk_base + atk_flat) * (1 + atk_pct / 100)" }],
};

const compiled = compileBuilder(DEFINITION);

const build = (over: Partial<Build> = {}): Build => ({
  selections: { weapon: ["sword"], talents: ["t1", "t2"] },
  ...over,
});

// ── Compiling the definition ─────────────────────────────────────────────────

describe("compile the definition: errors of the AUTHOR, not the user", () => {
  test("an option in two slots is rejected", () => {
    // It blows up when the author uploads the definition, not when a user opens it
    // el builder.
    expect(() =>
      compileBuilder({
        ...DEFINITION,
        slots: [
          { id: "a", name: "A", capacity: 1, options: [{ id: "x", name: "X", modifiers: [] }] },
          { id: "b", name: "B", capacity: 1, options: [{ id: "x", name: "X", modifiers: [] }] },
        ],
      })
    ).toThrow(/is in two slots/);
  });

  test("a budget pointing to a nonexistent slot is rejected", () => {
    expect(() =>
      compileBuilder({
        ...DEFINITION,
        budgets: [{ id: "b", name: "B", total: 5, slots: ["no-existe"] }],
      })
    ).toThrow(/nonexistent slot/);
  });

  test("a broken formula in `derived` is rejected at compile time", () => {
    expect(() =>
      compileBuilder({ ...DEFINITION, derived: [{ name: "x", formula: "eval(1)" }] })
    ).toThrow();
  });
});

// ── Build validation ─────────────────────────────────────────────────────────

describe("validation: ALL the problems, not the first", () => {
  test("a correct build gives no errors", () => {
    expect(validateBuild(compiled, build()).filter((i) => i.level === "error")).toHaveLength(0);
  });

  test("returns the whole list, not one at a time", () => {
    // Whoever puts together a build wants to see "you are over on points AND missing the weapon",
    // not play whack-a-mole.
    const broken = validateBuild(compiled, {
      selections: { talents: ["t1", "t2", "t3"] }, // 10 points of 5, and no weapon
    });
    const errors = broken.filter((i) => i.level === "error");
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.message.includes("Arma"))).toBe(true);
    expect(errors.some((e) => e.message.includes("Puntos de talento"))).toBe(true);
  });

  test("an overfilled slot is detected", () => {
    const issues = validateBuild(compiled, build({ selections: { weapon: ["sword", "bow"] } }));
    expect(issues.some((i) => i.message.includes("allows 1"))).toBe(true);
  });

  test("an option in the WRONG slot is detected", () => {
    // The classic error of a build code tampered with by hand.
    const issues = validateBuild(compiled, {
      selections: { weapon: ["heavy-armor"], talents: [] },
    });
    expect(issues.some((i) => i.message.includes("belongs to"))).toBe(true);
  });

  test("requirements cross slots", () => {
    // `t3` requires `t1`, which can be anywhere.
    const issues = validateBuild(compiled, { selections: { weapon: ["sword"], talents: ["t3"] } });
    expect(issues.some((i) => i.message.includes("requires"))).toBe(true);
  });

  test("exclusions also cross slots", () => {
    const issues = validateBuild(compiled, {
      selections: { weapon: ["bow"], armor: ["heavy-armor"], talents: [] },
    });
    expect(issues.some((i) => i.message.includes("does not coexist"))).toBe(true);
  });

  test("unspent points WARN, they do not invalidate", () => {
    // It is almost always an oversight, and whoever publishes a guide wants to know —
    // but the build is playable.
    const issues = validateBuild(compiled, { selections: { weapon: ["sword"], talents: ["t1"] } });
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
    expect(issues.some((i) => i.level === "warning" && i.message.includes("unspent"))).toBe(
      true
    );
  });

  test("an attribute that does not exist in the game is rejected", () => {
    const issues = validateBuild(compiled, build({ attributes: { invented: 5 } }));
    expect(issues.some((i) => i.message.includes("does not exist in this game"))).toBe(true);
  });
});

// ── Computation ──────────────────────────────────────────────────────────────

describe("stats computation", () => {
  test("base + attributes + modifiers → formulas", () => {
    const stats = computeStats(compiled, build());
    expect(stats.atk_flat).toBe(70); // sword 50 + t2 20
    expect(stats.atk_pct).toBe(10); // t1
    // (100+70) * 1.10. With `toBeCloseTo` because the engine does NOT round: in floating
    // point this is 187.00000000000003, and rounding would be deciding for the
    // game. Whoever wants integers wraps it in `floor()`, which is on the
    // allowlist precisely for that.
    expect(stats.atk_final).toBeCloseTo(187, 6);
  });

  test("`floor()` in the formula returns the integer the game expects", () => {
    const floored = compileBuilder({
      ...DEFINITION,
      derived: [
        { name: "atk_final", formula: "floor((atk_base + atk_flat) * (1 + atk_pct / 100))" },
      ],
    });
    expect(computeStats(floored, build()).atk_final).toBe(187);
  });

  test("the user's attributes ADD to the base", () => {
    const stats = computeStats(compiled, build({ attributes: { atk_base: 50 } }));
    expect(stats.atk_base).toBe(150);
  });

  test("an invalid build is NOT computed", () => {
    // Returning stats for an impossible build would be worse than failing: someone
    // would publish the guide with those numbers.
    expect(() => computeStats(compiled, { selections: { talents: ["t1"] } })).toThrow(
      /Invalid build/
    );
  });
});

// ── Build codes ──────────────────────────────────────────────────────────────

describe("build codes: they travel through chats", () => {
  test("round trip preserves the build", () => {
    const original = build({ attributes: { atk_base: 25 } });
    const decoded = decodeBuild(encodeBuild("test-rpg", original));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.builderId).toBe("test-rpg");
      expect(decoded.build.selections).toEqual(original.selections);
      expect(decoded.build.attributes).toEqual(original.attributes);
    }
  });

  test("the code is safe for URLs and chats", () => {
    // base64url: no +/= that break when pasted.
    const code = encodeBuild("test-rpg", build());
    expect(code).not.toMatch(/[+/=]/);
  });

  test("a truncated code does NOT throw: it returns the reason", () => {
    const code = encodeBuild("test-rpg", build());
    const decoded = decodeBuild(code.slice(0, code.length / 2));
    expect(decoded.ok).toBe(false);
  });

  test("garbage does not throw either", () => {
    for (const junk of ["", "no-es-base64!!", "aGVsbG8"]) {
      expect(() => decodeBuild(junk)).not.toThrow();
      expect(decodeBuild(junk).ok).toBe(false);
    }
  });

  test("a future version is rejected clearly", () => {
    // Versioned from day one: when the format changes, old codes
    // will keep opening and new ones will say what is going on.
    const future = btoa(JSON.stringify({ v: 99, b: "x", s: {} }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const decoded = decodeBuild(future);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toMatch(/Unsupported code version/);
  });

  test("a code with malformed selections is rejected, it does not slip through", () => {
    const bad = btoa(JSON.stringify({ v: 1, b: "x", s: { weapon: [1, 2, 3] } }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeBuild(bad).ok).toBe(false);
  });
});

/**
 * Publishing a build
 * ============================================================================
 *
 * Saving a build was already possible; showing it was not. What is pinned here is what
 * breaks silently when a gallery is read by subject:
 *
 * **That the client states the subject.** If the request carried "this build belongs
 * to Infergon", anyone could hang theirs on someone else's page. It comes
 * from the build, read against its definition, and that is why it is checked here.
 *
 * **That the subject is truly optional.** A SQUAD builder has no single
 * subject; if `subjectOfBuild` returned something made up, those builds
 * would show up in the gallery of whoever was first in the list.
 */
describe("whose build it is", () => {
  const WITH_SUBJECT: BuilderDefinition = { ...DEFINITION, subjectSlot: "weapon" };

  test("the subject is the option chosen in the slot that declares it", () => {
    const compiled = compileBuilder(WITH_SUBJECT);
    const build: Build = { selections: { weapon: ["bow"], armor: [] } };
    expect(subjectOfBuild(compiled, build)).toBe("bow");
  });

  test("without a subject slot there is no subject: a squad builder does not invent one", () => {
    const compiled = compileBuilder(DEFINITION);
    expect(subjectOfBuild(compiled, { selections: { weapon: ["bow"] } })).toBeNull();
  });

  test("with the slot empty neither: it is null, not the first option", () => {
    const compiled = compileBuilder(WITH_SUBJECT);
    expect(subjectOfBuild(compiled, { selections: { weapon: [] } })).toBeNull();
    expect(subjectOfBuild(compiled, { selections: {} })).toBeNull();
  });

  test("a subject pointing to a nonexistent slot blows up at compile time, not at publish time", () => {
    expect(() => compileBuilder({ ...DEFINITION, subjectSlot: "mascota" })).toThrow(/mascota/);
  });
});

describe("the gallery of published builds", () => {
  const ROUTES = readFileSync(
    join(__dirname, "..", "..", "kons", "kon-character-builder", "index.ts"),
    "utf-8"
  );

  test("the subject is stored from the SERVER, not from the request", () => {
    // `build` is assembled by the server from what was validated, field by field
    expect(ROUTES).toContain("subject = subjectOfBuild(compiled, build)");
    expect(ROUTES).toMatch(/subject,\s+publishedAt/);
    // `SaveBuild` does not accept it: what is not in the schema does not get in
    const schema = ROUTES.slice(ROUTES.indexOf("const SaveBuild"), ROUTES.indexOf("const EditBuild"));
    expect(schema).not.toContain("subject");
  });

  test("the gallery only lists PUBLIC ones: `unlisted` opens by its link and does not appear in lists", () => {
    // The routes are SDK operations: they are located by their declared `id`.
    const gallery = ROUTES.slice(
      ROUTES.indexOf('id: "list-builds"'),
      ROUTES.indexOf('id: "get-build"')
    );
    expect(gallery).toContain('eq(builderBuilds.visibility, "public")');
  });

  test("reading is public and writing is not", () => {
    // Before, an `app.use` that gave `optionalAuth` to GETs and `requireAuth` to the
    // rest; now each operation declares it with its `access`.
    const access = (id: string) => {
      const from = ROUTES.indexOf(`id: "${id}"`);
      expect(from, id).toBeGreaterThan(-1);
      return /access: "(\w+)"/.exec(ROUTES.slice(from))?.[1];
    };
    for (const id of ["list-builds", "get-build", "list-definitions", "get-definition"]) {
      expect(access(id), id).toBe("optional");
    }
    for (const id of ["save-build", "update-build", "delete-build", "vote-build"]) {
      expect(access(id), id).toBe("session");
    }
  });

  test("something already saved can be published, and the date is not recalculated on editing it", () => {
    expect(ROUTES).toMatch(/app\.patch\(\s*"\/builds\/:id"/);
    expect(ROUTES).toContain(
      'const publishesNow = data.visibility === "public" && !build.publishedAt'
    );
  });

  test("a public gallery does not hand out the id of whoever made it", () => {
    expect(ROUTES).toContain("const { ownerId: _ownerId, ...rest } = build;");
    expect(ROUTES).toContain("forOutside(f, user)");
  });

  test("the vote counter is recounted, not incremented by one", () => {
    const vote = ROUTES.slice(ROUTES.indexOf('id: "vote-build"'));
    expect(vote).toContain("count(*)");
    expect(vote).not.toContain("votes + 1");
    // Without a session you cannot vote: a counter that goes up by reloading orders nothing
    expect(vote).toContain('return c.json({ error: "A session is required to vote" }, 401)');
  });
});

// ── "Link" builds ────────────────────────────────────────────────────────────
// Tree planners store the build in the address: what reaches
// the server is a fragment, and ends up inside an `href` in the gallery.
describe("link builds", () => {
  const ID = "link:grim-dawn:/grim-dawn/calculadora";
  const empty = { selections: {} };

  test("an ordinary planner link is accepted", () => {
    expect(isLinkBuilder(ID)).toBe(true);
    expect(isLinkBuilder("cl1234")).toBe(false);
    expect(linkBuildProblem(ID, { ...empty, link: "#gd=AbC-12_x~3" })).toBeNull();
    expect(
      linkBuildProblem("link:arbol:/diablo-4/arbol", {
        ...empty,
        link: "#a=barbaro&n=1.2,3.1",
      })
    ).toBeNull();
    expect(
      linkBuildProblem(ID, { ...empty, link: "#gd=x", label: "Nigromante" })
    ).toBeNull();
  });

  test("nothing that could escape the href or the planner", () => {
    for (const link of [
      '#a="><script>',
      "#a=<b>",
      "#a b",
      "javascript:alert(1)",
      "#",
      "#é",
      `#${"x".repeat(4001)}`,
      7,
    ]) {
      expect(linkBuildProblem(ID, { ...empty, link } as unknown as Build)).not.toBeNull();
    }
    expect(linkBuildProblem(ID, empty)).not.toBeNull();
  });

  test("the planner id has a fixed shape", () => {
    for (const id of [
      "link:",
      "link:GD:/x",
      "link:gd:x",
      "link:gd:/x?y=1",
      "link:gd:/<x>",
    ]) {
      expect(linkBuildProblem(id, { ...empty, link: "#gd=x" })).not.toBeNull();
    }
  });

  test("a link build carries no pieces or huge labels", () => {
    expect(
      linkBuildProblem(ID, { selections: { weapon: ["x"] }, link: "#gd=x" })
    ).not.toBeNull();
    expect(
      linkBuildProblem(ID, { ...empty, link: "#gd=x", label: "x".repeat(81) })
    ).not.toBeNull();
  });

  test("the shortcut of a pieces build goes through the same filter", () => {
    expect(isValidLink("#b=arma:espada-1;casco:c")).toBe(true);
    expect(isValidLink('#b="x')).toBe(false);
  });
});
