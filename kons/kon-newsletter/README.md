# kon-newsletter

Newsletter members with double opt-in, a global suppression list, segments and campaigns, with
delivery delegated to an email provider (Resend, Mailgun, Postal, or any SMTP server through the
core's mail driver). For sites that want to run their own mailing list without a hosted
newsletter service.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | content | 1.0.1 | `/api/newsletter` | core `auth`; optional: kon-blog, kon-payments |

## Install

```bash
kitsuden kon add newsletter --enable
```

Run it inside a Kitsuden project, then restart the API. It ships off on purpose
(`defaultEnabled: false`): a kon that can write to your whole list does not switch itself on. Use
`--enable` or switch it on in the admin panel (**Kons**).

No environment variable is required to start: without a provider key it sends through the core's
mail driver (SMTP). On first start it creates one newsletter, `general`, if none exists. Set a
bounce webhook (see [Configuration](#configuration)) before sending real campaigns: without one
the API logs a warning and bounces and complaints are never seen.

The optional kons are not installed with it:

- **kon-blog**: with `NEWSLETTER_AUTO_SEND=true`, publishing a post sends it as a campaign.
- **kon-payments**: segments can filter by paid tier. Without it, tier `"free"` matches everyone and
  any paid tier matches nobody.

## What it adds

| Table | What it holds |
| --- | --- |
| `nl_newsletters` | The lists people subscribe to (`slug`, `name`, `public_signup`, `active`). |
| `nl_members` | One row per email address: name, status (`pending`, `subscribed`, `unsubscribed`, `cleaned`), locale, attributes (`jsonb`), consent date and IP, confirmation and unsubscribe tokens. |
| `nl_subscriptions` | Which member is subscribed to which newsletter. |
| `nl_suppressions` | Global list of addresses no campaign will ever write to (bounce, complaint, unsubscribe, manual). |
| `nl_segments` | Saved member filters a campaign can target. |
| `nl_campaigns` | A campaign: newsletter, optional segment, subject, preview text, HTML, status (`draft`, `scheduled`, `sending`, `sent`, `failed`, `canceled`), counters. `post_id` links it to a kon-blog post. |
| `nl_deliveries` | One row per campaign and member (unique), created before anything is sent; `pending` until sent. Records open and click times when tracking is on. |
| `nl_events` | Provider feedback events, deduplicated by provider and external id. |

It also registers two emails, `newsletter.confirm` and `newsletter.welcome`, with their texts.

### Rules the kon keeps

1. **Never send to a suppressed address.** Suppressions are checked again on every sending pass,
   not only when the segment is resolved, so a complaint that arrives mid-send still stops the next
   email.
2. **Every campaign email carries `List-Unsubscribe` and `List-Unsubscribe-Post`** (RFC 8058
   one-click), and the unsubscribe link is never rewritten for tracking.
3. **A soft bounce does not suppress.** Only hard bounces and complaints do.
4. **Sending is resumable.** Deliveries are created first and only `pending` ones are sent; the
   unique index `(campaign_id, member_id)` stops a resumed send from writing to anyone twice.
5. **Sign-up is not an oracle.** `POST /subscribe` gives the same answer whether the address is new,
   already subscribed or suppressed.

### Segments

A segment stores the query, not the list, so it is resolved again on every send. Suppressed
addresses are always excluded, and `status` defaults to `["subscribed"]`:

```jsonc
{
  "status": ["subscribed"],
  "newsletters": ["weekly"],            // slugs: subscribed to at least one of them
  "locales": ["en"],
  "tiers": ["paid"],                    // needs kon-payments; "free" = no active plan
  "subscribedAfter": "2026-01-01T00:00:00Z",
  "subscribedBefore": "2026-06-30T00:00:00Z",
  "attributes": { "web": "my-site" }    // jsonb containment on member attributes
}
```

When a campaign or a preview names a newsletter, only members subscribed to it are included.

The public sign-up can set only one attribute, `web` (lowercase letters, digits and hyphens); any
other attribute in the sign-up body is dropped, so a visitor cannot put themselves in a segment.
No route creates or edits a segment or a newsletter: they are rows you add yourself.

### Scheduling

A campaign created with `scheduledAt` is sent by a scheduler that runs every 30 seconds, once the
campaign is prepared (status `scheduled`) and its time has come. With several API processes only
one wins the `scheduled` to `sending` transition.

## HTTP API

Public routes (no session; the token or the provider signature authenticates):

| Route | Who | What it does |
| --- | --- | --- |
| `POST /api/newsletter/subscribe` | anyone | Body `{ email, name?, locale?, newsletters?, attributes?: { web } }`. Starts a double opt-in: sends a confirmation email. Always `{ ok, message }`; `400` only for an invalid body. |
| `GET /api/newsletter/confirm` | anyone with the token | `?token=`. Confirms the subscription and sends the welcome email. `400` for an unknown or expired token. |
| `GET /api/newsletter/unsubscribe` | anyone with the token | `?token=`. The footer link. Same answer whether the token is valid or not. |
| `POST /api/newsletter/unsubscribe` | anyone with the token | `?token=`. RFC 8058 one-click unsubscribe sent by mail clients; the body is ignored. |
| `POST /api/newsletter/webhook/:provider` | the email provider | `mailgun`, `resend`, `ses` or `postmark`. Verifies the signature over the raw body and applies bounces, complaints and unsubscribes. `404` for a provider that is not configured, `400` for a bad signature or payload. |
| `GET /api/newsletter/t/o/:token` | mail clients | Open pixel (the token ends in `.gif`). Always returns a 1x1 GIF; records the first open when open tracking is on and the token is valid. |
| `GET /api/newsletter/t/c/:token` | mail clients | Tracked link: records the click and redirects (`302`) to the destination signed inside the token. `400` when the token does not validate, so it is never an open redirect. |
| `GET /api/newsletter/portal.js` | anyone | Embeddable sign-up widget (JavaScript). |
| `GET /api/newsletter/portal` | anyone | A minimal HTML sign-up page with the widget. |

Administration (newsletter admin only, see [Who can do what](#who-can-do-what)):

| Route | Who | What it does |
| --- | --- | --- |
| `GET /api/newsletter/newsletters` | admin | Every newsletter, oldest first. |
| `GET /api/newsletter/members` | admin | Latest members (`limit`, default 100, max 500): email, name, status, locale, consent date. |
| `GET /api/newsletter/suppressions` | admin | Latest 500 suppressed addresses. |
| `POST /api/newsletter/suppressions` | admin | Body `{ email, detail? }`. Suppresses an address (`201`). Suppressing twice keeps the first reason. |
| `DELETE /api/newsletter/suppressions/:email` | admin | Removes a suppression (URL-encoded address). `ok` whether or not it existed. |
| `POST /api/newsletter/segments/preview` | admin | Body `{ filter?, newsletterId? }`. How many members a filter reaches, with 10 sample emails. Sends nothing. |
| `GET /api/newsletter/segments` | admin | Every saved segment. |
| `GET /api/newsletter/campaigns` | admin | Latest 100 campaigns, newest first. |
| `POST /api/newsletter/campaigns` | admin | Body `{ newsletterId, subject, html, segmentId?, previewText?, text?, scheduledAt? }`. Creates a draft (`201`). `400` with `issues` for an invalid body. |
| `GET /api/newsletter/campaigns/:id/preview` | admin | Renders the email as an address would receive it (`?email=`, default `preview@example.com`); `?format=html` returns the HTML itself. |
| `POST /api/newsletter/campaigns/:id/prepare` | admin | Resolves the segment and creates one pending delivery per recipient (suppressed excluded). Returns `{ ok, recipients }`. `400` if the campaign does not exist or is sending or sent. |
| `POST /api/newsletter/campaigns/:id/send` | admin | Prepares a draft if needed and starts sending in the background. `202 { ok, status: "sending" }`; `404` if missing, `409` if already sending. Cannot be undone. |
| `GET /api/newsletter/campaigns/:id/stats` | admin | Status, counters and the breakdown of deliveries by status. |

### Embeddable widget

```html
<div data-kitsuden-newsletter data-cta="Subscribe" data-newsletters="weekly"></div>
<script src="https://your-instance.com/api/newsletter/portal.js"></script>
```

Other attributes: `data-placeholder` and `data-locale` (default: `NEWSLETTER_DEFAULT_LOCALE`). The widget is restyled with the CSS
variables `--kitsuden-accent` and `--kitsuden-border` and inherits the host page's font. Embedding it
on another domain needs that domain in the API's CORS allowlist; `/portal` works without it because
it is served from the API's own origin.

### Request limits

`/subscribe` is public and sends an email per request, so it has its own limits on top of the
host's general one (`newsletter.limits.ts`, applied per client IP):

| Path | Limit | If the rate-limit store is down |
| --- | --- | --- |
| `/subscribe` | 5 per 5 minutes | rejects (fail-closed) |
| `/confirm` | 20 per 5 minutes | rejects (fail-closed) |
| `/unsubscribe` | 60 per minute | lets it through: an unsubscribe that answers `429` turns into a spam report |

Independently of the IP, a confirmation email is not re-sent to the same address within 5 minutes
(`CONFIRM_COOLDOWN_MS` in `newsletter.service.ts`), which stops someone rotating IPs against one
victim.

## Who can do what

The policy is `newsletter.policy.ts`: one action, `administer`, granted by
`isEffectiveAdmin(user, "newsletter")`: a human admin, or an agent with `admin`, `newsletter:*` or
`kon:newsletter:*`. Every non-public route requires it. Editors and ordinary users have no access
to members, campaigns or suppressions.

Row security (migrations `0001`, `0002`, `0003`, `0005`) covers `nl_members`, `nl_subscriptions`,
`nl_suppressions`, `nl_deliveries` and `nl_events`: only the newsletter admin and the system (a
request with no user) can read or write them. The public routes run their database work as the
system after checking the token or signature.

## Configuration

Sending (the first configured one is used; `NEWSLETTER_TRANSPORT` picks one by name):

| Variable | Effect |
| --- | --- |
| `NEWSLETTER_TRANSPORT` | `resend`, `mailgun` or `postal`; used only if that transport is configured. |
| `RESEND_API_KEY`, `RESEND_RATE_PER_SECOND` (10) | Resend, batches of 100. |
| `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_REGION` (`eu` for the EU endpoint), `MAILGUN_RATE_PER_SECOND` (10) | Mailgun, batches of 1,000. |
| `POSTAL_URL`, `POSTAL_API_KEY`, `POSTAL_RATE_PER_SECOND` (20) | Postal (self-hosted). |
| `NEWSLETTER_RATE_PER_SECOND` (10), `NEWSLETTER_CONCURRENCY` (4) | The generic transport over the core's mail driver, used when none of the above is configured. |

Bounces and complaints, at `POST /api/newsletter/webhook/:provider`:

| Variable | Provider |
| --- | --- |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | `mailgun` (HMAC over timestamp and token) |
| `RESEND_WEBHOOK_SECRET` | `resend` (Svix signature) |
| `SES_FEEDBACK_ENABLED=true` and `SES_TOPIC_ARN` | `ses` (SNS-signed; `SES_TOPIC_ARN` is the ARN of your SNS topic, several separated by commas; without it every notification is rejected) |
| `POSTMARK_WEBHOOK_TOKEN` | `postmark` (shared token) |

Tracking and auto-send:

| Variable | Effect |
| --- | --- |
| `NEWSLETTER_TRACK_OPENS=true` | Adds the open pixel. Off by default: an open pixel records that a specific person read an email, which is personal data and needs its own legal basis. |
| `NEWSLETTER_TRACK_CLICKS=true` | Rewrites links through `/t/c/:token`. Off by default. |
| `NEWSLETTER_TRACKING_SECRET` | HMAC secret for tracking tokens; falls back to `AUTH_SECRET`. With fewer than 16 characters tracking stays off whatever the two flags say. |
| `NEWSLETTER_DEFAULT_LOCALE` | Language (e.g. `es`, `pt-BR`) of members who sign up without `locale`, of the `/portal` page (`<html lang>`) and the widget's default `data-locale`. Default `en`. Confirmation and welcome emails are translated per member locale; the kon ships `en` and `es`, other languages fall back to the core mailer's default (`MAIL_LOCALE`). |
| `NEWSLETTER_AUTO_SEND=true` | With kon-blog: on `blog:post:published`, creates a campaign for the first newsletter and sends it. A post gets at most one campaign (unique `post_id`), so republishing does not resend. |

The kon also reads the core's `siteUrl` and `siteName` to build links and the default newsletter
name.

## Agents and MCP

Operations exposed as MCP tools (`newsletter__<operation>`):

| Operation | Fine scope | Writes | Sensitive |
| --- | --- | --- | --- |
| `subscribe` | `kon:newsletter:subscribe` | yes (sends an email) | no |
| `confirm-subscription` | `kon:newsletter:confirm-subscription` | yes | no |
| `unsubscribe`, `unsubscribe-one-click` | `kon:newsletter:unsubscribe`, `kon:newsletter:unsubscribe-one-click` | yes | no |
| `list-newsletters`, `list-members`, `list-suppressions`, `list-segments`, `list-campaigns` | `kon:newsletter:<operation>` | no | no |
| `preview-segment`, `preview-campaign`, `get-campaign-stats` | `kon:newsletter:<operation>` | no | no |
| `suppress-address` | `kon:newsletter:suppress-address` | yes | no |
| `remove-suppression` | `kon:newsletter:remove-suppression` | yes | yes (DELETE) |
| `create-campaign` | `kon:newsletter:create-campaign` | yes | no |
| `prepare-campaign` | `kon:newsletter:prepare-campaign` | yes | no |
| `send-campaign` | `kon:newsletter:send-campaign` | yes (emails the list) | yes |

Not MCP tools: `open-pixel`, `redirect-click`, `get-portal-script`, `get-portal-page` (browser
assets) and `receive-webhook` (called by the provider with a signature).

The admin operations are granted by the `administer` policy and by their fine scopes. When an admin
turns human approval on, `send-campaign` and `remove-suppression` are the ones held by default.
Notes for agents: [AGENTS.md](AGENTS.md).

## Tests

| File | What it covers |
| --- | --- |
| `tests/unit/newsletter.test.ts` | Unsubscribe headers, Mailgun/Resend/Postmark feedback signatures, the generic transport, tracking tokens, rate limits. |
| `tests/unit/kon-newsletter-security.test.ts` | Sign-up gives no oracle, double opt-in, unsubscribe tokens, admin routes closed to non-admins. |
| `tests/unit/ses-only-your-topic.test.ts` | SES feedback only from your own SNS topic. |
| `tests/unit/event-blog-newsletter.test.ts` | Auto-send listens to the event kon-blog emits. |
| `tests/unit/kon-newsletter-segments-locale.test.ts` | The segment `newsletters` filter, the default language of the portal, widget and mails. |

```bash
pnpm vitest run tests/unit/newsletter.test.ts
pnpm vitest run tests/unit/kon-newsletter-security.test.ts
pnpm vitest run tests/unit/ses-only-your-topic.test.ts
pnpm vitest run tests/unit/event-blog-newsletter.test.ts
pnpm vitest run tests/unit/kon-newsletter-segments-locale.test.ts
```

## License

MIT.
