# AGENTS.md — kon-listings

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Keep it true when the kon changes.

## What it is

Listings of any kind (real estate, vehicles, jobs), a public search for the agency's own site,
inquiries from visitors, and the XML feeds that portals such as Trovit and Mitula download. The
kinds of listing are files in `verticals/` and each portal's format is a file in `portals/`.

## Calling it

- Reading published listings needs no key. Writes need a key with `listings:*`, `kon:listings:*`
  or the operation's fine scope (`kon:listings:create`, `kon:listings:create-feed`…). A deny on
  the key (`!kon:listings:delete`) wins over any grant.
- Before creating a listing, read `listings__list-verticals`: it gives each vertical's attribute
  keys, types and options. An unknown key or a wrong type is a 422 that names the field.
- Create as a draft first if something is missing. Publishing (`status: "published"`) answers 422
  with every field the vertical still needs.
- To take a listing off the site and the portals, set `status` to `paused` or `closed`; delete
  only what was created by mistake.
- Before telling someone a feed is ready, run `listings__check-feed`: it lists the published
  listings the portal would not receive and the elements each one lacks.
- `listings__list-portals` says whether a portal's mapping is `verified`. Say so when it is not.
- `listings__delete`, `listings__delete-feed` and `listings__delete-inquiry` are marked sensitive.
  A write held for human approval answers `202 KITSUDEN_E_APPROVAL_REQUIRED`: report the proposal,
  do not retry.
- Inquiries hold names, emails and phones (`sensitivity` in kon.json): never copy them anywhere
  the person did not ask for.

## Map of the code

- `kon.json` — manifest: version, tables, mount path, sensitivity. The single source.
- `index.ts` — the kon definition: operations, rate limits, admin views.
- `listings.routes.ts` — the operations (REST route, OpenAPI entry and MCP tool each).
- `listings.verticals.ts` — loads `verticals/*.json` and checks attributes and publishing.
- `listings.feeds.ts` — loads `portals/*.json` and builds a portal's XML. Pure: no database.
- `listings.policy.ts` — who may view, create, update and delete each resource.
- `listings.schema.ts` — the drizzle tables.
- `verticals/` — one JSON file per kind of listing.
- `portals/` — one JSON file per portal: element names, value maps, required elements.
- `migrations/` — numbered SQL, with the tables' row security.

## Rules that must hold

- Tables are created by migrations only, never at runtime.
- The public never sees a listing that is not published: the route filters by `status` and row
  security filters again. Feeds and inquiries are the team's at the database level too.
- The feed lookup by token and the visitor's inquiry are the only `asSystem` calls, each after the
  application decided the action is allowed.
- XML text is escaped, never wrapped in CDATA, and element names come only from portal files,
  checked when they load.
- A listing missing a required portal element is left out of that portal's feed and reported by
  `check-feed`, never sent incomplete.
- Image URLs are https: portals download them.

## Changing it

- A new kind of listing: add `verticals/<id>.json` and its mapping in every file of `portals/`
  (the test "every shipped portal maps every shipped vertical" fails otherwise).
- A new portal: add `portals/<id>.json` with `verified: false` until someone checks it against
  the portal's specification.
- Schema change: edit `listings.schema.ts` and add the next numbered migration. Never edit an
  applied migration.
- New file next to `index.ts`: run `pnpm kon:sync` (package.json `files`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync` (it copies it
  to `kon.json`).

## Tests

`pnpm vitest run tests/unit/kon-listings.test.ts`
