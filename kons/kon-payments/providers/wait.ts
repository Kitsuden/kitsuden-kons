/**
 * How long to wait for a payment provider.
 *
 * Without this, `fetch` waits as long as it takes. And each call comes from a route
 * that runs in a Postgres transaction: if it has already queried (the user's
 * customer, the subscription), the transaction stays open while waiting, and
 * the application role cuts it at 60 s
 * (`idle_in_transaction_session_timeout`). A route makes at most two
 * consecutive calls (PayPal token + the operation): 2 × 15 s fits with margin.
 * A provider that does not answer in 15 s is a failure that can be retried.
 */
export const PROVIDER_WAIT_MS = 15_000;

/** The signal that cuts the call at `PROVIDER_WAIT_MS`. */
export function providerWait(): AbortSignal {
  return AbortSignal.timeout(PROVIDER_WAIT_MS);
}
