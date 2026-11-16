# AGENTS.md — kon-connections

Notes for AI agents: coding agents changing this kon, and agents that call it through Kitsuden.
Repository-wide rules: [../../AGENTS.md](../../AGENTS.md).

## What it is

Connected accounts at other services (Google, Microsoft 365, API key providers), with their
credentials sealed by the host (`ctx.secrets`). Other kons reach a provider through
`connectedClient`, which adds the credential and never exposes it.

## Calling it

- `connections__list-providers`, `connections__list-connections`, `connections__get-connection`:
  what exists and its status. Never a token.
- `connections__refresh-connection`: `outcome` is `refreshed`, `expired` (the person must connect
  again), `failed` (try later) or `not-needed`.
- `connections__revoke-connection`: cannot be undone. It is a write on a person's account: expect
  `202 KITSUDEN_E_APPROVAL_REQUIRED` and report the proposal; do not retry.
- `start-connection` and `add-api-key` always answer 403 to an agent. Tell the person to connect
  the account themselves.
- 404 means the connection does not exist or is not the caller's. It never says which.
- 503 `SECRETS_UNAVAILABLE`: the host has no secrets key; nothing can be connected.

## Map of the code

| File | Responsibility |
| --- | --- |
| `index.ts` | Operations, the refresh worker (`refreshTick`), events, the kon definition. |
| `connections.providers.ts` | The catalog: Google, Microsoft, `registerProvider`, scope sets, allowed hosts. |
| `connections.service.ts` | OAuth with PKCE, API keys, refresh, expiry, revoke, `findConnection`. |
| `connections.client.ts` | `connectedClient` / `clientFor`: the fetch other kons use. |
| `connections.policy.ts` | Policy `connections`. |
| `connections.schema.ts` | Tables and `publicConnection`, the only shape that leaves the kon. |
| `operations.ts` | `KON_ID`, the operation registry, the `OWN` and `ORGANIZATION` permissions. |
| `migrations/0001_connections.sql` | Tables and row security. |

## Rules that must hold

- No route, event, log line or error carries a token, a refresh token or an API key.
  `publicConnection` is the only shape that leaves.
- Without `ctx.secrets`, connecting is refused (503). Never store a credential readable.
- A `state` works once and for ten minutes; it is stored hashed.
- The client sends a credential only to `https` URLs on the provider's `apiHosts`.
- An admin does not see a person's `user` connection (row security), and an agent never consents.
- Google and Microsoft cannot be replaced through `registerProvider`.

## Changing it

- A new provider: add it to `connections.providers.ts` (or call `registerProvider` from another
  kon) with its `apiHosts`; every URL must be `https`.
- A new column holding a secret: list it in `secretColumns` in `index.ts` so a key rotation
  re-encrypts it.
- A new route: add it to `authorization-matrix.kons.json` and to the README.

## Tests

`tests/unit/kon-connections.test.ts` (PGlite, non-superuser role). kon-inbox's tests use this kon's
client with a fake provider.
