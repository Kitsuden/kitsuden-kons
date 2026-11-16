# kon-connections

Accounts at other services, connected once and used by every kon that needs them: a person's
Google or Microsoft 365 mailbox and calendar, the organization's account, or an API key for any
provider another kon registers. Credentials are sealed by the host and never returned; other kons
get a client that carries the credential for them.

| Maturity | Category | Version | Mounted at | Requires |
| --- | --- | --- | --- | --- |
| beta | business | 0.1.0 | `/api/connections` | — (core: `auth`, and `ctx.secrets` to connect) |

## Install

```bash
kitsuden kon add connections --enable
```

Restart the API afterwards. Without a secrets key on the host (`ctx.secrets`), the kon starts but
refuses every new connection with 503: it never stores a credential readable.

## What it adds

| Table | What it holds |
| --- | --- |
| `conn_connections` | One connected account: provider, `scope` (`user` or `organization`), owner, account id and email at the provider, granted scopes, `status` (`active`, `expired`, `revoked`, `error`), expiry, last refresh and use. The credential is a sealed secret in `credentials`. |
| `conn_oauth_states` | One OAuth round trip in flight (ten minutes): the `state` hashed, the PKCE verifier sealed. |

A worker refreshes access tokens five minutes before they run out, every five minutes. A
connection the provider will not refresh any more (`invalid_grant`) becomes `expired` and is
announced once.

Events, after the commit:

| Event | Payload |
| --- | --- |
| `connections:connection.created` | `connectionId`, `provider`, `scope`, `ownerId` |
| `connections:connection.expired` | the same and `reason` |
| `connections:connection.revoked` | `connectionId`, `provider`, `scope`, `ownerId` |

For another kon:

```ts
import { connectedClient } from "@kitsuden/kon-connections";

const google = await connectedClient(ctx, {
  provider: "google",
  ownerId: userId,           // omit for the organization's connection
  scopeSets: ["mail.read"],
  purpose: "kon-inbox: sync mail",
});
const res = await google.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages");
```

`fetch` refreshes the token when needed, sends it only to the provider's own hosts, and retries a
401 once with a fresh token. The token is never on the client object. `registerProvider()` adds a
provider (an API key service) to the catalog; Google and Microsoft cannot be replaced.

## HTTP API

| Route | Who | What |
| --- | --- | --- |
| `GET /api/connections/providers` | a signed-in person | The catalog: providers, how they connect, whether they are configured, scope sets. |
| `GET /api/connections/connections` | a signed-in person | Your connections; an admin also sees the organization's. Never a credential. |
| `GET /api/connections/connections/:id` | the owner (admin for the organization's) | One connection. 404 if it is not yours. |
| `POST /api/connections/oauth/start` | a person (admin for `organization`) | Returns the consent `url` (PKCE, ten minutes, one use). |
| `GET /api/connections/oauth/callback` | public, authenticated by `state` | Exchanges the code, stores the credential sealed, redirects to `returnTo`. |
| `POST /api/connections/api-keys` | a person (admin for `organization`) | Stores an API key, sealed. |
| `POST /api/connections/connections/:id/refresh` | the owner | Refreshes now; answers `refreshed`, `expired`, `failed` or `not-needed`. |
| `POST /api/connections/connections/:id/revoke` | the owner | Revokes at the provider when it can, deletes the credential, keeps the row. |

## Who can do what

- A person sees and manages only their own `user` connections. Row security enforces it: an admin
  does not see anyone's personal connection either.
- An admin manages the `organization` connections.
- An agent never starts a consent or stores a key (403): connecting an account is a person's
  decision. With the person's delegation it can list and refresh that person's connections.
- Other kons use connections only through `connectedClient`, as the system, and must ask for the
  right owner.

## Configuration

| Variable | What |
| --- | --- |
| `CONNECTIONS_GOOGLE_CLIENT_ID`, `CONNECTIONS_GOOGLE_CLIENT_SECRET` | The installation's Google OAuth client. |
| `CONNECTIONS_MICROSOFT_CLIENT_ID`, `CONNECTIONS_MICROSOFT_CLIENT_SECRET` | The installation's Microsoft Entra app. |
| `CONNECTIONS_MICROSOFT_TENANT` | Tenant id or `common` (default). |
| `CONNECTIONS_CALLBACK_URL` | The redirect URI registered at the providers. Default: `BETTER_AUTH_URL` + `/api/connections/oauth/callback`. |
| `CONNECTIONS_RETURN_ORIGINS` | Origins a person may be sent back to; default `ALLOWED_ORIGINS`. |

A provider without its client id and secret is listed as not configured and cannot be connected.

## Agents and MCP

What an agent must know before calling it is in [AGENTS.md](AGENTS.md).

Each route is an MCP tool `connections__<operation id>`: `list-providers`, `list-connections`,
`get-connection`, `refresh-connection`, `revoke-connection`. `start-connection` and `add-api-key`
answer 403 to an agent. Fine scopes are `kon:connections:<operation id>`.

## Tests

```bash
pnpm vitest run tests/unit/kon-connections.test.ts
```

PGlite with the kon's migration as a non-superuser role: PKCE, a state used once, sealed storage,
refresh and `invalid_grant`, revoke, the client's host allowlist and 401 retry, and isolation
between people and the admin.

## License

MIT
