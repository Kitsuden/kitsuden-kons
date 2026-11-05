/**
 * @kitsuden/kon-maps
 * ============================================================================
 *
 * Interactive game maps: an image with layers, categories and thousands of
 * markers on top.
 *
 * The engine does NOT import Leaflet or any map library: that is for the
 * CLIENT, and the viewer can use whichever it wants. What lives here is the
 * data model and its rules —normalized coordinates, validation, clustering—
 * which is what makes the tools built on top of it robust.
 */

import {
  repo,
  defineKonSdk,
  defineOperation,
  operationsRouter,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";

import {
  clusterMarkers,
  validateMapDefinition,
  validateMarker,
  type MapDefinition,
} from "./maps.engine.js";
import "./maps.policy.js";
import { gameMaps, mapCategories, mapMarkers } from "./maps.schema.js";
import manifest from "./kon.json" with { type: "json" };

/** Version and tables come from kon.json, the one place they are written (tests/guards/kon-single-source). */
const konTables = manifest.tables.map((t: string | { name: string }) => (typeof t === "string" ? t : t.name));

export * from "./maps.engine.js";
export * from "./maps.schema.js";

const MarkerInput = z.object({
  layerId: z.string().min(1),
  categoryId: z.string().min(1),
  /** Normalized [0..1]. Out of range is REJECTED, not clamped. */
  x: z.number(),
  y: z.number(),
  title: z.string().min(1).max(200),
  body: z.string().max(4000).nullable().optional(),
});

const ImportMarkers = z.object({ markers: z.array(MarkerInput).min(1).max(5000) });

/**
 * Shape of `PUT /maps`. Before, the JSON was read raw: the slug could be
 * anything of any length and `definition` any object (with layers that were not
 * a list, the engine blew up with a 500).
 */
const UpsertMap = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, "slug: lowercase letters, numbers and hyphens"),
  definition: z
    .object({
      id: z.string().max(80).optional(),
      name: z.string().min(1).max(200),
      /** http(s) or a path on the site itself: no `javascript:` or `data:`. */
      imageUrl: z
        .string()
        .min(1)
        .max(2000)
        .refine(
          (u) => /^(https?:)?[/][^/]|^https?:[/][/]/i.test(u),
          "imageUrl must be http(s) or a path starting with /"
        ),
      aspectRatio: z.number().finite().positive().max(100),
      layers: z
        .array(z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(200) }))
        .min(1)
        .max(100),
    })
    .passthrough(),
  /**
   * Map marker categories (chests, bosses, NPCs…). Without them NOT A SINGLE
   * marker could be imported through the API: `POST /markers` requires the
   * category to exist in `map_categories` and no route wrote it
   * (an earlier audit). They are UPSERTED by id: omitting them leaves the ones that exist, and
   * one that no longer comes is not deleted (it has markers hanging from it).
   */
  categories: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        name: z.string().min(1).max(200),
        icon: z.string().max(200).nullable().optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{3,8}$/, "color: hex (#rgb, #rrggbb…)")
          .optional(),
      })
    )
    .max(500)
    .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, "duplicate category")
    .optional(),
});

// ── Outputs (OpenAPI and MCP) ────────────────────────────────────────────────
//
// Loose on purpose (`passthrough`): they are database rows.

/** A database row: it carries `id`, and the rest as is. */
const Row = z.object({ id: z.string() }).passthrough();

const ParamSlug = z.object({ slug: z.string().describe("Map slug") });

/**
 * `PUT /maps` responds 201 on create and 200 on rewrite: `otherStatuses`
 * publishes it (see `PUBLISH_OUTPUT` in kon-tierlist).
 */
const SAVE_OUTPUT = {
  schema: z.object({ data: Row, categories: z.array(Row) }),
  otherStatuses: [201 as const],
  description: "Rewritten (200) or created (201)",
};

export const KON_ID = "kon-maps";

export function mapsOperations(ctx: KonContext): AnyOperation[] {
  const db = ctx.db.instance;

  // The viewer reads without a session: it lives on a public page and is usually embedded.
  // Writing requires a session: before, a `requireAuth` over `/maps/*` for whatever
  // was not GET; now, the `access` of each operation.
  return [
    /**
     * Full map: definition, categories and markers.
     *
     * All in ONE response on purpose: the viewer needs all three to paint the
     * first frame, and three chained requests are three network hops before
     * seeing anything.
     */
    defineOperation({
      id: "get-map",
      method: "GET",
      route: "/maps/:slug",
      summary: "Read a map with its categories and markers",
      description:
        "The map definition (image, aspect ratio, layers), its marker categories and its markers, in one response. Coordinates are normalized [0..1]. With `?cluster=<grid>` (a cell size in normalized units, at least 1/4096) markers come grouped in `clusters` and `markers` is empty. Public.",
      access: "public",
      input: {
        params: ParamSlug,
        query: z
          .object({
            cluster: z
              .string()
              .optional()
              .describe("Cluster grid size in normalized units (e.g. 0.05); omit for raw markers"),
          })
          .passthrough(),
      },
      output: {
        schema: z.object({
          data: Row,
          categories: z.array(Row),
          markers: z.array(Row),
          clusters: z.array(z.record(z.string(), z.unknown())).nullable(),
        }),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async (_input, { c }) => {
        const [map] = await repo(gameMaps, { db })
          .filter({ slug: c.req.param("slug") })
          .all();
        if (!map) return c.json({ error: "Not found" }, 404);

        const categories = await repo(mapCategories, { db }).filter({ mapId: map.id }).all();
        const markers = await repo(mapMarkers, { db }).filter({ mapId: map.id }).all();

        // `?cluster=0.05` returns grouped: with 3,000 markers, sending them all
        // and grouping on the client is transferring extra just to throw it away.
        // A grid smaller than 1/4096 groups nothing visible: it only multiplies
        // the cells.
        const grid = Number(c.req.query("cluster"));
        const clusters =
          Number.isFinite(grid) && grid > 0
            ? clusterMarkers(markers, Math.max(grid, 1 / 4096))
            : null;

        return c.json({ data: map, categories, markers: clusters ? [] : markers, clusters });
      },
    }),

    defineOperation({
      id: "save-map",
      method: "PUT",
      route: "/maps",
      summary: "Create or rewrite a map",
      description:
        "Upsert by slug: 201 when it creates the map, 200 when it rewrites it. `definition` holds name, image (http(s) or a site path), aspect ratio and layers; `categories` are upserted by id (omitted ones are kept). A malformed body is a 400 with `issues`, an inconsistent definition a 422. Site staff (admin/editor), or an agent with maps:create (maps:update to rewrite one).",
      access: "session",
      // The policy BEFORE reading the body, as before the SDK (403 before 400).
      permission: { policy: { resource: "maps", action: "create" } },
      // Rewrites a public map in one go.
      sensitive: true,
      // The body is validated by the handler: its 400 ("Valid `slug` and
      // `definition` are required", with `issues`) is the usual one.
      input: { body: UpsertMap, validatesHandler: true },
      output: SAVE_OUTPUT,
      errors: ["KITSUDEN_E_CONFLICT"],
      handle: async ({ body: rawValue }, { c, can }) => {
        // The body was already read by the SDK (`undefined` if it came empty; before, `null`).
        const read = UpsertMap.safeParse(rawValue ?? null);
        if (!read.success) {
          return c.json(
            { error: "Valid `slug` and `definition` are required", issues: read.error.issues },
            400
          );
        }
        const body = read.data as {
          slug: string;
          definition: MapDefinition;
          categories?: Array<{ id: string; name: string; icon?: string | null; color?: string }>;
        };

        const errors = validateMapDefinition(body.definition);
        if (errors.length) return c.json({ error: "Invalid map", issues: errors }, 422);

        const [existing] = await repo(gameMaps, { db }).filter({ slug: body.slug }).all();
        // Overwriting a map that already exists is EDITING it: it is asked via `update`
        // (today it coincides with `create`, but it does not have to).
        if (existing && !(await can(existing, "update"))) {
          return c.json({ error: "Forbidden" }, 403);
        }
        const values = { slug: body.slug, name: body.definition.name, definition: body.definition };
        const row = existing
          ? (
              await repo(gameMaps, { db })
                .filter({ id: existing.id })
                .update({ ...values, updatedAt: new Date() })
            )[0]
          : await repo(gameMaps, { db }).create(values);

        if (body.categories?.length) {
          await db
            .insert(mapCategories)
            .values(
              body.categories.map((cat) => ({
                mapId: row.id,
                categoryId: cat.id,
                name: cat.name,
                icon: cat.icon ?? null,
                ...(cat.color ? { color: cat.color } : {}),
              }))
            )
            .onConflictDoUpdate({
              target: [mapCategories.mapId, mapCategories.categoryId],
              set: {
                name: sql`excluded.name`,
                icon: sql`excluded.icon`,
                color: sql`excluded.color`,
              },
            });
        }
        const categories = await repo(mapCategories, { db }).filter({ mapId: row.id }).all();

        return c.json({ data: row, categories }, existing ? 200 : 201);
      },
    }),

    /**
     * Imports markers in bulk: this is how they arrive from a scrape or a CSV.
     *
     * **All or nothing**: if one marker is wrong, none gets in. A partial import
     * leaves the map in a state nobody knows whether it is complete, and the
     * usual cause of an error here —coordinates on another scale— affects the
     * whole batch, not a single row.
     */
    defineOperation({
      id: "import-markers",
      method: "POST",
      route: "/maps/:slug/markers",
      summary: "Import markers into a map",
      description:
        "Adds 1-5000 markers (layer, category, normalized x/y in [0..1], title, body). All or nothing: if any marker is invalid (unknown layer or category, out-of-range coordinates) none is saved and the 422 lists `issues` by index. Categories must exist (create them with save-map). Site staff (admin/editor), or an agent with maps:create. Returns 201 with the count.",
      access: "session",
      permission: { policy: { resource: "maps", action: "create", inHandler: true } },
      // Bulk import into a public map.
      sensitive: true,
      input: { params: ParamSlug, body: ImportMarkers },
      output: { status: 201, schema: z.object({ data: z.object({ imported: z.number() }) }) },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      handle: async ({ body: bodyValue }, { c, can }) => {
        // The policy is checked after validating the body, as before the SDK.
        if (!(await can({}))) return c.json({ error: "Forbidden" }, 403);

        const [map] = await repo(gameMaps, { db })
          .filter({ slug: c.req.param("slug") })
          .all();
        if (!map) return c.json({ error: "Not found" }, 404);

        const categories = await repo(mapCategories, { db }).filter({ mapId: map.id }).all();
        const { markers } = bodyValue;

        const issues: Array<{ index: number; errors: string[] }> = [];
        markers.forEach((marker, index) => {
          const errors = validateMarker(
            map.definition,
            categories.map((cat) => ({
              id: cat.categoryId,
              name: cat.name,
              icon: cat.icon,
              color: cat.color,
            })),
            marker as never
          );
          if (errors.length) issues.push({ index, errors });
        });

        if (issues.length) {
          return c.json({ error: `${issues.length} invalid marker(s)`, issues }, 422);
        }

        // A single insert: 5,000 INSERTs in a row per request added nothing.
        await repo(mapMarkers, { db }).createMany(
          markers.map((marker) => ({ ...marker, mapId: map.id }))
        );

        return c.json({ data: { imported: markers.length } }, 201);
      },
    }),
  ];
}

export function createKonMaps(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, mapsOperations(ctx), ctx);
}

/**
 * SDK kon (docs/kons/README.md): each route is a declared operation
 * (`mapsOperations`), with its OpenAPI, its MCP tool and its fine-grained scope.
 */
export const kon = defineKonSdk({
  id: KON_ID,
  name: "Maps",
  version: manifest.version,
  description: "Interactive game maps: layers, categories, markers and clustering",
  icon: "Map",
  mountPath: "/api/maps",
  operations: (ctx: KonContext) => mapsOperations(ctx),

  tables: konTables,

  // kon.json `admin` is the one list of admin views; the definition copies it.
  admin: {
    category: manifest.admin.category as "tools",
    views: manifest.admin.views.map((v) => ({ id: v.id, type: v.type as "grid", title: v.title, table: v.table })),
  },

  dependencies: { kons: [], core: ["auth"] },

  hooks: {
    onStartup: async (ctx) => {
      ctx.logger.info("🗺️  Maps ready — normalized coordinates, no Leaflet dependency");
    },
  },
});

export default kon;
