# kon-site

Several public sites from one Kitsuden. Each site has the frame its frontend draws (name, logo,
colours, menu) and the domains that lead to it. A frontend reads the request's `Host`, asks
`GET /api/site/resolve?host=`, and renders the site it gets back.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | core | 0.1.0 | `/api/site` | — (core `auth`) |

## Install

```bash
kitsuden kon add site --enable
```

Run it inside a Kitsuden project. The kon is off by default (`defaultEnabled: false` in `package.json`),
so pass `--enable` or switch it on in the admin panel (**Kons**). It needs no other kon and no
environment variables.

## What it adds

Install it when one Kitsuden serves more than one public site (one per community, game or brand)
and each site's frontend must know which one it is from the domain it was reached at. With one
site, the core's own **Settings** (site name, branding, main menu) is enough.

A **site** has a unique `slug`, a `name`, an optional `description` and default `locale`, a
`logoUrl` and `faviconUrl` (http(s) URLs or paths on the site itself), named `colors` as hex
(`primary`, `accent`… the frontend decides what each name paints), a `menu` of up to 50 links with
one optional level of children, and `extra`: up to 16 KB of JSON for whatever else the site's
template reads (social links, footer text).

A **domain** is a host name that leads to one site; one per site can be marked primary (the
canonical one). Hosts are stored normalized: lower case, without the port or the trailing dot.

This kon does not touch DNS, certificates or the proxy. The proxy in front (Caddy, Traefik,
Coolify) must already send every domain to the frontend; the kon only answers which site a host is.

Tables (from `kon.json`):

| Table | What it holds |
| --- | --- |
| `site_sites` | One row per site: unique `slug`, `name`, `description`, `locale`, `logo_url`, `favicon_url`, and `colors`, `menu`, `extra` as JSON. |
| `site_domains` | One row per host (`host` is the key), the `site_id` it leads to and `is_primary`; at most one primary per site. Deleting a site deletes its domains. |

The tables have no owner column and no row-level security: a site's configuration is public.

## HTTP API

| Method and path | Who | What it does |
| --- | --- | --- |
| `GET /api/site/resolve` | Anyone, no session | `?host=` (the Host header as it arrived; port and case are ignored) → the site's public configuration and `primaryHost`. A host registered without `www.` also answers with `www.`. 404 when no site has the host, 400 when it is not a host name. |
| `GET /api/site/sites/:slug` | Anyone, no session | The same configuration by slug, for a frontend that knows its site at build time. 404 for an unknown slug. |
| `GET /api/site/sites` | Staff (admin, editor) | Every site with its `hosts` and `primaryHost`. |
| `PUT /api/site/sites` | Admins | Creates (201) or rewrites (200) a site by `slug`. On a rewrite, a field left out keeps its value and `null` clears it; `colors`, `menu` and `extra` are replaced whole when sent. |
| `DELETE /api/site/sites/:slug` | Admins | Deletes the site and its domains. 204, or 404 for an unknown slug. |
| `GET /api/site/domains` | Staff (admin, editor) | Every domain with its site and `primary`. `?site=<slug>` keeps one site's. |
| `PUT /api/site/domains/:host` | Admins | Points a host at a site (`{ "site": "<slug>", "primary": true }`): 201 when new, 200 when it moves or changes. `primary: true` unsets the site's previous primary. |
| `DELETE /api/site/domains/:host` | Admins | The host stops leading anywhere. 204, or 404 when it is not registered. |

Body of `PUT /api/site/sites`:

```json
{
  "slug": "valhalla",
  "name": "Valhalla Legion",
  "locale": "es",
  "logoUrl": "/media/valhalla/logo.svg",
  "colors": { "primary": "#e11d48", "accent": "#0ea5e9" },
  "menu": [
    { "label": "News", "href": "/blog" },
    { "label": "Games", "href": "/games", "children": [{ "label": "Wikis", "href": "/wikis" }] },
    { "label": "Discord", "href": "https://discord.gg/example", "newTab": true }
  ],
  "extra": { "footer": "Made by the community" }
}
```

Images take http(s) URLs or site paths; menu links also take `mailto:`, `tel:` and `#anchor`.
`javascript:`, `data:` and protocol-relative `//host` links are refused with a 422.

How a frontend uses it, once per request (cache the answer for a short time if you like; nothing
in the kon caches, so a change in the panel shows on the next request):

```ts
const res = await fetch(`${API}/api/site/resolve?host=${encodeURIComponent(request.headers.get("host") ?? "")}`);
if (res.status === 404) return notFound();
const { data: site } = await res.json();
```

## Who can do what

The policy is `site.policy.ts` (resource `site`):

| Action | Allowed |
| --- | --- |
| `view` | Everyone |
| `list` | `admin`, `editor` |
| `create` | `admin` |
| `update` | `admin` |
| `delete` | `admin` |

- Anonymous visitors read a site's configuration and resolve hosts; listing sites and domains is
  for the site team; every write is for admins, because a domain pointed elsewhere or a swapped logo
  changes what every visitor sees at once.
- Rewriting a site that already exists checks `update` as well as `create`.
- Agents pass with the fine scope of the operation (`kon:site:save-site`, `kon:site:save-domain`…),
  the kon-wide `site:*`, `admin`, or the policy scopes `site:list`, `site:create`, `site:update`,
  `site:delete`. A denial on the key always wins.

## Configuration

None. The kon reads no environment variables and no settings.

## Agents and MCP

Every route is a kon SDK operation, so each is also an MCP tool:

| MCP tool | Fine scope | Writes | Sensitive |
| --- | --- | --- | --- |
| `site__resolve-host` | `kon:site:resolve-host` | no | no |
| `site__get-site` | `kon:site:get-site` | no | no |
| `site__list-sites` | `kon:site:list-sites` | no | no |
| `site__save-site` | `kon:site:save-site` | yes | yes |
| `site__delete-site` | `kon:site:delete-site` | yes | yes |
| `site__list-domains` | `kon:site:list-domains` | no | no |
| `site__save-domain` | `kon:site:save-domain` | yes | yes |
| `site__delete-domain` | `kon:site:delete-domain` | yes | yes |

The writes are sensitive: with human approval on, an agent's call comes back as
`202 KITSUDEN_E_APPROVAL_REQUIRED` until a person approves it. See [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/kon-site.test.ts` | Host normalization, saving sites and domains, resolving by Host with the `www.` fallback, one primary per site, refused links and images, who may write. |

```bash
pnpm vitest run tests/unit/kon-site.test.ts
```

## License

MIT.
