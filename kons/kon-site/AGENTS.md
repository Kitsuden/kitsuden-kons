# AGENTS.md — kon-site

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

The configuration of several public sites served by one Kitsuden, and the table that says which
site a host is. A site's frontend calls `resolve-host` with its request's Host and draws the frame
it gets back (name, logo, colours, menu). Eight SDK operations, mounted at `/api/site`.

## Calling it

- Resolve: no scope needed. `GET /api/site/resolve?host=example.com`, MCP tool `site__resolve-host`.
  Returns `{ data: { slug, name, description, locale, logoUrl, faviconUrl, colors, menu, extra, primaryHost } }`.
- Read one: no scope needed. `GET /api/site/sites/:slug`, MCP tool `site__get-site`, same shape.
- Lists (`site__list-sites`, `site__list-domains`): `kon:site:list-sites` / `kon:site:list-domains`,
  `site:*`, or `site:list`.
- Writes: the fine scopes `kon:site:save-site`, `kon:site:delete-site`, `kon:site:save-domain`,
  `kon:site:delete-domain`, `site:*`, or the policy scopes `site:create` (+ `site:update` to rewrite
  a site), `site:update` for domains, `site:delete` to delete a site.
- All four writes are sensitive. With human approval on they come back
  `202 KITSUDEN_E_APPROVAL_REQUIRED`: report the proposal to the user, do not retry.
- `save-site` (body `{ slug, name, … }`) is an upsert by slug: repeating it is safe. A field left out
  keeps its value, `null` clears it, and `colors`, `menu`, `extra` are replaced whole.
- `save-domain` (`host` in the path, body `{ site, primary? }`) is an upsert by host: repeating it is
  safe. It moves a host from one site to another without asking; check `list-domains` first.
- Refused on purpose: a host that is a URL, has a path, is an IPv6 literal or a single label other
  than `localhost` (400); images that are not http(s) or a site path, menu links other than http(s),
  site paths, `mailto:`, `tel:` and `#anchor`, a third menu level, more than 24 colours, and `extra`
  over 16 KB (422, the body's schema).
- A 404 means the slug or host does not exist; nothing is hidden by row security here.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Zod inputs and outputs, the eight operations (`siteOperations`), the router and the `defineKonSdk` definition. |
| `site.hosts.ts` | Pure rules: `normalizeHost` and `hostCandidates` (the `www.` fallback). No imports. |
| `site.policy.ts` | The `site` policy (`view`, `list`, `create`, `update`, `delete`). |
| `site.schema.ts` | Drizzle tables `site_sites`, `site_domains` and the menu types. |
| `kon.json` | Manifest: id, version, tables, mount path. |
| `migrations/0001_site.sql` | Creates both tables, the slug index, the site index and the one-primary-per-site partial index. |

## Rules that must hold

- Hosts are stored and looked up only through `normalizeHost`: lower case, no port, no trailing dot
  (`tests/unit/kon-site.test.ts`).
- `resolve-host` tries the host, then the host without `www.`; never the other way round, so a site
  registered with `www.` answers only that (`hostCandidates`).
- At most one primary domain per site: `save-domain` unsets the old one before writing, and the
  partial unique index `site_domains_primary_idx` refuses a second.
- Nothing in the kon caches: a change is seen on the next request by every replica. Do not add an
  in-process cache without a way to invalidate it on every replica.
- No `javascript:`, `data:` or `//host` value is ever stored in an image or a menu link.
- Operation ids (`resolve-host`, `get-site`, `list-sites`, `save-site`, `delete-site`,
  `list-domains`, `save-domain`, `delete-domain`) are contract: they name the MCP tools and fine
  scopes. Do not rename them.

## Changing it

- New migration: the next number in `migrations/` (`0002_...sql`). Never edit an applied one; if a
  checksum must change, the old one goes in `migrations/history.json`.
- New file at the root: run `pnpm kon:sync` (it updates `package.json` `files` and `kon.json`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`.
- A new route goes in `authorization-matrix.kons.json` and in the README's HTTP API table.

## Tests

```bash
pnpm vitest run tests/unit/kon-site.test.ts
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-site"
```
