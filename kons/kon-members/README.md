# kon-members

Paid memberships for a Kitsuden site: membership tiers, members (readers, not CMS accounts),
passwordless sign-in by magic link, and an access check that other kons (a blog, an academy, a
downloads area) call to decide whether a reader may see a piece of content.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| stable (tier `essential`) | core | 1.0.1 | `/api/members` | — (core `auth`; optional: kon-payments) |

## Install

```bash
kitsuden kon add members --enable
```

`package.json` has `defaultEnabled: false`, so pass `--enable` (or switch the kon on in the admin
panel, **Kons**). Restart the API afterwards. No other kon is required; with kon-payments installed,
paid subscriptions grant access by themselves (see [Paid access from kon-payments](#paid-access-from-kon-payments)).

The magic-link e-mail goes through the host's shared mailer, so the host must have mail configured
for readers to receive their sign-in link. See [Configuration](#configuration) for the two optional
environment variables.

## What it adds

Members are a separate identity system from CMS accounts: a reader signs in with a link sent to
their e-mail and gets a `kitsuden_member` cookie; nothing a reader does gives them backoffice
permissions.

Tables (from `kon.json`, created by `migrations/0001_members.sql`):

| Table | What it holds |
| --- | --- |
| `member_tiers` | Membership levels: `slug`, `name`, `level` (0-100), monthly and yearly price in cents, `currency` (default `EUR`), `benefits`, `visible`, `active`. |
| `members` | Readers: unique `email` (stored lower-case), `name`, `status` (`free`, `paid`, `comped`, `canceled`), `newsletterSubscribed`, `source`, `labels`, internal `note`, optional `authUserId` link to a CMS account. |
| `member_access` | Access grants: member, tier, `source` (`subscription`, `comp`, `manual`, `import`), optional `subscriptionId`, `startsAt`, `endsAt` (null = no end), `revokedAt`. Revoking keeps the row as history. |
| `member_signins` | Magic-link tokens, stored as SHA-256 hashes, single use, valid 15 minutes. |
| `member_sessions` | Reader sessions, stored as SHA-256 hashes, valid 60 days, revocable. |

How access is decided (`members.access.ts`, pure functions):

- Content declares `visibility`: `public` (anyone), `members` (any signed-in reader, free tier
  included) or `paid` (a live grant to a tier whose `level` is at least `minTierLevel`, default 1).
- A reader's level is the highest level among their live grants. A grant is live when it has
  started, has not ended (the end instant itself no longer counts) and is not revoked.
- An unknown `visibility` value is treated as `paid`, never as `public`.
- `gateBlocks` and `gateHtml` cut gated content on the server, keeping only the first N blocks or
  paragraphs, so hidden content is never sent to the client.

### Paid access from kon-payments

On startup the kon listens on the core event bus to kon-payments' subscription events
(`payment:subscription.created`, `.updated`, `.canceled`, `.payment_succeeded`, `.payment_failed`,
`payment:payment.failed`, `payment:payment.refunded`). Nothing is imported from kon-payments; without
it, no event arrives. Each event goes through `syncPaymentSubscription`:

- The member is the one whose `authUserId` is the paying CMS account. A payment is never matched to
  a member by e-mail; an event with no linked member changes nothing and is logged.
- The tier comes from `MEMBERS_PLAN_TIERS` (`planId:tierSlug` pairs). An event without a plan (a
  cancellation, a refund) keeps the tier of the grant that subscription already has. A plan not in
  the list grants nothing and is logged.
- `syncSubscriptionAccess` then writes the grant, idempotent by `subscriptionId`: `active` and
  `trialing` grant access until the end of the paid period; a `canceled` subscription keeps access
  until that period ends; anything else revokes the grant (the row stays as history).
- The member's `status` follows: `paid` while the subscription pays; when it is cancelled,
  `canceled` (or `paid`/`comped` if another live grant remains); when it lapses for non-payment,
  `free` (with the same exception).

`syncSubscriptionAccess`, `syncPaymentSubscription` and the pure rule `grantFromSubscription` are
exported for code that runs on the server.

## HTTP API

All paths are under `/api/members`. "Reader cookie" means the `kitsuden_member` cookie set by
`POST /api/members/signin/verify`.

Reader portal (public):

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/members/tiers` | Anyone | Active, visible tiers ordered by level, with prices and benefits. |
| `POST /api/members/signin` | Anyone | Body `{ email, name? }`. Creates the member if new and sends a sign-in link. Always answers `{ ok: true, message }`, whether or not the address exists; never returns the token. |
| `POST /api/members/signin/verify` | Anyone holding a link | Consumes the token (`?token=` or `token` in the body), sets the reader cookie (httpOnly, `SameSite=Lax`, 60 days) and returns the public member. 400 without a token; 401 for an invalid, used or expired token (same error for all three). |
| `GET /api/members/me` | Anyone | The reader of the cookie: public profile, `level` and the highest tier that level reaches. `{ data: null }` without a session. |
| `POST /api/members/signout` | Anyone | Revokes the session of the cookie and deletes the cookie. Always `{ ok: true }`. |
| `POST /api/members/gate` | Anyone | Body `{ visibility, minTierLevel? }`. Returns `{ allowed, reason?, viewerLevel, requiredLevel }` for the reader of the cookie. `reason` is `anonymous`, `needs-paid` or `needs-higher-tier`. |

Backoffice (needs a CMS session or an agent key):

| Route | Who may call it | What it does |
| --- | --- | --- |
| `GET /api/members/admin/members` | Staff | All members, newest first, 50 per page (`?page=`). |
| `GET /api/members/admin/members/:id` | Staff | The full member record (with `note`) and its grants. 404 for anyone else. |
| `POST /api/members/admin/tiers` | Admin | Creates a tier. 201 with the row; 409 if the slug exists. |
| `POST /api/members/admin/access/comp` | Staff | Body `{ memberId, tierId, endsAt? }`. Adds a `comp` grant and sets the member's status to `comped`. |
| `POST /api/members/admin/access/revoke` | Staff | Body `{ memberId, tierId }` (both required, 400 otherwise). Sets `revokedAt` on every live grant of that member for that tier. |

There are no routes to edit or delete members or tiers.

## Who can do what

The policy file is `members.policy.ts`. It governs the backoffice only; a reader's access to
content is decided by `members.access.ts` and never goes through it.

| Role | Can |
| --- | --- |
| Anonymous | The six portal routes. `POST /api/members/signin` is rate limited by the host (5 per hour per IP), and the kon issues at most one link per member per minute; a throttled request gets the same answer as a sent one. |
| Reader (member cookie) | The portal routes, as themselves. Readers have no backoffice access. |
| Signed-in CMS user | Nothing in the backoffice: 403 on lists and writes, 404 on a member record. |
| Editor | List and read members, give and revoke access (resource `member`: `view`, `create`, `update`). Cannot create tiers. |
| Admin | Everything above, plus creating tiers (resource `member-tier`) and the `delete` action of `member` (no route uses it yet). |
| Agent | As staff with `members:*`, `kon:members:*` or `admin` (as admin for tiers too). Narrower: `member:view`, `member:update`, `member-tier:create`, or the fine scope of the operation. |

Row security (`migrations/0006_english_rls.sql`, `0007_fine_scope_rls.sql`):

- `members` and `member_access`: the system, human admins and editors, and agents with
  `member:view|create|update|delete`, `members:*`, `kon:members:*` or `admin`. A fine scope opens
  the rows its operation touches: `kon:members:list-members` and `kon:members:get-member` read
  `members` (`get-member` also reads `member_access`), `kon:members:gift-access` writes both, and
  `kon:members:revoke-access` writes `member_access`. A deny of the scope or of `members:*` wins.
  Everyone else sees no rows, which is why a member record answers 404 rather than 403.
- `member_signins` and `member_sessions`: the system only. The portal routes run these lookups as
  the system and limit each one to the row the token points to.
- `member_tiers` has no row security: tiers are public.

The policy lets a CMS account read the member linked to it (`authUserId`), but row security on
`members` does not, so in practice that account gets 404 too.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `MEMBERS_SIGNIN_URL` | `<siteUrl>/members/verify` | The site page the e-mail link points to; the token is added as `?token=`. That page must call `POST /api/members/signin/verify`. `siteUrl` is the host's configured site URL. |
| `MEMBERS_SIGNIN_MAIL` | on | Set to `off` to stop the kon sending the e-mail, when another delivery listens to the `members.signin-requested` event instead. |
| `MEMBERS_PLAN_TIERS` | empty | Comma-separated `planId:tierSlug` pairs (`price_123:supporter,price_456:pro`): which tier each kon-payments plan grants. Read on each event. Empty: payments grant no tier. |
| `NODE_ENV` | — | When `production`, the reader cookie is marked `Secure`. |

The link points to a site page and not to the API because a GET that opens a session would be
triggered, and the single-use token burned, by link previewers in mail clients.

Event: `members.signin-requested` with `{ memberId, email, token }` is emitted each time a link is
issued. It carries the token in clear: only trusted code should listen to it.

## Agents and MCP

Each operation has an MCP tool `members__<op>` and a fine scope `kon:members:<op>`.

| Operation | Route | MCP tool | Writes |
| --- | --- | --- | --- |
| `list-plans` | `GET /api/members/tiers` | `members__list-plans` | no |
| `request-access-link` | `POST /api/members/signin` | `members__request-access-link` | yes (creates a member, sends an e-mail) |
| `check-access` | `POST /api/members/gate` | `members__check-access` | no |
| `list-members` | `GET /api/members/admin/members` | `members__list-members` | no |
| `get-member` | `GET /api/members/admin/members/:id` | `members__get-member` | no |
| `create-plan` | `POST /api/members/admin/tiers` | `members__create-plan` | yes |
| `gift-access` | `POST /api/members/admin/access/comp` | `members__gift-access` | yes |
| `revoke-access` | `POST /api/members/admin/access/revoke` | `members__revoke-access` | yes, sensitive |

`verify-access-link`, `get-reader` and `sign-out-reader` are not MCP tools: they work on a
browser's reader cookie, which an agent does not have. Through MCP, `check-access` therefore always
answers for an anonymous reader.

`revoke-access` is marked sensitive: when human approval is on, an agent's call comes back
`202 KITSUDEN_E_APPROVAL_REQUIRED` until an admin approves it. An admin can turn approval on for
other operations too. Details for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | Covers |
| --- | --- |
| `tests/unit/members-access.test.ts` | Grant validity, levels, `canAccess`, `gateBlocks`, `gateHtml`, `grantFromSubscription`. |
| `tests/unit/kon-members-routes.test.ts` | Routes: tiers, magic link (no token in the response, no e-mail oracle, single use, hashing, cooldown, no newsletter opt-in), reader session, `/gate`, `syncSubscriptionAccess`, backoffice refusals. |
| `tests/unit/members-access-mail.test.ts` | The sign-in e-mail, `MEMBERS_SIGNIN_MAIL=off`, `MEMBERS_SIGNIN_URL`. |
| `tests/unit/kon-members-fine-scopes.test.ts` | Agents with only a fine scope list, read, gift and revoke; a read-only fine scope cannot write; a deny wins. |
| `tests/unit/kon-members-payments-sync.test.ts` | kon-payments events through the event bus grant, keep and revoke access; `MEMBERS_PLAN_TIERS`; member status `paid`, `canceled`, `free`. |
| `tests/unit/effective-agents-in-kons.test.ts` | Agents with `admin`, `members:*` or `member:view` list members; row security with a deny. |
| `tests/guards/rls-kon-personal-data.test.ts` | Row security on the member tables. |

```bash
pnpm vitest run tests/unit/members-access.test.ts
pnpm vitest run tests/unit/kon-members-routes.test.ts
pnpm vitest run tests/unit/members-access-mail.test.ts
```

## License

MIT
