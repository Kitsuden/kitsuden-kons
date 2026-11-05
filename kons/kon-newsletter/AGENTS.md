# AGENTS.md — kon-newsletter

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

A mailing list: members with double opt-in, a global suppression list, segments and campaigns.
Delivery goes through a pluggable transport (Resend, Mailgun, Postal, or the core's mail driver);
bounces and complaints come back through signed provider webhooks.

## Calling it

- **Scopes.** Every admin operation needs the `administer` policy: an agent passes it with
  `admin`, `newsletter:*` or `kon:newsletter:*` (`isEffectiveAdmin`, and the same rule in row
  security). Fine scopes such as `kon:newsletter:list-campaigns` also grant the single operation at
  the API, but the `nl_*` tables with row security (members, subscriptions, suppressions,
  deliveries, events) only open to the effective newsletter admin; give a read-only agent
  `newsletter:*` with denies (`!kon:newsletter:send-campaign`, `!kon:newsletter:remove-suppression`)
  rather than fine scopes alone.
- **MCP tools** (`newsletter__<operation>`), what they return:
  - `list-newsletters` `{ newsletters }`, `list-members` `{ members }`, `list-suppressions`
    `{ suppressions }`, `list-segments` `{ segments }`, `list-campaigns` `{ campaigns }`.
  - `preview-segment` `{ total, sample }` (10 emails); `preview-campaign` `{ message }`;
    `get-campaign-stats` `{ status, stats, breakdown }`.
  - `create-campaign` `{ campaign }` (201, draft); `prepare-campaign` `{ ok, recipients }`;
    `send-campaign` `{ ok, status: "sending" }` (202, runs in the background).
  - `suppress-address` `{ ok }` (201); `remove-suppression` `{ ok }`.
  - `subscribe`, `confirm-subscription`, `unsubscribe`, `unsubscribe-one-click` `{ ok, message }`.
- **Approval.** `send-campaign` and `remove-suppression` are sensitive. With human approval on they
  come back `202 KITSUDEN_E_APPROVAL_REQUIRED`: report the proposal, do not retry. Note that a
  successful `send-campaign` is also a `202`; read the body (`status: "sending"`).
- **Before sending:** `create-campaign`, then `preview-campaign` and `preview-segment` to check the
  content and the audience, then `prepare-campaign`, then `send-campaign`. Watch progress with
  `get-campaign-stats`. A send cannot be recalled.
- **404s.** `preview-campaign`, `send-campaign` and `get-campaign-stats` answer 404 for a missing
  campaign; `prepare-campaign` answers 400 instead. List operations return empty lists, not 404,
  when row security hides rows.
- **Idempotency.** `suppress-address` and `unsubscribe-one-click` are idempotent. `prepare-campaign`
  can be repeated before sending. `send-campaign` answers 409 while a send is running.
  `create-campaign` is not idempotent: pass an `Idempotency-Key` when you may retry.
- **Refused or ignored, and why.**
  - `subscribe` always answers the same message; do not read its answer as "the address exists".
  - Public sign-up attributes other than `web` are dropped (a visitor cannot pick a segment).
  - There is no operation to create newsletters or segments, or to edit or delete a campaign.
  - Removing a suppression is a human decision: the address bounced or complained.

## Map of the code

| File | Responsibility |
| --- | --- |
| `kon.json` | Manifest: tables, mails, optional kons, admin views, mount path. |
| `package.json` | npm package; `files` and `version` kept in sync by `pnpm kon:sync`. |
| `index.ts` | `defineKonSdk` definition; transport and feedback-adapter selection from env; auto-send on `blog:post:published`; default newsletter seed; 30-second campaign scheduler. |
| `operations.ts` | `registry()` (router-shaped operation registry), `ADMIN_ONLY` permission, `KON_ID`. |
| `newsletter.routes.ts` | All operations (public, tracking, portal, webhook, admin) and the portal widget script. |
| `newsletter.service.ts` | Sign-up, confirm, unsubscribe, suppress, segment resolution, tier filter, prepare and send, message rendering, feedback application. |
| `newsletter.policy.ts` | The `newsletter` policy (`administer`). |
| `newsletter.limits.ts` | Per-IP rate limits for `/subscribe`, `/confirm`, `/unsubscribe`. |
| `newsletter.tracking.ts` | Tracking config from env, HMAC-signed open and click tokens, the pixel GIF. |
| `newsletter.mails.ts` | The `newsletter.confirm` and `newsletter.welcome` mailables and their translations. |
| `newsletter.schema.ts` | Drizzle tables `nl_*`. |
| `newsletter.types.ts` | Transport, feedback and segment types; unsubscribe headers. |
| `newsletter.db.ts` | Database type used by the kon. |
| `transports/smtp.ts` | Generic transport over the core's `MailDriver` (`driverTransport`). |
| `transports/resend.ts`, `transports/mailgun.ts`, `transports/postal.ts` | Native batch transports. |
| `feedback/mailgun.ts`, `feedback/resend.ts`, `feedback/ses.ts`, `feedback/postmark.ts` | Webhook signature checks and event normalization per provider. |
| `migrations/0000_initial.sql` | Creates the tables. |
| `migrations/0001_personal_data_rls.sql`, `0002_system_without_user.sql`, `0003_effective_admin.sql`, `0005_english_rls.sql` | Row security on personal-data tables. |
| `migrations/0004_english_names.sql` | Renames stored scopes and tool names to English. |
| `migrations/history.json` | Renamed migrations and previous checksums. |
| `tsconfig.json` | Extends `../../tsconfig.kons.json`. |

## Rules that must hold

- **Suppressed addresses never receive a campaign**; checked when resolving the segment and again
  on each sending pass (`newsletter.service.ts`).
- **Every campaign email has `List-Unsubscribe` and `List-Unsubscribe-Post`**
  (`newsletter.types.ts`; `newsletter.test.ts` "unsubscribe headers").
- **Only hard bounces and complaints suppress** (`applyFeedback`).
- **Deliveries are created before sending and are unique per campaign and member**; only
  `pending` ones are sent (index `nl_deliveries_campaign_member_idx`).
- **Sign-up is not an oracle** and **unsubscribe answers the same for any token**
  (`kon-newsletter-security.test.ts`).
- **Webhooks verify the provider signature**; SES only from `SES_TOPIC_ARN`
  (`newsletter.test.ts`, `ses-only-your-topic.test.ts`).
- **Tracking tokens are signed and carry the destination**; no secret of 16+ characters, no
  tracking (`newsletter.test.ts` "tracking").
- **Rate limits stay**: `/subscribe` and `/confirm` fail closed, `/unsubscribe` does not
  (`newsletter.test.ts` "kon rate limits").
- **One campaign per blog post** (unique `post_id`), and the auto-send listens to
  `blog:post:published` (`event-blog-newsletter.test.ts`).
- **Personal-data tables keep row security** (`tests/guards/rls-kon-personal-data.test.ts`).

## Changing it

- **New migration:** next number in `migrations/` (`0006_...`); never edit an applied one. Renames
  and comment-only edits of applied files go in `migrations/history.json`. A new table holding
  personal data needs row security like `0005_english_rls.sql`.
- **New provider:** a transport in `transports/` and/or an adapter in `feedback/`, registered in
  `buildTransport` / `buildFeedbackAdapters` in `index.ts`, then `pnpm kon:sync` for the new files.
- **New file at the root:** run `pnpm kon:sync`.
- **Behaviour change:** bump `version` in `package.json` and run `pnpm kon:sync`, which copies it to `kon.json`.
- The kon must not import kon-blog or kon-payments: both are optional. Auto-send uses a structural
  type and the tier filter queries `pay_subscriptions` with raw SQL.
- Do not rename operation ids: they are MCP tool names and fine scopes stored in agent keys.

## Tests

```bash
pnpm vitest run tests/unit/newsletter.test.ts
pnpm vitest run tests/unit/kon-newsletter-security.test.ts
pnpm vitest run tests/unit/ses-only-your-topic.test.ts
pnpm vitest run tests/unit/event-blog-newsletter.test.ts
pnpm vitest run tests/unit/kon-newsletter-segments-locale.test.ts
pnpm vitest run tests/guards/rls-kon-personal-data.test.ts
```

- Transports, feedback, tracking, limits: `newsletter.test.ts` (and `ses-only-your-topic.test.ts`
  for `feedback/ses.ts`).
- Routes, service, policy: `kon-newsletter-security.test.ts`.
- Auto-send in `index.ts`: `event-blog-newsletter.test.ts`.
- Migrations: `rls-kon-personal-data.test.ts` and `pnpm test:guards`.
