# AGENTS.md — kon-members

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

Paid memberships: tiers, members (readers with their own magic-link sign-in, separate from CMS
accounts) and the access decision for gated content. Mounted at `/api/members`. Stable, tier
`essential`: other kons and sites depend on its routes and on `members.access.ts`.

## Calling it

Scopes for an agent key:

- Read the member base: `members:*`, `kon:members:*`, `member:view`, or `admin`.
- Give or revoke access: `members:*`, `kon:members:*`, `member:update`, or `admin`.
- Create a tier: `members:*`, `kon:members:*`, `member-tier:create`, or `admin`.
- Fine scopes per operation: `kon:members:list-members`, `kon:members:get-member`,
  `kon:members:create-plan`, `kon:members:gift-access`, `kon:members:revoke-access`. Each opens
  its route and the rows that operation touches (`migrations/0007_fine_scope_rls.sql`): the two
  read scopes read, `gift-access` and `revoke-access` write. A read scope never writes.
- A deny wins: `!members:*` closes the kon even for a key with `admin`, in the application and in
  row security.

MCP tools (`members__<op>`):

| Tool | Returns |
| --- | --- |
| `members__list-plans` | `{ data: [tier] }`: active, visible tiers by level. |
| `members__request-access-link` | `{ ok: true, message }`. Sends a real e-mail to the address. Do not call it to probe whether someone is a member: the answer is the same either way. |
| `members__check-access` | `{ data: { allowed, reason?, viewerLevel, requiredLevel } }`. An agent has no reader cookie, so this answers for an anonymous reader. |
| `members__list-members` | A page of 50 members (`?page=`), newest first, with internal notes. |
| `members__get-member` | `{ data: member, grants: [grant] }`. |
| `members__create-plan` | `{ data: tier }` (201). |
| `members__gift-access` | `{ ok: true }`. |
| `members__revoke-access` | `{ ok: true }`. Sensitive: may come back `202 KITSUDEN_E_APPROVAL_REQUIRED`. Report the proposal to the human and do not retry. |

Other things to know:

- 404 on `GET /api/members/admin/members/:id` means the member does not exist or row security hides
  it from you; the two are not told apart.
- `create-plan` returns 409 when the slug exists; `gift-access` declares 409 when the member or the
  tier does not exist (foreign keys).
- `revoke-access` is idempotent (it only touches live grants). `gift-access` and `create-plan` are
  not: send an `idempotency_key` (MCP) or `Idempotency-Key` header (REST) if you may retry, or
  `gift-access` adds a second grant.
- Refused or impossible on purpose: reading the token of a sign-in link (it only travels by e-mail
  and by the `members.signin-requested` event); signing a reader in or out (no MCP tool, the
  routes work on a browser cookie); editing or deleting members or tiers (no route); recording a
  gift as a payment (`gift-access` always writes `source = comp`).

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Kon definition (`defineKonSdk`), re-exports, registers the policy and the e-mail on startup, and `listenToPayments` (kon-payments subscription events on the core event bus). |
| `operations.ts` | `KON_ID`, the operation registry shaped like a router, `onMembers()` permission helper. |
| `members.routes.ts` | All eleven operations, the reader cookie (`kitsuden_member`), `publicMember()` projection. |
| `members.policy.ts` | Backoffice policies `member` and `member-tier`. |
| `members.access.ts` | Pure access logic: `isGrantActive`, `viewerLevel`, `canAccess`, `gateBlocks`, `gateHtml`, `grantFromSubscription`. |
| `members.service.ts` | Database work: tokens and hashing, members, magic links, sessions, grants, `syncSubscriptionAccess`, `syncPaymentSubscription`, `planTiers` (`MEMBERS_PLAN_TIERS`), `compAccess`, `revokeAccess`. |
| `members.mails.ts` | The `members.signin` mailable, its texts, `accessUrl()`, `accessMailActive()`. |
| `members.schema.ts` | Drizzle tables and enums. |
| `migrations/` | SQL migrations `0001`-`0007` and `history.json`. |
| `kon.json`, `package.json`, `tsconfig.json` | Manifest, package, compiler settings. |

## Rules that must hold

| Rule | Where | Guarded by |
| --- | --- | --- |
| `POST /signin` answers the same whether the e-mail exists, is throttled, or an internal error happened; it never returns the token. The work runs in a savepoint and the e-mail is sent without awaiting. | `members.routes.ts` | `tests/unit/kon-members-routes.test.ts` |
| Tokens and session ids are stored only as SHA-256 hashes. | `members.service.ts` | `kon-members-routes.test.ts` ("stored HASHED") |
| A sign-in link is single use: consumed by one `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`. A new link burns the older unused ones; one link per member per 60 s. | `members.service.ts` | `kon-members-routes.test.ts` ("single use FOR REAL") |
| Invalid, used and expired links give the same 401. | `members.routes.ts` | `kon-members-routes.test.ts` |
| Requesting a link never subscribes anyone to the newsletter (`newsletterSubscribed: false`, although the column defaults to true). | `members.service.ts` `upsertMember` | `kon-members-routes.test.ts` |
| Portal responses use `publicMember()`: no `note`, `source` or `labels`. | `members.routes.ts` | `kon-members-routes.test.ts` |
| Unknown `visibility` is treated as `paid`; the end instant of a grant no longer grants; the level is the maximum of live grants. | `members.access.ts` | `tests/unit/members-access.test.ts` |
| Gated content is cut on the server and the input is never mutated. | `members.access.ts` | `members-access.test.ts` |
| Grants are revoked, never deleted; subscription sync is idempotent by `subscriptionId`. | `members.service.ts` | `kon-members-routes.test.ts` |
| kon-payments is followed only through the event bus (no import). A payment reaches a member only through `authUserId`, never by e-mail; the tier only through `MEMBERS_PLAN_TIERS`, never from checkout metadata. A cancelled subscription sets the member `canceled` unless another live grant remains. | `index.ts` `listenToPayments`, `members.service.ts` | `tests/unit/kon-members-payments-sync.test.ts` |
| The member cookie is separate from the CMS session; reader identity never grants backoffice rights. | `members.routes.ts`, `members.policy.ts` | `kon-members-routes.test.ts` ("backoffice with any account") |
| Row security: `members`/`member_access` for the team and the operations' fine scopes, `member_signins`/`member_sessions` for the system only. Portal routes use `ctx.db.asSystem` and touch only the row their token points to. | `migrations/0006_english_rls.sql`, `0007_fine_scope_rls.sql` | `tests/guards/rls-kon-personal-data.test.ts`, `tests/unit/effective-agents-in-kons.test.ts`, `tests/unit/kon-members-fine-scopes.test.ts` |
| Policies use `isEffectiveStaff`/`isEffectiveAdmin`, never `role === "admin"`, so agents with `members:*` see rows. | `members.policy.ts` | `effective-agents-in-kons.test.ts` |

## Changing it

- New migration: the next number in `migrations/` (now `0008_…`). Never edit an applied one: the
  runner checks checksums, and `migrations/history.json` lists the accepted older checksums
  (`previousChecksums`) and the old file names of renamed migrations (`renamed`). Add an entry
  there only when you rename a file.
- Row security policies are dropped and recreated by name; use the core helpers
  (`kitsuden_rls_team` and friends) as `docs/kons/README.md` in the core describes.
- New file at the kon root: run `pnpm kon:sync` (updates `package.json` `files` and `kon.json`).
- Behaviour change: bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json` (`index.ts` reads it from there).
- Operation ids are part of the contract (MCP tool, fine scope, stored agent keys). Do not rename
  one; `0005_english_names.sql` shows what a rename costs.
- Keep `members.access.ts` free of database and clock access (`now` is a parameter).
- E-mail texts live in `membersTranslations` (`members.mails.ts`), keyed by locale (`es`, `en`).

## Tests

```bash
pnpm vitest run tests/unit/members-access.test.ts        # after touching members.access.ts
pnpm vitest run tests/unit/kon-members-routes.test.ts    # routes, service, policy
pnpm vitest run tests/unit/members-access-mail.test.ts   # members.mails.ts, /signin
pnpm vitest run tests/unit/effective-agents-in-kons.test.ts      # policy or RLS
pnpm vitest run tests/unit/kon-members-fine-scopes.test.ts       # fine scopes and RLS
pnpm vitest run tests/unit/kon-members-payments-sync.test.ts     # kon-payments events → grants
pnpm vitest run tests/guards/rls-kon-personal-data.test.ts       # migrations
pnpm vitest run tests/guards/kon-docs.test.ts -t "kon-members"   # these docs
```
