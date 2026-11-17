# kon-listings

Listings of any kind (real estate, vehicles, jobs) with a public search for your own site,
inquiries from visitors, and the XML feeds portals such as Trovit and Mitula read.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| experimental | business | 0.1.0 | `/api/listings` | — |

A real estate agency keeps its properties here and shows them on its own site; a car dealer does
the same with its stock; and both publish to aggregators without retyping anything. The kind of
listing is data (`verticals/`), and so is each portal's format (`portals/`): a new kind of listing
or a new portal is a JSON file, not code.

## Install

Inside a Kitsuden project: `kitsuden kon add listings`, then restart the API.

With kon-crm, apply its `real-estate` preset (`POST /api/crm/presets/:id/apply` with that id) for
the agency's pipeline, and listen to `listings:inquiry.received` to turn inquiries into leads.

## What it adds

- `listings_items`: one row per listing. The columns every kind shares (title, description, price,
  currency, location, images, status) are columns; what one kind adds is in `attributes`, checked
  against its vertical. Status is `draft`, `published`, `paused` or `closed` (sold, rented,
  filled); only `published` is visible to the public and goes to portals.
- `listings_feeds`: one feed per portal and vertical, read by the portal from a URL with a token.
- `listings_inquiries`: what visitors asked about a listing. Personal data: team only.

### Verticals

| Vertical | Attributes | Needs to publish |
| --- | --- | --- |
| `real-estate` | operation (sale, rent), property type, bedrooms, bathrooms, areas, parking, floor, year, furnished, new build, amenities | price, currency, city, images, operation, property type |
| `vehicles` | make, model, year, mileage, condition, fuel, transmission, body type, color, doors, engine | price, currency, city, images, make, model, year, condition |
| `jobs` | company, contract, workplace, category, salary range and period, experience | city, company, contract |

A draft may be incomplete: every write checks the attributes' types, and the requirements are
checked only when the listing is published (and on every change while it stays published).

### Portal feeds

Trovit and Mitula read an XML document from a URL, usually once a day; they do not take listings
through an API. A feed is that document: the published listings of one vertical, in the portal's
format. `portals/trovit.json` and `portals/mitula.json` say how each listing becomes an ad.

**The mappings are unverified.** Neither portal publishes its feed specification; they send it
when you open a publisher account. The element names follow the format integrators describe.
Check them against the specification the portal gives you and edit the JSON file; then set
`verified: true`.

A listing missing an element the portal requires is left out of the XML instead of being sent
broken; `GET /api/listings/feeds/:id/check` lists which and why.

## HTTP API

| Route | Who |
| --- | --- |
| `GET /api/listings/verticals` | anyone |
| `GET /api/listings` | anyone (published listings; the team sees every status) |
| `GET /api/listings/:id` | anyone for a published listing; the team for the rest |
| `GET /api/listings/by-slug/:slug` | anyone for a published listing; the team for the rest |
| `POST /api/listings` | the team |
| `PATCH /api/listings/:id` | the team |
| `DELETE /api/listings/:id` | the team |
| `POST /api/listings/:id/inquiries` | anyone, for a published listing (rate-limited) |
| `GET /api/listings/inquiries` | the team |
| `DELETE /api/listings/inquiries/:id` | the team |
| `GET /api/listings/portals` | the team |
| `GET /api/listings/feeds` | the team |
| `POST /api/listings/feeds` | the team |
| `PATCH /api/listings/feeds/:id` | the team |
| `DELETE /api/listings/feeds/:id` | the team |
| `GET /api/listings/feeds/:id/check` | the team |
| `GET /api/listings/feed/:token` | anyone with the URL (rate-limited) |

Search filters on `GET /api/listings`: `vertical`, `city`, `region`, `q` (words in the title),
`priceMin`, `priceMax`, `attr` (one attribute, `operation:rent`), `sort` (`newest`, `price-asc`,
`price-desc`), `limit` (up to 100) and `offset`.

## Who can do what

`listings.policy.ts` decides, and row security in the migration says the same:

- **Anyone**, signed in or not, reads published listings and may send an inquiry about one.
- **The team** (admin, editor, or an agent with `listings:*`) sees every status, writes listings,
  manages feeds and reads inquiries.
- **A portal** reads its feed with the token in the URL. The token shows nothing that is not
  already published; rotate it (`rotateToken`) if the URL leaks.

A listing that is not published answers 404 to everyone outside the team, never 403.

## Configuration

None in the environment. A feed's settings are its `listingUrl` (where each listing lives on your
site, with `{slug}` or `{id}`) and the agency's name, phone and email, sent with every ad.

## Agents and MCP

MCP tools `listings__list`, `listings__get`, `listings__get-by-slug`, `listings__create`,
`listings__update`, `listings__delete`, `listings__list-verticals`, `listings__list-portals`,
`listings__list-feeds`, `listings__create-feed`, `listings__update-feed`, `listings__delete-feed`,
`listings__check-feed`, `listings__list-inquiries` and `listings__delete-inquiry`. The XML feed and
the visitors' inquiry form are not tools. See [AGENTS.md](AGENTS.md).

## Tests

`tests/unit/kon-listings.test.ts` (`pnpm vitest run tests/unit/kon-listings.test.ts`).

## License

MIT
